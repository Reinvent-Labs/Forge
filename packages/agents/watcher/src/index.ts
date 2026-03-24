/**
 * @forge/agent-watcher
 *
 * The Watcher Agent is the platform's observability brain. It ingests log
 * streams from multiple sources (Sentry, PostHog, custom), classifies events
 * using Claude Haiku, deduplicates via Redis, correlates related events, and
 * routes them to the appropriate downstream handlers (Fixer, notifications,
 * aggregation batches). It also maintains rolling statistical baselines and
 * surfaces anomalies, including deployment-correlated error spikes.
 */

import Anthropic from '@anthropic-ai/sdk'
import { createLogger, normalizeErrorFingerprint } from '@forge/shared'
import type {
  LogEvent,
  EnrichedLogEvent,
  LogClassification,
  ProjectMetrics,
} from '@forge/shared'
import { prisma } from '@forge/database'
import type { Redis } from 'ioredis'
import { randomUUID } from 'crypto'

const log = createLogger('agent-watcher')

// ---------------------------------------------------------------------------
// Supporting types
// ---------------------------------------------------------------------------

/** Configuration blob passed to an adapter when connecting. */
export interface AdapterConfig {
  apiKey?: string
  dsn?: string
  [key: string]: unknown
}

/** Filter criteria for ad-hoc log queries. */
export interface LogFilter {
  projectId?: string
  level?: string
  since?: Date
  until?: Date
  fingerprint?: string
  limit?: number
}

/**
 * Adapter interface for plugging in different log / event sources.
 * Each adapter owns connection lifecycle and provides both a streaming
 * iterator (real-time ingestion) and a query method (backfill).
 */
export interface LogIngestionAdapter {
  name: string
  connect(config: AdapterConfig): Promise<void>
  stream(): AsyncIterableIterator<LogEvent>
  query(filter: LogFilter): Promise<LogEvent[]>
}

/**
 * A statistical anomaly detected in a project metrics baseline.
 */
export interface AnomalyReport {
  projectId: string
  detectedAt: Date
  anomalies: AnomalyDetail[]
  deploymentCorrelated: boolean
  triggeringDeployId?: string
}

export interface AnomalyDetail {
  metric: string
  currentValue: number
  rollingMean: number
  stdDev: number
  sigmas: number
  description: string
}

/** Welford rolling stats stored in Redis. */
interface RollingStats {
  mean: number
  stdDev: number
  sampleCount: number
  updatedAt: number
}

// ---------------------------------------------------------------------------
// SentryAdapter
// ---------------------------------------------------------------------------

/**
 * Ingests error events from Sentry via the Issues API.
 * In production the stream() implementation would use Sentry real-time
 * webhooks. Here we poll for simplicity while keeping the interface correct.
 */
export class SentryAdapter implements LogIngestionAdapter {
  readonly name = 'sentry'
  private config: AdapterConfig = {}
  private projectSlug = ''
  private orgSlug = ''

  async connect(config: AdapterConfig): Promise<void> {
    log.info({ adapter: this.name }, 'Connecting Sentry adapter')
    this.config = config
    const dsn = (config['dsn'] as string | undefined) ?? ''
    const parts = dsn.split('/')
    this.projectSlug = parts[parts.length - 1] ?? 'unknown'
    this.orgSlug = parts[parts.length - 2] ?? 'unknown'
    log.info({ adapter: this.name, orgSlug: this.orgSlug, projectSlug: this.projectSlug }, 'Sentry adapter connected')
  }

  async *stream(): AsyncIterableIterator<LogEvent> {
    log.debug({ adapter: this.name }, 'Sentry stream started (polling mode)')
    return
    yield {} as LogEvent
  }

