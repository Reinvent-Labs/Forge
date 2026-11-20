/**
 * Forge Orchestrator — Main Entry Point
 *
 * The central nervous system of the Forge platform.
 * Receives events from all sources, routes to agents, manages approvals,
 * and publishes results to the event bus.
 */

import { createLogger } from '@forge/shared'
import type { AgentTask, ForgeEvent } from '@forge/shared'
import { prisma } from '@forge/database'
import { EventBus } from './event-bus.js'
import { AgentRouter } from './router.js'
import { ContextManager } from './context-manager.js'
import { ConfidenceEngine } from './confidence-engine.js'
import { ApprovalGateway } from './approval-gateway.js'
import IORedis from 'ioredis'

const log = createLogger('orchestrator')

// ---------------------------------------------------------------------------
// Orchestrator class
// ---------------------------------------------------------------------------

export class Orchestrator {
  readonly eventBus: EventBus
  readonly router: AgentRouter
  readonly contextManager: ContextManager
  readonly confidenceEngine: ConfidenceEngine
  readonly approvalGateway: ApprovalGateway
  private redis: IORedis

  constructor() {
    const redisUrl = process.env['REDIS_URL'] ?? 'redis://localhost:6379'
    this.redis = new IORedis(redisUrl, {
      maxRetriesPerRequest: null,  // required for BullMQ
      enableReadyCheck: false,
    })

    this.eventBus = new EventBus(this.redis)
    this.router = new AgentRouter()
    this.contextManager = new ContextManager()
    this.confidenceEngine = new ConfidenceEngine()
    this.approvalGateway = new ApprovalGateway()

    this.bindApprovalEvents()
    log.info('Orchestrator initialized')
  }

  /**
   * The main entry point for any new task.
   * Called by: webhook handlers, dashboard API, CLI, Slack/Telegram adapter.
   *
   * @param task - The task to process (must have projectId and organizationId)
   * @returns The task ID (already persisted to DB before returning)
   */
  async processTask(task: Omit<AgentTask, 'id' | 'createdAt'>): Promise<string> {
    // 1. Persist task to DB
    const project = await prisma.project.findUnique({
      where: { id: task.projectId },
      select: { autonomyLevel: true, name: true },
    })

    if (!project) {
      throw new Error(`Project not found: ${task.projectId}`)
    }

    const dbTask = await prisma.agentTask.create({
      data: {
        projectId: task.projectId,
        type: task.type.toUpperCase() as never,
        priority: task.priority.toUpperCase() as never,
        status: 'QUEUED',
        agentType: 'ORCHESTRATOR',
        requestedBy: task.requestedBy.toUpperCase() as never,
        requestedByUser: task.requestedByUserId ?? undefined,
        autonomyLevel: (project.autonomyLevel) as never,
        payload: task.payload,
      },
    })

    const fullTask: AgentTask = {
      ...task,
      id: dbTask.id,
      autonomyLevel: project.autonomyLevel.toLowerCase() as AgentTask['autonomyLevel'],
      createdAt: dbTask.createdAt,
    }

    log.info(
      { taskId: dbTask.id, taskType: task.type, projectId: task.projectId },
      'Task created',
    )

    // 2. Route to agent
    const routing = this.router.route(fullTask)

    // 3. Enrich with context if needed (code tasks)
    if (this.isCodeTask(task.type)) {
      const taskDescription = (task.payload['description'] as string) ?? task.type
      const contextPrompt = await this.contextManager.buildContextPrompt(
        task.projectId,
        taskDescription,
      )
      ;(fullTask.payload as Record<string, unknown>)['contextPrompt'] = contextPrompt
    }

    // 4. Gate through approval if required
    if (routing.requiresApproval) {
      await this.approvalGateway.createApproval({
        task: fullTask,
        title: this.buildApprovalTitle(fullTask),
        businessImpact: this.buildBusinessImpact(fullTask),
        technicalDetails: JSON.stringify(task.payload, null, 2).substring(0, 1000),
        confidenceScore: {
          total: 70,
          breakdown: {
            testCoverage: 14,
            moduleStability: 12,
            ciPassing: 16,
            stagingStability: 14,
            securityClean: 10,
            deployTiming: 10,
          },
          recommendation: 'recommend',
          humanReadableSummary: 'Action requires human review before proceeding.',
          riskFactors: [`Risk level: ${routing.riskLevel}`],
        },
        riskLevel: routing.riskLevel,
      })

      // Publish event for real-time dashboard notification
      await this.publishEvent({
        type: 'approval.created',
        projectId: task.projectId,
        organizationId: task.organizationId,
        payload: { taskId: dbTask.id, title: this.buildApprovalTitle(fullTask) },
      })

      return dbTask.id
    }

    // 5. Dispatch to agent queue
    await this.eventBus.dispatch(fullTask, routing.agentType)

    return dbTask.id
  }

