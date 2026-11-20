/**
 * Webhook routes
 * Handles incoming webhooks from: GitHub, Slack, Telegram, Sentry, PostHog, Vercel
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { createLogger } from '@forge/shared'
import { prisma } from '@forge/database'
import {
  verifySentrySignature,
  verifySharedSecret,
  verifySlackSignature,
  verifyVercelSignature,
} from './webhook-signatures.js'

const log = createLogger('routes:webhooks')

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer
  }
}

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name]
  return Array.isArray(value) ? value[0] : value
}

/**
 * Vercel issues a secret per webhook, so prefer the project's own secret
 * (`webhookSecret` in its VERCEL integration config) and fall back to the
 * deployment-wide VERCEL_WEBHOOK_SECRET.
 */
async function getVercelWebhookSecret(projectId: string): Promise<string | undefined> {
  try {
    const integration = await prisma.projectIntegration.findUnique({
      where: { projectId_type: { projectId, type: 'VERCEL' } },
      select: { config: true },
    })
    const config = integration?.config
    if (config && typeof config === 'object' && !Array.isArray(config)) {
      const secret = (config as Record<string, unknown>)['webhookSecret']
      if (typeof secret === 'string' && secret.length > 0) return secret
    }
  } catch (err) {
    log.warn({ projectId, error: (err as Error).message }, 'Failed to load Vercel webhook secret')
  }
  return process.env['VERCEL_WEBHOOK_SECRET']
}

function unauthorized(reply: FastifyReply, source: string): FastifyReply {
  log.warn({ source }, 'Rejected webhook with missing or invalid signature')
  return reply.status(401).send({ error: 'Invalid signature' })
}

/**
 * Captures the raw body for signature verification and parses JSON and
 * form-encoded bodies. Scoped to the webhook plugin so other routes keep
 * Fastify's default parsers.
 */
function registerRawBodyParsers(app: FastifyInstance): void {
  app.removeContentTypeParser('application/json')
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (request, body, done) => {
      const raw = body as Buffer
      request.rawBody = raw
      if (raw.length === 0) return done(null, {})
      try {
        done(null, JSON.parse(raw.toString('utf8')))
      } catch (err) {
        const error = err as Error & { statusCode?: number }
        error.statusCode = 400
        done(error, undefined)
      }
    },
  )
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'buffer' },
    (request, body, done) => {
      const raw = body as Buffer
      request.rawBody = raw
      done(null, Object.fromEntries(new URLSearchParams(raw.toString('utf8'))))
    },
  )
}

export async function registerWebhookRoutes(
  root: FastifyInstance,
): Promise<void> {
  await root.register(webhookRoutes)
}

