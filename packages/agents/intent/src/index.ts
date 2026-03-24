/**
 * @forge/agent-intent
 *
 * The Intent Agent translates natural language messages from founders and
 * developers into structured AgentTasks or conversational responses. It uses
 * Claude Haiku for fast intent classification and entity extraction, and
 * Claude Sonnet for complex feature-complexity estimation. It also detects
 * approval tokens in inbound messages and routes them to the ApprovalGateway.
 */

import Anthropic from '@anthropic-ai/sdk'
import { createLogger } from '@forge/shared'
import type {
  AgentTask,
  ParsedIntent,
  IntentType,
  ApprovalNotification,
} from '@forge/shared'
import { prisma } from '@forge/database'
import { randomUUID } from 'crypto'

const log = createLogger('agent-intent')

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Structured response the Intent Agent sends back to the messaging channel.
 */
export interface IntentResponse {
  /** Confirmation of what the agent understood: "I understood you want to..." */
  understood: string
  /** What the agent is doing or why no action is taken: "I am going to..." */
  action: string
  /** Approximate timeline for completion, if applicable. */
  timeline?: string
  /** True when an approval is required before executing the action. */
  needsApproval?: boolean
  /** Full approval notification payload, present when needsApproval is true. */
  approvalNotification?: ApprovalNotification
  /** Clarification question shown to the user when confidence is low. */
  clarificationQuestion?: string
  /** ID of the AgentTask created for this intent, if any. */
  generatedTaskId?: string
}

/**
 * Result of processing an approval or rejection token from a message.
 */
export interface ApprovalAction {
  /** Whether this was an approval or rejection. */
  action: 'approve' | 'reject'
  /** The raw token found in the message. */
  token: string
  /** The approval request ID resolved from the token. */
  approvalId: string
}

// ---------------------------------------------------------------------------
// IntentAgent
// ---------------------------------------------------------------------------

/**
 * Translates inbound natural language into structured AgentTasks.
 *
 * @example
 * const agent = new IntentAgent()
 * const parsed = await agent.parseMessage('The checkout page is broken', projectId, senderId)
 * const response = await agent.generateResponse(parsed, projectId)
 */
export class IntentAgent {
  private readonly anthropic: Anthropic
  /** Confidence threshold below which a clarification question is asked. */
  private readonly CONFIDENCE_THRESHOLD = 0.7

  constructor() {
    this.anthropic = new Anthropic()
    log.info('IntentAgent initialized')
  }

  // -------------------------------------------------------------------------
  // 1. parseMessage
  // -------------------------------------------------------------------------

  /**
   * Full intent parsing pipeline using Claude Haiku.
   *
   * Steps:
   * 1. Identify sender role (founder / developer / unknown) from org members.
   * 2. Classify intent type via Haiku.
   * 3. Extract entities: affected feature, error message, urgency, environment.
   * 4. Enrich context per intent type (fetch logs, check features, metrics).
   * 5. Generate structured AgentTask or mark for conversational reply.
   * 6. If confidence < 0.7, set clarification question instead of task.
   *
   * @param message   - Raw natural language message.
   * @param projectId - Project scope for the message.
   * @param senderId  - User ID of the sender (for role identification).
   * @returns Fully parsed intent with optional generated task.
   */
  async parseMessage(
    message: string,
    projectId: string,
    senderId: string,
  ): Promise<ParsedIntent> {
    const taskLog = log.child({ projectId, senderId })
    taskLog.info({ message }, 'Parsing message')

    try {
      // Step 1: Identify sender role
      const senderRole = await this.identifySenderRole(senderId, projectId)

      // Step 2 + 3: Classify intent and extract entities via Haiku
      const { intentType, confidence, entities } = await this.classifyIntent(
        message,
        senderRole,
      )

      taskLog.info({ intentType, confidence, senderRole }, 'Intent classified')

      // Step 4: Context enrichment based on intent type
      const enrichedContext = await this.enrichContext(intentType, entities, projectId)

      // Step 5 + 6: Build ParsedIntent
      const requiresClarification = confidence < this.CONFIDENCE_THRESHOLD
      let generatedTask: Partial<AgentTask> | undefined

      if (\!requiresClarification) {
        generatedTask = await this.buildAgentTask(
          intentType,
          entities,
          enrichedContext,
          projectId,
        )
      }

      const parsed: ParsedIntent = {
        raw: message,
        intentType,
        confidence,
        entities,
        requiresClarification,
        ...(requiresClarification
          ? {
              clarificationQuestion: this.buildClarificationQuestion(
                intentType,
                entities,
              ),
            }
          : {}),
        ...(generatedTask ? { generatedTask } : {}),
      }

      taskLog.info(
        { intentType, requiresClarification, hasTask: \!\!generatedTask },
        'Message parsed',
      )

      return parsed
    } catch (err) {
      taskLog.error({ err }, 'Failed to parse message')
      // Return a safe fallback: mark as general_chat requiring clarification
      return {
        raw: message,
        intentType: 'general_chat',
        confidence: 0,
        entities: {},
        requiresClarification: true,
        clarificationQuestion: 'I had trouble understanding that. Could you rephrase?',
      }
    }
  }

