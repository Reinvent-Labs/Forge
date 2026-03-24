import Anthropic from '@anthropic-ai/sdk'
import { Octokit } from 'octokit'
import fetch, { type RequestInit } from 'node-fetch'
import { execFile, type ExecFileOptions } from 'child_process'
import { promisify } from 'util'
import { randomUUID } from 'crypto'
import * as fs from 'fs/promises'
import * as fsSync from 'fs'
import * as path from 'path'

import { createContextLogger, createLogger } from '@forge/shared'
import type {
  AgentTask,
  AgentType,
  ForgeEvent,
  ForgeEventType,
  SecurityScore,
  Vulnerability,
} from '@forge/shared'
import { prisma } from '@forge/database'

const execFileAsync = promisify(execFile)
const log = createLogger('agent-security')

const SECURITY_MODEL = 'claude-haiku-4-5-20251001'
const MAX_GITHUB_RETRIES = 4
const MAX_SNYK_RETRIES = 4
const DEFAULT_MAX_COMMITS_TO_SCAN = 40
const MAX_FILE_SIZE_BYTES = 1_000_000

const IGNORED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
  '.cache',
])

const IGNORED_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.svg',
  '.pdf',
  '.zip',
  '.gz',
  '.tar',
  '.tgz',
  '.7z',
  '.mp4',
  '.mp3',
  '.mov',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.lockb',
])

const FALSE_POSITIVE_TOKENS = [
  'example',
  'changeme',
  'your_',
  'your-',
  'dummy',
  'sample',
  'placeholder',
  'test',
  'localhost',
]

export type ScanType =
  | 'DEPENDENCY_AUDIT'
  | 'SECRET_DETECTION'
  | 'SAST'
  | 'CONTAINER_SCAN'
  | 'LICENSE_COMPLIANCE'
  | 'CVE_WATCH'
  | 'API_SECURITY'

export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info'
export type DependencyProvider = 'auto' | 'npm' | 'snyk'
export type ScanScope = 'local' | 'github' | 'both'

export type SecretType =
  | 'aws_access_key'
  | 'aws_secret_key'
  | 'github_token'
  | 'slack_token'
  | 'stripe_key'
  | 'openai_key'
  | 'anthropic_key'
  | 'database_url'
  | 'jwt_secret'
  | 'generic_api_key'
  | 'private_key'
  | 'certificate'
  | 'generic'

export interface SecretInfo {
  name: string
  type: SecretType
  filePath: string
  lineNumber?: number
  commitSha?: string
  exposureStartedAt?: string
  partialValue?: string
  detector: 'local_file' | 'github_commit'
}

export interface DependencyPatch {
  packageName: string
  dependencySection:
    | 'dependencies'
    | 'devDependencies'
    | 'optionalDependencies'
    | 'peerDependencies'
  fromVersion: string
  toVersion: string
  filePath: string
  autoFixable: boolean
}

export interface PatchGenerationResult {
  patches: DependencyPatch[]
  filesChanged: string[]
}

export interface SecurityResult {
  taskId: string
  projectId: string
  scanType: ScanType
  success: boolean
  error?: string
  auditResult?: AuditResult
  secretScanResult?: SecretScanResult
  sastResult?: SastResult
  securityScore?: SecurityScore
  fixerTaskIds: string[]
  generatedPatches: DependencyPatch[]
  openedPrUrl?: string
  completedAt: Date
}

export interface AuditResult {
  projectId: string
  source: 'npm' | 'snyk' | 'combined' | 'github'
  totalVulnerabilities: number
  critical: number
  high: number
  medium: number
  low: number
  vulnerabilities: Vulnerability[]
  generatedPatches: DependencyPatch[]
  fixerTaskIds: string[]
  autoPrCreated: boolean
  autoPrUrl?: string
  rawOutput?: string
  scannedAt: Date
}

export interface SecretScanResult {
  projectId: string
  secretsFound: number
  localSecretsFound: number
  githubSecretsFound: number
  secrets: SecretInfo[]
  blocked: boolean
  scannedAt: Date
}

export interface SastFinding {
  ruleId: string
  severity: FindingSeverity
  filePath: string
  line: number
  message: string
  codeSnippet?: string
}

export interface SastResult {
  projectId: string
  totalFindings: number
  high: number
  medium: number
  low: number
  findings: SastFinding[]
  filesScanned: string[]
  scannedAt: Date
}

interface SecurityTaskPayload {
  scanType?: ScanType
  repoPath?: string
  changedFiles?: string[]
  dependencyProvider?: DependencyProvider
  scanScope?: ScanScope
  githubOwner?: string
  githubRepo?: string
  githubBaseBranch?: string
  maxCommitsToScan?: number
  snykOrgId?: string
  createPr?: boolean
  createFixerTasks?: boolean
}

interface DependencyAuditOptions {
  sourceTask?: AgentTask
  dependencyProvider?: DependencyProvider
  snykOrgId?: string
  githubOwner?: string
  githubRepo?: string
  githubBaseBranch?: string
  createPr?: boolean
  createFixerTasks?: boolean
  applyPatches?: boolean
}

interface SecretDetectionOptions {
  sourceTask?: AgentTask
  scanScope?: ScanScope
  githubOwner?: string
  githubRepo?: string
  githubBaseBranch?: string
  maxCommitsToScan?: number
}

interface SastTaskOptions {
  sourceTask?: AgentTask
}

interface ProjectRepositoryContext {
  owner: string | undefined
  repo: string | undefined
  baseBranch: string
}

interface SecurityAgentOptions {
  anthropic?: Anthropic
  octokit?: Octokit
  eventBus?: SecurityEventBus | undefined
  now?: () => Date
}

interface SecurityEventBus {
  publishEvent<T>(event: ForgeEvent<T>): Promise<void>
  dispatch?(task: AgentTask, agentType: AgentType): Promise<string>
}

interface NpmAuditAdvisory {
  source?: number
  name?: string
  dependency?: string
  title?: string
  url?: string
  severity?: string
  range?: string
}

interface NpmAuditVulnerability {
  name: string
  severity: string
  via: Array<string | NpmAuditAdvisory>
  range: string
  fixAvailable: boolean | { name: string; version: string; isSemVerMajor: boolean }
  isDirect: boolean
}

interface NpmAuditReport {
  auditReportVersion: number
  vulnerabilities: Record<string, NpmAuditVulnerability>
  metadata?: {
    vulnerabilities?: {
      info: number
      low: number
      moderate: number
      high: number
      critical: number
      total: number
    }
  }
}

interface NpmAuditExecutionResult {
  rawOutput: string
  vulnerabilities: Vulnerability[]
  counts: { critical: number; high: number; medium: number; low: number }
}

interface SnykApiIssue {
  id: string
  severity: string
  packageName: string
  version: string
  title?: string
  nearestFixedInVersion?: string
  identifiers?: {
    CVE?: string[]
    GHSA?: string[]
  }
  url?: string
}

interface SnykApiResponse {
  vulnerabilities?: SnykApiIssue[]
}

interface SemgrepResult {
  results: Array<{
    check_id: string
    path: string
    start: { line: number }
    extra: { severity: string; message: string; lines: string }
  }>
  errors: Array<{ message: string }>
}

interface SecretPattern {
  type: SecretType
  name: string
  regex: RegExp
  valueGroup?: number
}

interface PackageJsonShape {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  [key: string]: unknown
}

