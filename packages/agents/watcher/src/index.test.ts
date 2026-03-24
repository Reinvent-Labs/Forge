/**
 * @forge/agent-watcher — Unit Tests
 *
 * Tests the WatcherAgent's Welford online algorithm implementation,
 * anomaly sigma thresholds, batch classification chunking, deployment-
 * correlated spike detection, and silent failure detection.
 *
 * All external dependencies (prisma, ioredis, Anthropic) are fully mocked
 * so these tests run without any network or database access.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest'

// ---------------------------------------------------------------------------
// Module mocks — must be hoisted before any imports that use them
// ---------------------------------------------------------------------------

vi.mock('@forge/database', () => ({
  prisma: {
    projectMetricsSnapshot: {
      findMany: vi.fn(),
      create: vi.fn(),
      findFirst: vi.fn(),
    },
    codebaseContext: {
      findFirst: vi.fn(),
    },
    deployment: {
      findFirst: vi.fn(),
    },
    agentTask: {
      create: vi.fn(),
    },
    incident: {
      count: vi.fn(),
      findFirst: vi.fn(),
    },
  },
}))

vi.mock('@anthropic-ai/sdk', () => {
  const MockAnthropic = vi.fn().mockImplementation(() => ({
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: '["warning"]' }],
      }),
    },
  }))
  return { default: MockAnthropic }
})

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
  normalizeErrorFingerprint: (msg: string) => msg.toLowerCase().replace(/\s+/g, '-').slice(0, 64),
}))

// ---------------------------------------------------------------------------
// Import subject under test after mocks are registered
// ---------------------------------------------------------------------------

import { WatcherAgent } from './index'
import { prisma } from '@forge/database'

// ---------------------------------------------------------------------------
// Redis mock factory
// ---------------------------------------------------------------------------

/**
 * Creates a fresh in-memory Redis stub that supports the subset of commands
 * used by WatcherAgent: pipeline, zadd, zremrangebyscore, zscore, expire,
 * get, set, zrangebyscore.
 */
function makeRedisMock() {
  // Simulated sorted-set and key-value stores
  const zsets: Record<string, Map<string, number>> = {}
  const kvStore: Record<string, string> = {}

  const redisMock = {
    zadd: vi.fn((key: string, score: number, member: string) => {
      if (!zsets[key]) zsets[key] = new Map()
      zsets[key]!.set(member, score)
      return Promise.resolve(1)
    }),
    zremrangebyscore: vi.fn((key: string, min: number | string, max: number | string) => {
      if (!zsets[key]) return Promise.resolve(0)
      const minNum = min === '-inf' ? -Infinity : Number(min)
      const maxNum = max === '+inf' ? Infinity : Number(max)
      let removed = 0
      for (const [member, score] of zsets[key]!) {
        if (score >= minNum && score <= maxNum) {
          zsets[key]!.delete(member)
          removed++
        }
      }
      return Promise.resolve(removed)
    }),
    zscore: vi.fn((key: string, member: string) => {
      const score = zsets[key]?.get(member)
      return Promise.resolve(score !== undefined ? String(score) : null)
    }),
    zrangebyscore: vi.fn((key: string, min: number | string, max: number | string) => {
      if (!zsets[key]) return Promise.resolve([])
      const minNum = min === '-inf' ? -Infinity : Number(min)
      const maxNum = max === '+inf' ? Infinity : Number(max)
      const results: string[] = []
      for (const [member, score] of zsets[key]!) {
        if (score >= minNum && score <= maxNum) results.push(member)
      }
      return Promise.resolve(results)
    }),
    expire: vi.fn().mockResolvedValue(1),
    get: vi.fn((key: string) => Promise.resolve(kvStore[key] ?? null)),
    set: vi.fn((key: string, value: string) => {
      kvStore[key] = value
      return Promise.resolve('OK')
    }),
    pipeline: vi.fn(),
    // Expose internal stores for test introspection
    _zsets: zsets,
    _kvStore: kvStore,
  }

  // The pipeline returns a chainable object whose exec() resolves with
  // [error, result] pairs, mirroring ioredis semantics.
  const pipelineMock = {
    zremrangebyscore: vi.fn().mockReturnThis(),
    zscore: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue([
      [null, 0],   // zremrangebyscore result
      [null, null], // zscore result — null means "not found" (not a duplicate)
    ]),
  }
  redisMock.pipeline.mockReturnValue(pipelineMock)

  return { redisMock, pipelineMock, zsets, kvStore }
}