  // -------------------------------------------------------------------------
  // 2. generateResponse
  // -------------------------------------------------------------------------

  /**
   * Format a human-readable response for a parsed intent.
   *
   * Response includes:
   * - Confirmation of what was understood.
   * - What action is being taken (or why no action is needed).
   * - Expected timeline, if applicable.
   * - Approval notification payload if an approval is required.
   *
   * @param parsed    - Output from parseMessage.
   * @param projectId - Project scope.
   * @returns Structured IntentResponse ready for delivery to the channel.
   */
  async generateResponse(
    parsed: ParsedIntent,
    projectId: string,
  ): Promise<IntentResponse> {
    const respLog = log.child({ projectId, intentType: parsed.intentType })
    respLog.debug('Generating response')

    try {
      if (parsed.requiresClarification) {
        return {
          understood: 'I received your message but need some clarification.',
          action: 'Please answer the question below so I can help you.',
          clarificationQuestion: parsed.clarificationQuestion,
        }
      }

      const understood = this.buildUnderstoodStatement(parsed)
      const { action, timeline, needsApproval } = this.buildActionStatement(parsed)

      const response: IntentResponse = {
        understood,
        action,
        ...(timeline ? { timeline } : {}),
        ...(parsed.generatedTask?.id ? { generatedTaskId: parsed.generatedTask.id as string } : {}),
      }

      if (needsApproval) {
        const approval = await this.buildApprovalNotification(parsed, projectId)
        response.needsApproval = true
        response.approvalNotification = approval
      }

      respLog.info({ needsApproval }, 'Response generated')
      return response
    } catch (err) {
      respLog.error({ err }, 'Failed to generate response')
      return {
        understood: 'I received your message.',
        action: 'I encountered an error processing your request. Please try again.',
      }
    }
  }

  // -------------------------------------------------------------------------
  // 3. handleApprovalMessage
  // -------------------------------------------------------------------------

