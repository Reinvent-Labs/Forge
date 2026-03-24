/**
 * @forge/agent-devops - DevOps Agent
 *
 * Orchestrates production-safe deployments with:
 * - Multi-platform deploy APIs (Vercel, Railway, Fly.io)
 * - Staged rollout flow (preview -> staging -> production)
 * - Confidence-based promotion and approval gating
 * - Post-deploy health monitoring with automatic rollback
 * - Deployment duration and per-platform cost tracking
 * - Deployment freeze windows (weekends + late Friday)
 * - Optional DNS updates after successful production deployment
 */

import { randomUUID } from 'crypto'
import { createLogger, createContextLogger } from '@forge/shared'
import type {
  AgentTask,
  ConfidenceRecommendation,
  ConfidenceScore,
  CostAnomaly,
  CostRecord,
  TimeWindow,
} from '@forge/shared'
import { prisma } from '@forge/database'
import { ConfidenceEngine } from '@forge/orchestrator'
import type { ConfidenceInputs } from '@forge/orchestrator'
import { ApprovalGateway } from '@forge/orchestrator'

const log = createLogger('agent-devops')

const DAY_MS = 24 * 60 * 60 * 1000
const API_TIMEOUT_MS = 20_000

const DEPLOY_PROVIDERS = ['vercel', 'railway', 'fly'] as const
const DEPLOY_ENVIRONMENTS = ['preview', 'staging', 'production'] as const

const DEFAULT_BLOCKED_TIME_WINDOWS: TimeWindow[] = [
  { dayOfWeek: [5], startHour: 15, endHour: 24 },
  { dayOfWeek: [6], startHour: 0, endHour: 24 },
  { dayOfWeek: [0], startHour: 0, endHour: 24 },
]

const DEFAULT_ROLLBACK_CONFIG: RollbackConfig = {
  errorRateMultiplierThreshold: 1.5,
  p99LatencyMultiplierThreshold: 2.0,
  healthCheckFailureThreshold: 3,
  observationWindowMinutes: 10,
  healthCheckIntervalMs: 30_000,
}

const DEFAULT_PROMOTION_GATES: PromotionGates = {
  minStagingMinutes: 0,
  maxErrorRateDelta: 0.2,
  minConfidenceScore: 65,
}

const DEFAULT_PROVIDER_COST_RATES_USD_PER_MINUTE: Record<DeployProvider, number> = {
  vercel: 0.024,
  railway: 0.03,
  fly: 0.022,
}

/** Supported deployment providers for this agent. */
export type DeployProvider = (typeof DEPLOY_PROVIDERS)[number]

/** Rollout environments in promotion order. */
export type DeployEnvironmentName = (typeof DEPLOY_ENVIRONMENTS)[number]

/** DNS provider choices for post-deploy updates. */
export type DnsProvider = 'vercel' | 'cloudflare'

/**
 * Environment-specific deployment configuration.
 */
export interface EnvironmentConfig {
  name: DeployEnvironmentName
  provider: DeployProvider
  providerProjectId: string
  token: string
  url?: string
  teamId?: string
  serviceId?: string
  environmentId?: string
  appName?: string
  costRateUsdPerMinute?: number
}

/**
 * Automatic rollback trigger configuration.
 */
export interface RollbackConfig {
  /** Roll back when current error rate / baseline exceeds this multiplier. */
  errorRateMultiplierThreshold: number
  /** Roll back when current p99 / baseline exceeds this multiplier. */
  p99LatencyMultiplierThreshold: number
  /** Number of consecutive failed health checks to treat as unhealthy. */
  healthCheckFailureThreshold: number
  /** Minutes to observe after production deploy for degradation. */
  observationWindowMinutes: number
  /** Poll interval used during post-deploy monitoring. */
  healthCheckIntervalMs: number
}

/**
 * Promotion gate thresholds checked before production promotion.
 */
export interface PromotionGates {
  /** Minimum required staging age (minutes) before production promotion. */
  minStagingMinutes: number
  /** Maximum allowed relative error-rate increase (e.g. 0.2 = +20%). */
  maxErrorRateDelta: number
  /** Minimum confidence score required to proceed. */
  minConfidenceScore: number
}

/**
 * Internal deployment pipeline resolved from project config + task payload.
 */
export interface DeploymentPipeline {
  projectId: string
  provider: DeployProvider
  environments: Record<DeployEnvironmentName, EnvironmentConfig>
  blockedTimeWindows: TimeWindow[]
  rollbackConfig: RollbackConfig
  promotionGates: PromotionGates
}

/**
 * DNS record mutation request.
 */
export interface DnsRecordChange {
  type: 'A' | 'AAAA' | 'CNAME'
  name: string
  value: string
  ttl?: number
  proxied?: boolean
}

/**
 * DNS update configuration for post-production promotion.
 */
export interface DnsUpdateConfig {
  provider?: DnsProvider
  token?: string
  zoneId?: string
  projectId?: string
  records: DnsRecordChange[]
}

/**
 * Optional provider-level overrides supplied in task payload.
 */
export interface ProviderConfigOverride {
  token?: string
  projectId?: string
  previewProjectId?: string
  stagingProjectId?: string
  productionProjectId?: string
  teamId?: string
  serviceId?: string
  previewEnvironmentId?: string
  stagingEnvironmentId?: string
  productionEnvironmentId?: string
  appName?: string
  costRateUsdPerMinute?: number
}

/**
 * Optional environment-level overrides supplied in task payload.
 */
export interface EnvironmentConfigOverride {
  token?: string
  projectId?: string
  providerProjectId?: string
  teamId?: string
  serviceId?: string
  environmentId?: string
  appName?: string
  url?: string
  costRateUsdPerMinute?: number
}

/**
 * Deploy payload accepted by triggerDeploy.
 */
export interface DeployTaskPayload {
  action?: 'deploy' | 'rollback' | 'cost_analysis' | 'health_check'
  environment: DeployEnvironmentName
  provider?: DeployProvider
  commitSha?: string
  commitMessage?: string
  branch?: string
  changedFiles?: string[]
  ciPassing?: boolean
  ciCoverage?: number
  securityScanPassed?: boolean
  blockedTimeWindows?: TimeWindow[]
  overrideFrozenWindow: boolean
  forceApproval: boolean
  minStagingMinutes?: number
  maxErrorRateDelta?: number
  confidenceMinScore?: number
  rollbackConfig?: Partial<RollbackConfig>
  providers?: Partial<Record<DeployProvider, ProviderConfigOverride>>
  environments?: Partial<Record<DeployEnvironmentName, EnvironmentConfigOverride>>
  dns?: DnsUpdateConfig
}

/**
 * Rollback payload accepted by triggerRollback.
 */
export interface RollbackTaskPayload {
  environment: DeployEnvironmentName
  provider?: DeployProvider
  reason: string
  rollbackToDeploymentId?: string
  excludeDeploymentId?: string
  automatic: boolean
  providers?: Partial<Record<DeployProvider, ProviderConfigOverride>>
  environments?: Partial<Record<DeployEnvironmentName, EnvironmentConfigOverride>>
}

/**
 * Cost analysis payload accepted by analyzeCosts.
 */
export interface CostAnalysisPayload {
  lookbackDays: number
}

/**
 * Per-provider cost totals.
 */
export interface ProviderCostBreakdown {
  vercel: number
  railway: number
  fly: number
}

/**
 * Single stage rollout result.
 */
export interface StageDeployResult {
  deploymentId: string
  projectId: string
  environment: DeployEnvironmentName
  provider: DeployProvider
  status: 'pending' | 'in_progress' | 'succeeded' | 'failed' | 'rolled_back'
  startedAt: Date
  completedAt: Date
  durationMs: number
  estimatedCostUsd: number
  summary: string
  url?: string
  commitSha?: string
  externalId?: string
  rollbackReason?: string
  dnsUpdated?: boolean
}

/**
 * Result returned by deploy/rollback operations.
 */
export interface DeployResult {
  deploymentId: string
  projectId: string
  environment: DeployEnvironmentName
  provider: DeployProvider
  status: 'pending' | 'in_progress' | 'succeeded' | 'failed' | 'rolled_back'
  startedAt: Date
  completedAt: Date
  summary: string
  url?: string
  commitSha?: string
  confidenceScore?: ConfidenceScore
  totalCostUsd?: number
  approvalRequested?: boolean
  dnsUpdated?: boolean
  stageResults: StageDeployResult[]
}

/**
 * Top-level result envelope returned by handleTask.
 */
export interface DevOpsResult {
  taskId: string
  projectId: string
  action: 'deploy' | 'rollback' | 'cost_analysis' | 'health_check'
  success: boolean
  completedAt: Date
  error?: string
  approvalRequested?: boolean
  deployResult?: DeployResult
  costRecord?: CostRecord
  platformCosts?: ProviderCostBreakdown
}

/**
 * Result of a health check pass.
 */
interface HealthCheckResult {
  healthy: boolean
  statusCode: number
  latencyMs: number
  checkedAt: Date
  failures: number
}

/**
 * Normalized metrics snapshot used for rollback checks.
 */
interface MetricsSnapshot {
  errorRate: number
  p99LatencyMs: number
  capturedAt: Date
}

/**
 * Provider deploy API response.
 */
interface ProviderDeployResponse {
  externalId?: string
  url?: string
}

/**
 * Runtime dependencies for easier unit testing.
 */
export interface DevOpsAgentDependencies {
  confidenceEngine?: Pick<ConfidenceEngine, 'compute'>
  approvalGateway?: Pick<ApprovalGateway, 'createApproval'>
  fetchImpl?: typeof fetch
  now?: () => Date
  sleepFn?: (ms: number) => Promise<void>
}

class ApprovalRequiredError extends Error {
  readonly confidenceScore: ConfidenceScore

  constructor(message: string, confidenceScore: ConfidenceScore) {
    super(message)
    this.name = 'ApprovalRequiredError'
    this.confidenceScore = confidenceScore
  }
}

/**
 * Production deployment orchestration agent.
 */
