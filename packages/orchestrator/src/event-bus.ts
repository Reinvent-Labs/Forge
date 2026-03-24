/**
 * Forge Event Bus
 *
 * Built on BullMQ (Redis-backed queues). One queue per agent type.
 * Features:
 * - Dead letter queue for failed jobs
 * - Exponential backoff retry (3 attempts, max 1h delay)
 * - All job results persisted to PostgreSQL for audit trail
 * - Pub/sub for real-time dashboard updates via Socket.io
 */

import { Queue, Worker, QueueEvents, type Job, type JobsOptions } from 'bullmq'
import { createLogger } from '@forge/shared'
import type { AgentType, AgentTask, ForgeEvent, ForgeEventType } from '@forge/shared'
import { prisma } from '@forge/database'
import type { Redis } from 'ioredis'

const log = createLogger('event-bus')

// ---------------------------------------------------------------------------
// Queue names (one per agent type + shared queues)
// ---------------------------------------------------------------------------

export const QUEUE_NAMES = {
  builder: 'forge:agent:builder',
  watcher: 'forge:agent:watcher',
  fixer: 'forge:agent:fixer',
  security: 'forge:agent:security',
  devops: 'forge:agent:devops',
  intent: 'forge:agent:intent',
  debt: 'forge:agent:debt',
  onboarding: 'forge:agent:onboarding',
  orchestrator: 'forge:orchestrator',
  deadLetter: 'forge:dead-letter',
  events: 'forge:events',           // pub/sub for dashboard
} as const satisfies Record<string, string>

// ---------------------------------------------------------------------------
// Job options
// ---------------------------------------------------------------------------

const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: {
    type: 'exponential',
    delay: 5_000,        // 5s initial, doubles each retry → max ~20min after 3 attempts
  },
  removeOnComplete: { age: 86_400 },   // keep completed jobs for 24h
  removeOnFail: false,                  // keep failed jobs for investigation
}

const PRIORITY_DELAYS: Record<string, number> = {
  critical: 0,
  high: 0,
  normal: 100,
  low: 1000,
}

// ---------------------------------------------------------------------------
// EventBus class
// ---------------------------------------------------------------------------

export class EventBus {
  private queues: Map<string, Queue> = new Map()
  private queueEvents: Map<string, QueueEvents> = new Map()
  private redis: Redis

  constructor(redis: Redis) {
    this.redis = redis
    this.initQueues()
  }

  private initQueues(): void {
    const connection = this.redis

    for (const [name, queueName] of Object.entries(QUEUE_NAMES)) {
      const queue = new Queue(queueName, {
        connection,
        defaultJobOptions: DEFAULT_JOB_OPTIONS,
      })

      this.queues.set(name, queue)

      // QueueEvents for monitoring
      const queueEvents = new QueueEvents(queueName, { connection })
      this.queueEvents.set(name, queueEvents)

      queueEvents.on('completed', ({ jobId }) => {
        log.debug({ queueName, jobId }, 'Job completed')
      })

      queueEvents.on('failed', ({ jobId, failedReason }) => {
        log.error({ queueName, jobId, failedReason }, 'Job failed')
        void this.moveToDeadLetter(queueName, jobId, failedReason)
      })
    }

    log.info({ queues: Object.keys(QUEUE_NAMES) }, 'Event bus initialized')
  }

  /**
   * Dispatch an agent task to the appropriate queue.
   * Priority maps to BullMQ job priority (1=highest).
   */
  async dispatch(task: AgentTask, agentType: AgentType): Promise<string> {
    const queueKey = agentType as keyof typeof QUEUE_NAMES
    const queue = this.queues.get(queueKey)

    if (!queue) {
      throw new Error(`No queue registered for agent type: ${agentType}`)
    }

    const priorityMap = { critical: 1, high: 2, normal: 3, low: 4 }
    const delay = PRIORITY_DELAYS[task.priority] ?? 0

    const job = await queue.add(task.type, task, {
      ...DEFAULT_JOB_OPTIONS,
      jobId: task.id,
      priority: priorityMap[task.priority] ?? 3,
      delay,
    })

    log.info(
      { taskId: task.id, taskType: task.type, agentType, projectId: task.projectId },
      'Task dispatched to queue',
    )

    return job.id ?? task.id
  }

