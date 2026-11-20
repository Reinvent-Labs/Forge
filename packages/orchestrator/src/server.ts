/**
 * Forge Orchestrator HTTP Server
 *
 * Fastify server that exposes:
 * - REST API for dashboard and CLI
 * - WebSocket for real-time updates
 * - Webhook endpoints for GitHub, Slack, Telegram
 * - Health check endpoint
 */

import Fastify from 'fastify'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import { z } from 'zod'
import { createLogger, type AgentTask } from '@forge/shared'
import { initOrchestrator } from './index.js'
import { registerProjectRoutes } from './routes/projects.js'
import { registerWebhookRoutes } from './routes/webhooks.js'
import { registerAuthRoutes } from './routes/auth.js'
import { CronScheduler } from './cron.js'
import { WebSocketServer } from './websocket.js'

const log = createLogger('server')
const PORT = parseInt(process.env['PORT'] ?? '4000', 10)

async function start(): Promise<void> {
  const orchestrator = initOrchestrator()

  // ---------------------------------------------------------------------------
  // Fastify + HTTP server
  // ---------------------------------------------------------------------------

  const app = Fastify({ logger: false, trustProxy: true })

  await app.register(cors, {
    origin: process.env['DASHBOARD_URL'] ?? 'http://localhost:3000',
    credentials: true,
  })

  await app.register(helmet, {
    contentSecurityPolicy: false,  // handled by Next.js
  })

  const websocketServer = new WebSocketServer({
    eventBus: orchestrator.eventBus,
    path: '/ws',
  })

  websocketServer.start()

  app.server.on('upgrade', (request, socket, head) => {
    if (!websocketServer.isWebSocketRequest(request)) {
      socket.destroy()
      return
    }

    websocketServer.handleUpgrade(request, socket, head)
  })

  app.get('/ws', async (_request, reply) => {
    return reply.status(426).send({ error: 'Upgrade Required' })
  })

  // ---------------------------------------------------------------------------
  // Health check
  // ---------------------------------------------------------------------------

  app.get('/health', async () => ({
    status: 'ok',
    version: process.env['npm_package_version'] ?? '1.0.0',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  }))

  // ---------------------------------------------------------------------------
  // Task API
  // ---------------------------------------------------------------------------

  const CreateTaskSchema = z.object({
    type: z.string(),
    priority: z.enum(['critical', 'high', 'normal', 'low']).default('normal'),
    projectId: z.string().uuid(),
    organizationId: z.string().uuid(),
    payload: z.record(z.unknown()),
    requestedBy: z.enum(['system', 'founder', 'developer', 'webhook']).default('founder'),
  })

  app.post('/api/tasks', async (request, reply) => {
    try {
      const body = CreateTaskSchema.parse(request.body)

      const taskId = await orchestrator.processTask({
        type: body.type as AgentTask['type'],
        priority: body.priority,
        projectId: body.projectId,
        organizationId: body.organizationId,
        payload: body.payload,
        requestedBy: body.requestedBy,
        autonomyLevel: 'suggest',  // will be overridden from project settings
      })

      return reply.status(202).send({ taskId, status: 'queued' })
    } catch (err) {
      log.error({ error: (err as Error).message }, 'Failed to create task')
      return reply.status(400).send({ error: (err as Error).message })
    }
  })

  // ---------------------------------------------------------------------------
  // Approval webhook (from email/Slack one-click links)
  // ---------------------------------------------------------------------------

  app.get('/api/approvals/action', async (request, reply) => {
    const query = request.query as { token?: string; by?: string }

    if (!query.token) {
      return reply.status(400).send({ error: 'token required' })
    }

    try {
      // Unauthenticated link: no verified Forge identity, so the gateway rejects it
      // unless the approver is resolved to a Forge member.
      const result = await orchestrator.approvalGateway.processToken(
        query.token,
        { displayName: query.by ?? 'unknown' },
      )

      // Redirect to dashboard
      const dashboardUrl = process.env['DASHBOARD_URL'] ?? 'http://localhost:3000'
      return reply.redirect(
        `${dashboardUrl}/approvals/${result.approvalId}?action=${result.action}`,
      )
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message })
    }
  })

  // ---------------------------------------------------------------------------
  // Queue metrics (for monitoring)
  // ---------------------------------------------------------------------------

  app.get('/api/metrics/queues', async () => {
    return orchestrator.eventBus.getQueueMetrics()
  })

  // ---------------------------------------------------------------------------
  // Register route modules
  // ---------------------------------------------------------------------------

  await registerProjectRoutes(app)
  await registerWebhookRoutes(app)
  await registerAuthRoutes(app)

  // ---------------------------------------------------------------------------
  // Start cron scheduler
  // ---------------------------------------------------------------------------

  const cron = new CronScheduler(orchestrator)
  cron.start()

  // ---------------------------------------------------------------------------
  // Start server
  // ---------------------------------------------------------------------------

  try {
    await app.ready()
    await app.listen({ port: PORT, host: '0.0.0.0' })
    log.info({ port: PORT }, 'Forge Orchestrator started')
  } catch (err) {
    log.error({ error: (err as Error).message }, 'Failed to start server')
    process.exit(1)
  }

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    log.info({ signal }, 'Shutting down...')
    cron.stop()
    await websocketServer.close()
    await app.close()
    await orchestrator.close()
    process.exit(0)
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

// Handle unhandled rejections — log and exit
process.on('unhandledRejection', (reason) => {
  log.error({ reason }, 'Unhandled rejection — exiting')
  process.exit(1)
})

void start()
