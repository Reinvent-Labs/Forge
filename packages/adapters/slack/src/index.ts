/**
 * @forge/adapter-slack
 *
 * Slack integration for the Forge platform using @slack/bolt.
 * Handles incoming messages and sends rich Block Kit notifications for
 * approvals, incidents, daily digests, and task completions.
 *
 * HTTP mode -- does NOT use Socket Mode. Bolt exposes:
 *   POST /slack/events       -- Slack Events API
 *   POST /slack/interactive  -- Interactive component callbacks (button clicks)
 */

import { App } from '@slack/bolt';
import type { ButtonAction } from '@slack/bolt';
import type { KnownBlock } from '@slack/web-api';
import { createLogger } from '@forge/shared';
import type { ApprovalNotification } from '@forge/shared';
import type { ApprovalGateway, ApproverIdentity } from '@forge/orchestrator';

const log = createLogger('adapter-slack');

// =============================================================================
// EXPORTED INTERFACES
// =============================================================================

/** An active production incident requiring immediate founder attention. */
export interface IncidentAlert {
  id: string;
  title: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  affectedUsers?: number;
  whatForgeIsDoing: string;
  timestamp: Date;
}

/** Daily 7am digest payload summarising yesterday activity and today focus. */
export interface DailyDigest {
  date: Date;
  activitiesYesterday: string[];
  metricsSnapshot: { users?: number; errorRate?: number; uptime?: number };
  openApprovals: number;
  todaysFocus: string[];
}

/** Notification sent when an agent completes a task. */
export interface TaskCompleteMessage {
  taskType: string;
  summary: string;
  prUrl?: string;
  durationSeconds?: number;
}

// =============================================================================
// ADAPTER CONFIG
// =============================================================================

export interface SlackAdapterConfig {
  /** Slack app signing secret -- used to verify webhook request signatures */
  signingSecret: string;
  /** Bot OAuth token (xoxb-...) */
  botToken: string;
  /** ApprovalGateway instance for processing approve/reject button clicks */
  approvalGateway: ApprovalGateway;
}

// =============================================================================
// PRIVATE BLOCK KIT HELPERS
// =============================================================================

/** Map a risk level to a colour-coded emoji indicator. */
function riskEmoji(level: ApprovalNotification['riskLevel']): string {
  switch (level) {
    case 'critical': return '🔴';
    case 'high':     return '🔴';
    case 'medium':   return '🟡';
    case 'low':      return '🟢';
  }
}

/**
 * Render a text-based progress bar for a 0-100 score.
 * e.g. score=72, width=10 -> '███████░░░ 72%'
 */
function progressBar(score: number, width = 10): string {
  const filled = Math.round((score / 100) * width);
  const empty = width - filled;
  return `${'█'.repeat(filled)}${'░'.repeat(empty)} ${score}%`;
}

/** Human-readable incident severity label with colour emoji. */
function incidentSeverityLabel(severity: IncidentAlert['severity']): string {
  const map: Record<IncidentAlert['severity'], string> = {
    critical: '🔴 CRITICAL',
    high:     '🟠 HIGH',
    medium:   '🟡 MEDIUM',
    low:      '🟢 LOW',
  };
  return map[severity];
}

/** Format seconds into a human-readable duration (e.g. 125 -> 2m 5s). */
function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
}

// =============================================================================
// BLOCK KIT BUILDERS (exported for unit testing)
// =============================================================================

/**
 * Build Block Kit blocks for a human-in-the-loop approval notification.
 *
 * Layout:
 *  - Header with risk emoji and project name
 *  - Summary of the proposed action
 *  - Business impact
 *  - Risk level + confidence score progress bar (side-by-side fields)
 *  - Optional preview URL link
 *  - Expiry timestamp and approval ID
 *  - Approve / Reject action buttons with confirmation dialogs
 *
 * @param notification - ApprovalNotification from @forge/shared
 */
