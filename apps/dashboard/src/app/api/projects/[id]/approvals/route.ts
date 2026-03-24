import { NextResponse } from 'next/server'
import { getServerSession } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import type { ApprovalStatus } from '@prisma/client'

/**
 * GET /api/projects/[id]/approvals
 * Returns approval requests for the given project.
 *
 * Query params:
 *   ?status=pending|approved|rejected  — filter by status (defaults to PENDING)
 */
export async function GET(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const session = await getServerSession()
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const statusParam = searchParams.get('status')

    // Map the URL query value to the Prisma enum value
    const statusMap: Record<string, ApprovalStatus> = {
      pending: 'PENDING',
      approved: 'APPROVED',
      rejected: 'REJECTED',
      expired: 'EXPIRED',
    }

    const approvalStatus: ApprovalStatus =
      statusParam && statusMap[statusParam.toLowerCase()]
        ? statusMap[statusParam.toLowerCase()]
        : 'PENDING'

    const approvals = await prisma.approvalRequest.findMany({
      where: {
        projectId: params.id,
        status: approvalStatus,
      },
      include: {
        task: true,
      },
      orderBy: { createdAt: 'desc' },
    })

    // Shape the response to match the Approval type in types.ts
    const shaped = approvals.map((a) => {
      // confidenceScore is stored as JSON — extract fields safely
      const cs = a.confidenceScore as {
        total?: number
        riskFactors?: string[]
      } | null

      return {
        id: a.id,
        title: a.title,
        agentType: a.agentType.toLowerCase(),
        businessImpact: a.businessImpact,
        technicalSummary: a.technicalDetails,
        riskLevel: a.riskLevel.toLowerCase() as 'low' | 'medium' | 'high' | 'critical',
        confidenceScore: cs?.total ?? 0,
        riskFactors: cs?.riskFactors ?? [],
        expiresAt: a.expiresAt.toISOString(),
        status: a.status.toLowerCase() as 'pending' | 'approved' | 'rejected' | 'expired',
        prUrl: a.task.prUrl ?? undefined,
        createdAt: a.createdAt.toISOString(),
        resolvedAt: a.approvedAt?.toISOString() ?? undefined,
      }
    })

    return NextResponse.json({ approvals: shaped })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