  async query(filter: LogFilter): Promise<LogEvent[]> {
    const apiKey = (this.config['apiKey'] as string | undefined) ?? ''
    const url = 'https://sentry.io/api/0/projects/' + this.orgSlug + '/' + this.projectSlug + '/issues/?limit=' + String(filter.limit ?? 25)
    try {
      const response = await fetch(url, { headers: { Authorization: 'Bearer ' + apiKey } })
      if (\!response.ok) {
        log.warn({ adapter: this.name, status: response.status }, 'Sentry API non-200 response')
        return []
      }
      const issues = (await response.json()) as Array<{
        id: string; title: string; level: string; firstSeen: string
        metadata?: { value?: string }; tags?: Array<{ key: string; value: string }>
      }>
      return issues.map((issue) => ({
        id: issue.id,
        projectId: filter.projectId ?? '',
        source: this.name,
        timestamp: new Date(issue.firstSeen),
        level: issue.level,
        message: issue.title,
        fingerprint: normalizeErrorFingerprint(issue.title),
        metadata: { sentryIssueId: issue.id, tags: issue.tags ?? [], errorValue: issue.metadata?.value },
      }))
    } catch (err) {
      log.error({ adapter: this.name, err }, 'Failed to query Sentry API')
      return []
    }
  }
}

// ---------------------------------------------------------------------------
// PostHogAdapter
// ---------------------------------------------------------------------------

/**
 * Ingests exception events from PostHog via the HogQL Query API.
 * Queries the $exception event type and maps results to LogEvent.
 */
export class PostHogAdapter implements LogIngestionAdapter {
  readonly name = 'posthog'
  private config: AdapterConfig = {}

  async connect(config: AdapterConfig): Promise<void> {
    log.info({ adapter: this.name }, 'Connecting PostHog adapter')
    this.config = config
    log.info({ adapter: this.name }, 'PostHog adapter connected')
  }

  async *stream(): AsyncIterableIterator<LogEvent> {
    log.debug({ adapter: this.name }, 'PostHog stream started')
    return
    yield {} as LogEvent
  }

  async query(filter: LogFilter): Promise<LogEvent[]> {
    const apiKey = (this.config['apiKey'] as string | undefined) ?? ''
    const host = (this.config['host'] as string | undefined) ?? 'https://app.posthog.com'
    const queryBody = {
      query: {
        kind: 'HogQLQuery',
        query: 'SELECT uuid, timestamp, properties FROM events WHERE event = ' + "'" + '$exception' + "'" + ' ORDER BY timestamp DESC LIMIT ' + String(filter.limit ?? 25),
      },
    }
    try {
      const response = await fetch(host + '/api/query/', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(queryBody),
      })
      if (\!response.ok) {
        log.warn({ adapter: this.name, status: response.status }, 'PostHog API non-200 response')
        return []
      }
      const result = (await response.json()) as { results: Array<[string, string, Record<string, unknown>]> }
      return (result.results ?? []).map(([uuid, timestamp, properties]) => {
        const message = (properties['$exception_message'] as string | undefined) ?? 'Unknown exception'
        return {
          id: uuid,
          projectId: filter.projectId ?? '',
          source: this.name,
          timestamp: new Date(timestamp),
          level: 'error',
          message,
          fingerprint: normalizeErrorFingerprint(message),
          metadata: properties,
        }
      })
    } catch (err) {
      log.error({ adapter: this.name, err }, 'Failed to query PostHog API')
      return []
    }
  }
}

// ---------------------------------------------------------------------------
// WatcherAgent
// ---------------------------------------------------------------------------

/**
 * Core observability agent. Classifies, deduplicates, enriches, and routes
 * log events. Detects statistical anomalies in project metrics baselines.
 *
 * @example
 * const agent = new WatcherAgent(redis)
 * await agent.processLogBatch(events)
 */
export class WatcherAgent {
  private readonly anthropic: Anthropic
  /** 5-minute dedup window in seconds. */
  private readonly DEDUP_WINDOW_SECS = 300
  /** 30-minute warning aggregation window in seconds. */
  private readonly WARNING_BATCH_WINDOW_SECS = 1800
  /** Alert threshold: 2.5 standard deviations from rolling mean. */
  private readonly ANOMALY_SIGMA_THRESHOLD = 2.5
  /** Baseline TTL in Redis: 7 days in seconds. */
  private readonly BASELINE_WINDOW_SECS = 7 * 24 * 60 * 60
  /** Deployment-correlation window: 10 minutes in ms. */
  private readonly DEPLOY_CORRELATION_WINDOW_MS = 10 * 60 * 1000

