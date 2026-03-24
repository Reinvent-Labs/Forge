"use client"

import { useState } from "react"
import { Github, Cloud, BarChart3, MessageSquare, CreditCard, CheckCircle2, AlertTriangle, XCircle, Settings, Plus, X } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { MOCK_INTEGRATIONS } from "@/lib/mock-data"
import { formatTimeAgo, cn } from "@/lib/utils"
import type { Integration } from "@/lib/types"

const INTEGRATION_CATALOG = [
  { type: "github", name: "GitHub", category: "Source Control", description: "Connect your repository so Forge can read code, open PRs, and deploy changes.", icon: Github, color: "text-zinc-300", required: true },
  { type: "vercel", name: "Vercel", category: "Hosting", description: "Deploy your app automatically on every approved change.", icon: Cloud, color: "text-zinc-300", required: false },
  { type: "railway", name: "Railway", category: "Hosting", description: "Alternative hosting — containers and databases made easy.", icon: Cloud, color: "text-purple-400", required: false },
  { type: "posthog", name: "PostHog", category: "Analytics", description: "Track user behavior. Forge uses this to detect when changes hurt engagement.", icon: BarChart3, color: "text-orange-400", required: false },
  { type: "sentry", name: "Sentry", category: "Error Monitoring", description: "See every error in your product. Forge auto-triages and fixes them.", icon: AlertTriangle, color: "text-yellow-400", required: false },
  { type: "slack", name: "Slack", category: "Notifications", description: "Get alerts and approval requests directly in your Slack workspace.", icon: MessageSquare, color: "text-green-400", required: false },
  { type: "telegram", name: "Telegram", category: "Notifications", description: "Receive Forge updates via Telegram bot — great for mobile.", icon: MessageSquare, color: "text-blue-400", required: false },
  { type: "stripe", name: "Stripe", category: "Payments", description: "Track revenue, MRR, and churn. Forge monitors for payment failures.", icon: CreditCard, color: "text-purple-400", required: false },
  { type: "datadog", name: "Datadog", category: "Monitoring", description: "Advanced infrastructure monitoring and alerting.", icon: BarChart3, color: "text-orange-400", required: false },
] as const

type CatalogItem = typeof INTEGRATION_CATALOG[number]

const STATUS_CONFIG = {
  connected: { label: "Connected", variant: "success" as const, icon: CheckCircle2 },
  needs_attention: { label: "Needs Attention", variant: "warning" as const, icon: AlertTriangle },
  disconnected: { label: "Not Connected", variant: "default" as const, icon: XCircle },
}

interface ConnectModalProps {
  integration: CatalogItem
  onClose: () => void
}

