/**
 * @forge/auth — Multi-tenant Authentication & Authorization
 *
 * Implements:
 * - Multi-tenant auth with organization isolation
 * - Role-based access control (owner/admin/developer/viewer)
 * - API key authentication (for CLI and webhooks)
 * - Session management
 *
 * Built on Better Auth with custom multi-tenant extensions.
 */

import { betterAuth } from 'better-auth'
import { prismaAdapter } from 'better-auth/adapters/prisma'
import { prisma } from '@forge/database'
import { createLogger, hashApiKey } from '@forge/shared'
import { z } from 'zod'

const log = createLogger('auth')

// ---------------------------------------------------------------------------
// Better Auth instance
// ---------------------------------------------------------------------------

export const auth = betterAuth({
  database: prismaAdapter(prisma, {
    provider: 'postgresql',
  }),

  secret: process.env['BETTER_AUTH_SECRET'] ?? '',
  baseURL: process.env['BETTER_AUTH_URL'] ?? 'http://localhost:3000',

  emailAndPassword: {
    enabled: true,
    requireEmailVerification: process.env['NODE_ENV'] === 'production',
    minPasswordLength: 8,
  },

  session: {
    cookieCache: {
      enabled: true,
      maxAge: 5 * 60,  // 5 minutes
    },
    expiresIn: 7 * 24 * 60 * 60,  // 7 days
    updateAge: 24 * 60 * 60,       // Refresh if older than 1 day
  },

  plugins: [],
})

// ---------------------------------------------------------------------------
// RBAC
// ---------------------------------------------------------------------------

export type OrgRole = 'OWNER' | 'ADMIN' | 'DEVELOPER' | 'VIEWER'

/**
 * Permission matrix — what each role can do.
 */
const PERMISSIONS: Record<OrgRole, Set<string>> = {
  OWNER: new Set([
    'org:delete', 'org:manage_billing', 'org:manage_members',
    'project:create', 'project:delete', 'project:configure',
    'task:create', 'task:approve_critical', 'task:approve_high', 'task:approve_medium',
    'approval:approve', 'approval:reject',
    'credential:manage', 'audit:read',
  ]),
  ADMIN: new Set([
    'org:manage_members',
    'project:create', 'project:delete', 'project:configure',
    'task:create', 'task:approve_high', 'task:approve_medium',
    'approval:approve', 'approval:reject',
    'credential:manage', 'audit:read',
  ]),
  DEVELOPER: new Set([
    'project:configure',
    'task:create', 'task:approve_medium',
    'approval:approve', 'approval:reject',
    'audit:read',
  ]),
  VIEWER: new Set([
    'audit:read',
  ]),
}

/**
 * Check if a role has a specific permission.
 */
export function hasPermission(role: OrgRole, permission: string): boolean {
  return PERMISSIONS[role]?.has(permission) ?? false
}

/**
 * Get a user's role in an organization.
 * Returns null if the user is not a member.
 */
export async function getUserRole(
  userId: string,
  organizationId: string,
): Promise<OrgRole | null> {
  const membership = await prisma.orgMember.findUnique({
    where: {
      organizationId_userId: {
        organizationId,
        userId,
      },
    },
    select: { role: true },
  })

  return (membership?.role as OrgRole) ?? null
}

/**
 * Assert that a user has a specific permission in an organization.
 * Throws an error if they don't.
 */
export async function requirePermission(
  userId: string,
  organizationId: string,
  permission: string,
): Promise<void> {
  const role = await getUserRole(userId, organizationId)

  if (!role) {
    throw new AuthError('UNAUTHORIZED', 'You are not a member of this organization')
  }

  if (!hasPermission(role, permission)) {
    throw new AuthError(
      'FORBIDDEN',
      `Your role (${role}) does not have the '${permission}' permission`,
    )
  }
}

// ---------------------------------------------------------------------------
// API Key authentication
// ---------------------------------------------------------------------------

const API_KEY_PREFIX = 'forge_'

/**
 * Authenticate a request using an API key.
 * API keys are used by the CLI and programmatic integrations.
 *
 * @returns The organization ID associated with the key, or null if invalid.
 */
export async function authenticateApiKey(
  rawKey: string,
): Promise<{ organizationId: string; name: string } | null> {
  if (!rawKey.startsWith(API_KEY_PREFIX)) return null

  const hash = hashApiKey(rawKey)

  const apiKey = await prisma.apiKey.findUnique({
    where: { keyHash: hash },
    select: { organizationId: true, name: true, expiresAt: true, revokedAt: true },
  })

  if (!apiKey) return null
  if (apiKey.revokedAt) return null
  if (apiKey.expiresAt && apiKey.expiresAt < new Date()) return null

  // Update last used timestamp (fire-and-forget)
  void prisma.apiKey.update({
    where: { keyHash: hash },
    data: { lastUsedAt: new Date() },
  }).catch(() => {/* ignore */})

  return { organizationId: apiKey.organizationId, name: apiKey.name }
}

// ---------------------------------------------------------------------------
// Middleware helpers for Fastify
// ---------------------------------------------------------------------------

export interface AuthenticatedRequest {
  userId?: string
  organizationId?: string
  role?: OrgRole
  isApiKey?: boolean
}

/**
 * Extract auth context from a Fastify request.
 * Supports both session cookies and API key (Authorization: Bearer forge_...)
 */
export async function extractAuthContext(
  headers: Record<string, string | string[] | undefined>,
): Promise<AuthenticatedRequest | null> {
  // API key auth
  const authHeader = headers['authorization']
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer forge_')) {
    const key = authHeader.replace('Bearer ', '')
    const result = await authenticateApiKey(key)
    if (result) {
      return {
        organizationId: result.organizationId,
        isApiKey: true,
      }
    }
    return null
  }

  // Session cookie auth is handled by Better Auth middleware
  // In a Fastify plugin, you'd call auth.api.getSession here
  return null
}

// ---------------------------------------------------------------------------
// Organization management helpers
// ---------------------------------------------------------------------------

const CreateOrgSchema = z.object({
  name: z.string().min(1).max(100),
  userId: z.string().uuid(),
})

/**
 * Create a new organization and add the user as owner.
 * Generates a per-tenant encryption key for credential storage.
 */
export async function createOrganization(
  input: z.infer<typeof CreateOrgSchema>,
): Promise<{ organizationId: string; slug: string }> {
  const validated = CreateOrgSchema.parse(input)

  const slug = validated.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 50)

  // Generate per-tenant encryption key
  // In production, this should be stored in Vault; for now use env master key
  const { generateKey } = await import('@forge/shared')
  const encKey = generateKey()  // AES-256 key for this tenant

  const org = await prisma.organization.create({
    data: {
      name: validated.name,
      slug: `${slug}-${Date.now().toString(36)}`,
      encKey: encKey,  // Store encrypted with master key in prod
      members: {
        create: {
          userId: validated.userId,
          role: 'OWNER',
        },
      },
    },
  })

  log.info({ organizationId: org.id, userId: validated.userId }, 'Organization created')

  return { organizationId: org.id, slug: org.slug }
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class AuthError extends Error {
  constructor(
    public readonly code: 'UNAUTHORIZED' | 'FORBIDDEN' | 'INVALID_TOKEN',
    message: string,
  ) {
    super(message)
    this.name = 'AuthError'
  }
}

export { prisma }
