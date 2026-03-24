import type {
  Approval,
  ActivityItem,
  HealthScore,
  MetricPoint,
  LatencyMetrics,
  Integration,
  ProjectSettings,
  TeamMember,
  ApiKey,
  ApiMetricsResponse,
} from "./types"

/** Base URL pulled from environment — falls back to local dev server */
const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000"

/**
 * Authenticated fetch wrapper for the external orchestrator API.
 * Reads JWT from localStorage (set during onboarding/login).
 */
async function apiFetch<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  // In a real app this would come from a session/auth context
  const token =
    typeof window !== "undefined" ? localStorage.getItem("forge_token") : null

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  })

  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: "Request failed" }))
    throw new Error(
      (error as { message?: string }).message ?? `HTTP ${res.status}`
    )
  }

  return res.json() as Promise<T>
}

/**
 * Internal fetch wrapper for the Next.js API routes at /api/...
 * Credentials are handled server-side via NextAuth sessions (cookies),
 * so no explicit token header is needed from the browser.
 */
async function internalFetch<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  // Use a relative URL so it works in both browser and SSR contexts
  const base =
    typeof window !== "undefined"
      ? ""
      : (process.env.NEXTAUTH_URL ?? "http://localhost:3000")

  const res = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
    // Include cookies for session-based auth
    credentials: "include",
  })

  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: "Request failed" }))
    throw new Error(
      (error as { message?: string }).message ?? `HTTP ${res.status}`
    )
  }

  return res.json() as Promise<T>
}

// ============================================================
// DASHBOARD / HEALTH
// ============================================================

export async function getHealthScore(projectId: string): Promise<HealthScore> {
  return apiFetch<HealthScore>(`/projects/${projectId}/health`)
}

// ============================================================
// APPROVALS
// ============================================================

export async function getApprovals(projectId: string): Promise<Approval[]> {
  return apiFetch<Approval[]>(`/projects/${projectId}/approvals`)
}

export async function approveAction(
  projectId: string,
  approvalId: string
): Promise<{ success: boolean }> {
  return apiFetch(`/projects/${projectId}/approvals/${approvalId}/approve`, {
    method: "POST",
  })
}

export async function rejectAction(
  projectId: string,
  approvalId: string,
  reason?: string
): Promise<{ success: boolean }> {
  return apiFetch(`/projects/${projectId}/approvals/${approvalId}/reject`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  })
}

// ============================================================
// METRICS
// ============================================================

export interface MetricsResponse {
  activeUsers: MetricPoint[]
  newSignups: MetricPoint[]
  revenue: MetricPoint[] | null // null if Stripe not connected
  errorRate: MetricPoint[]
  uptime: number
  latency: LatencyMetrics[]
}

export async function getMetrics(
  projectId: string,
  range: "7d" | "30d" | "90d"
): Promise<MetricsResponse> {
  return apiFetch<MetricsResponse>(
    `/projects/${projectId}/metrics?range=${range}`
  )
}

// ============================================================
// ACTIVITY
// ============================================================

export async function getActivity(
  projectId: string,
  params?: {
    page?: number
    agentType?: string
    actionType?: string
    startDate?: string
    endDate?: string
  }
): Promise<{ items: ActivityItem[]; total: number; hasMore: boolean }> {
  const query = new URLSearchParams()
  if (params?.page) query.set("page", String(params.page))
  if (params?.agentType) query.set("agentType", params.agentType)
  if (params?.actionType) query.set("actionType", params.actionType)
  if (params?.startDate) query.set("startDate", params.startDate)
  if (params?.endDate) query.set("endDate", params.endDate)

  return apiFetch(`/projects/${projectId}/activity?${query.toString()}`)
}

// ============================================================
// INTEGRATIONS
// ============================================================

export async function getIntegrations(
  projectId: string
): Promise<Integration[]> {
  return apiFetch<Integration[]>(`/projects/${projectId}/integrations`)
}

export async function connectIntegration(
  projectId: string,
  type: string,
  config: Record<string, string>
): Promise<Integration> {
  return apiFetch<Integration>(`/projects/${projectId}/integrations`, {
    method: "POST",
    body: JSON.stringify({ type, config }),
  })
}

export async function disconnectIntegration(
  projectId: string,
  integrationId: string
): Promise<{ success: boolean }> {
  return apiFetch(`/projects/${projectId}/integrations/${integrationId}`, {
    method: "DELETE",
  })
}

// ============================================================
// SETTINGS
// ============================================================

export async function getSettings(
  projectId: string
): Promise<ProjectSettings> {
  return apiFetch<ProjectSettings>(`/projects/${projectId}/settings`)
}

export async function updateSettings(
  projectId: string,
  updates: Partial<ProjectSettings>
): Promise<ProjectSettings> {
  return apiFetch<ProjectSettings>(`/projects/${projectId}/settings`, {
    method: "PATCH",
    body: JSON.stringify(updates),
  })
}

