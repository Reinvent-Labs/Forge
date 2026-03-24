import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentTask } from '@forge/shared'

const testMocks = vi.hoisted(() => ({
  projectIntegrationFindMany: vi.fn(),
  projectMetricsCreate: vi.fn(),
  auditLogCreate: vi.fn(),
  incidentCreate: vi.fn(),
  agentTaskCreate: vi.fn(),
  anthropicCreate: vi.fn(),
}))

vi.mock('@forge/database', () => ({
  prisma: {
    projectIntegration: {
      findMany: testMocks.projectIntegrationFindMany,
    },
    projectMetricsSnapshot: {
      create: testMocks.projectMetricsCreate,
    },
    auditLog: {
      create: testMocks.auditLogCreate,
    },
    incident: {
      create: testMocks.incidentCreate,
    },
    agentTask: {
      create: testMocks.agentTaskCreate,
    },
  },
}))

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: {
      create: testMocks.anthropicCreate,
    },
  })),
}))

vi.mock('@forge/shared', () => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  }
  logger.child.mockReturnValue(logger)

  return {
    createLogger: () => logger,
    normalizeErrorFingerprint: (input: string) => input.toLowerCase().replace(/\s+/g, ' ').trim(),
  }
})

import WatcherAgent from './index'

function createJsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      ...(headers ?? {}),
    },
  })
}

function createRedisMock() {
  const state = new Map<string, string>()

  return {
    state,
    client: {
      get: vi.fn(async (key: string) => state.get(key) ?? null),
      set: vi.fn(async (key: string, value: string, ..._rest: Array<string | number>) => {
        state.set(key, value)
        return 'OK'
      }),
    },
  }
}

function createTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: '3b77595f-7f5c-418a-bec5-8d8e2c247b17',
    type: 'analyze_logs',
    priority: 'high',
    projectId: 'c3f81148-89fd-4e89-9f04-1d5dc1cb4652',
    organizationId: '60b03439-cf63-4ff6-9ea5-1f7e10ee5277',
    payload: {},
    requestedBy: 'system',
    autonomyLevel: 'semi',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  } as AgentTask
}

function baselineKey(projectId: string, metric: 'error_rate' | 'latency_p95' | 'latency_p99'): string {
  return `forge:watcher:baseline:${projectId}:${metric}`
}

function seedBaseline(
  state: Map<string, string>,
  projectId: string,
  metric: 'error_rate' | 'latency_p95' | 'latency_p99',
  mean: number,
  stdDev: number,
  sampleCount: number,
) {
  const m2 = stdDev * stdDev * Math.max(sampleCount - 1, 0)
  state.set(
    baselineKey(projectId, metric),
    JSON.stringify({
      mean,
      stdDev,
      sampleCount,
      m2,
      updatedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
    }),
  )
}

