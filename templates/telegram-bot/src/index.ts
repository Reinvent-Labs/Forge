/**
 * Forge Telegram Bot template
 *
 * Stack:
 *   - grammY   — Telegram Bot framework
 *   - Prisma   — PostgreSQL ORM
 *   - ioredis  — Redis client (session storage via @grammyjs/storage-redis)
 *   - Pino     — structured logging
 *   - Zod      — env validation
 *
 * Supports both long-polling (dev) and webhook (prod) modes.
 * Set BOT_WEBHOOK_DOMAIN to enable webhook mode.
 */

import { Bot, session, type Context } from 'grammy'
import { RedisAdapter } from '@grammyjs/storage-redis'
import { PrismaClient } from '@prisma/client'
import Redis from 'ioredis'
import pino from 'pino'
import { z } from 'zod'

// ─── Environment ──────────────────────────────────────────────────────────────

const envSchema = z.object({
  BOT_TOKEN: z.string().min(1, 'BOT_TOKEN is required'),
  BOT_WEBHOOK_DOMAIN: z.string().url().optional(),
  BOT_WEBHOOK_PORT: z.coerce.number().int().min(1).max(65535).default(8443),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
})

const parseEnv = () => {
  const result = envSchema.safeParse(process.env)
  if (!result.success) {
    console.error('Invalid environment variables:')
    result.error.issues.forEach((issue) => {
      console.error(`  ${issue.path.join('.')}: ${issue.message}`)
    })
    process.exit(1)
  }
  return result.data
}

const env = parseEnv()

// ─── Logger ───────────────────────────────────────────────────────────────────

const log = pino({
  level: env.LOG_LEVEL,
  transport:
    env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
})

// ─── Infrastructure ───────────────────────────────────────────────────────────

const prisma = new PrismaClient({
  log: env.NODE_ENV === 'development' ? ['query', 'error'] : ['error'],
})

const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null, // required for BullMQ if added later
  lazyConnect: true,
})

redis.on('error', (err) => log.error({ err }, 'Redis connection error'))
redis.on('connect', () => log.info('Redis connected'))

// ─── Session types ────────────────────────────────────────────────────────────

interface SessionData {
  /** Tracks which step the user is at in a multi-step conversation flow. */
  step?: string
  /** Generic key-value store for wizard state. */
  data?: Record<string, unknown>
}

// Extend grammY Context with session and our custom properties
type BotContext = Context & {
  session: SessionData
}

// ─── Bot setup ────────────────────────────────────────────────────────────────

const bot = new Bot<BotContext>(env.BOT_TOKEN)

// Session middleware backed by Redis
bot.use(
  session<SessionData, BotContext>({
    initial: (): SessionData => ({}),
    storage: new RedisAdapter({ instance: redis }),
  }),
)

// ─── Middleware: upsert user in DB ─────────────────────────────────────────────

bot.use(async (ctx, next) => {
  const tgUser = ctx.from
  if (tgUser && !tgUser.is_bot) {
    try {
      await prisma.user.upsert({
        where: { telegramId: BigInt(tgUser.id) },
        create: {
          telegramId: BigInt(tgUser.id),
          username: tgUser.username ?? null,
          firstName: tgUser.first_name,
          lastName: tgUser.last_name ?? null,
          languageCode: tgUser.language_code ?? null,
        },
        update: {
          username: tgUser.username ?? null,
          firstName: tgUser.first_name,
          lastName: tgUser.last_name ?? null,
          languageCode: tgUser.language_code ?? null,
        },
      })
    } catch (err) {
      log.error({ err, userId: tgUser.id }, 'Failed to upsert user')
    }
  }
  return next()
})

// ─── Commands ─────────────────────────────────────────────────────────────────

/** /start — greets the user and registers them */
bot.command('start', async (ctx) => {
  const name = ctx.from?.first_name ?? 'there'
  await ctx.reply(
    `Hi ${name}! 👋\n\nI'm your Forge bot. Use /help to see available commands.`,
    { parse_mode: 'HTML' },
  )
})

/** /help — lists available commands */
bot.command('help', async (ctx) => {
  const commands = [
    '/start  — greet the bot',
    '/help   — show this help message',
    '/status — check service status',
    // Add your own commands here
  ]
  await ctx.reply(`<b>Available commands</b>\n\n${commands.join('\n')}`, {
    parse_mode: 'HTML',
  })
})

/** /status — quick health check */
bot.command('status', async (ctx) => {
  const dbOk = await prisma
    .$queryRaw`SELECT 1`
    .then(() => true)
    .catch(() => false)

  const redisOk = redis.status === 'ready'

  const lines = [
    `<b>Service status</b>`,
    '',
    `Database: ${dbOk ? '✅ ok' : '❌ error'}`,
    `Redis:    ${redisOk ? '✅ ok' : '❌ error'}`,
    `Bot:      ✅ running`,
  ]

  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' })
})

// ─── Error handling ───────────────────────────────────────────────────────────

bot.catch((err) => {
  const ctx = err.ctx
  log.error(
    { err: err.error, updateId: ctx.update.update_id },
    'Unhandled bot error',
  )
})

// ─── Start ────────────────────────────────────────────────────────────────────

async function start() {
  await redis.connect()

  if (env.BOT_WEBHOOK_DOMAIN) {
    // ── Webhook mode (production) ──────────────────────────────────────────
    const webhookUrl = `${env.BOT_WEBHOOK_DOMAIN}/webhook`

    await bot.api.setWebhook(webhookUrl, {
      drop_pending_updates: true,
    })

    // grammY's built-in HTTP server for webhook
    const { createServer } = await import('http')
    const { webhookCallback } = await import('grammy')

    const server = createServer(webhookCallback(bot, 'http'))
    server.listen(env.BOT_WEBHOOK_PORT, () => {
      log.info(
        { webhookUrl, port: env.BOT_WEBHOOK_PORT },
        'Bot started in webhook mode',
      )
    })
  } else {
    // ── Long-polling mode (development) ────────────────────────────────────
    await bot.api.deleteWebhook({ drop_pending_updates: true })
    log.info('Bot started in long-polling mode')
    bot.start({
      onStart: (info) => log.info({ username: info.username }, 'Bot online'),
    })
  }
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────

async function shutdown(signal: string) {
  log.info({ signal }, 'Shutting down…')
  bot.stop()
  await redis.quit()
  await prisma.$disconnect()
  process.exit(0)
}

process.once('SIGINT', () => shutdown('SIGINT'))
process.once('SIGTERM', () => shutdown('SIGTERM'))

start().catch((err) => {
  log.fatal({ err }, 'Failed to start bot')
  process.exit(1)
})
