/**
 * Health check endpoint.
 *
 * GET /health         — liveness probe (always 200 if server is up)
 * GET /health/ready   — readiness probe (checks DB + Redis connectivity)
 *
 * Used by:
 * - Kubernetes liveness / readiness probes
 * - Vercel / Railway health check config
 * - Forge DevOps agent for post-deploy monitoring
 */

import type { FastifyPluginAsync } from 'fastify'
import type { PrismaClient } from '@prisma/client'

// Augment the Fastify instance type so `app.prisma` is recognised
declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient
  }
}

export const healthRoutes: FastifyPluginAsync = async (app) => {
  /** Liveness probe — confirms the Node process is alive */
  app.get('/', async (_req, reply) => {
    return reply.status(200).send({
      status: 'ok',
      timestamp: new Date().toISOString(),
      version: process.env['npm_package_version'] ?? '0.0.0',
    })
  })

  /** Readiness probe — confirms the service can handle requests */
  app.get('/ready', async (_req, reply) => {
    const checks: Record<string, 'ok' | 'error'> = {}
    let allOk = true

    // Database check
    try {
      await app.prisma.$queryRaw`SELECT 1`
      checks['database'] = 'ok'
    } catch {
      checks['database'] = 'error'
      allOk = false
    }

    const status = allOk ? 'ok' : 'degraded'
    const code = allOk ? 200 : 503

    return reply.status(code).send({ status, checks, timestamp: new Date().toISOString() })
  })
}
