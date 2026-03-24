import Anthropic from '@anthropic-ai/sdk'
import { createLogger } from '@forge/shared'
import type { AgentTask, DeployEnvironment, TaskPriority } from '@forge/shared'

const log = createLogger('agent-intent')

const HAIKU_MODEL = 'claude-haiku-4-5-20251001'
const DEFAULT_CONFIDENCE_THRESHOLD = 0.72
const DEFAULT_MAX_THREAD_MESSAGES = 6

export type IntentType =
  | 'build_feature'
  | 'fix_bug'
  | 'deploy'
  | 'rollback'
  | 'security_scan'
  | 'debt_review'
  | 'unknown'

export type IntentSource = 'slack' | 'telegram'

export interface ConversationTurn {
  role: 'user' | 'assistant'
  text: string
  timestamp?: Date
}

export interface IntentMessageInput {
  message: string
  projectId: string
  organizationId?: string
  senderId: string
  source?: IntentSource
  languageHint?: string
  threadId?: string
  thread?: ConversationTurn[]
  routeToOrchestrator?: boolean
  requestedBy?: AgentTask['requestedBy']
  autonomyLevel?: AgentTask['autonomyLevel']
}

export type LegacyParseOptions = Omit<
  Partial<IntentMessageInput>,
  'message' | 'projectId' | 'senderId'
>

export interface IntentEntities {
  projectReferences: string[]
  filePaths: string[]
  description?: string
  priority?: TaskPriority
  environment?: DeployEnvironment
  language: string
}

export interface IntentResult {
  raw: string
  source: IntentSource
  type: IntentType
  entities: IntentEntities
  confidence: number
  needsClarification: boolean
  clarificationQuestion?: string
  structuredTask?: Omit<AgentTask, 'id' | 'createdAt'>
  routedTaskId?: string
  routingError?: string
}

export interface IntentHandleTaskResult {
  success: boolean
  summary: string
  result: IntentResult
}

export interface OrchestratorLike {
  processTask(task: Omit<AgentTask, 'id' | 'createdAt'>): Promise<string>
}

export interface IntentAgentOptions {
  anthropicClient?: Anthropic
  orchestrator?: OrchestratorLike
  anthropicApiKey?: string
  model?: string
  confidenceThreshold?: number
  maxThreadMessages?: number
}

interface NormalizedInput {
  message: string
  projectId: string
  organizationId: string
  senderId: string
  source: IntentSource
  languageHint?: string
  threadId?: string
  thread: ConversationTurn[]
  routeToOrchestrator: boolean
  requestedBy: AgentTask['requestedBy']
  autonomyLevel: AgentTask['autonomyLevel']
}

interface RegexExtraction {
  projectReferences: string[]
  filePaths: string[]
  priority?: TaskPriority
  environment?: DeployEnvironment
  description?: string
}

interface AiClassification {
  type: IntentType
  confidence: number
  description?: string
  projectReferences: string[]
  filePaths: string[]
  priority?: TaskPriority
  environment?: DeployEnvironment
  language?: string
}

/**
 * NLP intent parser for Slack and Telegram command messages.
 *
 * The parser uses a hybrid strategy:
 * 1. Claude Haiku for semantic command understanding.
 * 2. Regex extraction for deterministic entity capture.
 * 3. Confidence scoring to decide if clarification is required.
 * 4. Optional orchestrator routing for actionable commands.
 */
export class IntentAgent {
  private readonly anthropic: Anthropic
  private readonly orchestrator: OrchestratorLike | null
  private readonly model: string
  private readonly confidenceThreshold: number
  private readonly maxThreadMessages: number

  constructor(options: IntentAgentOptions = {}) {
    this.anthropic =
      options.anthropicClient ??
      new Anthropic({
        apiKey: options.anthropicApiKey ?? process.env['ANTHROPIC_API_KEY'] ?? 'missing-api-key',
      })
    this.orchestrator = options.orchestrator ?? null
    this.model = options.model ?? HAIKU_MODEL
    this.confidenceThreshold = options.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD
    this.maxThreadMessages = options.maxThreadMessages ?? DEFAULT_MAX_THREAD_MESSAGES

    log.info(
      {
        model: this.model,
        confidenceThreshold: this.confidenceThreshold,
        hasOrchestrator: this.orchestrator !== null,
      },
      'IntentAgent initialized',
    )
  }