export function buildApprovalBlocks(notification: ApprovalNotification): KnownBlock[] {
  const {
    summary,
    businessImpact,
    riskLevel,
    confidenceScore,
    previewUrl,
    approveToken,
    rejectToken,
    expiresAt,
    approvalId,
    projectName,
  } = notification;

  const emoji = riskEmoji(riskLevel);
  const bar = progressBar(confidenceScore);

  const blocks: KnownBlock[] = [
    // Header
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `${emoji} Approval Required — ${projectName}`,
        emoji: true,
      },
    },
    { type: 'divider' },
    // Summary of the proposed action
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*What Forge wants to do:*\n${summary}` },
    },
    // Business impact
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Business Impact:*\n${businessImpact}` },
    },
    // Risk level and confidence score side-by-side
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Risk Level:*\n${emoji} ${riskLevel.toUpperCase()}` },
        { type: 'mrkdwn', text: `*Confidence Score:*\n\`${bar}\`` },
      ],
    },
    // Expiry timestamp and approval ID
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `⏰ *Expires:* ${expiresAt.toUTCString()}  |  ID: \`${approvalId}\``,
        },
      ],
    },
  ];

  // Optional preview link -- only shown when previewUrl is provided
  if (previewUrl !== undefined && previewUrl !== '') {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `🔍 <${previewUrl}|View Preview>` },
    });
  }

  blocks.push({ type: 'divider' });

  // Approve and Reject action buttons with confirmation dialogs
  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: '✅ Approve', emoji: true },
        style: 'primary',
        action_id: 'approval_approve',
        value: approveToken,
        confirm: {
          title: { type: 'plain_text', text: 'Confirm Approval' },
          text: {
            type: 'mrkdwn',
            text: `Approving will let Forge proceed with:\n*${summary}*`,
          },
          confirm: { type: 'plain_text', text: 'Yes, Approve' },
          deny:    { type: 'plain_text', text: 'Cancel' },
        },
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: '❌ Reject', emoji: true },
        style: 'danger',
        action_id: 'approval_reject',
        value: rejectToken,
        confirm: {
          title: { type: 'plain_text', text: 'Confirm Rejection' },
          text: {
            type: 'mrkdwn',
            text: 'Forge will not proceed with this action.',
          },
          confirm: { type: 'plain_text', text: 'Yes, Reject' },
          deny:    { type: 'plain_text', text: 'Cancel' },
        },
      },
    ],
  });

  return blocks;
}

/**
 * Build Block Kit blocks for an incident alert notification.
 *
 * @param incident - IncidentAlert payload
 */
export function buildIncidentBlocks(incident: IncidentAlert): KnownBlock[] {
  const severityLabel = incidentSeverityLabel(incident.severity);

  const blocks: KnownBlock[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: '🚨 Incident Detected', emoji: true },
    },
    { type: 'divider' },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Severity:*\n${severityLabel}` },
        { type: 'mrkdwn', text: `*When:*\n${incident.timestamp.toUTCString()}` },
      ],
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*What's happening:*\n${incident.title}` },
    },
  ];

  if (incident.affectedUsers !== undefined) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Estimated affected users:* ~${incident.affectedUsers.toLocaleString()}`,
      },
    });
  }

  blocks.push(
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*What Forge is doing:*\n${incident.whatForgeIsDoing}` },
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `Incident ID: \`${incident.id}\`` }],
    },
  );

  return blocks;
}

/**
 * Build Block Kit blocks for the daily 7am digest message.
 *
 * @param digest - DailyDigest payload
 */
export function buildDailyDigestBlocks(digest: DailyDigest): KnownBlock[] {
  const dateStr = digest.date.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const yesterdayList =
    digest.activitiesYesterday.length > 0
      ? digest.activitiesYesterday.map((a) => `• ${a}`.join('\n')
      : '• No automated activity yesterday';

  const focusList =
    digest.todaysFocus.length > 0
      ? digest.todaysFocus.map((f) => `• ${f}`.join('\n')
      : '• No items scheduled';

  const { users, errorRate, uptime } = digest.metricsSnapshot;
  const metricParts: string[] = [];
  // Build metric parts only for defined values to avoid NaN in output
  if (users !== undefined)     metricParts.push(`👥 *Active users:* ${users.toLocaleString()}`);
  if (errorRate !== undefined) metricParts.push(`⚠️ *Error rate:* ${(errorRate * 100).toFixed(2)}%`);
  if (uptime !== undefined)    metricParts.push(`✅ *Uptime:* ${(uptime * 100).toFixed(3)}%`);
  const metricsText = metricParts.length > 0 ? metricParts.join('  |  ') : '_No metrics available_';

  const openApprovalsText =
    digest.openApprovals > 0
      ? `⏳ *${digest.openApprovals} approval${digest.openApprovals > 1 ? 's' : ''}* — check the Forge dashboard.`
      : '✅ No pending approvals';

  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: `☀️ Forge Daily Digest — ${dateStr}`, emoji: true },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*What Forge did yesterday:*\n${yesterdayList}` },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Metrics snapshot:*\n${metricsText}` },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Today's focus:*\n${focusList}` },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: openApprovalsText },
    },
  ];
}

