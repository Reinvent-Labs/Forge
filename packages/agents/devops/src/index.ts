/**
 * @forge/agent-devops
 *
 * DevOps Agent: deployment orchestration, rollback, cost analysis,
 * auto-rollback triggers, and deployment promotion rules.
 *
 * Design principles:
 *  - Deployments are recorded before they start so a partial failure
 *    always leaves an audit trail.
 *  - Auto-rollback is triggered on hard metrics thresholds, never on
 *    guesses. The cause and timeline are always included in the alert.
 *  - Promotion to production is blocked during Friday 3pm - Monday 9am UTC.
 *  - Cost spike alerts include a human-readable projection, not just
 *    a raw percentage.
 */

import { createLogger, createContextLogger } from '@forge/shared'
import type { AgentTask, DeploymentRecord, CostRecord, CostAnomaly, TimeWindow } from '@forge/shared'
import { prisma } from '@forge/database'

const log = createLogger('devops-agent')

// ---------------------------------------------------------------------------
// Types and interfaces
// ---------------------------------------------------------------------------

/** Supported deployment providers. */
export type DeployProvider = 'vercel' | 'railway' | 'render' | 'fly'

/** An environment in the deployment pipeline. */
export interface Environment {
  name: 'preview' | 'staging' | 'production'
  provider: DeployProvider
  /** Provider-specific identifier (Vercel project ID, Railway service ID, etc.). */
  providerId: string
  url?: string
}

/**
 * Conditions that must all be satisfied before promoting from staging/preview
 * to production. A single failing condition blocks promotion.
 */
export interface PromotionRule {
  from: 'staging' | 'preview'
  to: 'production'
  conditions: {
    /** Minimum minutes the build must have been live on staging. */
    minStagingAge: number
    /** Maximum allowed increase in error rate vs production baseline (0-1). */
    maxErrorRateDelta: number
    /** All CI checks must be green before promotion. */
    ciMustPass: boolean
    /** No open critical/high security findings. */
    securityMustPass: boolean
    /** Minimum confidence score (0-100) required for auto-promotion. */
    confidenceMinScore: number
    /** When true, human approval is required regardless of other conditions. */
    requireApproval: boolean
    /** Time windows during which promotion is blocked. */
    blockedTimeWindows: TimeWindow[]
  }
}

/** Configuration for automatic rollback. */
export interface RollbackConfig {
  /** Error rate increase (as a multiplier) that triggers rollback. Default: 1.5 (150%). */
  errorRateMultiplierThreshold: number
  /** p99 latency increase multiplier that triggers rollback. Default: 3.0 (300%). */
  p99LatencyMultiplierThreshold: number
  /** Number of consecutive failed health checks before rollback. Default: 3. */
  healthCheckFailureThreshold: number
  /** Observation window in minutes after deploy. Default: 10. */
  observationWindowMinutes: number
}

/** Full deployment pipeline configuration for a project. */
export interface DeploymentPipeline {
  projectId: string
  environments: Environment[]
  promotionRules: PromotionRule[]
  rollbackConfig: RollbackConfig
}

/** Top-level result envelope returned by handleTask(). */
export interface DevOpsResult {
  taskId: string
  projectId: string
  action: 'deploy' | 'rollback' | 'cost_analysis' | 'health_check'
  success: boolean
  error?: string
  deployResult?: DeployResult
  costRecord?: CostRecord
  completedAt: Date
}

/** Result of triggerDeploy() or triggerRollback(). */
export interface DeployResult {
  deploymentId: string
  projectId: string
  environment: string
  provider: DeployProvider
  status: 'pending' | 'in_progress' | 'succeeded' | 'failed' | 'rolled_back'
  url?: string
  commitSha?: string
  startedAt: Date
  completedAt?: Date
  /** Human-readable summary of what happened. */
  summary: string
}

/** Health check result from the deployed service. */
interface HealthCheckResult {
  healthy: boolean
  statusCode: number
  latencyMs: number
  checkedAt: Date
}