  /**
   * Worker entry point for `translate_intent` tasks.
   *
   * Expected payload fields:
   * - `message`: natural language command
   * - `source`: `slack` or `telegram`
   * - `senderId`: sender identifier
   * - `thread`: optional conversation thread context
   */
  async handleTask(task: AgentTask): Promise<IntentHandleTaskResult> {
    if (task.type !== 'translate_intent') {
      const fallback = this.buildUnknownResult({
        message: 'Unsupported task type',
        source: 'slack',
      })
      return {
        success: false,
        summary: `Intent agent only handles translate_intent tasks (received: ${task.type})`,
        result: fallback,
      }
    }

    const payload = task.payload
    const message = typeof payload['message'] === 'string' ? payload['message'] : ''
    if (!message.trim()) {
      const fallback = this.buildUnknownResult({
        message: 'Missing message content',
        source: 'slack',
      })
      return {
        success: false,
        summary: 'translate_intent payload must include a non-empty message string',
        result: fallback,
      }
    }

    const source = normalizeSource(payload['source'])
    const senderId =
      typeof payload['senderId'] === 'string' && payload['senderId'].trim() !== ''
        ? payload['senderId']
        : 'system'
    const languageHint =
      typeof payload['languageHint'] === 'string' ? payload['languageHint'] : undefined
    const threadId = typeof payload['threadId'] === 'string' ? payload['threadId'] : undefined
    const thread = parseThread(payload['thread'])

    const parseInput: IntentMessageInput = {
      message,
      projectId: task.projectId,
      organizationId: task.organizationId,
      senderId,
      source,
      thread,
      requestedBy: task.requestedBy,
      autonomyLevel: task.autonomyLevel,
      routeToOrchestrator: true,
    }
    if (languageHint) {
      parseInput.languageHint = languageHint
    }
    if (threadId) {
      parseInput.threadId = threadId
    }

    const parsed = await this.parseMessage(parseInput)

    const summary = parsed.needsClarification
      ? `Clarification required: ${parsed.clarificationQuestion ?? 'missing details'}`
      : parsed.routedTaskId
        ? `Intent parsed and routed as task ${parsed.routedTaskId}`
        : 'Intent parsed successfully'

    return {
      success: !parsed.needsClarification && !parsed.routingError,
      summary,
      result: parsed,
    }
  }

  /**
   * Parse a natural language command, classify intent, extract entities,
   * and optionally route to orchestrator.
   */
  async parseMessage(input: IntentMessageInput): Promise<IntentResult>
  async parseMessage(
    message: string,
    projectId: string,
    senderId: string,
    options?: LegacyParseOptions,
  ): Promise<IntentResult>
  async parseMessage(
    inputOrMessage: IntentMessageInput | string,
    projectId?: string,
    senderId?: string,
    options: LegacyParseOptions = {},
  ): Promise<IntentResult> {
    const input = this.normalizeInput(inputOrMessage, projectId, senderId, options)
    const parseLog = log.child({
      projectId: input.projectId,
      source: input.source,
      senderId: input.senderId,
    })

    const sanitizedMessage = this.sanitizeMessage(input.message)
    if (!sanitizedMessage) {
      return {
        ...this.buildUnknownResult({ message: input.message, source: input.source }),
        clarificationQuestion: 'Please share the command in plain text.',
      }
    }

    parseLog.info({ message: sanitizedMessage }, 'Parsing intent message')

    const regexExtraction = this.extractEntitiesByRegex(sanitizedMessage, input.thread)
    const aiClassification = await this.classifyWithHaiku(sanitizedMessage, input)

    const resolvedType = this.resolveIntentType(sanitizedMessage, aiClassification, input.thread)
    const entities = this.mergeEntities({
      type: resolvedType,
      sanitizedMessage,
      regexExtraction,
      aiClassification,
      input,
    })

    const confidence = this.computeConfidence({
      type: resolvedType,
      message: sanitizedMessage,
      entities,
      aiConfidence: aiClassification.confidence,
      threadUsed: this.looksContextDependent(sanitizedMessage) && input.thread.length > 0,
    })

    let needsClarification = this.shouldAskClarification(resolvedType, confidence, entities)
    let clarificationQuestion = needsClarification
      ? this.buildClarificationQuestion(resolvedType, entities)
      : undefined

    let structuredTask = !needsClarification
      ? this.buildStructuredTask(resolvedType, entities, input)
      : undefined

    if (!needsClarification && structuredTask === undefined) {
      needsClarification = true
      clarificationQuestion = this.buildClarificationQuestion(resolvedType, entities)
    }

    let routedTaskId: string | undefined
    let routingError: string | undefined
    if (
      !needsClarification &&
      structuredTask !== undefined &&
      input.routeToOrchestrator &&
      this.orchestrator !== null
    ) {
      try {
        routedTaskId = await this.orchestrator.processTask(structuredTask)
      } catch (err) {
        routingError = err instanceof Error ? err.message : String(err)
      }
    }

    const result: IntentResult = {
      raw: sanitizedMessage,
      source: input.source,
      type: resolvedType,
      entities,
      confidence,
      needsClarification,
      ...(clarificationQuestion ? { clarificationQuestion } : {}),
      ...(structuredTask ? { structuredTask } : {}),
      ...(routedTaskId ? { routedTaskId } : {}),
      ...(routingError ? { routingError } : {}),
    }

    parseLog.info(
      {
        type: result.type,
        confidence: result.confidence,
        needsClarification: result.needsClarification,
        routed: result.routedTaskId !== undefined,
      },
      'Intent parse completed',
    )

    return result
  }

