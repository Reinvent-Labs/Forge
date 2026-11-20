import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@forge/shared', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  signApprovalToken: vi.fn(),
  verifyApprovalToken: vi.fn(),
}))

vi.mock('@forge/database', () => ({
  prisma: {
    approvalRequest: { findFirst: vi.fn(), updateMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    agentTask: { update: vi.fn() },
    user: { findUnique: vi.fn(), findFirst: vi.fn() },
  },
}))

vi.mock('@forge/auth', () => ({
  getUserRole: vi.fn(),
  hasPermission: vi.fn(),
}))

import { verifyApprovalToken } from '@forge/shared'
import { prisma } from '@forge/database'
import { getUserRole, hasPermission } from '@forge/auth'
import { ApprovalGateway } from './approval-gateway.js'

const ORG = 'org-1'
const PROJECT = 'proj-1'

function pendingRecord(riskLevel = 'CRITICAL') {
  return {
    id: 'appr-1',
    taskId: 'task-1',
    projectId: PROJECT,
    riskLevel,
    status: 'PENDING',
    expiresAt: new Date(Date.now() + 60_000),
    project: { organizationId: ORG },
  }
}

describe('ApprovalGateway.processToken', () => {
  let gateway: ApprovalGateway

  beforeEach(() => {
    vi.clearAllMocks()
    gateway = new ApprovalGateway()
    vi.mocked(verifyApprovalToken).mockResolvedValue({
      approvalId: 'x',
      action: 'approve',
      projectId: PROJECT,
      organizationId: ORG,
    } as never)
    vi.mocked(prisma.approvalRequest.findFirst).mockResolvedValue(pendingRecord() as never)
    vi.mocked(prisma.user.findFirst).mockResolvedValue({ id: 'user-1' } as never)
    vi.mocked(getUserRole).mockResolvedValue('OWNER')
    vi.mocked(hasPermission).mockReturnValue(true)
    vi.mocked(prisma.approvalRequest.updateMany).mockResolvedValue({ count: 1 } as never)
  })

  it('rejects approvers not linked to a Forge account', async () => {
    await expect(gateway.processToken('tok', { displayName: 'bob' })).rejects.toThrow(
      'not linked to a Forge account',
    )
    vi.mocked(prisma.user.findFirst).mockResolvedValue(null)
    await expect(
      gateway.processToken('tok', { email: 'bob@example.com', displayName: 'bob' }),
    ).rejects.toThrow('not linked to a Forge account')
    expect(prisma.approvalRequest.updateMany).not.toHaveBeenCalled()
  })

  it('rejects non-members and members without the risk-level permission', async () => {
    vi.mocked(getUserRole).mockResolvedValueOnce(null)
    await expect(
      gateway.processToken('tok', { email: 'bob@example.com', displayName: 'bob' }),
    ).rejects.toThrow("'task:approve_critical'")

    vi.mocked(getUserRole).mockResolvedValueOnce('ADMIN')
    vi.mocked(hasPermission).mockReturnValueOnce(false)
    await expect(
      gateway.processToken('tok', { email: 'bob@example.com', displayName: 'bob' }),
    ).rejects.toThrow("'task:approve_critical'")
    expect(hasPermission).toHaveBeenCalledWith('ADMIN', 'task:approve_critical')
    expect(prisma.approvalRequest.updateMany).not.toHaveBeenCalled()
  })

  it('rejects tokens issued for a different organization', async () => {
    vi.mocked(verifyApprovalToken).mockResolvedValue({
      approvalId: 'x',
      action: 'approve',
      projectId: PROJECT,
      organizationId: 'other-org',
    } as never)
    await expect(
      gateway.processToken('tok', { email: 'alice@example.com', displayName: 'alice' }),
    ).rejects.toThrow('does not match')
  })

  it('approves with a conditional update and emits once', async () => {
    const approved = vi.fn()
    gateway.on('approved', approved)

    const result = await gateway.processToken('tok', {
      email: 'alice@example.com',
      displayName: 'alice',
    })

    expect(result).toEqual({ action: 'approve', approvalId: 'appr-1' })
    expect(prisma.approvalRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'appr-1', status: 'PENDING', approveToken: 'tok' }),
        data: expect.objectContaining({ status: 'APPROVED', approvedById: 'user-1' }),
      }),
    )
    expect(prisma.agentTask.update).toHaveBeenCalledWith({
      where: { id: 'task-1' },
      data: { status: 'APPROVED' },
    })
    expect(approved).toHaveBeenCalledWith('appr-1', 'task-1', 'user-1')
  })

  it('lets only one of two concurrent calls resolve the approval', async () => {
    vi.mocked(prisma.approvalRequest.updateMany)
      .mockResolvedValueOnce({ count: 1 } as never)
      .mockResolvedValueOnce({ count: 0 } as never)
    const approved = vi.fn()
    gateway.on('approved', approved)

    const results = await Promise.allSettled([
      gateway.processToken('tok', { email: 'alice@example.com', displayName: 'alice' }),
      gateway.processToken('tok', { email: 'alice@example.com', displayName: 'alice' }),
    ])

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1)
    expect(prisma.agentTask.update).toHaveBeenCalledTimes(1)
    expect(approved).toHaveBeenCalledTimes(1)
  })
})
