"use client"

import { useState, useEffect, useCallback } from "react"
import { ExternalLink, Github, CheckCircle, XCircle, Clock, Shield, Zap, AlertTriangle } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "./card"
import { Badge } from "./badge"
import { Button } from "./button"
import { Progress } from "./progress"
import { formatCountdown, getRiskColor, getAgentLabel, getAgentColor, cn } from "@/lib/utils"
import type { Approval } from "@/lib/types"

interface ApprovalCardProps {
  approval: Approval
  onApprove: (id: string) => Promise<void>
  onReject: (id: string) => Promise<void>
}

/**
 * ApprovalCard — shows everything a founder needs to decide.
 *
 * Designed for non-technical founders:
 * - Business impact first (bold)
 * - Risk explained in plain English
 * - Confidence score visualized as a bar
 * - Expiry countdown creates appropriate urgency
 */
export function ApprovalCard({ approval, onApprove, onReject }: ApprovalCardProps) {
  const [countdown, setCountdown] = useState("")
  const [approving, setApproving] = useState(false)
  const [rejecting, setRejecting] = useState(false)
  const [resolved, setResolved] = useState(false)

  // Live countdown timer
  useEffect(() => {
    const tick = () => setCountdown(formatCountdown(approval.expiresAt))
    tick()
    const interval = setInterval(tick, 1000)
    return () => clearInterval(interval)
  }, [approval.expiresAt])

  const riskColors = getRiskColor(approval.riskLevel)
  const agentColors = getAgentColor(approval.agentType)
  const agentLabel = getAgentLabel(approval.agentType)

  const isExpiringSoon =
    new Date(approval.expiresAt).getTime() - Date.now() < 30 * 60 * 1000

  const handleApprove = useCallback(async () => {
    setApproving(true)
    try {
      await onApprove(approval.id)
      setResolved(true)
    } finally {
      setApproving(false)
    }
  }, [approval.id, onApprove])

  const handleReject = useCallback(async () => {
    setRejecting(true)
    try {
      await onReject(approval.id)
      setResolved(true)
    } finally {
      setRejecting(false)
    }
  }, [approval.id, onReject])

  const riskIcon = {
    critical: <AlertTriangle className="h-3.5 w-3.5" />,
    high: <AlertTriangle className="h-3.5 w-3.5" />,
    medium: <Shield className="h-3.5 w-3.5" />,
    low: <CheckCircle className="h-3.5 w-3.5" />,
  }[approval.riskLevel]

  if (resolved) {
    return (
      <Card className="opacity-50 pointer-events-none">
        <CardContent className="p-5 flex items-center gap-3">
          <CheckCircle className="h-5 w-5 text-green-400" />
          <span className="text-zinc-400 text-sm">Decision recorded for "{approval.title}"</span>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className={cn(
      "transition-all duration-200 fade-in",
      "border-zinc-800 hover:border-zinc-700"
    )}>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-center gap-2 flex-wrap">
            {/* Agent type badge */}
            <Badge
              className={cn("text-xs border", agentColors)}
            >
              <Zap className="h-3 w-3" />
              {agentLabel}
            </Badge>

            {/* Risk badge */}
            <Badge
              className={cn("text-xs border capitalize", riskColors.bg, riskColors.text, riskColors.border)}
            >
              {riskIcon}
              {approval.riskLevel} risk
            </Badge>
          </div>

          {/* Expiry timer */}
          <div
            className={cn(
              "flex items-center gap-1.5 text-xs font-medium rounded-full px-2.5 py-1",
              isExpiringSoon
                ? "bg-red-500/10 text-red-400 border border-red-500/30"
                : "bg-zinc-800 text-zinc-400"
            )}
          >
            <Clock className="h-3 w-3" />
            <span>{countdown}</span>
          </div>
        </div>

        <CardTitle className="text-base mt-2">{approval.title}</CardTitle>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Business impact — most important, shown first */}
        <div className="rounded-lg bg-zinc-800/60 p-3.5">
          <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wide mb-1.5">
            What this means for your business
          </p>
          <p className="text-sm text-zinc-200 leading-relaxed">
            {approval.businessImpact}
          </p>
        </div>

        {/* Confidence score */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-zinc-400 font-medium">
              Forge confidence
            </span>
            <span
              className={cn(
                "text-sm font-bold tabular-nums",
                approval.confidenceScore >= 85
                  ? "text-green-400"
                  : approval.confidenceScore >= 65
                  ? "text-yellow-400"
                  : "text-red-400"
              )}
            >
              {approval.confidenceScore}/100
            </span>
          </div>
          <Progress
            value={approval.confidenceScore}
            fillClass={
              approval.confidenceScore >= 85
                ? "bg-green-500"
                : approval.confidenceScore >= 65
                ? "bg-yellow-500"
                : "bg-red-500"
            }
          />
        </div>

        {/* Risk factors */}
        {approval.riskFactors.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wide mb-2">
              Things to be aware of
            </p>
            <ul className="space-y-1.5">
              {approval.riskFactors.map((factor, i) => (
                <li key={i} className="flex items-start gap-2 text-sm text-zinc-300">
                  <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-zinc-500 shrink-0" />
                  {factor}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Links */}
        {(approval.previewUrl ?? approval.prUrl) && (
          <div className="flex items-center gap-3">
            {approval.previewUrl && (
              <a
                href={approval.previewUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 text-xs text-green-400 hover:text-green-300 transition-colors"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                Preview changes
              </a>
            )}
            {approval.prUrl && (
              <a
                href={approval.prUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 text-xs text-zinc-400 hover:text-zinc-300 transition-colors"
              >
                <Github className="h-3.5 w-3.5" />
                View code
              </a>
            )}
          </div>
        )}

        {/* Action buttons */}
        <div className="flex gap-3 pt-1">
          <Button
            variant="default"
            size="sm"
            className="flex-1"
            onClick={handleApprove}
            loading={approving}
            disabled={rejecting}
          >
            <CheckCircle className="h-4 w-4" />
            Approve
          </Button>
          <Button
            variant="destructive"
            size="sm"
            className="flex-1"
            onClick={handleReject}
            loading={rejecting}
            disabled={approving}
          >
            <XCircle className="h-4 w-4" />
            Reject
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
