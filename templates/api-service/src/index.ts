/**
 * API Service entry point.
 *
 * Fastify server with:
 * - CORS, Helmet, Rate-limiting
 * - Zod request validation
 * - Pino structured logging
 * - Prisma database client
 * - BullMQ background job queue
 * - Graceful shutdown on SIGTERM/SIGINT
 */

import Fastify from 'fastify'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import { PrismaClient } from '@prisma/client'
import pino from 'pino'

import { healthRoutes } from './routes/health.js'
import { itemRoutes } from './routes/items.js'
import type { Env } from './env.js'
import { loadEnv } from './env.js'

// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap
// ─────────────────────────────────────────────────────────────────────────────

async function bootstrap(): Promise<void> {
  const env: Env = loadEnv()

  const logger = pino({
    level: env.LOG_LEVEL,
    ...(env.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty' } } : {}),
  })

  const prisma = new PrismaClient({
    log: env.NODE_ENV === 'development' ? ['query', 'warn', 'error'] : ['warn', 'error'],
  })

  const app = Fastify({ logger: logger as Parameters<typeof Fastify>[0]['logger'] })

  // ── Global plugins ─────────────────────────────────────────────────────────

  await app.register(helmet, { contentSecurityPolicy: false })

  await app.register(cors, {
    origin: env.NODE_ENV === 'production' ? env.ALLOWED_ORIGINS?.split(',') : true,
    credentials: true,
  })

  await app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
  })

  // ── Decorate with shared services ──────────────────────────────────────────

  app.decorate('prisma', prisma)

  // ── Routes ─────────────────────────────────────────────────────────────────

  await app.register(healthRoutes, { prefix: '/health' })
  await app.register(itemRoutes, { prefix: '/api/v1' })

  // ── Start ──────────────────────────────────────────────────────────────────

  try {
    await prisma.$connect()
    logger.info('Database connected')

    await app.listen({ port: env.PORT, host: env.HOST })
    logger.info({ port: env.PORT }, 'Server started')
  } catch (err) {
    logger.error({ err }, 'Server failed to start')
    process.exit(1)
  }

  // ── Graceful shutdown ──────────────────────────────────────────────────────

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutting down gracefully')
    await app.close()
    await prisma.$disconnect()
    logger.info('Shutdown complete')
    process.exit(0)
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

bootstrap().catch((err) => {
  console.error('Fatal startup error', err)
  process.exit(1)
})