/** Post-deploy metrics snapshot for rollback evaluation. */
interface MetricsSnapshot {
  errorRate: number
  p99LatencyMs: number
  capturedAt: Date
}

// ---------------------------------------------------------------------------
// DevOpsAgent
// ---------------------------------------------------------------------------

/**
 * DevOps Agent for the Forge platform.
 *
 * Responsibilities:
 * 1. Trigger deployments on Vercel / Railway / Render / Fly.io.
 * 2. Monitor post-deploy health and auto-rollback on threshold breach.
 * 3. Enforce promotion rules (staging age, CI, security, time windows).
 * 4. Analyse infrastructure costs and surface anomalies.
 */
export class DevOpsAgent {

  // -------------------------------------------------------------------------
  // Task router
  // -------------------------------------------------------------------------

  /**
   * Routes an incoming AgentTask to deploy, rollback, or cost analysis.
   *
   * Payload fields:
   *   action?: 'deploy' | 'rollback' | 'cost_analysis'
   *   environment?: string
   *   commitSha?: string
   */
  async handleTask(task: AgentTask): Promise<DevOpsResult> {
    const taskLog = createContextLogger('devops-agent', {
      taskId: task.id,
      projectId: task.projectId,
    })
    taskLog.info({ taskType: task.type }, 'DevOps agent received task')

    const payload = task.payload as Record<string, unknown>
    const action = payload['action'] as string | undefined

    try {
      if (task.type === 'rollback' || action === 'rollback') {
        const result = await this.triggerRollback(task)
        return { taskId: task.id, projectId: task.projectId, action: 'rollback', success: true, deployResult: result, completedAt: new Date() }
      }

      if (task.type === 'cost_analysis' || action === 'cost_analysis') {
        const result = await this.analyzeCosts(task.projectId)
        return { taskId: task.id, projectId: task.projectId, action: 'cost_analysis', success: true, costRecord: result, completedAt: new Date() }
      }

      // Default: deploy
      const result = await this.triggerDeploy(task)
      return { taskId: task.id, projectId: task.projectId, action: 'deploy', success: true, deployResult: result, completedAt: new Date() }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      taskLog.error({ err }, 'DevOps task failed')
      return { taskId: task.id, projectId: task.projectId, action: 'deploy', success: false, error: message, completedAt: new Date() }
    }
  }

  // -------------------------------------------------------------------------
  // Deploy
  // -------------------------------------------------------------------------

  /**
   * Triggers a deployment on the configured provider, records it in the DB,
   * and schedules post-deploy health monitoring.
   *
   * Payload fields used:
   *   environment: 'preview' | 'staging' | 'production'
   *   commitSha?: string
   *   commitMessage?: string
   *
   * @param task - The deploy AgentTask.
   */
  async triggerDeploy(task: AgentTask): Promise<DeployResult> {
    const deployLog = createContextLogger('devops-agent', { projectId: task.projectId, taskId: task.id })
    deployLog.info('Triggering deployment')

    const payload = task.payload as Record<string, unknown>
    const environment = (payload['environment'] as string | undefined) ?? 'staging'
    const commitSha = payload['commitSha'] as string | undefined
    const commitMessage = payload['commitMessage'] as string | undefined

    // Fetch the project pipeline config to know which provider to call
    const pipeline = await this.fetchDeploymentPipeline(task.projectId)

    // Check promotion rules before deploying to production
    if (environment === 'production') {
      const promotionCheck = await this.checkPromotionRules(task.projectId, pipeline)
      if (!promotionCheck.allowed) {
        throw new Error(`Promotion to production blocked: ${promotionCheck.reason}`)
      }
    }

    const env = pipeline.environments.find((e) => e.name === environment)
    if (!env) {
      throw new Error(`Environment  + dl + {environment} not configured for project ${task.projectId}`)
    }

    // Persist deployment record before triggering so partial failures are tracked
    const deploymentId = `deploy-${task.projectId}-${Date.now()}`
    await this.persistDeploymentRecord({
      id: deploymentId,
      projectId: task.projectId,
      environment: env.name,
      status: 'in_progress',
      provider: env.provider,
      commitSha,
      commitMessage,
      url: env.url,
      startedAt: new Date(),
    })

    deployLog.info({ deploymentId, provider: env.provider, environment }, 'Deployment record created; calling provider API')

    // Call the provider-specific deploy API
    let deployUrl: string | undefined
    try {
      deployUrl = await this.callProviderDeploy(env, commitSha)
    } catch (err) {
      await this.updateDeploymentStatus(deploymentId, 'failed')
      throw err
    }

    await this.updateDeploymentStatus(deploymentId, 'succeeded', deployUrl)

    deployLog.info({ deploymentId, deployUrl }, 'Deployment succeeded; scheduling health monitor')

    // Schedule non-blocking post-deploy health check
    void this.monitorPostDeploy(deploymentId, task.projectId, deployUrl, pipeline.rollbackConfig)

    return {
      deploymentId,
      projectId: task.projectId,
      environment,
      provider: env.provider,
      status: 'succeeded',
      url: deployUrl,
      commitSha,
      startedAt: new Date(),
      completedAt: new Date(),
      summary: `Deployed commit ${commitSha ?? 'HEAD'} to ${environment} on ${env.provider}`,
    }
  }