export class DevOpsAgent {
  private readonly confidenceEngine: Pick<ConfidenceEngine, 'compute'>
  private readonly approvalGateway: Pick<ApprovalGateway, 'createApproval'>
  private readonly fetchImpl: typeof fetch
  private readonly now: () => Date
  private readonly sleepFn: (ms: number) => Promise<void>

  constructor(deps: DevOpsAgentDependencies = {}) {
    this.confidenceEngine = deps.confidenceEngine ?? new ConfidenceEngine()
    this.approvalGateway = deps.approvalGateway ?? new ApprovalGateway()
    this.fetchImpl = deps.fetchImpl ?? fetch
    this.now = deps.now ?? (() => new Date())
    this.sleepFn = deps.sleepFn ?? sleep
  }

  /**
   * Main task router for deploy/rollback/cost-analysis/health-check actions.
   */
  async handleTask(task: AgentTask): Promise<DevOpsResult> {
    const taskLog = createContextLogger('agent-devops', {
      taskId: task.id,
      projectId: task.projectId,
      taskType: task.type,
    })

    const payload = asRecord(task.payload)
    const action = this.resolveAction(task, payload)

    taskLog.info({ action }, 'DevOps task received')

    try {
      if (action === 'rollback') {
        const deployResult = await this.triggerRollback(task)
        return {
          taskId: task.id,
          projectId: task.projectId,
          action,
          success: true,
          deployResult,
          completedAt: this.now(),
        }
      }

      if (action === 'cost_analysis') {
        const costPayload = this.parseCostAnalysisPayload(payload)
        const costRecord = await this.analyzeCosts(task.projectId, costPayload.lookbackDays)
        const platformCosts = await this.calculatePlatformCosts(task.projectId, costPayload.lookbackDays)
        return {
          taskId: task.id,
          projectId: task.projectId,
          action,
          success: true,
          costRecord,
          platformCosts,
          completedAt: this.now(),
        }
      }

      if (action === 'health_check') {
        const deploymentId = readString(payload['deploymentId'])
        if (!deploymentId) {
          throw new Error('health_check requires payload.deploymentId')
        }
        const rolledBack = await this.checkAutoRollbackTriggers(deploymentId, task.projectId)
        const deployment = await prisma.deployment.findUnique({ where: { id: deploymentId } })
        const environment = deployment ? fromDbEnvironment(deployment.environment) : 'production'
        const provider = deployment ? parseProvider(deployment.provider) : undefined
        if (!provider) {
          throw new Error(`Unknown deployment provider for deployment ${deploymentId}`)
        }

        const deployResult: DeployResult = {
          deploymentId,
          projectId: task.projectId,
          environment,
          provider,
          status: rolledBack ? 'rolled_back' : 'succeeded',
          startedAt: deployment?.startedAt ?? this.now(),
          completedAt: this.now(),
          summary: rolledBack
            ? 'Auto-rollback triggered during health check'
            : 'Health check passed; no rollback required',
          stageResults: [],
        }

        return {
          taskId: task.id,
          projectId: task.projectId,
          action,
          success: true,
          deployResult,
          completedAt: this.now(),
        }
      }

      const deployResult = await this.triggerDeploy(task)
      return {
        taskId: task.id,
        projectId: task.projectId,
        action: 'deploy',
        success: true,
        deployResult,
        completedAt: this.now(),
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      taskLog.error({ err }, 'DevOps task failed')

      const failedResult: DevOpsResult = {
        taskId: task.id,
        projectId: task.projectId,
        action,
        success: false,
        error: message,
        completedAt: this.now(),
      }

      if (err instanceof ApprovalRequiredError) {
        failedResult.approvalRequested = true
      }

      return failedResult
    }
  }

  /**
   * Deploys through a staged rollout:
   * preview -> staging -> production.
   */
  async triggerDeploy(task: AgentTask): Promise<DeployResult> {
    const payload = this.parseDeployTaskPayload(asRecord(task.payload))
    const deployLog = createContextLogger('agent-devops', {
      taskId: task.id,
      projectId: task.projectId,
      targetEnvironment: payload.environment,
    })

    const pipeline = await this.resolveDeploymentPipeline(task.projectId, payload)
    const stagePlan = this.buildStagePlan(payload.environment)

    if (payload.environment === 'production' && !stagePlan.includes('staging')) {
      throw new Error('Production deployments must pass through staging')
    }

    if (payload.environment === 'production') {
      this.assertAllowedDeploymentWindow(
        this.now(),
        pipeline.blockedTimeWindows,
        payload.overrideFrozenWindow,
      )
    }

    let confidenceScore = await this.calculateDeploymentConfidence(task, payload)
    if (confidenceScore.recommendation === 'block') {
      throw new Error(
        `Deployment blocked by confidence engine (${confidenceScore.total}/100): ${confidenceScore.humanReadableSummary}`,
      )
    }

    const rolloutStartedAt = this.now()
    const stageResults: StageDeployResult[] = []

    for (const stage of stagePlan) {
      if (stage === 'production') {
        await this.assertProductionPromotionGate(
          task.projectId,
          stageResults,
          confidenceScore,
          pipeline.promotionGates,
        )

        await this.ensureProductionApproval(task, payload, confidenceScore, stageResults)
      }

      const environment = pipeline.environments[stage]
      const stageResult = await this.deployEnvironment(task, environment, payload, confidenceScore)
      stageResults.push(stageResult)

      const health = await this.runConsecutiveHealthChecks(
        stageResult.url,
        pipeline.rollbackConfig.healthCheckFailureThreshold,
        pipeline.rollbackConfig.healthCheckIntervalMs,
      )

      if (!health.healthy) {
        deployLog.error(
          { stage, statusCode: health.statusCode, failures: health.failures },
          'Post-deploy health checks failed',
        )

        if (stage === 'production') {
          const reason = `Health checks failed ${health.failures} consecutive times`
          await this.executeAutoRollbackForStage(task, stageResult, reason)
          stageResult.status = 'rolled_back'
          stageResult.rollbackReason = reason
        }

        throw new Error(
          `Deployment to ${stage} failed health checks (status ${health.statusCode})`,
        )
      }

      if (stage === 'production') {
        void this.monitorPostDeployment(task, stageResult, pipeline.rollbackConfig)

        if (payload.dns && payload.dns.records.length > 0) {
          await this.updateDnsRecords(task.projectId, environment, stageResult, payload.dns)
          stageResult.dnsUpdated = true
        }
      } else {
        confidenceScore = await this.calculateDeploymentConfidence(task, payload)
        if (confidenceScore.recommendation === 'block') {
          throw new Error(
            `Deployment confidence dropped below safe threshold after ${stage}`,
          )
        }
      }
    }

    const finalStage = stageResults[stageResults.length - 1]
    if (!finalStage) {
      throw new Error('Staged rollout produced no deployment results')
    }

    const totalCostUsd = roundCurrency(
      stageResults.reduce((sum, stage) => sum + stage.estimatedCostUsd, 0),
    )

    const deployResult: DeployResult = {
      deploymentId: finalStage.deploymentId,
      projectId: task.projectId,
      environment: finalStage.environment,
      provider: finalStage.provider,
      status: finalStage.status,
      startedAt: rolloutStartedAt,
      completedAt: this.now(),
      summary: `Staged rollout completed: ${stagePlan.join(' -> ')}`,
      stageResults,
      confidenceScore,
      totalCostUsd,
    }

    if (finalStage.url) {
      deployResult.url = finalStage.url
    }

    if (payload.commitSha) {
      deployResult.commitSha = payload.commitSha
    }

    if (stageResults.some((s) => s.dnsUpdated)) {
      deployResult.dnsUpdated = true
    }

    return deployResult
  }

  /**
   * Rolls back to a previous successful deployment.
   */
  async triggerRollback(task: AgentTask): Promise<DeployResult> {
    const payload = this.parseRollbackTaskPayload(asRecord(task.payload))
    const rollbackLog = createContextLogger('agent-devops', {
      taskId: task.id,
      projectId: task.projectId,
      environment: payload.environment,
    })

    const pipeline = await this.resolveDeploymentPipeline(task.projectId, {
      environment: payload.environment,
      provider: payload.provider,
      overrideFrozenWindow: true,
      forceApproval: false,
    })

    const environment = pipeline.environments[payload.environment]
    const rollbackTarget = await this.fetchRollbackTarget(
      task.projectId,
      payload.environment,
      payload.rollbackToDeploymentId,
      payload.excludeDeploymentId,
    )

    if (!rollbackTarget) {
      throw new Error(`No successful ${payload.environment} deployment available for rollback`)
    }

    const startedAt = this.now()

    const rollbackRecord = await prisma.deployment.create({
      data: {
        projectId: task.projectId,
        environment: toDbEnvironment(payload.environment) as never,
        status: 'IN_PROGRESS' as never,
        provider: environment.provider,
        commitSha: rollbackTarget.commitSha ?? undefined,
        commitMessage: `ROLLBACK: ${payload.reason}`,
        branch: rollbackTarget.branch ?? undefined,
        triggeredBy: task.requestedBy,
      },
    })

    try {
      await this.callProviderRollback(environment, rollbackTarget)

      const completedAt = this.now()
      const durationMs = Math.max(0, completedAt.getTime() - startedAt.getTime())
      const rollbackUrl = rollbackTarget.url ?? environment.url

      await prisma.deployment.update({
        where: { id: rollbackRecord.id },
        data: {
          status: 'ROLLED_BACK' as never,
          url: rollbackUrl,
          completedAt,
          durationMs,
          rollbackReason: payload.reason,
          autoRolledBack: payload.automatic,
        },
      })

      await prisma.incident.create({
        data: {
          projectId: task.projectId,
          title: `Rollback executed in ${payload.environment}`,
          description: payload.reason,
          severity: 'HIGH' as never,
          status: 'RESOLVED' as never,
          affectedModules: ['deployment'],
          deploymentId: rollbackRecord.id,
          detectedAt: startedAt,
          resolvedAt: completedAt,
        },
      })

      const deployResult: DeployResult = {
        deploymentId: rollbackRecord.id,
        projectId: task.projectId,
        environment: payload.environment,
        provider: environment.provider,
        status: 'rolled_back',
        startedAt,
        completedAt,
        summary: `Rolled back ${payload.environment} to deployment ${rollbackTarget.id}`,
        stageResults: [],
      }

      if (rollbackUrl) {
        deployResult.url = rollbackUrl
      }

      if (rollbackTarget.commitSha) {
        deployResult.commitSha = rollbackTarget.commitSha
      }

      return deployResult
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      rollbackLog.error({ err }, 'Rollback failed')

      await prisma.deployment.update({
        where: { id: rollbackRecord.id },
        data: {
          status: 'FAILED' as never,
          rollbackReason: message,
          completedAt: this.now(),
          durationMs: Math.max(0, this.now().getTime() - startedAt.getTime()),
        },
      })

      throw err
    }
  }

  /**
   * Analyzes deployment costs for a lookback window.
   */
  async analyzeCosts(projectId: string, lookbackDays = 7): Promise<CostRecord> {
    const boundedLookbackDays = Math.max(1, Math.floor(lookbackDays))
    const periodEnd = this.now()
    const periodStart = new Date(periodEnd.getTime() - boundedLookbackDays * DAY_MS)
    const previousStart = new Date(periodStart.getTime() - boundedLookbackDays * DAY_MS)

    const [currentDeployments, previousDeployments] = await Promise.all([
      prisma.deployment.findMany({
        where: {
          projectId,
          completedAt: { gte: periodStart },
          status: { in: ['SUCCEEDED', 'ROLLED_BACK'] as never[] },
        },
      }),
      prisma.deployment.findMany({
        where: {
          projectId,
          completedAt: { gte: previousStart, lt: periodStart },
          status: { in: ['SUCCEEDED', 'ROLLED_BACK'] as never[] },
        },
      }),
    ])

    const currentCosts = this.aggregateProviderCosts(currentDeployments)
    const previousCosts = this.aggregateProviderCosts(previousDeployments)

    const anomalies: CostAnomaly[] = []
    for (const provider of DEPLOY_PROVIDERS) {
      const previous = previousCosts[provider]
      const current = currentCosts[provider]
      if (previous <= 0) {
        continue
      }
      const changePercent = ((current - previous) / previous) * 100
      if (changePercent > 20) {
        anomalies.push(
          this.buildCostAnomaly(provider, current, previous, changePercent, boundedLookbackDays),
        )
      }
    }

    const total = roundCurrency(
      currentCosts.vercel + currentCosts.railway + currentCosts.fly,
    )

    const costRecord: CostRecord = {
      projectId,
      period: periodEnd,
      breakdown: {
        hosting: total,
        aiApiCalls: 0,
        database: 0,
        storage: 0,
        monitoring: 0,
        thirdPartyServices: 0,
      },
      total,
      projectedMonthly: roundCurrency(total * 4.33),
      anomalies,
    }

    const organizationId = await this.fetchOrganizationId(projectId)
    await prisma.auditLog.create({
      data: {
        projectId,
        organizationId,
        actor: 'agent:devops:cost-analysis',
        actorType: 'agent',
        action: 'deployment.cost_analysis',
        resourceType: 'deployment',
        outcome: 'success',
        metadata: {
          lookbackDays: boundedLookbackDays,
          platformCosts: currentCosts,
          anomalies,
        },
      },
    })

    return costRecord
  }

  /**
   * Evaluates rollback triggers for an already-created deployment.
   */
  async checkAutoRollbackTriggers(
    deploymentId: string,
    projectId: string,
    configOverride?: RollbackConfig,
  ): Promise<boolean> {
    const deployment = await prisma.deployment.findUnique({ where: { id: deploymentId } })
    if (!deployment) {
      throw new Error(`Deployment not found: ${deploymentId}`)
    }

    const provider = parseProvider(deployment.provider)
    if (!provider) {
      throw new Error(`Unsupported deployment provider '${deployment.provider}'`) 
    }

    const config = configOverride ?? DEFAULT_ROLLBACK_CONFIG
    const baseline = await this.fetchPreDeployMetrics(projectId, deployment.startedAt)
    const current = await this.fetchCurrentMetrics(projectId)

    const health = await this.runConsecutiveHealthChecks(
      deployment.url ?? undefined,
      config.healthCheckFailureThreshold,
      config.healthCheckIntervalMs,
    )

    const errorRateTrigger = baseline.errorRate > 0
      ? current.errorRate / baseline.errorRate >= config.errorRateMultiplierThreshold
      : current.errorRate >= 0.05

    const latencyTrigger = baseline.p99LatencyMs > 0
      ? current.p99LatencyMs / baseline.p99LatencyMs >= config.p99LatencyMultiplierThreshold
      : false

    const healthCheckTrigger = !health.healthy

    if (!errorRateTrigger && !latencyTrigger && !healthCheckTrigger) {
      return false
    }

    const reasons: string[] = []
    if (errorRateTrigger) {
      reasons.push(
        `Error rate increased from ${(baseline.errorRate * 100).toFixed(2)}% to ${(current.errorRate * 100).toFixed(2)}%`,
      )
    }
    if (latencyTrigger) {
      reasons.push(
        `p99 latency increased from ${baseline.p99LatencyMs.toFixed(0)}ms to ${current.p99LatencyMs.toFixed(0)}ms`,
      )
    }
    if (healthCheckTrigger) {
      reasons.push(
        `Health checks failed (${health.failures} failures, last status ${health.statusCode})`,
      )
    }

    const reason = reasons.join('; ')

    const stageResult: StageDeployResult = {
      deploymentId: deployment.id,
      projectId,
      environment: fromDbEnvironment(deployment.environment),
      provider,
      status: 'succeeded',
      startedAt: deployment.startedAt,
      completedAt: deployment.completedAt ?? this.now(),
      durationMs: deployment.durationMs ?? 0,
      estimatedCostUsd: 0,
      summary: 'Deployed release under monitoring',
    }

    if (deployment.url) {
      stageResult.url = deployment.url
    }

    if (deployment.commitSha) {
      stageResult.commitSha = deployment.commitSha
    }

    const organizationId = await this.fetchOrganizationId(projectId)
    const autoRollbackTask: AgentTask = {
      id: randomUUID(),
      type: 'rollback',
      priority: 'critical',
      projectId,
      organizationId,
      payload: {
        action: 'rollback',
        environment: stageResult.environment,
        reason,
        provider,
        excludeDeploymentId: deployment.id,
        automatic: true,
      },
      requestedBy: 'system',
      autonomyLevel: 'autonomous',
      createdAt: this.now(),
    }

    await this.executeAutoRollbackForStage(autoRollbackTask, stageResult, reason)
    return true
  }

  private resolveAction(
    task: AgentTask,
    payload: Record<string, unknown>,
  ): DevOpsResult['action'] {
    const payloadAction = readString(payload['action'])
    if (payloadAction === 'rollback') return 'rollback'
    if (payloadAction === 'cost_analysis') return 'cost_analysis'
    if (payloadAction === 'health_check') return 'health_check'

    if (task.type === 'rollback') return 'rollback'
    if (task.type === 'cost_analysis') return 'cost_analysis'
    return 'deploy'
  }

  private parseDeployTaskPayload(payload: Record<string, unknown>): DeployTaskPayload {
    const parsed: DeployTaskPayload = {
      environment: parseEnvironment(payload['environment']) ?? 'production',
      overrideFrozenWindow: readBoolean(payload['overrideFrozenWindow']) ?? false,
      forceApproval: readBoolean(payload['forceApproval']) ?? false,
    }

    const provider = parseProvider(payload['provider'])
    if (provider) parsed.provider = provider

    const commitSha = readString(payload['commitSha'])
    if (commitSha) parsed.commitSha = commitSha

    const commitMessage = readString(payload['commitMessage'])
    if (commitMessage) parsed.commitMessage = commitMessage

    const branch = readString(payload['branch'])
    if (branch) parsed.branch = branch

    const changedFiles = readStringArray(payload['changedFiles'])
    if (changedFiles.length > 0) parsed.changedFiles = changedFiles

    const ciPassing = readBoolean(payload['ciPassing'])
    if (ciPassing !== undefined) parsed.ciPassing = ciPassing

    const ciCoverage = readNumber(payload['ciCoverage'])
    if (ciCoverage !== undefined) parsed.ciCoverage = ciCoverage

    const securityScanPassed = readBoolean(payload['securityScanPassed'])
    if (securityScanPassed !== undefined) parsed.securityScanPassed = securityScanPassed

    const blockedTimeWindows = parseTimeWindows(payload['blockedTimeWindows'])
    if (blockedTimeWindows.length > 0) parsed.blockedTimeWindows = blockedTimeWindows

    const minStagingMinutes = readNumber(payload['minStagingMinutes'])
    if (minStagingMinutes !== undefined) parsed.minStagingMinutes = Math.max(0, minStagingMinutes)

    const maxErrorRateDelta = readNumber(payload['maxErrorRateDelta'])
    if (maxErrorRateDelta !== undefined) {
      parsed.maxErrorRateDelta = Math.max(0, maxErrorRateDelta)
    }

    const confidenceMinScore = readNumber(payload['confidenceMinScore'])
    if (confidenceMinScore !== undefined) {
      parsed.confidenceMinScore = Math.min(100, Math.max(0, confidenceMinScore))
    }

    const rollbackConfig = parseRollbackConfig(payload['rollbackConfig'])
    if (rollbackConfig) parsed.rollbackConfig = rollbackConfig

    const providers = parseProviderConfigMap(payload['providers'])
    if (providers) parsed.providers = providers

    const environments = parseEnvironmentConfigMap(payload['environments'])
    if (environments) parsed.environments = environments

    const dns = parseDnsUpdateConfig(payload['dns'])
    if (dns) parsed.dns = dns

    return parsed
  }

  private parseRollbackTaskPayload(payload: Record<string, unknown>): RollbackTaskPayload {
    const parsed: RollbackTaskPayload = {
      environment: parseEnvironment(payload['environment']) ?? 'production',
      reason: readString(payload['reason']) ?? 'Rollback requested',
      automatic: readBoolean(payload['automatic']) ?? false,
    }

    const provider = parseProvider(payload['provider'])
    if (provider) parsed.provider = provider

    const rollbackToDeploymentId = readString(payload['rollbackToDeploymentId'])
    if (rollbackToDeploymentId) parsed.rollbackToDeploymentId = rollbackToDeploymentId

    const excludeDeploymentId = readString(payload['excludeDeploymentId'])
    if (excludeDeploymentId) parsed.excludeDeploymentId = excludeDeploymentId

    const providers = parseProviderConfigMap(payload['providers'])
    if (providers) parsed.providers = providers

    const environments = parseEnvironmentConfigMap(payload['environments'])
    if (environments) parsed.environments = environments

    return parsed
  }

  private parseCostAnalysisPayload(payload: Record<string, unknown>): CostAnalysisPayload {
    const requestedDays = readNumber(payload['lookbackDays'])
    return {
      lookbackDays:
        requestedDays !== undefined && requestedDays > 0
          ? Math.floor(requestedDays)
          : 7,
    }
  }

  private async resolveDeploymentPipeline(
    projectId: string,
    payload: Pick<
      DeployTaskPayload,
      | 'provider'
      | 'providers'
      | 'environments'
      | 'blockedTimeWindows'
      | 'rollbackConfig'
      | 'minStagingMinutes'
      | 'maxErrorRateDelta'
      | 'confidenceMinScore'
    >,
  ): Promise<DeploymentPipeline> {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      include: { integrations: true },
    })

