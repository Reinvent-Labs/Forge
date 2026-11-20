/**
 * NextAuth configuration and helpers.
 *
 * This file exports:
 *  - authOptions  — the NextAuthOptions object used by both the route handler
 *                   and server-side getServerSession calls
 *  - getServerSession — a convenience re-export of next-auth's getServerSession
 *                       pre-bound with authOptions so callers don't repeat it
 *
 */

import { NextAuthOptions, getServerSession as _getServerSession } from "next-auth"
import { PHASE_PRODUCTION_BUILD } from "next/constants"
import CredentialsProvider from "next-auth/providers/credentials"
import { PrismaClient } from "@prisma/client"
import bcrypt from "bcryptjs"
import { getNextAuthSecret } from "@/lib/nextauth-secret"

// ---------------------------------------------------------------------------
// Prisma singleton — avoids spawning a new connection on every hot-reload
// ---------------------------------------------------------------------------
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    datasources: {
      db: {
        url:
          process.env.DATABASE_URL ??
          "postgresql://forge:password@localhost:5435/forge",
      },
    },
  })

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma
}

// ---------------------------------------------------------------------------
// NextAuth options
// ---------------------------------------------------------------------------

/**
 * The shared NextAuth configuration object.
 * Import this in both the API route and any server-side session helpers.
 */
export const authOptions: NextAuthOptions = {
  // JWT-based sessions — no DB session table required
  session: {
    strategy: "jwt",
  },

  // Skipped only while `next build` collects page data; every runtime import
  // (dev, start, serverless) throws if the secret is missing or too short.
  ...(process.env.NEXT_PHASE === PHASE_PRODUCTION_BUILD
    ? {}
    : { secret: getNextAuthSecret() }),

  pages: {
    signIn: "/login",
  },

  providers: [
    CredentialsProvider({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },

      /**
       * Validate email/password against the database.
       * Returns the user object on success or null on failure.
       */
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) {
          return null
        }

        type RawUser = {
          id: string
          email: string
          name: string
          avatar_url: string | null
          password_hash: string | null
        }

        const rows = await prisma.$queryRaw<RawUser[]>`
          SELECT id, email, name, avatar_url, password_hash
          FROM users
          WHERE email = ${credentials.email}
          LIMIT 1
        `

        const user = rows[0]
        if (!user) return null

        // If no password hash is set on this account, deny access
        if (!user.password_hash) return null

        const passwordValid = await bcrypt.compare(
          credentials.password,
          user.password_hash
        )

        if (!passwordValid) return null

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          image: user.avatar_url ?? null,
          // role will be populated in the jwt callback via OrgMember lookup
          role: "member",
        }
      },
    }),
  ],

  callbacks: {
    /**
     * jwt callback — runs when the JWT is created or refreshed.
     * We persist id and role into the token so they survive page reloads
     * without hitting the database on every request.
     */
    async jwt({ token, user }) {
      if (user) {
        // First sign-in: copy the user fields into the token
        token.id = user.id
        token.role = (user as { role?: string }).role ?? "member"
      }
      return token
    },

    /**
     * session callback — runs when the session object is accessed on the client.
     * We surface id and role so components can gate UI without extra API calls.
     */
    async session({ session, token }) {
      if (token && session.user) {
        session.user.id = token.id as string
        session.user.role = token.role as string
      }
      return session
    },
  },
}

/**
 * Server-side helper to get the current session.
 * Usage: const session = await getServerSession()
 */
export async function getServerSession() {
  return _getServerSession(authOptions)
}