export async function getTeamMembers(
  projectId: string
): Promise<TeamMember[]> {
  return apiFetch<TeamMember[]>(`/projects/${projectId}/team`)
}

export async function inviteTeamMember(
  projectId: string,
  email: string,
  role: "admin" | "viewer"
): Promise<TeamMember> {
  return apiFetch<TeamMember>(`/projects/${projectId}/team/invite`, {
    method: "POST",
    body: JSON.stringify({ email, role }),
  })
}

export async function getApiKeys(projectId: string): Promise<ApiKey[]> {
  return apiFetch<ApiKey[]>(`/projects/${projectId}/api-keys`)
}

export async function createApiKey(
  projectId: string,
  name: string
): Promise<ApiKey & { secret: string }> {
  return apiFetch(`/projects/${projectId}/api-keys`, {
    method: "POST",
    body: JSON.stringify({ name }),
  })
}

export async function revokeApiKey(
  projectId: string,
  keyId: string
): Promise<{ success: boolean }> {
  return apiFetch(`/projects/${projectId}/api-keys/${keyId}`, {
    method: "DELETE",
  })
}

// ============================================================
// INTERNAL NEXT.JS API ROUTES (real Prisma queries)
// ============================================================

/** Shape returned by GET /api/projects/[id]/health */
export interface HealthRouteResponse {
  score: number
  grade: string
  uptime: number
  errorRate: number
  securityScore: number
  debtScore: number
  openIncidents: number
  criticalIncidents: number
}

/** Shape returned by GET /api/projects/[id]/metrics */
export interface MetricsRouteResponse {
  snapshots: ApiMetricsResponse[]
  latest: ApiMetricsResponse | null
}

/** Shape returned by GET /api/projects/[id]/activity */
export interface ActivityRouteResponse {
  tasks: {
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
  }[]
  total: number
  page: number
  pages: number
}

/**
 * Fetch all approvals for a project from the internal Next.js API route.
 * @param projectId - UUID of the project
 * @param status    - Optional status filter: 'pending' | 'approved' | 'rejected'
 */
export async function fetchApprovals(
  projectId: string,
  status?: "pending" | "approved" | "rejected"
): Promise<{ approvals: Approval[] }> {
  const query = status ? `?status=${status}` : ""
  return internalFetch<{ approvals: Approval[] }>(
    `/api/projects/${projectId}/approvals${query}`
  )
}

/**
 * Approve an approval request via the internal Next.js API route.
 */
export async function approveRequest(
  projectId: string,
  approvalId: string
): Promise<{ approval: Approval }> {
  return internalFetch<{ approval: Approval }>(
    `/api/projects/${projectId}/approvals/${approvalId}/approve`,
    { method: "POST" }
  )
}

/**
 * Reject an approval request via the internal Next.js API route.
 */
export async function rejectRequest(
  projectId: string,
  approvalId: string,
  reason: string
): Promise<{ approval: Approval }> {
  return internalFetch<{ approval: Approval }>(
    `/api/projects/${projectId}/approvals/${approvalId}/reject`,
    {
      method: "POST",
      body: JSON.stringify({ reason }),
    }
  )
}

/**
 * Fetch metrics snapshots for a project from the internal Next.js API route.
 * @param projectId - UUID of the project
 * @param range     - Time window: '7d' | '30d' | '90d' (defaults to '30d')
 */
export async function fetchMetrics(
  projectId: string,
  range?: "7d" | "30d" | "90d"
): Promise<MetricsRouteResponse> {
  const query = range ? `?range=${range}` : ""
  return internalFetch<MetricsRouteResponse>(
    `/api/projects/${projectId}/metrics${query}`
  )
}

/**
 * Fetch agent task activity for a project from the internal Next.js API route.
 */
export async function fetchActivity(
  projectId: string,
  params?: {
    page?: number
    limit?: number
    agentType?: string
  }
): Promise<ActivityRouteResponse> {
  const query = new URLSearchParams()
  if (params?.page) query.set("page", String(params.page))
  if (params?.limit) query.set("limit", String(params.limit))
  if (params?.agentType) query.set("agentType", params.agentType)
  const qs = query.toString()
  return internalFetch<ActivityRouteResponse>(
    `/api/projects/${projectId}/activity${qs ? `?${qs}` : ""}`
  )
}

/**
 * Fetch the computed health score for a project from the internal Next.js API route.
 */
export async function fetchHealth(
  projectId: string
): Promise<HealthRouteResponse> {
  return internalFetch<HealthRouteResponse>(
    `/api/projects/${projectId}/health`
  )
}

/**
 * Fetch all integrations for a project from the internal Next.js API route.
 */
export async function fetchIntegrations(
  projectId: string
): Promise<{ integrations: Integration[] }> {
  return internalFetch<{ integrations: Integration[] }>(
    `/api/projects/${projectId}/integrations`
  )
}
