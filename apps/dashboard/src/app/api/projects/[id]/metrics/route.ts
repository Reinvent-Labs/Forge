import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireProjectMember } from '@/lib/project-access'

/**
 * GET /api/projects/[id]/metrics
 * Returns ProjectMetricsSnapshot rows for the given project.
 *
 * Query params:
 *   ?range=7d|30d|90d  — number of days to look back (defaults to 30d)
 */
export async function GET(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const access = await requireProjectMember(params.id)
    if (!access.ok) return access.response
    const projectId = access.project.id

    const { searchParams } = new URL(request.url)
    const rangeParam = searchParams.get('range') ?? '30d'

    // Map range string to a number of days
    const rangeDaysMap: Record<string, number> = {
      '7d': 7,
      '30d': 30,
      '90d': 90,
    }
    const days = rangeDaysMap[rangeParam] ?? 30

    const since = new Date()
    since.setDate(since.getDate() - days)

    const snapshots = await prisma.projectMetricsSnapshot.findMany({
      where: {
        projectId,
        capturedAt: { gte: since },
      },
      orderBy: { capturedAt: 'asc' },
      // Cap at the most recent 90 rows to keep payloads reasonable
      take: 90,
    })

    const latest = snapshots.length > 0 ? snapshots[snapshots.length - 1] : null

    return NextResponse.json({ snapshots, latest })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