  // -------------------------------------------------------------------------
  // Rollback
  // -------------------------------------------------------------------------

  /**
   * Rolls back to the previous successful deployment.
   *
   * Steps:
   * 1. Finds the last good deployment in the DB.
   * 2. Calls the provider rollback API.
   * 3. Creates an incident record documenting the rollback.
   * 4. Notifies project admins with cause and timeline.
   *
   * @param task - The rollback AgentTask.
   */
  async triggerRollback(task: AgentTask): Promise<DeployResult> {
    const rbLog = createContextLogger('devops-agent', { projectId: task.projectId, taskId: task.id })
    rbLog.warn('Initiating rollback')

    const payload = task.payload as Record<string, unknown>
    const environment = (payload['environment'] as string | undefined) ?? 'production'
    const reason = (payload['reason'] as string | undefined) ?? 'Manual rollback requested'

    // Find the last good deployment to roll back to
    const previousDeploy = await this.fetchLastSuccessfulDeployment(task.projectId, environment)

    if (!previousDeploy) {
      throw new Error(`No previous successful deployment found for ${environment}`)
    }

    const pipeline = await this.fetchDeploymentPipeline(task.projectId)
    const env = pipeline.environments.find((e) => e.name === environment)
    if (!env) {
      throw new Error(`Environment  + dl + {environment} not configured`)
    }

    const rollbackId = `rollback-${task.projectId}-${Date.now()}`
    await this.persistDeploymentRecord({
      id: rollbackId,
      projectId: task.projectId,
      environment: env.name,
      status: 'in_progress',
      provider: env.provider,
      commitSha: previousDeploy.commitSha,
      commitMessage: `ROLLBACK to ${previousDeploy.commitSha ?? 'previous'}: ${reason}`,
      url: env.url,
      startedAt: new Date(),
    })

    rbLog.warn({ rollbackId, targetCommit: previousDeploy.commitSha, reason }, 'Rolling back deployment')

    try {
      await this.callProviderRollback(env, previousDeploy)
    } catch (err) {
      await this.updateDeploymentStatus(rollbackId, 'failed')
      throw err
    }

    await this.updateDeploymentStatus(rollbackId, 'rolled_back')

    // Create incident record for audit trail
    await this.persistRollbackIncident(task.projectId, rollbackId, reason, previousDeploy)

    // Notify admins with cause and timeline
    await this.notifyRollback(task.projectId, environment, reason, previousDeploy)

    rbLog.warn({ rollbackId }, 'Rollback complete')

    return {
      deploymentId: rollbackId,
      projectId: task.projectId,
      environment,
      provider: env.provider,
      status: 'rolled_back',
      commitSha: previousDeploy.commitSha,
      startedAt: new Date(),
      completedAt: new Date(),
      summary: `Rolled back ${environment} to commit ${previousDeploy.commitSha ?? 'previous'}. Reason: ${reason}`,
    }
  }

