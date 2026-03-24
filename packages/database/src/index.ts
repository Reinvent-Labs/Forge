/**
 * @forge/database
 *
 * Central database client for the Forge platform.
 * Uses Prisma with PostgreSQL + pgvector.
 *
 * All queries are scoped to organizationId at the application level.
 * Row-level security is enforced via middleware to prevent cross-tenant access.
 */

import { PrismaClient } from '@prisma/client'

// ---------------------------------------------------------------------------
// Singleton PrismaClient with logging
// ---------------------------------------------------------------------------

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      process.env['NODE_ENV'] === 'development'
        ? ['query', 'error', 'warn']
        : ['error'],
    errorFormat: 'pretty',
  })

if (process.env['NODE_ENV'] !== 'production') {
  globalForPrisma.prisma = prisma
}

// ---------------------------------------------------------------------------
// Tenant-scoped query helper
// ---------------------------------------------------------------------------

/**
 * Wraps a Prisma query to ensure it is always scoped to an organization.
 * Use this instead of calling prisma directly whenever organizationId is available.
 *
 * @example
 * const projects = await withTenant(organizationId, (tx) =>
 *   tx.project.findMany({ where: { status: 'ACTIVE' } })
 * )
 */
export async function withTenant<T>(
  organizationId: string,
  fn: (tx: PrismaClient) => Promise<T>,
): Promise<T> {
  // In production, Row-Level Security policies on PostgreSQL enforce this.
  // Here we set a session variable that RLS policies can reference.
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `SET LOCAL app.current_organization_id = '${organizationId}'`,
    )
    return fn(tx as unknown as PrismaClient)
  })
}

// ---------------------------------------------------------------------------
// Vector search helper
// ---------------------------------------------------------------------------

/**
 * Find the most similar module embeddings for a given query vector.
 * Uses pgvector's cosine distance operator (<=>).
 */
export async function findSimilarModules(
  contextId: string,
  queryEmbedding: number[],
  topK = 10,
): Promise<Array<{ moduleId: string; path: string; description: string; similarity: number }>> {
  const vectorLiteral = `[${queryEmbedding.join(',')}]`

  const results = await prisma.$queryRaw<
    Array<{ module_id: string; path: string; description: string; similarity: number }>
  >`
    SELECT
      me.id::text as module_id,
      mn.path,
      mn."plainEnglishDescription" as description,
      1 - (me.embedding <=> ${vectorLiteral}::vector) as similarity
    FROM module_embeddings me
    JOIN module_nodes mn ON me."moduleId" = mn.id
    WHERE mn."contextId" = ${contextId}::uuid
    ORDER BY me.embedding <=> ${vectorLiteral}::vector
    LIMIT ${topK}
  `

  return results.map((r) => ({
    moduleId: r.module_id,
    path: r.path,
    description: r.description,
    similarity: r.similarity,
  }))
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

export async function disconnectDb(): Promise<void> {
  await prisma.$disconnect()
}

// Re-export Prisma types for convenience
export type { Prisma } from '@prisma/client'
export * from '@prisma/client'