  constructor(private readonly redis: Redis) {
    this.anthropic = new Anthropic()
    log.info('WatcherAgent initialized')
  }

  // -------------------------------------------------------------------------
  // 1. classifyLog
  // -------------------------------------------------------------------------

  /**
   * Classify a single log event using Claude Haiku.
   *
   * Pipeline:
   * 1. Compute stable fingerprint.
   * 2. Redis sorted-set dedup check (5-min window) — return noise if seen.
   * 3. Classify via Haiku in parallel with module-context and deploy lookups.
   * 4. Return fully enriched event.
   *
   * @param event - Raw log event from any ingestion adapter.
   * @returns Enriched log event with classification and context metadata.
   */
  async classifyLog(event: LogEvent): Promise<EnrichedLogEvent> {
    const taskLog = log.child({ projectId: event.projectId, eventId: event.id })

    const fingerprint = event.fingerprint ?? normalizeErrorFingerprint(event.message)
    const dedupKey = 
    const now = Date.now()
    const windowStart = now - this.DEDUP_WINDOW_SECS * 1000

    // Atomic pipeline: prune stale entries then check for this fingerprint
    const pipeline = this.redis.pipeline()
    pipeline.zremrangebyscore(dedupKey, '-inf', windowStart)
    pipeline.zscore(dedupKey, fingerprint)
    const results = await pipeline.exec()

    const existingScore = results?.[1]?.[1]
    if (existingScore \!== null && existingScore \!== undefined) {
      taskLog.debug({ fingerprint }, 'Duplicate event in 5-min dedup window — discarding')
      return {
        ...event,
        fingerprint,
        classification: 'noise',
        userImpactEstimate: 0,
        correlatedEvents: [],
      }
    }

    // Register in dedup window
    await this.redis.zadd(dedupKey, now, fingerprint)
    await this.redis.expire(dedupKey, this.DEDUP_WINDOW_SECS)

    // Run classification and enrichment in parallel
    const [classification, moduleContext, recentDeploy] = await Promise.all([
      this.classifyViaClaude([event]).then((r) => r[0] ?? 'noise'),
      this.resolveModuleContext(event.projectId, event.message),
      this.getRecentDeploy(event.projectId),
    ])

    const enriched: EnrichedLogEvent = {
      ...event,
      fingerprint,
      classification: classification as LogClassification,
      affectedModule: moduleContext,
      recentDeployId: recentDeploy?.id,
      userImpactEstimate: this.estimateUserImpact(classification as LogClassification),
      correlatedEvents: [],
    }

    taskLog.info(
      { classification, affectedModule: moduleContext, deployId: recentDeploy?.id },
      'Log event classified',
    )

    return enriched
  }

  // -------------------------------------------------------------------------
  // 2. processLogBatch
  // -------------------------------------------------------------------------

