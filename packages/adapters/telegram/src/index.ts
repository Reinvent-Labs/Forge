/**
 * @forge/adapter-telegram
 *
 * Telegram integration for the Forge platform using grammY.
 * Handles incoming messages and sends formatted notifications for
 * approvals, incidents, daily digests, and task completions.
 *
 * Webhook mode: configure Telegram to POST to your public URL via setWebhook.
 */

import { Bot, InlineKeyboard } from 'grammy';
import type { Context } from 'grammy';
import { createLogger } from '@forge/shared';
import type { ApprovalNotification } from '@forge/shared';
import type { ApprovalGateway } from '@forge/orchestrator';

const log = createLogger('adapter-telegram');

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

export interface TelegramAdapterConfig {
  /** Telegram Bot API token from @BotFather */
  botToken: string;
  /** ApprovalGateway instance for processing approve/reject callback queries */
  approvalGateway: ApprovalGateway;
}

// =============================================================================
// PRIVATE FORMATTING HELPERS
// =============================================================================

/** Map a risk level to a coloured emoji indicator. */
function riskEmoji(level: ApprovalNotification['riskLevel']): string {
  switch (level) {
    case 'critical': return '🔴';
    case 'high':     return '🔴';
    case 'medium':   return '🟡';
    case 'low':      return '🟢';
  }
}

