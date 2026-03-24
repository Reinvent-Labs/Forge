/**
 * @forge/adapter-slack — NotificationRouter
 *
 * Routes ForgeEvents to the correct Slack/Telegram/email channels based on
 * per-project NotificationConfig and NotificationRule settings.
 *
 * Features:
 *  - Severity filtering: each rule has a minSeverity threshold
 *  - Schedule filtering: rules can restrict delivery to time windows
 *  - Rate limiting: max 10 non-critical notifications per channel per hour
 *  - Escalation: if a notification is unacknowledged, escalates after N minutes
 *  - Approval routing: sends to all configured approval channels
 */

import { createLogger } from '@forge/shared';
import type {
  NotificationConfig,
  NotificationRule,
  ForgeEvent,
  ApprovalRequest,
  ApprovalNotification,
  Severity,
  NotificationChannel,
} from '@forge/shared';
import type { SlackAdapter } from './index.js';

const log = createLogger('notification-router');

// =============================================================================
// SEVERITY ORDERING
// =============================================================================

/** Numeric severity rank -- higher means more severe. */
const SEVERITY_RANK: Record<Severity, number> = {
  critical: 4,
  high:     3,
  medium:   2,
  low:      1,
  info:     0,
};

// =============================================================================
// ESCALATION TRACKING
// =============================================================================

interface EscalationEntry {
  eventId: string;
  projectId: string;
  scheduledAt: Date;
  channels: NotificationChannel[];
  payload: unknown;
  acknowledged: boolean;
}

// =============================================================================
// NOTIFICATION ROUTER
// =============================================================================

/**
 * NotificationRouter evaluates notification rules for a project and routes
 * ForgeEvents to the appropriate Slack channels.
 *
 * Construct with the project NotificationConfig and the SlackAdapter.
 * Call send() for general events and sendApproval() for approval requests.
 *
 * @example
 * const router = new NotificationRouter({
 *   config: project.notificationConfig,
 *   slackAdapter,
 * });
 * await router.send(event, projectId);
 */
export class NotificationRouter {
  private readonly config: NotificationConfig;
  private readonly slackAdapter: SlackAdapter;

  /**
   * Per-channel timestamp windows for rate limiting.
   * Maps channelId -> array of send timestamps in the last hour.
   */
  private readonly rateLimitWindows = new Map<string, number[]>();

  /**
   * Pending escalations, keyed by eventId.
   * Cleared when the event is acknowledged.
   */
  private readonly escalations = new Map<string, EscalationEntry>();

  /** Max non-critical notifications per channel per hour. */
  private static readonly RATE_LIMIT_MAX = 10;

  /** Rate limit rolling window in milliseconds (1 hour). */
  private static readonly RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

  constructor(config: {
    config: NotificationConfig;
    slackAdapter: SlackAdapter;
  }) {
    this.config = config.config;
    this.slackAdapter = config.slackAdapter;
    log.info('NotificationRouter initialised');
  }

  // -- Public API ----------------------------------------------------------

  /**
   * Route a ForgeEvent to the appropriate notification channels.
   *
   * Applies the following checks in order:
   *  1. Find matching NotificationRules for the event type
   *  2. Filter by minSeverity -- skip if event is below threshold
   *  3. Filter by schedule (TimeWindow) -- skip if outside delivery window
   *  4. Apply rate limiting -- skip non-critical if channel is overloaded
   *  5. Send to all channels defined by matching rules
   *  6. Schedule escalation if the rule has an EscalationConfig
   *
   * @param event     - The ForgeEvent to route
   * @param projectId - The project ID (used for channel lookup)
   */
  async send(event: ForgeEvent<unknown>, projectId: string): Promise<void> {
    const eventSeverity = this.extractSeverity(event);
    const matchingRules = this.config.rules.filter((rule) => rule.eventType === event.type.replace('.', '_'));

    if (matchingRules.length === 0) {
      log.debug(
        { eventType: event.type, projectId },
        'No notification rules match this event type',
      );
      return;
    }

    for (const rule of matchingRules) {
      // 1. Severity filter
      if (!this.meetsSeverityThreshold(eventSeverity, rule.minSeverity)) {
        log.debug(
          { eventType: event.type, eventSeverity, minSeverity: rule.minSeverity },
          'Event below severity threshold -- skipping rule',
        );
        continue;
      }

      // 2. Schedule filter
      if (rule.schedule !== undefined && !this.isWithinSchedule(rule.schedule)) {
        log.debug(
          { eventType: event.type, schedule: rule.schedule },
          'Event outside delivery time window -- skipping rule',
        );
        continue;
      }

      const isCritical = eventSeverity === 'critical';

      // 3. Send to all channels in the rule
      for (const channel of rule.channels) {
        if (channel === 'slack') {
          await this.sendToSlack(event, isCritical);
        }
        // Telegram and email channels are handled by their respective adapters
        // which the host application wires in.
      }

      // 4. Schedule escalation if configured
      if (rule.escalation !== undefined) {
        this.scheduleEscalation(event, rule, eventSeverity);
      }
    }
  }

