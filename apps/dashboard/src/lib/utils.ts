import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"
import { formatDistanceToNow, format, differenceInSeconds } from "date-fns"

/**
 * Merge Tailwind classes safely, resolving conflicts.
 * Use this everywhere instead of raw clsx.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

/**
 * Format a date as a human-readable "time ago" string.
 * e.g. "3 minutes ago", "2 hours ago"
 */
export function formatTimeAgo(date: Date | string | number): string {
  const d = typeof date === "string" || typeof date === "number" ? new Date(date) : date
  return formatDistanceToNow(d, { addSuffix: true })
}

/**
 * Format a duration in seconds to a human-readable string.
 * e.g. 3661 => "1h 1m 1s"
 */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60)
    const s = seconds % 60
    return s > 0 ? `${m}m ${s}s` : `${m}m`
  }
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return m > 0 ? `${h}h ${m}m` : `${h}h`
}

/**
 * Format an expiry countdown — shows urgency as time decreases.
 */
export function formatCountdown(expiresAt: Date | string): string {
  const expiry = typeof expiresAt === "string" ? new Date(expiresAt) : expiresAt
  const diff = differenceInSeconds(expiry, new Date())
  if (diff <= 0) return "Expired"
  if (diff < 60) return `${diff}s`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ${diff % 60}s`
  return `${Math.floor(diff / 3600)}h ${Math.floor((diff % 3600) / 60)}m`
}

/**
 * Return Tailwind color classes based on risk level.
 */
export function getRiskColor(
  risk: "critical" | "high" | "medium" | "low"
): { bg: string; text: string; border: string } {
  switch (risk) {
    case "critical":
      return { bg: "bg-red-500/10", text: "text-red-400", border: "border-red-500/30" }
    case "high":
      return { bg: "bg-orange-500/10", text: "text-orange-400", border: "border-orange-500/30" }
    case "medium":
      return { bg: "bg-yellow-500/10", text: "text-yellow-400", border: "border-yellow-500/30" }
    case "low":
      return { bg: "bg-green-500/10", text: "text-green-400", border: "border-green-500/30" }
  }
}

/**
 * Map agent type codes to human-readable labels.
 * Founders should never see "AGENT_TYPE_BUGFIX" — they see "Bug Fixer".
 */
export function getAgentLabel(agentType: string): string {
  const labels: Record<string, string> = {
    bug_fixer: "Bug Fixer",
    feature_builder: "Feature Builder",
    security_guard: "Security Guard",
    performance_optimizer: "Performance Optimizer",
    deployment_manager: "Deployment Manager",
    monitor: "Health Monitor",
    code_reviewer: "Code Reviewer",
    database_optimizer: "Database Optimizer",
    dependency_updater: "Dependency Manager",
    test_writer: "Test Writer",
  }
  return labels[agentType] ?? agentType
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ")
}

/**
 * Get badge color classes for an agent type.
 */
export function getAgentColor(agentType: string): string {
  const colors: Record<string, string> = {
    bug_fixer: "bg-red-500/20 text-red-300 border-red-500/30",
    feature_builder: "bg-blue-500/20 text-blue-300 border-blue-500/30",
    security_guard: "bg-purple-500/20 text-purple-300 border-purple-500/30",
    performance_optimizer: "bg-orange-500/20 text-orange-300 border-orange-500/30",
    deployment_manager: "bg-cyan-500/20 text-cyan-300 border-cyan-500/30",
    monitor: "bg-green-500/20 text-green-300 border-green-500/30",
    code_reviewer: "bg-indigo-500/20 text-indigo-300 border-indigo-500/30",
    database_optimizer: "bg-yellow-500/20 text-yellow-300 border-yellow-500/30",
    dependency_updater: "bg-zinc-500/20 text-zinc-300 border-zinc-500/30",
    test_writer: "bg-teal-500/20 text-teal-300 border-teal-500/30",
  }
  return colors[agentType] ?? "bg-zinc-500/20 text-zinc-300 border-zinc-500/30"
}

/**
 * Format large numbers for display (e.g. 1200 => "1.2k").
 */
export function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return n.toString()
}

/**
 * Clamp a number between min and max.
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/**
 * Format a date for display in charts.
 */
export function formatChartDate(date: Date | string, range: "7d" | "30d" | "90d"): string {
  const d = typeof date === "string" ? new Date(date) : date
  if (range === "7d") return format(d, "EEE")
  if (range === "30d") return format(d, "MMM d")
  return format(d, "MMM d")
}
