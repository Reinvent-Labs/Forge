/**
 * Cron jobs for the Forge Orchestrator.
 *
 * Jobs:
 * - Every 15min: expire overdue approvals
 * - Every 30min: flush warning log aggregates to notification channels
 * - Every 1h: capture metrics snapshots for all active projects
 * - Every 6h: run security scans on all active projects
 * - Nightly 2am: dependency audit on all projects
 * - Nightly 3am: anomaly detection sweep
 * - 7am daily: send daily digest to all configured notification channels
 * - Weekly Sunday midnight: debt audit, license compliance scan
 * - Monthly 1st: generate debt sprint proposals
 */

import { createLogger } from '@forge/shared'
import { prisma } from '@forge/database'
import type { Orchestrator } from './index.js'

const log = createLogger('cron')

export class CronScheduler {
  private orchestrator: Orchestrator
  private timers: NodeJS.Timeout[] = []

  constructor(orchestrator: Orchestrator) {
    this.orchestrator = orchestrator
  }

  start(): void {
    // Every 15 minutes: expire overdue approvals
    this.timers.push(
      setInterval(
        () => void this.expireApprovals(),
        15 * 60 * 1000,
      ),
    )

    // Every 1 hour: capture metrics snapshots
    this.timers.push(
      setInterval(
        () => void this.captureMetricsSnapshots(),
        60 * 60 * 1000,
      ),
    )

    // Every 6 hours: security scans
    this.timers.push(
      setInterval(
        () => void this.scheduleSecurityScans(),
        6 * 60 * 60 * 1000,
      ),
    )

    // Nightly 2am UTC: dependency audit
    this.scheduleDailyAt(2, 0, () => void this.scheduleNightlyAudit())

    // Daily 7am UTC: daily digest
    this.scheduleDailyAt(7, 0, () => void this.sendDailyDigests())

    // Weekly Sunday midnight: debt audit
    this.scheduleWeeklyOn(0, 0, 0, () => void this.scheduleWeeklyDebtAudit())

    // Monthly 1st: sprint proposals
    this.scheduleMonthlyOn(1, 6, 0, () => void this.scheduleMonthlySprintProposals())

    log.info('Cron scheduler started')
  }

  private async expireApprovals(): Promise<void> {
    try {
      const count = await this.orchestrator.approvalGateway.expireOverdueApprovals()
      if (count > 0) log.info({ count }, 'Expired overdue approvals (cron)')
    } catch (err) {
      log.error({ error: (err as Error).message }, 'Cron: expire approvals failed')
    }
  }

  private async captureMetricsSnapshots(): Promise<void> {
    try {
      const projects = await prisma.project.findMany({
        where: { status: 'ACTIVE' },
        select: { id: true, organizationId: true },
      })

      // Create placeholder metric snapshots (real data flows from integrations)
      for (const project of projects) {
        await prisma.projectMetricsSnapshot.create({
          data: { projectId: project.id },
        })
      }

      log.debug({ count: projects.length }, 'Metrics snapshots captured')
    } catch (err) {
      log.error({ error: (err as Error).message }, 'Cron: metrics snapshot failed')
    }
  }

  private async scheduleSecurityScans(): Promise<void> {
    try {
      const projects = await prisma.project.findMany({
        where: { status: 'ACTIVE' },
        select: { id: true, organizationId: true },
      })

      for (const project of projects) {
        await this.orchestrator.processTask({
          type: 'security_patch',
          priority: 'low',
          projectId: project.id,
          organizationId: project.organizationId,
          payload: { scanType: 'dependency_audit', trigger: 'scheduled' },
          requestedBy: 'system',
          autonomyLevel: 'autonomous',
        })
      }

      log.info({ count: projects.length }, 'Security scans scheduled (cron)')
    } catch (err) {
      log.error({ error: (err as Error).message }, 'Cron: security scans failed')
    }
  }

  private async scheduleNightlyAudit(): Promise<void> {
    try {
      const projects = await prisma.project.findMany({
        where: { status: 'ACTIVE' },
        select: { id: true, organizationId: true },
      })

      for (const project of projects) {
        await this.orchestrator.processTask({
          type: 'security_patch',
          priority: 'low',
          projectId: project.id,
          organizationId: project.organizationId,
          payload: { scanType: 'full', trigger: 'nightly' },
          requestedBy: 'system',
          autonomyLevel: 'autonomous',
        })
      }

      log.info({ count: projects.length }, 'Nightly audits scheduled')
    } catch (err) {
      log.error({ error: (err as Error).message }, 'Cron: nightly audit failed')
    }
  }

