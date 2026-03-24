/**
 * JWT token utilities for Forge.
 *
 * Used for:
 * - Approval tokens (one-click approve/reject via Slack/Telegram/email)
 * - API keys (stateless auth for CLI and webhooks)
 *
 * Uses jose for standards-compliant JWT handling.
 */

import { SignJWT, jwtVerify, type JWTPayload } from 'jose'

const getSecret = () => {
  const secret = process.env['BETTER_AUTH_SECRET']
  if (!secret || secret.length < 32) {
    throw new Error('BETTER_AUTH_SECRET must be at least 32 characters')
  }
  return new TextEncoder().encode(secret)
}

export interface ApprovalTokenPayload extends JWTPayload {
  approvalId: string
  action: 'approve' | 'reject'
  projectId: string
  organizationId: string
}

/**
 * Sign a one-time approval token.
 * Expires in 24 hours. Each token is single-use (enforced at handler level).
 */
export async function signApprovalToken(
  payload: Omit<ApprovalTokenPayload, 'iat' | 'exp'>,
): Promise<string> {
  return new SignJWT(payload as JWTPayload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('24h')
    .setJti(crypto.randomUUID())
    .sign(getSecret())
}

/**
 * Verify and decode an approval token.
 * Throws if invalid or expired.
 */
export async function verifyApprovalToken(token: string): Promise<ApprovalTokenPayload> {
  const { payload } = await jwtVerify(token, getSecret())

  if (!payload['approvalId'] || !payload['action'] || !payload['projectId']) {
    throw new Error('Invalid approval token payload')
  }

  return payload as ApprovalTokenPayload
}

export interface SessionTokenPayload extends JWTPayload {
  userId: string
  organizationId: string
  role: string
}

/**
 * Sign a session token (7 days).
 */
export async function signSessionToken(
  payload: Omit<SessionTokenPayload, 'iat' | 'exp'>,
): Promise<string> {
  return new SignJWT(payload as JWTPayload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(getSecret())
}

/**
 * Verify a session token.
 */
export async function verifySessionToken(token: string): Promise<SessionTokenPayload> {
  const { payload } = await jwtVerify(token, getSecret())
  return payload as SessionTokenPayload
}