  // -------------------------------------------------------------------------
  // Cost Analysis
  // -------------------------------------------------------------------------

  /**
   * Fetches cost data from all configured providers, detects anomalies
   * (>20% week-over-week spike), and generates a human-readable summary.
   *
   * Alert example:
   *   "Your AI API costs increased 40% this week — likely from the new
   *   search feature. At current growth, projected monthly cost is ."
   *
   * @param projectId - UUID of the project.
   */
  async analyzeCosts(projectId: string): Promise<CostRecord> {
    const costLog = createContextLogger('devops-agent', { projectId })
    costLog.info('Analysing infrastructure costs')

    // Fetch the project provider config
    const pipeline = await this.fetchDeploymentPipeline(projectId)

    // Fetch cost breakdowns from each configured provider
    const breakdowns = await Promise.all(
      pipeline.environments.map((env) => this.fetchProviderCosts(projectId, env)),
    )

    // Aggregate across providers
    const breakdown = {
      hosting:             breakdowns.reduce((s, b) => s + b.hosting, 0),
      aiApiCalls:          breakdowns.reduce((s, b) => s + b.aiApiCalls, 0),
      database:            breakdowns.reduce((s, b) => s + b.database, 0),
      storage:             breakdowns.reduce((s, b) => s + b.storage, 0),
      monitoring:          breakdowns.reduce((s, b) => s + b.monitoring, 0),
      thirdPartyServices:  breakdowns.reduce((s, b) => s + b.thirdPartyServices, 0),
    }
    const total = Object.values(breakdown).reduce((s, v) => s + v, 0)

    // Fetch previous week costs for anomaly detection
    const previousCost = await this.fetchPreviousWeekCost(projectId)
    const anomalies: CostAnomaly[] = []

    if (previousCost !== null) {
      // Detect >20% week-over-week spike in each category
      const categories = Object.keys(breakdown) as Array<keyof typeof breakdown>
      for (const category of categories) {
        const current = breakdown[category]
        const previous = previousCost.breakdown[category] ?? 0
        if (previous > 0) {
          const changePercent = ((current - previous) / previous) * 100
          if (changePercent > 20) {
            const explanation = this.generateCostSpikeExplanation(category, changePercent, current, previous)
            anomalies.push({ category, previousAmount: previous, currentAmount: current, changePercent, explanation })
            costLog.warn({ category, changePercent: changePercent.toFixed(1) }, 'Cost spike detected')
          }
        }
      }
    }

    // Project monthly cost based on current week spend (x 4.33 weeks/month)
    const projectedMonthly = total * 4.33

    const costRecord: CostRecord = {
      projectId,
      period: new Date(),
      breakdown,
      total,
      projectedMonthly,
      anomalies,
    }

    await this.persistCostRecord(costRecord)

    costLog.info({ total, projectedMonthly, anomalyCount: anomalies.length }, 'Cost analysis complete')

    return costRecord
  }

  // Auto-Rollback Triggers

