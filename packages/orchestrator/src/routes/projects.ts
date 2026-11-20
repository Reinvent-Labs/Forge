/**
 * Project API routes
 * Handles: project CRUD, health snapshots, metrics, incidents, approvals, debt
 * Every handler checks the caller's membership in the project's organization.
 */

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '@forge/database'
import { createLogger } from '@forge/shared'
import { HttpError, isOrgAdmin, requireCaller, requireOrgPermission, requireProjectPermission } from '../auth.js'

const log = createLogger('routes:projects')

const CreateProjectSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().optional(),
  organizationId: z.string().uuid().optional(),
  autonomyLevel: z.enum(['SUGGEST', 'SEMI', 'AUTONOMOUS']).default('SUGGEST'),
})

const UpdateSettingsSchema = z.object({
  autonomyLevel: z.enum(['SUGGEST', 'SEMI', 'AUTONOMOUS']).optional(),
  codingStandards: z.string().optional(),
  notificationConfig: z.record(z.unknown()).optional(),
})

export async function registerProjectRoutes(app: FastifyInstance): Promise<void> {

  // List projects for an organization
  app.get('/api/projects', async (request, reply) => {
    const query = request.query as { organizationId?: string }
    const organizationId = query.organizationId ?? requireCaller(request).organizationId
    if (!organizationId) {
      return reply.status(400).send({ error: 'organizationId required' })
    }

    await requireOrgPermission(request, organizationId, 'audit:read')

    const projects = await prisma.project.findMany({
      where: { organizationId, status: { not: 'ARCHIVED' } },
      select: {
        id: true, name: true, slug: true, status: true,
        startupStage: true, autonomyLevel: true,
        productionUrl: true, createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    })

    return projects
  })

  // Create project
  app.post('/api/projects', async (request, reply) => {
    const body = CreateProjectSchema.safeParse(request.body)
    if (!body.success) {
      return reply.status(400).send({ error: body.error.flatten() })
    }

    const organizationId = body.data.organizationId ?? requireCaller(request).organizationId
    if (!organizationId) {
      return reply.status(400).send({ error: 'organizationId required' })
    }

    await requireOrgPermission(request, organizationId, 'project:create')

    const slug = body.data.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')

    const project = await prisma.project.create({
      data: {
        organizationId,
        name: body.data.name,
        slug,
        description: body.data.description,
        autonomyLevel: body.data.autonomyLevel,
      },
    })

    return reply.status(201).send(project)
  })

  // Get project health snapshot
  app.get('/api/projects/:projectId/health', async (request, reply) => {
    const { projectId } = request.params as { projectId: string }
    await requireProjectPermission(request, projectId, 'audit:read')

    try {
      const [latestMetrics, pendingApprovals, activeIncidents, openPRs, securityScan] =
        await Promise.all([
          prisma.projectMetricsSnapshot.findFirst({
            where: { projectId },
            orderBy: { capturedAt: 'desc' },
          }),
          prisma.approvalRequest.count({ where: { projectId, status: 'PENDING' } }),
          prisma.incident.count({ where: { projectId, status: { in: ['OPEN', 'ACKNOWLEDGED'] } } }),
          prisma.agentTask.count({
            where: { projectId, type: 'REVIEW_PR', status: 'COMPLETED', prNumber: { not: null } },
          }),
          prisma.securityScan.findFirst({
            where: { projectId, status: 'COMPLETED' },
            orderBy: { completedAt: 'desc' },
          }),
        ])

      // Compute simple aggregate health score
      let score = 100
      if (activeIncidents > 0) score -= Math.min(40, activeIncidents * 15)
      if (pendingApprovals > 3) score -= 5
      const errorRate = latestMetrics?.errorRate ?? 0
      if (errorRate > 5) score -= 20
      else if (errorRate > 1) score -= 10
      const uptime = latestMetrics?.uptimePercent ?? 100
      if (uptime < 99) score -= 15
      else if (uptime < 99.9) score -= 5
      score = Math.max(0, score)

      return {
        score,
        uptime: latestMetrics?.uptimePercent ?? 100,
        errorRate: latestMetrics?.errorRate ?? 0,
        p95Latency: latestMetrics?.p95Latency ?? 0,
        pendingApprovals,
        activeIncidents,
        openPRs,
        securityScore: securityScan
          ? (securityScan.score ?? 100)
          : 100,
        debtScore: 100,  // computed separately by Debt Agent
      }
    } catch (err) {
      log.error({ error: (err as Error).message, projectId }, 'Failed to get health')
      return reply.status(500).send({ error: 'Internal server error' })
    }
  })

  // List incidents
  app.get('/api/projects/:projectId/incidents', async (request, reply) => {
    const { projectId } = request.params as { projectId: string }
    await requireProjectPermission(request, projectId, 'audit:read')
    const query = request.query as { limit?: string; status?: string }
    const limit = parseInt(query.limit ?? '10', 10)

    const incidents = await prisma.incident.findMany({
      where: {
        projectId,
        ...(query.status ? { status: query.status as never } : {}),
      },
      orderBy: { detectedAt: 'desc' },
      take: limit,
    })

    return incidents
  })

  // List pending approvals
  app.get('/api/projects/:projectId/approvals', async (request, reply) => {
    const { projectId } = request.params as { projectId: string }
    await requireProjectPermission(request, projectId, 'audit:read')

    // Never select approveToken / rejectToken: they authorize one-click approval
    const approvals = await prisma.approvalRequest.findMany({
      where: { projectId, status: 'PENDING' },
      orderBy: { expiresAt: 'asc' },
      select: {
        id: true,
        projectId: true,
        taskId: true,
        agentType: true,
        title: true,
        businessImpact: true,
        technicalDetails: true,
        confidenceScore: true,
        riskLevel: true,
        status: true,
        expiresAt: true,
        approvedById: true,
        approvedAt: true,
        rejectionReason: true,
        createdAt: true,
        updatedAt: true,
        task: { select: { type: true, priority: true } },
      },
    })

    return approvals
  })

  // Get debt items
  app.get('/api/projects/:projectId/debt', async (request, reply) => {
    const { projectId } = request.params as { projectId: string }
    await requireProjectPermission(request, projectId, 'audit:read')
    const query = request.query as { severity?: string }

    const items = await prisma.debtItem.findMany({
      where: {
        projectId,
        resolvedAt: null,
        ...(query.severity ? { severity: query.severity.toUpperCase() as never } : {}),
      },
      orderBy: [{ severity: 'desc' }, { detectedAt: 'asc' }],
    })

    return items
  })

  // Get metrics snapshots
  app.get('/api/projects/:projectId/metrics', async (request, reply) => {
    const { projectId } = request.params as { projectId: string }
    await requireProjectPermission(request, projectId, 'audit:read')
    const query = request.query as { days?: string }
    const days = parseInt(query.days ?? '30', 10)
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

    const snapshots = await prisma.projectMetricsSnapshot.findMany({
      where: { projectId, capturedAt: { gte: since } },
      orderBy: { capturedAt: 'asc' },
    })

    return snapshots
  })

  // Update project settings
  app.post('/api/projects/:projectId/settings', async (request, reply) => {
    const { projectId } = request.params as { projectId: string }
    const body = UpdateSettingsSchema.safeParse(request.body)

    if (!body.success) {
      return reply.status(400).send({ error: body.error.flatten() })
    }

    const { role } = await requireProjectPermission(request, projectId, 'project:configure')
    if (body.data.autonomyLevel && !isOrgAdmin(role)) {
      throw new HttpError(403, 'Only organization owners and admins can change the autonomy level')
    }

    const updated = await prisma.project.update({
      where: { id: projectId },
      data: {
        ...(body.data.autonomyLevel ? { autonomyLevel: body.data.autonomyLevel } : {}),
        ...(body.data.codingStandards ? { codingStandards: body.data.codingStandards } : {}),
        ...(body.data.notificationConfig ? { notificationConfig: body.data.notificationConfig } : {}),
      },
      select: {
        id: true, name: true, slug: true, status: true,
        startupStage: true, autonomyLevel: true, codingStandards: true,
        notificationConfig: true, productionUrl: true, updatedAt: true,
      },
    })

    return updated
  })

  // Get activity feed (agent tasks)
  app.get('/api/projects/:projectId/activity', async (request, reply) => {
    const { projectId } = request.params as { projectId: string }
    await requireProjectPermission(request, projectId, 'audit:read')
    const query = request.query as { page?: string; agentType?: string }
    const page = parseInt(query.page ?? '1', 10)
    const limit = 20

    const tasks = await prisma.agentTask.findMany({
      where: {
        projectId,
        status: { in: ['COMPLETED', 'FAILED'] },
        ...(query.agentType ? { agentType: query.agentType.toUpperCase() as never } : {}),
      },
      orderBy: { completedAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    })

    return tasks
  })

  // Get recent logs (placeholder — real logs come from Watcher Agent)
  app.get('/api/projects/:projectId/logs', async (request, reply) => {
    const { projectId } = request.params as { projectId: string }
    await requireProjectPermission(request, projectId, 'audit:read')

    // In production this queries the Watcher Agent's log store (Redis/Loki)
    // For now return recent audit log entries
    const logs = await prisma.auditLog.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    })

    return logs.map((l) => ({
      timestamp: l.createdAt,
      level: l.outcome === 'failure' ? 'error' : 'info',
      message: `${l.action} on ${l.resourceType}${l.resourceId ? ` (${l.resourceId.substring(0, 8)})` : ''}`,
      source: l.actor,
    }))
  })
}