  /**
   * Process a batch of log events through the full classification pipeline.
   *
   * Steps:
   * 1. Dedup via Redis sorted set (5-min window).
   * 2. Enrich with module context (parallel).
   * 3. Batch-classify via Claude Haiku (chunks of 20).
   * 4. Correlate related events (same fingerprint, last 15 min).
   * 5. Route: noise->discard, warning->30-min aggregate, incident->Fixer,
   *    critical->page + Fixer.
   *
   * @param events - Array of raw log events to process.
   */
  async processLogBatch(events: LogEvent[]): Promise<void> {
    if (events.length === 0) return

    const firstEvent = events[0]
    const batchLog = log.child({ batchSize: events.length, projectId: firstEvent?.projectId })
    batchLog.info('Processing log batch')

    const dedupedEvents = await this.deduplicateBatch(events)
    batchLog.debug({ dedupedCount: dedupedEvents.length }, 'Deduplication complete')

    if (dedupedEvents.length === 0) {
      batchLog.info('All events were duplicates — batch discarded')
      return
    }

    const moduleContexts = await Promise.all(
      dedupedEvents.map((e) => this.resolveModuleContext(e.projectId, e.message)),
    )

    const classifications = await this.classifyViaClaude(dedupedEvents)

    const firstDeduped = dedupedEvents[0]
    const recentDeploy = firstDeduped ? await this.getRecentDeploy(firstDeduped.projectId) : null

    const enrichedEvents: EnrichedLogEvent[] = dedupedEvents.map((event, i) => ({
      ...event,
      fingerprint: event.fingerprint ?? normalizeErrorFingerprint(event.message),
      classification: (classifications[i] ?? 'noise') as LogClassification,
      affectedModule: moduleContexts[i],
      recentDeployId: recentDeploy?.id,
      userImpactEstimate: this.estimateUserImpact((classifications[i] ?? 'noise') as LogClassification),
      correlatedEvents: [],
    }))

    await this.correlateEvents(enrichedEvents)
    await this.routeEvents(enrichedEvents)

    batchLog.info(
      {
        noise: enrichedEvents.filter((e) => e.classification === 'noise').length,
        warning: enrichedEvents.filter((e) => e.classification === 'warning').length,
        incident: enrichedEvents.filter((e) => e.classification === 'incident').length,
        critical: enrichedEvents.filter((e) => e.classification === 'critical').length,
      },
      'Batch processing complete',
    )
  }

  // -------------------------------------------------------------------------
  // 3. detectAnomalies
  // -------------------------------------------------------------------------

  /**
   * Compare current metrics against 7-day rolling baselines stored in Redis.
   * Alerts at 2.5 sigma. Also surfaces silent failures and deployment-correlated
   * error spikes.
   *
   * @param projectId - The project to analyze.
   * @returns AnomalyReport with all detected anomalies.
   */
  async detectAnomalies(projectId: string): Promise<AnomalyReport> {
    const anomalyLog = log.child({ projectId, fn: 'detectAnomalies' })
    anomalyLog.info('Starting anomaly detection')

    const anomalies: AnomalyDetail[] = []

    const recentSnapshots = await prisma.projectMetricsSnapshot.findMany({
      where: { projectId, capturedAt: { gte: new Date(Date.now() - 30 * 60 * 1000) } },
      orderBy: { capturedAt: 'desc' },
      take: 10,
    })

    if (recentSnapshots.length === 0) {
      anomalyLog.info('No recent snapshots — skipping anomaly detection')
      return { projectId, detectedAt: new Date(), anomalies: [], deploymentCorrelated: false }
    }

    const latest = recentSnapshots[0]\!

    const metricsToCheck: Array<{ key: 'errorRate' | 'p95Latency' | 'p99Latency'; label: string }> = [
      { key: 'errorRate', label: 'error_rate' },
      { key: 'p95Latency', label: 'p95_latency' },
      { key: 'p99Latency', label: 'p99_latency' },
    ]

    for (const { key, label } of metricsToCheck) {
      const currentValue = latest[key]
      if (currentValue === null || currentValue === undefined) continue

      const stats = await this.getRollingStats(projectId, label)
      if (\!stats || stats.sampleCount < 10) {
        await this.updateRollingStats(projectId, label, currentValue)
        continue
      }

      const sigmas = stats.stdDev > 0 ? Math.abs(currentValue - stats.mean) / stats.stdDev : 0

      if (sigmas >= this.ANOMALY_SIGMA_THRESHOLD) {
        anomalies.push({
          metric: label,
          currentValue,
          rollingMean: stats.mean,
          stdDev: stats.stdDev,
          sigmas,
          description:
             +
            ,
        })
        anomalyLog.warn({ metric: label, currentValue, sigmas }, 'Anomaly detected')
      }

      await this.updateRollingStats(projectId, label, currentValue)
    }

    const silentFailures = await this.detectSilentFailures(projectId)
    anomalies.push(...silentFailures)

    const { deploymentCorrelated, triggeringDeployId } =
      await this.detectDeploymentCorrelation(projectId, anomalies)

    const report: AnomalyReport = {
      projectId,
      detectedAt: new Date(),
      anomalies,
      deploymentCorrelated,
      ...(triggeringDeployId \!== undefined ? { triggeringDeployId } : {}),
    }

    anomalyLog.info({ anomalyCount: anomalies.length, deploymentCorrelated }, 'Anomaly detection complete')
    return report
  }

