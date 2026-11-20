import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import {
  approvalPermissions,
  isUuid,
  notFound,
  requireProjectMember,
  requireProjectPermissions,
} from '@/lib/project-access'

/**
 * POST /api/projects/[id]/approvals/[approvalId]/approve
 * Marks the given approval request as APPROVED.
 * Only pending, unexpired requests can be approved, and the caller needs
 * approval:approve plus the task:approve_<risk> permission for the request's risk level.
 */
export async function POST(
  _request: Request,
  { params }: { params: { id: string; approvalId: string } }
) {
  try {
    const access = await requireProjectMember(params.id)
    if (!access.ok) return access.response
    const projectId = access.project.id

    if (!isUuid(params.approvalId)) return notFound()

    const approval = await prisma.approvalRequest.findFirst({
      where: { id: params.approvalId, projectId },
      select: { id: true, riskLevel: true },
    })
    if (!approval) return notFound()

    const denied = await requireProjectPermissions(
      access,
      approvalPermissions('approval:approve', approval.riskLevel),
    )
    if (denied) return denied

    const now = new Date()
    const { count } = await prisma.approvalRequest.updateMany({
      where: {
        id: approval.id,
        projectId,
        riskLevel: approval.riskLevel,
        status: 'PENDING',
        expiresAt: { gt: now },
      },
      data: {
        status: 'APPROVED',
        approvedAt: now,
        approvedById: access.userId,
      },
    })
    if (count === 0) return notFound()

    const updated = await prisma.approvalRequest.findUniqueOrThrow({
      where: { id: approval.id },
      include: { task: { select: { prUrl: true } } },
    })

    const cs = updated.confidenceScore as {
      total?: number
      riskFactors?: string[]
    } | null

    return NextResponse.json({
      approval: {
        id: updated.id,
        title: updated.title,
        agentType: updated.agentType.toLowerCase(),
        businessImpact: updated.businessImpact,
        technicalSummary: updated.technicalDetails,
        riskLevel: updated.riskLevel.toLowerCase(),
        confidenceScore: cs?.total ?? 0,
        riskFactors: cs?.riskFactors ?? [],
        expiresAt: updated.expiresAt.toISOString(),
        status: 'approved',
        prUrl: updated.task.prUrl ?? undefined,
        createdAt: updated.createdAt.toISOString(),
        resolvedAt: updated.approvedAt?.toISOString(),
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