const SECRET_PATTERNS: SecretPattern[] = [
  {
    type: 'aws_access_key',
    name: 'AWS Access Key ID',
    regex: /\b(?:A3T[A-Z0-9]|AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)[A-Z0-9]{16}\b/g,
  },
  {
    type: 'aws_secret_key',
    name: 'AWS Secret Access Key',
    regex:
      /\b(?:aws[_-]?)?(?:secret|access)?[_-]?key\b[^\n]{0,24}[=:]\s*['"]([A-Za-z0-9/+=]{40})['"]/gi,
    valueGroup: 1,
  },
  {
    type: 'github_token',
    name: 'GitHub Token',
    regex: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{82,255})\b/g,
  },
  {
    type: 'slack_token',
    name: 'Slack Token',
    regex: /\bxox[baprs]-[A-Za-z0-9-]{10,200}\b/g,
  },
  {
    type: 'stripe_key',
    name: 'Stripe Key',
    regex: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  },
  {
    type: 'openai_key',
    name: 'OpenAI API Key',
    regex: /\bsk-[A-Za-z0-9]{20,}\b/g,
  },
  {
    type: 'anthropic_key',
    name: 'Anthropic API Key',
    regex: /\bsk-ant-[A-Za-z0-9\-_]{20,}\b/g,
  },
  {
    type: 'database_url',
    name: 'Database URL',
    regex: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s'"`]+/gi,
  },
  {
    type: 'jwt_secret',
    name: 'JWT Secret',
    regex: /\b(?:jwt[_-]?secret|signing[_-]?key)\b\s*[:=]\s*['"]([^'"\n]{12,})['"]/gi,
    valueGroup: 1,
  },
  {
    type: 'generic_api_key',
    name: 'Generic API Key',
    regex:
      /\b(?:api[_-]?key|client[_-]?secret|token|secret|password|passwd)\b\s*[:=]\s*['"]([^'"\n]{12,})['"]/gi,
    valueGroup: 1,
  },
  {
    type: 'private_key',
    name: 'Private Key Block',
    regex:
      /-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]{0,12000}?-----END (?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g,
  },
  {
    type: 'certificate',
    name: 'Certificate Block',
    regex: /-----BEGIN CERTIFICATE-----[\s\S]{0,12000}?-----END CERTIFICATE-----/g,
  },
]

/**
 * Security agent for dependency audits, secret detection, and security patching.
 *
 * Follows the BuilderAgent style:
 * - explicit constructor dependency checks
 * - single `handleTask` entrypoint
 * - strongly typed result payloads
 * - robust error handling and structured logging
 */
export class SecurityAgent {
  private readonly anthropic: Anthropic
  private readonly octokit: Octokit
  private readonly eventBus: SecurityEventBus | undefined
  private readonly now: () => Date

  constructor(options: SecurityAgentOptions = {}) {
    const anthropicKey = process.env['ANTHROPIC_API_KEY']
    if (!options.anthropic && !anthropicKey) {
      throw new Error('ANTHROPIC_API_KEY environment variable is required')
    }

    const githubToken = process.env['GITHUB_TOKEN']
    if (!options.octokit && !githubToken) {
      throw new Error('GITHUB_TOKEN environment variable is required')
    }

    this.anthropic = options.anthropic ?? new Anthropic({ apiKey: anthropicKey as string })
    this.octokit = options.octokit ?? new Octokit({ auth: githubToken as string })
    this.eventBus = options.eventBus
    this.now = options.now ?? (() => new Date())
  }

  /**
   * Main entry point used by the orchestrator worker.
   *
   * Supported task routing:
   * - `security_patch` and `dependency_update` -> `DEPENDENCY_AUDIT`
   * - explicit payload `scanType`
   * - default fallback -> `DEPENDENCY_AUDIT`
   */
  async handleTask(task: AgentTask): Promise<SecurityResult> {
    const taskLog = createContextLogger('agent-security', {
      taskId: task.id,
      projectId: task.projectId,
      scanType: 'unknown',
    })

    const payload = task.payload as SecurityTaskPayload
    const scanType = this.resolveScanType(task, payload)

    await this.publishTaskLifecycleEvent(task, 'task.started', { scanType })

    try {
      const repository = await this.resolveRepositoryContext(task.projectId, payload)
      const fixerTaskIds: string[] = []
      const generatedPatches: DependencyPatch[] = []
      let openedPrUrl: string | undefined

      if (scanType === 'DEPENDENCY_AUDIT') {
        const dependencyAuditOptions: DependencyAuditOptions = {
          sourceTask: task,
          githubBaseBranch: repository.baseBranch,
          createPr: payload.createPr ?? task.type === 'security_patch',
          createFixerTasks: payload.createFixerTasks ?? true,
          applyPatches:
            task.type === 'security_patch' || task.type === 'dependency_update' || payload.createPr === true,
        }

        if (payload.dependencyProvider !== undefined) {
          dependencyAuditOptions.dependencyProvider = payload.dependencyProvider
        }
        if (payload.snykOrgId !== undefined) {
          dependencyAuditOptions.snykOrgId = payload.snykOrgId
        }
        if (repository.owner !== undefined) {
          dependencyAuditOptions.githubOwner = repository.owner
        }
        if (repository.repo !== undefined) {
          dependencyAuditOptions.githubRepo = repository.repo
        }

        const auditResult = await this.runDependencyAudit(
          task.projectId,
          payload.repoPath,
          dependencyAuditOptions,
        )

        fixerTaskIds.push(...auditResult.fixerTaskIds)
        generatedPatches.push(...auditResult.generatedPatches)
        openedPrUrl = auditResult.autoPrUrl

        const securityScore = await this.computeSecurityScore(task.projectId)

        await this.publishTaskLifecycleEvent(task, 'task.completed', {
          scanType,
          vulnerabilities: auditResult.totalVulnerabilities,
          securityScore: securityScore.total,
        })

        return {
          taskId: task.id,
          projectId: task.projectId,
          scanType,
          success: true,
          auditResult,
          securityScore,
          fixerTaskIds,
          generatedPatches,
          ...(openedPrUrl !== undefined ? { openedPrUrl } : {}),
          completedAt: this.now(),
        }
      }

      if (scanType === 'SECRET_DETECTION') {
        if (!payload.repoPath && !repository.owner) {
          throw new Error('SECRET_DETECTION requires repoPath (local scan) or GitHub repository details')
        }

        const secretDetectionOptions: SecretDetectionOptions = {
          sourceTask: task,
          scanScope: payload.scanScope ?? (payload.repoPath && repository.owner ? 'both' : payload.repoPath ? 'local' : 'github'),
          githubBaseBranch: repository.baseBranch,
        }
        if (repository.owner !== undefined) {
          secretDetectionOptions.githubOwner = repository.owner
        }
        if (repository.repo !== undefined) {
          secretDetectionOptions.githubRepo = repository.repo
        }
        if (payload.maxCommitsToScan !== undefined) {
          secretDetectionOptions.maxCommitsToScan = payload.maxCommitsToScan
        }

        const secretScanResult = await this.runSecretDetection(
          task.projectId,
          payload.repoPath,
          secretDetectionOptions,
        )

        const securityScore = await this.computeSecurityScore(task.projectId)

        await this.publishTaskLifecycleEvent(task, 'task.completed', {
          scanType,
          secretsFound: secretScanResult.secretsFound,
          securityScore: securityScore.total,
        })

        return {
          taskId: task.id,
          projectId: task.projectId,
          scanType,
          success: true,
          secretScanResult,
          securityScore,
          fixerTaskIds,
          generatedPatches,
          completedAt: this.now(),
        }
      }

      if (scanType === 'SAST') {
        if (!payload.repoPath) {
          throw new Error('SAST requires repoPath')
        }

        const sastResult = await this.runSast(task.projectId, payload.repoPath, payload.changedFiles ?? [], {
          sourceTask: task,
        })
        const securityScore = await this.computeSecurityScore(task.projectId)

        await this.publishTaskLifecycleEvent(task, 'task.completed', {
          scanType,
          findings: sastResult.totalFindings,
          securityScore: securityScore.total,
        })

        return {
          taskId: task.id,
          projectId: task.projectId,
          scanType,
          success: true,
          sastResult,
          securityScore,
          fixerTaskIds,
          generatedPatches,
          completedAt: this.now(),
        }
      }

      const securityScore = await this.computeSecurityScore(task.projectId)

      await this.publishTaskLifecycleEvent(task, 'task.completed', {
        scanType,
        securityScore: securityScore.total,
      })

      return {
        taskId: task.id,
        projectId: task.projectId,
        scanType,
        success: true,
        securityScore,
        fixerTaskIds,
        generatedPatches,
        completedAt: this.now(),
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)

      taskLog.error({ err, scanType }, 'Security task failed')

      await this.persistSecurityScan(task.projectId, scanType, {
        status: 'FAILED',
        findingsCount: { critical: 0, high: 0, medium: 0, low: 0 },
        data: { reason: message },
        findings: [],
        errorMessage: message,
      })

      await this.publishTaskLifecycleEvent(task, 'task.failed', {
        scanType,
        error: message,
      })

      return {
        taskId: task.id,
        projectId: task.projectId,
        scanType,
        success: false,
        error: message,
        fixerTaskIds: [],
        generatedPatches: [],
        completedAt: this.now(),
      }
    }
  }