  /**
   * Send an approval request notification to all configured approval channels.
   *
   * Unlike regular events, approval notifications are always sent regardless
   * of schedule or rate limits -- founders need to see these.
   *
   * @param approval  - The ApprovalRequest to notify about
   * @param projectId - The project ID
   */
  async sendApproval(approval: ApprovalRequest, projectId: string): Promise<void> {
    log.info(
      { approvalId: approval.id, projectId, riskLevel: approval.riskLevel },
      'Routing approval notification',
    );

    const notification: ApprovalNotification = {
      summary: approval.title,
      businessImpact: approval.businessImpact,
      riskLevel: approval.riskLevel,
      confidenceScore: approval.confidenceScore.total,
      approveToken: approval.approveToken,
      rejectToken: approval.rejectToken,
      expiresAt: approval.expiresAt,
      approvalId: approval.id,
      // projectName would come from DB lookup in production
      projectName: projectId,
    };

    // Send to Slack if configured
    if (
      this.config.channels.includes('slack') &&
      this.config.slackChannelId !== undefined
    ) {
      try {
        await this.slackAdapter.sendApprovalNotification(
          this.config.slackChannelId,
          notification,
        );
        log.info({ approvalId: approval.id }, 'Approval notification sent to Slack');
      } catch (err) {
        log.error({ err, approvalId: approval.id }, 'Failed to send approval to Slack');
      }
    }
  }

  /**
   * Mark an event as acknowledged, cancelling any pending escalation.
   * Call this when a founder has viewed or acted on the notification.
   *
   * @param eventId - The ForgeEvent ID to acknowledge
   */
  acknowledge(eventId: string): void {
    const entry = this.escalations.get(eventId);
    if (entry === undefined) return;

    entry.acknowledged = true;
    this.escalations.delete(eventId);
    log.info({ eventId }, 'Notification acknowledged -- escalation cancelled');
  }

  // -- Private Helpers -----------------------------------------------------

  /**
   * Extract the severity from a ForgeEvent payload.
   * Falls back to 'info' if the payload does not include a severity field.
   */
  private extractSeverity(event: ForgeEvent<unknown>): Severity {
    const payload = event.payload as Record<string, unknown>;
    const raw = typeof payload['severity'] === 'string' ? payload['severity'] : 'info';
    return (raw as Severity) in SEVERITY_RANK ? (raw as Severity) : 'info';
  }

  /**
   * Check whether the event severity meets the rule minimum threshold.
   *
   * @param eventSeverity - Severity of the incoming event
   * @param minSeverity   - Minimum severity required by the rule
   */
  private meetsSeverityThreshold(eventSeverity: Severity, minSeverity: Severity): boolean {
    return SEVERITY_RANK[eventSeverity] >= SEVERITY_RANK[minSeverity];
  }

  /**
   * Check whether the current UTC time falls within the given TimeWindow.
   *
   * @param schedule - TimeWindow with optional dayOfWeek and startHour/endHour (UTC)
   */
  private isWithinSchedule(schedule: NotificationRule['schedule']): boolean {
    if (schedule === undefined) return true;

    const now = new Date();
    const hourUTC = now.getUTCHours();
    const dayUTC = now.getUTCDay();

    // Check day-of-week constraint
    if (schedule.dayOfWeek !== undefined && !schedule.dayOfWeek.includes(dayUTC)) {
      return false;
    }

    // Check hour range (supports wrap-around, e.g. 22:00 to 02:00)
    if (schedule.startHour <= schedule.endHour) {
      return hourUTC >= schedule.startHour && hourUTC < schedule.endHour;
    }

    // Overnight window (e.g. startHour=22, endHour=6)
    return hourUTC >= schedule.startHour || hourUTC < schedule.endHour;
  }