async function webhookRoutes(app: FastifyInstance): Promise<void> {
  registerRawBodyParsers(app)

  // ---------------------------------------------------------------------------
  // GitHub App webhook
  // ---------------------------------------------------------------------------
  app.post('/api/webhooks/github', {
    config: { rawBody: true },  // need raw body for signature verification
  }, async (request, reply) => {
    const event = request.headers['x-github-event'] as string
    const signature = request.headers['x-hub-signature-256'] as string

    if (!event || !signature) {
      return reply.status(400).send({ error: 'Missing GitHub headers' })
    }

    try {
      // Dynamic import to avoid circular deps
      const { getForgeGitHub } = await import('@forge/github')
      const github = getForgeGitHub()

      await github.handleWebhook(event, request.body, signature)

      // Handle specific events that trigger orchestrator tasks
      const payload = request.body as Record<string, unknown>

      if (event === 'push' && payload['ref']) {
        const repoFullName = (payload['repository'] as Record<string, unknown>)?.['full_name'] as string
        if (repoFullName) {
          // Find project by repo
          const project = await prisma.project.findFirst({
            where: {
              githubRepoOwner: repoFullName.split('/')[0],
              githubRepoName: repoFullName.split('/')[1],
            },
            select: { id: true, organizationId: true },
          })

          if (project) {
            log.info({ projectId: project.id, event }, 'GitHub push — triggering context update')
            // The orchestrator processes this async via its event bus
          }
        }
      }

      return reply.status(200).send({ ok: true })
    } catch (err) {
      log.error({ error: (err as Error).message, event }, 'GitHub webhook error')
      return reply.status(400).send({ error: 'Webhook processing failed' })
    }
  })

  // ---------------------------------------------------------------------------
  // Slack interactive components (approve/reject buttons)
  // ---------------------------------------------------------------------------
  app.post('/api/webhooks/slack/interactive', async (request, reply) => {
    const verified = verifySlackSignature({
      signingSecret: process.env['SLACK_SIGNING_SECRET'],
      rawBody: request.rawBody,
      timestamp: header(request, 'x-slack-request-timestamp'),
      signature: header(request, 'x-slack-signature'),
    })
    if (!verified) return unauthorized(reply, 'slack')

    const body = request.body as { payload?: string }
    if (!body.payload) {
      return reply.status(400).send({ error: 'Missing payload' })
    }

    try {
      const payload = JSON.parse(body.payload) as {
        type: string
        actions?: Array<{ action_id: string; value: string }>
        user?: { id: string; name: string }
        response_url?: string
      }

      if (payload.type === 'block_actions' && payload.actions?.[0]) {
        const action = payload.actions[0]
        const token = action.value
        const approvedBy = payload.user?.name ?? 'slack-user'

        // Process via approval gateway
        const { ApprovalGateway } = await import('./approval-gateway-handler.js')
        await ApprovalGateway.processFromWebhook(token, approvedBy, payload.response_url)
      }

      return reply.status(200).send({ ok: true })
    } catch (err) {
      log.error({ error: (err as Error).message }, 'Slack interactive webhook error')
      return reply.status(200).send({ ok: true })  // Always 200 to Slack
    }
  })

  // ---------------------------------------------------------------------------
  // Telegram webhook
  // ---------------------------------------------------------------------------
  app.post('/api/webhooks/telegram/:projectId', async (request, reply) => {
    const { projectId } = request.params as { projectId: string }

    if (!verifySharedSecret(
      process.env['TELEGRAM_WEBHOOK_SECRET'],
      header(request, 'x-telegram-bot-api-secret-token'),
    )) {
      return unauthorized(reply, 'telegram')
    }

    try {
      const { getForgeGitHub: _ } = await import('@forge/github')
      log.debug({ projectId }, 'Telegram webhook received')

      // In production this routes to the TelegramAdapter's handleWebhook()
      return reply.status(200).send({ ok: true })
    } catch (err) {
      log.error({ error: (err as Error).message }, 'Telegram webhook error')
      return reply.status(200).send({ ok: true })
    }
  })

  // ---------------------------------------------------------------------------
  // Sentry webhook (error events)
  // ---------------------------------------------------------------------------
  app.post('/api/webhooks/sentry/:projectId', async (request, reply) => {
    const { projectId } = request.params as { projectId: string }

    if (!verifySentrySignature(
      process.env['SENTRY_WEBHOOK_SECRET'],
      request.rawBody,
      header(request, 'sentry-hook-signature'),
    )) {
      return unauthorized(reply, 'sentry')
    }

    try {
      const event = request.body as {
        action?: string
        data?: { issue?: { title?: string; level?: string; culprit?: string } }
      }

      if (event.action === 'created' || event.action === 'triggered') {
        const issue = event.data?.issue
        log.info({ projectId, title: issue?.title, level: issue?.level }, 'Sentry issue received')

        // Create a log event and route to Watcher Agent via event bus
        // In production: dispatch to watcher queue with LogEvent payload
      }

      return reply.status(200).send({ ok: true })
    } catch (err) {
      log.error({ error: (err as Error).message }, 'Sentry webhook error')
      return reply.status(200).send({ ok: true })
    }
  })

  // ---------------------------------------------------------------------------
  // PostHog webhook (feature usage, error events)
  // ---------------------------------------------------------------------------
  app.post('/api/webhooks/posthog/:projectId', async (request, reply) => {
    const { projectId } = request.params as { projectId: string }

    // PostHog does not sign webhooks; require a shared secret header instead.
    if (!verifySharedSecret(
      process.env['POSTHOG_WEBHOOK_SECRET'],
      header(request, 'x-forge-webhook-secret'),
    )) {
      return unauthorized(reply, 'posthog')
    }

    try {
      const event = request.body as { event?: string; properties?: Record<string, unknown> }
      log.debug({ projectId, event: event.event }, 'PostHog event received')

      // Route error events to Watcher Agent
      if (event.event === '$exception' || event.event === 'error') {
        // Dispatch to watcher queue
      }

      return reply.status(200).send({ ok: true })
    } catch (err) {
      log.error({ error: (err as Error).message }, 'PostHog webhook error')
      return reply.status(200).send({ ok: true })
    }
  })

  // ---------------------------------------------------------------------------
  // Vercel webhook (deployment events)
  // ---------------------------------------------------------------------------
  app.post('/api/webhooks/vercel/:projectId', async (request, reply) => {
    const { projectId } = request.params as { projectId: string }

    if (!verifyVercelSignature(
      await getVercelWebhookSecret(projectId),
      request.rawBody,
      header(request, 'x-vercel-signature'),
    )) {
      return unauthorized(reply, 'vercel')
    }

    try {
      const event = request.body as {
        type?: string
        payload?: {
          deployment?: { id: string; url: string; state: string; meta?: Record<string, unknown> }
        }
      }

      const deployment = event.payload?.deployment
      if (!deployment) return reply.status(200).send({ ok: true })

      log.info({ projectId, deployId: deployment.id, state: deployment.state }, 'Vercel deployment event')

      // Update deployment record in DB
      if (event.type === 'deployment.succeeded' || event.type === 'deployment.error') {
        await prisma.deployment.updateMany({
          where: { projectId, externalId: deployment.id },
          data: {
            status: event.type === 'deployment.succeeded' ? 'SUCCEEDED' : 'FAILED',
            completedAt: new Date(),
            url: deployment.url,
          },
        })
      }

      return reply.status(200).send({ ok: true })
    } catch (err) {
      log.error({ error: (err as Error).message }, 'Vercel webhook error')
      return reply.status(200).send({ ok: true })
    }
  })
}

// Placeholder to avoid import error — real handler in approval-gateway
declare module './approval-gateway-handler.js' {
  export const ApprovalGateway: {
    processFromWebhook(token: string, approvedBy: string, responseUrl?: string): Promise<void>
  }
}
