/**
 * @forge/github — GitHub App Integration
 *
 * Handles:
 * - GitHub App installation (per-project repo access)
 * - Incoming webhook processing (push, PR, workflow runs)
 * - PR creation with dual-register descriptions
 * - Repository file read/write via GitHub API
 * - CI status checks
 *
 * Uses GitHub Apps (not personal tokens) for secure, scoped access.
 * Each organization gets its own GitHub App installation.
 */

import { App as GitHubApp } from '@octokit/app'
import { Octokit } from '@octokit/rest'
import { Webhooks, type EmitterWebhookEvent } from '@octokit/webhooks'
import { createLogger } from '@forge/shared'
import { prisma } from '@forge/database'
import { z } from 'zod'

const log = createLogger('github')

// ---------------------------------------------------------------------------
// Forge GitHub App
// ---------------------------------------------------------------------------

export class ForgeGitHub {
  private app: GitHubApp
  private webhooks: Webhooks

  constructor() {
    const privateKey = (process.env['GITHUB_APP_PRIVATE_KEY'] ?? '')
      .replace(/\\n/g, '\n')

    this.app = new GitHubApp({
      appId: process.env['GITHUB_APP_ID'] ?? '',
      privateKey,
      webhooks: {
        secret: process.env['GITHUB_WEBHOOK_SECRET'] ?? '',
      },
    })

    this.webhooks = new Webhooks({
      secret: process.env['GITHUB_WEBHOOK_SECRET'] ?? '',
    })

    this.registerWebhookHandlers()
    log.info('GitHub App initialized')
  }

  // ---------------------------------------------------------------------------
  // Installation management
  // ---------------------------------------------------------------------------

  /**
   * Get an Octokit instance authenticated for a specific installation.
   * Each project stores its GitHub App installation ID.
   */
  async getInstallationClient(installationId: number): Promise<Octokit> {
    const octokit = await this.app.getInstallationOctokit(installationId)
    return octokit as unknown as Octokit
  }