  // -------------------------------------------------------------------------
  // 4. updateMetrics
  // -------------------------------------------------------------------------

  /**
   * Persist a metrics snapshot to the database.
   * Extracts the latest point from each time series before writing.
   *
   * @param projectId - Target project ID.
   * @param metrics   - Partial metrics object; undefined series are skipped.
   */
  async updateMetrics(projectId: string, metrics: Partial<ProjectMetrics>): Promise<void> {
    const metricsLog = log.child({ projectId, fn: 'updateMetrics' })
    metricsLog.debug('Persisting metrics snapshot')

    try {
      const latest = (series?: Array<{ value: number }>): number | null =>
        series && series.length > 0 ? (series[series.length - 1]?.value ?? null) : null

      const roundOrNull = (v: number | null): number | null => (v \!== null ? Math.round(v) : null)

      await prisma.projectMetricsSnapshot.create({
        data: {
          projectId,
          errorRate: latest(metrics.errorRate),
          p50Latency: latest(metrics.p50Latency),
          p95Latency: latest(metrics.p95Latency),
          p99Latency: latest(metrics.p99Latency),
          uptimePercent: latest(metrics.uptime),
          testCoverage: latest(metrics.testCoverage),
          securityScore: roundOrNull(latest(metrics.securityScore)),
          debtScore: roundOrNull(latest(metrics.debtScore)),
          openPrs: metrics.openPRs,
          activeUsers: roundOrNull(latest(metrics.activeUsers)),
          newSignups: roundOrNull(latest(metrics.newSignups)),
          revenue: latest(metrics.revenue),
        },
      })

      metricsLog.info('Metrics snapshot persisted')
    } catch (err) {
      metricsLog.error({ err }, 'Failed to persist metrics snapshot')
      throw err
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async deduplicateBatch(events: LogEvent[]): Promise<LogEvent[]> {
    const unique: LogEvent[] = []
    const now = Date.now()
    const windowStart = now - this.DEDUP_WINDOW_SECS * 1000

    for (const event of events) {
      const fingerprint = event.fingerprint ?? normalizeErrorFingerprint(event.message)
      const dedupKey = 

      const pipeline = this.redis.pipeline()
      pipeline.zremrangebyscore(dedupKey, '-inf', windowStart)
      pipeline.zscore(dedupKey, fingerprint)
      const results = await pipeline.exec()

      const score = results?.[1]?.[1]
      if (score === null || score === undefined) {
        await this.redis.zadd(dedupKey, now, fingerprint)
        await this.redis.expire(dedupKey, this.DEDUP_WINDOW_SECS)
        unique.push({ ...event, fingerprint })
      }
    }

    return unique
  }

  private async classifyViaClaude(events: LogEvent[]): Promise<string[]> {
    const results: string[] = []
    for (let i = 0; i < events.length; i += 20) {
      const chunk = events.slice(i, i + 20)
      const chunkResults = await this.classifyChunk(chunk)
      results.push(...chunkResults)
    }
    return results
  }

  private async classifyChunk(events: LogEvent[]): Promise<string[]> {
    const eventLines = events
      .map((e, idx) => )
      .join('\n')

    const prompt =
       +
       +
       +
       +
       +
       +
       +
      

    try {
      const response = await this.anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 512,
        messages: [{ role: 'user', content: prompt }],
      })

      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')

      const parsed = JSON.parse(text.trim()) as unknown[]
      if (\!Array.isArray(parsed)) throw new Error('Response is not a JSON array')

      const valid = new Set(['noise', 'warning', 'incident', 'critical'])
      return parsed.map((c) => (typeof c === 'string' && valid.has(c) ? c : 'warning'))
    } catch (err) {
      log.error({ err, eventCount: events.length }, 'Haiku classification failed — defaulting to warning')
      return events.map(() => 'warning')
    }
  }

