import { NextResponse } from 'next/server'
import { getServerSession } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import type { AgentType } from '@prisma/client'

/**
 * GET /api/projects/[id]/activity
 * Returns AgentTask rows for the given project, ordered newest first.
 *
 * Query params:
 *   ?page=1         — 1-based page number (defaults to 1)
 *   ?limit=20       — items per page (defaults to 20, max 100)
 *   ?agentType=BUILDER — filter by AgentType enum value
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
    const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10))
    const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') ?? '20', 10)))
    const agentTypeParam = searchParams.get('agentType')

    // Build the where clause, optionally filtering by agentType
    const where = {
      projectId: params.id,
      ...(agentTypeParam
        ? { agentType: agentTypeParam.toUpperCase() as AgentType }
        : {}),
    }

    const [tasks, total] = await Promise.all([
      prisma.agentTask.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.agentTask.count({ where }),
    ])

    const pages = Math.ceil(total / limit)

    return NextResponse.json({ tasks, total, page, pages })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
