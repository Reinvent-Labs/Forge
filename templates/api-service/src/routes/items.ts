/**
 * Example CRUD resource — replace "item" with your domain model.
 *
 * Routes:
 *   GET    /api/v1/items          — list items (paginated)
 *   POST   /api/v1/items          — create item
 *   GET    /api/v1/items/:id      — get item by ID
 *   PATCH  /api/v1/items/:id      — update item
 *   DELETE /api/v1/items/:id      — delete item
 */

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'

// ─── Zod schemas ──────────────────────────────────────────────────────────────

const createItemSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
})

const updateItemSchema = createItemSchema.partial()

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})

// ─── Route plugin ─────────────────────────────────────────────────────────────

export const itemRoutes: FastifyPluginAsync = async (app) => {

  /** List items — paginated */
  app.get('/items', async (req, reply) => {
    const query = paginationSchema.safeParse(req.query)
    if (!query.success) return reply.status(400).send({ error: query.error.flatten() })

    const { page, limit } = query.data
    const skip = (page - 1) * limit

    const [items, total] = await Promise.all([
      app.prisma.item.findMany({ skip, take: limit, orderBy: { createdAt: 'desc' } }),
      app.prisma.item.count(),
    ])

    return reply.send({
      items,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    })
  })

  /** Create item */
  app.post('/items', async (req, reply) => {
    const body = createItemSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: body.error.flatten() })

    const item = await app.prisma.item.create({ data: body.data })
    return reply.status(201).send(item)
  })

  /** Get item by ID */
  app.get<{ Params: { id: string } }>('/items/:id', async (req, reply) => {
    const item = await app.prisma.item.findUnique({ where: { id: req.params.id } })
    if (!item) return reply.status(404).send({ error: 'Not found' })
    return reply.send(item)
  })

  /** Update item */
  app.patch<{ Params: { id: string } }>('/items/:id', async (req, reply) => {
    const body = updateItemSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: body.error.flatten() })

    try {
      const item = await app.prisma.item.update({
        where: { id: req.params.id },
        data: body.data,
      })
      return reply.send(item)
    } catch {
      return reply.status(404).send({ error: 'Not found' })
    }
  })

  /** Delete item */
  app.delete<{ Params: { id: string } }>('/items/:id', async (req, reply) => {
    try {
      await app.prisma.item.delete({ where: { id: req.params.id } })
      return reply.status(204).send()
    } catch {
      return reply.status(404).send({ error: 'Not found' })
    }
  })
}
