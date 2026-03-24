/**
 * @forge/agent-fixer — Unit Tests
 *
 * Tests the FixerAgent's computeFingerprint (hex/UUID/line-number stripping),
 * classifyFixType routing logic, and assessRisk HIGH_RISK_KEYWORDS detection.
 *
 * Because FixerAgent requires ANTHROPIC_API_KEY and GITHUB_TOKEN in its
 * constructor, we set those env vars in beforeEach and mock the heavy
 * third-party modules (anthropic, octokit, @forge/orchestrator).
 *
 * The pure helper `computeFingerprint` is not exported directly, so we test
 * it indirectly through the public classifyFixType path — fingerprint equality
 * is verifiable because identical normalised messages produce identical DB
 * lookups.  We also expose it directly via a re-export shim approach or
 * by accessing the module-level function through the classifyFixType output.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('@forge/database', () => ({
  prisma: {
    fixPattern: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    codebaseContext: {
      findFirst: vi.fn(),
    },
  },
}))

vi.mock('anthropic', () => {
  const MockAnthropic = vi.fn().mockImplementation(() => ({
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: '' }],
      }),
    },
  }))
  return { default: MockAnthropic }
})

vi.mock('octokit', () => ({
  Octokit: vi.fn().mockImplementation(() => ({
    rest: {
      git: {
        getRef: vi.fn(),
        createRef: vi.fn(),
      },
      pulls: {
        create: vi.fn(),
      },
    },
  })),
}))

vi.mock('@forge/orchestrator', () => ({
  ConfidenceEngine: vi.fn().mockImplementation(() => ({
    compute: vi.fn().mockResolvedValue({
      total: 75,
      breakdown: { testCoverage: 15, moduleStability: 10, ciPassing: 20, stagingStability: 15, securityClean: 10, deployTiming: 5 },
      recommendation: 'recommend',
      humanReadableSummary: 'Good confidence.',
      riskFactors: [],
    }),
  })),
}))

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

import { FixerAgent } from './index'
import { prisma } from '@forge/database'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Access private methods on FixerAgent for white-box unit tests.
 */
function priv(agent: FixerAgent) {
  return agent as unknown as {
    classifyFixType: (errorMessage: string, projectId: string) => Promise<{
      fixType: string
      fingerprint: string
      description: string
      classificationConfidence: number
      knownPattern?: unknown
    }>
    assessRisk: (task: unknown) => Promise<string>
  }
}

/**
 * Build a minimal AgentTask-compatible object for assessRisk tests.
 */