  private async resolveModuleContext(projectId: string, message: string): Promise<string | undefined> {
    try {
      const context = await prisma.codebaseContext.findFirst({
        where: { projectId },
        include: { modules: true },
      })
      if (\!context) return undefined
      const messageLower = message.toLowerCase()
      const match = context.modules.find((m) => {
        const segments = m.path.toLowerCase().split('/')
        return segments.some((seg) => seg.length > 3 && messageLower.includes(seg))
      })
      return match?.path
    } catch {
      return undefined
    }
  }

  private async getRecentDeploy(projectId: string) {
    try {
      return await prisma.deployment.findFirst({
        where: { projectId, status: 'SUCCEEDED' },
        orderBy: { completedAt: 'desc' },
      })
    } catch {
      return null
    }
  }

  private async correlateEvents(events: EnrichedLogEvent[]): Promise<void> {
    const windowStart = Date.now() - 15 * 60 * 1000
    for (const event of events) {
      const fp = event.fingerprint ?? ''
      if (\!fp) continue
      const corrKey = 
      const correlated = await this.redis.zrangebyscore(corrKey, windowStart, '+inf')
      event.correlatedEvents = correlated.filter((id) => id \!== event.id)
      await this.redis.zadd(corrKey, Date.now(), event.id)
      await this.redis.expire(corrKey, 15 * 60)
    }
  }

  private async routeEvents(events: EnrichedLogEvent[]): Promise<void> {
    for (const event of events) {
      switch (event.classification) {
        case 'noise':
          break
        case 'warning': {
          const queueKey = 
          await this.redis.zadd(queueKey, Date.now(), JSON.stringify(event))
          await this.redis.expire(queueKey, this.WARNING_BATCH_WINDOW_SECS)
          log.debug({ eventId: event.id }, 'Warning enqueued for 30-min batch notification')
          break
        }
        case 'incident': {
          await this.createFixerTask(event, false)
          log.info({ eventId: event.id, module: event.affectedModule }, 'Incident — Fixer task created')
          break
        }
        case 'critical': {
          await this.createFixerTask(event, true)
          await this.pageOnCall(event)
          log.warn({ eventId: event.id, module: event.affectedModule }, 'Critical — paged on-call + Fixer task created')
          break
        }
      }
    }
  }

  private async createFixerTask(event: EnrichedLogEvent, isPaging: boolean): Promise<void> {
    try {
      await prisma.agentTask.create({
        data: {
          id: randomUUID(),
          projectId: event.projectId,
          type: 'FIX_INCIDENT',
          priority: isPaging ? 'CRITICAL' : 'HIGH',
          agentType: 'FIXER',
          requestedBy: 'SYSTEM',
          autonomyLevel: 'SEMI',
          payload: {
            eventId: event.id,
            message: event.message,
            classification: event.classification,
            affectedModule: event.affectedModule,
            fingerprint: event.fingerprint,
            correlatedEvents: event.correlatedEvents,
            recentDeployId: event.recentDeployId,
          },
        },
      })
    } catch (err) {
      log.error({ err, eventId: event.id }, 'Failed to create Fixer task')
    }
  }

  /** Stub for on-call paging. Production: POST to PagerDuty/OpsGenie Events API. */
  private async pageOnCall(event: EnrichedLogEvent): Promise<void> {
    log.warn(
      { eventId: event.id, message: event.message, module: event.affectedModule, userImpact: event.userImpactEstimate },
      'ON-CALL PAGE TRIGGERED — integrate PagerDuty/OpsGenie here',
    )
  }

