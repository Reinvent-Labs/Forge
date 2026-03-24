/**
 * @forge/agent-debt — Unit Tests
 *
 * Tests the DebtAgent's scoring formula, TODO/FIXME/HACK comment detection,
 * cyclomatic complexity counting, and outdated dependency detection.
 *
 * All database and Anthropic SDK calls are fully mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('@forge/database', () => ({
  prisma: {
    debtItem: {
      findMany: vi.fn(),
      upsert: vi.fn(),
      updateMany: vi.fn(),
    },
    codebaseContext: {
      findFirst: vi.fn(),
    },
    incident: {
      count: vi.fn(),
    },
  },
}))

vi.mock('@anthropic-ai/sdk', () => {
  const MockAnthropic = vi.fn().mockImplementation(() => ({
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              topItems: [{ index: 1, businessCase: 'Fix this now', remediationPriority: 1 }],
              suggestedSequencing: 'Fix critical items first',
              executiveSummary: 'The codebase has moderate debt.',
            }),
          },
        ],
      }),
    },
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

import { DebtAgent } from './index'
import { prisma } from '@forge/database'

// ---------------------------------------------------------------------------
// Private method accessor
// ---------------------------------------------------------------------------

/**
 * Type-cast to expose private detection helpers for direct unit testing.
 * This avoids the need to drive them through the full scanForDebt pipeline
 * (which would pull in DB calls for every file).
 */
