import { NextResponse } from 'next/server'
import { AuthError, requirePermission } from '@forge/auth'
import type { RiskLevel } from '@prisma/client'
import { getServerSession } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface ProjectAccess {
  userId: string
  project: { id: string; organizationId: string }
}

export type ProjectAccessResult =
  | ({ ok: true } & ProjectAccess)
  | { ok: false; response: NextResponse }

export function notFound(): NextResponse {
  return NextResponse.json({ error: 'Not found' }, { status: 404 })
}

export function isUuid(value: string): boolean {
  return UUID_RE.test(value)
}

/**
 * Resolves the session and loads the project only if the caller is a member
 * of the project's organization. Non-members get a 404 so project ids cannot
 * be probed across tenants.
 */
export async function requireProjectMember(projectId: string): Promise<ProjectAccessResult> {
  const session = await getServerSession()
  const userId = session?.user?.id
  if (!userId) {
    return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }

  if (!isUuid(projectId)) return { ok: false, response: notFound() }

  const project = await prisma.project.findFirst({
    where: {
      id: projectId,
      organization: { members: { some: { userId } } },
    },
    select: { id: true, organizationId: true },
  })

  if (!project) return { ok: false, response: notFound() }

  return { ok: true, userId, project }
}

const RISK_APPROVAL_PERMISSION: Partial<Record<RiskLevel, string>> = {
  MEDIUM: 'task:approve_medium',
  HIGH: 'task:approve_high',
  CRITICAL: 'task:approve_critical',
}

/**
 * Permissions required to approve or reject an approval request of the given risk level.
 */
export function approvalPermissions(
  action: 'approval:approve' | 'approval:reject',
  riskLevel: RiskLevel,
): string[] {
  const riskPermission = RISK_APPROVAL_PERMISSION[riskLevel]
  return riskPermission ? [action, riskPermission] : [action]
}

/**
 * Enforces every permission for the caller in the project's organization.
 * Returns an error response when any is missing, or null when all are granted.
 */
export async function requireProjectPermissions(
  access: ProjectAccess,
  permissions: string[],
): Promise<NextResponse | null> {
  try {
    for (const permission of permissions) {
      await requirePermission(access.userId, access.project.organizationId, permission)
    }
    return null
  } catch (error) {
    if (error instanceof AuthError) {
      return error.code === 'FORBIDDEN'
        ? NextResponse.json({ error: 'Forbidden' }, { status: 403 })
        : notFound()
    }
    throw error
  }
}