  /**
   * Get the Octokit client for a project by its project ID.
   */
  async getClientForProject(projectId: string): Promise<Octokit> {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { githubInstallationId: true },
    })

    if (!project?.githubInstallationId) {
      throw new Error(`Project ${projectId} has no GitHub App installation`)
    }

    return this.getInstallationClient(parseInt(project.githubInstallationId, 10))
  }

  // ---------------------------------------------------------------------------
  // PR management
  // ---------------------------------------------------------------------------

  /**
   * Create a pull request with a dual-register description.
   * The description is formatted for both technical and non-technical readers.
   *
   * @returns The created PR URL and number
   */
  async createPullRequest(options: CreatePrOptions): Promise<PrResult> {
    const {
      projectId, owner, repo, title, head, base,
      businessImpact, technicalRationale, filesSummary,
      testCoverage, newTestCount, ciPassing, confidenceScore,
      riskFactors, rollbackInstructions, agentType,
    } = options

    const client = await this.getClientForProject(projectId)

    const body = buildPrBody({
      businessImpact,
      technicalRationale,
      filesSummary,
      testCoverage: testCoverage ?? 0,
      newTestCount: newTestCount ?? 0,
      ciPassing: ciPassing ?? false,
      confidenceScore,
      riskFactors: riskFactors ?? [],
      rollbackInstructions: rollbackInstructions ?? 'Revert this PR via GitHub UI or `git revert`',
      agentType,
    })

    try {
      const pr = await client.pulls.create({
        owner,
        repo,
        title,
        body,
        head,
        base: base ?? 'main',
        draft: confidenceScore ? confidenceScore.total < 65 : false,
      })

      log.info({ projectId, prNumber: pr.data.number, prUrl: pr.data.html_url }, 'PR created')

      return {
        prUrl: pr.data.html_url,
        prNumber: pr.data.number,
        state: pr.data.state as 'open' | 'closed',
      }
    } catch (err) {
      log.error({ error: (err as Error).message, projectId }, 'Failed to create PR')
      throw err
    }
  }

  /**
   * Post a review comment on a PR.
   */
  async postPrReview(
    projectId: string,
    owner: string,
    repo: string,
    prNumber: number,
    body: string,
    event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT' = 'COMMENT',
  ): Promise<void> {
    const client = await this.getClientForProject(projectId)
    await client.pulls.createReview({
      owner,
      repo,
      pull_number: prNumber,
      body,
      event,
    })
  }

  /**
   * Get the files changed in a PR.
   */
  async getPrFiles(
    projectId: string,
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<PrFile[]> {
    const client = await this.getClientForProject(projectId)
    const { data } = await client.pulls.listFiles({
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    })

    return data.map((f) => ({
      path: f.filename,
      status: f.status as PrFile['status'],
      additions: f.additions,
      deletions: f.deletions,
    }))
  }

  // ---------------------------------------------------------------------------
  // File access
  // ---------------------------------------------------------------------------

  /**
   * Read a file from a repository.
   */
  async getFileContent(
    projectId: string,
    owner: string,
    repo: string,
    path: string,
    ref?: string,
  ): Promise<string> {
    const client = await this.getClientForProject(projectId)

    try {
      const { data } = await client.repos.getContent({
        owner,
        repo,
        path,
        ref,
      })

      if (!('content' in data) || typeof data.content !== 'string') {
        throw new Error(`${path} is not a file`)
      }

      return Buffer.from(data.content, 'base64').toString('utf8')
    } catch (err) {
      if ((err as { status?: number }).status === 404) {
        throw new Error(`File not found: ${path}`)
      }
      throw err
    }
  }

  /**
   * Create or update a file in a repository.
   */
  async putFileContent(
    projectId: string,
    owner: string,
    repo: string,
    path: string,
    content: string,
    message: string,
    branch: string,
  ): Promise<void> {
    const client = await this.getClientForProject(projectId)

    // Get existing SHA if the file exists (required for updates)
    let sha: string | undefined
    try {
      const { data } = await client.repos.getContent({ owner, repo, path, ref: branch })
      if ('sha' in data) sha = data.sha
    } catch {
      // File doesn't exist yet — that's fine
    }

    await client.repos.createOrUpdateFileContents({
      owner,
      repo,
      path,
      message,
      content: Buffer.from(content).toString('base64'),
      branch,
      sha,
    })
  }

  /**
   * Create a new branch from the default branch.
   */
  async createBranch(
    projectId: string,
    owner: string,
    repo: string,
    branchName: string,
    fromBranch = 'main',
  ): Promise<void> {
    const client = await this.getClientForProject(projectId)

    const { data: ref } = await client.git.getRef({
      owner,
      repo,
      ref: `heads/${fromBranch}`,
    })

    await client.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${branchName}`,
      sha: ref.object.sha,
    })

    log.debug({ projectId, branchName, fromBranch }, 'Branch created')
  }

  /**
   * Get CI check status for a commit.
   */
  async getCiStatus(
    projectId: string,
    owner: string,
    repo: string,
    ref: string,
  ): Promise<CiStatus> {
    const client = await this.getClientForProject(projectId)

    const { data } = await client.repos.getCombinedStatusForRef({ owner, repo, ref })

    return {
      state: data.state as CiStatus['state'],
      statuses: data.statuses.map((s) => ({
        context: s.context,
        state: s.state as 'success' | 'failure' | 'pending' | 'error',
        description: s.description ?? '',
      })),
    }
  }

  // ---------------------------------------------------------------------------
  // Webhook handling
  // ---------------------------------------------------------------------------

  /**
   * Process an incoming GitHub webhook payload.
   * Called from the Fastify route handler.
   */
  async handleWebhook(
    eventName: string,
    payload: unknown,
    signature: string,
  ): Promise<void> {
    await this.webhooks.verifyAndReceive({
      id: crypto.randomUUID(),
      name: eventName as EmitterWebhookEvent['name'],
      payload: JSON.stringify(payload),
      signature,
    })
  }

  /**
   * Register handlers for GitHub webhook events.
   * These events trigger Orchestrator tasks.
   */
  private registerWebhookHandlers(): void {
    // Push to default branch → update codebase context
    this.webhooks.on('push', async ({ payload }) => {
      if (!payload.ref.endsWith(payload.repository.default_branch ?? 'main')) return

      log.info({
        repo: payload.repository.full_name,
        commits: payload.commits.length,
      }, 'Push to default branch')

      // The orchestrator will handle context updates via a task
      // This is fired here and consumed by the orchestrator's webhook API
    })

    // PR opened/synchronize → run security scan + CI status check
    this.webhooks.on('pull_request', async ({ payload }) => {
      if (!['opened', 'synchronize'].includes(payload.action)) return

      log.info({
        repo: payload.repository.full_name,
        prNumber: payload.number,
        action: payload.action,
      }, 'PR event received')
    })

    // Workflow run completed → update CI status in Confidence Engine
    this.webhooks.on('workflow_run', async ({ payload }) => {
      log.debug({
        workflow: payload.workflow_run.name,
        status: payload.workflow_run.status,
        conclusion: payload.workflow_run.conclusion,
      }, 'Workflow run event')
    })

    this.webhooks.onError((error) => {
      log.error({ error: error.message }, 'GitHub webhook error')
    })
  }

  /**
   * Verify a webhook signature.
   * Returns true if valid, false if not.
   */
  async verifyWebhookSignature(
    payload: string,
    signature: string,
  ): Promise<boolean> {
    try {
      await this.webhooks.verify(payload, signature)
      return true
    } catch {
      return false
    }
  }
}

// ---------------------------------------------------------------------------
// PR body builder
// ---------------------------------------------------------------------------

interface PrBodyOptions {
  businessImpact: string
  technicalRationale: string
  filesSummary: string
  testCoverage: number
  newTestCount: number
  ciPassing: boolean
  confidenceScore?: { total: number; riskFactors?: string[] }
  riskFactors: string[]
  rollbackInstructions: string
  agentType: string
}

function buildPrBody(opts: PrBodyOptions): string {
  const {
    businessImpact, technicalRationale, filesSummary,
    testCoverage, newTestCount, ciPassing, confidenceScore,
    riskFactors, rollbackInstructions, agentType,
  } = opts

  const scoreSection = confidenceScore
    ? `## Confidence score: ${confidenceScore.total}/100\n${buildScoreBar(confidenceScore.total)}`
    : ''

  const riskSection = riskFactors.length > 0
    ? `## Risk factors\n${riskFactors.map((r) => `- ${r}`).join('\n')}`
    : ''

  return `## What changed
${businessImpact}

## Why
${technicalRationale}

## Files changed
${filesSummary}

## Tests
- Coverage: ${testCoverage}%
- New tests: ${newTestCount}
- All passing: ${ciPassing ? '✅' : '❌'}

${scoreSection}

${riskSection}

## Rollback
${rollbackInstructions}

---
*Generated by Forge ${agentType} Agent · ${new Date().toISOString()}*`
}

function buildScoreBar(score: number): string {
  const filled = Math.round(score / 10)
  const empty = 10 - filled
  const bar = '█'.repeat(filled) + '░'.repeat(empty)
  const label = score >= 85 ? '🟢 Auto-deploy' : score >= 65 ? '🟡 Recommend' : score >= 40 ? '🟠 Hold' : '🔴 Block'
  return `\`${bar}\` ${score}/100 — ${label}`
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreatePrOptions {
  projectId: string
  owner: string
  repo: string
  title: string
  head: string
  base?: string
  businessImpact: string
  technicalRationale: string
  filesSummary: string
  testCoverage?: number
  newTestCount?: number
  ciPassing?: boolean
  confidenceScore?: { total: number; riskFactors?: string[] }
  riskFactors?: string[]
  rollbackInstructions?: string
  agentType: string
}

export interface PrResult {
  prUrl: string
  prNumber: number
  state: 'open' | 'closed'
}

export interface PrFile {
  path: string
  status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied'
  additions: number
  deletions: number
}

export interface CiStatus {
  state: 'success' | 'failure' | 'pending' | 'error'
  statuses: Array<{
    context: string
    state: 'success' | 'failure' | 'pending' | 'error'
    description: string
  }>
}

// Validate incoming GitHub App installation webhook payloads
export const InstallationPayloadSchema = z.object({
  action: z.enum(['created', 'deleted', 'suspend', 'unsuspend']),
  installation: z.object({
    id: z.number(),
    account: z.object({
      login: z.string(),
      type: z.string(),
    }),
  }),
  repositories: z.array(z.object({
    id: z.number(),
    name: z.string(),
    full_name: z.string(),
    private: z.boolean(),
  })).optional(),
})

export type InstallationPayload = z.infer<typeof InstallationPayloadSchema>

// Singleton
let _forgeGitHub: ForgeGitHub | null = null

export function getForgeGitHub(): ForgeGitHub {
  if (!_forgeGitHub) {
    _forgeGitHub = new ForgeGitHub()
  }
  return _forgeGitHub
}
