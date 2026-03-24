/**
 * @forge/shared — Core TypeScript types
 *
 * These types are the canonical source of truth for all cross-package
 * communication in the Forge platform. Always use these instead of
 * duplicating definitions in individual packages.
 */

import { z } from 'zod'

// =============================================================================
// AGENT TASK
// =============================================================================

export const TaskTypeSchema = z.enum([
  'build_feature',
  'fix_bug',
  'fix_incident',
  'security_patch',
  'dependency_update',
  'refactor',
  'generate_tests',
  'review_pr',
  'deploy',
  'rollback',
  'onboard_project',
  'onboard_developer',
  'analyze_logs',
  'classify_alert',
  'translate_intent',
  'update_debt_ledger',
  'generate_postmortem',
  'cost_analysis',
])
export type TaskType = z.infer<typeof TaskTypeSchema>

export const TaskPrioritySchema = z.enum(['critical', 'high', 'normal', 'low'])
export type TaskPriority = z.infer<typeof TaskPrioritySchema>

export const AutonomyLevelSchema = z.enum(['suggest', 'semi', 'autonomous'])
export type AutonomyLevel = z.infer<typeof AutonomyLevelSchema>

export const AgentTypeSchema = z.enum([
  'builder',
  'watcher',
  'fixer',
  'security',
  'devops',
  'intent',
  'debt',
  'onboarding',
  'orchestrator',
])
export type AgentType = z.infer<typeof AgentTypeSchema>

export const RequestedBySchema = z.enum(['system', 'founder', 'developer', 'webhook'])
export type RequestedBy = z.infer<typeof RequestedBySchema>

export const AgentTaskSchema = z.object({
  id: z.string().uuid(),
  type: TaskTypeSchema,
  priority: TaskPrioritySchema,
  projectId: z.string().uuid(),
  organizationId: z.string().uuid(),
  payload: z.record(z.unknown()),
  contextSnapshot: z.custom<CodebaseContext>().optional(),
  requestedBy: RequestedBySchema,
  requestedByUserId: z.string().uuid().optional(),
  autonomyLevel: AutonomyLevelSchema,
  createdAt: z.date(),
})
export type AgentTask = z.infer<typeof AgentTaskSchema>

// =============================================================================
// CODEBASE CONTEXT
// =============================================================================

export interface TechStackSnapshot {
  language: string
  framework: string
  database?: string
  hosting?: string
  testFramework?: string
  packageManager?: string
  additionalTools?: string[]
}

export interface ModuleNode {
  path: string
  plainEnglishDescription: string
  lastModified: Date
  lastModifiedBy: string
  incidentCount: number
  testCoverage: number
  complexityScore: number
  embeddingId?: string
}

export interface DependencyEdge {
  from: string
  to: string
  type: 'import' | 'extends' | 'implements'
}

export interface ChangeEvent {
  timestamp: Date
  prNumber?: number
  prUrl?: string
  summary: string
  filesChanged: string[]
  authorName: string
}

export interface IncidentRecord {
  id: string
  title: string
  severity: 'critical' | 'high' | 'medium' | 'low'
  resolvedAt?: Date
  affectedModules: string[]
}

export interface DebtItem {
  id: string
  type: 'code_quality' | 'missing_tests' | 'security' | 'dependency' | 'architecture' | 'documentation'
  severity: 'low' | 'medium' | 'high' | 'critical'
  filePath: string
  plainEnglishDescription: string
  estimatedHours: number
  businessRisk: string
}

export interface TeamMember {
  name: string
  role: string
  githubHandle?: string
}

export interface ArchitectureDecisionRecord {
  id: string
  title: string
  status: 'proposed' | 'accepted' | 'deprecated' | 'superseded'
  decision: string
  consequences: string
  createdAt: Date
}

export interface CodebaseContext {
  projectId: string
  lastUpdated: Date
  modules: ModuleNode[]
  dependencies: DependencyEdge[]
  recentChanges: ChangeEvent[]
  incidentHistory: IncidentRecord[]
  debtItems: DebtItem[]
  techStack: TechStackSnapshot
  teamMembers: TeamMember[]
  adrs: ArchitectureDecisionRecord[]
}