  /**
   * Runs dependency scanning using npm audit and optional Snyk API.
   *
   * Behavior:
   * 1. Run npm audit when repoPath is available
   * 2. Optionally augment with Snyk API findings
   * 3. Optionally fall back to GitHub Dependabot alerts for remote-only scan
   * 4. Generate patches for fixable vulnerabilities
   * 5. Create Fixer tasks for auto-fixable findings
   * 6. Optionally open a GitHub PR with the generated dependency updates
   */
  async runDependencyAudit(
    projectId: string,
    repoPath: string | undefined,
    options: DependencyAuditOptions = {},
  ): Promise<AuditResult> {
    const auditLog = createContextLogger('agent-security', {
      projectId,
      op: 'dependency_audit',
    })

    const provider = options.dependencyProvider ?? 'auto'
    const vulnerabilities: Vulnerability[] = []
    const sourceLabels: Array<'npm' | 'snyk' | 'github'> = []
    const rawOutputs: string[] = []

    if (repoPath && (provider === 'auto' || provider === 'npm')) {
      const npmAudit = await this.runNpmAudit(repoPath)
      vulnerabilities.push(...npmAudit.vulnerabilities)
      rawOutputs.push(npmAudit.rawOutput)
      sourceLabels.push('npm')
    }

    const snykToken = process.env['SNYK_TOKEN']
    if (
      repoPath &&
      snykToken &&
      (provider === 'auto' || provider === 'snyk')
    ) {
      try {
        const snykOptions: { token: string; orgId?: string } = {
          token: snykToken,
        }
        if (options.snykOrgId !== undefined) {
          snykOptions.orgId = options.snykOrgId
        }

        const snykVulnerabilities = await this.runSnykAudit(repoPath, snykOptions)
        vulnerabilities.push(...snykVulnerabilities)
        sourceLabels.push('snyk')
      } catch (err) {
        auditLog.warn({ err }, 'Snyk API scan failed, continuing with available scan sources')
      }
    }

    if (!repoPath && options.githubOwner && options.githubRepo) {
      try {
        const githubVulnerabilities = await this.scanGitHubDependabotAlerts(
          options.githubOwner,
          options.githubRepo,
        )
        vulnerabilities.push(...githubVulnerabilities)
        sourceLabels.push('github')
      } catch (err) {
        auditLog.warn({ err }, 'GitHub Dependabot scan failed')
      }
    }

    const dedupedVulnerabilities = dedupeVulnerabilities(vulnerabilities)
    const counts = countVulnerabilitySeverities(dedupedVulnerabilities)
    const autoFixable = dedupedVulnerabilities.filter((v) => Boolean(v.fixedVersion))

    let generatedPatches: DependencyPatch[] = []
    let filesChanged: string[] = []

    if (repoPath && autoFixable.length > 0) {
      const patchResult = await this.generateSecurityPatches(repoPath, autoFixable, options.applyPatches ?? false)
      generatedPatches = patchResult.patches
      filesChanged = patchResult.filesChanged
    }

    let fixerTaskIds: string[] = []
    if ((options.createFixerTasks ?? true) && autoFixable.length > 0) {
      fixerTaskIds = await this.createFixerTasksForVulnerabilities(
        projectId,
        autoFixable,
        options.sourceTask,
        repoPath,
      )
    }

    let autoPrUrl: string | undefined
    if (
      options.createPr &&
      repoPath &&
      filesChanged.length > 0 &&
      options.githubOwner &&
      options.githubRepo
    ) {
      const prOptions: {
        owner: string
        repo: string
        baseBranch: string
        repoPath: string
        filesChanged: string[]
        vulnerabilities: Vulnerability[]
        patches: DependencyPatch[]
        taskId?: string
      } = {
        owner: options.githubOwner,
        repo: options.githubRepo,
        baseBranch: options.githubBaseBranch ?? 'main',
        repoPath,
        filesChanged,
        vulnerabilities: dedupedVulnerabilities,
        patches: generatedPatches,
      }

      if (options.sourceTask?.id !== undefined) {
        prOptions.taskId = options.sourceTask.id
      }

      autoPrUrl = await this.openSecurityFixPr(prOptions)

      if (options.sourceTask) {
        await this.publishForgeEvent(options.sourceTask, 'security.alert', {
          type: 'dependency_patch_pr_opened',
          prUrl: autoPrUrl,
          vulnerabilities: counts,
        })
      }
    }

    await this.persistSecurityScan(projectId, 'DEPENDENCY_AUDIT', {
      status: 'COMPLETED',
      findingsCount: counts,
      data: {
        source: inferAuditSource(sourceLabels),
        autoFixableCount: autoFixable.length,
        generatedPatchCount: generatedPatches.length,
      },
      findings: dedupedVulnerabilities,
    })

    if (options.sourceTask && dedupedVulnerabilities.length > 0) {
      await this.publishForgeEvent(options.sourceTask, 'security.alert', {
        type: 'dependency_vulnerabilities_detected',
        total: dedupedVulnerabilities.length,
        counts,
      })
    }

    return {
      projectId,
      source: inferAuditSource(sourceLabels),
      totalVulnerabilities: dedupedVulnerabilities.length,
      critical: counts.critical,
      high: counts.high,
      medium: counts.medium,
      low: counts.low,
      vulnerabilities: dedupedVulnerabilities,
      generatedPatches,
      fixerTaskIds,
      autoPrCreated: Boolean(autoPrUrl),
      ...(autoPrUrl !== undefined ? { autoPrUrl } : {}),
      ...(rawOutputs.length > 0 ? { rawOutput: rawOutputs.join('\n\n') } : {}),
      scannedAt: this.now(),
    }
  }

  /**
   * Generate dependency patches from auto-fixable vulnerabilities.
   *
   * When `applyChanges` is true, this method updates package.json and refreshes
   * package-lock.json (best effort). When false, it returns a dry-run patch plan.
   */
  async generateSecurityPatches(
    repoPath: string,
    vulnerabilities: Vulnerability[],
    applyChanges = true,
  ): Promise<PatchGenerationResult> {
    const packageJsonPath = path.join(repoPath, 'package.json')
    if (!fsSync.existsSync(packageJsonPath)) {
      return { patches: [], filesChanged: [] }
    }

    const packageJsonRaw = await fs.readFile(packageJsonPath, 'utf8')
    const packageJson = JSON.parse(packageJsonRaw) as PackageJsonShape

    const nextPackageJson = JSON.parse(JSON.stringify(packageJson)) as PackageJsonShape
    const patches: DependencyPatch[] = []

    for (const vulnerability of vulnerabilities) {
      if (!vulnerability.fixedVersion) {
        continue
      }

      const sections: Array<
        'dependencies' | 'devDependencies' | 'optionalDependencies' | 'peerDependencies'
      > = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']

      for (const section of sections) {
        const deps = nextPackageJson[section]
        if (!deps) {
          continue
        }

        const current = deps[vulnerability.packageName]
        if (!current) {
          continue
        }

        if (!isSupportedDependencyRange(current)) {
          continue
        }

        const targetVersionRange = applyPreferredRange(current, vulnerability.fixedVersion)
        if (targetVersionRange === current) {
          continue
        }

        deps[vulnerability.packageName] = targetVersionRange
        patches.push({
          packageName: vulnerability.packageName,
          dependencySection: section,
          fromVersion: current,
          toVersion: targetVersionRange,
          filePath: 'package.json',
          autoFixable: true,
        })
      }
    }

    const filesChanged: string[] = []

    if (patches.length > 0 && applyChanges) {
      await fs.writeFile(packageJsonPath, JSON.stringify(nextPackageJson, null, 2) + '\n', 'utf8')
      filesChanged.push('package.json')

      const lockfileUpdated = await this.refreshPackageLock(repoPath)
      if (lockfileUpdated) {
        filesChanged.push('package-lock.json')
      }
    }

    return {
      patches,
      filesChanged,
    }
  }

