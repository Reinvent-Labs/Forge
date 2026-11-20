/**
 * HTTP authentication & authorization for the orchestrator REST API.
 *
 * - registerApiAuth() installs a global onRequest hook that authenticates every
 *   /api/* route (except signed webhooks) and attaches the caller to the request.
 * - requireOrgPermission() / requireProjectPermission() enforce organization
 *   membership and role permissions inside each handler.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { decode as decodeNextAuthToken } from 'next-auth/jwt'
import { z } from 'zod'
import { prisma } from '@forge/database'
import { verifySessionToken } from '@forge/shared'
import { authenticateApiKey, getUserRole, hasPermission, type OrgRole } from '@forge/auth'

export interface CallerIdentity {
  type: 'user' | 'api-key'
  /** Set for user sessions; absent for API keys. */
  userId: string | null
  /** When set, the caller may only act within this organization. */
  organizationId: string | null
  /** Display name for audit trails. */
  name: string
}

export type UserCaller = CallerIdentity & { type: 'user'; userId: string }

declare module 'fastify' {
  interface FastifyRequest {
    caller: CallerIdentity | null
  }
}

/** Role granted to API keys inside their own organization. */
const API_KEY_ROLE: OrgRole = 'DEVELOPER'

/** Route prefixes that authenticate with their own signatures. */
const UNAUTHENTICATED_PREFIXES = ['/api/webhooks/']

const SESSION_COOKIES = [
  'forge_session',
  '__Secure-next-auth.session-token',
  'next-auth.session-token',
] as const

const NEXT_AUTH_SALTS = ['__Secure-next-auth.session-token', 'next-auth.session-token'] as const

const UuidSchema = z.string().uuid()

export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

export function registerApiAuth(app: FastifyInstance): void {
  app.decorateRequest('caller', null)

  app.addHook('onRequest', async (request, reply) => {
    // Use the matched route pattern (not the raw URL) so encoded paths cannot bypass the check
    const route = request.routeOptions.url
    if (!route || !route.startsWith('/api/')) return
    if (UNAUTHENTICATED_PREFIXES.some((prefix) => route.startsWith(prefix))) return

    const caller = await authenticateRequest(request)
    if (!caller) {
      return reply.status(401).send({ error: 'Unauthorized' })
    }

    request.caller = caller
  })
}

async function authenticateRequest(request: FastifyRequest): Promise<CallerIdentity | null> {
  const authHeader = request.headers['authorization']
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim()
    if (!token) return null

    if (token.startsWith('forge_')) {
      const apiKey = await authenticateApiKey(token)
      if (!apiKey) return null
      return {
        type: 'api-key',
        userId: null,
        organizationId: apiKey.organizationId,
        name: `api-key:${apiKey.name}`,
      }
    }

    return verifyUserToken(token)
  }

  const cookies = parseCookies(request.headers.cookie)
  for (const name of SESSION_COOKIES) {
    const token = cookies[name]
    if (token) return verifyUserToken(token)
  }

  return null
}

async function verifyUserToken(token: string): Promise<CallerIdentity | null> {
  try {
    const payload = await verifySessionToken(token)
    if (typeof payload.userId === 'string' && payload.userId) {
      return {
        type: 'user',
        userId: payload.userId,
        organizationId: typeof payload.organizationId === 'string' ? payload.organizationId : null,
        name: payload.userId,
      }
    }
  } catch {
    // fall through to NextAuth
  }

  const secret = process.env['NEXTAUTH_SECRET'] ?? process.env['BETTER_AUTH_SECRET']
  if (!secret) return null

  for (const salt of NEXT_AUTH_SALTS) {
    try {
      const payload = await decodeNextAuthToken({ token, secret, salt })
      if (!payload) continue
      const userId = typeof payload['id'] === 'string' ? payload['id'] : payload.sub
      if (!userId) continue
      return {
        type: 'user',
        userId,
        organizationId: null,
        name: typeof payload.email === 'string' ? payload.email : userId,
      }
    } catch {
      continue
    }
  }

  return null
}

function parseCookies(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {}
  if (!header) return result

  for (const pair of header.split(';')) {
    const trimmed = pair.trim()
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const value = trimmed.slice(eq + 1)
    try {
      result[trimmed.slice(0, eq)] = decodeURIComponent(value)
    } catch {
      result[trimmed.slice(0, eq)] = value
    }
  }

  return result
}

export function requireCaller(request: FastifyRequest): CallerIdentity {
  if (!request.caller) throw new HttpError(401, 'Unauthorized')
  return request.caller
}

/** Require a signed-in user (API keys are rejected). */
export function requireUser(request: FastifyRequest): UserCaller {
  const caller = requireCaller(request)
  if (caller.type !== 'user' || !caller.userId) {
    throw new HttpError(403, 'This action requires a user session')
  }
  return caller as UserCaller
}

/** Resolve the caller's role in an organization, or null if not a member. */
export async function getCallerRole(
  caller: CallerIdentity,
  organizationId: string,
): Promise<OrgRole | null> {
  if (caller.organizationId && caller.organizationId !== organizationId) return null
  if (caller.type === 'api-key') return API_KEY_ROLE
  if (!caller.userId || !UuidSchema.safeParse(organizationId).success) return null
  return getUserRole(caller.userId, organizationId)
}

/**
 * Require the caller to be a member of `organizationId` with `permission`.
 * Returns the caller's role.
 */
export async function requireOrgPermission(
  request: FastifyRequest,
  organizationId: string,
  permission: string,
): Promise<OrgRole> {
  const caller = requireCaller(request)
  const role = await getCallerRole(caller, organizationId)
  if (!role || !hasPermission(role, permission)) {
    throw new HttpError(403, 'Forbidden')
  }
  return role
}

/**
 * Load a project and require the caller to have `permission` in its organization.
 */
export async function requireProjectPermission(
  request: FastifyRequest,
  projectId: string,
  permission: string,
): Promise<{ organizationId: string; role: OrgRole }> {
  requireCaller(request)
  if (!UuidSchema.safeParse(projectId).success) {
    throw new HttpError(404, 'Project not found')
  }

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { organizationId: true },
  })
  if (!project) throw new HttpError(404, 'Project not found')

  const role = await requireOrgPermission(request, project.organizationId, permission)
  return { organizationId: project.organizationId, role }
}

export function isOrgAdmin(role: OrgRole): boolean {
  return role === 'OWNER' || role === 'ADMIN'
}
