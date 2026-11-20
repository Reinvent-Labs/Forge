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

const TOKEN_ISSUER = 'forge'
const APPROVAL_TOKEN_TYPE = 'forge-approval'
const SESSION_TOKEN_TYPE = 'forge-session'

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
    .setProtectedHeader({ alg: 'HS256', typ: APPROVAL_TOKEN_TYPE })
    .setIssuer(TOKEN_ISSUER)
    .setAudience(APPROVAL_TOKEN_TYPE)
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
  const { payload } = await jwtVerify(token, getSecret(), {
    algorithms: ['HS256'],
    typ: APPROVAL_TOKEN_TYPE,
    issuer: TOKEN_ISSUER,
    audience: APPROVAL_TOKEN_TYPE,
  })

  if (
    !payload['approvalId']
    || !payload['action']
    || !payload['projectId']
    || !payload['organizationId']
  ) {
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
    .setProtectedHeader({ alg: 'HS256', typ: SESSION_TOKEN_TYPE })
    .setIssuer(TOKEN_ISSUER)
    .setAudience(SESSION_TOKEN_TYPE)
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(getSecret())
}

/**
 * Verify a session token.
 */
export async function verifySessionToken(token: string): Promise<SessionTokenPayload> {
  const { payload } = await jwtVerify(token, getSecret(), {
    algorithms: ['HS256'],
    typ: SESSION_TOKEN_TYPE,
    issuer: TOKEN_ISSUER,
    audience: SESSION_TOKEN_TYPE,
  })

  if (
    typeof payload['userId'] !== 'string' || !payload['userId']
    || typeof payload['organizationId'] !== 'string' || !payload['organizationId']
    || typeof payload['role'] !== 'string' || !payload['role']
  ) {
    throw new Error('Invalid session token payload')
  }

  return payload as SessionTokenPayload
}
