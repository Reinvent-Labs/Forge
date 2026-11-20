/**
 * Approval gateway handler for webhook-based approval processing.
 *
 * This module bridges the Slack/Telegram webhook routes to the
 * ApprovalGateway instance that lives in the orchestrator singleton.
 *
 * It is imported dynamically from webhooks.ts to avoid circular dependency
 * issues during startup (the orchestrator instance is created after the
 * routes are registered).
 */

import { createLogger } from '@forge/shared'
import { prisma } from '@forge/database'
import { verifyApprovalToken } from '@forge/shared'
import { isSlackResponseUrl } from './webhook-signatures.js'

const log = createLogger('approval-gateway-handler')

/**
 * Processes an approval action triggered from a Slack interactive payload
 * or Telegram callback query.
 *
 * Steps:
 * 1. Verifies the JWT approval token (signed by ApprovalGateway.createApproval)
 * 2. Looks up the ApprovalRequest in the database by token field
 * 3. Updates the status to APPROVED or REJECTED
 * 4. Optionally sends a Slack response to the response_url confirming the action
 *
 * @param token       - JWT approval or rejection token
 * @param approvedBy  - Human-readable name/username of the person who acted
 * @param responseUrl - Optional Slack response_url to update the original message
 */
async function processFromWebhook(
  token: string,
  approvedBy: string,
  responseUrl?: string,
): Promise<void> {
  const handlerLog = log.child({ approvedBy })
  handlerLog.info('Processing approval token from webhook')

  // 1. Verify the JWT and extract approval info
  let payload: Awaited<ReturnType<typeof verifyApprovalToken>>
  try {
    payload = await verifyApprovalToken(token)
  } catch (err) {
    handlerLog.warn({ err }, 'Invalid or expired approval token — ignoring')
    return
  }

  const { approvalId, action } = payload
  handlerLog.info({ approvalId, action }, 'Token verified; updating approval status')

  // 2. Find the approval request and update it atomically
  const newStatus = action === 'approve' ? 'APPROVED' : 'REJECTED'

  try {
    await prisma.approvalRequest.updateMany({
      where: {
        id: approvalId,
        status: 'PENDING', // Only process pending approvals
        ...(action === 'approve'
          ? { approveToken: token }
          : { rejectToken: token }),
      },
      data: {
        status: newStatus,
        resolvedAt: new Date(),
        resolvedBy: approvedBy,
      },
    })
  } catch (err) {
    handlerLog.error({ err, approvalId }, 'Failed to update approval status in DB')
    throw err
  }

  handlerLog.info({ approvalId, newStatus }, 'Approval status updated')

  // 3. If Slack provided a response_url, update the original message
  if (responseUrl && !isSlackResponseUrl(responseUrl)) {
    handlerLog.warn('Ignoring response_url that is not an https://hooks.slack.com URL')
  } else if (responseUrl) {
    try {
      const emoji = action === 'approve' ? '✅' : '❌'
      const verb = action === 'approve' ? 'approved' : 'rejected'

      await fetch(responseUrl, {
        method: 'POST',
        redirect: 'error',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          replace_original: true,
          text: `${emoji} *${approvedBy}* ${verb} this change.`,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `${emoji} *${approvedBy}* ${verb} this change.`,
              },
            },
          ],
        }),
      })
    } catch (err) {
      // Non-fatal — the approval was processed successfully even if we can't update Slack
      handlerLog.warn({ err }, 'Failed to update Slack original message via response_url')
    }
  }
}

/**
 * Singleton-style object exported for use in webhook routes.
 * Uses a namespace object so callers can do: ApprovalGateway.processFromWebhook(...)
 */
export const ApprovalGateway = {
  processFromWebhook,
} as const