    if (!project) {
      throw new Error(`Project not found: ${projectId}`)
    }

    const provider =
      payload.provider ??
      parseProvider(project.hostingProvider) ??
      this.providerFromIntegrations(project.integrations)

    if (!provider) {
      throw new Error(
        'No deploy provider configured. Set payload.provider or project hosting integration.',
      )
    }

    const integrationConfig = this.integrationConfigForProvider(
      project.integrations,
      provider,
    )
    const providerOverride = payload.providers?.[provider]

    const environments: Record<DeployEnvironmentName, EnvironmentConfig> = {
      preview: this.buildEnvironmentConfig(
        'preview',
        provider,
        project,
        integrationConfig,
        providerOverride,
        payload.environments?.preview,
      ),
      staging: this.buildEnvironmentConfig(
        'staging',
        provider,
        project,
        integrationConfig,
        providerOverride,
        payload.environments?.staging,
      ),
      production: this.buildEnvironmentConfig(
        'production',
        provider,
        project,
        integrationConfig,
        providerOverride,
        payload.environments?.production,
      ),
    }

    const blockedTimeWindows = normalizeTimeWindows([
      ...DEFAULT_BLOCKED_TIME_WINDOWS,
      ...(payload.blockedTimeWindows ?? []),
    ])

    const rollbackConfig: RollbackConfig = {
      ...DEFAULT_ROLLBACK_CONFIG,
      ...(payload.rollbackConfig ?? {}),
    }

