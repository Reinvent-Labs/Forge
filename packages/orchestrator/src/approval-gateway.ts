/**
 * Approval Gateway
 *
 * Human-in-the-loop for risky agent actions.
 * - Creates ApprovalRequest records with signed JWT tokens
 * - Sends notifications via configured channels
 * - Handles approve/reject with token verification
 * - Auto-expires after 24h
 * - Emits events on resolution so waiting tasks can proceed
 */

import { EventEmitter } from 'events'
import { createLogger, signApprovalToken, verifyApprovalToken } from '@forge/shared'
import type {
  ApprovalRequest,
  AgentTask,
  ConfidenceScore,
  NotificationChannel,
  RiskLevel,
} from '@forge/shared'
import { prisma } from '@forge/database'
import { getUserRole, hasPermission } from '@forge/auth'

const log = createLogger('approval-gateway')

export interface CreateApprovalOptions {
  task: AgentTask
  title: string
  businessImpact: string
  technicalDetails: string
  confidenceScore: ConfidenceScore
  riskLevel: RiskLevel
  previewUrl?: string
}

/**
 * Identity of the person acting on an approval. Platform adapters must map
 * their user (e.g. Slack/Telegram) to a Forge account via `userId` or `email`.
 */
export interface ApproverIdentity {
  userId?: string
  email?: string
  displayName: string
}

/** Permission required to approve an action at each risk level. */
const APPROVE_PERMISSION_BY_RISK: Record<string, string> = {
  LOW: 'task:approve_medium',
  MEDIUM: 'task:approve_medium',
  HIGH: 'task:approve_high',
  CRITICAL: 'task:approve_critical',
}

// Events emitted by the gateway
export interface ApprovalGatewayEvents {
  approved: (approvalId: string, taskId: string, approvedBy: string) => void
  rejected: (approvalId: string, taskId: string, reason?: string) => void
  expired: (approvalId: string, taskId: string) => void
}

export class ApprovalGateway extends EventEmitter {
  /**
   * Create an approval request for a risky action.
   * Returns the request with signed tokens for one-click approve/reject.
   */
  async createApproval(options: CreateApprovalOptions): Promise<ApprovalRequest> {
    const { task, title, businessImpact, technicalDetails, confidenceScore, riskLevel } = options

    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000) // 24h

    // Sign one-time approval tokens
    const [approveToken, rejectToken] = await Promise.all([
      signApprovalToken({
        approvalId: crypto.randomUUID(),
        action: 'approve',
        projectId: task.projectId,
        organizationId: task.organizationId,
      }),
      signApprovalToken({
        approvalId: crypto.randomUUID(),
        action: 'reject',
        projectId: task.projectId,
        organizationId: task.organizationId,
      }),
    ])

    // Persist to database
    const record = await prisma.approvalRequest.create({
      data: {
        projectId: task.projectId,
        taskId: task.id,
        agentType: task.type.toUpperCase() as never,  // mapped to enum
        title,
        businessImpact,
        technicalDetails,
        confidenceScore: confidenceScore as never,
        riskLevel: riskLevel.toUpperCase() as never,
        expiresAt,
        approveToken,
        rejectToken,
        status: 'PENDING',
      },
      include: {
        project: {
          select: { name: true, notificationConfig: true },
        },
      },
    })

    // Update task status
    await prisma.agentTask.update({
      where: { id: task.id },
      data: { status: 'AWAITING_APPROVAL' },
    })

    log.info(
      { approvalId: record.id, taskId: task.id, riskLevel, projectId: task.projectId },
      'Approval request created',
    )

    const approval: ApprovalRequest = {
      id: record.id,
      projectId: record.projectId,
      organizationId: task.organizationId,
      agentType: task.type as never,
      taskId: record.taskId,
      title: record.title,
      businessImpact: record.businessImpact,
      technicalDetails: record.technicalDetails,
      confidenceScore: record.confidenceScore as unknown as ConfidenceScore,
      riskLevel: riskLevel,
      expiresAt: record.expiresAt,
      notificationsSent: [] as NotificationChannel[],
      status: 'pending',
      approveToken: record.approveToken,
      rejectToken: record.rejectToken,
    }