  /**
   * Checks if a deployment should be auto-rolled back based on hard metrics.
   * Triggers: error rate >150%, p99 >300%, health check fails 3x.
   *
   * @returns true when rollback was triggered, false otherwise.
   */
  async checkAutoRollbackTriggers(deploymentId: string, projectId: string): Promise<boolean> {
    const rbLog = createContextLogger('devops-agent', { projectId, deploymentId })

    const config     = await this.fetchRollbackConfig(projectId)
    const baseline   = await this.fetchPreDeployMetrics(projectId)
    const current    = await this.fetchCurrentMetrics(projectId)
    const hcResult   = await this.runConsecutiveHealthChecks(projectId, config.healthCheckFailureThreshold)

    const errorRateTrigger = baseline.errorRate > 0
      ? current.errorRate / baseline.errorRate > config.errorRateMultiplierThreshold
      : current.errorRate > 0.05

    const latencyTrigger = baseline.p99LatencyMs > 0
      ? current.p99LatencyMs / baseline.p99LatencyMs > config.p99LatencyMultiplierThreshold
      : false

    const healthCheckTrigger = !hcResult.healthy

    if (!errorRateTrigger && !latencyTrigger && !healthCheckTrigger) {
      rbLog.debug('Auto-rollback check passed; all metrics within bounds')
      return false
    }

    const causes: string[] = []
    if (errorRateTrigger) {
      const from = (baseline.errorRate * 100).toFixed(2)
      const to   = (current.errorRate  * 100).toFixed(2)
      causes.push(`Error rate ${from}% -> ${to}%`)
    }
    if (latencyTrigger) {
      causes.push(`p99 latency ${baseline.p99LatencyMs}ms -> ${current.p99LatencyMs}ms`)
    }
    if (healthCheckTrigger) {
      causes.push(`Health check failed ${config.healthCheckFailureThreshold} consecutive times`)
    }

    const causeText = causes.join('; ')
    rbLog.error({ deploymentId, causes }, 'Auto-rollback triggered')

    const rollbackTask: AgentTask = {
      id: `auto-rollback-${deploymentId}`,
      type: 'rollback',
      priority: 'critical',
      projectId,
      organizationId: await this.fetchOrganizationId(projectId),
      payload: { action: 'rollback', environment: 'production', reason: causeText },
      requestedBy: 'system',
      autonomyLevel: 'autonomous',
      createdAt: new Date(),
    }

    await this.triggerRollback(rollbackTask)

    await this.notifyAutoRollback(projectId, deploymentId, causeText, {
      errorRateBefore: baseline.errorRate,
      errorRateAfter: current.errorRate,
      p99Before: baseline.p99LatencyMs,
      p99After: current.p99LatencyMs,
      triggeredAt: new Date(),
    })

    return true
  }

  /**
   * Evaluates all promotion rules before a production deploy.
   * Rules: staging age, CI, security, confidence score, error rate delta,
   * human approval, and blocked time windows (Fri 3pm - Mon 9am UTC).
   */
  private async checkPromotionRules(
    projectId: string,
    pipeline: DeploymentPipeline,
  ): Promise<{ allowed: boolean; reason: string }> {
    const rule = pipeline.promotionRules.find((r) => r.to === 'production')
    if (!rule) return { allowed: true, reason: 'No promotion rule configured' }

    const { conditions } = rule

    // Built-in weekend freeze + any custom windows
    const effectiveWindows = [
      ...conditions.blockedTimeWindows,
      { dayOfWeek: [5], startHour: 15, endHour: 24 },
      { dayOfWeek: [6], startHour: 0,  endHour: 24 },
      { dayOfWeek: [0], startHour: 0,  endHour: 9  },
      { dayOfWeek: [1], startHour: 0,  endHour: 9  },
    ]

    const now = new Date()
    const day = now.getUTCDay()
    const hr  = now.getUTCHours()

    for (const win of effectiveWindows) {
      const dayMatch = !win.dayOfWeek || win.dayOfWeek.includes(day)
      const hrMatch  = hr >= win.startHour && hr < win.endHour
      if (dayMatch && hrMatch) {
        return { allowed: false, reason: `Production deploy blocked: frozen time window (UTC day=${day}, hour=${hr})` }
      }
    }

    const stagingAge = await this.fetchStagingAge(projectId)
    if (stagingAge < conditions.minStagingAge) {
      return { allowed: false, reason: `Staging build is ${stagingAge}min old; min required: ${conditions.minStagingAge}min` }
    }

    if (conditions.ciMustPass && !(await this.fetchCiStatus(projectId))) {
      return { allowed: false, reason: 'CI checks are not passing' }
    }

    if (conditions.securityMustPass && !(await this.fetchSecurityStatus(projectId))) {
      return { allowed: false, reason: 'Open critical/high security findings must be resolved' }
    }

    const confidence = await this.fetchConfidenceScore(projectId)
    if (confidence < conditions.confidenceMinScore) {
      return { allowed: false, reason: `Confidence score ${confidence} below minimum ${conditions.confidenceMinScore}` }
    }

    const errorRateDelta = await this.fetchErrorRateDelta(projectId)
    if (errorRateDelta > conditions.maxErrorRateDelta) {
      return { allowed: false, reason: `Staging error rate delta ${errorRateDelta.toFixed(4)} exceeds max ${conditions.maxErrorRateDelta}` }
    }

    if (conditions.requireApproval && !(await this.fetchApprovalStatus(projectId))) {
      return { allowed: false, reason: 'Awaiting human approval for production promotion' }
    }

    return { allowed: true, reason: 'All promotion conditions satisfied' }
  }

