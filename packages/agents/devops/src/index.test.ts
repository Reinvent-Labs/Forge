import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentTask, ConfidenceScore } from '@forge/shared'

vi.mock('@forge/shared', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  }),
  createContextLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))

vi.mock('@forge/database', () => ({
  prisma: {
    project: {
      findUnique: vi.fn(),
    },
    deployment: {
      create: vi.fn(),
      update: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    projectMetricsSnapshot: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    securityScan: {
      findFirst: vi.fn(),
    },
    approvalRequest: {
      findUnique: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
    incident: {
      create: vi.fn(),
    },
  },
}))

import { DevOpsAgent } from './index'
import type { EnvironmentConfig, RollbackConfig, StageDeployResult } from './index'
import { prisma } from '@forge/database'

const PROJECT_ID = '11111111-1111-1111-1111-111111111111'
const ORG_ID = '22222222-2222-2222-2222-222222222222'

interface PrivateDevOpsAgent {
  deployEnvironment: (...args: any[]) => Promise<StageDeployResult>
  runConsecutiveHealthChecks: (...args: any[]) => Promise<{
    healthy: boolean
    statusCode: number
    latencyMs: number
    checkedAt: Date
    failures: number
  }>
  monitorPostDeployment: (...args: any[]) => Promise<void>
  updateDnsRecords: (...args: any[]) => Promise<void>
  callProviderDeploy: (...args: any[]) => Promise<{ externalId?: string; url?: string }>
  persistDeploymentCost: (...args: any[]) => Promise<void>
  executeAutoRollbackForStage: (...args: any[]) => Promise<void>
}

function priv(agent: DevOpsAgent): PrivateDevOpsAgent {
  return agent as unknown as PrivateDevOpsAgent
}

function makeConfidence(
  recommendation: ConfidenceScore['recommendation'] = 'auto_deploy',
  total = 92,
): ConfidenceScore {
  return {
    total,
    breakdown: {
      testCoverage: 18,
      moduleStability: 14,
      ciPassing: 20,
      stagingStability: 18,
      securityClean: 14,
      deployTiming: 8,
    },
    recommendation,
    humanReadableSummary: `Score ${total}/100`,
    riskFactors: recommendation === 'auto_deploy' ? [] : ['Approval recommended'],
  }
}

function makeTask(payload: Record<string, unknown>): AgentTask {
  return {
    id: '33333333-3333-3333-3333-333333333333',
    type: 'deploy',
    priority: 'high',
    projectId: PROJECT_ID,
    organizationId: ORG_ID,
    payload,
    requestedBy: 'system',
    autonomyLevel: 'autonomous',
    createdAt: new Date('2026-03-24T10:00:00Z'),
  }
}

describe('DevOpsAgent', () => {
  let confidenceEngine: { compute: ReturnType<typeof vi.fn> }
  let approvalGateway: { createApproval: ReturnType<typeof vi.fn> }
  let fetchMock: ReturnType<typeof vi.fn>
  let agent: DevOpsAgent

  beforeEach(() => {
    vi.clearAllMocks()

    confidenceEngine = {
      compute: vi.fn().mockResolvedValue(makeConfidence('auto_deploy', 92)),
    }

    approvalGateway = {
      createApproval: vi.fn().mockResolvedValue({ id: 'approval-1' }),
    }

    fetchMock = vi.fn()

    agent = new DevOpsAgent({
      confidenceEngine: confidenceEngine as never,
      approvalGateway: approvalGateway as never,
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => new Date('2026-03-24T10:00:00Z'),
      sleepFn: async () => undefined,
    })

    vi.mocked(prisma.project.findUnique).mockResolvedValue({
      id: PROJECT_ID,
      organizationId: ORG_ID,
      hostingProvider: 'vercel',
      hostingProjectId: 'vercel-project-id',
      stagingUrl: 'https://staging.example.com',
      productionUrl: 'https://app.example.com',
      integrations: [
        {
          type: 'VERCEL',
          config: {
            token: 'vercel-token',
            projectId: 'vercel-project-id',
          },
        },
      ],
    } as never)

    vi.mocked(prisma.deployment.create).mockResolvedValue({
      id: 'deployment-1',
      startedAt: new Date('2026-03-24T10:00:00Z'),
    } as never)

    vi.mocked(prisma.deployment.update).mockResolvedValue({
      id: 'deployment-1',
      status: 'SUCCEEDED',
    } as never)

    vi.mocked(prisma.deployment.findFirst).mockResolvedValue({
      id: 'staging-success-1',
      projectId: PROJECT_ID,
      environment: 'STAGING',
      status: 'SUCCEEDED',
      provider: 'vercel',
      externalId: 'vercel-ext-1',
      commitSha: 'abc123',
      commitMessage: 'deploy',
      branch: 'main',
      triggeredBy: 'system',
      url: 'https://staging.example.com',
      autoRolledBack: false,
      rollbackReason: null,
      startedAt: new Date('2026-03-24T09:40:00Z'),
      completedAt: new Date('2026-03-24T09:55:00Z'),
      durationMs: 900000,
    } as never)

    vi.mocked(prisma.deployment.findUnique).mockResolvedValue({
      id: 'deployment-1',
      projectId: PROJECT_ID,
      environment: 'PRODUCTION',
      status: 'SUCCEEDED',
      provider: 'vercel',
      externalId: 'vercel-prod-1',
      commitSha: 'abc123',
      commitMessage: 'deploy prod',
      branch: 'main',
      triggeredBy: 'system',
      url: 'https://app.example.com',
      autoRolledBack: false,
      rollbackReason: null,
      startedAt: new Date('2026-03-24T10:00:00Z'),
      completedAt: new Date('2026-03-24T10:05:00Z'),
      durationMs: 300000,
    } as never)

    vi.mocked(prisma.deployment.findMany).mockResolvedValue([])

    vi.mocked(prisma.projectMetricsSnapshot.findFirst).mockResolvedValue({
      projectId: PROJECT_ID,
      errorRate: 0.01,
      p99Latency: 120,
      capturedAt: new Date('2026-03-24T09:58:00Z'),
    } as never)

    vi.mocked(prisma.projectMetricsSnapshot.findMany).mockResolvedValue([])
    vi.mocked(prisma.securityScan.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.approvalRequest.findUnique).mockResolvedValue(null)
    vi.mocked(prisma.auditLog.create).mockResolvedValue({ id: 'audit-1' } as never)
    vi.mocked(prisma.incident.create).mockResolvedValue({ id: 'incident-1' } as never)
  })

  it('blocks production deploys in forbidden windows without override', async () => {
    const saturdayAgent = new DevOpsAgent({
      confidenceEngine: confidenceEngine as never,
      approvalGateway: approvalGateway as never,
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => new Date('2026-03-28T16:30:00Z'),
      sleepFn: async () => undefined,
    })

    const deploySpy = vi.spyOn(priv(saturdayAgent), 'deployEnvironment')

    const result = await saturdayAgent.handleTask(
      makeTask({ action: 'deploy', environment: 'production' }),
    )

    expect(result.success).toBe(false)
    expect(result.error).toContain('blocked')
    expect(deploySpy).not.toHaveBeenCalled()
  })

  it('deploys through preview, staging, then production for production target', async () => {
    const deployedStages: string[] = []

    vi.spyOn(priv(agent), 'deployEnvironment').mockImplementation(
      async (_task: AgentTask, environment: EnvironmentConfig) => {
        deployedStages.push(environment.name)
        return {
          deploymentId: `deployment-${environment.name}`,
          projectId: PROJECT_ID,
          environment: environment.name,
          provider: environment.provider,
          status: 'succeeded',
          startedAt: new Date('2026-03-24T10:00:00Z'),
          completedAt: new Date('2026-03-24T10:01:00Z'),
          durationMs: 60_000,
          estimatedCostUsd: 0.03,
          summary: `Deployed ${environment.name}`,
          url: `https://${environment.name}.example.com`,
          externalId: `ext-${environment.name}`,
        }
      },
    )

    vi.spyOn(priv(agent), 'runConsecutiveHealthChecks').mockResolvedValue({
      healthy: true,
      statusCode: 200,
      latencyMs: 40,
      checkedAt: new Date('2026-03-24T10:02:00Z'),
      failures: 0,
    })

    vi.spyOn(priv(agent), 'monitorPostDeployment').mockResolvedValue()
    const dnsSpy = vi.spyOn(priv(agent), 'updateDnsRecords').mockResolvedValue()

    const result = await agent.triggerDeploy(
      makeTask({
        action: 'deploy',
        environment: 'production',
        dns: {
          provider: 'cloudflare',
          zoneId: 'zone-1',
          token: 'cf-token',
          records: [
            {
              type: 'CNAME',
              name: 'app.example.com',
              value: 'target.example.com',
            },
          ],
        },
      }),
    )

    expect(deployedStages).toEqual(['preview', 'staging', 'production'])
    expect(result.stageResults).toHaveLength(3)
    expect(dnsSpy).toHaveBeenCalledTimes(1)
    expect(result.dnsUpdated).toBe(true)
  })

  it('requests approval for production deploy when confidence is not auto_deploy', async () => {
    confidenceEngine.compute.mockResolvedValue(makeConfidence('recommend', 72))
    vi.mocked(prisma.approvalRequest.findUnique).mockResolvedValue(null)

    const deploySpy = vi.spyOn(priv(agent), 'deployEnvironment')

    const result = await agent.handleTask(
      makeTask({ action: 'deploy', environment: 'production' }),
    )

    expect(result.success).toBe(false)
    expect(result.approvalRequested).toBe(true)
    expect(approvalGateway.createApproval).toHaveBeenCalledTimes(1)
    expect(deploySpy).not.toHaveBeenCalled()
  })

  it('fails deployment when health checks fail', async () => {
    vi.spyOn(priv(agent), 'deployEnvironment').mockResolvedValue({
      deploymentId: 'deployment-preview',
      projectId: PROJECT_ID,
      environment: 'preview',
      provider: 'vercel',
      status: 'succeeded',
      startedAt: new Date('2026-03-24T10:00:00Z'),
      completedAt: new Date('2026-03-24T10:01:00Z'),
      durationMs: 60_000,
      estimatedCostUsd: 0.02,
      summary: 'Preview deployed',
      url: 'https://preview.example.com',
      externalId: 'preview-ext',
    })

    vi.spyOn(priv(agent), 'runConsecutiveHealthChecks').mockResolvedValue({
      healthy: false,
      statusCode: 500,
      latencyMs: 150,
      checkedAt: new Date('2026-03-24T10:02:00Z'),
      failures: 3,
    })

    const result = await agent.handleTask(
      makeTask({ action: 'deploy', environment: 'preview' }),
    )

    expect(result.success).toBe(false)
    expect(result.error).toContain('health checks')
  })

  it('triggers auto-rollback when error rate degrades past threshold', async () => {
    vi.mocked(prisma.deployment.findUnique).mockResolvedValue({
      id: 'deployment-prod-1',
      projectId: PROJECT_ID,
      environment: 'PRODUCTION',
      status: 'SUCCEEDED',
      provider: 'vercel',
      externalId: 'vercel-prod-1',
      commitSha: 'abc123',
      commitMessage: 'deploy prod',
      branch: 'main',
      triggeredBy: 'system',
      url: 'https://app.example.com',
      autoRolledBack: false,
      rollbackReason: null,
      startedAt: new Date('2026-03-24T10:00:00Z'),
      completedAt: new Date('2026-03-24T10:05:00Z'),
      durationMs: 300000,
    } as never)

    vi.mocked(prisma.projectMetricsSnapshot.findFirst).mockImplementation(
      async (args: { where?: Record<string, unknown> }) => {
        if (args.where && 'capturedAt' in args.where) {
          return {
            projectId: PROJECT_ID,
            errorRate: 0.01,
            p99Latency: 120,
            capturedAt: new Date('2026-03-24T09:59:00Z'),
          } as never
        }

        return {
          projectId: PROJECT_ID,
          errorRate: 0.03,
          p99Latency: 140,
          capturedAt: new Date('2026-03-24T10:03:00Z'),
        } as never
      },
    )

    vi.spyOn(priv(agent), 'runConsecutiveHealthChecks').mockResolvedValue({
      healthy: true,
      statusCode: 200,
      latencyMs: 42,
      checkedAt: new Date('2026-03-24T10:03:30Z'),
      failures: 0,
    })

    const rollbackSpy = vi
      .spyOn(priv(agent), 'executeAutoRollbackForStage')
      .mockResolvedValue()

    const rollbackConfig: RollbackConfig = {
      errorRateMultiplierThreshold: 1.5,
      p99LatencyMultiplierThreshold: 2.0,
      healthCheckFailureThreshold: 3,
      observationWindowMinutes: 10,
      healthCheckIntervalMs: 1000,
    }

    const triggered = await agent.checkAutoRollbackTriggers(
      'deployment-prod-1',
      PROJECT_ID,
      rollbackConfig,
    )

    expect(triggered).toBe(true)
    expect(rollbackSpy).toHaveBeenCalledTimes(1)
  })

  it('records deployment duration and cost for each stage deployment', async () => {
    const callProviderSpy = vi
      .spyOn(priv(agent), 'callProviderDeploy')
      .mockResolvedValue({
        externalId: 'vercel-deployment-ext',
        url: 'https://preview.example.com',
      })

    const persistCostSpy = vi.spyOn(priv(agent), 'persistDeploymentCost')

    const stageResult = await priv(agent).deployEnvironment(
      makeTask({ action: 'deploy', environment: 'preview', commitSha: 'abc123' }),
      {
        name: 'preview',
        provider: 'vercel',
        providerProjectId: 'vercel-project-id',
        token: 'vercel-token',
        costRateUsdPerMinute: 0.024,
      },
      {
        commitSha: 'abc123',
        commitMessage: 'preview rollout',
        branch: 'main',
      },
      makeConfidence('auto_deploy', 90),
    )

    expect(callProviderSpy).toHaveBeenCalledTimes(1)
    expect(persistCostSpy).toHaveBeenCalledTimes(1)
    expect(stageResult.durationMs).toBeGreaterThanOrEqual(0)
    expect(stageResult.estimatedCostUsd).toBeGreaterThan(0)

    expect(prisma.deployment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'SUCCEEDED',
          durationMs: expect.any(Number),
        }),
      }),
    )
  })
})
