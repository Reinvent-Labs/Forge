"use client"

import { useState, useCallback } from "react"
import { CheckSquare, History, Bell } from "lucide-react"
import { ApprovalCard } from "@/components/ui/approval-card"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { MOCK_APPROVALS } from "@/lib/mock-data"
import { formatTimeAgo, getAgentLabel } from "@/lib/utils"
import type { Approval } from "@/lib/types"

export default function ApprovalsPage() {
  const [tab, setTab] = useState<"pending" | "history">("pending")
  const [approvals, setApprovals] = useState<Approval[]>(MOCK_APPROVALS)

  const pending = approvals
    .filter((a) => a.status === "pending")
    .sort((a, b) => new Date(a.expiresAt).getTime() - new Date(b.expiresAt).getTime())

  const history = approvals
    .filter((a) => a.status !== "pending")
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())

  const handleApprove = useCallback(async (id: string) => {
    setApprovals((prev) =>
      prev.map((a) => a.id === id ? { ...a, status: "approved" as const, resolvedAt: new Date().toISOString() } : a)
    )
    await new Promise((resolve) => setTimeout(resolve, 600))
  }, [])

  const handleReject = useCallback(async (id: string) => {
    setApprovals((prev) =>
      prev.map((a) => a.id === id ? { ...a, status: "rejected" as const, resolvedAt: new Date().toISOString() } : a)
    )
    await new Promise((resolve) => setTimeout(resolve, 600))
  }, [])

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-zinc-100">Approvals Queue</h1>
          <p className="text-sm text-zinc-400 mt-1">
            Forge needs your sign-off before making these changes to your product.
          </p>
        </div>
        {pending.length > 0 && (
          <Badge variant="danger" className="text-sm px-3 py-1.5">
            <Bell className="h-4 w-4" />
            {pending.length} pending
          </Badge>
        )}
      </div>

      <div className="flex border-b border-zinc-800">
        {[
          { id: "pending" as const, label: "Pending", count: pending.length },
          { id: "history" as const, label: "History", count: history.length },
        ].map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${tab === t.id ? "border-green-500 text-green-400" : "border-transparent text-zinc-500 hover:text-zinc-300"}`}
          >
            {t.label}
            {t.count > 0 && (
              <span className={`rounded-full px-1.5 py-0.5 text-xs ${tab === t.id ? "bg-green-500/20 text-green-400" : "bg-zinc-800 text-zinc-500"}`}>{t.count}</span>
            )}
          </button>
        ))}
      </div>

      {tab === "pending" && (
        <div>
          {pending.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <CheckSquare className="h-12 w-12 text-green-500 mb-4" />
              <h3 className="text-lg font-semibold text-zinc-200">All caught up!</h3>
              <p className="text-zinc-400 text-sm mt-2 max-w-xs">
                No pending approvals right now. Forge will notify you when it needs your input.
              </p>
            </div>
          ) : (
            <div className="grid gap-4">
              {pending.map((approval) => (
                <ApprovalCard
                  key={approval.id}
                  approval={approval}
                  onApprove={handleApprove}
                  onReject={handleReject}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {tab === "history" && (
        <div>
          {history.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <History className="h-12 w-12 text-zinc-600 mb-4" />
              <h3 className="text-lg font-semibold text-zinc-200">No history yet</h3>
              <p className="text-zinc-400 text-sm mt-2">Past approvals and rejections will appear here.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {history.map((approval) => (
                <Card key={approval.id} className="opacity-75">
                  <CardContent className="p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-zinc-200 truncate">{approval.title}</p>
                        <p className="text-xs text-zinc-500 mt-0.5">
                          {getAgentLabel(approval.agentType)} &middot; {formatTimeAgo(approval.resolvedAt ?? approval.createdAt)}
                        </p>
                      </div>
                      <Badge
                        variant={approval.status === "approved" ? "success" : approval.status === "rejected" ? "danger" : "warning"}
                        className="capitalize text-xs"
                      >
                        {approval.status}
                      </Badge>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
