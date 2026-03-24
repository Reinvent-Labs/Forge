"use client"

import { useState } from "react"
import { Settings, Sliders, Bell, Users, Key, Clock, Copy, Eye, EyeOff, Plus, Trash2, Mail, Check } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { formatTimeAgo } from "@/lib/utils"

type Tab = "general" | "autonomy" | "notifications" | "team" | "api-keys" | "deployment"

const TABS: Array<{ id: Tab; label: string; icon: React.ComponentType<{ className?: string | undefined }> }> = [
  { id: "general", label: "General", icon: Settings },
  { id: "autonomy", label: "Autonomy", icon: Sliders },
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "team", label: "Team", icon: Users },
  { id: "api-keys", label: "API Keys", icon: Key },
  { id: "deployment", label: "Deployment", icon: Clock },
]

const AUTONOMY_OPTIONS = [
  {
    value: "supervised" as const,
    label: "Ask before everything",
    description: "Forge will ask your approval before making any change — no matter how small. Best if you want full control, but expect more notifications.",
    badge: "Safe",
    badgeVariant: "info" as const,
  },
  {
    value: "balanced" as const,
    label: "Handle small things, ask for big ones",
    description: "Forge fixes small bugs, updates dependencies, and monitors automatically. For anything touching user-facing features, payments, or security, it asks you first.",
    badge: "Recommended",
    badgeVariant: "success" as const,
  },
  {
    value: "full" as const,
    label: "Full autopilot",
    description: "Forge handles everything without interruptions. It will notify you about what it does, but will not wait for approval. Not recommended until you trust Forge fully.",
    badge: "Advanced",
    badgeVariant: "warning" as const,
  },
]

const MOCK_TEAM = [
  { id: "tm_1", name: "Alex Johnson", email: "alex@yourco.com", role: "owner" as const, joinedAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString() },
  { id: "tm_2", name: "Sam Chen", email: "sam@yourco.com", role: "admin" as const, joinedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString() },
]

const MOCK_API_KEYS = [
  { id: "key_1", name: "CLI — dev machine", prefix: "frg_dev_", createdAt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString(), lastUsedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() },
  { id: "key_2", name: "CI/CD pipeline", prefix: "frg_ci_", createdAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(), lastUsedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString() },
]

