/**
 * Signature verification helpers for inbound webhooks.
 * All HMACs are computed over the exact raw request body.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

const SLACK_MAX_SKEW_SECONDS = 60 * 5

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

function hmacHex(algorithm: 'sha1' | 'sha256', secret: string, data: Buffer | string): string {
  return createHmac(algorithm, secret).update(data).digest('hex')
}

/**
 * Slack v0 signing: `v0=` + HMAC-SHA256(signingSecret, `v0:${timestamp}:${rawBody}`).
 * Rejects timestamps older/newer than five minutes to prevent replay.
 */
export function verifySlackSignature(opts: {
  signingSecret: string | undefined
  rawBody: Buffer | undefined
  timestamp: string | undefined
  signature: string | undefined
  nowSeconds?: number
}): boolean {
  const { signingSecret, rawBody, timestamp, signature } = opts
  if (!signingSecret || !rawBody || !timestamp || !signature) return false
  if (!/^\d+$/.test(timestamp)) return false

  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000)
  if (Math.abs(now - Number(timestamp)) > SLACK_MAX_SKEW_SECONDS) return false

  const base = Buffer.concat([Buffer.from(`v0:${timestamp}:`), rawBody])
  const expected = `v0=${hmacHex('sha256', signingSecret, base)}`
  return safeEqual(expected, signature)
}

/** Vercel: `x-vercel-signature` = HMAC-SHA1(secret, rawBody) hex. */
export function verifyVercelSignature(
  secret: string | undefined,
  rawBody: Buffer | undefined,
  signature: string | undefined,
): boolean {
  if (!secret || !rawBody || !signature) return false
  return safeEqual(hmacHex('sha1', secret, rawBody), signature)
}

/** Sentry integration platform: `sentry-hook-signature` = HMAC-SHA256(clientSecret, rawBody) hex. */
export function verifySentrySignature(
  secret: string | undefined,
  rawBody: Buffer | undefined,
  signature: string | undefined,
): boolean {
  if (!secret || !rawBody || !signature) return false
  return safeEqual(hmacHex('sha256', secret, rawBody), signature)
}

/** Constant-time comparison of a shared secret sent in a header. */
export function verifySharedSecret(
  secret: string | undefined,
  provided: string | undefined,
): boolean {
  if (!secret || !provided) return false
  return safeEqual(secret, provided)
}

/** Only Slack's own response_url endpoints may be called back. */
export function isSlackResponseUrl(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  return (
    url.protocol === 'https:' &&
    url.hostname === 'hooks.slack.com' &&
    url.port === '' &&
    url.username === '' &&
    url.password === ''
  )
}
