import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Worker } from 'bullmq'
import { decode as decodeNextAuthToken } from 'next-auth/jwt'
import { z } from 'zod'
import { prisma } from '@forge/database'
import {
  createLogger,
  verifySessionToken,
  type AgentType,
  type ForgeEvent,
  type ForgeEventType,
} from '@forge/shared'
import { WebSocket, WebSocketServer as WsServer, type RawData } from 'ws'
import type { EventBus } from './event-bus.js'

const log = createLogger('websocket')

type BroadcastForgeEventType = Extract<ForgeEventType, 'approval.created' | 'task.completed' | 'incident.detected'>

const BROADCASTABLE_EVENT_TYPES: ReadonlySet<BroadcastForgeEventType> = new Set([
  'approval.created',
  'task.completed',
  'incident.detected',
])

export type RealtimeEventType = BroadcastForgeEventType | 'activity.new'

export interface ApprovalCreatedPayload extends Record<string, unknown> {
  taskId?: string
  title?: string
}

export interface TaskCompletedPayload extends Record<string, unknown> {
  taskId?: string
  result?: unknown
}

export interface IncidentDetectedPayload extends Record<string, unknown> {
  incidentId?: string
  severity?: string
}

export interface ActivityNewPayload {
  eventType: ForgeEventType
  payload: unknown
  sourceAgent?: AgentType
}

export interface RealtimeEventPayloadMap {
  'approval.created': ApprovalCreatedPayload
  'task.completed': TaskCompletedPayload
  'incident.detected': IncidentDetectedPayload
  'activity.new': ActivityNewPayload
}

export interface RealtimeEvent<TType extends RealtimeEventType = RealtimeEventType> {
  id: string
  type: TType
  projectId: string
  organizationId: string
  payload: RealtimeEventPayloadMap[TType]
  timestamp: string
}

type TokenType = 'forge-session' | 'next-auth'

interface AuthContext {
  userId: string
  tokenType: TokenType
  role?: string
  organizationId?: string
}

interface ConnectedClient {
  id: string
  socket: WebSocket
  auth: AuthContext
  rooms: Set<string>
  authorizedOrganizations: Set<string>
  projectOrganizations: Map<string, string>
  isAlive: boolean
}

interface AuthenticatedUpgradeRequest extends IncomingMessage {
  authContext?: AuthContext
}

const SubscribeProjectMessageSchema = z.object({
  type: z.union([z.literal('subscribe.project'), z.literal('subscribe:project')]),
  projectId: z.string().uuid(),
})

const UnsubscribeProjectMessageSchema = z.object({
  type: z.union([z.literal('unsubscribe.project'), z.literal('unsubscribe:project')]),
  projectId: z.string().uuid(),
})

const SubscribeOrganizationMessageSchema = z.object({
  type: z.union([z.literal('subscribe.organization'), z.literal('subscribe:organization')]),
  organizationId: z.string().uuid(),
})

const UnsubscribeOrganizationMessageSchema = z.object({
  type: z.union([z.literal('unsubscribe.organization'), z.literal('unsubscribe:organization')]),
  organizationId: z.string().uuid(),
})

const PingMessageSchema = z.object({
  type: z.literal('ping'),
})

const ClientMessageSchema = z.union([
  SubscribeProjectMessageSchema,
  UnsubscribeProjectMessageSchema,
  SubscribeOrganizationMessageSchema,
  UnsubscribeOrganizationMessageSchema,
  PingMessageSchema,
])

type ClientMessage = z.infer<typeof ClientMessageSchema>

type ServerMessage =
  | {
      type: 'connection.ready'
      connectionId: string
      heartbeatIntervalMs: number
    }
  | {
      type: 'subscription.confirmed'
      scope: 'project'
      projectId: string
      organizationId: string
    }
  | {
      type: 'subscription.confirmed'
      scope: 'organization'
      organizationId: string
    }
  | {
      type: 'subscription.removed'
      scope: 'project'
      projectId: string
      organizationId: string
    }
  | {
      type: 'subscription.removed'
      scope: 'organization'
      organizationId: string
    }
  | {
      type: 'event'
      event: RealtimeEvent
    }
  | {
      type: 'error'
      code: 'invalid_message' | 'unauthorized' | 'server_error'
      message: string
    }
  | {
      type: 'pong'
      timestamp: string
    }

export interface WebSocketServerOptions {
  eventBus: EventBus
  path?: string
  heartbeatIntervalMs?: number
}

