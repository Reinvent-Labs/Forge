import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireProjectMember } from '@/lib/project-access'

/**
 * GET /api/projects/[id]/integrations
 * Returns the ProjectIntegration rows for the given project, without their config.
 */
export async function GET(
  _request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const access = await requireProjectMember(params.id)
    if (!access.ok) return access.response
    const projectId = access.project.id

    const integrations = await prisma.projectIntegration.findMany({
      where: { projectId },
      select: {
        id: true,
        type: true,
        status: true,
        lastSyncAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    })

    return NextResponse.json({ integrations })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