  private normalizeInput(
    inputOrMessage: IntentMessageInput | string,
    projectId?: string,
    senderId?: string,
    options: LegacyParseOptions = {},
  ): NormalizedInput {
    if (typeof inputOrMessage === 'string') {
      if (!projectId || !senderId) {
        throw new Error('parseMessage(message, projectId, senderId) requires projectId and senderId')
      }

      return {
        message: inputOrMessage,
        projectId,
        organizationId: options.organizationId ?? projectId,
        senderId,
        source: options.source ?? 'slack',
        ...(options.languageHint ? { languageHint: options.languageHint } : {}),
        ...(options.threadId ? { threadId: options.threadId } : {}),
        thread: options.thread ?? [],
        routeToOrchestrator: options.routeToOrchestrator ?? true,
        requestedBy: options.requestedBy ?? 'founder',
        autonomyLevel: options.autonomyLevel ?? 'suggest',
      }
    }

    return {
      message: inputOrMessage.message,
      projectId: inputOrMessage.projectId,
      organizationId: inputOrMessage.organizationId ?? inputOrMessage.projectId,
      senderId: inputOrMessage.senderId,
      source: inputOrMessage.source ?? 'slack',
      ...(inputOrMessage.languageHint ? { languageHint: inputOrMessage.languageHint } : {}),
      ...(inputOrMessage.threadId ? { threadId: inputOrMessage.threadId } : {}),
      thread: inputOrMessage.thread ?? [],
      routeToOrchestrator: inputOrMessage.routeToOrchestrator ?? true,
      requestedBy: inputOrMessage.requestedBy ?? 'founder',
      autonomyLevel: inputOrMessage.autonomyLevel ?? 'suggest',
    }
  }

