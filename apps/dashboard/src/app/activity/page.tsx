"use client"

import { useState } from "react"
import { Activity, Filter } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ActivityItemComponent } from "@/components/ui/activity-item"
import { MOCK_ACTIVITY } from "@/lib/mock-data"
import { getAgentLabel } from "@/lib/utils"
import type { ActivityItem } from "@/lib/types"

const ACTION_TYPES: ActivityItem["actionType"][] = [
  "fix", "deploy", "monitor", "review", "update", "alert", "optimize"
]

const AGENT_TYPES = [
  "bug_fixer", "feature_builder", "security_guard", "performance_optimizer",
  "deployment_manager", "monitor", "code_reviewer",
]

export default function ActivityPage() {
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null)
  const [selectedAction, setSelectedAction] = useState<ActivityItem["actionType"] | null>(null)
  const [page, setPage] = useState(1)
  const ITEMS_PER_PAGE = 10

  const allActivity: ActivityItem[] = [
    ...MOCK_ACTIVITY,
    ...MOCK_ACTIVITY.map((item, i) => ({
      ...item,
      id: `${item.id}_v2_${i}`,
      timestamp: new Date(Date.now() - (i + 6) * 2 * 60 * 60 * 1000).toISOString(),
    })),
    ...MOCK_ACTIVITY.map((item, i) => ({
      ...item,
      id: `${item.id}_v3_${i}`,
      timestamp: new Date(Date.now() - (i + 12) * 2 * 60 * 60 * 1000).toISOString(),
    })),
  ]

  const filtered = allActivity.filter((item) => {
    if (selectedAgent && item.agentType !== selectedAgent) return false
    if (selectedAction && item.actionType !== selectedAction) return false
    return true
  })

  const paginated = filtered.slice(0, page * ITEMS_PER_PAGE)
  const hasMore = paginated.length < filtered.length

  const filterBtnCls = (active: boolean) =>
    active
      ? "rounded-full px-3 py-1 text-xs font-medium border border-green-500/50 bg-green-500/10 text-green-400 transition-colors"
      : "rounded-full px-3 py-1 text-xs font-medium border border-zinc-700 bg-zinc-900 text-zinc-400 hover:border-zinc-600 transition-colors"

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-zinc-100">Agent Activity</h1>
          <p className="text-sm text-zinc-400 mt-1">
            Everything Forge has done for your product, in plain English.
          </p>
        </div>
        <Badge variant="default" className="text-xs">
          <Activity className="h-3.5 w-3.5" />
          {filtered.length} actions
        </Badge>
      </div>

      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Filter className="h-4 w-4 text-zinc-500" />
          <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wide">Filter by agent</span>
        </div>
        <div className="flex flex-wrap gap-2">
          <button onClick={() => setSelectedAgent(null)} className={filterBtnCls(selectedAgent === null)}>
            All agents
          </button>
          {AGENT_TYPES.map((agent) => (
            <button
              key={agent}
              onClick={() => setSelectedAgent(selectedAgent === agent ? null : agent)}
              className={filterBtnCls(selectedAgent === agent)}
            >
              {getAgentLabel(agent)}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <button onClick={() => setSelectedAction(null)} className={filterBtnCls(selectedAction === null)}>
            All actions
          </button>
          {ACTION_TYPES.map((action) => (
            <button
              key={action}
              onClick={() => setSelectedAction(selectedAction === action ? null : action)}
              className={filterBtnCls(selectedAction === action) + " capitalize"}
            >
              {action}
            </button>
          ))}
        </div>
      </div>

      <Card>
        <CardContent className="p-5">
          {paginated.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Activity className="h-10 w-10 text-zinc-700 mb-3" />
              <p className="text-zinc-400 text-sm">No activity matches your filters.</p>
              <Button
                variant="ghost"
                size="sm"
                className="mt-3"
                onClick={() => { setSelectedAgent(null); setSelectedAction(null) }}
              >
                Clear filters
              </Button>
            </div>
          ) : (
            <div>
              {paginated.map((item) => (
                <ActivityItemComponent key={item.id} item={item} />
              ))}
              {hasMore && (
                <div className="pt-4 text-center">
                  <Button variant="outline" size="sm" onClick={() => setPage((p) => p + 1)}>
                    Load more
                  </Button>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
