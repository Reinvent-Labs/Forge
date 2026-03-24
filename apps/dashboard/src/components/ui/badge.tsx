import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const badgeVariants = cva(
  // Base styles: inline badge with border
  "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors",
  {
    variants: {
      variant: {
        default: "border-zinc-700 bg-zinc-800 text-zinc-300",
        success:
          "border-green-500/30 bg-green-500/10 text-green-400",
        warning:
          "border-yellow-500/30 bg-yellow-500/10 text-yellow-400",
        danger:
          "border-red-500/30 bg-red-500/10 text-red-400",
        info:
          "border-blue-500/30 bg-blue-500/10 text-blue-400",
        orange:
          "border-orange-500/30 bg-orange-500/10 text-orange-400",
        purple:
          "border-purple-500/30 bg-purple-500/10 text-purple-400",
        outline:
          "border-zinc-600 bg-transparent text-zinc-400",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

/**
 * Badge — small inline label for status, risk level, or agent type.
 * Green (success) is the only accent color used.
 */
function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  )
}

export { Badge, badgeVariants }