  private async classifyWithHaiku(message: string, input: NormalizedInput): Promise<AiClassification> {
    const threadSnippet = input.thread
      .slice(-this.maxThreadMessages)
      .map((turn) => `[${turn.role}] ${turn.text}`)
      .join('\n')

    const userPrompt = [
      `Source: ${input.source}`,
      `Language hint: ${input.languageHint ?? 'none'}`,
      'Supported intents: build_feature, fix_bug, deploy, rollback, security_scan, debt_review, unknown',
      'Classify the following command semantically (not keyword-only) and extract entities.',
      '',
      '<message>',
      message,
      '</message>',
      '',
      '<thread_context>',
      threadSnippet || 'none',
      '</thread_context>',
      '',
      'Return ONLY valid JSON in this format:',
      '{',
      '  "intentType": "build_feature|fix_bug|deploy|rollback|security_scan|debt_review|unknown",',
      '  "confidence": 0.0,',
      '  "description": "string or null",',
      '  "projectReferences": ["string"],',
      '  "filePaths": ["string"],',
      '  "priority": "critical|high|normal|low|null",',
      '  "environment": "preview|staging|production|null",',
      '  "language": "BCP-47 language tag, e.g. en or es"',
      '}',
    ].join('\n')

    try {
      const response = await this.anthropic.messages.create({
        model: this.model,
        max_tokens: 512,
        temperature: 0,
        system: [
          'You are Forge Intent Agent, an NLP command parser for a software platform.',
          'Be strict and return machine-readable JSON only.',
          'Use semantic understanding. Do not require exact keyword matches.',
        ].join('\n'),
        messages: [{ role: 'user', content: userPrompt }],
      })

      const responseText = response.content
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('')

      const parsed = parseAiResponse(responseText)
      if (!parsed) {
        return this.buildUnknownAiClassification()
      }

      const classification: AiClassification = {
        type: normalizeIntentType(parsed.intentType),
        confidence: clamp(typeof parsed.confidence === 'number' ? parsed.confidence : 0.35, 0, 1),
        projectReferences: ensureStringArray(parsed.projectReferences),
        filePaths: ensureStringArray(parsed.filePaths),
      }

      if (isMeaningfulText(parsed.description)) {
        classification.description = parsed.description.trim()
      }

      const priority = normalizePriority(parsed.priority)
      if (priority) {
        classification.priority = priority
      }

      const environment = normalizeEnvironment(parsed.environment)
      if (environment) {
        classification.environment = environment
      }

      const language = normalizeLanguage(parsed.language)
      if (language) {
        classification.language = language
      }

      return classification
    } catch (err) {
      log.warn({ err }, 'Haiku intent classification failed; using regex-first fallback')
      return this.buildUnknownAiClassification()
    }
  }

  private buildUnknownAiClassification(): AiClassification {
    return {
      type: 'unknown',
      confidence: 0.25,
      projectReferences: [],
      filePaths: [],
    }
  }

  private extractEntitiesByRegex(message: string, thread: ConversationTurn[]): RegexExtraction {
    const projectReferences = extractProjectReferences(message)
    const filePaths = extractFilePaths(message)
    const priority = extractPriority(message)
    const environment = extractEnvironment(message)

    const threadProjectReferences =
      projectReferences.length > 0
        ? []
        : extractProjectReferences(
            thread
              .slice(-this.maxThreadMessages)
              .map((turn) => turn.text)
              .join(' '),
          )

    const fallbackDescription = isMeaningfulText(message) ? message.trim() : undefined

    return {
      projectReferences: uniqueStrings([...projectReferences, ...threadProjectReferences]),
      filePaths: uniqueStrings(filePaths),
      ...(priority ? { priority } : {}),
      ...(environment ? { environment } : {}),
      ...(fallbackDescription ? { description: fallbackDescription } : {}),
    }
  }

  private resolveIntentType(
    message: string,
    aiClassification: AiClassification,
    thread: ConversationTurn[],
  ): IntentType {
    const heuristicType = this.inferIntentFromText(message)
    const threadType = this.inferIntentFromThread(thread)
    const contextDependent = this.looksContextDependent(message)

    if (aiClassification.type !== 'unknown' && aiClassification.confidence >= 0.45) {
      return aiClassification.type
    }

    if (heuristicType !== 'unknown') {
      return heuristicType
    }

    if (contextDependent && threadType !== 'unknown') {
      return threadType
    }

    return aiClassification.type
  }

  private mergeEntities(params: {
    type: IntentType
    sanitizedMessage: string
    regexExtraction: RegexExtraction
    aiClassification: AiClassification
    input: NormalizedInput
  }): IntentEntities {
    const { type, sanitizedMessage, regexExtraction, aiClassification, input } = params

    const projectReferences = uniqueStrings([
      ...regexExtraction.projectReferences,
      ...aiClassification.projectReferences,
    ])
    const filePaths = uniqueStrings([...regexExtraction.filePaths, ...aiClassification.filePaths])
    const priority = regexExtraction.priority ?? aiClassification.priority
    const environment = regexExtraction.environment ?? aiClassification.environment

    const aiDescription = aiClassification.description
    const commandDescription = this.extractDescriptionFromCommand(sanitizedMessage, type)
    const contextDescription = this.extractDescriptionFromThread(input.thread)
    const description =
      aiDescription ?? commandDescription ?? (this.looksContextDependent(sanitizedMessage) ? contextDescription : undefined)

    const language =
      aiClassification.language ??
      normalizeLanguage(input.languageHint) ??
      (containsLatinLetters(sanitizedMessage) ? 'en' : 'unknown')

    return {
      projectReferences,
      filePaths,
      ...(description ? { description } : {}),
      ...(priority ? { priority } : {}),
      ...(environment ? { environment } : {}),
      language,
    }
  }