// =============================================================================
// SLACK ADAPTER CLASS
// =============================================================================

/**
 * SlackAdapter manages the Bolt App, handles incoming Slack messages, and
 * provides typed methods for all outbound notifications Forge sends to Slack.
 *
 * Runs in HTTP mode -- requires a public-facing URL and Slack event
 * subscriptions configured at api.slack.com/apps.
 *
 * @example
 * const adapter = new SlackAdapter({
 *   signingSecret: process.env.SLACK_SIGNING_SECRET!,
 *   botToken: process.env.SLACK_BOT_TOKEN!,
 *   approvalGateway,
 * });
 * await adapter.start(3001);
 */
export class SlackAdapter {
  /** Underlying Bolt App instance. */
  private readonly app: App;

  /** ApprovalGateway for resolving approve/reject token interactions. */
  private readonly approvalGateway: ApprovalGateway;

  /**
   * Maps incident ID -> Slack message timestamp (ts) for thread replies.
   * Populated by sendIncidentAlert; consumed by sendIncidentThreadReply.
   */
  private readonly incidentThreads = new Map<string, string>();

  /**
   * Per-channel notification timestamp windows for rate limiting.
   * Maps channelId -> array of timestamps within the last hour.
   */
  private readonly rateLimitWindows = new Map<string, number[]>();

  /** Maximum non-critical notifications per channel per hour. */
  private static readonly RATE_LIMIT_MAX = 10;

  /** Rolling rate-limit window size in milliseconds (1 hour). */
  private static readonly RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

  constructor(config: SlackAdapterConfig) {
    this.approvalGateway = config.approvalGateway;

    // HTTP mode: Bolt verifies Slack request signatures automatically using
    // the signing secret. No socket mode setup required.
    this.app = new App({
      signingSecret: config.signingSecret,
      token: config.botToken,
      socketMode: false,
    });

    this.registerEventHandlers();
    this.registerInteractiveHandlers();

    log.info('SlackAdapter initialised (HTTP mode)');
  }

  // -- Lifecycle -----------------------------------------------------------

  /**
   * Start the Bolt HTTP receiver on the given port.
   * Bolt registers POST /slack/events and POST /slack/interactive.
   *
   * @param port - Port number (default 3001)
   */
  async start(port = 3001): Promise<void> {
    await this.app.start(port);
    log.info({ port }, 'SlackAdapter HTTP receiver started');
  }

  /** Gracefully shut down the Bolt HTTP receiver. */
  async stop(): Promise<void> {
    await this.app.stop();
    log.info('SlackAdapter stopped');
  }

  // -- Outbound Notifications ----------------------------------------------

  /**
   * Send a rich Block Kit approval notification.
   * Includes summary, business impact, confidence score bar, risk level,
   * optional preview link, expiry time, and Approve / Reject action buttons.
   *
   * @param channelId    - Target Slack channel ID (e.g. 'C01234567')
   * @param notification - ApprovalNotification from @forge/shared
   */
  async sendApprovalNotification(
    channelId: string,
    notification: ApprovalNotification,
  ): Promise<void> {
    log.info(
      { channelId, approvalId: notification.approvalId, riskLevel: notification.riskLevel },
      'Sending approval notification to Slack',
    );

    const blocks = buildApprovalBlocks(notification);

    try {
      await this.app.client.chat.postMessage({
        channel: channelId,
        text: `${riskEmoji(notification.riskLevel)} Approval required: ${notification.summary}`,
        blocks,
      });
    } catch (err) {
      log.error(
        { err, channelId, approvalId: notification.approvalId },
        'Failed to post approval notification',
      );
      throw err;
    }
  }

  /**
   * Send an incident alert to a Slack channel.
   * Stores the message timestamp so follow-up updates can be posted as
   * thread replies via sendIncidentThreadReply.
   *
   * @param channelId - Target Slack channel ID
   * @param incident  - IncidentAlert payload
   */
  async sendIncidentAlert(channelId: string, incident: IncidentAlert): Promise<void> {
    log.info(
      { channelId, incidentId: incident.id, severity: incident.severity },
      'Sending incident alert to Slack',
    );

    const blocks = buildIncidentBlocks(incident);

    try {
      const result = await this.app.client.chat.postMessage({
        channel: channelId,
        text: `🚨 Incident (${incident.severity.toUpperCase()}): ${incident.title}`,
        blocks,
      });

      // Persist thread ts so we can reply on this thread later
      if (typeof result.ts === 'string') {
        this.incidentThreads.set(incident.id, result.ts);
        log.debug({ incidentId: incident.id, ts: result.ts }, 'Incident thread ts stored');
      }
    } catch (err) {
      log.error({ err, channelId, incidentId: incident.id }, 'Failed to post incident alert');
      throw err;
    }
  }

