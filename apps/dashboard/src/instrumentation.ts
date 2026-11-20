import { getNextAuthSecret } from "@/lib/nextauth-secret"

/** Runs once when the Next.js server starts; refuses to boot without a valid secret. */
export function register() {
  getNextAuthSecret()
}
