# Multi-stage Docker build for the Forge Orchestrator service.
#
# Build context must be the monorepo root so COPY can reach shared workspace
# packages (packages/shared, packages/database) that the orchestrator depends on.
#
# Build command (run from repo root):
#   docker build -f packages/orchestrator/Dockerfile -t forge/orchestrator .
#
# Stage overview:
#   1. base      — shared Node 20 alpine layer with system deps
#   2. deps      — install ALL npm workspaces (needed for tsc path resolution)
#   3. builder   — compile TypeScript → JavaScript in dist/
#   4. runner    — minimal production image: only compiled output + prod deps

# ---------------------------------------------------------------------------
# Stage 1: base
# Establishes the shared base image used by every subsequent stage.
# Alpine is chosen for its small footprint (~5 MB vs ~100 MB for slim).
# ---------------------------------------------------------------------------
FROM node:20-alpine AS base

# `libc6-compat` is required on Alpine for some native Node addons (e.g. sharp,
# bcrypt) that link against glibc. Safe to include even if not currently needed.
RUN apk add --no-cache libc6-compat

WORKDIR /app

# ---------------------------------------------------------------------------
# Stage 2: deps
# Installs all workspace dependencies (including devDependencies) so TypeScript
# can resolve cross-package imports during compilation.
# ---------------------------------------------------------------------------
FROM base AS deps

# Copy workspace manifests first — Docker layer caching means `npm ci` is
# only re-run when a package.json or the lockfile actually changes.
COPY package.json package-lock.json ./
COPY packages/orchestrator/package.json ./packages/orchestrator/
COPY packages/shared/package.json       ./packages/shared/
COPY packages/database/package.json     ./packages/database/

# Install all dependencies (including devDeps needed for tsc)
RUN npm ci

# ---------------------------------------------------------------------------
# Stage 3: builder
# Compiles the orchestrator and its workspace dependencies from TypeScript.
# ---------------------------------------------------------------------------
FROM base AS builder

WORKDIR /app

# Bring in installed node_modules from the deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy source files for the orchestrator and shared packages it imports
COPY packages/orchestrator/ ./packages/orchestrator/
COPY packages/shared/       ./packages/shared/
COPY packages/database/     ./packages/database/

# Copy root tsconfig if it exists (workspaces often extend it)
COPY tsconfig*.json ./

# Compile TypeScript. Output is written to packages/orchestrator/dist/
# as configured in the orchestrator's tsconfig.json.
RUN cd packages/orchestrator && npx tsc

# ---------------------------------------------------------------------------
# Stage 4: runner
# Lean production image. Contains only:
#   - compiled JavaScript (dist/)
#   - production node_modules (no devDependencies)
#   - a non-root user for security hardening
# ---------------------------------------------------------------------------
FROM node:20-alpine AS runner

# Install libc6-compat in the final stage too (runtime native addons may need it)
RUN apk add --no-cache libc6-compat

WORKDIR /app

# Create a dedicated non-root user/group to run the process.
# Running as root inside a container is a security anti-pattern.
RUN addgroup --system --gid 1001 forge && \
    adduser  --system --uid 1001 --ingroup forge forge

# Copy production node_modules (avoids including devDeps in the final image)
COPY --from=deps /app/node_modules ./node_modules

# Copy the compiled output from the builder stage
COPY --from=builder /app/packages/orchestrator/dist ./dist

# Copy the package.json so `node` can resolve the package name and `npm start`
# works if needed for health-check scripts.
COPY packages/orchestrator/package.json ./package.json

# Switch to the non-root user before starting the process
USER forge

# Expose the Fastify HTTP port (default 3001; override with PORT env var)
EXPOSE 3001

# Health check: hit the /health endpoint every 30s.
# The orchestrator's Fastify server should expose GET /health returning 200.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-3001}/health || exit 1

# Start the compiled server
CMD ["node", "dist/server.js"]