    const promotionGates: PromotionGates = {
      minStagingMinutes:
        payload.minStagingMinutes ?? DEFAULT_PROMOTION_GATES.minStagingMinutes,
      maxErrorRateDelta:
        payload.maxErrorRateDelta ?? DEFAULT_PROMOTION_GATES.maxErrorRateDelta,
      minConfidenceScore:
        payload.confidenceMinScore ?? DEFAULT_PROMOTION_GATES.minConfidenceScore,
    }

    return {
      projectId,
      provider,
      environments,
      blockedTimeWindows,
      rollbackConfig,
      promotionGates,
    }
  }

  private providerFromIntegrations(
    integrations: Array<{ type: string; config: unknown }>,
  ): DeployProvider | undefined {
    const availableTypes = new Set(integrations.map((integration) => integration.type))
    if (availableTypes.has('VERCEL')) return 'vercel'
    if (availableTypes.has('RAILWAY')) return 'railway'
    if (availableTypes.has('FLY')) return 'fly'
    return undefined
  }

  private integrationConfigForProvider(
    integrations: Array<{ type: string; config: unknown }>,
    provider: DeployProvider,
  ): Record<string, unknown> {
    const integrationType = this.integrationTypeForProvider(provider)
    const integration = integrations.find((item) => item.type === integrationType)
    return asRecord(integration?.config)
  }

  private integrationTypeForProvider(provider: DeployProvider): 'VERCEL' | 'RAILWAY' | 'FLY' {
    if (provider === 'vercel') return 'VERCEL'
    if (provider === 'railway') return 'RAILWAY'
    return 'FLY'
  }

  private buildEnvironmentConfig(
    stage: DeployEnvironmentName,
    provider: DeployProvider,
    project: {
      hostingProjectId: string | null
      stagingUrl: string | null
      productionUrl: string | null
    },
    integrationConfig: Record<string, unknown>,
    providerOverride: ProviderConfigOverride | undefined,
    environmentOverride: EnvironmentConfigOverride | undefined,
  ): EnvironmentConfig {
    const stageProjectKey = `${stage}ProjectId`
    const stageEnvKey = `${stage}EnvironmentId`

    const token =
      environmentOverride?.token ??
      providerOverride?.token ??
      readString(integrationConfig['token']) ??
      this.providerTokenFromEnv(provider)

    if (!token) {
      throw new Error(`Missing ${provider} API token for ${stage} environment`)
    }

    const providerProjectId =
      environmentOverride?.providerProjectId ??
      environmentOverride?.projectId ??
      providerOverride?.[stageProjectKey as keyof ProviderConfigOverride] ??
      providerOverride?.projectId ??
      readString(integrationConfig[stageProjectKey]) ??
      readString(integrationConfig['projectId']) ??
      project.hostingProjectId ??
      undefined

    const appName =
      environmentOverride?.appName ??
      providerOverride?.appName ??
      readString(integrationConfig['appName']) ??
      providerProjectId

    const stageDefaultUrl =
      stage === 'production'
        ? project.productionUrl ?? undefined
        : stage === 'staging'
          ? project.stagingUrl ?? undefined
          : undefined

    const url =
      environmentOverride?.url ??
      readString(integrationConfig[`${stage}Url`]) ??
      stageDefaultUrl

    const serviceId =
      environmentOverride?.serviceId ??
      providerOverride?.serviceId ??
      readString(integrationConfig['serviceId'])

    const environmentId =
      environmentOverride?.environmentId ??
      providerOverride?.[stageEnvKey as keyof ProviderConfigOverride] ??
      readString(integrationConfig[stageEnvKey])

    const teamId =
      environmentOverride?.teamId ??
      providerOverride?.teamId ??
      readString(integrationConfig['teamId'])

    const costRateUsdPerMinute =
      environmentOverride?.costRateUsdPerMinute ??
      providerOverride?.costRateUsdPerMinute ??
      readNumber(integrationConfig['costRateUsdPerMinute']) ??
      DEFAULT_PROVIDER_COST_RATES_USD_PER_MINUTE[provider]

    if (provider === 'fly' && !appName) {
      throw new Error(`Missing Fly appName for ${stage} environment`) 
    }

    if (provider === 'railway' && !serviceId) {
      throw new Error(`Missing Railway serviceId for ${stage} environment`) 
    }

    if (provider !== 'fly' && !providerProjectId) {
      throw new Error(`Missing provider project identifier for ${provider}:${stage}`)
    }

    const env: EnvironmentConfig = {
      name: stage,
      provider,
      providerProjectId: providerProjectId ?? appName ?? '',
      token,
      costRateUsdPerMinute,
    }

    if (url) env.url = url
    if (teamId) env.teamId = teamId
    if (serviceId) env.serviceId = serviceId
    if (environmentId) env.environmentId = environmentId
    if (appName) env.appName = appName

    return env
  }

  private providerTokenFromEnv(provider: DeployProvider): string | undefined {
    if (provider === 'vercel') return process.env['VERCEL_TOKEN']
    if (provider === 'railway') return process.env['RAILWAY_TOKEN']
    return process.env['FLY_API_TOKEN']
  }

  private buildStagePlan(target: DeployEnvironmentName): DeployEnvironmentName[] {
    if (target === 'preview') return ['preview']
    if (target === 'staging') return ['preview', 'staging']
    return ['preview', 'staging', 'production']
  }

  private assertAllowedDeploymentWindow(
    at: Date,
    windows: TimeWindow[],
    overrideFrozenWindow: boolean,
  ): void {
    if (overrideFrozenWindow) {
      return
    }

    for (const window of windows) {
      if (isInTimeWindow(at, window)) {
        throw new Error(
          `Production deployment blocked by freeze window (UTC day ${at.getUTCDay()}, hour ${at.getUTCHours()})`,
        )
      }
    }
  }

  private async calculateDeploymentConfidence(
    task: AgentTask,
    payload: Pick<
      DeployTaskPayload,
      | 'commitSha'
      | 'changedFiles'
      | 'ciPassing'
      | 'ciCoverage'
      | 'securityScanPassed'
    >,
  ): Promise<ConfidenceScore> {
    const latestStaging = await prisma.deployment.findFirst({
      where: {
        projectId: task.projectId,
        environment: 'STAGING' as never,
        status: 'SUCCEEDED' as never,
      },
      orderBy: { completedAt: 'desc' },
    })

    const stagingMinutesStable =
      latestStaging?.completedAt
        ? Math.max(
            0,
            Math.floor((this.now().getTime() - latestStaging.completedAt.getTime()) / 60_000),
          )
        : undefined

    const metrics = await this.fetchCurrentMetrics(task.projectId)
    const security = await this.fetchSecuritySignals(task.projectId)

    const inputs: ConfidenceInputs = {
      projectId: task.projectId,
      ciPassing: payload.ciPassing ?? true,
      securityScanPassed: payload.securityScanPassed ?? security.scanPassed,
      deploymentTime: this.now(),
    }

    if (payload.commitSha) inputs.commitSha = payload.commitSha
    if (payload.changedFiles && payload.changedFiles.length > 0) {
      inputs.changedFiles = payload.changedFiles
    }
    if (payload.ciCoverage !== undefined) inputs.ciCoverage = payload.ciCoverage
    if (latestStaging?.completedAt) inputs.stagingDeployedAt = latestStaging.completedAt
    if (stagingMinutesStable !== undefined) {
      inputs.stagingMinutesStable = stagingMinutesStable
    }
    if (metrics.errorRate > 0) inputs.stagingErrorRate = metrics.errorRate
    if (security.criticalVulnerabilities > 0) {
      inputs.criticalVulnerabilities = security.criticalVulnerabilities
    }
    if (security.highVulnerabilities > 0) {
      inputs.highVulnerabilities = security.highVulnerabilities
    }
    if (security.secretsFound) {
      inputs.secretsFound = true
    }

    return this.confidenceEngine.compute(inputs)
  }

  private async assertProductionPromotionGate(
    projectId: string,
    stageResults: StageDeployResult[],
    confidenceScore: ConfidenceScore,
    gates: PromotionGates,
  ): Promise<void> {
    const stagingResult = stageResults.find(
      (stage) => stage.environment === 'staging' && stage.status === 'succeeded',
    )

    if (!stagingResult) {
      throw new Error('Cannot promote to production without successful staging deployment')
    }

    const stagingAgeMinutes = Math.floor(
      (this.now().getTime() - stagingResult.completedAt.getTime()) / 60_000,
    )
    if (stagingAgeMinutes < gates.minStagingMinutes) {
      throw new Error(
        `Staging must be stable for at least ${gates.minStagingMinutes} minutes before production promotion`,
      )
    }

    if (confidenceScore.total < gates.minConfidenceScore) {
      throw new Error(
        `Confidence score ${confidenceScore.total}/100 is below required ${gates.minConfidenceScore}/100`,
      )
    }

    const errorRateDelta = await this.fetchErrorRateDelta(projectId)
    if (errorRateDelta > gates.maxErrorRateDelta) {
      throw new Error(
        `Error rate delta ${errorRateDelta.toFixed(4)} exceeds allowed threshold ${gates.maxErrorRateDelta.toFixed(4)}`,
      )
    }
  }

  private async ensureProductionApproval(
    task: AgentTask,
    payload: Pick<DeployTaskPayload, 'forceApproval'>,
    confidenceScore: ConfidenceScore,
    stageResults: StageDeployResult[],
  ): Promise<void> {
    const existingApproval = await prisma.approvalRequest.findUnique({
      where: { taskId: task.id },
    })

    const requiresApproval =
      payload.forceApproval || confidenceScore.recommendation !== 'auto_deploy'

    if (!requiresApproval) {
      return
    }

    if (existingApproval) {
      if (existingApproval.status === 'APPROVED') {
        return
      }
      if (existingApproval.status === 'PENDING') {
        throw new ApprovalRequiredError(
          'Production deployment is waiting for approval gateway decision',
          confidenceScore,
        )
      }
      throw new Error(
        `Production deployment blocked: approval status is ${existingApproval.status.toLowerCase()}`,
      )
    }

    const previewUrl = stageResults.find((stage) => stage.environment === 'preview')?.url

    await this.approvalGateway.createApproval({
      task,
      title: `Deploy to production (${confidenceScore.total}/100 confidence)`,
      businessImpact:
        'Production release requested. This change affects live users and requires explicit confirmation.',
      technicalDetails: JSON.stringify(
        {
          confidence: confidenceScore,
          rollout: ['preview', 'staging', 'production'],
          riskFactors: confidenceScore.riskFactors,
        },
        null,
        2,
      ).slice(0, 1000),
      confidenceScore,
      riskLevel: this.riskLevelForRecommendation(confidenceScore.recommendation),
      previewUrl,
    })

    throw new ApprovalRequiredError(
      `Approval required for production deployment (confidence ${confidenceScore.total}/100)`,
      confidenceScore,
    )
  }

  private riskLevelForRecommendation(
    recommendation: ConfidenceRecommendation,
  ): 'low' | 'medium' | 'high' | 'critical' {
    if (recommendation === 'auto_deploy') return 'low'
    if (recommendation === 'recommend') return 'medium'
    if (recommendation === 'hold') return 'high'
    return 'critical'
  }

  private async deployEnvironment(
    task: AgentTask,
    environment: EnvironmentConfig,
    payload: Pick<DeployTaskPayload, 'commitSha' | 'commitMessage' | 'branch'>,
    confidenceScore: ConfidenceScore,
  ): Promise<StageDeployResult> {
    const startedAt = this.now()

    const deployment = await prisma.deployment.create({
      data: {
        projectId: task.projectId,
        environment: toDbEnvironment(environment.name) as never,
        status: 'IN_PROGRESS' as never,
        provider: environment.provider,
        commitSha: payload.commitSha,
        commitMessage: payload.commitMessage,
        branch: payload.branch,
        triggeredBy: task.requestedBy,
      },
    })

    try {
      const providerResponse = await this.callProviderDeploy(environment, payload)
      const completedAt = this.now()
      const durationMs = Math.max(0, completedAt.getTime() - startedAt.getTime())
      const resolvedUrl = providerResponse.url ?? environment.url
      const estimatedCostUsd = this.estimateDeploymentCost(
        environment.provider,
        durationMs,
        environment.costRateUsdPerMinute,
      )

      await prisma.deployment.update({
        where: { id: deployment.id },
        data: {
          status: 'SUCCEEDED' as never,
          externalId: providerResponse.externalId,
          url: resolvedUrl,
          completedAt,
          durationMs,
        },
      })

      await this.persistDeploymentCost(
        task,
        deployment.id,
        environment.provider,
        durationMs,
        estimatedCostUsd,
      )

      const stageResult: StageDeployResult = {
        deploymentId: deployment.id,
        projectId: task.projectId,
        environment: environment.name,
        provider: environment.provider,
        status: 'succeeded',
        startedAt,
        completedAt,
        durationMs,
        estimatedCostUsd,
        summary: `Deployed ${environment.name} on ${environment.provider} (${confidenceScore.total}/100 confidence)`,
      }

      if (resolvedUrl) {
        stageResult.url = resolvedUrl
      }

      if (payload.commitSha) {
        stageResult.commitSha = payload.commitSha
      }

      if (providerResponse.externalId) {
        stageResult.externalId = providerResponse.externalId
      }

      return stageResult
    } catch (err) {
      const completedAt = this.now()
      const durationMs = Math.max(0, completedAt.getTime() - startedAt.getTime())
      await this.markDeploymentFailed(deployment.id, completedAt, durationMs, err)
      throw err
    }
  }

  private async markDeploymentFailed(
    deploymentId: string,
    completedAt: Date,
    durationMs: number,
    err: unknown,
  ): Promise<void> {
    const message = err instanceof Error ? err.message : String(err)
    try {
      await prisma.deployment.update({
        where: { id: deploymentId },
        data: {
          status: 'FAILED' as never,
          rollbackReason: message.slice(0, 500),
          completedAt,
          durationMs,
        },
      })
    } catch (updateErr) {
      log.error(
        { deploymentId, err: updateErr },
        'Failed to mark deployment as failed',
      )
    }
  }

  private async monitorPostDeployment(
    task: AgentTask,
    stageResult: StageDeployResult,
    rollbackConfig: RollbackConfig,
  ): Promise<void> {
    const checks = Math.max(
      1,
      Math.floor(
        (rollbackConfig.observationWindowMinutes * 60_000) /
          Math.max(1, rollbackConfig.healthCheckIntervalMs),
      ),
    )

    for (let attempt = 0; attempt < checks; attempt += 1) {
      if (attempt > 0) {
        await this.sleepFn(rollbackConfig.healthCheckIntervalMs)
      }

      const rolledBack = await this.checkAutoRollbackTriggers(
        stageResult.deploymentId,
        task.projectId,
        rollbackConfig,
      )

      if (rolledBack) {
        log.warn(
          {
            taskId: task.id,
            projectId: task.projectId,
            deploymentId: stageResult.deploymentId,
          },
          'Auto-rollback executed during post-deploy monitoring',
        )
        return
      }
    }
  }

  private async executeAutoRollbackForStage(
    task: AgentTask,
    stageResult: StageDeployResult,
    reason: string,
  ): Promise<void> {
    const rollbackTask: AgentTask = {
      id: randomUUID(),
      type: 'rollback',
      priority: 'critical',
      projectId: task.projectId,
      organizationId: task.organizationId,
      payload: {
        action: 'rollback',
        environment: stageResult.environment,
        reason,
        provider: stageResult.provider,
        excludeDeploymentId: stageResult.deploymentId,
        automatic: true,
      },
      requestedBy: 'system',
      autonomyLevel: 'autonomous',
      createdAt: this.now(),
    }

    await this.triggerRollback(rollbackTask)

    await prisma.deployment.update({
      where: { id: stageResult.deploymentId },
      data: {
        status: 'ROLLED_BACK' as never,
        autoRolledBack: true,
        rollbackReason: reason,
      },
    })

    await prisma.incident.create({
      data: {
        projectId: task.projectId,
        title: `Auto-rollback: ${stageResult.environment}`,
        description: reason,
        severity: 'CRITICAL' as never,
        status: 'RESOLVED' as never,
        affectedModules: ['deployment'],
        deploymentId: stageResult.deploymentId,
        detectedAt: this.now(),
        resolvedAt: this.now(),
      },
    })
  }

  private async callProviderDeploy(
    environment: EnvironmentConfig,
    payload: Pick<DeployTaskPayload, 'commitSha' | 'branch'>,
  ): Promise<ProviderDeployResponse> {
    if (environment.provider === 'vercel') {
      return this.deployToVercel(environment, payload)
    }
    if (environment.provider === 'railway') {
      return this.deployToRailway(environment, payload)
    }
    return this.deployToFly(environment, payload)
  }

  private async callProviderRollback(
    environment: EnvironmentConfig,
    targetDeployment: {
      id: string
      externalId: string | null
      commitSha: string | null
      provider: string
    },
  ): Promise<void> {
    if (environment.provider === 'vercel') {
      await this.rollbackOnVercel(environment, targetDeployment)
      return
    }
    if (environment.provider === 'railway') {
      await this.rollbackOnRailway(environment, targetDeployment)
      return
    }
    await this.rollbackOnFly(environment, targetDeployment)
  }

  private async deployToVercel(
    environment: EnvironmentConfig,
    payload: Pick<DeployTaskPayload, 'commitSha' | 'branch'>,
  ): Promise<ProviderDeployResponse> {
    const query = environment.teamId
      ? `?teamId=${encodeURIComponent(environment.teamId)}`
      : ''

    const body: Record<string, unknown> = {
      name: environment.providerProjectId,
      project: environment.providerProjectId,
      target: environment.name === 'production' ? 'production' : 'preview',
      meta: {
        forgeEnvironment: environment.name,
      },
    }

    const ref = payload.branch ?? payload.commitSha
    if (ref) {
      body['gitSource'] = {
        type: 'github',
        ref,
      }
    }

    const response = await this.requestJson<{ id?: string; url?: string }>(
      `https://api.vercel.com/v13/deployments${query}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${environment.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
      'Vercel deploy API',
    )

    return {
      externalId: response.id,
      url: normalizeDeploymentUrl(response.url) ?? environment.url,
    }
  }

  private async deployToRailway(
    environment: EnvironmentConfig,
    payload: Pick<DeployTaskPayload, 'commitSha'>,
  ): Promise<ProviderDeployResponse> {
    if (!environment.serviceId) {
      throw new Error(`Railway serviceId is required for ${environment.name}`)
    }

    const query = `
      mutation ForgeDeploy($projectId: String!, $serviceId: String!, $environmentId: String, $commitSha: String) {
        deploymentCreate(input: {
          projectId: $projectId,
          serviceId: $serviceId,
          environmentId: $environmentId,
          commitSha: $commitSha
        }) {
          id
          url
        }
      }
    `

    const data = await this.requestGraphQl<{
      deploymentCreate?: { id?: string; url?: string }
      serviceInstanceDeploy?: { id?: string; url?: string }
    }>(
      'https://backboard.railway.app/graphql/v2',
      environment.token,
      query,
      {
        projectId: environment.providerProjectId,
        serviceId: environment.serviceId,
        environmentId: environment.environmentId ?? null,
        commitSha: payload.commitSha ?? null,
      },
      'Railway deploy API',
    )

    const deployment = data.deploymentCreate ?? data.serviceInstanceDeploy
    if (!deployment) {
      throw new Error('Railway deploy API returned no deployment payload')
    }

    return {
      externalId: deployment.id,
      url: normalizeDeploymentUrl(deployment.url) ?? environment.url,
    }
  }

  private async deployToFly(
    environment: EnvironmentConfig,
    payload: Pick<DeployTaskPayload, 'commitSha'>,
  ): Promise<ProviderDeployResponse> {
    const appName = environment.appName ?? environment.providerProjectId
    if (!appName) {
      throw new Error(`Fly appName is required for ${environment.name}`)
    }

    const query = `
      mutation ForgeFlyDeploy($appName: String!, $buildTag: String) {
        deployImage(input: {
          appName: $appName,
          strategy: ROLLING,
          imageTag: $buildTag
        }) {
          release {
            id
          }
        }
      }
    `

    const data = await this.requestGraphQl<{
      deployImage?: { release?: { id?: string } }
    }>(
      'https://api.fly.io/graphql',
      environment.token,
      query,
      {
        appName,
        buildTag: payload.commitSha ?? null,
      },
      'Fly deploy API',
    )

    return {
      externalId: data.deployImage?.release?.id,
      url: environment.url ?? `https://${appName}.fly.dev`,
    }
  }

  private async rollbackOnVercel(
    environment: EnvironmentConfig,
    targetDeployment: {
      id: string
      externalId: string | null
    },
  ): Promise<void> {
    if (!targetDeployment.externalId) {
      throw new Error('Cannot rollback on Vercel without target external deployment ID')
    }

    const query = environment.teamId
      ? `?teamId=${encodeURIComponent(environment.teamId)}`
      : ''

    await this.requestJson<Record<string, unknown>>(
      `https://api.vercel.com/v13/deployments/${encodeURIComponent(targetDeployment.externalId)}/promote${query}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${environment.token}`,
          'Content-Type': 'application/json',
        },
      },
      'Vercel rollback API',
    )
  }

  private async rollbackOnRailway(
    environment: EnvironmentConfig,
    targetDeployment: {
      externalId: string | null
    },
  ): Promise<void> {
    if (!targetDeployment.externalId) {
      throw new Error('Cannot rollback on Railway without target external deployment ID')
    }

    const query = `
      mutation ForgeRailwayRollback($deploymentId: String!) {
        rollbackDeployment(id: $deploymentId) {
          id
        }
      }
    `

    await this.requestGraphQl<Record<string, unknown>>(
      'https://backboard.railway.app/graphql/v2',
      environment.token,
      query,
      { deploymentId: targetDeployment.externalId },
      'Railway rollback API',
    )
  }

  private async rollbackOnFly(
    environment: EnvironmentConfig,
    targetDeployment: {
      externalId: string | null
    },
  ): Promise<void> {
    const appName = environment.appName ?? environment.providerProjectId
    if (!appName) {
      throw new Error('Cannot rollback on Fly without appName')
    }

    const query = `
      mutation ForgeFlyRollback($appName: String!, $releaseId: String) {
        rollbackRelease(input: {
          appName: $appName,
          releaseId: $releaseId
        }) {
          release {
            id
          }
        }
      }
    `

    await this.requestGraphQl<Record<string, unknown>>(
      'https://api.fly.io/graphql',
      environment.token,
      query,
      {
        appName,
        releaseId: targetDeployment.externalId,
      },
      'Fly rollback API',
    )
  }

  private async updateDnsRecords(
    projectId: string,
    productionEnvironment: EnvironmentConfig,
    stageResult: StageDeployResult,
    dnsConfig: DnsUpdateConfig,
  ): Promise<void> {
    const provider =
      dnsConfig.provider ??
      (productionEnvironment.provider === 'vercel' ? 'vercel' : 'cloudflare')

    if (provider === 'vercel') {
      await this.updateDnsViaVercel(productionEnvironment, stageResult, dnsConfig)
    } else {
      await this.updateDnsViaCloudflare(dnsConfig)
    }

    const organizationId = await this.fetchOrganizationId(projectId)
    await prisma.auditLog.create({
      data: {
        projectId,
        organizationId,
        actor: 'agent:devops:dns',
        actorType: 'agent',
        action: 'deployment.dns_updated',
        resourceType: 'deployment',
        resourceId: stageResult.deploymentId,
        outcome: 'success',
        metadata: {
          provider,
          records: dnsConfig.records,
        },
      },
    })
  }

  private async updateDnsViaVercel(
    productionEnvironment: EnvironmentConfig,
    stageResult: StageDeployResult,
    dnsConfig: DnsUpdateConfig,
  ): Promise<void> {
    const projectId = dnsConfig.projectId ?? productionEnvironment.providerProjectId
    const token = dnsConfig.token ?? productionEnvironment.token

    if (!projectId) {
      throw new Error('Vercel DNS update requires a projectId')
    }
    if (!token) {
      throw new Error('Vercel DNS update requires a token')
    }

    for (const record of dnsConfig.records) {
      try {
        await this.requestJson<Record<string, unknown>>(
          `https://api.vercel.com/v10/projects/${encodeURIComponent(projectId)}/domains`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ name: record.name }),
          },
          'Vercel DNS update API',
        )
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (!message.toLowerCase().includes('already')) {
          throw err
        }
      }

      if (stageResult.externalId && record.type === 'CNAME') {
        await this.requestJson<Record<string, unknown>>(
          `https://api.vercel.com/v2/deployments/${encodeURIComponent(stageResult.externalId)}/aliases`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ alias: record.name }),
          },
          'Vercel alias update API',
        )
      }
    }
  }

  private async updateDnsViaCloudflare(dnsConfig: DnsUpdateConfig): Promise<void> {
    const token = dnsConfig.token ?? process.env['CLOUDFLARE_API_TOKEN']
    const zoneId = dnsConfig.zoneId

    if (!token) {
      throw new Error('Cloudflare DNS update requires token or CLOUDFLARE_API_TOKEN')
    }

    if (!zoneId) {
      throw new Error('Cloudflare DNS update requires zoneId')
    }

    for (const record of dnsConfig.records) {
      const response = await this.requestJson<{
        success?: boolean
        errors?: Array<{ message?: string }>
      }>(
        `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(zoneId)}/dns_records`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            type: record.type,
            name: record.name,
            content: record.value,
            ttl: record.ttl ?? 1,
            proxied: record.proxied ?? false,
          }),
        },
        'Cloudflare DNS update API',
      )

      if (!response.success) {
        const message =
          response.errors?.map((item) => item.message).filter(Boolean).join('; ') ||
          'Cloudflare API returned success=false'
        throw new Error(message)
      }
    }
  }

  private async runConsecutiveHealthChecks(
    deployUrl: string | undefined,
    failureThreshold: number,
    intervalMs: number,
  ): Promise<HealthCheckResult> {
    if (!deployUrl) {
      return {
        healthy: false,
        statusCode: 0,
        latencyMs: 0,
        checkedAt: this.now(),
        failures: failureThreshold,
      }
    }

    const checks = Math.max(1, failureThreshold)
    let consecutiveFailures = 0
    let totalFailures = 0
    let latest: HealthCheckResult = {
      healthy: true,
      statusCode: 200,
      latencyMs: 0,
      checkedAt: this.now(),
      failures: 0,
    }

    for (let attempt = 0; attempt < checks; attempt += 1) {
      latest = await this.runSingleHealthCheck(deployUrl)
      if (latest.healthy) {
        consecutiveFailures = 0
      } else {
        consecutiveFailures += 1
        totalFailures += 1
      }

      if (consecutiveFailures >= failureThreshold) {
        return {
          ...latest,
          healthy: false,
          failures: totalFailures,
        }
      }

      if (attempt < checks - 1) {
        await this.sleepFn(intervalMs)
      }
    }

    return {
      ...latest,
      healthy: totalFailures === 0,
      failures: totalFailures,
    }
  }

  private async runSingleHealthCheck(baseUrl: string): Promise<HealthCheckResult> {
    const normalizedBase = baseUrl.replace(/\/+$/, '')
    const targets = [
      `${normalizedBase}/health`,
      `${normalizedBase}/api/health`,
      normalizedBase,
    ]

    let lastStatusCode = 0
    let lastLatencyMs = 0

    for (const target of targets) {
      const started = Date.now()
      try {
        const response = await this.fetchWithTimeout(target, {
          method: 'GET',
          headers: { 'User-Agent': 'forge-devops-agent/1.0' },
        })
        const latencyMs = Date.now() - started

        if (response.ok) {
          return {
            healthy: true,
            statusCode: response.status,
            latencyMs,
            checkedAt: this.now(),
            failures: 0,
          }
        }

        lastStatusCode = response.status
        lastLatencyMs = latencyMs
      } catch {
        lastStatusCode = 0
        lastLatencyMs = Date.now() - started
      }
    }

    return {
      healthy: false,
      statusCode: lastStatusCode,
      latencyMs: lastLatencyMs,
      checkedAt: this.now(),
      failures: 1,
    }
  }

  private async fetchPreDeployMetrics(
    projectId: string,
    deployedAt: Date,
  ): Promise<MetricsSnapshot> {
    const baseline = await prisma.projectMetricsSnapshot.findFirst({
      where: {
        projectId,
        capturedAt: { lte: deployedAt },
      },
      orderBy: { capturedAt: 'desc' },
    })

    if (!baseline) {
      return {
        errorRate: 0,
        p99LatencyMs: 0,
        capturedAt: this.now(),
      }
    }

    return {
      errorRate: baseline.errorRate ?? 0,
      p99LatencyMs: baseline.p99Latency ?? 0,
      capturedAt: baseline.capturedAt,
    }
  }

  private async fetchCurrentMetrics(projectId: string): Promise<MetricsSnapshot> {
    const current = await prisma.projectMetricsSnapshot.findFirst({
      where: { projectId },
      orderBy: { capturedAt: 'desc' },
    })

    if (!current) {
      return {
        errorRate: 0,
        p99LatencyMs: 0,
        capturedAt: this.now(),
      }
    }

    return {
      errorRate: current.errorRate ?? 0,
      p99LatencyMs: current.p99Latency ?? 0,
      capturedAt: current.capturedAt,
    }
  }

  private async fetchErrorRateDelta(projectId: string): Promise<number> {
    const snapshots = await prisma.projectMetricsSnapshot.findMany({
      where: { projectId },
      orderBy: { capturedAt: 'desc' },
      take: 2,
    })

    if (snapshots.length < 2) {
      return 0
    }

    const current = snapshots[0]?.errorRate ?? 0
    const previous = snapshots[1]?.errorRate ?? 0
    if (previous <= 0) {
      return current > 0 ? 1 : 0
    }

    return (current - previous) / previous
  }

  private async fetchSecuritySignals(projectId: string): Promise<{
    scanPassed: boolean
    criticalVulnerabilities: number
    highVulnerabilities: number
    secretsFound: boolean
  }> {
    const latestScan = await prisma.securityScan.findFirst({
      where: { projectId },
      orderBy: { startedAt: 'desc' },
    })

    if (!latestScan) {
      return {
        scanPassed: true,
        criticalVulnerabilities: 0,
        highVulnerabilities: 0,
        secretsFound: false,
      }
    }

    const data = asRecord(latestScan.data)
    const findingsCount = asRecord(latestScan.findingsCount)

    const criticalVulnerabilities =
      readNumber(data['critical']) ?? readNumber(findingsCount['critical']) ?? 0
    const highVulnerabilities =
      readNumber(data['high']) ?? readNumber(findingsCount['high']) ?? 0
    const secretsFound =
      (readBoolean(data['secretsFound']) ?? false) ||
      (readNumber(data['secretsCount']) ?? 0) > 0

    const scanPassed =
      latestScan.status === 'COMPLETED' &&
      criticalVulnerabilities === 0 &&
      !secretsFound

    return {
      scanPassed,
      criticalVulnerabilities,
      highVulnerabilities,
      secretsFound,
    }
  }

  private async persistDeploymentCost(
    task: AgentTask,
    deploymentId: string,
    provider: DeployProvider,
    durationMs: number,
    estimatedCostUsd: number,
  ): Promise<void> {
    await prisma.auditLog.create({
      data: {
        projectId: task.projectId,
        organizationId: task.organizationId,
        actor: `agent:devops:${task.id}`,
        actorType: 'agent',
        action: 'deployment.cost',
        resourceType: 'deployment',
        resourceId: deploymentId,
        outcome: 'success',
        durationMs,
        metadata: {
          provider,
          estimatedCostUsd,
          durationMs,
        },
      },
    })
  }

  private estimateDeploymentCost(
    provider: DeployProvider,
    durationMs: number,
    overrideRateUsdPerMinute?: number,
  ): number {
    const ratePerMinute =
      overrideRateUsdPerMinute ?? DEFAULT_PROVIDER_COST_RATES_USD_PER_MINUTE[provider]
    const minutes = Math.max(durationMs, 1000) / 60_000
    return roundCurrency(ratePerMinute * minutes)
  }

  private aggregateProviderCosts(
    deployments: Array<{
      provider: string
      durationMs: number | null
      startedAt: Date
      completedAt: Date | null
    }>,
  ): ProviderCostBreakdown {
    const totals = emptyProviderCosts()

    for (const deployment of deployments) {
      const provider = parseProvider(deployment.provider)
      if (!provider) {
        continue
      }

      const inferredDurationMs =
        deployment.durationMs ??
        (deployment.completedAt
          ? Math.max(0, deployment.completedAt.getTime() - deployment.startedAt.getTime())
          : 0)

      totals[provider] = roundCurrency(
        totals[provider] + this.estimateDeploymentCost(provider, inferredDurationMs),
      )
    }

    return totals
  }

  private buildCostAnomaly(
    provider: DeployProvider,
    current: number,
    previous: number,
    changePercent: number,
    lookbackDays: number,
  ): CostAnomaly {
    return {
      category: `hosting:${provider}`,
      previousAmount: roundCurrency(previous),
      currentAmount: roundCurrency(current),
      changePercent,
      explanation:
        `${provider} deployment costs increased ${changePercent.toFixed(1)}% over the last ` +
        `${lookbackDays} days (${formatUsd(previous)} -> ${formatUsd(current)}).`,
    }
  }

  private async calculatePlatformCosts(
    projectId: string,
    lookbackDays: number,
  ): Promise<ProviderCostBreakdown> {
    const start = new Date(this.now().getTime() - lookbackDays * DAY_MS)
    const deployments = await prisma.deployment.findMany({
      where: {
        projectId,
        completedAt: { gte: start },
        status: { in: ['SUCCEEDED', 'ROLLED_BACK'] as never[] },
      },
    })

    return this.aggregateProviderCosts(deployments)
  }

  private async fetchRollbackTarget(
    projectId: string,
    environment: DeployEnvironmentName,
    rollbackToDeploymentId?: string,
    excludeDeploymentId?: string,
  ): Promise<{
    id: string
    externalId: string | null
    commitSha: string | null
    branch: string | null
    url: string | null
    provider: string
  } | null> {
    if (rollbackToDeploymentId) {
      const explicitTarget = await prisma.deployment.findUnique({
        where: { id: rollbackToDeploymentId },
      })

      if (!explicitTarget) {
        throw new Error(`Rollback target deployment not found: ${rollbackToDeploymentId}`)
      }

      if (explicitTarget.projectId !== projectId) {
        throw new Error('Rollback target belongs to a different project')
      }

      if (explicitTarget.environment !== toDbEnvironment(environment)) {
        throw new Error('Rollback target environment does not match requested rollback')
      }

      if (explicitTarget.status !== 'SUCCEEDED') {
        throw new Error('Rollback target must be a successful deployment')
      }

      return {
        id: explicitTarget.id,
        externalId: explicitTarget.externalId,
        commitSha: explicitTarget.commitSha,
        branch: explicitTarget.branch,
        url: explicitTarget.url,
        provider: explicitTarget.provider,
      }
    }

    const target = await prisma.deployment.findFirst({
      where: {
        projectId,
        environment: toDbEnvironment(environment) as never,
        status: 'SUCCEEDED' as never,
        ...(excludeDeploymentId ? { id: { not: excludeDeploymentId } } : {}),
      },
      orderBy: { completedAt: 'desc' },
    })

    if (!target) {
      return null
    }

    return {
      id: target.id,
      externalId: target.externalId,
      commitSha: target.commitSha,
      branch: target.branch,
      url: target.url,
      provider: target.provider,
    }
  }

  private async fetchOrganizationId(projectId: string): Promise<string> {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { organizationId: true },
    })

    if (!project) {
      throw new Error(`Project not found: ${projectId}`)
    }

    return project.organizationId
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
  ): Promise<Response> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS)

    try {
      return await this.fetchImpl(url, {
        ...init,
        signal: controller.signal,
      })
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`Request timed out after ${API_TIMEOUT_MS}ms: ${url}`)
      }
      throw err
    } finally {
      clearTimeout(timeout)
    }
  }

  private async requestJson<T>(
    url: string,
    init: RequestInit,
    context: string,
  ): Promise<T> {
    const response = await this.fetchWithTimeout(url, init)
    const responseText = await response.text()

    if (!response.ok) {
      throw new Error(
        `${context} failed with status ${response.status}: ${responseText.slice(0, 400)}`,
      )
    }

    if (responseText.trim().length === 0) {
      return {} as T
    }

    try {
      return JSON.parse(responseText) as T
    } catch {
      throw new Error(`${context} returned invalid JSON`) 
    }
  }

  private async requestGraphQl<TData>(
    url: string,
    token: string,
    query: string,
    variables: Record<string, unknown>,
    context: string,
  ): Promise<TData> {
    const response = await this.requestJson<{
      data?: TData
      errors?: Array<{ message?: string }>
    }>(
      url,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query, variables }),
      },
      context,
    )

    if (response.errors && response.errors.length > 0) {
      const message = response.errors
        .map((item) => item.message)
        .filter(Boolean)
        .join('; ')
      throw new Error(`${context} returned GraphQL errors: ${message}`)
    }

    if (!response.data) {
      throw new Error(`${context} returned no data`) 
    }

    return response.data
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null) {
    return value as Record<string, unknown>
  }
  return {}
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value
    .map((item) => readString(item))
    .filter((item): item is string => item !== undefined)
}