export class WebSocketServer {
  private readonly eventBus: EventBus
  private readonly wss: WsServer
  private readonly path: string
  private readonly heartbeatIntervalMs: number
  private readonly clients = new Map<WebSocket, ConnectedClient>()
  private readonly rooms = new Map<string, Set<WebSocket>>()
  private heartbeatTimer: NodeJS.Timeout | undefined
  private eventWorker: Worker<ForgeEvent<unknown>> | undefined
  private started = false
  private closing = false

  constructor(options: WebSocketServerOptions) {
    this.eventBus = options.eventBus
    this.path = options.path ?? '/ws'
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30_000
    this.wss = new WsServer({ noServer: true })

    this.wss.on('connection', (socket, request) => {
      void this.onConnection(socket, request)
    })
  }

  start(): void {
    if (this.started) {
      return
    }

    this.started = true
    this.eventWorker = this.eventBus.registerEventWorker(async (event) => {
      this.onForgeEvent(event)
    })

    this.heartbeatTimer = setInterval(() => {
      this.runHeartbeat()
    }, this.heartbeatIntervalMs)
    this.heartbeatTimer.unref()

    log.info({ path: this.path }, 'WebSocket server started')
  }

  isWebSocketRequest(request: IncomingMessage): boolean {
    return this.getRequestPathname(request) === this.path
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (this.closing) {
      this.rejectUpgrade(socket, 503, 'Service Unavailable')
      return
    }

    if (!this.started) {
      this.start()
    }

    if (!this.isWebSocketRequest(request)) {
      socket.destroy()
      return
    }

    void this.authenticateRequest(request)
      .then((authContext) => {
        ;(request as AuthenticatedUpgradeRequest).authContext = authContext

        this.wss.handleUpgrade(request, socket, head, (ws) => {
          this.wss.emit('connection', ws, request)
        })
      })
      .catch((error) => {
        log.warn({ error: (error as Error).message }, 'WebSocket authentication failed')
        this.rejectUpgrade(socket, 401, 'Unauthorized')
      })
  }

  async close(): Promise<void> {
    this.closing = true

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = undefined
    }

    if (this.eventWorker) {
      await this.eventWorker.close()
      this.eventWorker = undefined
    }

    for (const client of [...this.clients.values()]) {
      if (client.socket.readyState === WebSocket.OPEN || client.socket.readyState === WebSocket.CONNECTING) {
        client.socket.close(1001, 'Server shutdown')
      }
      this.cleanupClient(client)
    }

    await new Promise<void>((resolve) => {
      this.wss.close(() => {
        resolve()
      })
    })