  private inferIntentFromText(message: string): IntentType {
    const normalized = message.toLowerCase()

    if (matchesAny(normalized, [/\broll\s?back\b/i, /\brevert\b/i, /\bback out\b/i])) {
      return 'rollback'
    }
    if (matchesAny(normalized, [/\bdeploy\b/i, /\brelease\b/i, /\bpush\s+live\b/i, /\bship\b/i])) {
      return 'deploy'
    }
    if (matchesAny(normalized, [/\bsecurity\b/i, /\bvulnerab/i, /\baudit\b/i, /\bscan\b/i])) {
      return 'security_scan'
    }
    if (matchesAny(normalized, [/\btechnical\s+debt\b/i, /\bdebt\s+review\b/i, /\bcode\s+debt\b/i])) {
      return 'debt_review'
    }
    if (matchesAny(normalized, [/\bfix\b/i, /\bbug\b/i, /\bbroken\b/i, /\bissue\b/i, /\berror\b/i])) {
      return 'fix_bug'
    }
    if (matchesAny(normalized, [/\bbuild\b/i, /\bcreate\b/i, /\bimplement\b/i, /\badd\b/i, /\bfeature\b/i])) {
      return 'build_feature'
    }

    return 'unknown'
  }

  private inferIntentFromThread(thread: ConversationTurn[]): IntentType {
    for (let i = thread.length - 1; i >= 0; i -= 1) {
      const turn = thread[i]
      if (turn.role !== 'user') continue
      const inferred = this.inferIntentFromText(turn.text)
      if (inferred !== 'unknown') {
        return inferred
      }
    }
    return 'unknown'
  }

  private looksContextDependent(message: string): boolean {
    const normalized = message.trim().toLowerCase()
    if (normalized.length <= 14) {
      return true
    }

    return matchesAny(normalized, [
      /\bdo\s+it\b/i,
      /\bdo\s+that\b/i,
      /\bthat\b/i,
      /\bthis\b/i,
      /\bsame\b/i,
      /\bgo\s+ahead\b/i,
    ])
  }

  private extractDescriptionFromThread(thread: ConversationTurn[]): string | undefined {
    for (let i = thread.length - 1; i >= 0; i -= 1) {
      const turn = thread[i]
      if (turn.role !== 'user') continue
      if (isMeaningfulText(turn.text)) {
        return turn.text.trim()
      }
    }
    return undefined
  }

  private extractDescriptionFromCommand(message: string, type: IntentType): string | undefined {
    const normalized = message.trim()

    const clean = (value: string): string =>
      value
        .replace(/^please\s+/i, '')
        .replace(/^can\s+you\s+/i, '')
        .replace(/^could\s+you\s+/i, '')
        .replace(/^for\s+project\s+[A-Za-z0-9._/-]+\s*/i, '')
        .replace(/\s+/g, ' ')
        .trim()

    let description = normalized
    switch (type) {
      case 'build_feature':
        description = description.replace(/^(build|create|implement|add)\s+/i, '')
        break
      case 'fix_bug':
        description = description.replace(/^(fix|resolve|debug|repair|patch)\s+/i, '')
        break
      case 'deploy':
        description = description.replace(/^(deploy|release|ship)\s+/i, '')
        break
      case 'rollback':
        description = description.replace(/^(rollback|roll\s?back|revert)\s+/i, '')
        break
      case 'security_scan':
        description = description.replace(/^(check|run|scan)\s+/i, '')
        break
      case 'debt_review':
        description = description.replace(/^(show|review|analyze)\s+/i, '')
        break
      default:
        break
    }

    const cleaned = clean(description)
    return isMeaningfulText(cleaned) ? cleaned : undefined
  }

