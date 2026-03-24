"use client"

/**
 * TopBar — sticky header with:
 *  - Mobile hamburger menu (md: hidden)
 *  - Page title derived from the current pathname
 *  - Right-side actions: refresh, theme toggle, user avatar + sign-out
 *
 * The user avatar shows the first two initials of the signed-in user's name
 * inside a green circle. Clicking it (or the sign-out button) signs the user
 * out and redirects them to /login.
 */

import { Menu, Moon, Sun, RefreshCw, LogOut } from "lucide-react"
import { useTheme } from "next-themes"
import { useSession, signOut } from "next-auth/react"
import { useForgeStore } from "@/lib/store"
import { Button } from "@/components/ui/button"
import { usePathname } from "next/navigation"

const PAGE_TITLES: Record<string, string> = {
  "/": "Command Center",
  "/approvals": "Approvals Queue",
  "/metrics": "Business Metrics",
  "/health": "Technical Health",
  "/activity": "Agent Activity",
  "/integrations": "Integrations",
  "/settings": "Settings",
}

/**
 * Derive up-to-two uppercase initials from a display name.
 * Falls back to "?" when no name is available.
 */
function getInitials(name?: string | null): string {
  if (!name) return "?"
  const parts = name.trim().split(/\s+/)
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase()
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase()
}

/**
 * UserMenu — avatar initials circle + sign-out icon button.
 * Rendered only when a session exists.
 */
function UserMenu() {
  const { data: session, status } = useSession()

  // Don't render anything while session is loading or unauthenticated
  if (status !== "authenticated" || !session?.user) return null

  const initials = getInitials(session.user.name)
  const displayName = session.user.name ?? session.user.email ?? "User"

  function handleSignOut() {
    signOut({ callbackUrl: "/login" })
  }

  return (
    <div className="flex items-center gap-2">
      {/* Avatar initials — acts as a visual identity cue */}
      <div
        className="w-8 h-8 rounded-full bg-green-500 flex items-center justify-center shrink-0"
        title={displayName}
        aria-label={`Signed in as ${displayName}`}
      >
        <span className="text-xs font-semibold text-zinc-950 select-none">
          {initials}
        </span>
      </div>

      {/* Sign-out button */}
      <Button
        variant="ghost"
        size="icon"
        onClick={handleSignOut}
        aria-label="Sign out"
        title="Sign out"
        className="shrink-0 text-zinc-400 hover:text-zinc-100"
      >
        <LogOut className="h-4 w-4" />
      </Button>
    </div>
  )
}

/**
 * TopBar — mobile hamburger menu + page title + theme toggle.
 * Stays fixed at the top of the content area.
 */
export function TopBar() {
  const { theme, setTheme } = useTheme()
  const { toggleSidebar } = useForgeStore()
  const pathname = usePathname()

  const title = PAGE_TITLES[pathname] ?? "Forge"

  return (
    <header className="h-16 border-b border-zinc-800 bg-zinc-950/80 backdrop-blur-sm flex items-center px-4 md:px-6 lg:px-8 gap-4 sticky top-0 z-30 shrink-0">
      {/* Mobile menu button */}
      <Button
        variant="ghost"
        size="icon"
        onClick={toggleSidebar}
        className="md:hidden shrink-0"
        aria-label="Open navigation menu"
      >
        <Menu className="h-5 w-5" />
      </Button>

      {/* Page title */}
      <h1 className="text-lg font-semibold text-zinc-100 flex-1 truncate">{title}</h1>

      {/* Right actions */}
      <div className="flex items-center gap-2">
        {/* Refresh indicator — could be animated when queries are fetching */}
        <Button
          variant="ghost"
          size="icon"
          className="hidden sm:flex"
          aria-label="Refresh data"
          onClick={() => window.location.reload()}
        >
          <RefreshCw className="h-4 w-4" />
        </Button>

        {/* Theme toggle */}
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          aria-label="Toggle theme"
        >
          <Sun className="h-4 w-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
          <Moon className="absolute h-4 w-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
          <span className="sr-only">Toggle theme</span>
        </Button>

        {/* User avatar + sign-out (only shown when authenticated) */}
        <UserMenu />
      </div>
    </header>
  )
}