    log.info('WebSocket server closed')
  }

  private async onConnection(socket: WebSocket, request: IncomingMessage): Promise<void> {
    const authContext = (request as AuthenticatedUpgradeRequest).authContext

    if (!authContext) {
      socket.close(4401, 'Unauthorized')
      return
    }

    const client: ConnectedClient = {
      id: crypto.randomUUID(),
      socket,
      auth: authContext,
      rooms: new Set(),
      authorizedOrganizations: new Set(
        authContext.organizationId ? [authContext.organizationId] : [],
      ),
      projectOrganizations: new Map(),
      isAlive: true,
    }

    this.clients.set(socket, client)

    socket.on('message', (rawData) => {
      void this.onClientMessage(client, rawData)
    })

    socket.on('pong', () => {
      client.isAlive = true
    })

    socket.on('close', (code) => {
      this.cleanupClient(client)
      log.debug({ connectionId: client.id, code }, 'WebSocket client disconnected')
    })

    socket.on('error', (error) => {
      log.warn({ connectionId: client.id, error: error.message }, 'WebSocket client error')
    })

    this.send(client, {
      type: 'connection.ready',
      connectionId: client.id,
      heartbeatIntervalMs: this.heartbeatIntervalMs,
    })

    log.info(
      { connectionId: client.id, userId: client.auth.userId, tokenType: client.auth.tokenType },
      'WebSocket client connected',
    )
  }

  private async onClientMessage(client: ConnectedClient, rawData: RawData): Promise<void> {
    const message = this.parseMessage(rawData)
    if (!message) {
      this.sendError(client, 'invalid_message', 'Message must be valid JSON')
      return
    }

    if (message.type === 'ping') {
      client.isAlive = true
      this.send(client, { type: 'pong', timestamp: new Date().toISOString() })
      return
    }

    if (message.type === 'subscribe.project' || message.type === 'subscribe:project') {
      await this.subscribeProject(client, message.projectId)
      return
    }

    if (message.type === 'unsubscribe.project' || message.type === 'unsubscribe:project') {
      this.unsubscribeProject(client, message.projectId)
      return
    }

    if (message.type === 'subscribe.organization' || message.type === 'subscribe:organization') {
      await this.subscribeOrganization(client, message.organizationId)
      return
    }

    if (message.type === 'unsubscribe.organization' || message.type === 'unsubscribe:organization') {
      this.unsubscribeOrganization(client, message.organizationId)
    }
  }

  private async subscribeProject(client: ConnectedClient, projectId: string): Promise<void> {
    try {
      const organizationId = await this.authorizeProject(client, projectId)
      if (!organizationId) {
        this.sendError(client, 'unauthorized', 'Project subscription not allowed')
        return
      }

      const room = this.formatProjectRoom(organizationId, projectId)
      this.joinRoom(client, room)

      this.send(client, {
        type: 'subscription.confirmed',
        scope: 'project',
        projectId,
        organizationId,
      })
    } catch (error) {
      log.error(
        { error: (error as Error).message, connectionId: client.id, projectId },
        'Failed to subscribe client to project room',
      )
      this.sendError(client, 'server_error', 'Could not subscribe to project room')
    }
  }

  private unsubscribeProject(client: ConnectedClient, projectId: string): void {
    const organizationId = client.projectOrganizations.get(projectId)
    if (!organizationId) {
      return
    }

    const room = this.formatProjectRoom(organizationId, projectId)
    this.leaveRoom(client, room)
    client.projectOrganizations.delete(projectId)

    this.send(client, {
      type: 'subscription.removed',
      scope: 'project',
      projectId,
      organizationId,
    })
  }

  private async subscribeOrganization(client: ConnectedClient, organizationId: string): Promise<void> {
    try {
      const allowed = await this.authorizeOrganization(client, organizationId)
      if (!allowed) {
        this.sendError(client, 'unauthorized', 'Organization subscription not allowed')
        return
      }

      const room = this.formatOrganizationRoom(organizationId)
      this.joinRoom(client, room)

      this.send(client, {
        type: 'subscription.confirmed',
        scope: 'organization',
        organizationId,
      })
    } catch (error) {
      log.error(
        { error: (error as Error).message, connectionId: client.id, organizationId },
        'Failed to subscribe client to organization room',
      )
      this.sendError(client, 'server_error', 'Could not subscribe to organization room')
    }
  }

  private unsubscribeOrganization(client: ConnectedClient, organizationId: string): void {
    const room = this.formatOrganizationRoom(organizationId)
    this.leaveRoom(client, room)

    this.send(client, {
      type: 'subscription.removed',
      scope: 'organization',
      organizationId,
    })
  }

  private joinRoom(client: ConnectedClient, room: string): void {
    const members = this.rooms.get(room)

    if (!members) {
      this.rooms.set(room, new Set([client.socket]))
      client.rooms.add(room)
      return
    }

    members.add(client.socket)
    client.rooms.add(room)
  }

  private leaveRoom(client: ConnectedClient, room: string): void {
    const members = this.rooms.get(room)
    if (!members) {
      return
    }

    members.delete(client.socket)
    if (members.size === 0) {
      this.rooms.delete(room)
    }
    client.rooms.delete(room)
  }

  private cleanupClient(client: ConnectedClient): void {
    const deleted = this.clients.delete(client.socket)
    if (!deleted) {
      return
    }

    for (const room of client.rooms) {
      const members = this.rooms.get(room)
      if (!members) {
        continue
      }
      members.delete(client.socket)
      if (members.size === 0) {
        this.rooms.delete(room)
      }
    }

    client.rooms.clear()
    client.projectOrganizations.clear()
  }

  private send(client: ConnectedClient, message: ServerMessage): void {
    if (client.socket.readyState !== WebSocket.OPEN) {
      return
    }

    client.socket.send(JSON.stringify(message))
  }

  private sendError(
    client: ConnectedClient,
    code: 'invalid_message' | 'unauthorized' | 'server_error',
    message: string,
  ): void {
    this.send(client, {
      type: 'error',
      code,
      message,
    })
  }

  private async authenticateRequest(request: IncomingMessage): Promise<AuthContext> {
    const token = this.extractToken(request)
    if (!token) {
      throw new Error('Missing authentication token')
    }

    return this.verifyToken(token)
  }

  private extractToken(request: IncomingMessage): string | null {
    const authHeader = request.headers['authorization']
    if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7).trim()
      if (token.length > 0) {
        return token
      }
    }

    const parsedUrl = this.getRequestUrl(request)
    const tokenFromQuery = parsedUrl?.searchParams.get('token')
    if (tokenFromQuery) {
      return tokenFromQuery
    }

    const cookies = this.parseCookies(request.headers.cookie)
    const tokenFromCookie =
      cookies['forge_session']
      ?? cookies['next-auth.session-token']
      ?? cookies['__Secure-next-auth.session-token']

    return tokenFromCookie ?? null
  }

  private async verifyToken(token: string): Promise<AuthContext> {
    try {
      const payload = await verifySessionToken(token)
      return {
        userId: payload.userId,
        organizationId: payload.organizationId,
        role: payload.role,
        tokenType: 'forge-session',
      }
    } catch {
      const nextAuthSecret = process.env['NEXTAUTH_SECRET'] ?? process.env['BETTER_AUTH_SECRET']
      if (!nextAuthSecret) {
        throw new Error('Missing NEXTAUTH_SECRET or BETTER_AUTH_SECRET')
      }

      const salts = ['next-auth.session-token', '__Secure-next-auth.session-token'] as const

      for (const salt of salts) {
        try {
          const payload = await decodeNextAuthToken({ token, secret: nextAuthSecret, salt })
          const authContext = this.parseNextAuthPayload(payload as Record<string, unknown> | null)
          if (authContext) {
            return authContext
          }
        } catch {
          continue
        }
      }
    }

    throw new Error('Invalid or expired token')
  }

  private parseNextAuthPayload(payload: Record<string, unknown> | null): AuthContext | null {
    if (!payload) {
      return null
    }

    const fromId = typeof payload['id'] === 'string' ? payload['id'] : undefined
    const fromSub = typeof payload['sub'] === 'string' ? payload['sub'] : undefined
    const userId = fromId ?? fromSub

    if (!userId) {
      return null
    }

    const authContext: AuthContext = {
      userId,
      tokenType: 'next-auth',
    }

    if (typeof payload['role'] === 'string') {
      authContext.role = payload['role']
    }

    if (typeof payload['organizationId'] === 'string') {
      authContext.organizationId = payload['organizationId']
    }

    return authContext
  }

  private parseCookies(cookieHeader: string | undefined): Record<string, string> {
    const result: Record<string, string> = {}

    if (!cookieHeader) {
      return result
    }

    const cookiePairs = cookieHeader.split(';')

    for (const pair of cookiePairs) {
      const trimmed = pair.trim()
      if (trimmed.length === 0) {
        continue
      }

      const equalsIndex = trimmed.indexOf('=')
      if (equalsIndex <= 0) {
        continue
      }

      const key = trimmed.slice(0, equalsIndex)
      const rawValue = trimmed.slice(equalsIndex + 1)

      try {
        result[key] = decodeURIComponent(rawValue)
      } catch {
        result[key] = rawValue
      }
    }

    return result
  }

  private parseMessage(rawData: RawData): ClientMessage | null {
    try {
      const message = JSON.parse(this.readRawData(rawData)) as unknown
      const parsed = ClientMessageSchema.safeParse(message)
      if (!parsed.success) {
        return null
      }
      return parsed.data
    } catch {
      return null
    }
  }

  private readRawData(rawData: RawData): string {
    if (typeof rawData === 'string') {
      return rawData
    }

    if (rawData instanceof ArrayBuffer) {
      return Buffer.from(rawData).toString('utf8')
    }

    if (Array.isArray(rawData)) {
      return Buffer.concat(rawData).toString('utf8')
    }

    return rawData.toString('utf8')
  }

  private async authorizeProject(client: ConnectedClient, projectId: string): Promise<string | null> {
    const cachedOrganizationId = client.projectOrganizations.get(projectId)
    if (cachedOrganizationId) {
      const allowed = await this.authorizeOrganization(client, cachedOrganizationId)
      return allowed ? cachedOrganizationId : null
    }

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { organizationId: true },
    })

    if (!project) {
      return null
    }

    const allowed = await this.authorizeOrganization(client, project.organizationId)
    if (!allowed) {
      return null
    }

    client.projectOrganizations.set(projectId, project.organizationId)
    return project.organizationId
  }

  private async authorizeOrganization(client: ConnectedClient, organizationId: string): Promise<boolean> {
    if (client.auth.organizationId && client.auth.organizationId !== organizationId) {
      return false
    }

    if (client.authorizedOrganizations.has(organizationId)) {
      return true
    }

    if (client.auth.organizationId && client.auth.organizationId === organizationId) {
      client.authorizedOrganizations.add(organizationId)
      return true
    }

    const membership = await prisma.orgMember.findUnique({
      where: {
        organizationId_userId: {
          organizationId,
          userId: client.auth.userId,
        },
      },
      select: { organizationId: true },
    })

    if (!membership) {
      return false
    }

    client.authorizedOrganizations.add(organizationId)
    return true
  }

  private onForgeEvent(event: ForgeEvent<unknown>): void {
    const realtimeEvents = this.toRealtimeEvents(event)
    for (const realtimeEvent of realtimeEvents) {
      this.broadcastScopedEvent(realtimeEvent)
    }
  }

  private toRealtimeEvents(event: ForgeEvent<unknown>): RealtimeEvent[] {
    const timestamp = this.toIsoTimestamp(event.timestamp as Date | string)
    const realtimeEvents: RealtimeEvent[] = []

    if (this.isBroadcastableEventType(event.type)) {
      realtimeEvents.push({
        id: event.id,
        type: event.type,
        projectId: event.projectId,
        organizationId: event.organizationId,
        payload: this.normalizeRecordPayload(event.payload),
        timestamp,
      })
    }

    const activityPayloadBase = {
      eventType: event.type,
      payload: event.payload,
    }

    const activityPayload: ActivityNewPayload = event.sourceAgent
      ? { ...activityPayloadBase, sourceAgent: event.sourceAgent }
      : activityPayloadBase

    realtimeEvents.push({
      id: `${event.id}:activity`,
      type: 'activity.new',
      projectId: event.projectId,
      organizationId: event.organizationId,
      payload: activityPayload,
      timestamp,
    })

    return realtimeEvents
  }

  private normalizeRecordPayload(payload: unknown): Record<string, unknown> {
    if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
      return payload as Record<string, unknown>
    }

    return { value: payload }
  }

  private broadcastScopedEvent(event: RealtimeEvent): void {
    const recipients = this.collectRecipients(event.organizationId, event.projectId)
    if (recipients.size === 0) {
      return
    }

    const outbound: ServerMessage = {
      type: 'event',
      event,
    }

    const serialized = JSON.stringify(outbound)

    for (const socket of recipients) {
      if (socket.readyState !== WebSocket.OPEN) {
        continue
      }
      socket.send(serialized)
    }
  }

  private collectRecipients(organizationId: string, projectId: string): Set<WebSocket> {
    const recipients = new Set<WebSocket>()

    const organizationRoom = this.formatOrganizationRoom(organizationId)
    const projectRoom = this.formatProjectRoom(organizationId, projectId)

    const organizationMembers = this.rooms.get(organizationRoom)
    if (organizationMembers) {
      for (const socket of organizationMembers) {
        recipients.add(socket)
      }
    }

    const projectMembers = this.rooms.get(projectRoom)
    if (projectMembers) {
      for (const socket of projectMembers) {
        recipients.add(socket)
      }
    }

    return recipients
  }

  private runHeartbeat(): void {
    for (const client of this.clients.values()) {
      if (client.socket.readyState !== WebSocket.OPEN) {
        this.cleanupClient(client)
        continue
      }

      if (!client.isAlive) {
        log.debug({ connectionId: client.id }, 'WebSocket heartbeat timeout')
        client.socket.terminate()
        this.cleanupClient(client)
        continue
      }

      client.isAlive = false
      client.socket.ping()
    }
  }

  private formatOrganizationRoom(organizationId: string): string {
    return `organization:${organizationId}`
  }

  private formatProjectRoom(organizationId: string, projectId: string): string {
    return `project:${organizationId}:${projectId}`
  }

  private toIsoTimestamp(timestamp: Date | string): string {
    const parsed = timestamp instanceof Date ? timestamp : new Date(timestamp)

    if (Number.isNaN(parsed.getTime())) {
      return new Date().toISOString()
    }

    return parsed.toISOString()
  }

  private isBroadcastableEventType(type: ForgeEventType): type is BroadcastForgeEventType {
    return BROADCASTABLE_EVENT_TYPES.has(type as BroadcastForgeEventType)
  }

  private rejectUpgrade(socket: Duplex, statusCode: number, statusText: string): void {
    if (socket.destroyed) {
      return
    }

    socket.write(
      `HTTP/1.1 ${statusCode} ${statusText}\r\n`
      + 'Connection: close\r\n'
      + 'Content-Type: text/plain\r\n'
      + '\r\n',
    )
    socket.destroy()
  }

  private getRequestPathname(request: IncomingMessage): string | null {
    return this.getRequestUrl(request)?.pathname ?? null
  }

  private getRequestUrl(request: IncomingMessage): URL | null {
    if (!request.url) {
      return null
    }

    const host = request.headers.host ?? 'localhost'

    try {
      return new URL(request.url, `http://${host}`)
    } catch {
      return null
    }
  }
}
