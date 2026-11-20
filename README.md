# Forge

**Your AI startup CTO. Built to last.**

Forge is a production-grade, multi-agent platform that gives non-technical founders a complete technical co-founder as infrastructure: it builds applications, monitors production, fixes bugs autonomously, manages security, and surfaces everything through a founder-friendly dashboard.

<div align="center">
  <a href="https://forge.reinvent-labs.com" target="_blank">
    <img src="apps/landing/public/favicon.svg" width="64" height="64" alt="Forge Logo">
  </a>
</div>

<div align="center" style="margin: 20px 0;">
  <a href="https://forge.reinvent-labs.com" target="_blank" style="background: #22c55e; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold; margin: 0 10px; display: inline-block;">
    🔥 Launch Forge App
  </a>
  <a href="https://github.com/Reinvent-Labs/Forge" target="_blank" style="background: #18181b; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold; margin: 0 10px; display: inline-block; border: 1px solid #3f3f46;">
    📄 View Documentation
  </a>
</div>

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        FORGE PLATFORM                           │
├─────────────────────────────────────────────────────────────────┤
│  apps/dashboard          Next.js 14 Founder Dashboard           │
├─────────────────────────────────────────────────────────────────┤
│  packages/orchestrator   Central nervous system                 │
│  ├── AgentRouter         Task type → agent routing              │
│  ├── ContextManager      Codebase knowledge graph               │
│  ├── ConfidenceEngine    0-100 deployment scoring               │
│  ├── ApprovalGateway     Human-in-the-loop gate                 │
│  └── EventBus            BullMQ queues per agent                │
├─────────────────────────────────────────────────────────────────┤
│  packages/agents/*       Specialized agents                     │
│  ├── builder             Feature implementation (Claude Sonnet) │
│  ├── fixer               Incident & bug fixing (Claude Sonnet)  │
│  ├── watcher             Log monitoring (Claude Haiku)          │
│  ├── security            Vulnerability scanning (Haiku + tools) │
│  ├── devops              Deployments & cost (Claude Sonnet)     │
│  ├── intent              NLP parsing (Claude Haiku)             │
│  ├── debt                Tech debt tracking (Claude Haiku)      │
│  └── onboarding          Project setup (Claude Sonnet)          │
├─────────────────────────────────────────────────────────────────┤
│  packages/adapters/*     Communication adapters                 │
│  ├── slack               Block Kit, one-click approvals         │
│  └── telegram            grammY bot, inline keyboards           │
├─────────────────────────────────────────────────────────────────┤
│  packages/github         GitHub App integration                 │
│  packages/database       Prisma + PostgreSQL + pgvector         │
│  packages/shared         Types, logger, crypto, tokens          │
│  packages/cli            `forge` CLI tool                       │
└─────────────────────────────────────────────────────────────────┘
```

---

## Quick Start

### Prerequisites

- Node.js 20+
- Docker & Docker Compose
- npm 10+

### 1. Clone & Install

```bash
git clone <this-repo>
cd forge
npm install
```

### 2. Start Infrastructure

```bash
docker compose up -d
# Starts: PostgreSQL, Redis, Vault, Prometheus, Grafana, MinIO
```

### 3. Configure Environment

```bash
cp .env.example .env
# Fill in ANTHROPIC_API_KEY, GITHUB_APP_*, BETTER_AUTH_SECRET

# The dashboard (Next.js) only reads env files from apps/dashboard and will not
# start without a NEXTAUTH_SECRET of at least 32 characters:
(umask 077 && echo "NEXTAUTH_SECRET=$(openssl rand -base64 32)" >> apps/dashboard/.env.local)
```

### 4. Initialize Database

```bash
npm run db:generate
npm run db:migrate
```

### 5. Start Development

```bash
npm run dev
# Orchestrator: http://localhost:4000
# Dashboard:    http://localhost:3000
```

---

## Repository Structure

```
forge/
├── apps/
│   └── dashboard/          # Next.js 14 founder dashboard
├── packages/
│   ├── shared/             # Canonical types, utils (crypto, logger, tokens)
│   ├── database/           # Prisma schema, client, vector search
│   ├── orchestrator/       # Core orchestrator + HTTP server
│   ├── agents/
│   │   ├── builder/        # Code generation & scaffolding
│   │   ├── watcher/        # Log monitoring & anomaly detection
│   │   ├── fixer/          # Incident response & bug fixing
│   │   ├── security/       # Security scanning & scoring
│   │   ├── devops/         # Deployments, rollbacks, cost tracking
│   │   ├── intent/         # NLP intent parsing (Slack/Telegram)
│   │   ├── debt/           # Technical debt tracking & proposals
│   │   └── onboarding/     # Project & developer onboarding
│   ├── adapters/
│   │   ├── slack/          # Slack Block Kit + interactive approvals
│   │   └── telegram/       # Telegram bot + inline keyboards
│   ├── github/             # GitHub App: webhooks, PR creation, file access
│   └── cli/                # `forge` command-line tool
├── templates/
│   ├── next-fullstack/     # Next.js + Prisma + Better Auth + PostHog
│   └── api-service/        # Fastify + Prisma + BullMQ
├── infra/
│   ├── postgres/           # init.sql (extensions)
│   ├── prometheus/         # Scrape config
│   └── grafana/            # Dashboards & datasources
├── docker-compose.yml      # Local dev infrastructure
└── turbo.json              # Turborepo pipeline config
```

---

## CLI Usage

```bash
# Authenticate
forge login

# Set active project
forge project use <projectId>

# Check health
forge status

# Onboard a new project (interactive wizard)
forge init

# Build a feature
forge build "Add a password reset flow"

# Fix a bug
forge fix "Users can't log in with Google OAuth"

# Deploy
forge deploy --env staging
forge deploy --env production

# Security
forge security

# Technical debt
forge debt
forge debt --severity high

# Incidents
forge incidents

# Onboard a developer
forge onboard-dev --name "Jane Smith" --email "jane@startup.com"

# Trigger PR review
forge review 42

# View pending approvals
forge approvals

# Full audit
forge audit
```

---

## Autonomy Levels

| Level | Behavior |
|---|---|
| **Suggest** | Always asks before acting (recommended for new projects) |
| **Semi-autonomous** | Acts on low-risk tasks (tests, docs, deps), asks for medium+ |
| **Autonomous** | Acts unless critical risk (auth, payments, data migrations) |

Configure via dashboard Settings → Autonomy, or: `forge config set autonomy semi`

---

## Agent Routing

| Task Type | Agent | Model |
|---|---|---|
| build_feature, refactor, generate_tests, review_pr | Builder | Claude Sonnet |
| fix_bug, fix_incident | Fixer | Claude Sonnet |
| analyze_logs, classify_alert | Watcher | Claude Haiku |
| security_patch, dependency_update | Security | Claude Haiku |
| deploy, rollback, cost_analysis | DevOps | Claude Sonnet |
| translate_intent | Intent | Claude Haiku |
| update_debt_ledger | Debt | Claude Haiku |
| onboard_project, onboard_developer, generate_postmortem | Onboarding | Claude Sonnet |

---

## Confidence Scoring

Every proposed deployment is scored 0-100:

| Score | Action | Meaning |
|---|---|---|
| 85-100 | `auto_deploy` | All signals green |
| 65-84 | `recommend` | Mostly ready, founder approval suggested |
| 40-64 | `hold` | Concerns present, explicit approval + justification |
| 0-39 | `block` | Not safe to deploy |

Breakdown:
- **Test coverage** (0-20): CI must pass; higher coverage = higher score
- **Module stability** (0-15): Changed modules' incident history
- **CI passing** (0-20): All CI checks green
- **Staging stability** (0-20): Time stable + error rate in staging
- **Security clean** (0-15): No secrets, no critical vulns
- **Deploy timing** (0-10): Penalizes Fridays 3pm+ and weekends

---

## Security Architecture

- **Row-level security** on all DB tables scoped to `organizationId`
- **Per-tenant encryption**: each project's credentials encrypted with a unique AES-256 key
- **GitHub Apps** (not PATs): scoped to specific repos, principle of least privilege
- **Sandboxed agent execution**: no shared filesystem between projects
- **Immutable audit log**: every agent action, API call, credential access — 90-day retention
- **Secret rotation protocol**: on secret detection, immediate notification + rotation guide (never auto-rotate)
- **RBAC**: owner / admin / developer / viewer with granular permissions

---

## Environment Variables

See [.env.example](.env.example) for all required variables.

**Minimum required for local dev:**
```bash
ANTHROPIC_API_KEY=           # Required for all agents
DATABASE_URL=                # PostgreSQL connection
REDIS_URL=                   # Redis connection
BETTER_AUTH_SECRET=          # 32+ random chars
GITHUB_APP_ID=               # GitHub App
GITHUB_APP_PRIVATE_KEY=      # GitHub App PEM key
GITHUB_WEBHOOK_SECRET=       # Webhook signature secret
```

---

## Standalone Deployment Modes

| Mode | Packages | Use Case |
|---|---|---|
| `forge-watcher` | watcher + dashboard metrics | Monitoring only |
| `forge-security` | security agent | CI security scanning only |
| `forge-builder` | builder + orchestrator | AI-powered development |
| `forge-full` | everything | Complete CTO platform |

---

## Contributing

This is a monorepo managed with [Turborepo](https://turbo.build/). All packages must:

- Pass TypeScript strict mode (`tsc --noEmit`)
- Have ≥80% test coverage on business logic
- Use Pino structured logging
- Validate all inputs with Zod
- Handle all errors with typed try/catch
- Include JSDoc on all exported functions

---

*Build Forge. Build it to last.*