export default function SettingsPage() {
  const [tab, setTab] = useState<Tab>("general")
  const [autonomy, setAutonomy] = useState<"supervised" | "balanced" | "full">("balanced")
  const [projectName, setProjectName] = useState("My Startup")
  const [projectDesc, setProjectDesc] = useState("An amazing product that solves real problems.")
  const [slackWebhook, setSlackWebhook] = useState("")
  const [telegramChatId, setTelegramChatId] = useState("")
  const [inviteEmail, setInviteEmail] = useState("")
  const [inviting, setInviting] = useState(false)
  const [newKeyName, setNewKeyName] = useState("")
  const [creatingKey, setCreatingKey] = useState(false)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const [showKeyId, setShowKeyId] = useState<string | null>(null)
  const [savedGeneral, setSavedGeneral] = useState(false)

  const handleCopy = async (text: string, keyId: string) => {
    await navigator.clipboard.writeText(text)
    setCopiedKey(keyId)
    setTimeout(() => setCopiedKey(null), 2000)
  }

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold text-zinc-100">Settings</h1>
        <p className="text-sm text-zinc-400 mt-1">Configure how Forge works for your team.</p>
      </div>

      <div className="flex overflow-x-auto border-b border-zinc-800 gap-0">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-2 px-4 py-3 text-sm font-medium whitespace-nowrap border-b-2 transition-colors ${tab === t.id ? "border-green-500 text-green-400" : "border-transparent text-zinc-500 hover:text-zinc-300"}`}
          >
            <t.icon className="h-4 w-4" />
            {t.label}
          </button>
        ))}
      </div>

      {tab === "general" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Project Details</CardTitle>
            <CardDescription>Basic information about your product.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-zinc-300 mb-1.5">Project name</label>
              <input type="text" value={projectName} onChange={(e) => setProjectName(e.target.value)} className="w-full rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-100 text-sm px-3 py-2.5 focus:outline-none focus:border-green-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-zinc-300 mb-1.5">Description</label>
              <textarea value={projectDesc} onChange={(e) => setProjectDesc(e.target.value)} rows={3} className="w-full rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-100 text-sm px-3 py-2.5 focus:outline-none focus:border-green-500 resize-none" />
            </div>
            <Button onClick={() => { setSavedGeneral(true); setTimeout(() => setSavedGeneral(false), 2000) }} className="w-full sm:w-auto">
              {savedGeneral ? <><Check className="h-4 w-4" /> Saved</> : "Save changes"}
            </Button>
          </CardContent>
        </Card>
      )}

      {tab === "autonomy" && (
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">How much should Forge do on its own?</CardTitle>
              <CardDescription>Choose how much control you want to keep. You can change this anytime.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {AUTONOMY_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  onClick={() => setAutonomy(option.value)}
                  className={`w-full text-left rounded-xl border p-4 transition-all ${autonomy === option.value ? "border-green-500/50 bg-green-500/5" : "border-zinc-800 bg-zinc-900/50 hover:border-zinc-700"}`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-semibold text-zinc-100 text-sm">{option.label}</span>
                    <div className="flex items-center gap-2">
                      <Badge variant={option.badgeVariant} className="text-xs">{option.badge}</Badge>
                      {autonomy === option.value && (
                        <div className="h-4 w-4 rounded-full bg-green-500 flex items-center justify-center">
                          <Check className="h-2.5 w-2.5 text-zinc-950" />
                        </div>
                      )}
                    </div>
                  </div>
                  <p className="text-sm text-zinc-400 leading-relaxed text-left">{option.description}</p>
                </button>
              ))}
            </CardContent>
          </Card>
        </div>
      )}

      {tab === "notifications" && (
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Slack</CardTitle>
              <CardDescription>Get Forge alerts and approval requests in Slack.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-zinc-300 mb-1.5">Slack Webhook URL</label>
                <input type="text" value={slackWebhook} onChange={(e) => setSlackWebhook(e.target.value)} placeholder="https://hooks.slack.com/services/..." className="w-full rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-100 text-sm px-3 py-2.5 focus:outline-none focus:border-green-500 placeholder:text-zinc-500 font-mono" />
              </div>
              <Button disabled={!slackWebhook} className="w-full sm:w-auto">Save Slack config</Button>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Telegram</CardTitle>
              <CardDescription>Receive alerts via Telegram bot on your phone.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-zinc-300 mb-1.5">Telegram Chat ID</label>
                <input type="text" value={telegramChatId} onChange={(e) => setTelegramChatId(e.target.value)} placeholder="e.g. -1001234567890" className="w-full rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-100 text-sm px-3 py-2.5 focus:outline-none focus:border-green-500 placeholder:text-zinc-500 font-mono" />
                <p className="text-xs text-zinc-500 mt-1.5">Start a chat with <span className="text-zinc-300 font-mono">@ForgeBot</span> on Telegram to get your Chat ID.</p>
              </div>
              <Button disabled={!telegramChatId} className="w-full sm:w-auto">Save Telegram config</Button>
            </CardContent>
          </Card>
        </div>
      )}

      {tab === "team" && (
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Team Members</CardTitle>
              <CardDescription>People who can access this Forge project.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {MOCK_TEAM.map((member) => (
                <div key={member.id} className="flex items-center justify-between gap-3 py-2 border-b border-zinc-800 last:border-0">
                  <div className="flex items-center gap-3">
                    <div className="h-9 w-9 rounded-full bg-zinc-800 flex items-center justify-center shrink-0">
                      <span className="text-sm font-bold text-zinc-300">{member.name.charAt(0)}</span>
                    </div>
                    <div>
                      <p className="text-sm font-medium text-zinc-200">{member.name}</p>
                      <p className="text-xs text-zinc-500">{member.email}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={member.role === "owner" ? "success" : "default"} className="capitalize text-xs">{member.role}</Badge>
                    {member.role !== "owner" && (
                      <Button variant="ghost" size="icon-sm"><Trash2 className="h-3.5 w-3.5 text-zinc-500 hover:text-red-400" /></Button>
                    )}
                  </div>
                </div>
              ))}
              <div className="pt-3">
                <p className="text-sm font-medium text-zinc-300 mb-2">Invite someone</p>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-500" />
                    <input type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} placeholder="colleague@company.com" className="w-full rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-100 text-sm pl-9 pr-3 py-2.5 focus:outline-none focus:border-green-500 placeholder:text-zinc-500" />
                  </div>
                  <Button size="sm" disabled={!inviteEmail || inviting} loading={inviting} onClick={() => { setInviting(true); setTimeout(() => { setInviting(false); setInviteEmail("") }, 1500) }}>
                    <Plus className="h-4 w-4" />Invite
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {tab === "api-keys" && (
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">API Keys</CardTitle>
              <CardDescription>Use these keys to access Forge from the CLI or your CI/CD pipeline.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {MOCK_API_KEYS.map((apiKey) => (
                <div key={apiKey.id} className="flex items-center justify-between gap-3 py-2.5 border-b border-zinc-800 last:border-0">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-zinc-200">{apiKey.name}</p>
                    <code className="text-xs font-mono text-zinc-400 bg-zinc-800 px-2 py-0.5 rounded mt-1 inline-block">
                      {showKeyId === apiKey.id ? `${apiKey.prefix}•••••••••••••••••••••••••` : `${apiKey.prefix}•••••••••••••••••••••••••`}
                    </code>
                    {apiKey.lastUsedAt && (
                      <p className="text-xs text-zinc-600 mt-1">Last used {formatTimeAgo(apiKey.lastUsedAt)}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <Button variant="ghost" size="icon-sm" onClick={() => setShowKeyId(showKeyId === apiKey.id ? null : apiKey.id)}>
                      {showKeyId === apiKey.id ? <EyeOff className="h-3.5 w-3.5 text-zinc-500" /> : <Eye className="h-3.5 w-3.5 text-zinc-500" />}
                    </Button>
                    <Button variant="ghost" size="icon-sm" onClick={() => handleCopy(apiKey.prefix, apiKey.id)}>
                      {copiedKey === apiKey.id ? <Check className="h-3.5 w-3.5 text-green-400" /> : <Copy className="h-3.5 w-3.5 text-zinc-500" />}
                    </Button>
                    <Button variant="ghost" size="icon-sm"><Trash2 className="h-3.5 w-3.5 text-zinc-500 hover:text-red-400" /></Button>
                  </div>
                </div>
              ))}
              <div className="pt-3">
                <p className="text-sm font-medium text-zinc-300 mb-2">Create new key</p>
                <div className="flex gap-2">
                  <input type="text" value={newKeyName} onChange={(e) => setNewKeyName(e.target.value)} placeholder="e.g. Production CI" className="flex-1 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-100 text-sm px-3 py-2.5 focus:outline-none focus:border-green-500 placeholder:text-zinc-500" />
                  <Button size="sm" disabled={!newKeyName || creatingKey} loading={creatingKey} onClick={() => { setCreatingKey(true); setTimeout(() => { setCreatingKey(false); setNewKeyName("") }, 1500) }}>
                    <Plus className="h-4 w-4" />Create
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {tab === "deployment" && (
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Blocked Deployment Windows</CardTitle>
              <CardDescription>Forge will not deploy to production during these times.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-lg border border-zinc-800 divide-y divide-zinc-800">
                {[
                  { label: "Friday 6pm — Monday 9am", timezone: "UTC", active: true },
                  { label: "Dec 24 — Jan 2", timezone: "UTC", active: true },
                ].map((window, i) => (
                  <div key={i} className="flex items-center justify-between p-3">
                    <div>
                      <p className="text-sm text-zinc-200">{window.label}</p>
                      <p className="text-xs text-zinc-500">{window.timezone}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant={window.active ? "success" : "default"} className="text-xs">{window.active ? "Active" : "Inactive"}</Badge>
                      <Button variant="ghost" size="icon-sm"><Trash2 className="h-3.5 w-3.5 text-zinc-500 hover:text-red-400" /></Button>
                    </div>
                  </div>
                ))}
              </div>
              <Button variant="outline" size="sm"><Plus className="h-4 w-4" />Add blocked window</Button>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Auto-Rollback</CardTitle>
              <CardDescription>If error rates spike after a deployment, should Forge roll back automatically?</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-zinc-200">Roll back if errors spike above 5%</p>
                  <p className="text-xs text-zinc-500 mt-1">Forge will revert to the previous version and notify you.</p>
                </div>
                <div className="h-6 w-11 rounded-full bg-green-500 relative cursor-pointer shrink-0">
                  <div className="absolute right-1 top-1 h-4 w-4 rounded-full bg-white" />
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  )
}
