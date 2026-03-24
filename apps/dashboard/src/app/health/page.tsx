"use client"

import { Shield, Code2, CheckCircle, AlertTriangle, XCircle } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
// Badge removed - unused import
import { Progress } from "@/components/ui/progress"
import { HealthScoreDisplay } from "@/components/ui/health-score"
import { BarMetricChart, AreaMetricChart } from "@/components/ui/metric-chart"
import { MOCK_HEALTH, MOCK_UPTIME_HEATMAP } from "@/lib/mock-data"
import { cn } from "@/lib/utils"
import { format } from "date-fns"

export default function HealthPage() {
  const health = MOCK_HEALTH

  const deploymentData = Array.from({ length: 30 }, (_, i) => ({
    date: new Date(Date.now() - (30 - i - 1) * 24 * 60 * 60 * 1000).toISOString(),
    value: Math.random() > 0.7 ? Math.floor(Math.random() * 3) + 1 : 0,
  }))

  const errorData = Array.from({ length: 30 }, (_, i) => ({
    date: new Date(Date.now() - (30 - i - 1) * 24 * 60 * 60 * 1000).toISOString(),
    value: 0.2 + Math.random() * 0.8,
  }))

  const getUptimeColor = (uptime: number) => {
    if (uptime >= 99.5) return "bg-green-500"
    if (uptime >= 99) return "bg-green-600/70"
    if (uptime >= 95) return "bg-yellow-500"
    if (uptime >= 90) return "bg-orange-500"
    return "bg-red-500"
  }

  const scoreCards = [
    {
      label: "Security",
      score: health.securityScore,
      icon: Shield,
      description: "How well-protected your product is from attacks",
      items: [
        { name: "Dependencies up to date", status: "ok" as const },
        { name: "No exposed secrets", status: "ok" as const },
        { name: "Authentication hardened", status: "warning" as const },
        { name: "Rate limiting active", status: "ok" as const },
      ],
    },
    {
      label: "Code Quality",
      score: health.debtScore,
      icon: Code2,
      description: "How maintainable and clean your codebase is",
      items: [
        { name: "Type coverage: 94%", status: "ok" as const },
        { name: "Test coverage: 61%", status: "warning" as const },
        { name: "Complex functions: 12", status: "warning" as const },
        { name: "Duplicate code: 4 instances", status: "warning" as const },
      ],
    },
  ]

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold text-zinc-100">Technical Health</h1>
        <p className="text-sm text-zinc-400 mt-1">
          A plain-English view of how your product is running under the hood.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card className="flex items-center justify-center py-8">
          <HealthScoreDisplay score={health.overall} trend={health.trend} size="lg" label="Overall Health" animated />
        </Card>
        <div className="md:col-span-3 grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { label: "Uptime", value: `${health.uptime}%`, good: health.uptime >= 99.5, description: "Last 30 days" },
            { label: "Error Rate", value: `${health.errorRate}%`, good: health.errorRate < 1, description: "Of all requests" },
            { label: "Security", value: `${health.securityScore}/100`, good: health.securityScore >= 80, description: "Protection score" },
            { label: "Code Quality", value: `${health.debtScore}/100`, good: health.debtScore >= 70, description: "Maintainability" },
          ].map((stat) => (
            <Card key={stat.label}>
              <CardContent className="pt-5 pb-4">
                <div className="flex items-center gap-2 mb-2">
                  {stat.good ? (
                    <CheckCircle className="h-4 w-4 text-green-400 shrink-0" />
                  ) : (
                    <AlertTriangle className="h-4 w-4 text-yellow-400 shrink-0" />
                  )}
                  <span className="text-xs text-zinc-400">{stat.label}</span>
                </div>
                <div className={`text-2xl font-bold tabular-nums ${stat.good ? "text-green-400" : "text-yellow-400"}`}>{stat.value}</div>
                <p className="text-xs text-zinc-500 mt-1">{stat.description}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Uptime History — Last 90 Days</CardTitle>
          <CardDescription>Each block is one day. Green means 99.9%+ uptime. Red means significant downtime.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-1">
            {MOCK_UPTIME_HEATMAP.map((day) => (
              <div
                key={day.date}
                className={cn("h-4 w-4 rounded-sm", getUptimeColor(day.uptime))}
                title={`${format(new Date(day.date), "MMM d")}: ${day.uptime.toFixed(2)}% uptime`}
              />
            ))}
          </div>
          <div className="flex items-center gap-4 mt-3">
            <div className="flex items-center gap-1.5 text-xs text-zinc-500"><div className="h-3 w-3 rounded-sm bg-green-500" />99.9%+</div>
            <div className="flex items-center gap-1.5 text-xs text-zinc-500"><div className="h-3 w-3 rounded-sm bg-yellow-500" />95-99%</div>
            <div className="flex items-center gap-1.5 text-xs text-zinc-500"><div className="h-3 w-3 rounded-sm bg-red-500" />Under 95%</div>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Error Rate (30 days)</CardTitle>
            <CardDescription>Spikes usually happen after deployments — Forge auto-rolls back if needed</CardDescription>
          </CardHeader>
          <CardContent>
            <AreaMetricChart
              data={errorData}
              label="Error Rate"
              color="#ef4444"
              formatter={(v) => `${v.toFixed(2)}%`}
              height={180}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Deployment Frequency (30 days)</CardTitle>
            <CardDescription>How often Forge is shipping updates to your product</CardDescription>
          </CardHeader>
          <CardContent>
            <BarMetricChart
              data={deploymentData}
              label="Deployments"
              color="#3b82f6"
              height={180}
              formatter={(v) => String(Math.round(v))}
            />
            <p className="text-xs text-zinc-500 mt-3">
              Average: <span className="font-semibold text-zinc-300">{health.deploymentFrequency.toFixed(1)}</span> per week
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {scoreCards.map((section) => (
          <Card key={section.label}>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <section.icon className="h-4 w-4 text-zinc-400" />
                  <CardTitle className="text-base">{section.label}</CardTitle>
                </div>
                <span className="text-2xl font-bold text-zinc-100 tabular-nums">{section.score}</span>
              </div>
              <CardDescription>{section.description}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Progress value={section.score} className="h-2" />
              <div className="space-y-2 mt-3">
                {section.items.map((item) => (
                  <div key={item.name} className="flex items-center gap-2.5 text-sm">
                    {item.status === "ok" ? (
                      <CheckCircle className="h-4 w-4 text-green-400 shrink-0" />
                    ) : item.status === "warning" ? (
                      <AlertTriangle className="h-4 w-4 text-yellow-400 shrink-0" />
                    ) : (
                      <XCircle className="h-4 w-4 text-red-400 shrink-0" />
                    )}
                    <span className="text-zinc-300">{item.name}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}
