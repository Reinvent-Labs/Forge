/**
 * Auth routes — organization creation, API key management
 */

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '@forge/database'
import { createLogger } from '@forge/shared'
import { generateApiKey, hashApiKey } from '@forge/shared'
import { createOrganization } from '@forge/auth'

const log = createLogger('routes:auth')

const CreateOrgSchema = z.object({
  name: z.string().min(1).max(100),
  userId: z.string().uuid(),
})

const CreateApiKeySchema = z.object({
  name: z.string().min(1).max(50),
  organizationId: z.string().uuid(),
  expiresInDays: z.number().int().min(1).max(365).optional(),
})

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {

  // Create organization (called after user signs up)
  app.post('/api/organizations', async (request, reply) => {
    const body = CreateOrgSchema.safeParse(request.body)
    if (!body.success) {
      return reply.status(400).send({ error: body.error.flatten() })
    }

    try {
      const result = await createOrganization(body.data)
      return reply.status(201).send(result)
    } catch (err) {
      log.error({ error: (err as Error).message }, 'Failed to create organization')
      return reply.status(500).send({ error: 'Failed to create organization' })
    }
  })

  // List organizations for a user
  app.get('/api/organizations', async (request, reply) => {
    const query = request.query as { userId?: string }
    if (!query.userId) {
      return reply.status(400).send({ error: 'userId required' })
    }

    const memberships = await prisma.orgMember.findMany({
      where: { userId: query.userId },
      include: {
        organization: {
          select: {
            id: true, name: true, slug: true, planTier: true, createdAt: true,
          },
        },
      },
    })

    return memberships.map((m) => ({
      ...m.organization,
      role: m.role,
    }))
  })

  // Create an API key for CLI/programmatic access
  app.post('/api/api-keys', async (request, reply) => {
    const body = CreateApiKeySchema.safeParse(request.body)
    if (!body.success) {
      return reply.status(400).send({ error: body.error.flatten() })
    }

    const { key, prefix, hash } = generateApiKey()

    const expiresAt = body.data.expiresInDays
      ? new Date(Date.now() + body.data.expiresInDays * 24 * 60 * 60 * 1000)
      : undefined

    await prisma.apiKey.create({
      data: {
        organizationId: body.data.organizationId,
        name: body.data.name,
        keyHash: hash,
        prefix,
        expiresAt,
      },
    })

    log.info({ organizationId: body.data.organizationId, name: body.data.name }, 'API key created')

    // Return the key ONCE — it will never be shown again
    return reply.status(201).send({
      key,
      prefix,
      name: body.data.name,
      expiresAt,
      warning: 'Store this key securely. It will never be shown again.',
    })
  })

  // List API keys (prefix only, never full key)
  app.get('/api/api-keys', async (request, reply) => {
    const query = request.query as { organizationId?: string }
    if (!query.organizationId) {
      return reply.status(400).send({ error: 'organizationId required' })
    }

    const keys = await prisma.apiKey.findMany({
      where: { organizationId: query.organizationId, revokedAt: null },
      select: {
        id: true, name: true, prefix: true, lastUsedAt: true, expiresAt: true, createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    })

    return keys
  })

  // Revoke an API key
  app.delete('/api/api-keys/:keyId', async (request, reply) => {
    const { keyId } = request.params as { keyId: string }

    await prisma.apiKey.update({
      where: { id: keyId },
      data: { revokedAt: new Date() },
    })

    return reply.status(204).send()
  })

  // Invite a team member
  app.post('/api/organizations/:orgId/invitations', async (request, reply) => {
    const { orgId } = request.params as { orgId: string }
    const body = z.object({
      email: z.string().email(),
      role: z.enum(['ADMIN', 'DEVELOPER', 'VIEWER']),
    }).safeParse(request.body)

    if (!body.success) {
      return reply.status(400).send({ error: body.error.flatten() })
    }

    const invitation = await prisma.orgInvitation.create({
      data: {
        organizationId: orgId,
        email: body.data.email,
        role: body.data.role,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    })

    log.info({ orgId, email: body.data.email, role: body.data.role }, 'Invitation created')

    // In production: send invitation email here
    return reply.status(201).send({
      invitationId: invitation.id,
      token: invitation.token,
    })
  })
}