  /**
   * Check whether a notification can be sent to a channel.
   * Non-critical events are capped at RATE_LIMIT_MAX per hour.
   *
   * @param channelKey - Unique key for the channel (e.g. 'slack:C01234')
   * @param isCritical - Critical events bypass the rate limit
   */
  private checkRateLimit(channelKey: string, isCritical: boolean): boolean {
    if (isCritical) return true;

    const now = Date.now();
    const window = this.rateLimitWindows.get(channelKey) ?? [];
    const cutoff = now - NotificationRouter.RATE_LIMIT_WINDOW_MS;
    const recent = window.filter((ts) => ts > cutoff);

    if (recent.length >= NotificationRouter.RATE_LIMIT_MAX) {
      log.warn(
        { channelKey, count: recent.length },
        'Rate limit reached -- skipping notification',
      );
      return false;
    }

    recent.push(now);
    this.rateLimitWindows.set(channelKey, recent);
    return true;
  }

  /**
   * Send the event notification to Slack if a channel is configured.
   * Applies per-channel rate limiting.
   *
   * @param event      - The ForgeEvent to notify about
   * @param isCritical - Whether to bypass rate limiting
   */
  private async sendToSlack(event: ForgeEvent<unknown>, isCritical: boolean): Promise<void> {
    const channelId = this.config.slackChannelId;
    if (channelId === undefined) {
      log.debug('No Slack channel configured -- skipping');
      return;
    }

    const channelKey = `slack:${channelId}`;
    if (!this.checkRateLimit(channelKey, isCritical)) return;

    // Build a human-readable summary from the event payload
    const payload = event.payload as Record<string, unknown>;
    const title = typeof payload['title'] === 'string' ? payload['title'] : event.type;
    const summary = typeof payload['summary'] === 'string' ? payload['summary'] : JSON.stringify(payload).substring(0, 200);

    try {
      await this.slackAdapter.boltApp.client.chat.postMessage({
        channel: channelId,
        text: `${title} ${summary}`,
      });
      log.debug({ channelId, eventType: event.type }, 'Notification sent to Slack');
    } catch (err) {
      log.error({ err, channelId, eventType: event.type }, 'Failed to send Slack notification');
    }
  }

  /**
   * Schedule an escalation for an event notification.
   * If the event is not acknowledged within escalation.afterMinutes,
   * the notification is re-sent to the escalation channels.
   *
   * @param event         - The ForgeEvent to escalate
   * @param rule          - The NotificationRule with escalation config
   * @param eventSeverity - Used to bypass rate limits for critical escalations
   */
  private scheduleEscalation(
    event: ForgeEvent<unknown>,
    rule: NotificationRule,
    eventSeverity: Severity,
  ): void {
    if (rule.escalation === undefined) return;

    const { afterMinutes, escalateTo } = rule.escalation;
    const escalateAt = new Date(Date.now() + afterMinutes * 60 * 1000);

    const entry: EscalationEntry = {
      eventId: event.id,
      projectId: event.projectId,
      scheduledAt: escalateAt,
      channels: escalateTo,
      payload: event.payload,
      acknowledged: false,
    };

    this.escalations.set(event.id, entry);

    log.info(
      {
        eventId: event.id,
        afterMinutes,
        escalateTo,
        scheduledAt: escalateAt,
      },
      'Escalation scheduled',
    );

    // Use a simple setTimeout for in-process escalation.
    // For production workloads, replace this with a durable job queue (BullMQ/Redis)
    // to survive process restarts.
    setTimeout(() => {
      void this.executeEscalation(entry, eventSeverity);
    }, afterMinutes * 60 * 1000);
  }

  /**
   * Execute a scheduled escalation if the event was not acknowledged.
   *
   * @param entry         - EscalationEntry created at schedule time
   * @param eventSeverity - Used to bypass rate limits for critical escalations
   */
  private async executeEscalation(
    entry: EscalationEntry,
    eventSeverity: Severity,
  ): Promise<void> {
    if (entry.acknowledged) {
      log.debug({ eventId: entry.eventId }, 'Escalation skipped -- already acknowledged');
      return;
    }

    log.warn(
      { eventId: entry.eventId, channels: entry.channels },
      'Escalating unacknowledged notification',
    );

    const isCritical = eventSeverity === 'critical';

    for (const channel of entry.channels) {
      if (channel === 'slack' && this.config.slackChannelId !== undefined) {
        const channelKey = `escalation:slack:${this.config.slackChannelId}`;
        if (!this.checkRateLimit(channelKey, isCritical)) continue;

        try {
          await this.slackAdapter.boltApp.client.chat.postMessage({
            channel: this.config.slackChannelId,
            text: `⚠️ *Escalation* -- notification not acknowledged. Event ID: ${entry.eventId}`,
          });
        } catch (err) {
          log.error({ err, eventId: entry.eventId }, 'Failed to send escalation notification');
        }
      }
      // Other channels (telegram, email) handled by host application
    }
  }
}

