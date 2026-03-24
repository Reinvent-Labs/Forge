import { NextResponse } from 'next/server'
import { getServerSession } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

/**
 * POST /api/projects/[id]/approvals/[approvalId]/reject
 * Marks the given approval request as REJECTED.
 *
 * Body: { reason: string }
 */
export async function POST(
  request: Request,
  { params }: { params: { id: string; approvalId: string } }
) {
  try {
    const session = await getServerSession()
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json().catch(() => ({})) as { reason?: string }
    const reason = body.reason ?? ''

    const updated = await prisma.approvalRequest.update({
      where: {
        id: params.approvalId,
        projectId: params.id,
      },
      data: {
        status: 'REJECTED',
        rejectionReason: reason,
      },
      include: { task: true },
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
        status: 'rejected',
        prUrl: updated.task.prUrl ?? undefined,
        createdAt: updated.createdAt.toISOString(),
        resolvedAt: updated.updatedAt.toISOString(),
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
