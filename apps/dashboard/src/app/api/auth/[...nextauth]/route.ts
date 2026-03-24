/**
 * NextAuth.js catch-all route handler (App Router style).
 *
 * Next.js App Router requires named exports GET and POST.
 * We import the handler from next-auth and re-export it under both names.
 */

import NextAuth from "next-auth"
import { authOptions } from "@/lib/auth"

// Build the NextAuth request handler from the shared authOptions
const handler = NextAuth(authOptions)

export { handler as GET, handler as POST }
