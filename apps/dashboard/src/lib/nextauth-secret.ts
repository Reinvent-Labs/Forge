/**
 * Validation for the NextAuth JWT signing/encryption secret.
 *
 * There is deliberately no fallback value: a known secret would let anyone
 * forge a valid session cookie for any user.
 */

export const MIN_NEXTAUTH_SECRET_LENGTH = 32

export function getNextAuthSecret(): string {
  const secret = process.env.NEXTAUTH_SECRET

  if (!secret) {
    throw new Error(
      "NEXTAUTH_SECRET is not set. Generate one with `openssl rand -base64 32` and set it in the dashboard environment."
    )
  }

  if (secret.length < MIN_NEXTAUTH_SECRET_LENGTH) {
    throw new Error(
      `NEXTAUTH_SECRET must be at least ${MIN_NEXTAUTH_SECRET_LENGTH} characters long. Generate one with \`openssl rand -base64 32\`.`
    )
  }

  return secret
}