// =============================================================================
// CONFIDENCE ENGINE
// =============================================================================

export type ConfidenceRecommendation = 'auto_deploy' | 'recommend' | 'hold' | 'block'

export interface ConfidenceScoreBreakdown {
  testCoverage: number      // 0-20
  moduleStability: number   // 0-15
  ciPassing: number         // 0-20
  stagingStability: number  // 0-20
  securityClean: number     // 0-15
  deployTiming: number      // 0-10
}

export interface ConfidenceScore {
  total: number
  breakdown: ConfidenceScoreBreakdown
  recommendation: ConfidenceRecommendation
  humanReadableSummary: string
  riskFactors: string[]
}

// =============================================================================
// APPROVAL GATEWAY
// =============================================================================

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired'
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical'

export interface ApprovalRequest {
  id: string
  projectId: string
  organizationId: string
  agentType: AgentType
  taskId: string
  title: string
  businessImpact: string
  technicalDetails: string
  confidenceScore: ConfidenceScore
  riskLevel: RiskLevel
  expiresAt: Date
  notificationsSent: NotificationChannel[]
  status: ApprovalStatus
  approvedById?: string
  approvedAt?: Date
  rejectionReason?: string
  approveToken: string
  rejectToken: string
}

export type NotificationChannel = 'slack' | 'telegram' | 'email' | 'dashboard'

export interface ApprovalNotification {
  summary: string
  businessImpact: string
  riskLevel: RiskLevel
  confidenceScore: number
  previewUrl?: string
  approveToken: string
  rejectToken: string
  expiresAt: Date
  approvalId: string
  projectName: string
}

// =============================================================================
// INCIDENT & LOG EVENTS
// =============================================================================

export type IncidentSeverity = 'critical' | 'high' | 'medium' | 'low'
export type LogClassification = 'noise' | 'warning' | 'incident' | 'critical'

export interface LogEvent {
  id: string
  projectId: string
  source: string         // adapter name
  timestamp: Date
  level: string          // error | warn | info | debug
  message: string
  metadata: Record<string, unknown>
  fingerprint?: string   // normalized signature for dedup
}

export interface EnrichedLogEvent extends LogEvent {
  classification: LogClassification
  affectedModule?: string
  recentDeployId?: string
  userImpactEstimate?: number
  correlatedEvents?: string[]
}

// =============================================================================
// DEPLOYMENT
// =============================================================================

export type DeployEnvironment = 'preview' | 'staging' | 'production'
export type DeployStatus = 'pending' | 'in_progress' | 'succeeded' | 'failed' | 'rolled_back'

export interface DeploymentRecord {
  id: string
  projectId: string
  environment: DeployEnvironment
  status: DeployStatus
  provider: string
  commitSha?: string
  commitMessage?: string
  url?: string
  startedAt: Date
  completedAt?: Date
}

// =============================================================================
// SECURITY
// =============================================================================

export interface SecurityScore {
  total: number
  breakdown: {
    criticalVulnerabilities: number
    highVulnerabilities: number
    mediumVulnerabilities: number
    secretsExposed: number
    outdatedDependencies: number
    lastScanAge: number
    sastFindings: number
  }
  trend: 'improving' | 'stable' | 'degrading'
  lastUpdated: Date
}

export interface Vulnerability {
  id: string
  severity: 'critical' | 'high' | 'medium' | 'low'
  packageName: string
  installedVersion: string
  fixedVersion?: string
  cveId?: string
  description: string
  advisory?: string
}

// =============================================================================
// METRICS
// =============================================================================

export interface TimeSeriesPoint {
  timestamp: Date
  value: number
}

export type TimeSeriesMetric = TimeSeriesPoint[]

