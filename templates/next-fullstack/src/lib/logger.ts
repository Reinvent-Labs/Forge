/**
 * Structured logger for {{PROJECT_NAME}}.
 * Uses Pino for high-performance JSON logging.
 * In production: JSON to stdout (consumed by log aggregator).
 * In development: pretty-printed to console.
 */

import pino from 'pino'

export const logger = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  ...(process.env['NODE_ENV'] === 'development'
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss' },
        },
      }
    : {}),
  base: {
    service: '{{PROJECT_SLUG}}',
    env: process.env['NODE_ENV'],
  },
})
