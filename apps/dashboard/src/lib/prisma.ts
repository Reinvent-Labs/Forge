import { PrismaClient } from '@prisma/client'

/**
 * Prisma singleton for the dashboard app.
 * Uses globalThis to avoid creating new connections on every hot-reload in development.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    datasources: {
      db: {
        url:
          process.env.DATABASE_URL ??
          'postgresql://forge:password@localhost:5435/forge',
      },
    },
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma
