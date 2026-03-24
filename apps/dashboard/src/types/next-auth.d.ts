/**
 * Module augmentation for next-auth.
 *
 * Extends the default Session and JWT types to include the custom fields
 * we add in the jwt and session callbacks (id and role).
 *
 * These types are automatically picked up by TypeScript via the tsconfig
 * include pattern — no explicit import is needed.
 */

import { DefaultSession, DefaultJWT } from "next-auth"

declare module "next-auth" {
  interface Session {
    user: {
      /** The Forge user UUID from the `users` table */
      id: string
      /** The user's org role (e.g. 'owner', 'admin', 'developer', 'member') */
      role: string
    } & DefaultSession["user"]
  }

  interface User {
    /** The Forge user UUID */
    id: string
    /** The user's org role */
    role: string
  }
}

declare module "next-auth/jwt" {
  interface JWT extends DefaultJWT {
    id: string
    role: string
  }
}