  /**
   * Secret detection supporting both local repository scans and GitHub commit scans.
   */
  async runSecretDetection(
    projectId: string,
    repoPath: string | undefined,
    options: SecretDetectionOptions = {},
  ): Promise<SecretScanResult> {
    const scanScope = options.scanScope ?? 'local'
    const shouldScanLocal = scanScope === 'local' || scanScope === 'both'
    const shouldScanGitHub = scanScope === 'github' || scanScope === 'both'

    const localSecrets =
      shouldScanLocal && repoPath
        ? await this.scanLocalRepositoryForSecrets(repoPath)
        : []

    const githubSecrets =
      shouldScanGitHub && options.githubOwner && options.githubRepo
        ? await this.scanGitHubCommitsForSecrets(
            options.githubOwner,
            options.githubRepo,
            options.githubBaseBranch ?? 'main',
            options.maxCommitsToScan ?? DEFAULT_MAX_COMMITS_TO_SCAN,
          )
        : []

    const allSecrets = dedupeSecrets([...localSecrets, ...githubSecrets])
    const blocked = allSecrets.length > 0

    await this.persistSecurityScan(projectId, 'SECRET_DETECTION', {
      status: 'COMPLETED',
      findingsCount: {
        critical: blocked ? allSecrets.length : 0,
        high: 0,
        medium: 0,
        low: 0,
      },
      data: {
        secretsFound: allSecrets.length,
        localSecretsFound: localSecrets.length,
        githubSecretsFound: githubSecrets.length,
      },
      findings: allSecrets,
    })

    if (blocked) {
      for (const secret of allSecrets.slice(0, 25)) {
        await this.handleSecretExposure(projectId, secret)
      }
    }

    if (options.sourceTask && allSecrets.length > 0) {
      await this.publishForgeEvent(options.sourceTask, 'security.alert', {
        type: 'secret_exposure_detected',
        secretsFound: allSecrets.length,
        localSecretsFound: localSecrets.length,
        githubSecretsFound: githubSecrets.length,
      })
    }

    return {
      projectId,
      secretsFound: allSecrets.length,
      localSecretsFound: localSecrets.length,
      githubSecretsFound: githubSecrets.length,
      secrets: allSecrets,
      blocked,
      scannedAt: this.now(),
    }
  }

  /**
   * Run Semgrep static analysis. Missing Semgrep binary is treated as a soft
   * failure with empty findings.
   */
  async runSast(
    projectId: string,
    repoPath: string,
    changedFiles: string[],
    options: SastTaskOptions = {},
  ): Promise<SastResult> {
    const targets = changedFiles.length > 0 ? changedFiles : [repoPath]

    let raw: SemgrepResult = { results: [], errors: [] }
    try {
      const { stdout } = await this.execCommand('semgrep', ['--config', 'p/security-audit', '--json', ...targets], {
        cwd: repoPath,
        timeout: 180_000,
      })
      raw = JSON.parse(stdout) as SemgrepResult
    } catch (err: unknown) {
      if (isRecord(err) && typeof err['stdout'] === 'string') {
        try {
          raw = JSON.parse(err['stdout']) as SemgrepResult
        } catch {}
      }
    }

    const findings: SastFinding[] = raw.results.map((entry) => ({
      ruleId: entry.check_id,
      severity: mapSemgrepSeverity(entry.extra.severity),
      filePath: entry.path,
      line: entry.start.line,
      message: entry.extra.message,
      codeSnippet: entry.extra.lines,
    }))

    const high = findings.filter((f) => f.severity === 'critical' || f.severity === 'high').length
    const medium = findings.filter((f) => f.severity === 'medium').length
    const low = findings.filter((f) => f.severity === 'low' || f.severity === 'info').length

    await this.persistSecurityScan(projectId, 'SAST', {
      status: 'COMPLETED',
      findingsCount: { critical: 0, high, medium, low },
      data: {
        totalFindings: findings.length,
      },
      findings,
    })

    if (options.sourceTask && findings.length > 0) {
      await this.publishForgeEvent(options.sourceTask, 'security.alert', {
        type: 'sast_findings_detected',
        totalFindings: findings.length,
        high,
        medium,
        low,
      })
    }

    return {
      projectId,
      totalFindings: findings.length,
      high,
      medium,
      low,
      findings,
      filesScanned: [...new Set(findings.map((f) => f.filePath))],
      scannedAt: this.now(),
    }
  }

  /**
   * Compute a 0-100 security score from the latest scan snapshots.
   *
   * Scoring model:
   * - Critical vulnerability: -22
   * - High vulnerability:     -12
   * - Medium vulnerability:   -6
   * - Secret exposure:        -25
   * - Outdated dependencies:  -2
   * - SAST findings:          -3 each
   * - Last scan age (days):   -1/day (max 30)
   */
  async computeSecurityScore(projectId: string): Promise<SecurityScore> {
    const scans = await prisma.securityScan.findMany({
      where: {
        projectId,
        status: 'COMPLETED',
      },
      orderBy: { completedAt: 'desc' },
      take: 60,
    })

    const latestByType = new Map<string, (typeof scans)[number]>()
    for (const scan of scans) {
      if (!latestByType.has(scan.scanType)) {
        latestByType.set(scan.scanType, scan)
      }
    }

    const dependencyScan = latestByType.get('DEPENDENCY_AUDIT')
    const secretScan = latestByType.get('SECRET_DETECTION')
    const sastScan = latestByType.get('SAST')

    const dependencyCounts = parseCountRecord(dependencyScan?.findingsCount)
    const secretData = parseDataRecord(secretScan?.data)
    const sastData = parseDataRecord(sastScan?.data)

    const secretsExposed = toInteger(secretData['secretsFound'])
    const outdatedDependencies = toInteger(secretData['outdatedDependencies'])
    const sastFindings = toInteger(sastData['totalFindings'])

    const latestScanTimestamp = scans[0]?.completedAt ?? scans[0]?.startedAt
    const lastScanAgeDays = latestScanTimestamp
      ? Math.max(0, Math.floor((this.now().getTime() - latestScanTimestamp.getTime()) / 86_400_000))
      : 30

    const penalty =
      dependencyCounts.critical * 22 +
      dependencyCounts.high * 12 +
      dependencyCounts.medium * 6 +
      secretsExposed * 25 +
      outdatedDependencies * 2 +
      sastFindings * 3 +
      Math.min(30, lastScanAgeDays)

    const total = clampScore(100 - penalty)

    const breakdown: SecurityScore['breakdown'] = {
      criticalVulnerabilities: dependencyCounts.critical,
      highVulnerabilities: dependencyCounts.high,
      mediumVulnerabilities: dependencyCounts.medium,
      secretsExposed,
      outdatedDependencies,
      lastScanAge: Math.min(30, lastScanAgeDays),
      sastFindings,
    }

    const previousSnapshot = await prisma.projectMetricsSnapshot.findMany({
      where: {
        projectId,
        securityScore: { not: null },
      },
      orderBy: { capturedAt: 'desc' },
      take: 1,
      select: { securityScore: true },
    })

    const previousScore = previousSnapshot[0]?.securityScore
    const trend: SecurityScore['trend'] =
      previousScore === null || previousScore === undefined
        ? 'stable'
        : total >= previousScore + 3
          ? 'improving'
          : total <= previousScore - 3
            ? 'degrading'
            : 'stable'

    try {
      await prisma.projectMetricsSnapshot.create({
        data: {
          projectId,
          securityScore: total,
        },
      })
    } catch (err) {
      log.warn({ projectId, err }, 'Failed to persist security score snapshot')
    }

    return {
      total,
      breakdown,
      trend,
      lastUpdated: this.now(),
    }
  }

  /**
   * Secret exposure incident handling protocol.
   *
   * This method detects and notifies only. It does not rotate credentials.
   */
  async handleSecretExposure(projectId: string, secret: SecretInfo): Promise<void> {
    const exposureLog = createContextLogger('agent-security', {
      projectId,
      secretType: secret.type,
      filePath: secret.filePath,
      commitSha: secret.commitSha,
    })

    exposureLog.error('Secret exposure detected')

    const incident = await prisma.incident.create({
      data: {
        projectId,
        title: `Secret exposed: ${secret.type}`,
        description:
          `A ${secret.type} credential pattern was detected in ${secret.filePath}. ` +
          'Credential rotation must be handled by an owner/admin.',
        severity: 'CRITICAL',
        status: 'OPEN',
        affectedModules: [secret.filePath],
        detectedAt: this.now(),
      },
    })

    const remediationPrompt = [
      `A potential ${secret.type} secret exposure was detected.`,
      `File: ${secret.filePath}`,
      secret.lineNumber !== undefined ? `Line: ${secret.lineNumber}` : '',
      secret.commitSha !== undefined ? `Commit: ${secret.commitSha}` : '',
      '',
      'Provide a concise remediation checklist with these constraints:',
      '1. Include revoke/rotate guidance for the secret type.',
      '2. Include git history cleanup steps.',
      '3. Include monitoring and prevention controls.',
      '4. Never propose auto-rotation by the agent.',
      '',
      'Return numbered steps only.',
    ]
      .filter(Boolean)
      .join('\n')

    let remediationNotes =
      '1. Revoke and rotate the exposed credential in the source provider.\n' +
      '2. Remove the secret from repository history using git-filter-repo or BFG.\n' +
      '3. Invalidate existing sessions/tokens dependent on the secret.\n' +
      '4. Add secret scanning to CI and pre-commit hooks.'

    try {
      const completion = await this.anthropic.messages.create({
        model: SECURITY_MODEL,
        max_tokens: 600,
        messages: [{ role: 'user', content: remediationPrompt }],
      })

      const textBlocks = completion.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text.trim())
        .filter((block) => block.length > 0)

      if (textBlocks.length > 0) {
        remediationNotes = textBlocks.join('\n\n')
      }
    } catch (err) {
      exposureLog.warn({ err }, 'Failed to generate remediation notes with Claude Haiku')
    }

