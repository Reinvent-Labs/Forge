"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import {
  LayoutDashboard,
  CheckSquare,
  BarChart3,
  Heart,
  Activity,
  Plug,
  Settings,
  Zap,
  X,
  Bell,
} from "lucide-react"
import { useForgeStore } from "@/lib/store"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"

const NAV_ITEMS = [
  {
    href: "/",
    label: "Command Center",
    icon: LayoutDashboard,
    description: "Overview & alerts",
  },
  {
    href: "/approvals",
    label: "Approvals",
    icon: CheckSquare,
    description: "Pending decisions",
    badge: true,
  },
  {
    href: "/metrics",
    label: "Metrics",
    icon: BarChart3,
    description: "Business numbers",
  },
  {
    href: "/health",
    label: "Tech Health",
    icon: Heart,
    description: "System status",
  },
  {
    href: "/activity",
    label: "Activity",
    icon: Activity,
    description: "What Forge did",
  },
  {
    href: "/integrations",
    label: "Integrations",
    icon: Plug,
    description: "Connected tools",
  },
  {
    href: "/settings",
    label: "Settings",
    icon: Settings,
    description: "Configure Forge",
  },
]

/**
 * Sidebar — desktop navigation.
 * On mobile, slides in as a drawer when sidebarOpen is true.
 */
export function Sidebar() {
  const pathname = usePathname()
  const { sidebarOpen, setSidebarOpen, pendingApprovals } = useForgeStore()

  return (
    <>
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm md:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Sidebar panel */}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex flex-col w-64 bg-zinc-950 border-r border-zinc-800 transition-transform duration-300",
          "md:relative md:translate-x-0 md:flex",
          sidebarOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"
        )}
      >
        {/* Logo */}
        <div className="flex items-center justify-between h-16 px-5 border-b border-zinc-800 shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-green-500">
              <Zap className="h-4.5 w-4.5 text-zinc-950" />
            </div>
            <span className="font-bold text-zinc-100 text-lg tracking-tight">Forge</span>
          </div>
          {/* Mobile close button */}
          <button
            onClick={() => setSidebarOpen(false)}
            className="md:hidden p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-400"
            aria-label="Close sidebar"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto py-4 px-3" aria-label="Main navigation">
          <ul className="space-y-0.5">
            {NAV_ITEMS.map((item) => {
              const isActive =
                item.href === "/"
                  ? pathname === "/"
                  : pathname.startsWith(item.href)

              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={() => setSidebarOpen(false)}
                    className={cn(
                      "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-150",
                      isActive
                        ? "bg-green-500/10 text-green-400 border border-green-500/20"
                        : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                    )}
                    aria-current={isActive ? "page" : undefined}
                  >
                    <item.icon
                      className={cn(
                        "h-4.5 w-4.5 shrink-0",
                        isActive ? "text-green-400" : "text-zinc-500"
                      )}
                    />
                    <div className="flex-1 min-w-0">
                      <span className="block truncate">{item.label}</span>
                    </div>
                    {/* Approval count badge */}
                    {item.badge && pendingApprovals > 0 && (
                      <Badge variant="danger" className="text-xs px-1.5 py-0.5 min-w-[20px] justify-center">
                        {pendingApprovals > 99 ? "99+" : pendingApprovals}
                      </Badge>
                    )}
                  </Link>
                </li>
              )
            })}
          </ul>
        </nav>

        {/* Footer */}
        <div className="p-4 border-t border-zinc-800 shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="h-8 w-8 rounded-full bg-zinc-800 flex items-center justify-center">
              <span className="text-xs font-bold text-zinc-300">YC</span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold text-zinc-200 truncate">Your Company</p>
              <p className="text-xs text-zinc-500">Free Plan</p>
            </div>
            <Bell className="h-4 w-4 text-zinc-500 hover:text-zinc-300 cursor-pointer transition-colors" />
          </div>
        </div>
      </aside>
    </>
  )
}
