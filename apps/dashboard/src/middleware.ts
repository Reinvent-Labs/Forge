/**
 * NextAuth middleware — protects all application routes.
 *
 * Unauthenticated visitors are redirected to /login.
 *
 * The matcher excludes:
 *  - /login              — the sign-in page itself (public)
 *  - /api/auth/**        — NextAuth's own API endpoints (public)
 *  - /_next/static/**    — static JS/CSS assets
 *  - /_next/image/**     — Next.js image optimisation endpoint
 *  - /favicon.ico        — browser favicon request
 */

export { default } from "next-auth/middleware"

export const config = {
  matcher: [
    "/((?!login|api/auth|_next/static|_next/image|favicon.ico).*)",
  ],
}