    await prisma.incident.update({
      where: { id: incident.id },
      data: {
        remediationNotes,
      },
    })
  }

  private async runNpmAudit(repoPath: string): Promise<NpmAuditExecutionResult> {
    let rawOutput = ''

    try {
      const { stdout } = await this.execCommand('npm', ['audit', '--json'], {
        cwd: repoPath,
        timeout: 120_000,
      })
      rawOutput = stdout
    } catch (err: unknown) {
      if (isRecord(err) && typeof err['stdout'] === 'string') {
        rawOutput = err['stdout']
      } else {
        throw new Error(
          `npm audit execution failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }

    if (!rawOutput.trim()) {
      throw new Error('npm audit returned empty output')
    }

    const report = JSON.parse(rawOutput) as NpmAuditReport
    const vulnerabilities = this.parseNpmAuditVulnerabilities(report)

    const meta = report.metadata?.vulnerabilities
    const counts = meta
      ? {
          critical: meta.critical,
          high: meta.high,
          medium: meta.moderate,
          low: meta.low,
        }
      : countVulnerabilitySeverities(vulnerabilities)

    return {
      rawOutput,
      vulnerabilities,
      counts,
    }
  }

  private parseNpmAuditVulnerabilities(report: NpmAuditReport): Vulnerability[] {
    const vulnerabilities: Vulnerability[] = []

    for (const [packageName, vulnerability] of Object.entries(report.vulnerabilities ?? {})) {
      const fixedVersion =
        vulnerability.fixAvailable && typeof vulnerability.fixAvailable === 'object'
          ? vulnerability.fixAvailable.version
          : undefined

      const viaAdvisories = (vulnerability.via ?? []).filter(
        (entry): entry is NpmAuditAdvisory => isRecord(entry),
      )

      if (viaAdvisories.length === 0) {
        vulnerabilities.push({
          id: `npm-${packageName}-${vulnerability.range}`,
          severity: mapNpmSeverity(vulnerability.severity),
          packageName,
          installedVersion: vulnerability.range,
          fixedVersion,
          description: `Vulnerability in ${packageName}@${vulnerability.range}`,
        })
        continue
      }

      for (let index = 0; index < viaAdvisories.length; index += 1) {
        const advisory = viaAdvisories[index]
        const source = advisory?.source ?? index
        const identifier = extractVulnerabilityIdentifier(advisory?.title, advisory?.url)
        const severity = mapNpmSeverity(advisory?.severity ?? vulnerability.severity)

        vulnerabilities.push({
          id: `npm-${packageName}-${String(source)}`,
          severity,
          packageName,
          installedVersion: vulnerability.range,
          fixedVersion,
          ...(identifier.cveId !== undefined ? { cveId: identifier.cveId } : {}),
          description:
            advisory?.title ??
            `Vulnerability in ${packageName}@${vulnerability.range}`,
          ...(advisory?.url !== undefined ? { advisory: advisory.url } : {}),
        })
      }
    }

    return vulnerabilities
  }

  private async runSnykAudit(
    repoPath: string,
    options: { token: string; orgId?: string },
  ): Promise<Vulnerability[]> {
    const packageJsonPath = path.join(repoPath, 'package.json')
    if (!fsSync.existsSync(packageJsonPath)) {
      return []
    }

    const files: Record<string, string> = {
      'package.json': await fs.readFile(packageJsonPath, 'utf8'),
    }

    const lockfilePath = path.join(repoPath, 'package-lock.json')
    if (fsSync.existsSync(lockfilePath)) {
      files['package-lock.json'] = await fs.readFile(lockfilePath, 'utf8')
    }

    const query = options.orgId ? `?org=${encodeURIComponent(options.orgId)}` : ''
    const url = `https://snyk.io/api/v1/test/npm${query}`
    const body = {
      encoding: 'plain',
      files,
    }

    const response = await this.fetchJsonWithRateLimit<SnykApiResponse>(
      url,
      {
        method: 'POST',
        headers: {
          Authorization: `token ${options.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
      MAX_SNYK_RETRIES,
      'snyk_api',
    )

    const vulnerabilities: Vulnerability[] = (response.vulnerabilities ?? []).map((issue) => {
      const cveId = issue.identifiers?.CVE?.[0]
      const ghsa = issue.identifiers?.GHSA?.[0]
      return {
        id: `snyk-${issue.id}`,
        severity: mapSnykSeverity(issue.severity),
        packageName: issue.packageName,
        installedVersion: issue.version,
        fixedVersion: issue.nearestFixedInVersion,
        ...(cveId !== undefined ? { cveId } : {}),
        description: issue.title ?? `Snyk vulnerability in ${issue.packageName}`,
        ...((issue.url ?? ghsa) !== undefined ? { advisory: issue.url ?? ghsa } : {}),
      }
    })

    return vulnerabilities
  }

  private async scanGitHubDependabotAlerts(owner: string, repo: string): Promise<Vulnerability[]> {
    const response = (await this.withGitHubRateLimit(
      () =>
        this.octokit.request('GET /repos/{owner}/{repo}/dependabot/alerts', {
          owner,
          repo,
          state: 'open',
          per_page: 100,
        }),
      'dependabot_alerts',
    )) as { data: unknown }

    const data = Array.isArray(response.data) ? response.data : []
    const vulnerabilities: Vulnerability[] = []

    for (const rawAlert of data) {
      if (!isRecord(rawAlert)) {
        continue
      }

      const dependency = isRecord(rawAlert['dependency']) ? rawAlert['dependency'] : undefined
      const dependencyPackage = isRecord(dependency?.['package']) ? dependency?.['package'] : undefined
      const packageName =
        typeof dependencyPackage?.['name'] === 'string'
          ? dependencyPackage['name']
          : undefined
      if (!packageName) {
        continue
      }

      const advisory = isRecord(rawAlert['security_advisory'])
        ? rawAlert['security_advisory']
        : undefined
      const vulnerability = isRecord(rawAlert['security_vulnerability'])
        ? rawAlert['security_vulnerability']
        : undefined

      const cveId =
        typeof advisory?.['cve_id'] === 'string' ? advisory['cve_id'] : undefined
      const ghsaId =
        typeof advisory?.['ghsa_id'] === 'string' ? advisory['ghsa_id'] : undefined
      const severityText =
        typeof advisory?.['severity'] === 'string'
          ? advisory['severity']
          : typeof vulnerability?.['severity'] === 'string'
            ? vulnerability['severity']
            : 'low'

      const firstPatchedVersion = isRecord(vulnerability?.['first_patched_version'])
        ? vulnerability?.['first_patched_version']
        : undefined
      const fixedVersion =
        typeof firstPatchedVersion?.['identifier'] === 'string'
          ? firstPatchedVersion['identifier']
          : undefined

      vulnerabilities.push({
        id:
          typeof rawAlert['number'] === 'number'
            ? `gh-${owner}-${repo}-${rawAlert['number']}`
            : `gh-${owner}-${repo}-${packageName}`,
        severity: mapNpmSeverity(severityText),
        packageName,
        installedVersion:
          typeof vulnerability?.['vulnerable_version_range'] === 'string'
            ? vulnerability['vulnerable_version_range']
            : 'unknown',
        fixedVersion,
        ...(cveId !== undefined ? { cveId } : {}),
        description:
          typeof advisory?.['summary'] === 'string'
            ? advisory['summary']
            : `Dependabot alert for ${packageName}`,
        ...((typeof advisory?.['references'] === 'string'
          ? advisory['references']
          : ghsaId) !== undefined
          ? {
              advisory:
                typeof advisory?.['references'] === 'string'
                  ? advisory['references']
                  : ghsaId,
            }
          : {}),
      })
    }

    return vulnerabilities
  }

  private async createFixerTasksForVulnerabilities(
    projectId: string,
    vulnerabilities: Vulnerability[],
    sourceTask?: AgentTask,
    repoPath?: string,
  ): Promise<string[]> {
    const taskIds: string[] = []

    for (const vulnerability of vulnerabilities) {
      if (!vulnerability.fixedVersion) {
        continue
      }

      const created = await prisma.agentTask.create({
        data: {
          projectId,
          type: 'FIX_BUG',
          priority: mapSeverityToTaskPriority(vulnerability.severity),
          status: 'QUEUED',
          agentType: 'FIXER',
          requestedBy: 'SYSTEM',
          autonomyLevel: 'SEMI',
          payload: {
            source: 'security_agent',
            action: 'upgrade_dependency',
            vulnerability,
            repoPath,
            instruction: `Upgrade ${vulnerability.packageName} to ${vulnerability.fixedVersion}`,
          } as object,
        },
      })

      taskIds.push(created.id)

      if (sourceTask) {
        const fixerTask: AgentTask = {
          id: created.id,
          type: 'fix_bug',
          priority: created.priority.toLowerCase() as AgentTask['priority'],
          projectId,
          organizationId: sourceTask.organizationId,
          payload: {
            source: 'security_agent',
            vulnerability,
            repoPath,
            instruction: `Upgrade ${vulnerability.packageName} to ${vulnerability.fixedVersion}`,
            errorMessage: `Dependency vulnerability: ${vulnerability.description}`,
          },
          requestedBy: 'system',
          autonomyLevel: 'semi',
          createdAt: created.createdAt,
        }

        if (this.eventBus?.dispatch) {
          try {
            await this.eventBus.dispatch(fixerTask, 'fixer')
          } catch (err) {
            log.warn({ err, taskId: created.id }, 'Failed to dispatch fixer task via EventBus')
          }
        }
      }
    }

    return taskIds
  }

  private async openSecurityFixPr(options: {
    owner: string
    repo: string
    baseBranch: string
    repoPath: string
    filesChanged: string[]
    vulnerabilities: Vulnerability[]
    patches: DependencyPatch[]
    taskId?: string
  }): Promise<string> {
    const branchName =
      options.taskId !== undefined
        ? `forge/security/${options.taskId.slice(0, 8)}`
        : `forge/security/${Date.now()}`

    const baseRef = (await this.withGitHubRateLimit(
      () =>
        this.octokit.rest.git.getRef({
          owner: options.owner,
          repo: options.repo,
          ref: `heads/${options.baseBranch}`,
        }),
      'get_base_ref',
    )) as { data: { object: { sha: string } } }

    const baseSha = baseRef.data.object.sha

    try {
      await this.withGitHubRateLimit(
        () =>
          this.octokit.rest.git.createRef({
            owner: options.owner,
            repo: options.repo,
            ref: `refs/heads/${branchName}`,
            sha: baseSha,
          }),
        'create_security_branch',
      )
    } catch (err) {
      if (!isRateLimitError(err) && !isAlreadyExistsError(err)) {
        throw err
      }
      if (isRateLimitError(err)) {
        throw err
      }
    }

    for (const relativePath of options.filesChanged) {
      const absolutePath = path.join(options.repoPath, relativePath)
      const fileContent = await fs.readFile(absolutePath, 'utf8')

      let sha: string | undefined
      try {
        const existing = (await this.withGitHubRateLimit(
          () =>
            this.octokit.rest.repos.getContent({
              owner: options.owner,
              repo: options.repo,
              path: relativePath,
              ref: branchName,
            }),
          `read_file_${relativePath}`,
        )) as { data: { sha?: string } | unknown[] }

        const data = existing.data
        if (!Array.isArray(data) && typeof data.sha === 'string') {
          sha = data.sha
        }
      } catch (err) {
        if (!isNotFoundError(err)) {
          throw err
        }
      }

      await this.withGitHubRateLimit(
        () =>
          this.octokit.rest.repos.createOrUpdateFileContents({
            owner: options.owner,
            repo: options.repo,
            path: relativePath,
            branch: branchName,
            message: `chore(security): patch ${relativePath}`,
            content: Buffer.from(fileContent, 'utf8').toString('base64'),
            ...(sha !== undefined ? { sha } : {}),
          }),
        `commit_file_${relativePath}`,
      )
    }

    const prBody = await this.buildSecurityPrBody(options.vulnerabilities, options.patches)

    const pr = (await this.withGitHubRateLimit(
      () =>
        this.octokit.rest.pulls.create({
          owner: options.owner,
          repo: options.repo,
          head: branchName,
          base: options.baseBranch,
          title: 'chore(security): patch vulnerable dependencies',
          body: prBody,
          draft: true,
        }),
      'create_security_pr',
    )) as { data: { html_url: string } }

    return pr.data.html_url
  }

  private async buildSecurityPrBody(
    vulnerabilities: Vulnerability[],
    patches: DependencyPatch[],
  ): Promise<string> {
    const severityCounts = countVulnerabilitySeverities(vulnerabilities)

    let executiveSummary =
      'This PR updates vulnerable dependencies identified by the Forge Security Agent.'

    try {
      const summaryPrompt = [
        'Summarize this dependency security patch in 2 concise sentences.',
        `Critical: ${severityCounts.critical}`,
        `High: ${severityCounts.high}`,
        `Medium: ${severityCounts.medium}`,
        `Low: ${severityCounts.low}`,
        `Patched packages: ${patches.map((patch) => patch.packageName).join(', ')}`,
      ].join('\n')

      const completion = await this.anthropic.messages.create({
        model: SECURITY_MODEL,
        max_tokens: 240,
        messages: [{ role: 'user', content: summaryPrompt }],
      })

      const text = completion.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text.trim())
        .join('\n')
        .trim()

      if (text.length > 0) {
        executiveSummary = text
      }
    } catch (err) {
      log.warn({ err }, 'Failed to generate AI PR summary; using fallback summary')
    }

    const vulnerabilityLines = vulnerabilities
      .slice(0, 30)
      .map((vuln) => {
        const fixed = vuln.fixedVersion ? ` -> ${vuln.fixedVersion}` : ''
        const cve = vuln.cveId ? ` (${vuln.cveId})` : ''
        return `- ${vuln.packageName}@${vuln.installedVersion}${fixed} [${vuln.severity}]${cve}`
      })
      .join('\n')

    const patchLines = patches
      .map(
        (patch) =>
          `- ${patch.packageName}: ${patch.fromVersion} -> ${patch.toVersion} (${patch.dependencySection})`,
      )
      .join('\n')

    return [
      '## Summary',
      executiveSummary,
      '',
      '## Vulnerability counts',
      `- Critical: ${severityCounts.critical}`,
      `- High: ${severityCounts.high}`,
      `- Medium: ${severityCounts.medium}`,
      `- Low: ${severityCounts.low}`,
      '',
      '## Patched dependencies',
      patchLines || '- None',
      '',
      '## Findings (top 30)',
      vulnerabilityLines || '- None',
      '',
      '## Notes',
      '- Secret rotation is not automated by Forge Security Agent.',
      '- Review and merge this PR after CI validation.',
    ].join('\n')
  }

  private async scanLocalRepositoryForSecrets(repoPath: string): Promise<SecretInfo[]> {
    const files = await this.collectScannableFiles(repoPath)
    const findings: SecretInfo[] = []

    for (const absoluteFilePath of files) {
      const relativePath = normalizeToPosix(path.relative(repoPath, absoluteFilePath))
      let content = ''
      try {
        content = await fs.readFile(absoluteFilePath, 'utf8')
      } catch {
        continue
      }

      if (content.includes('\u0000')) {
        continue
      }

      findings.push(
        ...this.detectSecretsInContent(content, relativePath, {
          detector: 'local_file',
        }),
      )
    }

    return findings
  }

  private async collectScannableFiles(repoPath: string): Promise<string[]> {
    const queue = [repoPath]
    const files: string[] = []

    while (queue.length > 0) {
      const current = queue.pop()
      if (!current) {
        continue
      }

      let entries: fsSync.Dirent[] = []
      try {
        entries = await fs.readdir(current, { withFileTypes: true })
      } catch {
        continue
      }

      for (const entry of entries) {
        const absolute = path.join(current, entry.name)
        if (entry.isDirectory()) {
          if (IGNORED_DIRECTORIES.has(entry.name)) {
            continue
          }
          queue.push(absolute)
          continue
        }

        if (!entry.isFile()) {
          continue
        }

        if (IGNORED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
          continue
        }

        try {
          const stat = await fs.stat(absolute)
          if (stat.size > MAX_FILE_SIZE_BYTES) {
            continue
          }
        } catch {
          continue
        }

        files.push(absolute)
      }
    }

    return files
  }

  private detectSecretsInContent(
    content: string,
    filePath: string,
    context: {
      detector: SecretInfo['detector']
      commitSha?: string
      exposureStartedAt?: string
    },
  ): SecretInfo[] {
    const matches: SecretInfo[] = []

    for (const pattern of SECRET_PATTERNS) {
      pattern.regex.lastIndex = 0
      let match: RegExpExecArray | null

      while ((match = pattern.regex.exec(content)) !== null) {
        const matchedValue = match[pattern.valueGroup ?? 0] ?? match[0]
        if (isFalsePositiveSecret(pattern.type, matchedValue)) {
          continue
        }

        const lineNumber = lineNumberFromIndex(content, match.index)
        matches.push({
          name: pattern.name,
          type: pattern.type,
          filePath,
          lineNumber,
          ...(context.commitSha !== undefined ? { commitSha: context.commitSha } : {}),
          ...(context.exposureStartedAt !== undefined
            ? { exposureStartedAt: context.exposureStartedAt }
            : {}),
          partialValue: maskSecretValue(matchedValue),
          detector: context.detector,
        })

        if (match.index === pattern.regex.lastIndex) {
          pattern.regex.lastIndex += 1
        }
      }
    }

    return matches
  }

  private async scanGitHubCommitsForSecrets(
    owner: string,
    repo: string,
    baseBranch: string,
    maxCommits: number,
  ): Promise<SecretInfo[]> {
    const findings: SecretInfo[] = []

    const commitsResponse = (await this.withGitHubRateLimit(
      () =>
        this.octokit.rest.repos.listCommits({
          owner,
          repo,
          sha: baseBranch,
          per_page: Math.min(100, Math.max(1, maxCommits)),
        }),
      'list_commits_for_secret_scan',
    )) as { data: Array<{ sha: string }> }

    const commits = commitsResponse.data.slice(0, maxCommits)

    for (const commit of commits) {
      const sha = commit.sha
      const detailed = (await this.withGitHubRateLimit(
        () =>
          this.octokit.rest.repos.getCommit({
            owner,
            repo,
            ref: sha,
          }),
        `get_commit_${sha}`,
      )) as {
        data: {
          commit: { committer?: { date?: string } }
          files?: Array<{ filename: string; patch?: string }>
        }
      }

      const commitDate = detailed.data.commit.committer?.date
      for (const file of detailed.data.files ?? []) {
        if (!file.patch) {
          continue
        }

        const addedLines = file.patch
          .split('\n')
          .filter((line: string) => line.startsWith('+') && !line.startsWith('+++'))
          .map((line: string) => line.slice(1))
          .join('\n')

        findings.push(
          ...this.detectSecretsInContent(addedLines, file.filename, {
            detector: 'github_commit',
            commitSha: sha,
            exposureStartedAt: commitDate,
          }),
        )
      }
    }

    return findings
  }

  private async resolveRepositoryContext(
    projectId: string,
    payload: SecurityTaskPayload,
  ): Promise<ProjectRepositoryContext> {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: {
        githubRepoOwner: true,
        githubRepoName: true,
        defaultBranch: true,
      },
    })

    return {
      owner: payload.githubOwner ?? project?.githubRepoOwner ?? undefined,
      repo: payload.githubRepo ?? project?.githubRepoName ?? undefined,
      baseBranch: payload.githubBaseBranch ?? project?.defaultBranch ?? 'main',
    }
  }

  private resolveScanType(task: AgentTask, payload: SecurityTaskPayload): ScanType {
    if (payload.scanType) {
      return payload.scanType
    }

    if (task.type === 'security_patch' || task.type === 'dependency_update') {
      return 'DEPENDENCY_AUDIT'
    }

    return 'DEPENDENCY_AUDIT'
  }

  private async refreshPackageLock(repoPath: string): Promise<boolean> {
    const lockfilePath = path.join(repoPath, 'package-lock.json')
    if (!fsSync.existsSync(lockfilePath)) {
      return false
    }

    try {
      await this.execCommand(
        'npm',
        ['install', '--package-lock-only', '--ignore-scripts'],
        {
          cwd: repoPath,
          timeout: 180_000,
        },
      )
      return true
    } catch (err) {
      log.warn({ err, repoPath }, 'Failed to refresh package-lock.json after dependency patching')
      return false
    }
  }

  private async execCommand(
    command: string,
    args: string[],
    options: ExecFileOptions,
  ): Promise<{ stdout: string; stderr: string }> {
    const result = (await execFileAsync(command, args, {
      ...options,
      encoding: 'utf8',
      maxBuffer: 5 * 1024 * 1024,
    })) as { stdout: string; stderr: string }

    return {
      stdout: result.stdout,
      stderr: result.stderr,
    }
  }

  private async fetchJsonWithRateLimit<T>(
    url: string,
    init: RequestInit,
    maxRetries: number,
    context: string,
  ): Promise<T> {
    let attempt = 0

    while (true) {
      const response = await fetch(url, init)
      if (response.ok) {
        return (await response.json()) as T
      }

      if (response.status === 429 || response.status === 403) {
        if (attempt >= maxRetries) {
          throw new Error(`Rate limit exceeded for ${context} after ${attempt + 1} attempts`)
        }

        const delayMs = computeRateLimitDelayFromHeaders(
          response.headers.get('retry-after'),
          response.headers.get('x-ratelimit-reset'),
          attempt,
        )

        await sleep(delayMs)
        attempt += 1
        continue
      }

      const errorBody = await response.text()
      throw new Error(`HTTP ${response.status} during ${context}: ${errorBody.slice(0, 400)}`)
    }
  }

  private async withGitHubRateLimit<T>(
    operation: () => Promise<T>,
    context: string,
  ): Promise<T> {
    let attempt = 0

    while (true) {
      try {
        return await operation()
      } catch (err) {
        if (!isRateLimitError(err)) {
          throw err
        }

        if (attempt >= MAX_GITHUB_RETRIES) {
          throw err
        }

        const headers = extractErrorHeaders(err)
        const delayMs = computeRateLimitDelayFromHeaders(
          headers['retry-after'],
          headers['x-ratelimit-reset'],
          attempt,
        )

        log.warn(
          { context, delayMs, attempt, err },
          'GitHub API rate limited, retrying request',
        )

        await sleep(delayMs)
        attempt += 1
      }
    }
  }

  private async persistSecurityScan(
    projectId: string,
    scanType: ScanType,
    data: {
      status: 'COMPLETED' | 'FAILED'
      score?: number
      findingsCount: { critical: number; high: number; medium: number; low: number }
      data: Record<string, unknown>
      findings: unknown[]
      errorMessage?: string
    },
  ): Promise<void> {
    await prisma.securityScan.create({
      data: {
        projectId,
        scanType,
        status: data.status,
        ...(data.score !== undefined ? { score: data.score } : {}),
        findingsCount: data.findingsCount,
        data: data.data as object,
        findings: data.findings as object,
        startedAt: this.now(),
        completedAt: this.now(),
        ...(data.errorMessage !== undefined ? { errorMessage: data.errorMessage } : {}),
      },
    })
  }

  private async publishTaskLifecycleEvent<T>(
    task: AgentTask,
    eventType: Extract<ForgeEventType, 'task.started' | 'task.completed' | 'task.failed'>,
    payload: T,
  ): Promise<void> {
    await this.publishForgeEvent(task, eventType, payload)
  }

  private async publishForgeEvent<T>(
    task: AgentTask,
    eventType: ForgeEventType,
    payload: T,
  ): Promise<void> {
    if (!this.eventBus) {
      return
    }

    const event: ForgeEvent<T> = {
      id: randomUUID(),
      type: eventType,
      projectId: task.projectId,
      organizationId: task.organizationId,
      payload,
      timestamp: this.now(),
      sourceAgent: 'security',
    }

    try {
      await this.eventBus.publishEvent(event)
    } catch (err) {
      log.warn({ err, eventType, taskId: task.id }, 'Failed to publish security event')
    }
  }
}

function dedupeVulnerabilities(vulnerabilities: Vulnerability[]): Vulnerability[] {
  const seen = new Map<string, Vulnerability>()

  for (const vulnerability of vulnerabilities) {
    const key = [
      vulnerability.packageName,
      vulnerability.installedVersion,
      vulnerability.fixedVersion ?? '',
      vulnerability.cveId ?? '',
      vulnerability.id,
    ].join('|')

    if (!seen.has(key)) {
      seen.set(key, vulnerability)
    }
  }

  return Array.from(seen.values())
}

function countVulnerabilitySeverities(vulnerabilities: Vulnerability[]): {
  critical: number
  high: number
  medium: number
  low: number
} {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 }

  for (const vulnerability of vulnerabilities) {
    if (vulnerability.severity === 'critical') counts.critical += 1
    else if (vulnerability.severity === 'high') counts.high += 1
    else if (vulnerability.severity === 'medium') counts.medium += 1
    else if (vulnerability.severity === 'low') counts.low += 1
  }

  return counts
}

function parseCountRecord(value: unknown): {
  critical: number
  high: number
  medium: number
  low: number
} {
  if (!isRecord(value)) {
    return { critical: 0, high: 0, medium: 0, low: 0 }
  }

  return {
    critical: toInteger(value['critical']),
    high: toInteger(value['high']),
    medium: toInteger(value['medium']),
    low: toInteger(value['low']),
  }
}

function parseDataRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    return {}
  }
  return value
}

function inferAuditSource(labels: Array<'npm' | 'snyk' | 'github'>):
  | 'npm'
  | 'snyk'
  | 'combined'
  | 'github' {
  const unique = [...new Set(labels)]
  if (unique.length === 0) return 'npm'
  if (unique.length > 1) return 'combined'
  return unique[0] ?? 'npm'
}

function mapNpmSeverity(severity: string): Vulnerability['severity'] {
  const normalized = severity.toLowerCase()
  if (normalized === 'critical') return 'critical'
  if (normalized === 'high') return 'high'
  if (normalized === 'moderate' || normalized === 'medium') return 'medium'
  if (normalized === 'low') return 'low'
  return 'low'
}

function mapSnykSeverity(severity: string): Vulnerability['severity'] {
  const normalized = severity.toLowerCase()
  if (normalized === 'critical') return 'critical'
  if (normalized === 'high') return 'high'
  if (normalized === 'medium' || normalized === 'moderate') return 'medium'
  if (normalized === 'low') return 'low'
  return 'low'
}

function mapSemgrepSeverity(severity: string): FindingSeverity {
  const normalized = severity.toUpperCase()
  if (normalized === 'ERROR') return 'high'
  if (normalized === 'WARNING') return 'medium'
  if (normalized === 'INFO') return 'low'
  return 'info'
}

function mapSeverityToTaskPriority(
  severity: Vulnerability['severity'],
): 'CRITICAL' | 'HIGH' | 'NORMAL' | 'LOW' {
  if (severity === 'critical') return 'CRITICAL'
  if (severity === 'high') return 'HIGH'
  if (severity === 'medium') return 'NORMAL'
  return 'LOW'
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, score))
}

function extractVulnerabilityIdentifier(
  title?: string,
  advisoryUrl?: string,
): { cveId?: string; ghsaId?: string } {
  const source = `${title ?? ''} ${advisoryUrl ?? ''}`
  const cveMatch = /\bCVE-\d{4}-\d{4,}\b/i.exec(source)
  const ghsaMatch = /\bGHSA-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}\b/i.exec(source)

  return {
    ...(cveMatch?.[0] !== undefined ? { cveId: cveMatch[0].toUpperCase() } : {}),
    ...(ghsaMatch?.[0] !== undefined ? { ghsaId: ghsaMatch[0].toUpperCase() } : {}),
  }
}

function applyPreferredRange(currentRange: string, fixedVersion: string): string {
  const trimmed = currentRange.trim()

  if (trimmed.startsWith('^')) {
    return `^${fixedVersion}`
  }
  if (trimmed.startsWith('~')) {
    return `~${fixedVersion}`
  }
  if (trimmed.startsWith('>=')) {
    return `>=${fixedVersion}`
  }
  if (/^\d+\.\d+\.\d+/.test(trimmed)) {
    return fixedVersion
  }

  return `^${fixedVersion}`
}

function isSupportedDependencyRange(value: string): boolean {
  const normalized = value.trim().toLowerCase()
  if (normalized.startsWith('workspace:')) return false
  if (normalized.startsWith('file:')) return false
  if (normalized.startsWith('link:')) return false
  if (normalized.startsWith('git+')) return false
  return true
}

function normalizeToPosix(filePath: string): string {
  return filePath.split(path.sep).join('/')
}

function lineNumberFromIndex(content: string, index: number): number {
  if (index <= 0) {
    return 1
  }
  let line = 1
  for (let i = 0; i < index; i += 1) {
    if (content.charCodeAt(i) === 10) {
      line += 1
    }
  }
  return line
}

function maskSecretValue(value: string): string {
  if (value.length <= 8) {
    return `${value.slice(0, 2)}...`
  }
  return `${value.slice(0, 4)}...${value.slice(-2)}`
}

function isFalsePositiveSecret(type: SecretType, value: string): boolean {
  if (type === 'private_key' || type === 'certificate') {
    return false
  }

  const lower = value.toLowerCase()
  if (FALSE_POSITIVE_TOKENS.some((token) => lower.includes(token))) {
    return true
  }

  if (/^[x*.-]+$/.test(value)) {
    return true
  }

  return value.trim().length < 8
}

function dedupeSecrets(secrets: SecretInfo[]): SecretInfo[] {
  const seen = new Set<string>()
  const unique: SecretInfo[] = []

  for (const secret of secrets) {
    const key = [
      secret.type,
      secret.filePath,
      secret.lineNumber ?? '',
      secret.commitSha ?? '',
      secret.partialValue ?? '',
      secret.detector,
    ].join('|')

    if (seen.has(key)) {
      continue
    }

    seen.add(key)
    unique.push(secret)
  }

  return unique
}

function computeRateLimitDelayFromHeaders(
  retryAfterHeader: string | null | undefined,
  rateLimitResetHeader: string | null | undefined,
  attempt: number,
): number {
  const retryAfterSeconds = retryAfterHeader ? parseInt(retryAfterHeader, 10) : NaN
  if (!Number.isNaN(retryAfterSeconds) && retryAfterSeconds > 0) {
    return retryAfterSeconds * 1000
  }

  const resetEpochSeconds = rateLimitResetHeader ? parseInt(rateLimitResetHeader, 10) : NaN
  if (!Number.isNaN(resetEpochSeconds) && resetEpochSeconds > 0) {
    const resetMs = resetEpochSeconds * 1000 - Date.now() + 500
    if (resetMs > 0) {
      return resetMs
    }
  }

  return Math.min(60_000, 1_000 * 2 ** attempt)
}

function extractErrorHeaders(error: unknown): Record<string, string | undefined> {
  if (!isRecord(error)) {
    return {}
  }

  const response = isRecord(error['response']) ? error['response'] : undefined
  const headers = isRecord(response?.['headers']) ? response?.['headers'] : undefined
  if (!headers) {
    return {}
  }

  const normalized: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(headers)) {
    normalized[key.toLowerCase()] =
      typeof value === 'string' ? value : Array.isArray(value) ? value[0] : value !== undefined ? String(value) : undefined
  }

  return normalized
}

function isRateLimitError(error: unknown): boolean {
  if (!isRecord(error)) {
    return false
  }

  const status = typeof error['status'] === 'number' ? error['status'] : undefined
  return status === 403 || status === 429
}

function isNotFoundError(error: unknown): boolean {
  if (!isRecord(error)) {
    return false
  }
  return error['status'] === 404
}

function isAlreadyExistsError(error: unknown): boolean {
  if (!isRecord(error)) {
    return false
  }
  return error['status'] === 422
}

function toInteger(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value))
  }
  if (typeof value === 'string') {
    const parsed = parseInt(value, 10)
    if (!Number.isNaN(parsed)) {
      return Math.max(0, parsed)
    }
  }
  return 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

export const securityAgent = new SecurityAgent()
