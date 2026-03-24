import { NextResponse } from 'next/server'
import { getServerSession } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

/**
 * Compute a letter grade from a numeric score (0–100).
 */
function scoreToGrade(score: number): string {
  if (score >= 90) return 'A'
  if (score >= 80) return 'B'
  if (score >= 70) return 'C'
  if (score >= 60) return 'D'
  return 'F'
}

/**
 * GET /api/projects/[id]/health
 * Computes a composite health score from recent metrics, incidents,
 * security scans, and debt items.
 *
 * Weighting:
 *   uptime        40%
 *   errorRate     30%  (inverted: lower error rate → higher contribution)
 *   securityScore 20%
 *   debtScore     10%
 */
export async function GET(
  _request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const session = await getServerSession()
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const thirtyDaysAgo = new Date()
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)

    // Run all queries in parallel for efficiency
    const [latestSnapshot, recentIncidents, latestScan, debtCounts] =
      await Promise.all([
        // Most recent metrics snapshot
        prisma.projectMetricsSnapshot.findFirst({
          where: { projectId: params.id },
          orderBy: { capturedAt: 'desc' },
        }),

        // All incidents in the last 30 days
        prisma.incident.findMany({
          where: {
            projectId: params.id,
            detectedAt: { gte: thirtyDaysAgo },
          },
          select: { severity: true, status: true },
        }),

        // Most recent security scan
        prisma.securityScan.findFirst({
          where: {
            projectId: params.id,
            status: 'COMPLETED',
          },
          orderBy: { completedAt: 'desc' },
        }),

        // Debt item counts grouped by severity
        prisma.debtItem.groupBy({
          by: ['severity'],
          where: {
            projectId: params.id,
            resolvedAt: null,
          },
          _count: { id: true },
        }),
      ])

    // --- Derive component scores ---

    // Uptime score (0–100): use snapshot value or default to 100
    const uptimePercent = latestSnapshot?.uptimePercent ?? 100
    const uptimeScore = Math.min(100, uptimePercent) // already a percentage

    // Error rate score (0–100): invert error rate
    // Treat error rates above 10% as score 0, 0% as score 100
    const errorRate = latestSnapshot?.errorRate ?? 0
    const errorRateScore = Math.max(0, 100 - errorRate * 10)

    // Security score (0–100): use scan score or default to 100
    const securityScore = latestScan?.score ?? 100

    // Debt score (0–100): penalise based on open debt item severity
    // Critical: -15 pts each, High: -8, Medium: -3, Low: -1 (capped at 0)
    const debtPenalty = debtCounts.reduce((total, group) => {
      const count = group._count.id
      const penaltyMap: Record<string, number> = {
        CRITICAL: 15,
        HIGH: 8,
        MEDIUM: 3,
        LOW: 1,
      }
      return total + count * (penaltyMap[group.severity] ?? 0)
    }, 0)
    const debtScore = Math.max(0, 100 - debtPenalty)

    // Weighted composite score
    const compositeScore = Math.round(
      uptimeScore * 0.4 +
      errorRateScore * 0.3 +
      securityScore * 0.2 +
      debtScore * 0.1
    )

    // Incident counts
    const openIncidents = recentIncidents.filter(
      (i) => i.status === 'OPEN' || i.status === 'ACKNOWLEDGED'
    ).length
    const criticalIncidents = recentIncidents.filter(
      (i) => i.severity === 'CRITICAL'
    ).length

    return NextResponse.json({
      score: compositeScore,
      grade: scoreToGrade(compositeScore),
      uptime: uptimePercent,
      errorRate,
      securityScore,
      debtScore,
      openIncidents,
      criticalIncidents,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
