/**
 * Mock data for development — replace with real API calls in production.
 * All data uses plain English as founders will see it.
 */
import type {
  Approval,
  ActivityItem,
  HealthScore,
  Incident,
  Integration,
} from "./types"
import type { MetricsResponse } from "./api"

export const MOCK_HEALTH: HealthScore = {
  overall: 87,
  trend: 3,
  uptime: 99.7,
  errorRate: 0.8,
  securityScore: 82,
  debtScore: 71,
  deploymentFrequency: 4.2,
}

export const MOCK_INCIDENT: Incident = {
  id: "inc_001",
  title: "Login page responding slowly",
  status: "investigating",
  affectedUsers: 142,
  totalUsers: 1840,
  description:
    "Users are experiencing slow login times (average 8 seconds instead of the normal 0.4 seconds). The issue started 23 minutes ago.",
  whatForgeIsDoing:
    "I am analyzing database query performance and checking for lock contention. I have identified a slow query and am preparing a fix.",
  startedAt: new Date(Date.now() - 23 * 60 * 1000).toISOString(),
  severity: "high",
}

export const MOCK_APPROVALS: Approval[] = [
  {
    id: "apr_001",
    title: "Fix password reset email not sending",
    agentType: "bug_fixer",
    businessImpact:
      "12 users have been unable to reset their passwords in the last 24 hours. Fixing this will unblock these users immediately.",
    technicalSummary: "SMTP retry logic was missing exponential backoff.",
    riskLevel: "low",
    confidenceScore: 94,
    riskFactors: [
      "Email delivery relies on third-party SMTP provider",
      "Change affects authentication flow",
    ],
    expiresAt: new Date(Date.now() + 45 * 60 * 1000).toISOString(),
    status: "pending",
    previewUrl: "https://preview-abc123.vercel.app",
    prUrl: "https://github.com/yourco/app/pull/142",
    createdAt: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
  },
  {
    id: "apr_002",
    title: "Upgrade payment library to fix security vulnerability",
    agentType: "security_guard",
    businessImpact:
      "A known vulnerability in the current payment library could allow attackers to read card metadata. Upgrading eliminates this risk.",
    technicalSummary: "stripe-js v2.1.0 → v2.4.1 patches CVE-2024-1234.",
    riskLevel: "medium",
    confidenceScore: 78,
    riskFactors: [
      "Payment library changes require careful testing",
      "API interface changes in v2.3.0 need verification",
      "Stripe webhook signatures must be re-validated",
    ],
    expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    status: "pending",
    prUrl: "https://github.com/yourco/app/pull/143",
    createdAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
  },
  {
    id: "apr_003",
    title: "Deploy dashboard performance improvements",
    agentType: "performance_optimizer",
    businessImpact:
      "Dashboard loads 3x faster. Users who currently bounce after slow loads (about 8% of visits) are likely to stay.",
    technicalSummary:
      "Added query result caching, reduced N+1 queries, lazy-loaded heavy components.",
    riskLevel: "low",
    confidenceScore: 91,
    riskFactors: [
      "Cache invalidation logic is new code",
      "Memory usage may increase by ~50MB on server",
    ],
    expiresAt: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
    status: "pending",
    previewUrl: "https://preview-perf-xyz.vercel.app",
    prUrl: "https://github.com/yourco/app/pull/144",
    createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  },
]