  private computeConfidence(params: {
    type: IntentType
    message: string
    entities: IntentEntities
    aiConfidence: number
    threadUsed: boolean
  }): number {
    const { type, message, entities, aiConfidence, threadUsed } = params

    const aiScore = clamp(aiConfidence, 0, 1)
    const keywordScore = this.keywordSignal(type, message)
    const entityScore = this.entityCompleteness(type, entities)
    const contextBoost = threadUsed ? 0.05 : 0

    let total = aiScore * 0.6 + keywordScore * 0.2 + entityScore * 0.2 + contextBoost
    if (type === 'unknown') {
      total = Math.min(total, 0.45)
    }

    return clamp(total, 0, 1)
  }

  private keywordSignal(type: IntentType, message: string): number {
    const normalized = message.toLowerCase()

    const signals: Record<Exclude<IntentType, 'unknown'>, RegExp[]> = {
      build_feature: [/\bbuild\b/i, /\bcreate\b/i, /\bimplement\b/i, /\bfeature\b/i, /\bpage\b/i],
      fix_bug: [/\bfix\b/i, /\bbug\b/i, /\berror\b/i, /\bbroken\b/i, /\bissue\b/i],
      deploy: [/\bdeploy\b/i, /\brelease\b/i, /\bship\b/i, /\bproduction\b/i, /\bstaging\b/i],
      rollback: [/\brollback\b/i, /\broll\s?back\b/i, /\brevert\b/i, /\bundo\b/i],
      security_scan: [/\bsecurity\b/i, /\bvulnerab/i, /\bscan\b/i, /\baudit\b/i],
      debt_review: [/\btechnical\s+debt\b/i, /\bdebt\b/i, /\bcode\s+quality\b/i, /\brefactor\b/i],
    }

    if (type === 'unknown') {
      return 0
    }

    const regexes = signals[type]
    const hits = regexes.reduce((count, regex) => count + (regex.test(normalized) ? 1 : 0), 0)
    return clamp(hits / regexes.length, 0, 1)
  }

  private entityCompleteness(type: IntentType, entities: IntentEntities): number {
    switch (type) {
      case 'build_feature':
      case 'fix_bug': {
        let score = entities.description ? 0.7 : 0.2
        if (entities.filePaths.length > 0) score += 0.2
        if (entities.projectReferences.length > 0) score += 0.1
        return clamp(score, 0, 1)
      }

      case 'deploy':
      case 'rollback':
        return entities.environment ? 1 : 0.25

      case 'security_scan':
      case 'debt_review': {
        let score = entities.description ? 0.75 : 0.55
        if (entities.filePaths.length > 0) score += 0.15
        if (entities.projectReferences.length > 0) score += 0.1
        return clamp(score, 0, 1)
      }

      default:
        return 0.2
    }
  }

  private shouldAskClarification(type: IntentType, confidence: number, entities: IntentEntities): boolean {
    if (type === 'unknown') return true
    if (confidence < this.confidenceThreshold) return true

    if ((type === 'build_feature' || type === 'fix_bug') && !entities.description) {
      return true
    }

    if ((type === 'deploy' || type === 'rollback') && !entities.environment) {
      return true
    }

    return false
  }

  private buildClarificationQuestion(type: IntentType, entities: IntentEntities): string {
    if (type === 'deploy' || type === 'rollback') {
      return 'Which environment should I target: preview, staging, or production?'
    }

    if (type === 'build_feature' && !entities.description) {
      return 'What feature should I build? Please include a short description.'
    }

    if (type === 'fix_bug' && !entities.description) {
      return 'What bug should I fix? Share the failing behavior and, if possible, a file path.'
    }

    if (type === 'security_scan') {
      return 'Do you want a full security scan or a dependency-focused scan?'
    }

    if (type === 'debt_review') {
      return 'Should I review overall technical debt or specific files/modules?'
    }

    return 'Should I build a feature, fix a bug, deploy, rollback, run a security scan, or review technical debt?'
  }