export interface ProjectMetrics {
  // Business
  activeUsers?: TimeSeriesMetric
  newSignups?: TimeSeriesMetric
  revenue?: TimeSeriesMetric
  featureUsage?: Record<string, TimeSeriesMetric>

  // Technical
  errorRate?: TimeSeriesMetric
  p50Latency?: TimeSeriesMetric
  p95Latency?: TimeSeriesMetric
  p99Latency?: TimeSeriesMetric
  uptime?: TimeSeriesMetric
  deploymentFrequency?: TimeSeriesMetric
  meanTimeToRecovery?: TimeSeriesMetric

  // Code health
  testCoverage?: TimeSeriesMetric
  securityScore?: TimeSeriesMetric
  debtScore?: TimeSeriesMetric
  openPRs?: number
  stalePRs?: number
}

// =============================================================================
// FIX PATTERNS
// =============================================================================

export interface FixPattern {
  id: string
  projectId: string
  errorFingerprint: string
  errorDescription: string
  fixApplied: string
  filesChanged: string[]
  successCount: number
  failureCount: number
  lastApplied?: Date
  avgTimeToFixSec?: number
}

// =============================================================================
// NOTIFICATION CONFIG
// =============================================================================

export type EventType =
  | 'incident_created'
  | 'incident_resolved'
  | 'approval_required'
  | 'approval_expired'
  | 'deploy_started'
  | 'deploy_completed'
  | 'deploy_failed'
  | 'security_alert'
  | 'debt_sprint_proposal'
  | 'cost_spike'
  | 'agent_task_completed'
  | 'daily_digest'

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info'

export interface TimeWindow {
  dayOfWeek?: number[] // 0=Sun, 6=Sat
  startHour: number    // 0-23 UTC
  endHour: number
}

export interface EscalationConfig {
  afterMinutes: number
  escalateTo: NotificationChannel[]
}

export interface NotificationRule {
  eventType: EventType
  minSeverity: Severity
  channels: NotificationChannel[]
  schedule?: TimeWindow
  escalation?: EscalationConfig
}

export interface NotificationConfig {
  channels: NotificationChannel[]
  rules: NotificationRule[]
  slackChannelId?: string
  slackWorkspaceId?: string
  telegramChatId?: string
  emailRecipients?: string[]
}

// =============================================================================
// COST TRACKING
// =============================================================================

export interface CostAnomaly {
  category: string
  previousAmount: number
  currentAmount: number
  changePercent: number
  explanation: string
}

export interface CostRecord {
  projectId: string
  period: Date
  breakdown: {
    hosting: number
    aiApiCalls: number
    database: number
    storage: number
    monitoring: number
    thirdPartyServices: number
  }
  total: number
  projectedMonthly: number
  anomalies: CostAnomaly[]
}

// =============================================================================
// INTENT PARSING
// =============================================================================

export type IntentType =
  | 'bug_report'
  | 'feature_request'
  | 'status_query'
  | 'approval'
  | 'question'
  | 'escalation'
  | 'general_chat'

export interface ParsedIntent {
  raw: string
  intentType: IntentType
  confidence: number
  entities: {
    affectedFeature?: string
    errorMessage?: string
    urgency?: 'low' | 'medium' | 'high' | 'critical'
    targetEnvironment?: string
  }
  requiresClarification: boolean
  clarificationQuestion?: string
  generatedTask?: Partial<AgentTask>
}

// =============================================================================
// EVENT BUS EVENTS
// =============================================================================

export type ForgeEventType =
  | 'task.created'
  | 'task.started'
  | 'task.completed'
  | 'task.failed'
  | 'approval.created'
  | 'approval.resolved'
  | 'incident.detected'
  | 'incident.resolved'
  | 'deploy.triggered'
  | 'deploy.completed'
  | 'security.alert'
  | 'log.classified'
  | 'metrics.updated'
  | 'debt.updated'

export interface ForgeEvent<T = unknown> {
  id: string
  type: ForgeEventType
  projectId: string
  organizationId: string
  payload: T
  timestamp: Date
  sourceAgent?: AgentType
}
