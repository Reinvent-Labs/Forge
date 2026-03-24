"use client"

import { useEffect, useRef } from "react"
import { cn, clamp } from "@/lib/utils"
import { TrendingUp, TrendingDown, Minus } from "lucide-react"

interface HealthScoreProps {
  score: number
  trend: number
  size?: "sm" | "md" | "lg"
  label?: string
  className?: string
  animated?: boolean
}

/**
 * HealthScoreDisplay — large circular score widget.
 *
 * Shows a ring chart (SVG) with the score number inside.
 * Color shifts from red (0-40) to yellow (41-70) to green (71-100).
 * Founders see a simple 0-100 number, not raw metrics.
 */
export function HealthScoreDisplay({
  score,
  trend,
  size = "md",
  label = "Startup Health",
  className,
  animated = true,
}: HealthScoreProps) {
  const safeScore = clamp(Math.round(score), 0, 100)
  const circleRef = useRef<SVGCircleElement>(null)

  // SVG ring dimensions
  const dimensions = { sm: 80, md: 120, lg: 160 }
  const dim = dimensions[size]
  const radius = (dim - 16) / 2
  const circumference = 2 * Math.PI * radius
  const offset = circumference - (safeScore / 100) * circumference

  // Color based on score range
  const getScoreColor = (s: number) => {
    if (s >= 80) return { ring: "#22c55e", text: "text-green-400" }
    if (s >= 60) return { ring: "#eab308", text: "text-yellow-400" }
    if (s >= 40) return { ring: "#f97316", text: "text-orange-400" }
    return { ring: "#ef4444", text: "text-red-400" }
  }

  const colors = getScoreColor(safeScore)

  // Animate the ring fill on mount
  useEffect(() => {
    if (!animated || !circleRef.current) return
    circleRef.current.style.strokeDashoffset = String(circumference)
    const timer = setTimeout(() => {
      if (circleRef.current) {
        circleRef.current.style.transition = "stroke-dashoffset 1.2s ease-out"
        circleRef.current.style.strokeDashoffset = String(offset)
      }
    }, 100)
    return () => clearTimeout(timer)
  }, [safeScore, circumference, offset, animated])

  const textSizes = { sm: "text-xl", md: "text-3xl", lg: "text-5xl" }
  const labelSizes = { sm: "text-xs", md: "text-sm", lg: "text-base" }

  return (
    <div className={cn("flex flex-col items-center gap-2", className)}>
      <div className="relative" style={{ width: dim, height: dim }}>
        <svg width={dim} height={dim} className="-rotate-90">
          {/* Background ring */}
          <circle
            cx={dim / 2}
            cy={dim / 2}
            r={radius}
            fill="none"
            stroke="#27272a"
            strokeWidth="8"
          />
          {/* Score ring */}
          <circle
            ref={circleRef}
            cx={dim / 2}
            cy={dim / 2}
            r={radius}
            fill="none"
            stroke={colors.ring}
            strokeWidth="8"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={animated ? circumference : offset}
            style={
              animated
                ? {}
                : { strokeDashoffset: offset }
            }
          />
        </svg>

        {/* Score number centered inside ring */}
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span
            className={cn(
              "font-bold tabular-nums",
              textSizes[size],
              colors.text
            )}
          >
            {safeScore}
          </span>
          {size !== "sm" && (
            <span className="text-xs text-zinc-500 mt-0.5">/ 100</span>
          )}
        </div>
      </div>

      {/* Label + trend */}
      <div className="text-center">
        <p className={cn("font-medium text-zinc-300", labelSizes[size])}>
          {label}
        </p>
        {trend !== 0 && (
          <div className="flex items-center justify-center gap-1 mt-1">
            {trend > 0 ? (
              <TrendingUp className="h-3.5 w-3.5 text-green-400" />
            ) : trend < 0 ? (
              <TrendingDown className="h-3.5 w-3.5 text-red-400" />
            ) : (
              <Minus className="h-3.5 w-3.5 text-zinc-500" />
            )}
            <span
              className={cn(
                "text-xs font-medium",
                trend > 0
                  ? "text-green-400"
                  : trend < 0
                  ? "text-red-400"
                  : "text-zinc-500"
              )}
            >
              {trend > 0 ? "+" : ""}{trend} this week
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