  private buildStructuredTask(
    type: IntentType,
    entities: IntentEntities,
    input: NormalizedInput,
  ): Omit<AgentTask, 'id' | 'createdAt'> | undefined {
    const priority = entities.priority ?? 'normal'
    const basePayload = compactRecord({
      description: entities.description,
      projectReferences: entities.projectReferences.length > 0 ? entities.projectReferences : undefined,
      filePaths: entities.filePaths.length > 0 ? entities.filePaths : undefined,
      source: input.source,
      senderId: input.senderId,
      language: entities.language,
      threadId: input.threadId,
      threadContext:
        input.thread.length > 0
          ? input.thread
              .slice(-this.maxThreadMessages)
              .map((turn) => ({ role: turn.role, text: turn.text }))
          : undefined,
    })

    const baseTask = {
      priority,
      projectId: input.projectId,
      organizationId: input.organizationId,
      requestedBy: input.requestedBy,
      autonomyLevel: input.autonomyLevel,
    } as const

    switch (type) {
      case 'build_feature':
        if (!entities.description) return undefined
        return {
          ...baseTask,
          type: 'build_feature',
          payload: basePayload,
        }

      case 'fix_bug':
        if (!entities.description) return undefined
        return {
          ...baseTask,
          type: 'fix_bug',
          payload: basePayload,
        }

      case 'deploy':
        if (!entities.environment) return undefined
        return {
          ...baseTask,
          type: 'deploy',
          payload: compactRecord({
            ...basePayload,
            action: 'deploy',
            environment: entities.environment,
          }),
        }

      case 'rollback':
        if (!entities.environment) return undefined
        return {
          ...baseTask,
          type: 'rollback',
          payload: compactRecord({
            ...basePayload,
            action: 'rollback',
            environment: entities.environment,
          }),
        }

      case 'security_scan':
        return {
          ...baseTask,
          type: 'security_patch',
          payload: compactRecord({
            ...basePayload,
            scanType: 'DEPENDENCY_AUDIT',
            trigger: 'chat_command',
          }),
        }

      case 'debt_review':
        return {
          ...baseTask,
          type: 'update_debt_ledger',
          payload: compactRecord({
            ...basePayload,
            trigger: 'chat_command',
          }),
        }

      default:
        return undefined
    }
  }

  private sanitizeMessage(message: string): string {
    return message
      .replace(/<@[^>]+>/g, ' ')
      .replace(/^\/\w+\s+/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  }

  private buildUnknownResult(params: { message: string; source: IntentSource }): IntentResult {
    return {
      raw: params.message,
      source: params.source,
      type: 'unknown',
      entities: {
        projectReferences: [],
        filePaths: [],
        language: 'en',
      },
      confidence: 0,
      needsClarification: true,
      clarificationQuestion:
        'I could not classify that command. Please tell me if this is build, fix, deploy, rollback, security scan, or debt review.',
    }
  }
}

interface RawAiResponse {
  intentType?: unknown
  confidence?: unknown
  description?: unknown
  projectReferences?: unknown
  filePaths?: unknown
  priority?: unknown
  environment?: unknown
  language?: unknown
}

function parseAiResponse(text: string): RawAiResponse | null {
  const jsonCandidate = extractJsonObject(text)
  if (!jsonCandidate) return null

  try {
    const parsed = JSON.parse(jsonCandidate) as unknown
    if (typeof parsed !== 'object' || parsed === null) {
      return null
    }
    return parsed as RawAiResponse
  } catch {
    return null
  }
}

function extractJsonObject(text: string): string | null {
  const trimmed = text.trim()
  const withoutFence = trimmed
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim()

  const firstBrace = withoutFence.indexOf('{')
  const lastBrace = withoutFence.lastIndexOf('}')
  if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
    return null
  }

  return withoutFence.slice(firstBrace, lastBrace + 1)
}

function normalizeIntentType(value: unknown): IntentType {
  if (typeof value !== 'string') return 'unknown'

  const normalized = value.trim().toLowerCase()
  switch (normalized) {
    case 'build_feature':
    case 'fix_bug':
    case 'deploy':
    case 'rollback':
    case 'security_scan':
    case 'debt_review':
      return normalized
    default:
      return 'unknown'
  }
}

