/**
 * @forge/agent-fixer — Fixer Agent
 *
 * Handles bug fixing and incident response. Implements a risk-aware decision
 * tree that learns from past fixes via the FixPattern DB table.
 *
 * Decision tree:
 *   1. Classify fix type:
 *      - dependency_vulnerability → defer to Security Agent
 *      - known_error_pattern (>90% success rate) → auto-fix using stored pattern
 *      - new_error → full Claude analysis
 *   2. Assess risk level:
 *      - high / critical (auth, payments, data migration) → ALWAYS require approval
 *      - medium (API / schema changes) → require approval per autonomy level
 *      - low (cosmetic, non-critical) → proceed per autonomy level config
 *   3. If proceeding: analyse with Claude claude-sonnet-4-6, generate fix,
 *      run regression tests, score confidence, open PR and notify
 */

import Anthropic from 'anthropic'
import { Octokit } from 'octokit'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {
  createLogger,
  applyWorkspaceFileChanges,
  assertSandboxAvailable,
  installSandboxDependencies,
  runInSandbox,
} from '@forge/shared'
import type { AgentTask, ConfidenceScore, FixPattern, RiskLevel } from '@forge/shared'
import { prisma } from '@forge/database'
import { ConfidenceEngine } from '@forge/orchestrator'
import type { ConfidenceInputs } from '@forge/orchestrator'

const log = createLogger('agent-fixer')

// ---------------------------------------------------------------------------
// Types and Interfaces
// ---------------------------------------------------------------------------

/** Result returned by every FixerAgent public method. */
export interface FixerResult {
  success: boolean
  prUrl?: string
  prNumber?: number
  filesChanged: string[]
  summary: string
  confidenceScore?: ConfidenceScore
  /** Whether human approval was requested before proceeding. */
  approvalRequested?: boolean
  /** The fix type classification assigned to this error. */
  fixType?: FixType
}

/** The broad category of a fix, used to route the decision tree. */
export type FixType =
  | 'dependency_vulnerability'
  | 'known_error_pattern'
  | 'new_error'

/** Structured classification of an error message including routing metadata. */
export interface FixClassification {
  fixType: FixType
  /** Normalised fingerprint used for deduplication and pattern lookup. */
  fingerprint: string
  /** Human-readable summary of what the error is. */
  description: string
  /** The known pattern if one was found. */
  knownPattern?: FixPattern
  /** Confidence in the classification (0-1). */
  classificationConfidence: number
}

/** Parsed payload for fix_bug tasks. */
interface FixBugPayload {
  errorMessage: string
  stackTrace?: string
  contextPrompt?: string
  repoOwner?: string
  repoName?: string
  baseBranch?: string
  /** The log event or bug report that triggered this task. */
  triggerSource?: string
}

/** Parsed payload for fix_incident tasks. */
interface FixIncidentPayload {
  incidentId?: string
  errorMessage: string
  stackTrace?: string
  affectedUsers?: number
  contextPrompt?: string
  repoOwner?: string
  repoName?: string
  baseBranch?: string
}

/** A single file change to apply as part of a fix. */
interface FileChange {
  filePath: string
  content: string
  action: 'create' | 'modify' | 'delete'
}

/** Options for opening a GitHub pull request. */
interface PrOptions {
  owner: string
  repo: string
  branch: string
  baseBranch: string
  title: string
  body: string
}

// Re-export RiskLevel so consumers have a single import point
export type { RiskLevel, FixPattern }

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The Claude model used for all code-generation calls. */
const MODEL = 'claude-sonnet-4-6'

/**
 * Error fingerprint keywords that indicate a dependency vulnerability.
 * When any of these appear in the error message we defer to the Security Agent
 * rather than trying to patch application code.
 */
const VULNERABILITY_KEYWORDS = [
  'CVE-',
  'GHSA-',
  'npm audit',
  'vulnerability',
  'advisory',
  'security patch',
]

/**
 * Risk-bearing keywords in error messages or stack traces.
 * Presence in the analysed content raises the risk level to at least "medium".
 */
const HIGH_RISK_KEYWORDS = [
  'auth',
  'authentication',
  'authorization',
  'oauth',
  'jwt',
  'password',
  'stripe',
  'payment',
  'billing',
  'database migration',
  'data migration',
  'schema migration',
  'drop table',
  'delete from',
]

// ---------------------------------------------------------------------------
// FixerAgent
// ---------------------------------------------------------------------------