function parseProvider(value: unknown): DeployProvider | undefined {
  const normalized = readString(value)?.toLowerCase()
  return normalized && (DEPLOY_PROVIDERS as readonly string[]).includes(normalized)
    ? (normalized as DeployProvider)
    : undefined
}

function parseEnvironment(value: unknown): DeployEnvironmentName | undefined {
  const normalized = readString(value)?.toLowerCase()
  return normalized && (DEPLOY_ENVIRONMENTS as readonly string[]).includes(normalized)
    ? (normalized as DeployEnvironmentName)
    : undefined
}

function parseProviderConfigMap(
  value: unknown,
): Partial<Record<DeployProvider, ProviderConfigOverride>> | undefined {
  const root = asRecord(value)
  const parsed: Partial<Record<DeployProvider, ProviderConfigOverride>> = {}

  for (const provider of DEPLOY_PROVIDERS) {
    const source = asRecord(root[provider])
    if (Object.keys(source).length === 0) {
      continue
    }

    const config: ProviderConfigOverride = {}
    const token = readString(source['token'])
    if (token) config.token = token
    const projectId = readString(source['projectId'])
    if (projectId) config.projectId = projectId
    const previewProjectId = readString(source['previewProjectId'])
    if (previewProjectId) config.previewProjectId = previewProjectId
    const stagingProjectId = readString(source['stagingProjectId'])
    if (stagingProjectId) config.stagingProjectId = stagingProjectId
    const productionProjectId = readString(source['productionProjectId'])
    if (productionProjectId) config.productionProjectId = productionProjectId
    const teamId = readString(source['teamId'])
    if (teamId) config.teamId = teamId
    const serviceId = readString(source['serviceId'])
    if (serviceId) config.serviceId = serviceId
    const previewEnvironmentId = readString(source['previewEnvironmentId'])
    if (previewEnvironmentId) config.previewEnvironmentId = previewEnvironmentId
    const stagingEnvironmentId = readString(source['stagingEnvironmentId'])
    if (stagingEnvironmentId) config.stagingEnvironmentId = stagingEnvironmentId
    const productionEnvironmentId = readString(source['productionEnvironmentId'])
    if (productionEnvironmentId) config.productionEnvironmentId = productionEnvironmentId
    const appName = readString(source['appName'])
    if (appName) config.appName = appName
    const costRate = readNumber(source['costRateUsdPerMinute'])
    if (costRate !== undefined) config.costRateUsdPerMinute = costRate

    parsed[provider] = config
  }

  return Object.keys(parsed).length > 0 ? parsed : undefined
}

