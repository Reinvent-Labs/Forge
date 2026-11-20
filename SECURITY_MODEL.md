# Security model — Forge

Facts marked **(user)** come from the owner; everything else was inferred from the code. Used as the threat model for Devin security scans; edit it when the system changes.

## Forge (`forge.reinvent-labs.com`)

Multi-agent "AI CTO" platform: Next.js dashboard, Fastify orchestrator, AI agents that read/write customer repos via a GitHub App and deploy via Vercel/Railway/Render/Fly tokens.

Components
- **Forge-Dashboard** — `apps/dashboard` (NextAuth middleware), `apps/landing` (static marketing).
- **Forge-Orchestrator** — `packages/orchestrator` (REST `/api/*`, `/ws`, approval links `/api/approvals/action?token=`, tasks, cron), `packages/auth` (Better Auth, orgs, RBAC owner/admin/developer/viewer, API keys).
- **Forge-Webhooks** — `packages/orchestrator/src/routes/webhooks.ts`, `packages/github`, `packages/adapters/{slack,telegram}` (GitHub/Slack/Telegram/Sentry/PostHog/Vercel webhooks per project).
- **Forge-Agents** — `packages/agents/*` (builder, fixer, devops, security…): LLM-driven code changes, shell execution (`child_process`), deployments; prompt-injection surface from repo content, logs and chat.
- **Forge-Secrets** — `packages/shared` crypto/tokens, Vault/Doppler, `MASTER_ENCRYPTION_KEY` per-tenant credential encryption, `packages/database` (Prisma + pgvector).
- **Forge-Infra** — `docker-compose.yml`, `infra/`, `packages/orchestrator/Dockerfile`, `.github/workflows/deploy-*.yml`, `templates/`.

Trust boundaries / entry points
- Internet → dashboard/orchestrator; tenant isolation between organizations is the key boundary.
- Third-party webhooks → orchestrator (signature verification per provider).
- Untrusted content (customer code, logs, issues, chat messages) → LLM agents → tools with GitHub write and deploy credentials.

Assets
- Customers' GitHub App installation tokens, cloud/deploy tokens, encrypted tenant credentials.
- Customer source code and production logs.
- AI provider keys and spend.

## Attacker profiles
- Anonymous internet user.
- Tenant user of another Forge organization: wants cross-tenant access.
- Malicious content author: prompt injection.
- Forged webhook sender against payment/messaging webhooks.

## Existing controls (observed)
- Forge: helmet, CORS to `DASHBOARD_URL`, Better Auth with email verification in production, hashed API keys.

## Critical assets **(user)**
- Forge customers' GitHub/cloud credentials and code.

## Out of scope / accepted risk / lower priority **(user)**
- Denial of service and AI-cost abuse (rate limits, token spend, resource exhaustion): accepted risk / low priority.
- Forge as a whole: prototype, lower priority than Academy and Aya. Exception: findings exposing customers' GitHub/cloud credentials or code (a named critical asset) keep their severity.
- The owner also selected "nothing ruled out, every finding matters" — read as: everything not listed above keeps the scanner's severity.

## Open questions
- Who can get an account? Unknown to the owner; the code allows public email/password sign-up, so assume anyone on the internet (inferred).
