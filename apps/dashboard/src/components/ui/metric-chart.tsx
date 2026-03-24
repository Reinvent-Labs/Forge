"use client"

import {
  AreaChart, Area, LineChart, Line, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from "recharts"
import { format } from "date-fns"
import { cn } from "@/lib/utils"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function DarkTooltip({ active, payload, label, formatter }: any) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 shadow-xl text-xs">
      <p className="text-zinc-400 mb-1.5">{label}</p>
      {payload.map((entry: { dataKey: string; color: string; value: number; name: string }) => (
        <div key={entry.dataKey as string} className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full" style={{ background: entry.color }} />
          <span className="text-zinc-300">
            {entry.name}:{" "}
            <span className="font-semibold text-zinc-100">
              {formatter ? formatter(entry.value as number, entry.name as string) : entry.value}
            </span>
          </span>
        </div>
      ))}
    </div>
  )
}

const CHART_DEFAULTS = {
  margin: { top: 5, right: 10, left: -10, bottom: 5 },
  grid: { stroke: "#27272a", strokeDasharray: "3 3" },
  xAxis: { tick: { fill: "#71717a", fontSize: 11 }, axisLine: false, tickLine: false },
  yAxis: { tick: { fill: "#71717a", fontSize: 11 }, axisLine: false, tickLine: false },
}

interface AreaMetricChartProps {
  data: Array<{ date: string; value: number }>
  label: string
  color?: string
  formatter?: (v: number) => string
  height?: number
  className?: string
}

export function AreaMetricChart({ data, label, color = "#22c55e", formatter, height = 200, className }: AreaMetricChartProps) {
  const formatted = data.map((d) => ({ ...d, display: format(new Date(d.date), "MMM d") }))
  const gradId = `area-grad-${label.replace(/ /g, "-")}`

  return (
    <div className={cn("w-full", className)} style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={formatted} margin={CHART_DEFAULTS.margin}>
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={color} stopOpacity={0.3} />
              <stop offset="95%" stopColor={color} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid {...CHART_DEFAULTS.grid} />
          <XAxis dataKey="display" {...CHART_DEFAULTS.xAxis} interval="preserveStartEnd" />
          <YAxis {...CHART_DEFAULTS.yAxis} tickFormatter={formatter ?? ((v: number) => String(v))} width={50} />
          <Tooltip content={(props) => formatter ? <DarkTooltip {...props} formatter={(v: number) => formatter(v)} /> : <DarkTooltip {...props} />} />
          <Area
            type="monotone"
            dataKey="value"
            name={label}
            stroke={color}
            strokeWidth={2}
            fill={`url(#area-grad-${label.replace(/ /g, "-")})`}
            dot={false}
            activeDot={{ r: 4, fill: color }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

interface MultiLineChartProps {
  data: Array<{ date: string; p50: number; p95: number; p99: number }>
  height?: number
  className?: string
}

export function LatencyChart({ data, height = 200, className }: MultiLineChartProps) {
  const formatted = data.map((d) => ({
    ...d,
    display: format(new Date(d.date), "MMM d"),
    p50: Math.round(d.p50),
    p95: Math.round(d.p95),
    p99: Math.round(d.p99),
  }))

  const msFormatter = (v: number) => `${v}ms`

  return (
    <div className={cn("w-full", className)} style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={formatted} margin={CHART_DEFAULTS.margin}>
          <CartesianGrid {...CHART_DEFAULTS.grid} />
          <XAxis dataKey="display" {...CHART_DEFAULTS.xAxis} interval="preserveStartEnd" />
          <YAxis {...CHART_DEFAULTS.yAxis} tickFormatter={msFormatter} width={55} />
          <Tooltip content={(props) => <DarkTooltip {...props} formatter={(v: number) => msFormatter(v)} />} />
          <Legend wrapperStyle={{ fontSize: 11, color: "#71717a", paddingTop: 8 }} />
          <Line type="monotone" dataKey="p50" name="p50 (typical)" stroke="#22c55e" strokeWidth={2} dot={false} activeDot={{ r: 3 }} />
          <Line type="monotone" dataKey="p95" name="p95 (95th pct)" stroke="#eab308" strokeWidth={2} dot={false} activeDot={{ r: 3 }} />
          <Line type="monotone" dataKey="p99" name="p99 (slowest 1%)" stroke="#ef4444" strokeWidth={2} dot={false} activeDot={{ r: 3 }} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

interface BarMetricChartProps {
  data: Array<{ date: string; value: number }>
  label: string
  color?: string
  height?: number
  className?: string
  formatter?: (v: number) => string
}

export function BarMetricChart({ data, label, color = "#22c55e", height = 160, className, formatter }: BarMetricChartProps) {
  const formatted = data.map((d) => ({ ...d, display: format(new Date(d.date), "MMM d") }))

  return (
    <div className={cn("w-full", className)} style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={formatted} margin={CHART_DEFAULTS.margin}>
          <CartesianGrid {...CHART_DEFAULTS.grid} />
          <XAxis dataKey="display" {...CHART_DEFAULTS.xAxis} interval="preserveStartEnd" />
          <YAxis {...CHART_DEFAULTS.yAxis} tickFormatter={formatter ?? ((v: number) => String(v))} width={50} />
          <Tooltip content={(props) => formatter ? <DarkTooltip {...props} formatter={(v: number) => formatter(v)} /> : <DarkTooltip {...props} />} />
          <Bar dataKey="value" name={label} fill={color} radius={[3, 3, 0, 0]} maxBarSize={32} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