/** Human-readable severity label with colour emoji. */
function severityLabel(severity: IncidentAlert['severity']): string {
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

/**
 * Escape a string for Telegram HTML parse mode.
 * Replaces <, >, & with their HTML entities.
 *
 * @param text - Raw string to escape
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// =============================================================================
// MESSAGE FORMATTERS
// =============================================================================

/**
 * Build the HTML-formatted approval notification message.
 *
 * Uses Telegram HTML parse mode with:
 *  - <b> for bold titles
 *  - <i> for emphasis
 *  - <code> for technical values (tokens, IDs)
 *  - Emoji for visual indicators
 *
 * @param notification - ApprovalNotification from @forge/shared
 */
function formatApprovalMessage(notification: ApprovalNotification): string {
  const emoji = riskEmoji(notification.riskLevel);
  const expiryStr = notification.expiresAt.toUTCString();

  let msg = [
    `${emoji} <b>Approval Required — ${escapeHtml(notification.projectName)}</b>`,
    '',
    `<b>🔍 What Forge wants to do:</b>`,
    `${escapeHtml(notification.summary)}`,
    '',
    `<b>Business Impact:</b>`,
    `${escapeHtml(notification.businessImpact)}`,
    '',
    `<b>Risk Level:</b> ${emoji} <i>${notification.riskLevel.toUpperCase()}</i>`,
    `<b>Confidence Score:</b> <code>${notification.confidenceScore}/100</code>`,
    '',
    `⏰ <b>Expires:</b> <code>${expiryStr}</code>`,
  ].join('
');

  if (notification.previewUrl !== undefined && notification.previewUrl !== '') {
    msg += `
🔍 <a href="${notification.previewUrl}">View Preview</a>`;
  }

  return msg;
}

/**
 * Build the HTML-formatted incident alert message.
 *
 * @param incident - IncidentAlert payload
 */
function formatIncidentMessage(incident: IncidentAlert): string {
  const label = severityLabel(incident.severity);
  const parts = [
    `🚨 <b>Incident Alert</b>`,
    '',
    `<b>Severity:</b> ${label}`,
    `<b>When:</b> <code>${incident.timestamp.toUTCString()}</code>`,
    '',
    `<b>What's happening:</b>`,
    `${escapeHtml(incident.title)}`,
  ];

  if (incident.affectedUsers !== undefined) {
    parts.push(`<b>Estimated affected users:</b> ~${incident.affectedUsers.toLocaleString()}`);
  }

  parts.push(
    '',
    `<b>🔍 What Forge is doing:</b>`,
    `${escapeHtml(incident.whatForgeIsDoing)}`,
    '',
    `<i>Incident ID: <code>${incident.id}</code></i>`,
  );

  return parts.join('
');
}

/**
 * Build the HTML-formatted daily digest message.
 *
 * @param digest - DailyDigest payload
 */
function formatDailyDigestMessage(digest: DailyDigest): string {
  const dateStr = digest.date.toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  const yesterdayList =
    digest.activitiesYesterday.length > 0
      ? digest.activitiesYesterday.map((a) => `• ${escapeHtml(a)}`.join('\n')
      : '• No automated activity yesterday';

  const focusList =
    digest.todaysFocus.length > 0
      ? digest.todaysFocus.map((f) => `• ${escapeHtml(f)}`.join('\n')
      : '• No items scheduled';

  const { users, errorRate, uptime } = digest.metricsSnapshot;
  const metricParts: string[] = [];
  if (users !== undefined)     metricParts.push(`👥 Active users: <b>${users.toLocaleString()}</b>`);
  if (errorRate !== undefined) metricParts.push(`⚠️ Error rate: <b>${(errorRate * 100).toFixed(2)}%</b>`);
  if (uptime !== undefined)    metricParts.push(`✅ Uptime: <b>${(uptime * 100).toFixed(3)}%</b>`);
  const metricsText = metricParts.length > 0 ? metricParts.join('\n') : 'No metrics available';

  const openApprovalsLine =
    digest.openApprovals > 0
      ? `⏳ <b>${digest.openApprovals} approval${digest.openApprovals > 1 ? 's' : ''} waiting</b> — check the Forge dashboard.`
      : '✅ No pending approvals';

  return [
    `☀️ <b>Forge Daily Digest — ${escapeHtml(dateStr)}</b>`,
    '',
    '<b>What Forge did yesterday:</b>',
    yesterdayList,
    '',
    '<b>Metrics snapshot:</b>',
    metricsText,
    '',
    '<b>Today's focus:</b>',
    focusList,
    '',
    openApprovalsLine,
  ].join('
');
}

// =============================================================================
// TELEGRAM ADAPTER CLASS
// =============================================================================

/**
 * TelegramAdapter manages a grammY Bot instance, handles incoming messages
 * and callback queries, and provides typed methods for all outbound
 * notifications Forge sends to Telegram chats.
 *
 * Supports both private chats and group chats (multi-founder / dev teams).
 *
 * @example
 * const adapter = new TelegramAdapter({
 *   botToken: process.env.TELEGRAM_BOT_TOKEN!,
 *   approvalGateway,
 * });
 * await adapter.setWebhook('https://your-domain.com/api/telegram/webhook');
 */
export class TelegramAdapter {
  /** The underlying grammY Bot instance. */
  private readonly bot: Bot;

  /** ApprovalGateway for resolving approve/reject callback queries. */
  private readonly approvalGateway: ApprovalGateway;

  constructor(config: TelegramAdapterConfig) {
    this.approvalGateway = config.approvalGateway;
    this.bot = new Bot(config.botToken);

    this.registerMessageHandlers();
    this.registerCallbackHandlers();

    log.info('TelegramAdapter initialised');
  }

  // -- Webhook Management --------------------------------------------------

  /**
   * Register the webhook URL with Telegram.
   * Telegram will POST all updates to this URL.
   *
   * @param webhookUrl - Fully-qualified HTTPS URL (e.g. https://example.com/api/telegram/webhook)
   */
  async setWebhook(webhookUrl: string): Promise<void> {
    await this.bot.api.setWebhook(webhookUrl);
    log.info({ webhookUrl }, 'Telegram webhook registered');
  }

  /**
   * Process an incoming webhook payload from Telegram.
   * Call this from your HTTP route handler.
   *
   * @param body - The raw request body (parsed JSON from Telegram)
   */
  async handleWebhook(body: unknown): Promise<void> {
    try {
      await this.bot.handleUpdate(body as Parameters<typeof this.bot.handleUpdate>[0]);
    } catch (err) {
      log.error({ err }, 'Error handling Telegram webhook update');
      throw err;
    }
  }

  // -- Outbound Notifications ----------------------------------------------

  /**
   * Send an approval notification with inline keyboard.
   * The inline keyboard encodes the JWT approve/reject tokens in callback_data.
   *
   * @param chatId       - Telegram chat ID (number or string)
   * @param notification - ApprovalNotification from @forge/shared
   */
  async sendApprovalNotification(
    chatId: string | number,
    notification: ApprovalNotification,
  ): Promise<void> {
    log.info(
      { chatId, approvalId: notification.approvalId, riskLevel: notification.riskLevel },
      'Sending approval notification to Telegram',
    );

    const text = formatApprovalMessage(notification);

    // Encode tokens in callback_data for inline keyboard buttons
    // Format: "action:token" -- action is used to route the callback
    const keyboard = new InlineKeyboard()
      .text(
        `✅ Approve`,
        `approve:${notification.approveToken}`,
      )
      .text(
        `❌ Reject`,
        `reject:${notification.rejectToken}`,
      );

    try {
      await this.bot.api.sendMessage(chatId, text, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
    } catch (err) {
      log.error(
        { err, chatId, approvalId: notification.approvalId },
        'Failed to send Telegram approval notification',
      );
      throw err;
    }
  }

  /**
   * Send an incident alert notification.
   *
   * @param chatId   - Telegram chat ID
   * @param incident - IncidentAlert payload
   */
  async sendIncidentAlert(chatId: string | number, incident: IncidentAlert): Promise<void> {
    log.info(
      { chatId, incidentId: incident.id, severity: incident.severity },
      'Sending incident alert to Telegram',
    );

    const text = formatIncidentMessage(incident);

    try {
      await this.bot.api.sendMessage(chatId, text, {
        parse_mode: 'HTML',
      });
    } catch (err) {
      log.error({ err, chatId, incidentId: incident.id }, 'Failed to send Telegram incident alert');
      throw err;
    }
  }

  /**
   * Send the 7am daily digest message.
   *
   * @param chatId - Telegram chat ID
   * @param digest - DailyDigest payload
   */
  async sendDailyDigest(chatId: string | number, digest: DailyDigest): Promise<void> {
    const dateStr = digest.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    log.info({ chatId, date: dateStr }, 'Sending daily digest to Telegram');

    const text = formatDailyDigestMessage(digest);

    try {
      await this.bot.api.sendMessage(chatId, text, {
        parse_mode: 'HTML',
      });
    } catch (err) {
      log.error({ err, chatId }, 'Failed to send Telegram daily digest');
      throw err;
    }
  }

  /**
   * Send a task-completion notification with optional PR link.
   *
   * @param chatId - Telegram chat ID
   * @param result - TaskCompleteMessage payload
   */
  async sendTaskComplete(chatId: string | number, result: TaskCompleteMessage): Promise<void> {
    log.info(
      { chatId, taskType: result.taskType },
      'Sending task complete notification to Telegram',
    );

    const durationText =
      result.durationSeconds !== undefined
        ? 
        : '';

    const prLine =
      result.prUrl !== undefined && result.prUrl !== ''
        ? `
🔗 <a href="${result.prUrl}">View Pull Request</a>`
        : '';

    const text =
      `✅ <b>Forge completed: ${escapeHtml(result.taskType)}${durationText}</b>
${escapeHtml(result.summary)}${prLine}`;

    try {
      await this.bot.api.sendMessage(chatId, text, {
        parse_mode: 'HTML',
      });
    } catch (err) {
      log.error({ err, chatId, taskType: result.taskType }, 'Failed to send Telegram task complete');
      throw err;
    }
  }

  // -- Inbound Message Handlers --------------------------------------------

  /**
   * Register grammY handlers for incoming text messages.
   * Delegates to onMessageReceived -- override to wire IntentAgent.
   */
  private registerMessageHandlers(): void {
    this.bot.on('message:text', async (ctx) => {
      const text = ctx.message.text;
      const chatId = ctx.chat.id;
      const userId = ctx.from?.id ?? 0;
      const username = ctx.from?.username ?? ctx.from?.first_name ?? String(userId);

      log.info({ chatId, userId, textLength: text.length }, 'Received Telegram message');

      try {
        await this.onMessageReceived({ text, chatId, userId, username, ctx });
      } catch (err) {
        log.error({ err, chatId, userId }, 'Error handling Telegram message');
        await ctx.reply('Sorry, something went wrong. Please try again.');
      }
    });
  }

  /**
   * Register grammY callback query handlers for inline keyboard button presses.
   * Decodes approve/reject tokens from callback_data and calls ApprovalGateway.
   */
  private registerCallbackHandlers(): void {
    this.bot.on('callback_query:data', async (ctx) => {
      const data = ctx.callbackQuery.data;
      const userId = ctx.from.id;
      const username = ctx.from.username ?? ctx.from.first_name ?? String(userId);

      // Acknowledge the callback query first to stop the loading indicator
      await ctx.answerCallbackQuery();

      // Callback data format: "action:token"
      const colonIdx = data.indexOf(':');
      if (colonIdx === -1) {
        log.warn({ data, userId }, 'Malformed callback_data -- missing colon separator');
        return;
      }

      const action = data.substring(0, colonIdx);
      const token = data.substring(colonIdx + 1);

      if (action !== 'approve' && action !== 'reject') {
        log.warn({ action, userId }, 'Unknown callback action');
        return;
      }

      log.info({ action, userId }, 'Telegram approval callback received');

      try {
        const result = await this.approvalGateway.processToken(
          token,
          username,
          action === 'reject' ?  : undefined,
        );

        const successText = action === 'approve'
          ? `✅ <b>Approved</b> by ${escapeHtml(username)}. Forge is proceeding. (ID: <code>${result.approvalId}</code>)`
          : `❌ <b>Rejected</b> by ${escapeHtml(username)}. Forge will not proceed. (ID: <code>${result.approvalId}</code>)`;

        // Edit the original approval message to show the result
        if (ctx.callbackQuery.message !== undefined) {
          try {
            await ctx.editMessageText(successText, {
              parse_mode: 'HTML',
            });
          } catch {
            // editMessageText can fail if message is too old -- send new message instead
            await ctx.reply(successText, {
              parse_mode: 'HTML',
            });
          }
        } else {
          await ctx.reply(successText, {
            parse_mode: 'HTML',
          });
        }

        log.info({ approvalId: result.approvalId, action, userId }, 'Telegram approval resolved');
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        log.error({ err, action, userId }, 'Failed to process Telegram approval callback');

        await ctx.reply(
          `❌ Failed to process your action: <code>${escapeHtml(msg)}</code>`,
          { parse_mode: 'HTML' },
        );
      }
    });
  }

  // -- Extension Point -----------------------------------------------------

  /**
   * Override this in a subclass to route incoming Telegram messages to the
   * IntentAgent or any other handler.
   *
   * @param params.text     - Raw message text
   * @param params.chatId   - Telegram chat ID
   * @param params.userId   - Telegram user ID of the sender
   * @param params.username - Display name of the sender
   * @param params.ctx      - grammY Context (for advanced use)
   */
  protected async onMessageReceived(params: {
    text: string;
    chatId: number;
    userId: number;
    username: string;
    ctx: Context;
  }): Promise<void> {
    log.debug(
      { chatId: params.chatId, userId: params.userId },
      'Message received -- subclass onMessageReceived to connect IntentAgent',
    );
  }

  // -- Accessors -----------------------------------------------------------

  /**
   * Expose the underlying grammY Bot for advanced use cases
   * (e.g. adding custom middleware or filter queries).
   */
  get gramMyBot(): Bot {
    return this.bot;
  }
}