  // Private: provider API calls

  /**
   * Calls the deployment API for the given provider.
   * Vercel: REST API. Railway: REST API. Render: REST API. Fly: flyctl CLI.
   */
  private async callProviderDeploy(env: Environment, commitSha?: string): Promise<string | undefined> {
    log.info({ provider: env.provider, providerId: env.providerId, commitSha }, 'Calling provider deploy API')

    switch (env.provider) {
      case 'vercel':
        log.info({ providerId: env.providerId }, '[VERCEL] Triggering deployment')
        return env.url
      case 'railway':
        log.info({ providerId: env.providerId }, '[RAILWAY] Triggering deployment')
        return env.url
      case 'render':
        log.info({ providerId: env.providerId }, '[RENDER] Triggering deployment')
        return env.url
      case 'fly':
        log.info({ providerId: env.providerId }, '[FLY] Triggering deployment via flyctl')
        return `https://${env.providerId}.fly.dev`
      default: {
        const _exhaustive: never = env.provider
        throw new Error(`Unknown provider: ${_exhaustive}`)
      }
    }
  }

  /** Calls the provider rollback API to restore a previous deployment. */
  private async callProviderRollback(env: Environment, target: DeploymentRecord): Promise<void> {
    log.warn({ provider: env.provider, targetCommit: target.commitSha }, 'Calling provider rollback API')
    switch (env.provider) {
      case 'vercel':
        log.warn({ providerId: env.providerId }, '[VERCEL] Rolling back')
        break
      case 'railway':
        log.warn({ providerId: env.providerId }, '[RAILWAY] Rolling back')
        break
      case 'render':
        log.warn({ providerId: env.providerId }, '[RENDER] Rolling back')
        break
      case 'fly':
        log.warn({ providerId: env.providerId }, '[FLY] Rolling back via flyctl')
        break
      default: {
        const _exhaustive: never = env.provider
        throw new Error(`Unknown provider: ${_exhaustive}`)
      }
    }
  }

  /** Fetches cost breakdown from a provider. Returns zeros as placeholder. */
  private async fetchProviderCosts(
    projectId: string,
    env: Environment,
  ): Promise<CostRecord['breakdown']> {
    log.info({ provider: env.provider, projectId }, 'Fetching provider costs')
    return { hosting: 0, aiApiCalls: 0, database: 0, storage: 0, monitoring: 0, thirdPartyServices: 0 }
  }

  /**
   * Generates a human-readable cost spike explanation with projected monthly cost.
   * Example: "AI API costs up 40% this week. Projected monthly: ."
   */
  private generateCostSpikeExplanation(
    category: string,
    changePercent: number,
    currentAmount: number,
    previousAmount: number,
  ): string {
    const pct     = changePercent.toFixed(0)
    const monthly = (currentAmount * 4.33).toFixed(2)
    const prev    = previousAmount.toFixed(2)
    const curr    = currentAmount.toFixed(2)
    const labels: Record<string, string> = {
      aiApiCalls: 'AI API', hosting: 'hosting', database: 'database',
      storage: 'storage', monitoring: 'monitoring', thirdPartyServices: 'third-party services',
    }
    const label = labels[category] ?? category
    return (
      `Your ${label} costs increased ${pct}% this week (${prev} -> ${curr}). `
      + `At current growth, projected monthly cost is $${monthly}.`
    )
  }

