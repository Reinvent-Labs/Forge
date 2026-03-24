import { NextResponse } from 'next/server'
import { getServerSession } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

/**
 * GET /api/projects
 * Returns all projects belonging to the authenticated user's organization(s).
 */
export async function GET() {
  try {
    const session = await getServerSession()

    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Find all org memberships for this user, then get their projects
    const memberships = await prisma.orgMember.findMany({
      where: { userId: session.user.id },
      select: { organizationId: true },
    })

    const orgIds = memberships.map((m) => m.organizationId)

    const projects = await prisma.project.findMany({
      where: {
        organizationId: { in: orgIds },
        status: { not: 'ARCHIVED' },
      },
      orderBy: { createdAt: 'desc' },
    })

    return NextResponse.json({ projects })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