function parseEnvironmentConfigMap(
  value: unknown,
): Partial<Record<DeployEnvironmentName, EnvironmentConfigOverride>> | undefined {
  const root = asRecord(value)
  const parsed: Partial<Record<DeployEnvironmentName, EnvironmentConfigOverride>> = {}

  for (const stage of DEPLOY_ENVIRONMENTS) {
    const source = asRecord(root[stage])
    if (Object.keys(source).length === 0) {
      continue
    }

    const config: EnvironmentConfigOverride = {}
    const token = readString(source['token'])
    if (token) config.token = token
    const projectId = readString(source['projectId'])
    if (projectId) config.projectId = projectId
    const providerProjectId = readString(source['providerProjectId'])
    if (providerProjectId) config.providerProjectId = providerProjectId
    const teamId = readString(source['teamId'])
    if (teamId) config.teamId = teamId
    const serviceId = readString(source['serviceId'])
    if (serviceId) config.serviceId = serviceId
    const environmentId = readString(source['environmentId'])
    if (environmentId) config.environmentId = environmentId
    const appName = readString(source['appName'])
    if (appName) config.appName = appName
    const url = readString(source['url'])
    if (url) config.url = url
    const costRate = readNumber(source['costRateUsdPerMinute'])
    if (costRate !== undefined) config.costRateUsdPerMinute = costRate

    parsed[stage] = config
  }

  return Object.keys(parsed).length > 0 ? parsed : undefined
}