function normalizePriority(value: unknown): TaskPriority | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase()
  switch (normalized) {
    case 'critical':
    case 'high':
    case 'normal':
    case 'low':
      return normalized
    case 'urgent':
    case 'asap':
      return 'critical'
    case 'medium':
      return 'normal'
    default:
      return undefined
  }
}

function normalizeEnvironment(value: unknown): DeployEnvironment | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase()
  switch (normalized) {
    case 'preview':
      return 'preview'
    case 'staging':
      return 'staging'
    case 'production':
    case 'prod':
      return 'production'
    default:
      return undefined
  }
}

function normalizeLanguage(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  if (!normalized) return undefined

  if (/^[a-z]{2}(?:-[A-Z]{2})?$/.test(normalized)) {
    return normalized
  }

  if (/^[a-z]{2}$/i.test(normalized)) {
    return normalized.toLowerCase()
  }

  return undefined
}

function parseThread(value: unknown): ConversationTurn[] {
  if (!Array.isArray(value)) return []
  const turns: ConversationTurn[] = []
  for (const item of value) {
    const turn = parseConversationTurn(item)
    if (turn) turns.push(turn)
  }
  return turns
}

function parseConversationTurn(value: unknown): ConversationTurn | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  const role = raw['role']
  const text = raw['text']
  if ((role !== 'user' && role !== 'assistant') || typeof text !== 'string') {
    return null
  }

  const timestampValue = raw['timestamp']
  if (typeof timestampValue === 'string' || timestampValue instanceof Date) {
    const timestamp = new Date(timestampValue)
    if (!Number.isNaN(timestamp.getTime())) {
      return { role, text, timestamp }
    }
  }

  return { role, text }
}

function normalizeSource(value: unknown): IntentSource {
  if (typeof value !== 'string') return 'slack'
  const normalized = value.trim().toLowerCase()
  return normalized === 'telegram' ? 'telegram' : 'slack'
}

function extractProjectReferences(text: string): string[] {
  const matches: string[] = []
  const regex = /\b(?:project|repo|repository)\s*(?:[:#]\s*|\s+)([A-Za-z0-9._/-]+)/gi
  let match: RegExpExecArray | null
  while ((match = regex.exec(text)) !== null) {
    const ref = match[1]
    if (ref) {
      matches.push(ref)
    }
  }
  return uniqueStrings(matches)
}

function extractFilePaths(text: string): string[] {
  const matches: string[] = []
  const regex = /((?:\.{1,2}\/|\/)?(?:[A-Za-z0-9_-]+\/)+[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+)/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(text)) !== null) {
    const filePath = match[1]
    if (filePath && !filePath.startsWith('http')) {
      matches.push(filePath)
    }
  }
  return uniqueStrings(matches)
}

function extractPriority(text: string): TaskPriority | undefined {
  if (matchesAny(text, [/\bcritical\b/i, /\burgent\b/i, /\basap\b/i, /\bp0\b/i, /\bsev\s*1\b/i])) {
    return 'critical'
  }
  if (matchesAny(text, [/\bhigh\s+priority\b/i, /\bimportant\b/i, /\bsoon\b/i, /\bp1\b/i])) {
    return 'high'
  }
  if (matchesAny(text, [/\blow\s+priority\b/i, /\bwhenever\b/i, /\blater\b/i, /\bbacklog\b/i])) {
    return 'low'
  }
  return undefined
}

function extractEnvironment(text: string): DeployEnvironment | undefined {
  if (matchesAny(text, [/\bproduction\b/i, /\bprod\b/i])) {
    return 'production'
  }
  if (matchesAny(text, [/\bstaging\b/i])) {
    return 'staging'
  }
  if (matchesAny(text, [/\bpreview\b/i])) {
    return 'preview'
  }
  return undefined
}

function ensureStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return uniqueStrings(
    value
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  )
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter((value) => value !== '')))
}

function compactRecord(record: Record<string, unknown>): Record<string, unknown> {
  const compacted: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) {
      compacted[key] = value
    }
  }
  return compacted
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min
  if (value > max) return max
  return value
}

function matchesAny(value: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value))
}

function isMeaningfulText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length >= 3
}

function containsLatinLetters(value: string): boolean {
  return /[A-Za-z]/.test(value)
}