describe('WatcherAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    testMocks.projectIntegrationFindMany.mockResolvedValue([])
    testMocks.projectMetricsCreate.mockResolvedValue({ id: 'snapshot-1' })
    testMocks.auditLogCreate.mockResolvedValue({ id: 'audit-1' })
    testMocks.incidentCreate.mockResolvedValue({ id: 'incident-1' })
    testMocks.agentTaskCreate.mockResolvedValue({ id: 'task-1' })
    testMocks.anthropicCreate.mockResolvedValue({ content: [{ type: 'text', text: '[]' }] })
  })

  it('fetches logs from Vercel, Railway, and Fly and normalizes them', async () => {
    const now = new Date('2026-01-01T12:00:00.000Z')
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input)

      if (url.includes('api.vercel.com')) {
        return createJsonResponse({
          logs: [
            {
              id: 'vercel-1',
              timestamp: now.toISOString(),
              level: 'info',
              message: 'GET /health status=200 25ms',
            },
          ],
        })
      }

      if (url.includes('railway.app')) {
        return createJsonResponse({
          data: {
            project: {
              logs: [
                {
                  id: 'railway-1',
                  timestamp: now.toISOString(),
                  severity: 'info',
                  message: 'Worker heartbeat ok',
                },
              ],
            },
          },
        })
      }

      if (url.includes('api.fly.io')) {
        return createJsonResponse({
          data: {
            app: {
              logs: {
                nodes: [
                  {
                    id: 'fly-1',
                    timestamp: now.toISOString(),
                    level: 'info',
                    message: 'Request served in 41ms',
                  },
                ],
              },
            },
          },
        })
      }

      return createJsonResponse({}, 404)
    })

    const { client: redisClient } = createRedisMock()
    const eventBus = { publishEvent: vi.fn().mockResolvedValue(undefined) }

    const agent = new WatcherAgent({
      redis: redisClient as never,
      eventBus,
      fetchImplementation: fetchMock as unknown as typeof fetch,
      now: () => now,
      config: { minBaselineSamples: 999 },
    })

    const result = await agent.handleTask(
      createTask({
        payload: {
          retentionWindowMinutes: 30,
          sources: [
            { provider: 'vercel', token: 'token-v', projectId: 'vercel-project' },
            { provider: 'railway', token: 'token-r', projectId: 'railway-project' },
            { provider: 'fly', token: 'token-f', appName: 'fly-app' },
          ],
        },
      }),
    )

    expect(result.success).toBe(true)
    expect(result.sourcesChecked).toEqual(['vercel', 'railway', 'fly'])
    expect(result.logsFetched).toBe(3)
    expect(result.normalizedLogs).toBe(3)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('detects anomaly spikes, stores alert history, emits events, and triggers Fixer for critical alerts', async () => {
    const now = new Date('2026-01-01T12:00:00.000Z')
    const { client: redisClient, state } = createRedisMock()
    const eventBus = { publishEvent: vi.fn().mockResolvedValue(undefined) }

    const projectId = 'c3f81148-89fd-4e89-9f04-1d5dc1cb4652'
    seedBaseline(state, projectId, 'error_rate', 0.02, 0.01, 30)
    seedBaseline(state, projectId, 'latency_p95', 200, 30, 30)
    seedBaseline(state, projectId, 'latency_p99', 300, 40, 30)

    const noisyLogs = Array.from({ length: 20 }, (_, index) => ({
      id: `err-${index}`,
      timestamp: now.toISOString(),
      level: 'error',
      message: `Unhandled exception in checkout flow status=500 ${1400 + index}ms`,
      statusCode: 500,
      latencyMs: 1400 + index,
    }))

    const fetchMock = vi.fn(async () => createJsonResponse({ logs: noisyLogs }))

    const agent = new WatcherAgent({
      redis: redisClient as never,
      eventBus,
      fetchImplementation: fetchMock as unknown as typeof fetch,
      now: () => now,
    })

    const result = await agent.handleTask(
      createTask({
        payload: {
          retentionWindowMinutes: 30,
          sources: [{ provider: 'vercel', token: 'token-v', projectId: 'vercel-project' }],
        },
      }),
    )

    expect(result.success).toBe(true)
    expect(result.anomaliesDetected).toBeGreaterThan(0)
    expect(result.criticalAlerts).toBeGreaterThan(0)
    expect(testMocks.auditLogCreate).toHaveBeenCalled()
    expect(eventBus.publishEvent).toHaveBeenCalled()
    expect(testMocks.agentTaskCreate).toHaveBeenCalled()
  })

  it('retries provider calls on HTTP 429 and respects Retry-After delay', async () => {
    const now = new Date('2026-01-01T12:00:00.000Z')
    const { client: redisClient } = createRedisMock()
    const sleepMock = vi.fn(async (_ms: number) => undefined)

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(createJsonResponse({ message: 'rate limited' }, 429, { 'retry-after': '1' }))
      .mockResolvedValueOnce(
        createJsonResponse({
          logs: [
            {
              id: 'v-1',
              timestamp: now.toISOString(),
              level: 'info',
              message: 'Healthy request in 20ms',
            },
          ],
        }),
      )

    const agent = new WatcherAgent({
      redis: redisClient as never,
      fetchImplementation: fetchMock as unknown as typeof fetch,
      sleepImplementation: sleepMock,
      now: () => now,
      config: {
        minBaselineSamples: 999,
        rateLimit: {
          maxRetries: 2,
          baseDelayMs: 100,
          maxDelayMs: 2000,
        },
      },
    })

    const result = await agent.handleTask(
      createTask({
        payload: {
          retentionWindowMinutes: 30,
          sources: [{ provider: 'vercel', token: 'token-v', projectId: 'vercel-project' }],
        },
      }),
    )

    expect(result.success).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(sleepMock).toHaveBeenCalledWith(1000)
  })

  it('honors retention window configuration when filtering logs', async () => {
    const now = new Date('2026-01-01T12:00:00.000Z')
    const oldTimestamp = new Date(now.getTime() - 30 * 60_000).toISOString()
    const recentTimestamp = new Date(now.getTime() - 2 * 60_000).toISOString()

    const fetchMock = vi.fn(async () =>
      createJsonResponse({
        logs: [
          { id: 'old', timestamp: oldTimestamp, level: 'info', message: 'Old log line' },
          { id: 'new', timestamp: recentTimestamp, level: 'info', message: 'Recent log line' },
        ],
      }),
    )

    const { client: redisClient } = createRedisMock()

    const agent = new WatcherAgent({
      redis: redisClient as never,
      fetchImplementation: fetchMock as unknown as typeof fetch,
      now: () => now,
      config: { minBaselineSamples: 999 },
    })

    const result = await agent.handleTask(
      createTask({
        payload: {
          retentionWindowMinutes: 5,
          sources: [{ provider: 'vercel', token: 'token-v', projectId: 'vercel-project' }],
        },
      }),
    )

    expect(result.success).toBe(true)
    expect(result.logsFetched).toBe(2)
    expect(result.normalizedLogs).toBe(1)
  })

  it('classify_alert uses Anthropic output and triggers Fixer when severity is critical', async () => {
    const now = new Date('2026-01-01T12:00:00.000Z')
    const { client: redisClient } = createRedisMock()

    testMocks.anthropicCreate.mockResolvedValueOnce({
      content: [
        {
          type: 'text',
          text: '{"severity":"critical","reason":"Payment failures indicate a user-facing outage"}',
        },
      ],
    })

    const eventBus = { publishEvent: vi.fn().mockResolvedValue(undefined) }
    const fetchMock = vi.fn(async () => createJsonResponse({ logs: [] }))

    const agent = new WatcherAgent({
      redis: redisClient as never,
      eventBus,
      fetchImplementation: fetchMock as unknown as typeof fetch,
      now: () => now,
    })

    const result = await agent.handleTask(
      createTask({
        type: 'classify_alert',
        payload: {
          provider: 'vercel',
          log: {
            id: 'entry-1',
            timestamp: now.toISOString(),
            level: 'info',
            message: 'Checkout flow unavailable for most requests',
          },
        },
      }),
    )

    expect(result.success).toBe(true)
    expect(result.alerts).toHaveLength(1)
    expect(result.alerts[0]?.severity).toBe('critical')
    expect(testMocks.anthropicCreate).toHaveBeenCalled()
    expect(testMocks.agentTaskCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: 'FIX_INCIDENT' }),
      }),
    )
  })
})