function parseRollbackConfig(value: unknown): Partial<RollbackConfig> | undefined {
  const source = asRecord(value)
  if (Object.keys(source).length === 0) {
    return undefined
  }

  const config: Partial<RollbackConfig> = {}
  const errorRateMultiplierThreshold = readNumber(source['errorRateMultiplierThreshold'])
  if (errorRateMultiplierThreshold !== undefined) {
    config.errorRateMultiplierThreshold = errorRateMultiplierThreshold
  }
  const p99LatencyMultiplierThreshold = readNumber(source['p99LatencyMultiplierThreshold'])
  if (p99LatencyMultiplierThreshold !== undefined) {
    config.p99LatencyMultiplierThreshold = p99LatencyMultiplierThreshold
  }
  const healthCheckFailureThreshold = readNumber(source['healthCheckFailureThreshold'])
  if (healthCheckFailureThreshold !== undefined) {
    config.healthCheckFailureThreshold = Math.max(1, Math.floor(healthCheckFailureThreshold))
  }
  const observationWindowMinutes = readNumber(source['observationWindowMinutes'])
  if (observationWindowMinutes !== undefined) {
    config.observationWindowMinutes = Math.max(1, observationWindowMinutes)
  }
  const healthCheckIntervalMs = readNumber(source['healthCheckIntervalMs'])
  if (healthCheckIntervalMs !== undefined) {
    config.healthCheckIntervalMs = Math.max(1000, healthCheckIntervalMs)
  }

  return Object.keys(config).length > 0 ? config : undefined
}