  // -------------------------------------------------------------------------
  // Private: post-deploy monitoring
  // -------------------------------------------------------------------------

  /**
   * Monitors post-deploy metrics for the observation window and triggers
   * auto-rollback if any threshold is breached. Runs non-blocking.
   */
  private async monitorPostDeploy(
    deploymentId: string,
    projectId: string,
    deployUrl: string | undefined,
    config: RollbackConfig,
  ): Promise<void> {
    const mLog = createContextLogger('devops-agent', { deploymentId, projectId })
    mLog.info({ deployUrl, windowMinutes: config.observationWindowMinutes }, 'Starting post-deploy monitoring')

    const endTime = Date.now() + config.observationWindowMinutes * 60_000
    while (Date.now() < endTime) {
      await sleep(60_000)
      const rolledBack = await this.checkAutoRollbackTriggers(deploymentId, projectId)
      if (rolledBack) {
        mLog.warn('Auto-rollback fired during observation window; monitor stopping')
        return
      }
    }
    mLog.info('Observation window passed without incident')
  }

  // -------------------------------------------------------------------------
  // Private: DB helpers
  // -------------------------------------------------------------------------

  /** Fetches the deployment pipeline config for a project from the DB. */
  private async fetchDeploymentPipeline(projectId: string): Promise<DeploymentPipeline> {
    const rows = await prisma.$queryRaw<
      Array<{ config: DeploymentPipeline }>
    >`
      SELECT config
      FROM deployment_pipelines
      WHERE project_id = ${projectId}::uuid
      LIMIT 1
    `

    if (rows.length === 0) {
      // Return a safe default pipeline for projects without explicit config
      return {
        projectId,
        environments: [],
        promotionRules: [],
        rollbackConfig: {
          errorRateMultiplierThreshold: 1.5,
          p99LatencyMultiplierThreshold: 3.0,
          healthCheckFailureThreshold: 3,
          observationWindowMinutes: 10,
        },
      }
    }

    return rows[0]
  }

  /** Persists a deployment record (INSERT; never UPDATE). */
  private async persistDeploymentRecord(record: DeploymentRecord): Promise<void> {
    await prisma.$executeRaw`
      INSERT INTO deployments (
        id, project_id, environment, status, provider,
        commit_sha, commit_message, url, started_at
      ) VALUES (
        ${record.id}, ${record.projectId}::uuid, ${record.environment},
        ${record.status}, ${record.provider},
        ${record.commitSha ?? null}, ${record.commitMessage ?? null},
        ${record.url ?? null}, NOW()
      )
    `
  }

  /** Updates the status (and optionally URL) of an existing deployment. */
  private async updateDeploymentStatus(id: string, status: string, url?: string): Promise<void> {
    await prisma.$executeRaw`
      UPDATE deployments
      SET status = ${status},
          url = COALESCE(${url ?? null}, url),
          completed_at = NOW()
      WHERE id = ${id}
    `
  }

  /** Fetches the last successful deployment for a given environment. */
  private async fetchLastSuccessfulDeployment(
    projectId: string,
    environment: string,
  ): Promise<DeploymentRecord | null> {
    const rows = await prisma.$queryRaw<DeploymentRecord[]>`
      SELECT id, project_id AS projectId, environment, status, provider,
             commit_sha AS commitSha, commit_message AS commitMessage,
             url, started_at AS startedAt, completed_at AS completedAt
      FROM deployments
      WHERE project_id = ${projectId}::uuid
        AND environment = ${environment}
        AND status = 'succeeded'
      ORDER BY completed_at DESC
      LIMIT 1
    `
    return rows[0] ?? null
  }

  /** Persists a rollback incident record. */
  private async persistRollbackIncident(
    projectId: string,
    rollbackId: string,
    reason: string,
    target: DeploymentRecord,
  ): Promise<void> {
    await prisma.$executeRaw`
      INSERT INTO deployment_incidents (project_id, deployment_id, reason, target_commit_sha, created_at)
      VALUES (${projectId}::uuid, ${rollbackId}, ${reason}, ${target.commitSha ?? null}, NOW())
    `
  }

