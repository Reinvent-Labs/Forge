/**
 * Cryptographic utilities for Forge.
 *
 * Per-tenant credential encryption uses AES-256-GCM.
 * Master key lives in Vault/Doppler; per-tenant keys are encrypted with it.
 *
 * NEVER store plaintext secrets. NEVER log decrypted values.
 */

import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto'

const ALGORITHM = 'aes-256-gcm'
const KEY_LENGTH = 32  // bytes (256 bits)
const IV_LENGTH = 12   // bytes (96 bits — optimal for GCM)
const TAG_LENGTH = 16  // bytes (128-bit auth tag)

/**
 * Encrypt a string value with AES-256-GCM.
 * Returns a base64-encoded string: iv:tag:ciphertext
 */
export function encrypt(plaintext: string, keyHex: string): string {
  if (keyHex.length !== KEY_LENGTH * 2) {
    throw new Error('Encryption key must be 32 bytes (64 hex chars)')
  }

  const key = Buffer.from(keyHex, 'hex')
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, key, iv)

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ])

  const tag = cipher.getAuthTag()

  // Format: base64(iv):base64(tag):base64(ciphertext)
  return [
    iv.toString('base64'),
    tag.toString('base64'),
    encrypted.toString('base64'),
  ].join(':')
}

/**
 * Decrypt a value previously encrypted with `encrypt()`.
 */
export function decrypt(encryptedValue: string, keyHex: string): string {
  if (keyHex.length !== KEY_LENGTH * 2) {
    throw new Error('Encryption key must be 32 bytes (64 hex chars)')
  }

  const parts = encryptedValue.split(':')
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted value format')
  }

  const [ivB64, tagB64, ciphertextB64] = parts as [string, string, string]

  const key = Buffer.from(keyHex, 'hex')
  const iv = Buffer.from(ivB64, 'base64')
  const tag = Buffer.from(tagB64, 'base64')
  const ciphertext = Buffer.from(ciphertextB64, 'base64')

  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(tag)

  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString('utf8')
}

/**
 * Generate a cryptographically secure random hex key.
 */
export function generateKey(): string {
  return randomBytes(KEY_LENGTH).toString('hex')
}

/**
 * Hash an API key for storage. Uses SHA-256.
 * Returns hex-encoded hash.
 */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

/**
 * Generate a secure API key with a readable prefix.
 * Format: forge_<base64url-random-32bytes>
 */
export function generateApiKey(): { key: string; prefix: string; hash: string } {
  const random = randomBytes(32).toString('base64url')
  const key = `forge_${random}`
  const prefix = key.substring(0, 12)
  const hash = hashApiKey(key)
  return { key, prefix, hash }
}

/**
 * Normalize an error fingerprint for consistent dedup/matching.
 * Strips memory addresses, line numbers, and session-specific data.
 */
export function normalizeErrorFingerprint(errorMessage: string): string {
  return createHash('sha256')
    .update(
      errorMessage
        .replace(/0x[0-9a-f]+/gi, '0xADDR')     // hex addresses
        .replace(/:\d+:\d+/g, ':N:N')             // line:col numbers
        .replace(/\b\d{10,}\b/g, 'ID')            // long numeric IDs
        .replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi, 'UUID')
        .toLowerCase()
        .trim(),
    )
    .digest('hex')
    .substring(0, 16)
}
