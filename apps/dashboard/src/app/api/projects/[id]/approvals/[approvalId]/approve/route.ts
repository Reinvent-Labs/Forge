import { NextResponse } from 'next/server'
import { getServerSession } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

/**
 * POST /api/projects/[id]/approvals/[approvalId]/approve
 * Marks the given approval request as APPROVED.
 */
export async function POST(
  _request: Request,
  { params }: { params: { id: string; approvalId: string } }
) {
  try {
    const session = await getServerSession()
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const updated = await prisma.approvalRequest.update({
      where: {
        id: params.approvalId,
        projectId: params.id,
      },
      data: {
        status: 'APPROVED',
        approvedAt: new Date(),
        approvedById: session.user.id,
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