  /**
   * Detect approval or rejection keywords/tokens in a message and route
   * them to the ApprovalGateway.
   *
   * Positive signals: yes, approve, approved, go ahead, ship it, do it, lgtm
   * Negative signals: no, reject, rejected, cancel, stop, decline
   *
   * @param message   - Inbound message text.
   * @param projectId - Project scope.
   * @returns ApprovalAction if an approval token was resolved, else null.
   */
  async handleApprovalMessage(
    message: string,
    projectId: string,
  ): Promise<ApprovalAction | null> {
    const msgLower = message.trim().toLowerCase()

    const approvePatterns = ['yes', 'approve', 'approved', 'go ahead', 'ship it', 'do it', 'lgtm', 'looks good']
    const rejectPatterns = ['no', 'reject', 'rejected', 'cancel', 'stop', 'decline', 'abort']

    const isApproval = approvePatterns.some((p) => msgLower.includes(p))
    const isRejection = rejectPatterns.some((p) => msgLower.includes(p))

    if (\!isApproval && \!isRejection) return null

    // Look for a pending approval request for this project
    try {
      const pendingApproval = await prisma.approvalRequest.findFirst({
        where: { projectId, status: 'PENDING' },
        orderBy: { createdAt: 'desc' },
      })

      if (\!pendingApproval) {
        log.debug({ projectId }, 'Approval signal received but no pending approval found')
        return null
      }

      const action: ApprovalAction = {
        action: isApproval ? 'approve' : 'reject',
        token: isApproval ? pendingApproval.approveToken : pendingApproval.rejectToken,
        approvalId: pendingApproval.id,
      }

      // Update the approval status
      await prisma.approvalRequest.update({
        where: { id: pendingApproval.id },
        data: {
          status: isApproval ? 'APPROVED' : 'REJECTED',
          approvedAt: isApproval ? new Date() : undefined,
          rejectionReason: isRejection ? 'Rejected via chat message' : undefined,
        },
      })

      log.info({ approvalId: pendingApproval.id, action: action.action }, 'Approval resolved via chat')
      return action
    } catch (err) {
      log.error({ err, projectId }, 'Failed to resolve approval message')
      return null
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Identify the sender role within the organization.
   * Returns founder, developer, or unknown.
   */
  private async identifySenderRole(
    senderId: string,
    projectId: string,
  ): Promise<'founder' | 'developer' | 'unknown'> {
    try {
      const project = await prisma.project.findUnique({
        where: { id: projectId },
        include: { organization: { include: { members: { include: { user: true } } } } },
      })
      if (\!project) return 'unknown'
      const member = project.organization.members.find((m) => m.userId === senderId)
      if (\!member) return 'unknown'
      switch (member.role) {
        case 'OWNER':
        case 'ADMIN':
          return 'founder'
        case 'DEVELOPER':
          return 'developer'
        default:
          return 'unknown'
      }
    } catch {
      return 'unknown'
    }
  }

  /**
   * Classify intent and extract entities via Claude Haiku.
   */
  private async classifyIntent(
    message: string,
    senderRole: string,
  ): Promise<{
    intentType: IntentType
    confidence: number
    entities: ParsedIntent['entities']
  }> {
    const promptText = [
      'You are an intent classifier for a software development platform.',
      'Sender role: ' + senderRole,
      'Message: ' + JSON.stringify(message),
      '',
      'Classify the intent and extract entities. Respond with ONLY a JSON object:',
      '{',
      '  "intentType": one of: bug_report|feature_request|status_query|approval|question|escalation|general_chat,',
      '  "confidence": number 0.0-1.0,',
      '  "affectedFeature": string or null,',
      '  "errorMessage": string or null,',
      '  "urgency": one of: low|medium|high|critical or null,',
      '  "targetEnvironment": one of: preview|staging|production or null',
      '}',
    ].join('
')

    try {
      const response = await this.anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 512,
        messages: [{ role: 'user', content: promptText }],
      })

      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')

      const parsed = JSON.parse(text.trim()) as {
        intentType: IntentType
        confidence: number
        affectedFeature?: string | null
        errorMessage?: string | null
        urgency?: 'low' | 'medium' | 'high' | 'critical' | null
        targetEnvironment?: string | null
      }

      const validIntentTypes = new Set<IntentType>([
        'bug_report', 'feature_request', 'status_query',
        'approval', 'question', 'escalation', 'general_chat',
      ])
      const intentType: IntentType = validIntentTypes.has(parsed.intentType)
        ? parsed.intentType
        : 'general_chat'

      return {
        intentType,
        confidence: Math.min(1, Math.max(0, parsed.confidence ?? 0.5)),
        entities: {
          affectedFeature: parsed.affectedFeature ?? undefined,
          errorMessage: parsed.errorMessage ?? undefined,
          urgency: parsed.urgency ?? undefined,
          targetEnvironment: parsed.targetEnvironment ?? undefined,
        },
      }
    } catch (err) {
      log.error({ err }, 'Haiku intent classification failed')
      return { intentType: 'general_chat', confidence: 0.3, entities: {} }
    }
  }

  /**
   * Enrich context based on detected intent type.
   * bug_report: fetch recent errors from last 1h
   * feature_request: estimate complexity via Sonnet
   * status_query: fetch current metrics
   */
  private async enrichContext(
    intentType: IntentType,
    entities: ParsedIntent['entities'],
    projectId: string,
  ): Promise<Record<string, unknown>> {
    switch (intentType) {
      case 'bug_report':
        return this.enrichBugReport(projectId, entities.affectedFeature)
      case 'feature_request':
        return this.enrichFeatureRequest(projectId, entities.affectedFeature)
      case 'status_query':
        return this.enrichStatusQuery(projectId)
      default:
        return {}
    }
  }

  private async enrichBugReport(
    projectId: string,
    featureName?: string,
  ): Promise<Record<string, unknown>> {
    try {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000)
      const recentIncidents = await prisma.incident.findMany({
        where: {
          projectId,
          detectedAt: { gte: oneHourAgo },
          ...(featureName ? { affectedModules: { has: featureName } } : {}),
        },
        orderBy: { detectedAt: 'desc' },
        take: 5,
      })
      return {
        recentIncidents: recentIncidents.map((i) => ({
          id: i.id,
          title: i.title,
          severity: i.severity,
          detectedAt: i.detectedAt,
          affectedModules: i.affectedModules,
        })),
        relatedIncidentCount: recentIncidents.length,
      }
    } catch {
      return {}
    }
  }

