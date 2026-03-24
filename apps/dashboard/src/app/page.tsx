"use client"

import { useState } from "react"
import Link from "next/link"
import { AlertTriangle, CheckSquare, ShieldAlert, ArrowRight, Hammer, Bug, BarChart3, Users, X, Loader2 } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { HealthScoreDisplay } from "@/components/ui/health-score"
import { ActivityItemComponent } from "@/components/ui/activity-item"
import { MOCK_HEALTH, MOCK_ACTIVITY, MOCK_INCIDENT, MOCK_APPROVALS } from "@/lib/mock-data"

/** Command Center - founder home page overview */
export default function CommandCenterPage() {
  const [incidentDismissed, setIncidentDismissed] = useState(false)
  const [buildModalOpen, setBuildModalOpen] = useState(false)
  const [reportModalOpen, setReportModalOpen] = useState(false)

  const health = MOCK_HEALTH
  const recentActivity = MOCK_ACTIVITY.slice(0, 5)
  const incident = MOCK_INCIDENT
  const pendingCount = MOCK_APPROVALS.filter((a) => a.status === "pending").length
  const criticalApprovals = MOCK_APPROVALS.filter(
    (a) => a.status === "pending" && (a.riskLevel === "critical" || a.riskLevel === "high")
  ).length

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      {incident && incident.status !== "resolved" && !incidentDismissed && (
        <div className="slide-in-top relative rounded-xl border border-red-500/30 bg-red-500/5 p-4 md:p-5">
          <div className="flex items-start gap-3">
            <div className="pulse-ring h-3 w-3 rounded-full bg-red-500 mt-1 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap items-center gap-2 mb-1.5">
                <Badge variant="danger" className="text-xs">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Active Incident
                </Badge>
                <span className="text-sm font-semibold text-red-300">{incident.title}</span>
              </div>
              <p className="text-sm text-zinc-300 mb-2">{incident.description}</p>
              <div className="flex items-center gap-1.5 text-xs text-zinc-400">
                <Users className="h-3.5 w-3.5" />
                <span>
                  <span className="font-semibold text-zinc-200">{incident.affectedUsers.toLocaleString()}</span>
                  {" "}of {incident.totalUsers.toLocaleString()} users affected
                </span>
              </div>
              <p className="text-xs text-green-400 mt-2.5 font-medium">
                Forge is working on it: {incident.whatForgeIsDoing}
              </p>
            </div>
            <button onClick={() => setIncidentDismissed(true)} className="shrink-0 p-1 rounded-md hover:bg-red-500/10 text-zinc-400" aria-label="Dismiss">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card className="md:col-span-1 flex items-center justify-center py-6">
          <HealthScoreDisplay score={health.overall} trend={health.trend} size="lg" label="Startup Health" animated />
        </Card>
        <div className="md:col-span-3 grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Card className="hover:border-zinc-700 transition-colors">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardDescription>Waiting for you</CardDescription>
                <CheckSquare className="h-4 w-4 text-zinc-500" />
              </div>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold text-zinc-100 tabular-nums">{pendingCount}</div>
              <p className="text-xs text-zinc-400 mt-1">
                {criticalApprovals > 0 ? `${criticalApprovals} high-priority` : "Pending approvals"}
              </p>
              {pendingCount > 0 && (
                <Link href="/approvals">
                  <Button variant="link" size="sm" className="px-0 mt-2 h-auto text-xs">
                    Review now <ArrowRight className="h-3 w-3" />
                  </Button>
                </Link>
              )}
            </CardContent>
          </Card>

          <Card className="hover:border-zinc-700 transition-colors">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardDescription>Active incidents</CardDescription>
                <AlertTriangle className="h-4 w-4 text-zinc-500" />
              </div>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold tabular-nums">
                <span className={incident.status !== "resolved" ? "text-red-400" : "text-green-400"}>
                  {incident.status !== "resolved" ? 1 : 0}
                </span>
              </div>
              <p className="text-xs text-zinc-400 mt-1">
                {incident.status !== "resolved" ? "Forge is investigating" : "All systems normal"}
              </p>
              {incident.status !== "resolved" && (
                <Badge variant="danger" className="mt-2 text-xs">In progress</Badge>
              )}
            </CardContent>
          </Card>

          <Card className="hover:border-zinc-700 transition-colors">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardDescription>Security score</CardDescription>
                <ShieldAlert className="h-4 w-4 text-zinc-500" />
              </div>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold text-zinc-100 tabular-nums">{health.securityScore}</div>
              <p className="text-xs text-zinc-400 mt-1">Out of 100</p>
              <Badge
                variant={health.securityScore >= 80 ? "success" : health.securityScore >= 60 ? "warning" : "danger"}
                className="mt-2 text-xs"
              >
                {health.securityScore >= 80 ? "Good" : health.securityScore >= 60 ? "Needs attention" : "Critical"}
              </Badge>
            </CardContent>
          </Card>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">Today&apos;s Activity</CardTitle>
              <Link href="/activity">
                <Button variant="ghost" size="sm" className="text-xs">
                  View all <ArrowRight className="h-3.5 w-3.5" />
                </Button>
              </Link>
            </div>
            <CardDescription>What Forge has been doing for you</CardDescription>
          </CardHeader>
          <CardContent>
            {recentActivity.map((item) => (
              <ActivityItemComponent key={item.id} item={item} compact />
            ))}
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Quick Actions</CardTitle>
              <CardDescription>Tell Forge what to do next</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Button variant="default" className="w-full justify-start gap-3" onClick={() => setBuildModalOpen(true)}>
                <Hammer className="h-4 w-4" />Build something
              </Button>
              <Button variant="outline" className="w-full justify-start gap-3" onClick={() => setReportModalOpen(true)}>
                <Bug className="h-4 w-4" />Report a problem
              </Button>
              <Link href="/metrics">
                <Button variant="outline" className="w-full justify-start gap-3">
                  <BarChart3 className="h-4 w-4" />Check metrics
                </Button>
              </Link>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">This Week</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              {[
                { label: "Bugs fixed automatically", value: "7", color: "text-green-400" },
                { label: "Deployments shipped", value: "3", color: "text-blue-400" },
                { label: "Uptime", value: `${health.uptime}%`, color: "text-green-400" },
                { label: "Error rate", value: `${health.errorRate}%`, color: health.errorRate < 1 ? "text-green-400" : "text-yellow-400" },
              ].map((stat) => (
                <div key={stat.label} className="flex items-center justify-between">
                  <span className="text-xs text-zinc-400">{stat.label}</span>
                  <span className={`text-sm font-bold tabular-nums ${stat.color}`}>{stat.value}</span>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>

      {buildModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setBuildModalOpen(false)} />
          <Card className="relative z-10 w-full max-w-md fade-in">
            <CardHeader>
              <CardTitle>What should Forge build?</CardTitle>
              <CardDescription>Describe what you want in plain English. Forge will scope it and ask for approval before building.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <textarea
                className="w-full h-32 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-100 text-sm p-3 resize-none focus:outline-none focus:border-green-500 placeholder:text-zinc-500"
                placeholder="e.g. Add a CSV export button to the reports page so users can download their data..."
              />
              <div className="flex gap-3">
                <Button className="flex-1">Submit to Forge</Button>
                <Button variant="outline" onClick={() => setBuildModalOpen(false)}>Cancel</Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {reportModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setReportModalOpen(false)} />
          <Card className="relative z-10 w-full max-w-md fade-in">
            <CardHeader>
              <CardTitle>Report a problem</CardTitle>
              <CardDescription>Describe what is broken. Forge will investigate and fix it.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <textarea
                className="w-full h-32 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-100 text-sm p-3 resize-none focus:outline-none focus:border-green-500 placeholder:text-zinc-500"
                placeholder="e.g. The checkout button is broken on mobile. Users click it and nothing happens..."
              />
              <div className="flex gap-3">
                <Button variant="destructive" className="flex-1 bg-red-500 text-white hover:bg-red-400">Report to Forge</Button>
                <Button variant="outline" onClick={() => setReportModalOpen(false)}>Cancel</Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  )
}