export const MOCK_ACTIVITY: ActivityItem[] = [
  {
    id: "act_001",
    agentType: "bug_fixer",
    description:
      "Fixed a crash that was affecting 8% of users trying to upload profile photos. The issue was a missing file size check.",
    timestamp: new Date(Date.now() - 12 * 60 * 1000).toISOString(),
    prUrl: "https://github.com/yourco/app/pull/141",
    actionType: "fix",
  },
  {
    id: "act_002",
    agentType: "monitor",
    description:
      "Detected a spike in error rates (2.1% → 8.4%) at 2:14 AM. Woke up the bug fixer agent.",
    timestamp: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
    actionType: "alert",
  },
  {
    id: "act_003",
    agentType: "deployment_manager",
    description:
      "Deployed version 1.4.7 to production. All health checks passed. Zero downtime.",
    timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    actionType: "deploy",
  },
  {
    id: "act_004",
    agentType: "security_guard",
    description:
      "Rotated API keys that had not been used in 90+ days. 3 keys revoked, no active integrations affected.",
    timestamp: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
    actionType: "update",
  },
  {
    id: "act_005",
    agentType: "performance_optimizer",
    description:
      "Reduced average page load time from 2.4 seconds to 0.8 seconds by optimizing database queries on the reports page.",
    timestamp: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
    prUrl: "https://github.com/yourco/app/pull/139",
    actionType: "optimize",
  },
  {
    id: "act_006",
    agentType: "code_reviewer",
    description:
      "Reviewed 3 pull requests from your team. Left 7 suggestions, 2 blocking issues fixed before merge.",
    timestamp: new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString(),
    actionType: "review",
  },
]

// Generate metric data points for charts
function generateMetricPoints(
  days: number,
  base: number,
  variance: number
): Array<{ date: string; value: number }> {
  return Array.from({ length: days }, (_, i) => ({
    date: new Date(Date.now() - (days - i - 1) * 24 * 60 * 60 * 1000).toISOString(),
    value: Math.max(0, base + (Math.random() - 0.5) * variance),
  }))
}

export const MOCK_METRICS: MetricsResponse = {
  activeUsers: generateMetricPoints(30, 1200, 300),
  newSignups: generateMetricPoints(30, 42, 20),
  revenue: generateMetricPoints(30, 8400, 2000),
  errorRate: generateMetricPoints(30, 0.8, 0.6),
  uptime: 99.72,
  latency: Array.from({ length: 30 }, (_, i) => ({
    date: new Date(Date.now() - (30 - i - 1) * 24 * 60 * 60 * 1000).toISOString(),
    p50: 120 + (Math.random() - 0.5) * 40,
    p95: 280 + (Math.random() - 0.5) * 80,
    p99: 520 + (Math.random() - 0.5) * 160,
  })),
}

export const MOCK_INTEGRATIONS: Integration[] = [
  {
    id: "int_github",
    name: "GitHub",
    type: "github",
    status: "connected",
    connectedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    metadata: { repo: "yourco/app", branch: "main" },
  },
  {
    id: "int_vercel",
    name: "Vercel",
    type: "vercel",
    status: "connected",
    connectedAt: new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString(),
    metadata: { project: "your-app" },
  },
  {
    id: "int_posthog",
    name: "PostHog",
    type: "posthog",
    status: "connected",
    connectedAt: new Date(Date.now() - 25 * 24 * 60 * 60 * 1000).toISOString(),
  },
  {
    id: "int_sentry",
    name: "Sentry",
    type: "sentry",
    status: "needs_attention",
    connectedAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString(),
    metadata: { issue: "Token expired" },
  },
  {
    id: "int_slack",
    name: "Slack",
    type: "slack",
    status: "connected",
    connectedAt: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString(),
    metadata: { channel: "#forge-alerts" },
  },
  {
    id: "int_stripe",
    name: "Stripe",
    type: "stripe",
    status: "disconnected",
  },
  {
    id: "int_telegram",
    name: "Telegram",
    type: "telegram",
    status: "disconnected",
  },
  {
    id: "int_datadog",
    name: "Datadog",
    type: "datadog",
    status: "disconnected",
  },
]

// Generate uptime heatmap data (last 90 days)
export const MOCK_UPTIME_HEATMAP = Array.from({ length: 90 }, (_, i) => ({
  date: new Date(Date.now() - (90 - i - 1) * 24 * 60 * 60 * 1000).toISOString(),
  uptime: i === 23 || i === 51 ? 94.2 : i === 67 ? 87.1 : 99.8 + Math.random() * 0.2,
}))
