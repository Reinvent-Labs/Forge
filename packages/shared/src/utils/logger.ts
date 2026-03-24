/**
 * Structured logger for all Forge packages.
 * Uses Pino for high-performance structured JSON logging.
 * Every log entry includes: timestamp, level, package, projectId (if available).
 */

import pino from 'pino'

export type LogContext = {
  projectId?: string
  organizationId?: string
  agentType?: string
  taskId?: string
  requestId?: string
  [key: string]: unknown
}

const baseLogger = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  formatters: {
    level(label) {
      return { level: label }
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  base: {
    service: process.env['SERVICE_NAME'] ?? 'forge',
    env: process.env['NODE_ENV'] ?? 'development',
  },
})

/**
 * Create a child logger scoped to a specific package/module.
 * Always call this at the module level, not per-request.
 *
 * @example
 * const log = createLogger('orchestrator')
 * log.info({ projectId }, 'Task routed to builder agent')
 */
export function createLogger(component: string) {
  return baseLogger.child({ component })
}

/**
 * Create a request-scoped logger with context bound in.
 * Call this at the start of each agent task/request.
 */
export function createContextLogger(component: string, ctx: LogContext) {
  return baseLogger.child({ component, ...ctx })
}

export { pino }
export type { Logger } from 'pino'
