# Forge Telegram Bot Template

A production-grade Telegram bot template built for the Forge platform. Ships with PostgreSQL persistence, Redis session storage, structured logging, environment validation, and support for both long-polling and webhook modes.

## Features

- **grammY** — Modern Telegram Bot framework with built-in session support
- **Prisma** — Type-safe PostgreSQL ORM with migrations
- **Redis** — Session storage via `@grammyjs/storage-redis`
- **Pino** — Structured JSON logging with pretty-print for development
- **Zod** — Strict environment variable validation
- **Dual Mode** — Long-polling for development, webhook for production
- **Docker Ready** — Multi-stage Dockerfile with automatic schema migrations
- **TypeScript** — Full type safety out of the box

## Prerequisites

- Node.js 20+
- npm 10+
- PostgreSQL 13+ (local or remote)
- Redis 6+ (or Docker)

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Environment Setup

```bash
cp .env.example .env
```

Edit `.env` with your values:

| Variable | Description | Example |
|----------|-------------|---------|
| `BOT_TOKEN` | Token from [@BotFather](https://t.me/botfather) | `123456:ABC...` |
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://user:pass@localhost:5432/telegram_bot` |
| `REDIS_URL` | Redis connection string | `redis://localhost:6379` |
| `NODE_ENV` | Runtime environment | `development` or `production` |
| `LOG_LEVEL` | Logging level | `debug`, `info`, `warn`, `error` |
| `BOT_WEBHOOK_DOMAIN` | **Optional.** Webhook domain in production | `https://bot.example.com` |
| `BOT_WEBHOOK_PORT` | **Optional.** Webhook port | `8443` (default) |

### 3. Database Setup

Generate Prisma client and run migrations:

```bash
npm run db:generate
npm run db:migrate
```

### 4. Start the Bot

**Development (long-polling):**

```bash
npm run dev
```

Watch for file changes and auto-reload. Polling mode uses less memory and is ideal for local development.

**Production (webhook):**

```bash
npm run build
npm start
```

Requires `BOT_WEBHOOK_DOMAIN` to be set. Bot will immediately register webhook and listen for updates.

## Project Structure

```
telegram-bot/
├── src/
│   └── index.ts          # Main bot entry point, handlers, middleware
├── prisma/
│   └── schema.prisma     # Database schema
├── Dockerfile            # Multi-stage build for production
├── package.json
├── tsconfig.json
├── .env.example
└── README.md
```

## Architecture

### Entry Point

[src/index.ts](src/index.ts) contains:

- **Environment validation** — Zod schema ensures all required vars are set
- **Logger setup** — Pino with pretty-printing in dev
- **Database client** — Prisma singleton with query logging in dev
- **Redis client** — ioredis for session storage
- **Bot instance** — grammY Bot with session middleware
- **Middleware** — Auto-upsert users in database
- **Handlers** — `/start` and text/command handlers (example)

### Session Management

Sessions are persisted in Redis with a TTL. Define your session schema in `SessionData`:

```typescript
interface SessionData {
  step?: string                      // Multi-step conversation state
  data?: Record<string, unknown>     // Wizard/form data
}
```

Access in handlers:

```typescript
bot.command('start', async (ctx) => {
  ctx.session.step = 'awaiting_input'
  ctx.session.data = { startedAt: Date.now() }
  await ctx.reply('Hello!')
})
```

### Database Schema

Edit [prisma/schema.prisma](prisma/schema.prisma) to define your data models. Example user table already included:

```prisma
model User {
  id        Int      @id @default(autoincrement())
  telegramId String  @unique
  username   String?
  firstName  String?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}
```

After changes, generate client and create migration:

```bash
npm run db:migrate
```

### Logging

Pino logs all activity with structured JSON:

```typescript
log.info({ userId: ctx.from.id }, 'User sent message')
log.error({ err }, 'Database error')
log.warn('Warning message')
```

In development, `pino-pretty` formats output. In production, JSON logs are sent to stdout (ideal for Docker/K8s).

## Deployment

### Docker

Build and run:

```bash
docker build -t telegram-bot .
docker run -e BOT_TOKEN=... -e DATABASE_URL=... -e BOT_WEBHOOK_DOMAIN=https://example.com telegram-bot
```

The Dockerfile:
1. Installs dependencies and generates Prisma client
2. Compiles TypeScript
3. Removes dev dependencies and copies final artifacts
4. Auto-runs `prisma migrate deploy` before starting the bot

### Environment Variables in Production

Set these via:
- **Docker**: `-e` flags or `.env` file passed to container
- **Kubernetes**: ConfigMap + Secret
- **Railway/Heroku**: Dashboard environment variables
- **Docker Compose**: `services.bot.environment`

Ensure `BOT_WEBHOOK_DOMAIN` is set to your public HTTPS URL.

## Development Workflow

### Type Checking

```bash
npm run typecheck
```

Catch TypeScript errors without building.

### Testing

```bash
npm run test
```

Run Vitest. Add tests in `src/__tests__` or alongside code as `*.test.ts`.

### Building

```bash
npm run build
```

Compiles TypeScript to `dist/`. Ready for production.

## Handlers & Commands

Modify handlers in `src/index.ts`. Examples:

**Command handler:**

```typescript
bot.command('start', async (ctx) => {
  await ctx.reply('Welcome! Type /help for commands.')
})
```

**Text message handler:**

```typescript
bot.on('message:text', async (ctx) => {
  const { text } = ctx.message
  await ctx.reply(`You said: ${text}`)
})
```

**Button (callback query):**

```typescript
bot.on('callback_query:data', async (ctx) => {
  const data = ctx.callbackQuery.data
  await ctx.answerCallbackQuery()
})
```

See [grammY docs](https://grammy.dev) for full reference.

## Database Queries

Use Prisma in handlers:

```typescript
bot.command('profile', async (ctx) => {
  const user = await prisma.user.findFirst({
    where: { telegramId: String(ctx.from.id) },
  })
  await ctx.reply(`Name: ${user?.firstName || 'Unknown'}`)
})
```

## Error Handling

The bot catches errors and logs them:

```typescript
bot.catch((err) => {
  log.error({ err }, 'Bot error')
})
```

For handler errors:

```typescript
bot.command('fail', async (ctx) => {
  try {
    await riskyOperation()
  } catch (err) {
    log.error({ err }, 'Operation failed')
    await ctx.reply('Something went wrong.')
  }
})
```

## Webhook vs Long-Polling

| Feature | Long-Polling | Webhook |
|---------|--------------|---------|
| **Setup** | None needed | Requires HTTPS + domain |
| **Latency** | 1–3s polling delay | Real-time |
| **Memory** | Low (single connection) | Low (stateless) |
| **Dev-Friendly** | Yes (localhost works) | No (localhost ≠ public URL) |

**How to switch:**

Set `BOT_WEBHOOK_DOMAIN` to enable webhook:

```bash
BOT_WEBHOOK_DOMAIN=https://bot.example.com npm start
```

Omit it (or unset) to use long-polling:

```bash
npm run dev
```

## Troubleshooting

### "BOT_TOKEN is invalid"
Verify token from [@BotFather](https://t.me/botfather). Format: `123456:ABCdefGhIJKlmNoPQRsTUVwxyZ`.

### "Cannot connect to database"
Check `DATABASE_URL` is correct and PostgreSQL is running:

```bash
ping localhost  # or your DB host
psql postgresql://user:pass@localhost:5432/telegram_bot
```

### "Redis connection error"
Ensure Redis is running on port 6379 (or update `REDIS_URL`):

```bash
redis-cli ping  # Should return PONG
```

### Logs not appearing in dev
Check `LOG_LEVEL`. Set to `debug` for verbose output:

```bash
LOG_LEVEL=debug npm run dev
```

### "Webhook already registered"
If switching modes, first deregister the old webhook:

```bash
curl https://api.telegram.org/bot<TOKEN>/deleteWebhook
```

## Environment Checklist

Before deploying:

- [ ] `BOT_TOKEN` is set and valid
- [ ] `DATABASE_URL` points to a live PostgreSQL instance
- [ ] `REDIS_URL` points to a live Redis instance
- [ ] `NODE_ENV=production`
- [ ] `BOT_WEBHOOK_DOMAIN` is set to a valid HTTPS domain (for production)
- [ ] Database migrations have run (`prisma migrate deploy`)
- [ ] Logs are captured (stdout in containers, Pino JSON format)

## Next Steps

1. Define your data model in `prisma/schema.prisma`
2. Run migrations: `npm run db:migrate`
3. Add command handlers and message handlers in `src/index.ts`
4. Test locally: `npm run dev`
5. Build and deploy: `npm run build && npm start` (or use Docker)

## Resources

- [grammY Documentation](https://grammy.dev) — Bot framework reference
- [Prisma Documentation](https://www.prisma.io/docs/) — Database ORM
- [Telegram Bot API](https://core.telegram.org/bots/api) — Official Telegram API docs
- [Redis Documentation](https://redis.io/docs/) — Session storage backend

## License

Part of the Forge platform. See root LICENSE.