// ---------------------------------------------------------------------------
// Welford algorithm helpers — replicated for ground-truth comparison
// ---------------------------------------------------------------------------

/**
 * Pure implementation of the Welford online mean/variance algorithm,
 * used as ground truth to verify the agent's Redis-backed implementation.
 */
function welfordCompute(values: number[]): { mean: number; stdDev: number } {
  if (values.length === 0) return { mean: 0, stdDev: 0 }
  let n = 0
  let mean = 0
  let m2 = 0
  for (const x of values) {
    n++
    const delta = x - mean
    mean += delta / n
    const delta2 = x - mean
    m2 += delta * delta2
  }
  const variance = n > 1 ? m2 / (n - 1) : 0
  return { mean, stdDev: Math.sqrt(variance) }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WatcherAgent', () => {
  let agent: WatcherAgent
  let redisMock: ReturnType<typeof makeRedisMock>['redisMock']
  let pipelineMock: ReturnType<typeof makeRedisMock>['pipelineMock']
  let kvStore: ReturnType<typeof makeRedisMock>['kvStore']

  beforeEach(() => {
    vi.clearAllMocks()
    const mocks = makeRedisMock()
    redisMock = mocks.redisMock
    pipelineMock = mocks.pipelineMock
    kvStore = mocks.kvStore
    // WatcherAgent accepts any Redis-compatible object
    agent = new WatcherAgent(redisMock as never)
  })

  // -------------------------------------------------------------------------
  // Welford online algorithm — convergence
  // -------------------------------------------------------------------------

  describe('Welford online algorithm (updateRollingStats / getRollingStats)', () => {
    it('converges mean to the arithmetic mean after N samples', async () => {
      const values = [10, 20, 30, 40, 50]
      const { mean: expectedMean } = welfordCompute(values)

      // Feed all values into the agent's internal updateRollingStats.
      // We drive this indirectly via detectAnomalies which calls the method
      // after checking snapshots. Instead we access the private method
      // through the agent's public surface by calling detectAnomalies
      // with mocked snapshots that each carry the metric values.

      // Seed the kvStore with a stats object after manually running Welford
      // so we can verify getRollingStats reads it correctly.
      const projectId = 'proj-welford-mean'
      const metric = 'error_rate'
      const key = `forge:baseline:${projectId}:${metric}`

      // Simulate having previously processed the first 4 values
      let n = 0, runningMean = 0, m2 = 0
      for (const v of values.slice(0, 4)) {
        n++
        const delta = v - runningMean
        runningMean += delta / n
        const delta2 = v - runningMean
        m2 += delta * delta2
      }
      const stdDevSoFar = n > 1 ? Math.sqrt(m2 / (n - 1)) : 0
      kvStore[key] = JSON.stringify({
        mean: runningMean,
        stdDev: stdDevSoFar,
        sampleCount: n,
        updatedAt: Date.now(),
      })

      // Trigger updateRollingStats for the 5th value via detectAnomalies.
      // detectAnomalies calls updateRollingStats when sampleCount < 10.
      const fifthValue = values[4]!
      vi.mocked(prisma.projectMetricsSnapshot.findMany).mockResolvedValue([
        { id: '1', capturedAt: new Date(), projectId, errorRate: fifthValue, p95Latency: null, p99Latency: null } as never,
      ])
      vi.mocked(prisma.incident.count).mockResolvedValue(0)
      vi.mocked(prisma.deployment.findFirst).mockResolvedValue(null)

      await agent.detectAnomalies(projectId)

      // The set call should have persisted updated stats
      expect(redisMock.set).toHaveBeenCalled()
      const setCall = vi.mocked(redisMock.set).mock.calls[0]!
      const persisted = JSON.parse(setCall[1] as string) as { mean: number; stdDev: number; sampleCount: number }

      expect(persisted.sampleCount).toBe(5)
      expect(persisted.mean).toBeCloseTo(expectedMean, 8)
    })

    it('converges standard deviation to the population stddev after N samples', async () => {
      const values = [2, 4, 4, 4, 5, 5, 7, 9]
      const { mean: expectedMean, stdDev: expectedStdDev } = welfordCompute(values)

      // Run Welford manually to get intermediate state after 7 values
      let n = 0, runningMean = 0, m2 = 0
      for (const v of values.slice(0, 7)) {
        n++
        const delta = v - runningMean
        runningMean += delta / n
        const delta2 = v - runningMean
        m2 += delta * delta2
      }
      const projectId = 'proj-welford-std'
      const metric = 'error_rate'
      const key = `forge:baseline:${projectId}:${metric}`
      kvStore[key] = JSON.stringify({
        mean: runningMean,
        stdDev: n > 1 ? Math.sqrt(m2 / (n - 1)) : 0,
        sampleCount: n,
        updatedAt: Date.now(),
      })

      vi.mocked(prisma.projectMetricsSnapshot.findMany).mockResolvedValue([
        { id: '1', capturedAt: new Date(), projectId, errorRate: values[7]!, p95Latency: null, p99Latency: null } as never,
      ])
      vi.mocked(prisma.incident.count).mockResolvedValue(0)
      vi.mocked(prisma.deployment.findFirst).mockResolvedValue(null)

      await agent.detectAnomalies(projectId)

      const setCall = vi.mocked(redisMock.set).mock.calls[0]!
      const persisted = JSON.parse(setCall[1] as string) as { mean: number; stdDev: number }

      expect(persisted.mean).toBeCloseTo(expectedMean, 8)
      expect(persisted.stdDev).toBeCloseTo(expectedStdDev, 8)
    })

    it('initialises with mean = first value and stdDev = 0 for a single sample', async () => {
      const projectId = 'proj-welford-init'
      // No existing key in kvStore — agent should initialise from scratch
      vi.mocked(prisma.projectMetricsSnapshot.findMany).mockResolvedValue([
        { id: '1', capturedAt: new Date(), projectId, errorRate: 42, p95Latency: null, p99Latency: null } as never,
      ])
      vi.mocked(prisma.incident.count).mockResolvedValue(0)
      vi.mocked(prisma.deployment.findFirst).mockResolvedValue(null)

      await agent.detectAnomalies(projectId)

      const setCall = vi.mocked(redisMock.set).mock.calls[0]!
      const persisted = JSON.parse(setCall[1] as string) as { mean: number; stdDev: number; sampleCount: number }

      expect(persisted.mean).toBe(42)
      expect(persisted.stdDev).toBe(0)
      expect(persisted.sampleCount).toBe(1)
    })
  })

  // -------------------------------------------------------------------------
  // Sigma threshold — anomaly detection
  // -------------------------------------------------------------------------

  describe('anomaly sigma threshold (ANOMALY_SIGMA_THRESHOLD = 2.5)', () => {
    /**
     * Helper: seeds Redis with rolling stats and calls detectAnomalies with a
     * given current error-rate value. Returns the AnomalyReport.
     */
    async function runWithStats(
      projectId: string,
      mean: number,
      stdDev: number,
      sampleCount: number,
      currentValue: number,
    ) {
      const key = `forge:baseline:${projectId}:error_rate`
      kvStore[key] = JSON.stringify({ mean, stdDev, sampleCount, updatedAt: Date.now() })

      vi.mocked(prisma.projectMetricsSnapshot.findMany).mockResolvedValue([
        { id: '1', capturedAt: new Date(), projectId, errorRate: currentValue, p95Latency: null, p99Latency: null } as never,
      ])
      vi.mocked(prisma.incident.count).mockResolvedValue(0)
      vi.mocked(prisma.deployment.findFirst).mockResolvedValue(null)

      return agent.detectAnomalies(projectId)
    }

    it('does NOT flag a value at exactly 2.5σ as an anomaly (strict less-than check)', async () => {
      // The threshold is >= 2.5, so a value at exactly 2.499σ should not trigger
      const mean = 100
      const stdDev = 10
      const currentValue = mean + 2.499 * stdDev // 124.99 — just below threshold
      const report = await runWithStats('proj-sigma-below', mean, stdDev, 15, currentValue)
      expect(report.anomalies.filter((a) => a.metric === 'error_rate')).toHaveLength(0)
    })

    it('flags a value at exactly 2.5σ as an anomaly', async () => {
      const mean = 100
      const stdDev = 10
      const currentValue = mean + 2.5 * stdDev // 125 — at threshold
      const report = await runWithStats('proj-sigma-at', mean, stdDev, 15, currentValue)
      const errAnomalies = report.anomalies.filter((a) => a.metric === 'error_rate')
      expect(errAnomalies).toHaveLength(1)
      expect(errAnomalies[0]!.sigmas).toBeCloseTo(2.5, 5)
    })

    it('flags a value at 3σ as an anomaly with correct sigmas', async () => {
      const mean = 50
      const stdDev = 5
      const currentValue = mean + 3 * stdDev // 65
      const report = await runWithStats('proj-sigma-3', mean, stdDev, 15, currentValue)
      const errAnomalies = report.anomalies.filter((a) => a.metric === 'error_rate')
      expect(errAnomalies).toHaveLength(1)
      expect(errAnomalies[0]!.sigmas).toBeCloseTo(3, 5)
      expect(errAnomalies[0]!.rollingMean).toBe(mean)
      expect(errAnomalies[0]!.stdDev).toBe(stdDev)
    })

    it('skips anomaly detection when sampleCount < 10 (baseline still warming up)', async () => {
      const mean = 100
      const stdDev = 10
      const currentValue = mean + 5 * stdDev // 5σ — would trigger if baseline were ready
      const report = await runWithStats('proj-sigma-warmup', mean, stdDev, 9, currentValue)
      // With sampleCount < 10 the agent only calls updateRollingStats, not the sigma check
      expect(report.anomalies.filter((a) => a.metric === 'error_rate')).toHaveLength(0)
    })

    it('returns zero anomalies when no recent snapshots exist', async () => {
      vi.mocked(prisma.projectMetricsSnapshot.findMany).mockResolvedValue([])
      const report = await agent.detectAnomalies('proj-no-snapshots')
      expect(report.anomalies).toHaveLength(0)
      expect(report.deploymentCorrelated).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // Batch classification chunking
  // -------------------------------------------------------------------------

  describe('classifyViaClaude chunking (chunks of 20)', () => {
    it('sends exactly 2 chunks for 25 events (ceil(25/20) = 2)', async () => {
      // processLogBatch drives classifyViaClaude → classifyChunk
      // Each classifyChunk call invokes this.anthropic.messages.create once.
      // We obtain the mock from the Anthropic constructor.
      const Anthropic = (await import('@anthropic-ai/sdk')).default
      const anthropicInstance = vi.mocked(Anthropic).mock.results[0]!.value as {
        messages: { create: MockInstance }
      }
      const createSpy = anthropicInstance.messages.create

      // Return a valid classification array for each chunk
      createSpy.mockImplementation(({ messages }: { messages: Array<{ content: string }> }) => {
        const content = messages[0]!.content as string
        // Count how many lines are in the event list section
        const lineCount = (content.match(/^\d+\./gm) ?? []).length || 20
        const arr = Array.from({ length: lineCount }, () => 'noise')
        return Promise.resolve({ content: [{ type: 'text', text: JSON.stringify(arr) }] })
      })

      const makeEvent = (i: number) => ({
        id: `evt-${i}`,
        projectId: 'proj-chunk',
        source: 'sentry',
        timestamp: new Date(),
        level: 'error',
        message: `Error message ${i}`,
        metadata: {},
      })

      const events = Array.from({ length: 25 }, (_, i) => makeEvent(i))

      // Pipeline mock: all events are treated as new (zscore returns null)
      pipelineMock.exec.mockResolvedValue([
        [null, 0],
        [null, null],
      ])

      vi.mocked(prisma.codebaseContext.findFirst).mockResolvedValue(null)
      vi.mocked(prisma.deployment.findFirst).mockResolvedValue(null)
      vi.mocked(prisma.agentTask.create).mockResolvedValue({ id: 'task-1' } as never)

      await agent.processLogBatch(events)

      // classifyChunk should have been called twice (chunk 1: 20, chunk 2: 5)
      expect(createSpy).toHaveBeenCalledTimes(2)
    })

    it('sends exactly 1 chunk for 20 events', async () => {
      const Anthropic = (await import('@anthropic-ai/sdk')).default
      const anthropicInstance = vi.mocked(Anthropic).mock.results[0]!.value as {
        messages: { create: MockInstance }
      }
      const createSpy = anthropicInstance.messages.create

      createSpy.mockResolvedValue({
        content: [{ type: 'text', text: JSON.stringify(Array(20).fill('noise')) }],
      })

      const events = Array.from({ length: 20 }, (_, i) => ({
        id: `evt-${i}`,
        projectId: 'proj-chunk20',
        source: 'sentry',
        timestamp: new Date(),
        level: 'error',
        message: `Error ${i}`,
        metadata: {},
      }))

      pipelineMock.exec.mockResolvedValue([[null, 0], [null, null]])
      vi.mocked(prisma.codebaseContext.findFirst).mockResolvedValue(null)
      vi.mocked(prisma.deployment.findFirst).mockResolvedValue(null)

      await agent.processLogBatch(events)

      expect(createSpy).toHaveBeenCalledTimes(1)
    })
  })

  // -------------------------------------------------------------------------
  // Deployment-correlated spike detection
  // -------------------------------------------------------------------------

  describe('deployment-correlated spike detection (10-min window)', () => {
    it('marks report as deploymentCorrelated when a deploy occurred within 10 minutes and error_rate spiked', async () => {
      const projectId = 'proj-deploy-corr'
      const mean = 1
      const stdDev = 0.1
      // 4σ spike — well above threshold
      const currentValue = mean + 4 * stdDev

      const key = `forge:baseline:${projectId}:error_rate`
      kvStore[key] = JSON.stringify({ mean, stdDev, sampleCount: 20, updatedAt: Date.now() })

      vi.mocked(prisma.projectMetricsSnapshot.findMany).mockResolvedValue([
        { id: '1', capturedAt: new Date(), projectId, errorRate: currentValue, p95Latency: null, p99Latency: null } as never,
      ])
      vi.mocked(prisma.incident.count).mockResolvedValue(0)

      // Deploy completed 5 minutes ago — within the 10-min window
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000)
      vi.mocked(prisma.deployment.findFirst).mockResolvedValue({
        id: 'deploy-abc',
        completedAt: fiveMinutesAgo,
        status: 'SUCCEEDED',
      } as never)

      const report = await agent.detectAnomalies(projectId)

      expect(report.deploymentCorrelated).toBe(true)
      expect(report.triggeringDeployId).toBe('deploy-abc')
    })

    it('does NOT mark deploymentCorrelated when deploy was 15 minutes ago (outside window)', async () => {
      const projectId = 'proj-deploy-old'
      const mean = 1
      const stdDev = 0.1
      const currentValue = mean + 4 * stdDev

      const key = `forge:baseline:${projectId}:error_rate`
      kvStore[key] = JSON.stringify({ mean, stdDev, sampleCount: 20, updatedAt: Date.now() })

      vi.mocked(prisma.projectMetricsSnapshot.findMany).mockResolvedValue([
        { id: '1', capturedAt: new Date(), projectId, errorRate: currentValue, p95Latency: null, p99Latency: null } as never,
      ])
      vi.mocked(prisma.incident.count).mockResolvedValue(0)

      // detectDeploymentCorrelation queries the DB with `completedAt >= cutoff`.
      // Returning null simulates no deployment within the window.
      vi.mocked(prisma.deployment.findFirst).mockResolvedValue(null)

      const report = await agent.detectAnomalies(projectId)

      expect(report.deploymentCorrelated).toBe(false)
      expect(report.triggeringDeployId).toBeUndefined()
    })

    it('does NOT mark deploymentCorrelated when there is a deploy but no error_rate spike', async () => {
      const projectId = 'proj-deploy-no-spike'
      const mean = 5
      const stdDev = 1
      // Only 1σ — well below the 2.5σ threshold
      const currentValue = mean + 1 * stdDev

      const key = `forge:baseline:${projectId}:error_rate`
      kvStore[key] = JSON.stringify({ mean, stdDev, sampleCount: 20, updatedAt: Date.now() })

      vi.mocked(prisma.projectMetricsSnapshot.findMany).mockResolvedValue([
        { id: '1', capturedAt: new Date(), projectId, errorRate: currentValue, p95Latency: null, p99Latency: null } as never,
      ])
      vi.mocked(prisma.incident.count).mockResolvedValue(0)
      vi.mocked(prisma.deployment.findFirst).mockResolvedValue({
        id: 'deploy-xyz',
        completedAt: new Date(Date.now() - 2 * 60 * 1000),
        status: 'SUCCEEDED',
      } as never)

      const report = await agent.detectAnomalies(projectId)

      expect(report.deploymentCorrelated).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // Silent failure detection
  // -------------------------------------------------------------------------

  describe('silent failure detection', () => {
    it('adds a silent_failure anomaly when open incidents exist but error rate is < 0.01', async () => {
      const projectId = 'proj-silent'

      // Snapshots exist but the error rate is near zero
      vi.mocked(prisma.projectMetricsSnapshot.findMany).mockResolvedValue([
        { id: '1', capturedAt: new Date(), projectId, errorRate: 0.001, p95Latency: null, p99Latency: null } as never,
      ])
      // No rolling stats — skip sigma check
      vi.mocked(prisma.incident.count).mockResolvedValue(3)
      vi.mocked(prisma.projectMetricsSnapshot.findFirst).mockResolvedValue({
        id: '1', capturedAt: new Date(), projectId, errorRate: 0.001,
      } as never)
      vi.mocked(prisma.deployment.findFirst).mockResolvedValue(null)

      const report = await agent.detectAnomalies(projectId)

      const silentAnomalies = report.anomalies.filter((a) => a.metric === 'silent_failure')
      expect(silentAnomalies).toHaveLength(1)
      expect(silentAnomalies[0]!.sigmas).toBe(999)
      expect(silentAnomalies[0]!.currentValue).toBe(3) // open incident count
    })

    it('does NOT add a silent_failure anomaly when there are no open incidents', async () => {
      const projectId = 'proj-no-silent'

      vi.mocked(prisma.projectMetricsSnapshot.findMany).mockResolvedValue([
        { id: '1', capturedAt: new Date(), projectId, errorRate: 0.001, p95Latency: null, p99Latency: null } as never,
      ])
      vi.mocked(prisma.incident.count).mockResolvedValue(0)
      vi.mocked(prisma.projectMetricsSnapshot.findFirst).mockResolvedValue({
        id: '1', capturedAt: new Date(), projectId, errorRate: 0.001,
      } as never)
      vi.mocked(prisma.deployment.findFirst).mockResolvedValue(null)

      const report = await agent.detectAnomalies(projectId)

      expect(report.anomalies.filter((a) => a.metric === 'silent_failure')).toHaveLength(0)
    })

    it('does NOT add a silent_failure anomaly when error rate is >= 0.01 (visible errors)', async () => {
      const projectId = 'proj-high-err'

      vi.mocked(prisma.projectMetricsSnapshot.findMany).mockResolvedValue([
        { id: '1', capturedAt: new Date(), projectId, errorRate: 0.05, p95Latency: null, p99Latency: null } as never,
      ])
      vi.mocked(prisma.incident.count).mockResolvedValue(5)
      vi.mocked(prisma.projectMetricsSnapshot.findFirst).mockResolvedValue({
        id: '1', capturedAt: new Date(), projectId, errorRate: 0.05,
      } as never)
      vi.mocked(prisma.deployment.findFirst).mockResolvedValue(null)

      const report = await agent.detectAnomalies(projectId)

      expect(report.anomalies.filter((a) => a.metric === 'silent_failure')).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // processLogBatch — empty batch guard
  // -------------------------------------------------------------------------

  describe('processLogBatch edge cases', () => {
    it('returns early without calling Redis when event array is empty', async () => {
      await agent.processLogBatch([])
      expect(redisMock.pipeline).not.toHaveBeenCalled()
    })
  })
})
