"use client"

import { useState } from "react"
import { TrendingUp, Users, DollarSign, Activity, Wifi, Zap } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { AreaMetricChart, LatencyChart } from "@/components/ui/metric-chart"
import { MOCK_METRICS } from "@/lib/mock-data"
import { formatNumber } from "@/lib/utils"
import type { MetricsResponse } from "@/lib/api"

type Range = "7d" | "30d" | "90d"

const RANGE_LABELS: Record<Range, string> = {
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
}

function sliceData<T>(data: T[], range: Range): T[] {
  const days = range === "7d" ? 7 : range === "30d" ? 30 : 90
  return data.slice(-days)
}

export default function MetricsPage() {
  const [range, setRange] = useState<Range>("30d")
  const metrics: MetricsResponse = MOCK_METRICS

  const activeUsersData = sliceData(metrics.activeUsers, range)
  const signupsData = sliceData(metrics.newSignups, range)
  const revenueData = metrics.revenue ? sliceData(metrics.revenue, range) : null
  const errorRateData = sliceData(metrics.errorRate, range)
  const latencyData = sliceData(metrics.latency, range)

  const avgUsers = Math.round(activeUsersData.reduce((s, d) => s + d.value, 0) / activeUsersData.length)
  const totalSignups = Math.round(signupsData.reduce((s, d) => s + d.value, 0))
  const totalRevenue = revenueData ? Math.round(revenueData.reduce((s, d) => s + d.value, 0)) : null
  const avgErrorRate = (errorRateData.reduce((s, d) => s + d.value, 0) / errorRateData.length).toFixed(2)

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-zinc-100">Business Metrics</h1>
          <p className="text-sm text-zinc-400 mt-1">The numbers that tell you how your product is performing.</p>
        </div>
        <div className="flex rounded-lg border border-zinc-800 bg-zinc-900 p-0.5 gap-0.5">
          {(Object.keys(RANGE_LABELS) as Range[]).map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${range === r ? "bg-green-500 text-zinc-950" : "text-zinc-400 hover:text-zinc-200"}`}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      <div>
        <h2 className="text-base font-semibold text-zinc-300 mb-3 flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-green-400" />
          Business Growth
        </h2>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
          {[
            { label: "Avg. Daily Users", value: formatNumber(avgUsers), icon: Users, color: "text-blue-400", trend: "+12% vs prev period" },
            { label: "New Signups", value: formatNumber(totalSignups), icon: Activity, color: "text-green-400", trend: RANGE_LABELS[range] },
            { label: "Revenue", value: totalRevenue !== null ? `$${formatNumber(totalRevenue as number)}` : "Not connected", icon: DollarSign, color: totalRevenue !== null ? "text-green-400" : "text-zinc-600", trend: totalRevenue !== null ? RANGE_LABELS[range] : "Connect Stripe" },
            { label: "Uptime", value: `${metrics.uptime}%`, icon: Wifi, color: metrics.uptime >= 99.9 ? "text-green-400" : "text-yellow-400", trend: "30-day average" },
          ].map((stat) => (
            <Card key={stat.label}>
              <CardHeader className="pb-1">
                <div className="flex items-center justify-between">
                  <CardDescription className="text-xs">{stat.label}</CardDescription>
                  <stat.icon className="h-3.5 w-3.5 text-zinc-600" />
                </div>
              </CardHeader>
              <CardContent>
                <div className={`text-2xl font-bold tabular-nums ${stat.color}`}>{stat.value}</div>
                <p className="text-xs text-zinc-500 mt-1">{stat.trend}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Daily Active Users</CardTitle>
              <CardDescription>People actively using your product each day</CardDescription>
            </CardHeader>
            <CardContent>
              <AreaMetricChart
                data={activeUsersData}
                label="Active Users"
                color="#22c55e"
                formatter={(v) => formatNumber(Math.round(v))}
                height={200}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">New Signups</CardTitle>
              <CardDescription>New accounts created each day</CardDescription>
            </CardHeader>
            <CardContent>
              <AreaMetricChart
                data={signupsData}
                label="New Signups"
                color="#3b82f6"
                formatter={(v) => String(Math.round(v))}
                height={200}
              />
            </CardContent>
          </Card>

          <Card className="md:col-span-2">
            <CardHeader>
              <CardTitle className="text-sm">Revenue</CardTitle>
              <CardDescription>
                {revenueData ? "Daily revenue from your Stripe integration" : "Connect Stripe to start tracking revenue"}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {revenueData ? (
                <AreaMetricChart
                  data={revenueData}
                  label="Revenue"
                  color="#22c55e"
                  formatter={(v) => `$${formatNumber(Math.round(v))}`}
                  height={200}
                />
              ) : (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <DollarSign className="h-12 w-12 text-zinc-700 mb-3" />
                  <h3 className="text-sm font-semibold text-zinc-300">Revenue tracking not set up</h3>
                  <p className="text-xs text-zinc-500 mt-1 mb-4 max-w-xs">
                    Connect your Stripe account to see daily revenue, MRR, and churn in this dashboard.
                  </p>
                  <Button size="sm" variant="outline">Connect Stripe</Button>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <div>
        <h2 className="text-base font-semibold text-zinc-300 mb-3 flex items-center gap-2">
          <Zap className="h-4 w-4 text-yellow-400" />
          Technical Reliability
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-sm">Error Rate</CardTitle>
                  <CardDescription>% of requests that fail</CardDescription>
                </div>
                <Badge variant={Number(avgErrorRate) < 1 ? "success" : Number(avgErrorRate) < 3 ? "warning" : "danger"} className="text-xs">
                  Avg: {avgErrorRate}%
                </Badge>
              </div>
            </CardHeader>
            <CardContent>
              <AreaMetricChart
                data={errorRateData}
                label="Error Rate"
                color="#ef4444"
                formatter={(v) => `${v.toFixed(2)}%`}
                height={180}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Response Time</CardTitle>
              <CardDescription>
                How fast your product responds — p50 is typical, p99 is the slowest 1% of users
              </CardDescription>
            </CardHeader>
            <CardContent>
              <LatencyChart data={latencyData} height={180} />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