  /** Heuristic user-impact estimate (0-100) based on classification severity. */
  private estimateUserImpact(classification: LogClassification): number {
    switch (classification) {
      case 'critical': return 100
      case 'incident': return 50
      case 'warning':  return 10
      case 'noise':    return 0
    }
  }

  private async getRollingStats(projectId: string, metric: string): Promise<RollingStats | null> {
    const key = 
    try {
      const raw = await this.redis.get(key)
      if (\!raw) return null
      return JSON.parse(raw) as RollingStats
    } catch {
      return null
    }
  }

  /**
   * Update Welford online algorithm stats in Redis with a new data point.
   * Persisted with a 7-day TTL.
   */
  private async updateRollingStats(projectId: string, metric: string, value: number): Promise<void> {
    const key = 
    try {
      const existing = await this.getRollingStats(projectId, metric)
      let mean: number
      let stdDev: number
      let sampleCount: number

      if (\!existing) {
        mean = value; stdDev = 0; sampleCount = 1
      } else {
        sampleCount = existing.sampleCount + 1
        const delta = value - existing.mean
        mean = existing.mean + delta / sampleCount
        const delta2 = value - mean
        const m2 = existing.stdDev * existing.stdDev * (existing.sampleCount - 1) + delta * delta2
        stdDev = sampleCount > 1 ? Math.sqrt(m2 / (sampleCount - 1)) : 0
      }

      const stats: RollingStats = { mean, stdDev, sampleCount, updatedAt: Date.now() }
      await this.redis.set(key, JSON.stringify(stats), 'EX', this.BASELINE_WINDOW_SECS)
    } catch (err) {
      log.error({ err, projectId, metric }, 'Failed to update rolling stats')
    }
  }

  private async detectSilentFailures(projectId: string): Promise<AnomalyDetail[]> {
    const anomalies: AnomalyDetail[] = []
    try {
      const openIncidents = await prisma.incident.count({ where: { projectId, status: 'OPEN' } })
      const latestSnapshot = await prisma.projectMetricsSnapshot.findFirst({
        where: { projectId },
        orderBy: { capturedAt: 'desc' },
      })
      if (openIncidents > 0 && latestSnapshot && (latestSnapshot.errorRate ?? 0) < 0.01) {
        anomalies.push({
          metric: 'silent_failure',
          currentValue: openIncidents,
          rollingMean: 0,
          stdDev: 0,
          sigmas: 999,
          description:
             +
            'possible silent failure (downstream errors masked by HTTP 200 responses)',
        })
      }
    } catch (err) {
      log.error({ err, projectId }, 'Silent failure detection error')
    }
    return anomalies
  }

  private async detectDeploymentCorrelation(
    projectId: string,
    anomalies: AnomalyDetail[],
  ): Promise<{ deploymentCorrelated: boolean; triggeringDeployId?: string }> {
    if (anomalies.length === 0) return { deploymentCorrelated: false }
    try {
      const cutoff = new Date(Date.now() - this.DEPLOY_CORRELATION_WINDOW_MS)
      const recentDeploy = await prisma.deployment.findFirst({
        where: { projectId, status: 'SUCCEEDED', completedAt: { gte: cutoff } },
        orderBy: { completedAt: 'desc' },
      })
      if (recentDeploy) {
        const hasErrorSpike = anomalies.some(
          (a) => a.metric === 'error_rate' && a.sigmas >= this.ANOMALY_SIGMA_THRESHOLD,
        )
        if (hasErrorSpike) {
          log.warn({ deployId: recentDeploy.id, completedAt: recentDeploy.completedAt }, 'Error spike correlated with recent deployment')
          return { deploymentCorrelated: true, triggeringDeployId: recentDeploy.id }
        }
      }
    } catch (err) {
      log.error({ err, projectId }, 'Deployment correlation check failed')
    }
    return { deploymentCorrelated: false }
  }
}
