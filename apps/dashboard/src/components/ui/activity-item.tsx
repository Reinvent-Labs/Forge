import { formatTimeAgo, getAgentLabel, getAgentColor, cn } from "@/lib/utils"
import type { ActivityItem } from "@/lib/types"
import { ExternalLink, GitPullRequest } from "lucide-react"

interface ActivityItemProps {
  item: ActivityItem
  compact?: boolean
}

/**
 * ActivityItem — a single entry in the agent activity feed.
 * Plain English description with agent badge and links.
 */
export function ActivityItemComponent({ item, compact = false }: ActivityItemProps) {
  const agentColor = getAgentColor(item.agentType)
  const agentLabel = getAgentLabel(item.agentType)

  const actionIcons: Record<ActivityItem["actionType"], string> = {
    fix: "🔧",
    deploy: "🚀",
    monitor: "👁️",
    review: "🔍",
    update: "🔄",
    alert: "⚡",
    optimize: "⚡",
  }

  const incidentHref = `/incidents/${item.incidentId}`

  return (
    <div className={cn("flex items-start gap-3 py-3 border-b border-zinc-800 last:border-0 fade-in", compact ? "py-2" : "py-3.5")}>
      <div className="text-lg shrink-0 mt-0.5" aria-hidden="true">
        {actionIcons[item.actionType]}
      </div>
      <div className="flex-1 min-w-0">
        <p className={cn("text-zinc-200 leading-snug", compact ? "text-xs" : "text-sm")}>
          {item.description}
        </p>
        <div className="flex flex-wrap items-center gap-2 mt-1.5">
          <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium", agentColor)}>
            {agentLabel}
          </span>
          <span className="text-xs text-zinc-500">{formatTimeAgo(item.timestamp)}</span>
          {item.prUrl && (
            <a href={item.prUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-green-400 hover:text-green-300 transition-colors">
              <GitPullRequest className="h-3 w-3" />View PR
            </a>
          )}
          {item.incidentId && (
            <a href={incidentHref} className="inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-300 transition-colors">
              <ExternalLink className="h-3 w-3" />Incident
            </a>
          )}
        </div>
      </div>
    </div>
  )
}
