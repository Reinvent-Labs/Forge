/**
 * Validated environment configuration.
 * Fails fast with a clear error message if required variables are missing.
 */

import { z } from 'zod'

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url().optional(),
  JWT_SECRET: z.string().min(32),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  ALLOWED_ORIGINS: z.string().optional(), // Comma-separated list for production CORS
})

export type Env = z.infer<typeof envSchema>

/**
 * Parse and validate the current process environment.
 * Throws a descriptive ZodError on the first missing or invalid variable.
 */
export function loadEnv(): Env {
  const result = envSchema.safeParse(process.env)

  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n')

    throw new Error(`Environment validation failed:\n${issues}\n\nCheck your .env file against .env.example`)
  }

  return result.data
}