function priv(agent: DebtAgent) {
  return agent as unknown as {
    detectTodoComments: (projectId: string, filePath: string, content: string) => Array<{ severity: string; filePath: string }>
    detectHighComplexity: (projectId: string, filePath: string, content: string) => Array<{ severity: string; filePath: string }>
    detectOutdatedDependencies: (projectId: string, fileContents: Record<string, string>) => Promise<Array<{ type: string; severity: string; plainEnglishDescription: string }>>
    detectMissingErrorHandling: (projectId: string, filePath: string, content: string) => Array<{ severity: string }>
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DebtAgent', () => {
  let agent: DebtAgent

  beforeEach(() => {
    vi.clearAllMocks()
    agent = new DebtAgent()
  })

  // -------------------------------------------------------------------------
  // computeDebtScore — scoring formula
  // -------------------------------------------------------------------------

  describe('computeDebtScore', () => {
    it('returns 100 when there are no unresolved debt items', async () => {
      vi.mocked(prisma.debtItem.findMany).mockResolvedValue([])
      const score = await agent.computeDebtScore('proj-clean')
      expect(score).toBe(100)
    })

    it('deducts 20 per CRITICAL item', async () => {
      vi.mocked(prisma.debtItem.findMany).mockResolvedValue([
        { severity: 'CRITICAL' } as never,
        { severity: 'CRITICAL' } as never,
      ])
      const score = await agent.computeDebtScore('proj-critical')
      // 100 - 2*20 = 60
      expect(score).toBe(60)
    })

    it('deducts 10 per HIGH item', async () => {
      vi.mocked(prisma.debtItem.findMany).mockResolvedValue([
        { severity: 'HIGH' } as never,
        { severity: 'HIGH' } as never,
        { severity: 'HIGH' } as never,
      ])
      const score = await agent.computeDebtScore('proj-high')
      // 100 - 3*10 = 70
      expect(score).toBe(70)
    })

    it('deducts 5 per MEDIUM item', async () => {
      vi.mocked(prisma.debtItem.findMany).mockResolvedValue([
        { severity: 'MEDIUM' } as never,
        { severity: 'MEDIUM' } as never,
      ])
      const score = await agent.computeDebtScore('proj-medium')
      // 100 - 2*5 = 90
      expect(score).toBe(90)
    })

    it('deducts 1 per LOW item', async () => {
      vi.mocked(prisma.debtItem.findMany).mockResolvedValue([
        { severity: 'LOW' } as never,
        { severity: 'LOW' } as never,
        { severity: 'LOW' } as never,
        { severity: 'LOW' } as never,
        { severity: 'LOW' } as never,
      ])
      const score = await agent.computeDebtScore('proj-low')
      // 100 - 5*1 = 95
      expect(score).toBe(95)
    })

    it('applies mixed severity deductions correctly', async () => {
      vi.mocked(prisma.debtItem.findMany).mockResolvedValue([
        { severity: 'CRITICAL' } as never, // -20
        { severity: 'HIGH' } as never,      // -10
        { severity: 'MEDIUM' } as never,    // -5
        { severity: 'LOW' } as never,       // -1
      ])
      const score = await agent.computeDebtScore('proj-mixed')
      // 100 - 20 - 10 - 5 - 1 = 64
      expect(score).toBe(64)
    })

    it('clamps score to 0 when deductions exceed 100', async () => {
      // 6 CRITICAL items = 120 deduction > 100
      vi.mocked(prisma.debtItem.findMany).mockResolvedValue(
        Array.from({ length: 6 }, () => ({ severity: 'CRITICAL' } as never)),
      )
      const score = await agent.computeDebtScore('proj-clamped')
      expect(score).toBe(0)
    })

    it('returns 0 on database error (safe fallback)', async () => {
      vi.mocked(prisma.debtItem.findMany).mockRejectedValue(new Error('DB connection failed'))
      const score = await agent.computeDebtScore('proj-db-error')
      expect(score).toBe(0)
    })
  })

  // -------------------------------------------------------------------------
  // detectTodoComments — regex detection
  // -------------------------------------------------------------------------

  describe('detectTodoComments (regex pattern matching)', () => {
    it('detects a // TODO: comment and assigns "low" severity', () => {
      const content = [
        'function doSomething() {',
        '  // TODO: implement this properly',
        '  return null',
        '}',
      ].join('\n')
      const items = priv(agent).detectTodoComments('proj-1', 'src/util.ts', content)
      expect(items).toHaveLength(1)
      expect(items[0]!.severity).toBe('low')
    })

    it('detects a // FIXME: comment and assigns "medium" severity', () => {
      const content = '// FIXME: this breaks under load\nconst x = 1'
      const items = priv(agent).detectTodoComments('proj-1', 'src/api.ts', content)
      expect(items).toHaveLength(1)
      expect(items[0]!.severity).toBe('medium')
    })

    it('detects a // HACK: comment and assigns "medium" severity', () => {
      const content = '// HACK: workaround for library bug\nreturn undefined'
      const items = priv(agent).detectTodoComments('proj-1', 'src/hack.ts', content)
      expect(items).toHaveLength(1)
      expect(items[0]!.severity).toBe('medium')
    })

    it('detects a // TEMP: comment and assigns "low" severity', () => {
      const content = '// TEMP: remove before release\nconst flag = true'
      const items = priv(agent).detectTodoComments('proj-1', 'src/temp.ts', content)
      expect(items).toHaveLength(1)
      expect(items[0]!.severity).toBe('low')
    })

    it('detects multiple markers in the same file', () => {
      const content = [
        '// TODO: add tests',
        'function a() {}',
        '// FIXME: null check',
        'function b() {}',
        '// HACK: bandaid solution',
      ].join('\n')
      const items = priv(agent).detectTodoComments('proj-1', 'src/multi.ts', content)
      expect(items).toHaveLength(3)
    })

    it('is case-insensitive (// todo: is detected)', () => {
      const content = '// todo: lowercase works too\nconst y = 2'
      const items = priv(agent).detectTodoComments('proj-1', 'src/lower.ts', content)
      expect(items).toHaveLength(1)
    })

    it('does NOT flag normal comments without a marker', () => {
      const content = '// This is a regular comment\n// Another normal comment\nconst z = 3'
      const items = priv(agent).detectTodoComments('proj-1', 'src/clean.ts', content)
      expect(items).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // detectHighComplexity — cyclomatic complexity counting
  // -------------------------------------------------------------------------

  describe('detectHighComplexity (cyclomatic complexity counting)', () => {
    it('returns no items for a simple function below threshold (10 decision points)', () => {
      const content = [
        'function simple(x: number): number {',
        '  if (x > 0) return x',
        '  return -x',
        '}',
      ].join('\n')
      // 1 `if` keyword = 1 decision point < 10
      const items = priv(agent).detectHighComplexity('proj-1', 'src/simple.ts', content)
      expect(items).toHaveLength(0)
    })

    it('flags a file with more than 10 decision points', () => {
      // Generate code with 12 if statements
      const ifStatements = Array.from({ length: 12 }, (_, i) => `  if (x === ${i}) return ${i}`).join('\n')
      const content = `function complex(x: number): number {\n${ifStatements}\n  return -1\n}`
      const items = priv(agent).detectHighComplexity('proj-1', 'src/complex.ts', content)
      expect(items).toHaveLength(1)
    })

    it('assigns "medium" severity when complexity is 11-30 decision points', () => {
      // 15 decision points (if keywords)
      const content = Array.from({ length: 15 }, (_, i) => `if (a${i}) { b${i}() }`).join('\n')
      const items = priv(agent).detectHighComplexity('proj-1', 'src/medium.ts', content)
      expect(items).toHaveLength(1)
      expect(items[0]!.severity).toBe('medium')
    })

    it('assigns "high" severity when complexity exceeds 30 decision points', () => {
      // 35 decision points
      const content = Array.from({ length: 35 }, (_, i) => `if (a${i}) { b${i}() }`).join('\n')
      const items = priv(agent).detectHighComplexity('proj-1', 'src/high.ts', content)
      expect(items).toHaveLength(1)
      expect(items[0]!.severity).toBe('high')
    })

    it('counts logical operators (&& and ||) as decision points', () => {
      // 12 && operators = 12 decision points > threshold
      const conditions = Array.from({ length: 12 }, (_, i) => `a${i}`).join(' && ')
      const content = `if (${conditions}) { doSomething() }`
      const items = priv(agent).detectHighComplexity('proj-1', 'src/logical.ts', content)
      expect(items).toHaveLength(1)
    })

    it('skips non-TypeScript files (e.g. .md or .json)', () => {
      const content = 'if you want to know\n## then read this'
      const items = priv(agent).detectHighComplexity('proj-1', 'README.md', content)
      expect(items).toHaveLength(0)
    })

    it('includes the estimated hours in the debt item (ceil(complexity/10)*2)', () => {
      // 11 decision points → estimatedHours = ceil(11/10)*2 = 2
      const content = Array.from({ length: 11 }, (_, i) => `if (a${i}) { b${i}() }`).join('\n')
      const items = priv(agent).detectHighComplexity('proj-1', 'src/hours.ts', content) as Array<{ estimatedHours: number }>
      expect(items[0]!.estimatedHours).toBe(2)
    })
  })

  // -------------------------------------------------------------------------
  // detectOutdatedDependencies — 2+ major versions behind
  // -------------------------------------------------------------------------

  describe('detectOutdatedDependencies', () => {
    it('returns no items when package.json is absent from fileContents', async () => {
      const items = await priv(agent).detectOutdatedDependencies('proj-1', {
        'src/index.ts': 'export const x = 1',
      })
      expect(items).toHaveLength(0)
    })

    it('flags a dependency that is more than 2 major versions behind', async () => {
      // Mock the npm registry fetch response
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ version: '5.0.0' }),
      } as never)

      const packageJson = JSON.stringify({
        dependencies: { lodash: '^2.0.0' }, // installed: major 2, latest: 5 → gap of 3
      })

      const items = await priv(agent).detectOutdatedDependencies('proj-1', {
        'package.json': packageJson,
      })

      expect(items.length).toBeGreaterThanOrEqual(1)
      expect(items[0]!.type).toBe('dependency')
      // lodash is 3 major versions behind (3 < 4) so severity is "medium"
      expect(items[0]!.severity).toBe('medium')
      expect(items[0]!.plainEnglishDescription).toContain('lodash')
    })

    it('assigns "high" severity for a gap of 4+ major versions', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ version: '7.0.0' }),
      } as never)

      const packageJson = JSON.stringify({
        dependencies: { react: '^1.0.0' }, // installed: 1, latest: 7 → gap of 6
      })

      const items = await priv(agent).detectOutdatedDependencies('proj-1', {
        'package.json': packageJson,
      })

      expect(items.length).toBeGreaterThanOrEqual(1)
      expect(items[0]!.severity).toBe('high')
    })

    it('does NOT flag a dependency that is exactly 2 major versions behind (threshold is >2)', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ version: '4.0.0' }),
      } as never)

      // MAX_MAJOR_VERSION_GAP = 2, condition is `latestMajor - installedMajor > 2`
      const packageJson = JSON.stringify({
        dependencies: { express: '^2.0.0' }, // gap = 2 → NOT flagged
      })

      const items = await priv(agent).detectOutdatedDependencies('proj-1', {
        'package.json': packageJson,
      })

      expect(items).toHaveLength(0)
    })

    it('does NOT flag a dependency that is only 1 major version behind', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ version: '3.0.0' }),
      } as never)

      const packageJson = JSON.stringify({
        dependencies: { axios: '^2.0.0' }, // gap = 1
      })

      const items = await priv(agent).detectOutdatedDependencies('proj-1', {
        'package.json': packageJson,
      })

      expect(items).toHaveLength(0)
    })

    it('skips a dependency when the registry request fails', async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error('Network error'))

      const packageJson = JSON.stringify({
        dependencies: { 'some-package': '^1.0.0' },
      })

      // Should not throw — silently skips the failed package
      const items = await priv(agent).detectOutdatedDependencies('proj-1', {
        'package.json': packageJson,
      })

      expect(items).toHaveLength(0)
    })
  })
})