  /**
   * Publish a platform event (for real-time dashboard updates).
   * Events are consumed by the WebSocket broadcaster.
   */
  async publishEvent<T>(event: ForgeEvent<T>): Promise<void> {
    const queue = this.queues.get('events')
    if (!queue) return

    await queue.add(event.type, event, {
      removeOnComplete: { age: 3600 },  // events only needed for 1h
      removeOnFail: { age: 3600 },
    })
  }

  /**
   * Register a worker for an agent queue.
   * The worker's process function receives raw BullMQ jobs.
   */
  registerWorker(
    agentType: AgentType,
    processor: (job: Job<AgentTask>) => Promise<unknown>,
    concurrency = 2,
  ): Worker<AgentTask> {
    const queueName = QUEUE_NAMES[agentType as keyof typeof QUEUE_NAMES]

    if (!queueName) {
      throw new Error(`No queue for agent type: ${agentType}`)
    }

    const worker = new Worker(queueName, processor, {
      connection: this.redis,
      concurrency,
    })

    worker.on('completed', (job, result) => {
      log.info(
        { jobId: job.id, taskType: job.name, agentType },
        'Worker completed job',
      )
      void this.persistJobResult(job, 'completed', result)
    })

    worker.on('failed', (job, error) => {
      log.error(
        { jobId: job?.id, taskType: job?.name, agentType, error: error.message },
        'Worker failed job',
      )
      if (job) {
        void this.persistJobResult(job, 'failed', null, error.message)
      }
    })

    log.info({ agentType, concurrency }, 'Worker registered')
    return worker
  }

  /**
   * Persist job results to the audit log for compliance and debugging.
   */
  private async persistJobResult(
    job: Job<AgentTask>,
    outcome: 'completed' | 'failed',
    result: unknown,
    errorMessage?: string,
  ): Promise<void> {
    try {
      const task = job.data
      const durationMs = job.processedOn
        ? Date.now() - job.processedOn
        : undefined

      await prisma.agentTask.update({
        where: { id: task.id },
        data: {
          status: outcome === 'completed' ? 'COMPLETED' : 'FAILED',
          result: result as Record<string, unknown> ?? undefined,
          errorMessage: errorMessage,
          completedAt: new Date(),
          durationMs,
        },
      })

      await prisma.auditLog.create({
        data: {
          projectId: task.projectId,
          organizationId: task.organizationId,
          actor: `agent:${job.name}:${task.id}`,
          actorType: 'agent',
          action: `task.${outcome}`,
          resourceType: 'agent_task',
          resourceId: task.id,
          outcome,
          durationMs,
          metadata: { taskType: task.type, agentType: job.queueName },
        },
      })
    } catch (err) {
      // Don't throw from audit persistence — log and continue
      log.error({ error: (err as Error).message }, 'Failed to persist job result')
    }
  }

  /**
   * Move a failed job to the dead letter queue for manual inspection.
   */
  private async moveToDeadLetter(
    sourceQueue: string,
    jobId: string,
    reason: string,
  ): Promise<void> {
    try {
      const dlq = this.queues.get('deadLetter')
      if (!dlq) return

      await dlq.add('dead-letter', { sourceQueue, jobId, reason, timestamp: new Date() })
    } catch (err) {
      log.error({ error: (err as Error).message }, 'Failed to move job to dead letter queue')
    }
  }

  /**
   * Get queue metrics for all agent queues (for health monitoring).
   */
  async getQueueMetrics(): Promise<Record<string, { waiting: number; active: number; failed: number }>> {
    const metrics: Record<string, { waiting: number; active: number; failed: number }> = {}

    for (const [name, queue] of this.queues.entries()) {
      if (name === 'events' || name === 'deadLetter') continue
      const counts = await queue.getJobCounts('waiting', 'active', 'failed')
      metrics[name] = {
        waiting: counts.waiting ?? 0,
        active: counts.active ?? 0,
        failed: counts.failed ?? 0,
      }
    }

    return metrics
  }

  async close(): Promise<void> {
    for (const queue of this.queues.values()) {
      await queue.close()
    }
    for (const qe of this.queueEvents.values()) {
      await qe.close()
    }
    log.info('Event bus closed')
  }
}