function makeTask(errorMessage: string, stackTrace = '') {
  return {
    id: 'task-1',
    type: 'fix_bug',
    priority: 'normal',
    projectId: 'proj-1',
    organizationId: 'org-1',
    payload: { errorMessage, stackTrace },
    requestedBy: 'system',
    autonomyLevel: 'semi',
    createdAt: new Date(),
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FixerAgent', () => {
  let agent: FixerAgent

  beforeEach(() => {
    vi.clearAllMocks()
    process.env['ANTHROPIC_API_KEY'] = 'test-key'
    process.env['GITHUB_TOKEN'] = 'test-token'
    agent = new FixerAgent()
  })

  // -------------------------------------------------------------------------
  // computeFingerprint — tested indirectly via classifyFixType output
  // -------------------------------------------------------------------------

  describe('computeFingerprint (stable deduplication)', () => {
    beforeEach(() => {
      // No known patterns in the DB — falls through to new_error
      vi.mocked(prisma.fixPattern.findFirst).mockResolvedValue(null)
    })

    it('produces the same fingerprint for two messages that differ only in hex address', async () => {
      const msg1 = 'Segfault at 0x7fff1234abcd in module core'
      const msg2 = 'Segfault at 0x0000beef in module core'

      const r1 = await priv(agent).classifyFixType(msg1, 'proj-1')
      const r2 = await priv(agent).classifyFixType(msg2, 'proj-1')

      expect(r1.fingerprint).toBe(r2.fingerprint)
    })

    it('strips different hex addresses so fingerprints are equal regardless of address value', async () => {
      const base = 'Error: cannot read property of null at 0xABCDEF'
      const variant = 'Error: cannot read property of null at 0x123456'

      const r1 = await priv(agent).classifyFixType(base, 'proj-1')
      const r2 = await priv(agent).classifyFixType(variant, 'proj-1')

      expect(r1.fingerprint).toBe(r2.fingerprint)
    })

    it('produces the same fingerprint for messages that differ only in line number', async () => {
      const msg1 = 'TypeError: undefined is not a function at line 42 in handler.ts'
      const msg2 = 'TypeError: undefined is not a function at line 99 in handler.ts'

      const r1 = await priv(agent).classifyFixType(msg1, 'proj-1')
      const r2 = await priv(agent).classifyFixType(msg2, 'proj-1')

      expect(r1.fingerprint).toBe(r2.fingerprint)
    })

    it('produces the same fingerprint for messages with different UUIDs', async () => {
      const msg1 = 'Task 550e8400-e29b-41d4-a716-446655440000 failed with error'
      const msg2 = 'Task a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11 failed with error'

      const r1 = await priv(agent).classifyFixType(msg1, 'proj-1')
      const r2 = await priv(agent).classifyFixType(msg2, 'proj-1')

      expect(r1.fingerprint).toBe(r2.fingerprint)
    })

    it('produces DIFFERENT fingerprints for semantically different errors', async () => {
      const msg1 = 'TypeError: cannot read null at 0xABCD'
      const msg2 = 'ReferenceError: x is not defined at 0xABCD'

      const r1 = await priv(agent).classifyFixType(msg1, 'proj-1')
      const r2 = await priv(agent).classifyFixType(msg2, 'proj-1')

      expect(r1.fingerprint).not.toBe(r2.fingerprint)
    })

    it('lowercases the entire message before fingerprinting', async () => {
      const msg1 = 'TypeError: CANNOT READ PROPERTY at 0xABCD'
      const msg2 = 'typeerror: cannot read property at 0xABCD'

      const r1 = await priv(agent).classifyFixType(msg1, 'proj-1')
      const r2 = await priv(agent).classifyFixType(msg2, 'proj-1')

      expect(r1.fingerprint).toBe(r2.fingerprint)
    })
  })

  // -------------------------------------------------------------------------
  // classifyFixType — routing logic
  // -------------------------------------------------------------------------

  describe('classifyFixType', () => {
    it('returns "dependency_vulnerability" when error contains "CVE-"', async () => {
      const result = await priv(agent).classifyFixType('CVE-2023-44487 found in package', 'proj-1')
      expect(result.fixType).toBe('dependency_vulnerability')
      expect(result.classificationConfidence).toBeGreaterThan(0.9)
    })

    it('returns "dependency_vulnerability" for npm audit keyword', async () => {
      const result = await priv(agent).classifyFixType('npm audit found a vulnerability in lodash', 'proj-1')
      expect(result.fixType).toBe('dependency_vulnerability')
    })

    it('returns "dependency_vulnerability" for GHSA advisory ID', async () => {
      const result = await priv(agent).classifyFixType('GHSA-1234-5678-9abc advisory applies', 'proj-1')
      expect(result.fixType).toBe('dependency_vulnerability')
    })

    it('returns "known_error_pattern" when a matching FixPattern exists in the DB', async () => {
      vi.mocked(prisma.fixPattern.findFirst).mockResolvedValue({
        id: 'pattern-1',
        projectId: 'proj-1',
        errorFingerprint: 'some-fingerprint',
        errorDescription: 'Null pointer in checkout',
        fixApplied: '[]',
        filesChanged: [],
        successCount: 9,
        failureCount: 1,
        lastApplied: new Date(),
        avgTimeToFixSec: 30,
      } as never)

      const result = await priv(agent).classifyFixType('TypeError: null pointer in checkout', 'proj-1')
      expect(result.fixType).toBe('known_error_pattern')
      expect(result.knownPattern).toBeDefined()
    })

    it('returns "new_error" when no pattern matches and no vulnerability keywords present', async () => {
      vi.mocked(prisma.fixPattern.findFirst).mockResolvedValue(null)
      const result = await priv(agent).classifyFixType('Something went wrong in the UI layer', 'proj-1')
      expect(result.fixType).toBe('new_error')
    })
  })

  // -------------------------------------------------------------------------
  // assessRisk — HIGH_RISK_KEYWORDS detection
  // -------------------------------------------------------------------------

  describe('assessRisk', () => {
    it('returns "high" when error message contains "auth"', async () => {
      const task = makeTask('Authentication failure in the auth middleware')
      const risk = await priv(agent).assessRisk(task)
      expect(risk).toBe('high')
    })

    it('returns "high" when error message contains "payment"', async () => {
      const task = makeTask('Payment processing error: card declined')
      const risk = await priv(agent).assessRisk(task)
      expect(risk).toBe('high')
    })

    it('returns "high" when error message contains "stripe"', async () => {
      const task = makeTask('Stripe webhook signature verification failed')
      const risk = await priv(agent).assessRisk(task)
      expect(risk).toBe('high')
    })

    it('returns "high" when error message contains "database migration"', async () => {
      const task = makeTask('Error during database migration: column not found')
      const risk = await priv(agent).assessRisk(task)
      expect(risk).toBe('high')
    })

    it('returns "high" when error message contains "jwt"', async () => {
      const task = makeTask('JWT token verification failed: signature mismatch')
      const risk = await priv(agent).assessRisk(task)
      expect(risk).toBe('high')
    })

    it('returns "high" when HIGH_RISK keyword appears in the stack trace (not just message)', async () => {
      const task = makeTask('Unexpected error occurred', 'at authMiddleware (/app/src/auth/middleware.ts:45)')
      const risk = await priv(agent).assessRisk(task)
      expect(risk).toBe('high')
    })

    it('returns "medium" when error message contains "api" (medium-risk term)', async () => {
      const task = makeTask('API endpoint returned 500 for /v1/users')
      const risk = await priv(agent).assessRisk(task)
      expect(risk).toBe('medium')
    })

    it('returns "medium" when error message contains "schema"', async () => {
      const task = makeTask('Schema validation error in request body')
      const risk = await priv(agent).assessRisk(task)
      expect(risk).toBe('medium')
    })

    it('returns "low" for a benign UI error with no risk keywords', async () => {
      const task = makeTask('TypeError: cannot read property "color" of undefined in ThemeProvider')
      const risk = await priv(agent).assessRisk(task)
      expect(risk).toBe('low')
    })

    it('returns "low" for a generic logging error', async () => {
      const task = makeTask('Log formatter failed to serialise object')
      const risk = await priv(agent).assessRisk(task)
      expect(risk).toBe('low')
    })

    it('is case-insensitive — "AUTH" matches the "auth" keyword', async () => {
      const task = makeTask('AUTH SERVICE UNAVAILABLE')
      const risk = await priv(agent).assessRisk(task)
      expect(risk).toBe('high')
    })
  })

  // -------------------------------------------------------------------------
  // handleTask — high-risk gate
  // -------------------------------------------------------------------------

  describe('handleTask — high-risk approval gate', () => {
    it('blocks a fix_bug task when risk assessment returns high and sets approvalRequested', async () => {
      vi.mocked(prisma.fixPattern.findFirst).mockResolvedValue(null)

      const task = {
        id: 'task-gate',
        type: 'fix_bug' as const,
        priority: 'high' as const,
        projectId: 'proj-1',
        organizationId: 'org-1',
        payload: { errorMessage: 'authentication token expired' },
        requestedBy: 'system' as const,
        autonomyLevel: 'semi' as const,
        createdAt: new Date(),
      }

      const result = await agent.handleTask(task)

      expect(result.approvalRequested).toBe(true)
      expect(result.success).toBe(false)
      expect(result.summary).toContain('high')
    })

    it('defers to Security Agent for a dependency_vulnerability error', async () => {
      vi.mocked(prisma.fixPattern.findFirst).mockResolvedValue(null)

      const task = {
        id: 'task-vuln',
        type: 'fix_bug' as const,
        priority: 'high' as const,
        projectId: 'proj-1',
        organizationId: 'org-1',
        payload: { errorMessage: 'CVE-2023-1234 found in express package' },
        requestedBy: 'system' as const,
        autonomyLevel: 'semi' as const,
        createdAt: new Date(),
      }

      const result = await agent.handleTask(task)

      expect(result.success).toBe(true)
      expect(result.fixType).toBe('dependency_vulnerability')
      expect(result.summary).toContain('Security Agent')
    })
  })
})