  private async sendDailyDigests(): Promise<void> {
    try {
      const projects = await prisma.project.findMany({
        where: { status: 'ACTIVE', notificationConfig: { not: null } },
        select: { id: true, organizationId: true, notificationConfig: true },
      })

      await this.orchestrator.publishEvent({
        type: 'metrics.updated',
        projectId: 'system',
        organizationId: 'system',
        payload: { type: 'daily_digest', projects: projects.map((p) => p.id) },
        sourceAgent: 'orchestrator',
      })

      log.info({ count: projects.length }, 'Daily digests triggered')
    } catch (err) {
      log.error({ error: (err as Error).message }, 'Cron: daily digest failed')
    }
  }

  private async scheduleWeeklyDebtAudit(): Promise<void> {
    try {
      const projects = await prisma.project.findMany({
        where: { status: 'ACTIVE' },
        select: { id: true, organizationId: true },
      })

      for (const project of projects) {
        await this.orchestrator.processTask({
          type: 'update_debt_ledger',
          priority: 'low',
          projectId: project.id,
          organizationId: project.organizationId,
          payload: { trigger: 'weekly_audit' },
          requestedBy: 'system',
          autonomyLevel: 'autonomous',
        })
      }

      log.info({ count: projects.length }, 'Weekly debt audits scheduled')
    } catch (err) {
      log.error({ error: (err as Error).message }, 'Cron: weekly debt audit failed')
    }
  }

  private async scheduleMonthlySprintProposals(): Promise<void> {
    try {
      const projects = await prisma.project.findMany({
        where: { status: 'ACTIVE' },
        select: { id: true, organizationId: true },
      })

      for (const project of projects) {
        await this.orchestrator.processTask({
          type: 'update_debt_ledger',
          priority: 'low',
          projectId: project.id,
          organizationId: project.organizationId,
          payload: { trigger: 'monthly_sprint_proposal' },
          requestedBy: 'system',
          autonomyLevel: 'autonomous',
        })
      }

      log.info({ count: projects.length }, 'Monthly sprint proposals scheduled')
    } catch (err) {
      log.error({ error: (err as Error).message }, 'Cron: monthly sprint proposals failed')
    }
  }

  // ---------------------------------------------------------------------------
  // Scheduling utilities
  // ---------------------------------------------------------------------------

  private scheduleDailyAt(hour: number, minute: number, fn: () => void): void {
    const now = new Date()
    const next = new Date()
    next.setUTCHours(hour, minute, 0, 0)
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1)

    const msUntil = next.getTime() - now.getTime()
    const timer = setTimeout(() => {
      fn()
      this.timers.push(setInterval(fn, 24 * 60 * 60 * 1000))
    }, msUntil)
    this.timers.push(timer)
  }

  private scheduleWeeklyOn(dayOfWeek: number, hour: number, minute: number, fn: () => void): void {
    const now = new Date()
    const next = new Date()
    next.setUTCHours(hour, minute, 0, 0)
    const daysUntil = (7 + dayOfWeek - now.getUTCDay()) % 7 || 7
    next.setUTCDate(now.getUTCDate() + daysUntil)

    const msUntil = next.getTime() - now.getTime()
    const timer = setTimeout(() => {
      fn()
      this.timers.push(setInterval(fn, 7 * 24 * 60 * 60 * 1000))
    }, msUntil)
    this.timers.push(timer)
  }

  private scheduleMonthlyOn(dayOfMonth: number, hour: number, minute: number, fn: () => void): void {
    const now = new Date()
    const next = new Date()
    next.setUTCDate(dayOfMonth)
    next.setUTCHours(hour, minute, 0, 0)
    if (next <= now) next.setUTCMonth(next.getUTCMonth() + 1)

    const msUntil = next.getTime() - now.getTime()
    const timer = setTimeout(() => {
      fn()
      // Re-schedule next month
      this.scheduleMonthlyOn(dayOfMonth, hour, minute, fn)
    }, msUntil)
    this.timers.push(timer)
  }

  stop(): void {
    for (const timer of this.timers) {
      clearTimeout(timer)
      clearInterval(timer)
    }
    this.timers = []
    log.info('Cron scheduler stopped')
  }
}
