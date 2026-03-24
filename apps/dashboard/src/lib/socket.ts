import { io, type Socket } from "socket.io-client"

const SOCKET_URL = process.env.NEXT_PUBLIC_WS_URL ?? "http://localhost:4000"

let socket: Socket | null = null

/**
 * Get or create the Socket.io singleton.
 * Only one connection is maintained per browser session.
 */
export function getSocket(): Socket {
  if (!socket) {
    socket = io(SOCKET_URL, {
      autoConnect: false,
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
      transports: ["websocket", "polling"],
    })
  }
  return socket
}

/**
 * Connect to the socket server with authentication.
 */
export function connectSocket(token: string): Socket {
  const s = getSocket()
  s.auth = { token }
  if (!s.connected) s.connect()
  return s
}

/**
 * Subscribe to all events for a specific project.
 * The server emits project-scoped events into a room.
 */
export function subscribeToProject(projectId: string): void {
  const s = getSocket()
  s.emit("join:project", { projectId })
}

/**
 * Unsubscribe from project events.
 */
export function unsubscribeFromProject(projectId: string): void {
  const s = getSocket()
  s.emit("leave:project", { projectId })
}

/** Typed event map for Forge WebSocket events */
export type ForgeSocketEvent =
  | "approval:new"
  | "approval:expired"
  | "incident:new"
  | "incident:updated"
  | "incident:resolved"
  | "activity:new"
  | "health:updated"
  | "metrics:updated"

/**
 * Register a typed event handler.
 * Returns a cleanup function to remove the listener.
 */
export function onEvent<T>(
  event: ForgeSocketEvent,
  handler: (data: T) => void
): () => void {
  const s = getSocket()
  s.on(event, handler)
  return () => s.off(event, handler)
}

/**
 * Disconnect socket — call on logout.
 */
export function disconnectSocket(): void {
  if (socket?.connected) {
    socket.disconnect()
    socket = null
  }
}