  /**
   * Reply inside an existing incident alert thread.
   * Falls back to a standalone message if the thread timestamp is not tracked.
   *
   * @param channelId  - Slack channel ID
   * @param incidentId - Incident ID (must have been sent via sendIncidentAlert)
   * @param text       - Update text
   */
  async sendIncidentThreadReply(
    channelId: string,
    incidentId: string,
    text: string,
  ): Promise<void> {
    const threadTs = this.incidentThreads.get(incidentId);

    if (threadTs === undefined) {
      log.warn(
        { incidentId },
        'No thread ts for incident -- posting as standalone message',
      );
      await this.app.client.chat.postMessage({ channel: channelId, text });
      return;
    }

    try {
      await this.app.client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text,
      });
    } catch (err) {
      log.error({ err, channelId, incidentId }, 'Failed to post incident thread reply');
      throw err;
    }
  }

  /**
   * Send the 7am daily digest message.
   * Covers yesterday activity, current metrics, open approvals, and today focus.
   *
   * @param channelId - Target Slack channel ID
   * @param digest    - DailyDigest payload
   */
  async sendDailyDigest(channelId: string, digest: DailyDigest): Promise<void> {
    const dateStr = digest.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    log.info({ channelId, date: dateStr }, 'Sending daily digest to Slack');

    const blocks = buildDailyDigestBlocks(digest);

    try {
      await this.app.client.chat.postMessage({
        channel: channelId,
        text: `☀️ Forge Daily Digest — ${dateStr}`,
        blocks,
      });
    } catch (err) {
      log.error({ err, channelId }, 'Failed to post daily digest');
      throw err;
    }
  }

  /**
   * Send a task-completion notification with optional PR link and duration.
   *
   * @param channelId - Target Slack channel ID
   * @param result    - TaskCompleteMessage payload
   */
  async sendTaskComplete(channelId: string, result: TaskCompleteMessage): Promise<void> {
    log.info(
      { channelId, taskType: result.taskType },
      'Sending task complete notification to Slack',
    );

    const durationText =
      result.durationSeconds !== undefined
        ? 
        : '';

    const prText =
      result.prUrl !== undefined && result.prUrl !== ''
        ? `\n🔗 <${result.prUrl}|View Pull Request>`
        : '';

    const blocks: KnownBlock[] = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `✅ *Forge completed: ${result.taskType}${durationText}*\n${result.summary}${prText}`,
        },
      },
    ];

    try {
      await this.app.client.chat.postMessage({
        channel: channelId,
        text: `✅ Forge completed: ${result.taskType}`,
        blocks,
      });
    } catch (err) {
      log.error({ err, channelId, taskType: result.taskType }, 'Failed to post task complete');
      throw err;
    }
  }

  // -- Rate Limiting -------------------------------------------------------

  /**
   * Check whether a notification can be sent to a channel.
   * Non-critical events are capped at 10 per channel per hour.
   * Critical events bypass the limit entirely.
   *
   * @param channelId  - Slack channel ID
   * @param isCritical - If true, rate limiting is bypassed
   * @returns true if the notification should proceed
   */
  checkRateLimit(channelId: string, isCritical = false): boolean {
    if (isCritical) return true;

    const now = Date.now();
    const window = this.rateLimitWindows.get(channelId) ?? [];
    const cutoff = now - SlackAdapter.RATE_LIMIT_WINDOW_MS;
    const recent = window.filter((ts) => ts > cutoff);

    if (recent.length >= SlackAdapter.RATE_LIMIT_MAX) {
      log.warn(
        { channelId, count: recent.length },
        'Slack rate limit reached -- skipping notification',
      );
      return false;
    }

    recent.push(now);
    this.rateLimitWindows.set(channelId, recent);
    return true;
  }

  // -- Inbound Event Handlers ----------------------------------------------

  /**
   * Register Bolt event listeners for incoming messages and @mentions.
   * Delegates to onMessageReceived -- subclass to wire the IntentAgent.
   */
  private registerEventHandlers(): void {
    // Regular channel messages -- ignore edits and bot messages
    this.app.message(async ({ message, say }) => {
      if (message.subtype !== undefined) return;
      if (!('text' in message) || typeof message.text !== 'string') return;

      const text = message.text;
      const userId = 'user' in message ? (message.user as string) : 'unknown';
      const channelId = message.channel;

      log.info({ userId, channelId, textLength: text.length }, 'Received Slack message');

      try {
        await this.onMessageReceived({ text, userId, channelId, say });
      } catch (err) {
        log.error({ err, userId, channelId }, 'Error handling incoming Slack message');
        await say('Sorry, something went wrong. Please try again.');
      }
    });

    // @mention events
    this.app.event('app_mention', async ({ event, say }) => {
      log.info({ userId: event.user, channelId: event.channel }, 'Bot @mentioned');

      try {
        await this.onMessageReceived({
          text: event.text,
          userId: event.user,
          channelId: event.channel,
          say,
        });
      } catch (err) {
        log.error({ err, userId: event.user }, 'Error handling @mention');
        await say('Sorry, something went wrong. Please try again.');
      }
    });
  }

  /**
   * Register interactive component handlers for approve/reject button clicks.
   * Calls ApprovalGateway.processToken and replaces the original message.
   */
  private registerInteractiveHandlers(): void {
    // Approve button handler
    this.app.action('approval_approve', async ({ action, ack, respond, body }) => {
      // Must acknowledge within the Slack 3-second timeout window
      await ack();

      const token = (action as ButtonAction).value;
      const userId = body.user.id;
      const username = body.user.name ?? body.user.username ?? userId;

      log.info({ userId }, 'Approve button clicked');

      try {
        const approver = await this.resolveApprover(userId, username);
        const result = await this.approvalGateway.processToken(token, approver);

        await respond({
          replace_original: true,
          text: `✅ *Approved* by @${username}. Forge is proceeding. (ID: \`${result.approvalId}\`)`,
        });

        log.info({ approvalId: result.approvalId, userId }, 'Approval resolved via Slack');
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        log.error({ err, userId }, 'Failed to process Slack approval');
        await respond({ replace_original: false, text: `❌ Failed to process approval: ${msg}` });
      }
    });

    // Reject button handler
    this.app.action('approval_reject', async ({ action, ack, respond, body }) => {
      await ack();

      const token = (action as ButtonAction).value;
      const userId = body.user.id;
      const username = body.user.name ?? body.user.username ?? userId;

      log.info({ userId }, 'Reject button clicked');

      try {
        const approver = await this.resolveApprover(userId, username);
        const result = await this.approvalGateway.processToken(
          token,
          approver,
          `Rejected via Slack by ${username}`,
        );

        await respond({
          replace_original: true,
          text: `❌ *Rejected* by @${username}. Forge will not proceed. (ID: \`${result.approvalId}\`)`,
        });

        log.info({ approvalId: result.approvalId, userId }, 'Rejection resolved via Slack');
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        log.error({ err, userId }, 'Failed to process Slack rejection');
        await respond({ replace_original: false, text: `❌ Failed to process rejection: ${msg}` });
      }
    });
  }

  /**
   * Map a Slack user to a Forge approver via their Slack profile email.
   * Requires the `users:read.email` bot scope.
   */
  private async resolveApprover(userId: string, username: string): Promise<ApproverIdentity> {
    const info = await this.app.client.users.info({ user: userId });
    const email = info.user?.profile?.email;
    if (!email) {
      throw new Error('Could not resolve your Slack email to a Forge account');
    }
    return { email, displayName: username };
  }

  // -- Extension Point -----------------------------------------------------

  /**
   * Override this in a subclass to route incoming Slack messages to the
   * IntentAgent or any other handler.
   *
   * Default behaviour: logs the message and does nothing.
   *
   * @param params.text      - Raw message text from Slack
   * @param params.userId    - Slack user ID of the sender
   * @param params.channelId - Slack channel where the message arrived
   * @param params.say       - Bolt reply helper
   */
  protected async onMessageReceived(params: {
    text: string;
    userId: string;
    channelId: string;
    say: (message: string) => Promise<unknown>;
  }): Promise<void> {
    log.debug(
      { userId: params.userId, channelId: params.channelId },
      'Message received -- subclass onMessageReceived to connect IntentAgent',
    );
  }

  // -- Accessors -----------------------------------------------------------

  /**
   * Expose the underlying Bolt App for advanced use cases
   * (e.g. adding custom middleware or extra route handlers).
   */
  get boltApp(): App {
    return this.app;
  }
}