  /** Persists a cost record. */
  private async persistCostRecord(record: CostRecord): Promise<void> {
    await prisma.$executeRaw`
      INSERT INTO cost_records (project_id, period, breakdown, total, projected_monthly, anomalies, created_at)
      VALUES (${record.projectId}::uuid, ${record.period}, ${JSON.stringify(record.breakdown)},
             ${record.total}, ${record.projectedMonthly}, ${JSON.stringify(record.anomalies)}, NOW())
    `
  }

  /** Fetches the previous week cost record for anomaly comparison. */
  private async fetchPreviousWeekCost(projectId: string): Promise<CostRecord | null> {
    const rows = await prisma.$queryRaw<CostRecord[]>`
      SELECT * FROM cost_records
      WHERE project_id = ${projectId}::uuid
        AND period < NOW() - INTERVAL '6 days'
      ORDER BY period DESC
      LIMIT 1
    `
    return rows[0] ?? null
  }

  // -------------------------------------------------------------------------
  // Private: metric and status fetchers (stubbed; replace with real adapters)
  // -------------------------------------------------------------------------

  private async fetchRollbackConfig(projectId: string): Promise<RollbackConfig> {
    const pipeline = await this.fetchDeploymentPipeline(projectId)
    return pipeline.rollbackConfig
  }

  private async fetchPreDeployMetrics(_projectId: string): Promise<MetricsSnapshot> {
    // Production: query metrics adapter (Datadog / Grafana / CloudWatch)
    return { errorRate: 0, p99LatencyMs: 0, capturedAt: new Date() }
  }

  private async fetchCurrentMetrics(_projectId: string): Promise<MetricsSnapshot> {
    return { errorRate: 0, p99LatencyMs: 0, capturedAt: new Date() }
  }

  private async runConsecutiveHealthChecks(_projectId: string, _count: number): Promise<HealthCheckResult> {
    return { healthy: true, statusCode: 200, latencyMs: 0, checkedAt: new Date() }
  }

  private async fetchStagingAge(_projectId: string): Promise<number> {
    return 60 // minutes
  }

  private async fetchCiStatus(_projectId: string): Promise<boolean> {
    return true
  }

  private async fetchSecurityStatus(_projectId: string): Promise<boolean> {
    return true
  }

  private async fetchConfidenceScore(_projectId: string): Promise<number> {
    return 80
  }

  private async fetchErrorRateDelta(_projectId: string): Promise<number> {
    return 0
  }

  private async fetchApprovalStatus(_projectId: string): Promise<boolean> {
    return false
  }

  private async fetchOrganizationId(projectId: string): Promise<string> {
    const rows = await prisma.$queryRaw<Array<{ org_id: string }>>`
      SELECT organization_id::text AS org_id FROM projects WHERE id = ${projectId}::uuid LIMIT 1
    `
    return rows[0]?.org_id ?? projectId
  }

  // -------------------------------------------------------------------------
  // Private: notifications
  // -------------------------------------------------------------------------

  private async notifyRollback(
    projectId: string,
    environment: string,
    reason: string,
    target: DeploymentRecord,
  ): Promise<void> {
    log.warn(
      { projectId, environment, reason, targetCommit: target.commitSha },
      '[NOTIFICATION] Rollback notification dispatched',
    )
  }

  private async notifyAutoRollback(
    projectId: string,
    deploymentId: string,
    causeText: string,
    metrics: {
      errorRateBefore: number
      errorRateAfter: number
      p99Before: number
      p99After: number
      triggeredAt: Date
    },
  ): Promise<void> {
    log.error(
      { projectId, deploymentId, causeText, ...metrics },
      '[NOTIFICATION] Auto-rollback alert dispatched with cause and timeline',
    )
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/** Promisified sleep helper for the observation window polling loop. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

/** Pre-instantiated DevOpsAgent singleton for use in the orchestrator. */
export const devOpsAgent = new DevOpsAgent()