    return approval
  }

  /**
   * Process an approval action via signed token.
   * Called from Slack/Telegram webhooks or dashboard.
   *
   * Returns the updated approval request.
   */
  async processToken(
    token: string,
    approver: ApproverIdentity,
    rejectionReason?: string,
  ): Promise<{ action: 'approve' | 'reject'; approvalId: string }> {
    // Verify JWT signature and expiry
    let payload: Awaited<ReturnType<typeof verifyApprovalToken>>
    try {
      payload = await verifyApprovalToken(token)
    } catch (err) {
      log.warn({ error: (err as Error).message }, 'Invalid or expired approval token')
      throw new Error('Invalid or expired approval token')
    }

    // Look up the approval request by token (exact match)
    const field = payload.action === 'approve' ? 'approveToken' : 'rejectToken'
    const record = await prisma.approvalRequest.findFirst({
      where: { [field]: token, status: 'PENDING' },
      include: { project: { select: { organizationId: true } } },
    })

    if (!record) {
      throw new Error('Approval request not found or already resolved')
    }

    const organizationId = record.project.organizationId
    if (payload.organizationId !== organizationId || payload.projectId !== record.projectId) {
      throw new Error('Approval token does not match this approval request')
    }

    if (record.expiresAt < new Date()) {
      await this.expireApproval(record.id)
      throw new Error('Approval request has expired')
    }

    const userId = await this.authorizeApprover(
      approver,
      organizationId,
      payload.action === 'approve'
        ? APPROVE_PERMISSION_BY_RISK[record.riskLevel] ?? 'task:approve_critical'
        : 'approval:reject',
    )

    // Resolve the approval atomically: only one concurrent caller can move it out of PENDING
    const status = payload.action === 'approve' ? 'APPROVED' : 'REJECTED'
    const now = new Date()
    const { count } = await prisma.approvalRequest.updateMany({
      where: { id: record.id, status: 'PENDING', [field]: token, expiresAt: { gt: now } },
      data: {
        status,
        approvedAt: now,
        approvedById: userId,
        rejectionReason: rejectionReason ?? null,
      },
    })

    if (count !== 1) {
      throw new Error('Approval request not found or already resolved')
    }

    // Update task status
    await prisma.agentTask.update({
      where: { id: record.taskId },
      data: { status },
    })

    log.info(
      {
        approvalId: record.id,
        taskId: record.taskId,
        action: payload.action,
        approvedBy: userId,
        approverName: approver.displayName,
      },
      'Approval resolved',
    )

    if (payload.action === 'approve') {
      this.emit('approved', record.id, record.taskId, userId)
    } else {
      this.emit('rejected', record.id, record.taskId, rejectionReason)
    }

    return { action: payload.action, approvalId: record.id }
  }

  /**
   * Map the approver to a Forge member of the organization and require the
   * given permission. Returns the Forge user ID.
   */
  private async authorizeApprover(
    approver: ApproverIdentity,
    organizationId: string,
    permission: string,
  ): Promise<string> {
    const user = approver.userId
      ? await prisma.user.findUnique({ where: { id: approver.userId }, select: { id: true } })
      : approver.email
        ? await prisma.user.findFirst({
            where: { email: { equals: approver.email, mode: 'insensitive' } },
            select: { id: true },
          })
        : null

    if (!user) {
      log.warn({ approverName: approver.displayName }, 'Approver is not linked to a Forge account')
      throw new Error('You are not linked to a Forge account')
    }

    const role = await getUserRole(user.id, organizationId)
    if (!role || !hasPermission(role, permission)) {
      log.warn(
        { userId: user.id, organizationId, permission, role },
        'Approver lacks permission for approval action',
      )
      throw new Error(`You do not have the '${permission}' permission for this approval`)
    }

    return user.id
  }

  /**
   * Mark approval as expired. Called by the expiry cron job.
   */
  async expireApproval(approvalId: string): Promise<void> {
    const record = await prisma.approvalRequest.findUnique({
      where: { id: approvalId },
    })

    if (!record || record.status !== 'PENDING') return

    await prisma.approvalRequest.update({
      where: { id: approvalId },
      data: { status: 'EXPIRED' },
    })

    await prisma.agentTask.update({
      where: { id: record.taskId },
      data: { status: 'CANCELLED' },
    })

    this.emit('expired', approvalId, record.taskId)
    log.info({ approvalId, taskId: record.taskId }, 'Approval expired')
  }

  /**
   * Expire all overdue pending approvals.
   * Call this every 15 minutes via cron.
   */
  async expireOverdueApprovals(): Promise<number> {
    const overdue = await prisma.approvalRequest.findMany({
      where: { status: 'PENDING', expiresAt: { lt: new Date() } },
      select: { id: true },
    })

    await Promise.all(overdue.map((r) => this.expireApproval(r.id)))

    if (overdue.length > 0) {
      log.info({ count: overdue.length }, 'Expired overdue approvals')
    }

    return overdue.length
  }

  /**
   * Get pending approvals for a project (for dashboard queue).
   */
  async getPendingApprovals(projectId: string): Promise<typeof result> {
    const result = await prisma.approvalRequest.findMany({
      where: { projectId, status: 'PENDING' },
      orderBy: { expiresAt: 'asc' },
      include: {
        task: { select: { type: true, priority: true } },
      },
    })
    return result
  }
}