  /**
   * Publish a platform event to the event bus.
   * Used for real-time dashboard updates via WebSocket.
   */
  async publishEvent<T>(
    event: Omit<ForgeEvent<T>, 'id' | 'timestamp'>,
  ): Promise<void> {
    const fullEvent: ForgeEvent<T> = {
      ...event,
      id: crypto.randomUUID(),
      timestamp: new Date(),
    }
    await this.eventBus.publishEvent(fullEvent)
  }

  /**
   * Handle approved task: dispatch to agent queue.
   */
  private async onApprovalApproved(
    approvalId: string,
    taskId: string,
  ): Promise<void> {
    log.info({ approvalId, taskId }, 'Approval granted — dispatching task')

    const dbTask = await prisma.agentTask.findUnique({
      where: { id: taskId },
      include: { project: true },
    })

    if (!dbTask) {
      log.error({ taskId }, 'Task not found after approval')
      return
    }

    const task: AgentTask = {
      id: dbTask.id,
      type: dbTask.type.toLowerCase() as AgentTask['type'],
      priority: dbTask.priority.toLowerCase() as AgentTask['priority'],
      projectId: dbTask.projectId,
      organizationId: dbTask.project.organizationId,
      payload: dbTask.payload as Record<string, unknown>,
      requestedBy: dbTask.requestedBy.toLowerCase() as AgentTask['requestedBy'],
      requestedByUserId: dbTask.requestedByUser ?? undefined,
      autonomyLevel: dbTask.autonomyLevel.toLowerCase() as AgentTask['autonomyLevel'],
      createdAt: dbTask.createdAt,
    }

    const routing = this.router.route(task)
    await this.eventBus.dispatch(task, routing.agentType)
  }

  /**
   * Wire up approval gateway events to task dispatch.
   */
  private bindApprovalEvents(): void {
    this.approvalGateway.on('approved', (approvalId: string, taskId: string) => {
      void this.onApprovalApproved(approvalId, taskId)
    })

    this.approvalGateway.on('rejected', (approvalId: string, taskId: string) => {
      log.info({ approvalId, taskId }, 'Task rejected by founder')
    })

    this.approvalGateway.on('expired', (approvalId: string, taskId: string) => {
      log.warn({ approvalId, taskId }, 'Approval expired — task cancelled')
    })
  }

  private isCodeTask(type: AgentTask['type']): boolean {
    return [
      'build_feature',
      'fix_bug',
      'fix_incident',
      'refactor',
      'generate_tests',
    ].includes(type)
  }

  private buildApprovalTitle(task: AgentTask): string {
    const descriptions: Record<string, string> = {
      build_feature: `Build: ${(task.payload['description'] as string) ?? 'new feature'}`,
      fix_bug: `Fix: ${(task.payload['description'] as string) ?? 'bug'}`,
      fix_incident: `Incident fix: ${(task.payload['title'] as string) ?? 'production issue'}`,
      deploy: `Deploy to ${(task.payload['environment'] as string) ?? 'production'}`,
      rollback: `Rollback ${(task.payload['environment'] as string) ?? 'production'}`,
      security_patch: `Security patch: ${(task.payload['description'] as string) ?? 'vulnerability'}`,
    }
    return descriptions[task.type] ?? `${task.type.replace(/_/g, ' ')}`
  }

  private buildBusinessImpact(task: AgentTask): string {
    const impacts: Record<string, string> = {
      build_feature: 'Adding a new capability to your product.',
      fix_bug: 'Fixing a bug that may be affecting users.',
      fix_incident: 'Resolving an active production incident.',
      deploy: 'Releasing code changes to users.',
      rollback: 'Reverting recent changes to restore stability.',
      security_patch: 'Fixing a security vulnerability to protect user data.',
    }
    return (
      (task.payload['businessImpact'] as string) ??
      impacts[task.type] ??
      'This action will modify your production environment.'
    )
  }

  async close(): Promise<void> {
    await this.eventBus.close()
    await prisma.$disconnect()
    this.redis.disconnect()
    log.info('Orchestrator closed')
  }
}

// Singleton instance for the process
export let orchestrator: Orchestrator

export function initOrchestrator(): Orchestrator {
  orchestrator = new Orchestrator()
  return orchestrator
}

// Re-export sub-modules
export { EventBus } from './event-bus.js'
export { AgentRouter } from './router.js'
export { ContextManager } from './context-manager.js'
export { ConfidenceEngine } from './confidence-engine.js'
export { ApprovalGateway } from './approval-gateway.js'
export type { ApproverIdentity } from './approval-gateway.js'
