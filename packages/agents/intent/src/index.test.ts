import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockCreate = vi.fn()

vi.mock('@anthropic-ai/sdk', () => {
  const MockAnthropic = vi.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  }))
  return { default: MockAnthropic }
})

vi.mock('@forge/shared', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  }),
}))

import { IntentAgent, type IntentMessageInput } from './index'

interface MockAiPayload {
  intentType?: string
  confidence?: number
  description?: string | null
  projectReferences?: string[] | null
  filePaths?: string[] | null
  priority?: string | null
  environment?: string | null
  language?: string | null
}

function mockHaikuResponse(payload: MockAiPayload): void {
  mockCreate.mockResolvedValueOnce({
    content: [{ type: 'text', text: JSON.stringify(payload) }],
  })
}

function baseInput(message: string, source: 'slack' | 'telegram' = 'slack'): IntentMessageInput {
  return {
    message,
    projectId: 'project-1',
    organizationId: 'org-1',
    senderId: 'user-1',
    source,
    routeToOrchestrator: false,
  }
}

describe('IntentAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('parses "Build a user profile page" as build_feature', async () => {
    mockHaikuResponse({
      intentType: 'build_feature',
      confidence: 0.92,
      description: 'user profile page',
      language: 'en',
    })

    const agent = new IntentAgent()
    const result = await agent.parseMessage(baseInput('Build a user profile page', 'slack'))

    expect(result.type).toBe('build_feature')
    expect(result.entities.description?.toLowerCase()).toContain('user profile page')
    expect(result.confidence).toBeGreaterThan(0.7)
    expect(result.structuredTask?.type).toBe('build_feature')
  })

  it('parses "Fix the login bug" as fix_bug and extracts file paths via regex', async () => {
    mockHaikuResponse({
      intentType: 'fix_bug',
      confidence: 0.88,
      description: 'login bug',
      filePaths: [],
      language: 'en',
    })

    const agent = new IntentAgent()
    const result = await agent.parseMessage(
      baseInput('Fix the login bug in src/auth/login.ts for project storefront'),
    )

    expect(result.type).toBe('fix_bug')
    expect(result.entities.filePaths).toContain('src/auth/login.ts')
    expect(result.entities.projectReferences).toContain('storefront')
    expect(result.structuredTask?.type).toBe('fix_bug')
  })

  it('parses "Deploy to production" as deploy with production environment', async () => {
    mockHaikuResponse({
      intentType: 'deploy',
      confidence: 0.9,
      description: 'deploy latest release',
      environment: 'production',
      language: 'en',
    })

    const agent = new IntentAgent()
    const result = await agent.parseMessage(baseInput('Deploy to production', 'telegram'))

    expect(result.type).toBe('deploy')
    expect(result.entities.environment).toBe('production')
    expect(result.structuredTask?.type).toBe('deploy')
    expect(result.structuredTask?.payload['environment']).toBe('production')
  })

  it('parses "Check security vulnerabilities" as security_scan', async () => {
    mockHaikuResponse({
      intentType: 'security_scan',
      confidence: 0.87,
      description: 'check security vulnerabilities',
      language: 'en',
    })

    const agent = new IntentAgent()
    const result = await agent.parseMessage(baseInput('Check security vulnerabilities'))

    expect(result.type).toBe('security_scan')
    expect(result.structuredTask?.type).toBe('security_patch')
    expect(result.structuredTask?.payload['scanType']).toBe('DEPENDENCY_AUDIT')
  })

  it('parses "Show me technical debt" as debt_review', async () => {
    mockHaikuResponse({
      intentType: 'debt_review',
      confidence: 0.85,
      description: 'show technical debt',
      language: 'en',
    })

    const agent = new IntentAgent()
    const result = await agent.parseMessage(baseInput('Show me technical debt'))

    expect(result.type).toBe('debt_review')
    expect(result.structuredTask?.type).toBe('update_debt_ledger')
    expect(result.structuredTask?.payload['trigger']).toBe('chat_command')
  })

  it('asks a clarifying question for ambiguous requests', async () => {
    mockHaikuResponse({
      intentType: 'unknown',
      confidence: 0.22,
      description: null,
      language: 'en',
    })

    const agent = new IntentAgent()
    const result = await agent.parseMessage(baseInput('Can you handle that?'))

    expect(result.type).toBe('unknown')
    expect(result.needsClarification).toBe(true)
    expect(result.clarificationQuestion).toBeDefined()
    expect(result.structuredTask).toBeUndefined()
  })

  it('uses thread context to recover missing description details', async () => {
    mockHaikuResponse({
      intentType: 'fix_bug',
      confidence: 0.78,
      description: null,
      filePaths: [],
      language: 'en',
    })

    const agent = new IntentAgent()
    const result = await agent.parseMessage({
      ...baseInput('Do that in src/auth/login.ts'),
      thread: [
        { role: 'user', text: 'Fix the login bug on Safari' },
        { role: 'assistant', text: 'Got it, I can work on that.' },
      ],
    })

    expect(result.type).toBe('fix_bug')
    expect(result.entities.description).toContain('Fix the login bug on Safari')
    expect(result.entities.filePaths).toContain('src/auth/login.ts')
  })

  it('routes parsed intents to orchestrator when configured', async () => {
    mockHaikuResponse({
      intentType: 'deploy',
      confidence: 0.94,
      description: 'deploy now',
      environment: 'production',
      language: 'en',
    })

    const processTask = vi.fn().mockResolvedValue('task-42')
    const agent = new IntentAgent({
      orchestrator: { processTask },
    })

    const result = await agent.parseMessage({
      ...baseInput('Deploy to production', 'slack'),
      routeToOrchestrator: true,
    })

    expect(processTask).toHaveBeenCalledTimes(1)
    expect(result.routedTaskId).toBe('task-42')
    expect(result.routingError).toBeUndefined()
  })

  it('falls back to semantic heuristic classification when Haiku is unavailable', async () => {
    mockCreate.mockRejectedValueOnce(new Error('Anthropic unavailable'))

    const agent = new IntentAgent()
    const result = await agent.parseMessage(baseInput('Ship the new profile feature'))

    expect(result.type).toBe('deploy')
    expect(result.confidence).toBeGreaterThan(0.3)
  })
})
