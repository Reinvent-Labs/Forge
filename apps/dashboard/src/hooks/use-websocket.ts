"use client"

import { useEffect, useRef, useState, useCallback } from "react"
import { useSession } from "next-auth/react"

/**
 * WebSocket event types that can be received from the server.
 */
export type WebSocketEventType =
  | "approval.created"
  | "approval.approved"
  | "approval.rejected"
  | "task.completed"
  | "task.failed"
  | "incident.detected"
  | "incident.resolved"
  | "activity.new"
  | "health.updated"
  | "connection.established"
  | "connection.error"

/**
 * Structure of events received from the WebSocket server.
 */
export interface WebSocketEvent<T = unknown> {
  type: WebSocketEventType
  id: string
  timestamp: string
  projectId: string
  organizationId: string
  payload: T
}

/**
 * Hook options for useWebSocket.
 */
interface UseWebSocketOptions {
  projectId?: string | undefined
  organizationId?: string | undefined
  onEvent?: (event: WebSocketEvent) => void
  onConnect?: () => void
  onDisconnect?: () => void
  onError?: (error: Event) => void
  reconnect?: boolean
  reconnectInterval?: number
  maxReconnectAttempts?: number
}

/**
 * useWebSocket — Real-time connection to Forge orchestrator.
 *
 * Provides live updates for approvals, tasks, incidents, and activity.
 * Auto-reconnects with exponential backoff.
 *
 * @example
 * const { connected, send, lastEvent } = useWebSocket({
 *   projectId: "proj_123",
 *   onEvent: (event) => console.log("New event:", event.type),
 * })
 */
export function useWebSocket(options: UseWebSocketOptions) {
  const { data: session } = useSession()
  const [connected, setConnected] = useState(false)
  const [lastEvent, setLastEvent] = useState<WebSocketEvent | null>(null)
  const [reconnectAttempt, setReconnectAttempt] = useState(0)
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  const {
    projectId,
    organizationId,
    onEvent,
    onConnect,
    onDisconnect,
    onError,
    reconnect = true,
    reconnectInterval = 3000,
    maxReconnectAttempts = 5,
  } = options

  /**
   * Get the WebSocket URL with authentication.
   */
  const getWsUrl = useCallback(() => {
    const baseUrl = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:4001"
    const token = (session as { accessToken?: string })?.accessToken ?? session?.user?.id ?? ""
    const params = new URLSearchParams()
    if (token) params.set("token", token)
    if (projectId) params.set("projectId", projectId)
    if (organizationId) params.set("organizationId", organizationId)
    return `${baseUrl}?${params.toString()}`
  }, [session, projectId, organizationId])

  /**
   * Connect to the WebSocket server.
   */
  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return

    try {
      const wsUrl = getWsUrl()
      const ws = new WebSocket(wsUrl)

      ws.onopen = () => {
        setConnected(true)
        setReconnectAttempt(0)
        onConnect?.()

        // Subscribe to project room if specified
        if (projectId) {
          ws.send(
            JSON.stringify({
              type: "subscribe",
              room: `project:${projectId}`,
            })
          )
        }
      }

      ws.onmessage = (message) => {
        try {
          const event = JSON.parse(message.data) as WebSocketEvent
          setLastEvent(event)
          onEvent?.(event)
        } catch (err) {
          console.error("Failed to parse WebSocket message:", err)
        }
      }

      ws.onclose = () => {
        setConnected(false)
        onDisconnect?.()

        // Auto-reconnect if enabled
        if (reconnect && reconnectAttempt < maxReconnectAttempts) {
          const delay = reconnectInterval * Math.pow(2, reconnectAttempt)
          reconnectTimeoutRef.current = setTimeout(() => {
            setReconnectAttempt((prev) => prev + 1)
            connect()
          }, delay)
        }
      }

      ws.onerror = (error) => {
        console.error("WebSocket error:", error)
        onError?.(error)
      }

      wsRef.current = ws
    } catch (err) {
      console.error("Failed to create WebSocket connection:", err)
    }
  }, [getWsUrl, projectId, reconnect, reconnectInterval, maxReconnectAttempts, reconnectAttempt, onConnect, onDisconnect, onError, onEvent])

  /**
   * Disconnect from the WebSocket server.
   */
  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current)
      reconnectTimeoutRef.current = null
    }
    if (wsRef.current) {
      wsRef.current.close()
      wsRef.current = null
    }
    setConnected(false)
  }, [])

  /**
   * Send a message to the server.
   */
  const send = useCallback(
    (data: unknown) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify(data))
        return true
      }
      return false
    },
    []
  )

  // Connect on mount, disconnect on unmount
  useEffect(() => {
    connect()
    return () => disconnect()
  }, [connect, disconnect])

  // Reconnect when project changes
  useEffect(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      disconnect()
      connect()
    }
  }, [projectId, organizationId, connect, disconnect])

  return {
    connected,
    lastEvent,
    reconnectAttempt,
    send,
    connect,
    disconnect,
  }
}

/**
 * Hook specifically for activity feed events.
 */
export function useActivityFeed(projectId?: string) {
  const [activities, setActivities] = useState<WebSocketEvent[]>([])

  const { connected, lastEvent } = useWebSocket({
    projectId,
    onEvent: (event) => {
      if (event.type === "activity.new" || event.type === "task.completed" || event.type === "task.failed") {
        setActivities((prev) => [event, ...prev].slice(0, 100))
      }
    },
  })

  return { activities, connected, lastEvent }
}

/**
 * Hook specifically for approval events.
 */
export function useApprovalEvents(projectId?: string) {
  const [pendingApprovals, setPendingApprovals] = useState<number>(0)
  const [lastApproval, setLastApproval] = useState<WebSocketEvent | null>(null)

  const { connected, lastEvent } = useWebSocket({
    projectId,
    onEvent: (event) => {
      if (event.type === "approval.created") {
        setPendingApprovals((prev) => prev + 1)
        setLastApproval(event)
      } else if (event.type === "approval.approved" || event.type === "approval.rejected") {
        setPendingApprovals((prev) => Math.max(0, prev - 1))
      }
    },
  })

  return { pendingApprovals, lastApproval, connected, lastEvent }
}