  /**
   * Use Claude Sonnet for feature complexity estimation — requires deeper
   * reasoning about codebase architecture than Haiku provides.
   */
  private async enrichFeatureRequest(
    projectId: string,
    featureName?: string,
  ): Promise<Record<string, unknown>> {
    try {
      const context = await prisma.codebaseContext.findFirst({
        where: { projectId },
        include: { modules: true },
      })
      if (\!context || \!featureName) return {}

      const moduleList = context.modules
        .slice(0, 20)
        .map((m) => m.path + ': ' + m.plainEnglishDescription)
        .join('
')

      const complexityResponse = await this.anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 512,
        messages: [{
          role: 'user',
          content:
            'Estimate the complexity of implementing this feature: "' + featureName + '"

' +
            'Existing modules:
' + moduleList + '

' +
            'Respond with ONLY a JSON object: {"complexity": "low|medium|high", "estimatedDays": number, "rationale": "one sentence"}',
        }],
      })

      const text = complexityResponse.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')

      const estimate = JSON.parse(text.trim()) as {
        complexity: string
        estimatedDays: number
        rationale: string
      }
      return { complexityEstimate: estimate }
    } catch {
      return {}
    }
  }

  private async enrichStatusQuery(projectId: string): Promise<Record<string, unknown>> {
    try {
      const latest = await prisma.projectMetricsSnapshot.findFirst({
        where: { projectId },
        orderBy: { capturedAt: 'desc' },
      })
      return { currentMetrics: latest ?? {} }
    } catch {
      return {}
    }
  }

  private async buildAgentTask(
    intentType: IntentType,
    entities: ParsedIntent['entities'],
    enrichedContext: Record<string, unknown>,
    projectId: string,
  ): Promise<Partial<AgentTask> | undefined> {
    const actionableIntents: IntentType[] = ['bug_report', 'feature_request', 'escalation']
    if (\!actionableIntents.includes(intentType)) return undefined

    try {
      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { organizationId: true, autonomyLevel: true },
      })
      if (\!project) return undefined

      const taskType = intentType === 'bug_report' ? 'FIX_BUG'
        : intentType === 'feature_request' ? 'BUILD_FEATURE'
        : 'FIX_INCIDENT'

      const priority = entities.urgency === 'critical' ? 'CRITICAL'
        : entities.urgency === 'high' ? 'HIGH'
        : 'NORMAL'

      const task = await prisma.agentTask.create({
        data: {
          id: randomUUID(),
          projectId,
          type: taskType,
          priority,
          agentType: intentType === 'bug_report' ? 'FIXER' : 'BUILDER',
          requestedBy: 'FOUNDER',
          autonomyLevel: project.autonomyLevel ?? 'SUGGEST',
          payload: { intentType, entities, enrichedContext },
        },
      })

      return {
        id: task.id,
        type: intentType === 'bug_report' ? 'fix_bug' : 'build_feature',
        projectId,
        organizationId: project.organizationId,
        payload: task.payload as Record<string, unknown>,
        requestedBy: 'founder',
        autonomyLevel: (project.autonomyLevel?.toLowerCase() ?? 'suggest') as 'suggest' | 'semi' | 'autonomous',
        priority: priority.toLowerCase() as 'critical' | 'high' | 'normal' | 'low',
        createdAt: task.createdAt,
      }
    } catch (err) {
      log.error({ err, intentType }, 'Failed to build agent task')
      return undefined
    }
  }

  private buildClarificationQuestion(
    intentType: IntentType,
    entities: ParsedIntent['entities'],
  ): string {
    if (intentType === 'bug_report' && \!entities.affectedFeature) {
      return 'Which part of the product is affected by this bug?'
    }
    if (intentType === 'feature_request' && \!entities.affectedFeature) {
      return 'Could you describe the feature you have in mind in more detail?'
    }
    if (intentType === 'status_query') {
      return 'Which service or metric would you like a status update on?'
    }
    return 'Could you clarify what you need help with?'
  }

  private buildUnderstoodStatement(parsed: ParsedIntent): string {
    switch (parsed.intentType) {
      case 'bug_report':
        return parsed.entities.affectedFeature
          ? 'I understood you are reporting a bug in ' + parsed.entities.affectedFeature + '.'
          : 'I understood you are reporting a bug.'
      case 'feature_request':
        return parsed.entities.affectedFeature
          ? 'I understood you want to add: ' + parsed.entities.affectedFeature + '.'
          : 'I understood you have a feature request.'
      case 'status_query':
        return 'I understood you want a status update on the project.'
      case 'approval':
        return 'I understood you want to approve or reject a pending action.'
      case 'escalation':
        return 'I understood this is an escalation that needs immediate attention.'
      case 'question':
        return 'I understood you have a question.'
      default:
        return 'I received your message.'
    }
  }

  private buildActionStatement(parsed: ParsedIntent): {
    action: string
    timeline?: string
    needsApproval: boolean
  } {
    switch (parsed.intentType) {
      case 'bug_report':
        return {
          action: 'I am creating a bug fix task and assigning it to the Fixer agent.',
          timeline: parsed.entities.urgency === 'critical' ? 'Immediately' : 'Within the next sprint',
          needsApproval: false,
        }
      case 'feature_request':
        return {
          action: 'I am creating a feature task. It will require your approval before implementation begins.',
          timeline: 'Estimated in the complexity analysis above',
          needsApproval: true,
        }
      case 'status_query':
        return { action: 'Here are the current metrics for your project.', needsApproval: false }
      case 'escalation':
        return {
          action: 'I am escalating this to critical priority and paging on-call.',
          timeline: 'Immediately',
          needsApproval: false,
        }
      case 'approval':
        return { action: 'Processing your approval decision now.', needsApproval: false }
      default:
        return { action: 'No automated action is required for this message.', needsApproval: false }
    }
  }

  private async buildApprovalNotification(
    parsed: ParsedIntent,
    projectId: string,
  ): Promise<ApprovalNotification> {
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000)
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { name: true },
    })
    const approveToken = randomUUID()
    const rejectToken = randomUUID()
    const approvalId = randomUUID()

    return {
      summary: parsed.entities.affectedFeature
        ? 'Approve feature: ' + parsed.entities.affectedFeature
        : 'Approve pending action',
      businessImpact: 'This action will be executed by the Builder agent upon approval.',
      riskLevel: 'medium',
      confidenceScore: Math.round(parsed.confidence * 100),
      approveToken,
      rejectToken,
      expiresAt,
      approvalId,
      projectName: project?.name ?? 'Unknown Project',
    }
  }
}
