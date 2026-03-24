/**
 * api.ts
 *
 * Typed axios wrapper for the Forge API.
 * All outgoing requests are authenticated via the Bearer token stored in the
 * CLI config.  Error responses are converted into human-readable messages by
 * `handleApiError` (imported from utils.ts).
 */

import axios, { type AxiosInstance, type AxiosError } from 'axios'
import { getConfig } from './config.js'
import { handleApiError } from './utils.js'

// ---------------------------------------------------------------------------
// Response shape types
// ---------------------------------------------------------------------------

/** Health/ready response from GET /health/ready */
export interface HealthResponse {
  status: 'ok' | 'degraded' | 'error'
  uptime: number
  timestamp: string
}

/** A single agent status entry returned by the status endpoint. */
export interface AgentStatus {
  name: string
  status: 'running' | 'stopped' | 'error'
  lastActive: string
  details?: string
}

/** A single log entry returned by the logs endpoint. */
export interface LogEntry {
  timestamp: string
  agent: string
  message: string
  level: 'info' | 'warn' | 'error' | 'debug'
}

/** Response returned when a deployment is triggered. */
export interface DeployResponse {
  deploymentId: string
  status: 'queued' | 'in_progress' | 'success' | 'failed'
  url?: string
  message: string
}

/** Response returned when an approval is processed. */
export interface ApprovalResponse {
  approvalId: string
  status: 'approved' | 'rejected'
  processedAt: string
  message: string
}

// ---------------------------------------------------------------------------
// Query-param types
// ---------------------------------------------------------------------------

export interface LogsQuery {
  agent?: string | undefined
  tail?: number | undefined
}

export interface DeployOptions {
  env: 'staging' | 'production'
}

export interface ApprovalOptions {
  reason: string
}

// ---------------------------------------------------------------------------
// Internal factory — builds a fresh axios instance on every call so that
// config changes (e.g. setting the API URL) are always reflected.
// ---------------------------------------------------------------------------

function buildClient(): AxiosInstance {
  const { apiUrl, authToken } = getConfig()

  return axios.create({
    baseURL: apiUrl,
    timeout: 15_000,
    headers: {
      'Content-Type': 'application/json',
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    },
  })
}

// ---------------------------------------------------------------------------
// Public API functions
// ---------------------------------------------------------------------------

/**
 * Fetches the health/ready status of the Forge API and all running agents.
 * Maps the raw response into a typed AgentStatus array for display.
 *
 * @returns Array of agent statuses, or throws on network/auth failure.
 */
export async function getStatus(): Promise<AgentStatus[]> {
  const client = buildClient()

  try {
    // Primary health check — verifies the API is reachable
    await client.get<HealthResponse>('/health/ready')

    // Fetch per-agent statuses if the endpoint exists
    const { data } = await client.get<{ agents: AgentStatus[] }>('/api/agents/status')
    return data.agents
  } catch (err) {
    // Re-throw with a friendly message so the caller can display it
    throw new Error(handleApiError(err as AxiosError | Error))
  }
}

/**
 * Retrieves recent log entries from the Forge API.
 *
 * @param query - Optional filters: agent name and number of tail entries.
 * @returns Array of log entries.
 */
export async function getLogs(query: LogsQuery = {}): Promise<LogEntry[]> {
  const client = buildClient()

  const params: Record<string, string> = {}
  if (query.agent) params['agent'] = query.agent
  if (query.tail !== undefined) params['tail'] = String(query.tail)

  try {
    const { data } = await client.get<{ logs: LogEntry[] }>('/api/logs', { params })
    return data.logs
  } catch (err) {
    throw new Error(handleApiError(err as AxiosError | Error))
  }
}

/**
 * Triggers a deployment via the Forge API.
 *
 * @param options - Deployment options (env: staging | production).
 * @returns DeployResponse with deployment ID and a final URL on success.
 */
export async function triggerDeploy(options: DeployOptions): Promise<DeployResponse> {
  const client = buildClient()

  try {
    const { data } = await client.post<DeployResponse>('/api/deploy', {
      environment: options.env,
    })
    return data
  } catch (err) {
    throw new Error(handleApiError(err as AxiosError | Error))
  }
}

/**
 * Processes a pending approval request.
 *
 * @param approvalId - The ID of the approval to process.
 * @param options    - Must include a human-readable reason for the decision.
 * @returns ApprovalResponse confirming the outcome.
 */
export async function processApproval(
  approvalId: string,
  options: ApprovalOptions,
): Promise<ApprovalResponse> {
  const client = buildClient()

  try {
    const { data } = await client.post<ApprovalResponse>(
      `/api/approvals/${approvalId}/approve`,
      { reason: options.reason },
    )
    return data
  } catch (err) {
    throw new Error(handleApiError(err as AxiosError | Error))
  }
}
