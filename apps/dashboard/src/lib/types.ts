/**
 * Forge API types — shared across all API calls.
 * Business-friendly naming: no raw technical codes exposed to founder UI.
 */

export type RiskLevel = "critical" | "high" | "medium" | "low"
export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired"
export type IncidentStatus = "active" | "investigating" | "resolved"
export type IntegrationStatus = "connected" | "needs_attention" | "disconnected"
export type AutonomyLevel = "full" | "balanced" | "supervised"

export interface Approval {
  id: string
  title: string
  agentType: string
  businessImpact: string
  technicalSummary: string
  riskLevel: RiskLevel
  confidenceScore: number
  riskFactors: string[]
  expiresAt: string
  status: ApprovalStatus
  previewUrl?: string
  prUrl?: string
  createdAt: string
  resolvedAt?: string
}

export interface Incident {
  id: string
  title: string
  status: IncidentStatus
  affectedUsers: number
  totalUsers: number
  description: string // Plain English: what happened
  whatForgeIsDoing: string // Plain English: what the AI is doing about it
  startedAt: string
  resolvedAt?: string
  severity: RiskLevel
}

export interface ActivityItem {
  id: string
  agentType: string
  description: string // Plain English
  timestamp: string
  prUrl?: string
  incidentId?: string
  actionType: "fix" | "deploy" | "monitor" | "review" | "update" | "alert" | "optimize"
}

export interface HealthScore {
  overall: number
  trend: number // +/- change
  uptime: number
  errorRate: number
  securityScore: number
  debtScore: number
  deploymentFrequency: number
}

export interface MetricPoint {
  date: string
  value: number
}

export interface LatencyMetrics {
  date: string
  p50: number
  p95: number
  p99: number
}

export interface Integration {
  id: string
  name: string
  type: string
  status: IntegrationStatus
  connectedAt?: string
  metadata?: Record<string, string>
}

export interface ProjectSettings {
  id: string
  name: string
  description: string
  autonomyLevel: AutonomyLevel
  slackWebhook?: string
  telegramChatId?: string
  blockedTimeWindows: Array<{ start: string; end: string; timezone: string }>
  autoRollback: boolean
}

export interface TeamMember {
  id: string
  name: string
  email: string
  role: "owner" | "admin" | "viewer"
  avatarUrl?: string
  joinedAt: string
}

export interface ApiKey {
  id: string
  name: string
  prefix: string // Only first 8 chars shown after creation
  createdAt: string
  lastUsedAt?: string
}

// ---------------------------------------------------------------------------
// API Response types (match the orchestrator REST API shapes)
// ---------------------------------------------------------------------------

export interface ApiHealthResponse {
  score: number
  uptime: number
  errorRate: number
  p95Latency: number
  pendingApprovals: number
  activeIncidents: number
  openPRs: number
  securityScore: number
  debtScore: number
}

export interface ApiMetricsResponse {
  id: string
  projectId: string
  capturedAt: string
  activeUsers: number | null
  newSignups: number | null
  revenue: number | null
  errorRate: number | null
  p50Latency: number | null
  p95Latency: number | null
  p99Latency: number | null
  uptimePercent: number | null
  testCoverage: number | null
  securityScore: number | null
  debtScore: number | null
  openPrs: number | null
}

export interface ApiDebtResponse {
  id: string
  projectId: string
  type: string
  severity: string
  filePath: string
  plainEnglishDescription: string
  technicalDescription: string
  estimatedHours: number
  businessRisk: string
  detectedAt: string
  resolvedAt: string | null
}

export interface ApiIncidentResponse {
  id: string
  projectId: string
  title: string
  description: string
  severity: string
  status: string
  affectedModules: string[]
  affectedUsers: number | null
  detectedAt: string
  resolvedAt: string | null
  postmortemUrl: string | null
}

export interface ApiActivityResponse {
  id: string
  projectId: string
  type: string
  agentType: string
  status: string
  payload: Record<string, unknown>
  prUrl: string | null
  prNumber: number | null
  createdAt: string
  completedAt: string | null
  durationMs: number | null
}

export interface ApiApprovalResponse {
  id: string
  projectId: string
  taskId: string
  agentType: string
  title: string
  businessImpact: string
  technicalDetails: string
  confidenceScore: {
    total: number
    breakdown: Record<string, number>
    recommendation: string
    humanReadableSummary: string
    riskFactors: string[]
  }
  riskLevel: string
  status: string
  expiresAt: string
  approveToken: string
  rejectToken: string
  task: {
    type: string
    priority: string
  }
}
