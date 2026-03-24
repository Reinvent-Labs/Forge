/**
 * @forge/agent-intent — Unit Tests
 *
 * Tests the IntentAgent's confidence threshold behaviour, intent type
 * validation (7 valid types), approval token detection from natural language,
 * and the generateResponse / handleApprovalMessage pipelines.
 *
 * Claude Haiku calls are mocked so the classification result is fully
 * deterministic in tests.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('@forge/database', () => ({
  prisma: {
    project: {
      findUnique: vi.fn(),
    },
    agentTask: {
      create: vi.fn(),
    },
    incident: {
      findMany: vi.fn(),
    },
    codebaseContext: {
      findFirst: vi.fn(),
    },
    projectMetricsSnapshot: {
      findFirst: vi.fn(),
    },
    approvalRequest: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    organization: {
      findFirst: vi.fn(),
    },
  },
}))

// ---------------------------------------------------------------------------
// Anthropic mock — lets individual tests control the Haiku response
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Import subject under test
// ---------------------------------------------------------------------------

import { IntentAgent } from './index'
import { prisma } from '@forge/database'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Make mockCreate resolve with a Haiku-style response containing a JSON
 * classification payload.
 */
function mockHaikuResponse(payload: {
  intentType: string
  confidence: number
  affectedFeature?: string | null
  errorMessage?: string | null
  urgency?: string | null
  targetEnvironment?: string | null
}) {
  mockCreate.mockResolvedValueOnce({
    content: [{ type: 'text', text: JSON.stringify(payload) }],
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('IntentAgent', () => {
  let agent: IntentAgent

  beforeEach(() => {
    vi.clearAllMocks()
    agent = new IntentAgent()

    // Default DB stubs
    vi.mocked(prisma.project.findUnique).mockResolvedValue({
      id: 'proj-1',
      organizationId: 'org-1',
      autonomyLevel: 'SUGGEST',
      organization: {
        members: [{ userId: 'user-founder', role: 'OWNER', user: { id: 'user-founder' } }],
      },
    } as never)

    vi.mocked(prisma.agentTask.create).mockResolvedValue({ id: 'task-new', createdAt: new Date() } as never)
    vi.mocked(prisma.incident.findMany).mockResolvedValue([])
    vi.mocked(prisma.codebaseContext.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.projectMetricsSnapshot.findFirst).mockResolvedValue(null)
  })

  // -------------------------------------------------------------------------
  // Confidence threshold — < 0.7 triggers clarification
  // -------------------------------------------------------------------------

  describe('confidence threshold (CONFIDENCE_THRESHOLD = 0.7)', () => {
    it('sets requiresClarification = true when Haiku confidence is 0.69', async () => {
      mockHaikuResponse({ intentType: 'bug_report', confidence: 0.69 })
      const parsed = await agent.parseMessage('something is broken', 'proj-1', 'user-founder')
      expect(parsed.requiresClarification).toBe(true)
      expect(parsed.clarificationQuestion).toBeDefined()
    })

    it('sets requiresClarification = true when confidence is 0.0', async () => {
      mockHaikuResponse({ intentType: 'general_chat', confidence: 0.0 })
      const parsed = await agent.parseMessage('huh', 'proj-1', 'user-founder')
      expect(parsed.requiresClarification).toBe(true)
    })

    it('sets requiresClarification = false when confidence is exactly 0.7', async () => {
      mockHaikuResponse({ intentType: 'status_query', confidence: 0.7 })
      const parsed = await agent.parseMessage('show me the metrics', 'proj-1', 'user-founder')
      expect(parsed.requiresClarification).toBe(false)
    })

    it('sets requiresClarification = false when confidence is 0.95', async () => {
      mockHaikuResponse({ intentType: 'bug_report', confidence: 0.95, affectedFeature: 'checkout' })
      const parsed = await agent.parseMessage('The checkout page crashes on Safari', 'proj-1', 'user-founder')
      expect(parsed.requiresClarification).toBe(false)
    })

    it('does NOT generate an agent task when confidence is below threshold', async () => {
      mockHaikuResponse({ intentType: 'bug_report', confidence: 0.5 })
      const parsed = await agent.parseMessage('something bad', 'proj-1', 'user-founder')
      expect(parsed.generatedTask).toBeUndefined()
    })

    it('DOES generate an agent task when confidence is above threshold for an actionable intent', async () => {
      mockHaikuResponse({ intentType: 'bug_report', confidence: 0.9, affectedFeature: 'login', urgency: 'high' })
      const parsed = await agent.parseMessage('Login is completely broken', 'proj-1', 'user-founder')
      expect(parsed.generatedTask).toBeDefined()
      expect(parsed.generatedTask?.id).toBe('task-new')
    })
  })

  // -------------------------------------------------------------------------
  // Intent type validation — 7 valid types
  // -------------------------------------------------------------------------

  describe('intent type validation', () => {
    const validIntentTypes = [
      'bug_report',
      'feature_request',
      'status_query',
      'approval',
      'question',
      'escalation',
      'general_chat',
    ] as const

    for (const intentType of validIntentTypes) {
      it(`accepts valid intent type "${intentType}"`, async () => {
        mockHaikuResponse({ intentType, confidence: 0.85 })
        const parsed = await agent.parseMessage('test message', 'proj-1', 'user-founder')
        expect(parsed.intentType).toBe(intentType)
      })
    }

    it('falls back to "general_chat" for an invalid intent type from Claude', async () => {
      // Claude returns a value not in the valid set
      mockHaikuResponse({ intentType: 'unsupported_type' as never, confidence: 0.9 })
      const parsed = await agent.parseMessage('test', 'proj-1', 'user-founder')
      expect(parsed.intentType).toBe('general_chat')
    })

    it('falls back to "general_chat" with requiresClarification = true when Haiku throws', async () => {
      mockCreate.mockRejectedValueOnce(new Error('API error'))
      const parsed = await agent.parseMessage('test', 'proj-1', 'user-founder')
      // classifyIntent catches the error and returns general_chat with confidence 0.3
      // 0.3 < 0.7 so requiresClarification should be true
      expect(parsed.intentType).toBe('general_chat')
      expect(parsed.requiresClarification).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // Approval token detection from natural language
  // -------------------------------------------------------------------------

  describe('handleApprovalMessage — approval token detection', () => {
    const pendingApproval = {
      id: 'approval-1',
      projectId: 'proj-1',
      status: 'PENDING',
      approveToken: 'tok-approve-abc',
      rejectToken: 'tok-reject-xyz',
      createdAt: new Date(),
    }

    beforeEach(() => {
      vi.mocked(prisma.approvalRequest.findFirst).mockResolvedValue(pendingApproval as never)
      vi.mocked(prisma.approvalRequest.update).mockResolvedValue({ id: 'approval-1' } as never)
    })

    it('detects "yes" as an approval signal', async () => {
      const result = await agent.handleApprovalMessage('yes', 'proj-1')
      expect(result).not.toBeNull()
      expect(result!.action).toBe('approve')
      expect(result!.approvalId).toBe('approval-1')
    })

    it('detects "approve" as an approval signal', async () => {
      const result = await agent.handleApprovalMessage('approve', 'proj-1')
      expect(result!.action).toBe('approve')
    })

    it('detects "ship it" as an approval signal', async () => {
      const result = await agent.handleApprovalMessage('ship it!', 'proj-1')
      expect(result!.action).toBe('approve')
    })

    it('detects "lgtm" as an approval signal', async () => {
      const result = await agent.handleApprovalMessage('lgtm, looks good', 'proj-1')
      expect(result!.action).toBe('approve')
    })

    it('detects "no" as a rejection signal', async () => {
      const result = await agent.handleApprovalMessage('no', 'proj-1')
      expect(result!.action).toBe('reject')
    })

    it('detects "cancel" as a rejection signal', async () => {
      const result = await agent.handleApprovalMessage('cancel that', 'proj-1')
      expect(result!.action).toBe('reject')
    })

    it('detects "reject" as a rejection signal', async () => {
      const result = await agent.handleApprovalMessage('reject the change', 'proj-1')
      expect(result!.action).toBe('reject')
    })

    it('returns null for a message with no approval or rejection keywords', async () => {
      const result = await agent.handleApprovalMessage('what is the status?', 'proj-1')
      expect(result).toBeNull()
    })

    it('returns null when there is no pending approval request in the database', async () => {
      vi.mocked(prisma.approvalRequest.findFirst).mockResolvedValue(null)
      const result = await agent.handleApprovalMessage('yes', 'proj-1')
      expect(result).toBeNull()
    })

    it('returns the correct approve token from the pending approval record', async () => {
      const result = await agent.handleApprovalMessage('go ahead', 'proj-1')
      expect(result!.token).toBe(pendingApproval.approveToken)
    })

    it('returns the correct reject token from the pending approval record', async () => {
      const result = await agent.handleApprovalMessage('stop', 'proj-1')
      expect(result!.token).toBe(pendingApproval.rejectToken)
    })

    it('updates the approval record status to APPROVED when approved', async () => {
      await agent.handleApprovalMessage('approved', 'proj-1')
      expect(prisma.approvalRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'approval-1' },
          data: expect.objectContaining({ status: 'APPROVED' }),
        }),
      )
    })

    it('updates the approval record status to REJECTED when rejected', async () => {
      await agent.handleApprovalMessage('decline', 'proj-1')
      expect(prisma.approvalRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'approval-1' },
          data: expect.objectContaining({ status: 'REJECTED' }),
        }),
      )
    })
  })

  // -------------------------------------------------------------------------
  // generateResponse — clarification response shape
  // -------------------------------------------------------------------------

  describe('generateResponse', () => {
    it('returns a clarification response when requiresClarification is true', async () => {
      const parsed = {
        raw: 'some unclear message',
        intentType: 'general_chat' as const,
        confidence: 0.3,
        entities: {},
        requiresClarification: true,
        clarificationQuestion: 'Could you clarify what you need help with?',
      }
      const response = await agent.generateResponse(parsed, 'proj-1')
      expect(response.clarificationQuestion).toBeDefined()
      expect(response.understood).toContain('clarification')
    })

    it('returns a bug-report response with timeline when intent is bug_report', async () => {
      const parsed = {
        raw: 'checkout is broken',
        intentType: 'bug_report' as const,
        confidence: 0.9,
        entities: { affectedFeature: 'checkout', urgency: 'critical' as const },
        requiresClarification: false,
      }
      const response = await agent.generateResponse(parsed, 'proj-1')
      expect(response.understood).toContain('checkout')
      expect(response.action).toContain('Fixer')
      expect(response.timeline).toBe('Immediately')
    })

    it('sets needsApproval = true for a feature_request intent', async () => {
      vi.mocked(prisma.project.findUnique).mockResolvedValue({
        id: 'proj-1',
        name: 'Test Project',
        organizationId: 'org-1',
      } as never)

      const parsed = {
        raw: 'add dark mode',
        intentType: 'feature_request' as const,
        confidence: 0.85,
        entities: { affectedFeature: 'dark mode' },
        requiresClarification: false,
      }
      const response = await agent.generateResponse(parsed, 'proj-1')
      expect(response.needsApproval).toBe(true)
      expect(response.approvalNotification).toBeDefined()
    })
  })
})