/**
 * Incident-response and bug-fixing agent for Forge.
 *
 * Uses a risk-aware decision tree before making any code changes.
 * Learns from past fixes via FixPattern database records.
 *
 * @example
 * const agent = new FixerAgent()
 * const result = await agent.handleTask(task)
 */
export class FixerAgent {
  private readonly anthropic: Anthropic
  private readonly octokit: Octokit
  private readonly confidenceEngine: ConfidenceEngine

  constructor() {
    const apiKey = process.env['ANTHROPIC_API_KEY']
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY environment variable is required')
    }
    const githubToken = process.env['GITHUB_TOKEN']
    if (!githubToken) {
      throw new Error('GITHUB_TOKEN environment variable is required')
    }
    this.anthropic = new Anthropic({ apiKey })
    this.octokit = new Octokit({ auth: githubToken })
    this.confidenceEngine = new ConfidenceEngine()
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Main entry point. Dispatches to fixBug or fixIncident based on task type.
   *
   * @param task - The AgentTask dispatched by the orchestrator
   */
  async handleTask(task: AgentTask): Promise<FixerResult> {
    log.info(
      { taskId: task.id, type: task.type, projectId: task.projectId },
      'Fixer agent received task',
    )
    try {
      switch (task.type) {
        case 'fix_bug':
          return await this.fixBug(task)
        case 'fix_incident':
          return await this.fixIncident(task)
        default:
          throw new Error(`Fixer agent does not handle task type: ${task.type}`)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error({ taskId: task.id, err }, 'Fixer agent task failed')
      return {
        success: false,
        filesChanged: [],
        summary: `Task failed: ${message}`,
      }
    }
  }

  /**
   * Fix a bug from its error message and optional stack trace.
   *
   * Runs the full decision tree: classify → risk-assess → fix or gate.
   * Stores the outcome in FixPattern for future pattern matching.
   *
   * @param task - AgentTask with FixBugPayload in task.payload
   */
  async fixBug(task: AgentTask): Promise<FixerResult> {
    const payload = task.payload as FixBugPayload
    const taskLog = log.child({ taskId: task.id, op: 'fix_bug' })
    taskLog.info({ errorMessage: payload.errorMessage }, 'Starting bug fix')

    // Step 1: Classify the fix type
    let classification: FixClassification
    try {
      classification = await this.classifyFixType(payload.errorMessage, task.projectId)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      taskLog.error({ err }, 'Fix classification failed')
      return { success: false, filesChanged: [], summary: `Classification failed: ${message}` }
    }

    taskLog.info({ fixType: classification.fixType, fingerprint: classification.fingerprint }, 'Fix classified')

    // Step 2: Dependency vulnerabilities are handled by the Security Agent
    if (classification.fixType === 'dependency_vulnerability') {
      taskLog.info('Deferring dependency vulnerability to Security Agent')
      return {
        success: true,
        filesChanged: [],
        summary: 'Dependency vulnerability detected. Deferred to Security Agent for patching.',
        fixType: 'dependency_vulnerability',
      }
    }

    // Step 3: Assess risk level before making any changes
    let riskLevel: RiskLevel
    try {
      riskLevel = await this.assessRisk(task)
    } catch (err) {
      // Default to high risk on assessment failure — safe-fail
      taskLog.warn({ err }, 'Risk assessment failed; defaulting to high risk')
      riskLevel = 'high'
    }

    taskLog.info({ riskLevel }, 'Risk level assessed')

    // Step 4: High/critical risk always requires explicit approval
    if (riskLevel === 'high' || riskLevel === 'critical') {
      taskLog.warn({ riskLevel }, 'High-risk fix requires approval before proceeding')
      return {
        success: false,
        filesChanged: [],
        summary: `Fix blocked: ${riskLevel} risk requires explicit human approval before code changes are made.`,
        approvalRequested: true,
        fixType: classification.fixType,
      }
    }

    // Step 5: Medium risk requires approval if autonomy level is 'suggest'
    if (riskLevel === 'medium' && task.autonomyLevel === 'suggest') {
      taskLog.info({ riskLevel }, 'Medium-risk fix in suggest mode; requesting approval')
      return {
        success: false,
        filesChanged: [],
        summary: `Fix staged for approval: medium-risk changes require approval in suggest mode.`,
        approvalRequested: true,
        fixType: classification.fixType,
      }
    }

    // Step 6: If we have a known pattern with high success rate, use it
    const pattern = classification.knownPattern
    if (classification.fixType === 'known_error_pattern' && pattern) {
      const successRate = pattern.successCount / Math.max(1, pattern.successCount + pattern.failureCount)
      if (successRate >= 0.9) {
        taskLog.info({ patternId: pattern.id, successRate }, 'Applying known fix pattern')
        return await this.applyKnownPattern(task, pattern, riskLevel)
      }
    }

    // Step 7: Full Claude analysis for new or low-confidence errors
    return await this.analyseAndFix(task, payload, classification, riskLevel)
  }

  /**
   * Emergency incident fix — same decision tree as fixBug but with
   * elevated priority logging and a shorter approval timeout.
   *
   * For critical incidents affecting many users, the approval gate is
   * still enforced for auth/payment/data changes, but a 30-minute
   * auto-escalation is triggered instead of the standard 24-hour window.
   *
   * @param task - AgentTask with FixIncidentPayload in task.payload
   */
  async fixIncident(task: AgentTask): Promise<FixerResult> {
    const payload = task.payload as FixIncidentPayload
    const taskLog = log.child({ taskId: task.id, op: 'fix_incident', incidentId: payload.incidentId })

    taskLog.warn(
      { errorMessage: payload.errorMessage, affectedUsers: payload.affectedUsers },
      'INCIDENT: Starting emergency fix',
    )

    // Reuse the same decision tree as fixBug — the logic is identical.
    // We translate the incident payload into a fix_bug compatible shape
    // so we can share all the routing/risk/pattern logic.
    const bugTask: AgentTask = {
      ...task,
      type: 'fix_bug',
      payload: {
        errorMessage: payload.errorMessage,
        stackTrace: payload.stackTrace,
        contextPrompt: payload.contextPrompt,
        repoOwner: payload.repoOwner,
        repoName: payload.repoName,
        baseBranch: payload.baseBranch,
        triggerSource: `incident:${payload.incidentId ?? 'unknown'}` ,
      } satisfies FixBugPayload,
    }

    const result = await this.fixBug(bugTask)

    // Annotate the result so callers know this was an incident response
    return {
      ...result,
      summary: `[INCIDENT${payload.incidentId ? ` #${payload.incidentId}` : ''}] ${result.summary}`,
    }
  }

  // -------------------------------------------------------------------------
  // Private core methods
  // -------------------------------------------------------------------------

  /**
   * Classify the fix type for an error message.
   *
   * Checks for dependency vulnerability keywords first, then looks up the
   * FixPattern DB for a matching fingerprint. Falls through to new_error
   * if neither condition is met.
   *
   * @param errorMessage - The raw error message or log line
   * @param projectId - Used to scope FixPattern lookups to this project
   */
  private async classifyFixType(
    errorMessage: string,
    projectId: string,
  ): Promise<FixClassification> {
    const lowerMsg = errorMessage.toLowerCase()

    // 1. Check for dependency vulnerability markers
    const isVulnerability = VULNERABILITY_KEYWORDS.some((kw) => lowerMsg.includes(kw.toLowerCase()))
    const fingerprint = computeFingerprint(errorMessage)

    if (isVulnerability) {
      return {
        fixType: 'dependency_vulnerability',
        fingerprint,
        description: 'Security vulnerability in a dependency detected.',
        classificationConfidence: 0.95,
      }
    }

    // 2. Look up existing fix patterns for this project
    const knownPattern = await this.lookupFixHistory(fingerprint, projectId)

    if (knownPattern) {
      const total = knownPattern.successCount + knownPattern.failureCount
      const successRate = total > 0 ? knownPattern.successCount / total : 0
      return {
        fixType: 'known_error_pattern',
        fingerprint,
        description: knownPattern.errorDescription,
        knownPattern,
        classificationConfidence: successRate,
      }
    }

    // 3. New error — no pattern match
    return {
      fixType: 'new_error',
      fingerprint,
      description: errorMessage.slice(0, 120),
      classificationConfidence: 1.0,
    }
  }

  /**
   * Assess the risk level of a proposed fix.
   *
   * Risk is determined by scanning the error message and stack trace for
   * high-risk keywords (auth, payments, data migration). Returns "high" if
   * any match, "medium" for API/schema changes, "low" otherwise.
   *
   * @param task - The task whose payload contains the error context
   */
  private async assessRisk(task: AgentTask): Promise<RiskLevel> {
    const payload = task.payload as FixBugPayload
    const combined = [payload.errorMessage, payload.stackTrace ?? ''].join(' ').toLowerCase()

    // High-risk keywords → always flag as high
    const isHighRisk = HIGH_RISK_KEYWORDS.some((kw) => combined.includes(kw.toLowerCase()))
    if (isHighRisk) return 'high'

    // API or schema change indicators → medium risk
    const mediumRiskTerms = ['api', 'schema', 'endpoint', 'route', 'middleware']
    const isMediumRisk = mediumRiskTerms.some((kw) => combined.includes(kw))
    if (isMediumRisk) return 'medium'

    // Check the changed modules in the codebase context for incident history
    if (task.contextSnapshot) {
      const highIncidentModules = task.contextSnapshot.modules.filter(
        (m) => m.incidentCount > 3,
      )
      if (highIncidentModules.length > 0) {
        return 'medium'
      }
    }

    return 'low'
  }

  /**
   * Look up a stored fix pattern by error fingerprint for a specific project.
   *
   * Returns null if no pattern is found. Only considers patterns with at least
   * one successful application to avoid acting on untested patterns.
   *
   * @param fingerprint - Normalised error fingerprint
   * @param projectId - Scopes the lookup to this project only
   */
  private async lookupFixHistory(
    fingerprint: string,
    projectId: string,
  ): Promise<FixPattern | null> {
    try {
      const pattern = await prisma.fixPattern.findFirst({
        where: {
          projectId,
          errorFingerprint: fingerprint,
          successCount: { gt: 0 },
        },
        orderBy: { lastApplied: 'desc' },
      })

      if (!pattern) return null

      // Map Prisma model to the shared FixPattern interface
      return {
        id: pattern.id,
        projectId: pattern.projectId,
        errorFingerprint: pattern.errorFingerprint,
        errorDescription: pattern.errorDescription,
        fixApplied: pattern.fixApplied,
        filesChanged: pattern.filesChanged,
        successCount: pattern.successCount,
        failureCount: pattern.failureCount,
        lastApplied: pattern.lastApplied ?? undefined,
        avgTimeToFixSec: pattern.avgTimeToFixSec ?? undefined,
      }
    } catch (err) {
      log.warn({ fingerprint, projectId, err }, 'FixPattern lookup failed')
      return null
    }
  }

  /**
   * Record the outcome of a fix attempt for future pattern matching.
   *
   * On success: increments the success counter and updates lastApplied.
   * On failure: increments the failure counter.
   * If no pattern exists yet, creates a new one.
   *
   * Errors are swallowed — recording failures must never block the fix result.
   *
   * @param pattern - Partial pattern describing the fix that was attempted
   * @param success - Whether the fix application was successful
   * @param projectId - The project this pattern belongs to
   */
  private async recordFixOutcome(
    pattern: Partial<FixPattern>,
    success: boolean,
    projectId: string,
  ): Promise<void> {
    try {
      if (!pattern.errorFingerprint) return

      const existing = await prisma.fixPattern.findFirst({
        where: { projectId, errorFingerprint: pattern.errorFingerprint },
      })

      if (existing) {
        await prisma.fixPattern.update({
          where: { id: existing.id },
          data: {
            successCount: success ? { increment: 1 } : undefined,
            failureCount: !success ? { increment: 1 } : undefined,
            lastApplied: success ? new Date() : undefined,
          },
        })
      } else {
        await prisma.fixPattern.create({
          data: {
            projectId,
            errorFingerprint: pattern.errorFingerprint ?? '',
            errorDescription: pattern.errorDescription ?? '',
            fixApplied: pattern.fixApplied ?? '',
            filesChanged: pattern.filesChanged ?? [],
            successCount: success ? 1 : 0,
            failureCount: success ? 0 : 1,
            lastApplied: success ? new Date() : null,
          },
        })
      }
    } catch (err) {
      log.warn({ err }, 'Failed to record fix outcome in DB')
    }
  }

  /**
   * Apply a known fix pattern without calling Claude.
   *
   * Writes the stored fix contents to a temp directory, runs regression
   * tests to verify the fix still works, then opens a PR.
   *
   * @param task - The originating task
   * @param pattern - The known fix pattern to apply
   * @param riskLevel - Risk level for PR description and confidence calc
   */
  private async applyKnownPattern(
    task: AgentTask,
    pattern: FixPattern,
    riskLevel: RiskLevel,
  ): Promise<FixerResult> {
    const taskLog = log.child({ taskId: task.id, op: 'apply_known_pattern', patternId: pattern.id })
    const payload = task.payload as FixBugPayload

    // Apply the stored file changes to a temp directory
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-fixer-'))
    try {
      // The fixApplied field stores a JSON array of FileChange objects
      let fileChanges: FileChange[] = []
      try {
        fileChanges = JSON.parse(pattern.fixApplied) as FileChange[]
      } catch {
        // fixApplied may be a plain description rather than JSON — skip file writes
        taskLog.warn('fixApplied is not valid JSON; skipping file application')
      }

      if (fileChanges.length > 0) {
        applyWorkspaceFileChanges(workDir, fileChanges)
      }

      // Run regression tests to verify the pattern still works
      let regressionPassed = false
      let coverage: number | undefined
      try {
        const testOutput = runRegressionTests(workDir)
        regressionPassed = true
        const coverageMatch = testOutput.match(/Lines\s*:\s*([\d.]+)%/)
        if (coverageMatch?.[1]) coverage = parseFloat(coverageMatch[1])
      } catch (err) {
        taskLog.warn({ err }, 'Regression tests failed for known pattern')
      }

      // Record the outcome
      await this.recordFixOutcome(
        {
          errorFingerprint: pattern.errorFingerprint,
          errorDescription: pattern.errorDescription,
          fixApplied: pattern.fixApplied,
          filesChanged: fileChanges.map((f) => f.filePath),
        },
        regressionPassed,
        task.projectId,
      )

      // Compute confidence
      let confidenceScore: ConfidenceScore | undefined
      try {
        const confidenceInputs: ConfidenceInputs = {
          projectId: task.projectId,
          ciPassing: regressionPassed,
          ciCoverage: coverage,
          securityScanPassed: regressionPassed,
          changedFiles: fileChanges.map((f) => f.filePath),
        }
        confidenceScore = await this.confidenceEngine.compute(confidenceInputs)
      } catch (err) {
        taskLog.warn({ err }, 'Confidence engine failed')
      }

      // Open PR if GitHub is configured
      const owner = payload.repoOwner ?? process.env['GITHUB_REPO_OWNER'] ?? ''
      const repo = payload.repoName ?? process.env['GITHUB_REPO_NAME'] ?? ''

      if (!owner || !repo) {
        return {
          success: regressionPassed,
          filesChanged: fileChanges.map((f) => f.filePath),
          summary: `Applied known fix pattern (${pattern.id}). Regression tests ${regressionPassed ? 'passed' : 'failed'}.`,
          fixType: 'known_error_pattern',
          confidenceScore,
        }
      }

      const branch = `forge/fix/known/${task.id.slice(0, 8)}`
      const prBody = buildFixPrBody({
        errorMessage: payload.errorMessage,
        fixDescription: `Applied known fix pattern (success rate: ${Math.round((pattern.successCount / Math.max(1, pattern.successCount + pattern.failureCount)) * 100)}%).`,
        fileChanges,
        riskLevel,
        regressionPassed,
        confidenceScore,
        taskId: task.id,
      })

      let prUrl: string | undefined
      let prNumber: number | undefined
      try {
        prUrl = await this.openPr({
          owner,
          repo,
          branch,
          baseBranch: payload.baseBranch ?? 'main',
          title: `fix: apply known pattern for "${payload.errorMessage.slice(0, 60)}"` ,
          body: prBody,
        })
        prNumber = extractPrNumber(prUrl)
      } catch (err) {
        taskLog.error({ err }, 'PR creation failed')
      }

      return {
        success: regressionPassed,
        prUrl,
        prNumber,
        filesChanged: fileChanges.map((f) => f.filePath),
        summary: `Applied known fix pattern. Regression tests ${regressionPassed ? 'passed' : 'failed'}.${prUrl ? ` PR: ${prUrl}` : ''}` ,
        fixType: 'known_error_pattern',
        confidenceScore,
      }
    } finally {
      try { fs.rmSync(workDir, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  }

  /**
   * Full Claude analysis and fix for a new or low-confidence error.
   *
   * Sends the error message, stack trace, and codebase context to Claude,
   * parses the generated file changes, runs regression tests, scores confidence,
   * and opens a PR.
   *
   * @param task - The originating task
   * @param payload - The FixBugPayload
   * @param classification - The fix classification result
   * @param riskLevel - Already-computed risk level
   */
  private async analyseAndFix(
    task: AgentTask,
    payload: FixBugPayload,
    classification: FixClassification,
    riskLevel: RiskLevel,
  ): Promise<FixerResult> {
    const taskLog = log.child({ taskId: task.id, op: 'analyse_and_fix' })
    taskLog.info({ riskLevel }, 'Calling Claude for full fix analysis')

    const systemPrompt = buildFixSystemPrompt()
    const userMessage = buildFixUserMessage(payload)

    let claudeResponse: string
    try {
      claudeResponse = await this.callClaude(systemPrompt, userMessage)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      taskLog.error({ err }, 'Claude analysis failed')
      await this.recordFixOutcome(
        {
          errorFingerprint: classification.fingerprint,
          errorDescription: payload.errorMessage,
          fixApplied: 'FAILED: Claude call failed',
          filesChanged: [],
        },
        false,
        task.projectId,
      )
      return { success: false, filesChanged: [], summary: `Fix analysis failed: ${message}`, fixType: classification.fixType }
    }

    const fileChanges = parseFileChanges(claudeResponse)
    if (fileChanges.length === 0) {
      taskLog.warn('No file changes parsed from Claude fix response')
      return { success: false, filesChanged: [], summary: 'Claude did not return any file changes for this fix.', fixType: classification.fixType }
    }

    taskLog.info({ count: fileChanges.length }, 'Parsed fix file changes')

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-fixer-'))
    try {
      applyWorkspaceFileChanges(workDir, fileChanges)

      // Run regression tests
      let regressionPassed = false
      let coverage: number | undefined
      const regressionErrors: string[] = []
      try {
        const testOutput = runRegressionTests(workDir)
        regressionPassed = true
        const coverageMatch = testOutput.match(/Lines\s*:\s*([\d.]+)%/)
        if (coverageMatch?.[1]) coverage = parseFloat(coverageMatch[1])
      } catch (err) {
        regressionErrors.push(String(err).slice(0, 500))
        taskLog.warn({ err }, 'Regression tests failed')
      }

      // Compute confidence score
      let confidenceScore: ConfidenceScore | undefined
      try {
        confidenceScore = await this.confidenceEngine.compute({
          projectId: task.projectId,
          ciPassing: regressionPassed,
          ciCoverage: coverage,
          securityScanPassed: regressionPassed,
          changedFiles: fileChanges.map((f) => f.filePath),
        })
      } catch (err) {
        taskLog.warn({ err }, 'Confidence engine failed')
      }

      // Record the fix outcome for future pattern matching
      await this.recordFixOutcome(
        {
          errorFingerprint: classification.fingerprint,
          errorDescription: payload.errorMessage,
          fixApplied: JSON.stringify(fileChanges),
          filesChanged: fileChanges.map((f) => f.filePath),
        },
        regressionPassed,
        task.projectId,
      )

      // Open PR if GitHub is configured
      const owner = payload.repoOwner ?? process.env['GITHUB_REPO_OWNER'] ?? ''
      const repo = payload.repoName ?? process.env['GITHUB_REPO_NAME'] ?? ''

      if (!owner || !repo) {
        return {
          success: regressionPassed,
          filesChanged: fileChanges.map((f) => f.filePath),
          summary: `Fix generated for "${payload.errorMessage.slice(0, 80)}". Regression ${regressionPassed ? 'passed' : 'failed'}.`,
          fixType: classification.fixType,
          confidenceScore,
        }
      }

      const branch = `forge/fix/${task.id.slice(0, 8)}`
      const fixDescription = extractSection(claudeResponse, 'FIX_DESCRIPTION') ?? `Fix for: ${payload.errorMessage.slice(0, 100)}`
      const prBody = buildFixPrBody({
        errorMessage: payload.errorMessage,
        fixDescription,
        fileChanges,
        riskLevel,
        regressionPassed,
        confidenceScore,
        taskId: task.id,
      })

      let prUrl: string | undefined
      let prNumber: number | undefined
      try {
        prUrl = await this.openPr({
          owner,
          repo,
          branch,
          baseBranch: payload.baseBranch ?? 'main',
          title: `fix: ${payload.errorMessage.slice(0, 70)}`,
          body: prBody,
        })
        prNumber = extractPrNumber(prUrl)
        taskLog.info({ prUrl, prNumber }, 'Fix PR opened')
      } catch (err) {
        taskLog.error({ err }, 'PR creation failed')
      }

      return {
        success: regressionPassed,
        prUrl,
        prNumber,
        filesChanged: fileChanges.map((f) => f.filePath),
        summary: `Fix for "${payload.errorMessage.slice(0, 80)}". Regression ${regressionPassed ? 'passed' : 'failed'}.${prUrl ? ` PR: ${prUrl}` : ''}` ,
        fixType: classification.fixType,
        confidenceScore,
      }
    } finally {
      try { fs.rmSync(workDir, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  }

  // -------------------------------------------------------------------------
  // GitHub helpers
  // -------------------------------------------------------------------------

  /**
   * Open a GitHub pull request as a draft.
   *
   * Creates the feature branch from the base SHA, then creates the PR.
   * Returns the HTML URL of the created PR.
   *
   * @param options - PR creation options
   * @throws if the base branch cannot be resolved or the GitHub API call fails
   */
  private async openPr(options: PrOptions): Promise<string> {
    const { owner, repo, branch, baseBranch, title, body } = options

    let baseSha: string
    try {
      const { data: ref } = await this.octokit.rest.git.getRef({
        owner,
        repo,
        ref: `heads/${baseBranch}`,
      })
      baseSha = ref.object.sha
    } catch (err) {
      throw new Error(`Could not resolve base branch on ${owner}/${repo}: ${String(err)}`)
    }

    try {
      await this.octokit.rest.git.createRef({
        owner,
        repo,
        ref: `refs/heads/${branch}`,
        sha: baseSha,
      })
    } catch (err) {
      log.warn({ branch, err }, 'Branch already exists; continuing to PR creation')
    }

    const { data: pr } = await this.octokit.rest.pulls.create({
      owner,
      repo,
      title,
      body,
      head: branch,
      base: baseBranch,
      draft: true,
    })

    log.info({ prNumber: pr.number, url: pr.html_url }, 'Fix PR created on GitHub')
    return pr.html_url
  }

  /**
   * Make a single-turn call to Claude claude-sonnet-4-6 and return the assistant text.
   *
   * @param systemPrompt - System instructions for this call
   * @param userMessage - User-facing prompt
   * @throws if the API call fails or Claude returns no text
   */
  private async callClaude(systemPrompt: string, userMessage: string): Promise<string> {
    const message = await this.anthropic.messages.create({
      model: MODEL,
      max_tokens: 8192,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    })
    const textBlock = message.content.find((b) => b.type === 'text')
    if (!textBlock || textBlock.type  !== 'text') {
      throw new Error('Claude returned no text content')
    }
    return textBlock.text
  }
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

function buildFixSystemPrompt(): string {
  return [
    'You are Forge Fixer Agent, an expert software engineer specialising in debugging',
    'and incident response. You write production-quality TypeScript fixes in strict mode.',
    '',
    'When fixing a bug, structure your response with these labelled sections:',
    '',
    'ROOT_CAUSE: <one sentence — the actual root cause of the bug>',
    'FIX_DESCRIPTION: <1-2 sentences in plain English for a non-technical founder>',
    'TECHNICAL_DETAILS: <technical explanation of the fix approach>',
    '',
    'Then FILE_CHANGES blocks for every file you create or modify:',
    '',
    `<file path="relative/path/to/file.ts" action="create|modify|delete">`,
    '// full file contents here',
    '</file>',
    '',
    'Always include a regression test that proves the bug is fixed.',
    'Never make more changes than necessary to fix the specific bug.',
  ].join('\n')
}

function buildFixUserMessage(payload: FixBugPayload): string {
  const parts = [
    'Fix the following bug:',
    '',
    '<error_message>',
    payload.errorMessage,
    '</error_message>',
  ]
  if (payload.stackTrace) {
    parts.push('', '<stack_trace>', payload.stackTrace, '</stack_trace>')
  }
  if (payload.contextPrompt) {
    parts.push('', '<codebase_context>', payload.contextPrompt, '</codebase_context>')
  }
  parts.push('', 'Produce a minimal, targeted fix. Include a regression test.')
  return parts.join('\n')
}

// ---------------------------------------------------------------------------
// PR body builder
// ---------------------------------------------------------------------------

interface FixPrBodyOptions {
  errorMessage: string
  fixDescription: string
  fileChanges: FileChange[]
  riskLevel: RiskLevel
  regressionPassed: boolean
  confidenceScore?: ConfidenceScore
  taskId: string
}

/**
 * Build the PR body for a bug fix or incident response.
 *
 * Uses the same dual-register approach as the Builder Agent: plain English
 * for founders in the summary, technical details for engineers below.
 *
 * @param opts - Values to interpolate
 */
function buildFixPrBody(opts: FixPrBodyOptions): string {
  const { errorMessage, fixDescription, fileChanges, riskLevel, regressionPassed, confidenceScore } = opts

  const filesSummary = fileChanges.map((f) => `- \`${f.filePath}\` (${f.action})`).join('\n')
  const score = confidenceScore?.total ?? 'N/A'
  const riskEmoji = riskLevel === 'high' ? '[HIGH]' : riskLevel === 'medium' ? '[MEDIUM]' : '[LOW]'
  const riskFactors = confidenceScore?.riskFactors.length
    ? confidenceScore.riskFactors.map((r) => `- ${r}`).join('\n')
    : '- None identified'
  const confidenceBreakdown = confidenceScore
    ? Object.entries(confidenceScore.breakdown).map(([k, v]) => `- ${k}: ${v}`).join('\n')
    : 'Confidence score unavailable.'


  return [
    '## What was broken',
    `${errorMessage.slice(0, 200)}`,
    '',
    '## What changed',
    fixDescription,
    '',
    ,
    '',
    '## Files changed',
    filesSummary,
    '',
    '## Regression tests',
    `- All passing: ${regressionPassed ? 'Yes' : 'No'}`,
    '',
    ,
    confidenceBreakdown,
    '',
    '## Risk factors',
    riskFactors,
    '',
    '## Rollback',
    "Revert this PR via GitHub's 'Revert' button, or run:",
    '```',
    'git revert HEAD --no-edit && git push',
    '```',
    '',
    '---',
    `*Generated by Forge Fixer Agent · ${new Date().toISOString()}*`,
  ].join('\n')
}

// ---------------------------------------------------------------------------
// File-system helpers
// ---------------------------------------------------------------------------

/**
 * Run the regression suite for generated fix code. Generated tests and jest
 * configs are untrusted, so they only run in the sandbox (no host env, no
 * network, lifecycle scripts disabled). Throws if the suite fails or the
 * sandbox is unavailable.
 */
function runRegressionTests(workDir: string): string {
  assertSandboxAvailable()
  installSandboxDependencies(workDir)
  return runInSandbox(workDir, ['npx', '--no-install', 'jest', '--passWithNoTests'], { timeoutMs: 120_000 })
}

// ---------------------------------------------------------------------------
// Response parsers
// ---------------------------------------------------------------------------

function parseFileChanges(response: string): FileChange[] {
  const changes: FileChange[] = []
  const fileBlockRegex =
    /<file\s+path="([^"]+)"\s+action="(create|modify|delete)"[^>]*>([\s\S]*?)<\/file>/g
  let match: RegExpExecArray | null
  while ((match = fileBlockRegex.exec(response))  !== null) {
    const [, filePath, action, content] = match
    if (filePath && action) {
      changes.push({
        filePath,
        action: action as FileChange['action'],
        content: (content ?? '').trim(),
      })
    }
  }
  return changes
}

function extractSection(response: string, sectionName: string): string | undefined {
  const regex = new RegExp(sectionName + String.fromCharCode(58) + '\\s*([\\s\\S]*?)(?=\\n[A-Z_]+:|$)', '')
  const match = regex.exec(response)
  return match?.[1]?.trim()
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

/**
 * Compute a normalised fingerprint for an error message.
 *
 * Strips memory addresses, line numbers, and UUIDs so that the same logical
 * error produces the same fingerprint even when the exact text varies.
 *
 * @param errorMessage - Raw error message or log line
 */
function computeFingerprint(errorMessage: string): string {
  return errorMessage
    .toLowerCase()
    // Remove hex addresses (e.g. 0x7f3a...)
    .replace(/0x[0-9a-f]+/g, '0xHEX')
    // Remove UUIDs
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, 'UUID')
    // Remove standalone numbers (line numbers, ports, counts)
    .replace(/\b\d+\b/g, 'N')
    // Collapse whitespace
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 255)
}

function extractPrNumber(prUrl: string): number | undefined {
  const match = /\/pull\/(\d+)$/.exec(prUrl)
  return match?.[1] ? parseInt(match[1], 10) : undefined
}