function parseTimeWindows(value: unknown): TimeWindow[] {
  if (!Array.isArray(value)) {
    return []
  }

  const parsed: TimeWindow[] = []

  for (const item of value) {
    const source = asRecord(item)
    const startHour = readNumber(source['startHour'])
    const endHour = readNumber(source['endHour'])
    if (startHour === undefined || endHour === undefined) {
      continue
    }
    if (startHour < 0 || startHour > 24 || endHour < 0 || endHour > 24 || endHour <= startHour) {
      continue
    }

    let dayOfWeek: number[] | undefined
    if (Array.isArray(source['dayOfWeek'])) {
      const rawDays = source['dayOfWeek']
        .map((day) => readNumber(day))
        .filter((day): day is number => day !== undefined)
        .map((day) => Math.floor(day))
        .filter((day) => day >= 0 && day <= 6)
      if (rawDays.length > 0) {
        dayOfWeek = Array.from(new Set(rawDays))
      }
    }

    const window: TimeWindow = {
      startHour,
      endHour,
    }
    if (dayOfWeek) {
      window.dayOfWeek = dayOfWeek
    }
    parsed.push(window)
  }

  return parsed
}

function parseDnsUpdateConfig(value: unknown): DnsUpdateConfig | undefined {
  const source = asRecord(value)
  const recordsInput = source['records']
  if (!Array.isArray(recordsInput) || recordsInput.length === 0) {
    return undefined
  }

  const records: DnsRecordChange[] = []
  for (const recordInput of recordsInput) {
    const record = asRecord(recordInput)
    const type = readString(record['type'])?.toUpperCase()
    if (type !== 'A' && type !== 'AAAA' && type !== 'CNAME') {
      continue
    }

    const name = readString(record['name'])
    const valueString = readString(record['value'])
    if (!name || !valueString) {
      continue
    }

    const parsedRecord: DnsRecordChange = {
      type,
      name,
      value: valueString,
    }

    const ttl = readNumber(record['ttl'])
    if (ttl !== undefined) {
      parsedRecord.ttl = Math.max(1, Math.floor(ttl))
    }

    const proxied = readBoolean(record['proxied'])
    if (proxied !== undefined) {
      parsedRecord.proxied = proxied
    }

    records.push(parsedRecord)
  }

  if (records.length === 0) {
    return undefined
  }

  const parsedConfig: DnsUpdateConfig = { records }

  const provider = readString(source['provider'])?.toLowerCase()
  if (provider === 'vercel' || provider === 'cloudflare') {
    parsedConfig.provider = provider
  }

  const token = readString(source['token'])
  if (token) {
    parsedConfig.token = token
  }

  const zoneId = readString(source['zoneId'])
  if (zoneId) {
    parsedConfig.zoneId = zoneId
  }

  const projectId = readString(source['projectId'])
  if (projectId) {
    parsedConfig.projectId = projectId
  }

  return parsedConfig
}

function toDbEnvironment(environment: DeployEnvironmentName): 'PREVIEW' | 'STAGING' | 'PRODUCTION' {
  if (environment === 'preview') return 'PREVIEW'
  if (environment === 'staging') return 'STAGING'
  return 'PRODUCTION'
}

function fromDbEnvironment(environment: string): DeployEnvironmentName {
  if (environment === 'PREVIEW') return 'preview'
  if (environment === 'STAGING') return 'staging'
  return 'production'
}

function normalizeDeploymentUrl(url: string | undefined): string | undefined {
  if (!url) return undefined
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return url
  }
  return `https://${url}`
}

function isInTimeWindow(at: Date, window: TimeWindow): boolean {
  const day = at.getUTCDay()
  const hour = at.getUTCHours()
  const dayMatches = !window.dayOfWeek || window.dayOfWeek.includes(day)
  const hourMatches = hour >= window.startHour && hour < window.endHour
  return dayMatches && hourMatches
}

function normalizeTimeWindows(windows: TimeWindow[]): TimeWindow[] {
  const deduped = new Map<string, TimeWindow>()
  for (const window of windows) {
    const key = JSON.stringify({
      dayOfWeek: window.dayOfWeek ?? null,
      startHour: window.startHour,
      endHour: window.endHour,
    })
    deduped.set(key, window)
  }
  return Array.from(deduped.values())
}

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100
}

function formatUsd(value: number): string {
  return `$${roundCurrency(value).toFixed(2)}`
}

function emptyProviderCosts(): ProviderCostBreakdown {
  return {
    vercel: 0,
    railway: 0,
    fly: 0,
  }
}

/** Singleton DevOps agent instance used by the orchestrator workers. */
export const devOpsAgent = new DevOpsAgent()