function ConnectModal({ integration, onClose }: ConnectModalProps) {
  const [step, setStep] = useState<"info" | "form" | "done">("info")
  const [apiKey, setApiKey] = useState("")

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <Card className="relative z-10 w-full max-w-md fade-in">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="h-9 w-9 rounded-lg bg-zinc-800 flex items-center justify-center">
                <integration.icon className={cn("h-5 w-5", integration.color)} />
              </div>
              <CardTitle className="text-base">Connect {integration.name}</CardTitle>
            </div>
            <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-400" aria-label="Close">
              <X className="h-4 w-4" />
            </button>
          </div>
          <CardDescription>{integration.description}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {step === "info" && (
            <>
              <div className="rounded-lg bg-zinc-800/60 p-3.5 text-sm text-zinc-300">
                <p className="font-medium text-zinc-200 mb-2">What Forge can do with {integration.name}:</p>
                <ul className="space-y-1 text-sm text-zinc-400">
                  <li>Read your data and understand patterns</li>
                  <li>Automatically respond to events and alerts</li>
                  <li>Surface insights directly in this dashboard</li>
                </ul>
              </div>
              <Button className="w-full" onClick={() => setStep("form")}>
                Connect {integration.name}
              </Button>
            </>
          )}
          {step === "form" && (
            <>
              <div>
                <label className="block text-sm font-medium text-zinc-300 mb-2">{integration.name} API Key</label>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={`Paste your ${integration.name} API key here...`}
                  className="w-full rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-100 text-sm px-3 py-2.5 focus:outline-none focus:border-green-500 placeholder:text-zinc-500"
                />
                <p className="text-xs text-zinc-500 mt-1.5">Your key is encrypted and never shared.</p>
              </div>
              <div className="flex gap-3">
                <Button className="flex-1" onClick={() => setStep("done")} disabled={!apiKey}>Save connection</Button>
                <Button variant="outline" onClick={() => setStep("info")}>Back</Button>
              </div>
            </>
          )}
          {step === "done" && (
            <div className="text-center py-4">
              <CheckCircle2 className="h-12 w-12 text-green-400 mx-auto mb-3" />
              <h3 className="font-semibold text-zinc-100 mb-1">{integration.name} connected!</h3>
              <p className="text-sm text-zinc-400 mb-4">Forge will start using {integration.name} immediately.</p>
              <Button onClick={onClose} className="w-full">Done</Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

export default function IntegrationsPage() {
  const [connectingType, setConnectingType] = useState<string | null>(null)
  const integrations = MOCK_INTEGRATIONS

  const getIntegrationStatus = (type: string): Integration | undefined =>
    integrations.find((i) => i.type === type)

  const categories = Array.from(new Set(INTEGRATION_CATALOG.map((i) => i.category)))
  const connectingCatalog = INTEGRATION_CATALOG.find((i) => i.type === connectingType)
  const connectedCount = integrations.filter((i) => i.status === "connected").length
  const attentionCount = integrations.filter((i) => i.status === "needs_attention").length

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-zinc-100">Integrations</h1>
          <p className="text-sm text-zinc-400 mt-1">
            Connect your tools so Forge can see everything and act on your behalf.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="success" className="text-xs"><CheckCircle2 className="h-3.5 w-3.5" />{connectedCount} connected</Badge>
          {attentionCount > 0 && (
            <Badge variant="warning" className="text-xs"><AlertTriangle className="h-3.5 w-3.5" />{attentionCount} need attention</Badge>
          )}
        </div>
      </div>

      {categories.map((category) => {
        const items = INTEGRATION_CATALOG.filter((i) => i.category === category)
        return (
          <div key={category}>
            <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wide mb-3">{category}</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {items.map((item) => {
                const status = getIntegrationStatus(item.type)
                const statusConfig = STATUS_CONFIG[status?.status ?? "disconnected"]
                const StatusIcon = statusConfig.icon

                return (
                  <Card
                    key={item.type}
                    className={cn("hover:border-zinc-700 transition-colors", status?.status === "needs_attention" && "border-yellow-500/30")}
                  >
                    <CardHeader className="pb-2">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-3">
                          <div className="h-9 w-9 rounded-lg bg-zinc-800 flex items-center justify-center shrink-0">
                            <item.icon className={cn("h-4 w-4", item.color)} />
                          </div>
                          <div>
                            <CardTitle className="text-sm">{item.name}</CardTitle>
                            {item.required && <span className="text-xs text-zinc-500">Required</span>}
                          </div>
                        </div>
                        <Badge variant={statusConfig.variant} className="text-xs shrink-0">
                          <StatusIcon className="h-3 w-3" />{statusConfig.label}
                        </Badge>
                      </div>
                    </CardHeader>
                    <CardContent>
                      <p className="text-xs text-zinc-400 mb-3 leading-relaxed">{item.description}</p>
                      {status?.status === "connected" && status.connectedAt && (
                        <p className="text-xs text-zinc-600 mb-3">Connected {formatTimeAgo(status.connectedAt)}</p>
                      )}
                      {status?.status === "needs_attention" && (
                        <div className="rounded-md bg-yellow-500/10 border border-yellow-500/20 px-2.5 py-2 mb-3">
                          <p className="text-xs text-yellow-400">{status.metadata?.issue ?? "Reconnection required"}</p>
                        </div>
                      )}
                      {status?.status === "connected" ? (
                        <Button variant="ghost" size="sm" className="w-full text-xs" onClick={() => setConnectingType(item.type)}>
                          <Settings className="h-3.5 w-3.5" />Configure
                        </Button>
                      ) : status?.status === "needs_attention" ? (
                        <Button variant="outline" size="sm" className="w-full text-xs border-yellow-500/30 text-yellow-400 hover:bg-yellow-500/10" onClick={() => setConnectingType(item.type)}>
                          Reconnect
                        </Button>
                      ) : (
                        <Button variant="default" size="sm" className="w-full text-xs" onClick={() => setConnectingType(item.type)}>
                          <Plus className="h-3.5 w-3.5" />Connect
                        </Button>
                      )}
                    </CardContent>
                  </Card>
                )
              })}
            </div>
          </div>
        )
      })}

      {connectingType && connectingCatalog && (
        <ConnectModal integration={connectingCatalog} onClose={() => setConnectingType(null)} />
      )}
    </div>
  )
}
