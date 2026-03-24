/**
 * @forge/agent-security — Unit Tests
 *
 * Tests the SecurityAgent's severity mapping helpers, secret classification,
 * composite security scoring, grade thresholds, and the npm audit result
 * mapping pipeline (via a mocked execFileAsync).
 *
 * All external dependencies are fully mocked — no network or database access.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Module mocks — declared before any imports that load the mocked modules
// ---------------------------------------------------------------------------

vi.mock('@forge/database', () => ({
  prisma: {
    securityScan: {
      findMany: vi.fn(),
      create: vi.fn().mockResolvedValue({ id: 'scan-1' }),
    },
    project: {
      findUniqueOrThrow: vi.fn(),
    },
    incident: {
      create: vi.fn().mockResolvedValue({ id: 'incident-1' }),
      update: vi.fn(),
    },
  },
}))

vi.mock('@anthropic-ai/sdk', () => {
  const MockAnthropic = vi.fn().mockImplementation(() => ({
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'Remediation guidance here.' }],
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
  }),
  createContextLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))

// ---------------------------------------------------------------------------
// Mock child_process at the module level so `promisify(execFile)` wraps our
// mock function. vi.hoisted() ensures the variable is available when the
// vi.mock() factory runs (vi.mock calls are hoisted above regular code).
// ---------------------------------------------------------------------------

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }))

vi.mock('child_process', () => ({
  execFile: execFileMock,
}))

// ---------------------------------------------------------------------------
// Import subject under test (after mocks)
// ---------------------------------------------------------------------------

import { SecurityAgent } from './index'
import { prisma } from '@forge/database'

// ---------------------------------------------------------------------------
// Private method accessor — bypass TypeScript access control for unit tests
// ---------------------------------------------------------------------------

function priv(agent: SecurityAgent) {
  return agent as unknown as {
    mapNpmSeverity: (s: string) => string
    mapSemgrepSeverity: (s: string) => string
    classifySecretType: (description: string, rawValue?: string) => string
  }
}

// ---------------------------------------------------------------------------
// npm audit JSON builder
// ---------------------------------------------------------------------------

function makeNpmAuditJson(opts: {
  critical?: number
  high?: number
  moderate?: number
  low?: number
  pkgName?: string
  pkgRange?: string
  pkgFixVersion?: string
} = {}) {
  const critical = opts.critical ?? 0
  const high = opts.high ?? 0
  const moderate = opts.moderate ?? 0
  const low = opts.low ?? 0
  const pkgName = opts.pkgName ?? 'lodash'
  const pkgRange = opts.pkgRange ?? '<4.17.21'
  const pkgFixVersion = opts.pkgFixVersion ?? '4.17.21'

  return JSON.stringify({
    auditReportVersion: 2,
    vulnerabilities: {
      [pkgName]: {
        name: pkgName,
        severity: critical > 0 ? 'critical' : high > 0 ? 'high' : moderate > 0 ? 'moderate' : 'low',
        via: [{ title: 'Prototype Pollution' }],
        range: pkgRange,
        fixAvailable: { name: pkgName, version: pkgFixVersion, isSemVerMajor: false },
        isDirect: true,
      },
    },
    metadata: {
      vulnerabilities: {
        info: 0,
        low,
        moderate,
        high,
        critical,
        total: critical + high + moderate + low,
      },
    },
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SecurityAgent', () => {
  let agent: SecurityAgent

  beforeEach(() => {
    vi.clearAllMocks()
    agent = new SecurityAgent()
  })

  // -------------------------------------------------------------------------
  // mapNpmSeverity
  // -------------------------------------------------------------------------

  describe('mapNpmSeverity', () => {
    it('maps "critical" → "critical"', () => {
      expect(priv(agent).mapNpmSeverity('critical')).toBe('critical')
    })

    it('maps "high" → "high"', () => {
      expect(priv(agent).mapNpmSeverity('high')).toBe('high')
    })

    it('maps "moderate" → "medium" (npm uses "moderate", Forge uses "medium")', () => {
      expect(priv(agent).mapNpmSeverity('moderate')).toBe('medium')
    })

    it('maps "low" → "low"', () => {
      expect(priv(agent).mapNpmSeverity('low')).toBe('low')
    })

    it('maps "info" → "info"', () => {
      expect(priv(agent).mapNpmSeverity('info')).toBe('info')
    })

    it('maps any unknown severity → "info" (safe default)', () => {
      expect(priv(agent).mapNpmSeverity('unknown-severity')).toBe('info')
      expect(priv(agent).mapNpmSeverity('')).toBe('info')
    })
  })

  // -------------------------------------------------------------------------
  // mapSemgrepSeverity
  // -------------------------------------------------------------------------

  describe('mapSemgrepSeverity', () => {
    it('maps "ERROR" → "high"', () => {
      expect(priv(agent).mapSemgrepSeverity('ERROR')).toBe('high')
    })

    it('maps "WARNING" → "medium"', () => {
      expect(priv(agent).mapSemgrepSeverity('WARNING')).toBe('medium')
    })

    it('maps "INFO" → "info"', () => {
      expect(priv(agent).mapSemgrepSeverity('INFO')).toBe('info')
    })

    it('is case-insensitive ("error" → "high", "warning" → "medium")', () => {
      expect(priv(agent).mapSemgrepSeverity('error')).toBe('high')
      expect(priv(agent).mapSemgrepSeverity('warning')).toBe('medium')
      expect(priv(agent).mapSemgrepSeverity('info')).toBe('info')
    })

    it('maps unknown Semgrep severity → "info"', () => {
      expect(priv(agent).mapSemgrepSeverity('NOTICE')).toBe('info')
      expect(priv(agent).mapSemgrepSeverity('')).toBe('info')
    })
  })

  // -------------------------------------------------------------------------
  // classifySecretType
  // -------------------------------------------------------------------------

  describe('classifySecretType', () => {
    it('classifies AWS access key by "aws" in description', () => {
      expect(priv(agent).classifySecretType('AWS Access Key ID', undefined)).toBe('aws_access_key')
    })

    it('classifies AWS access key by AKIA value prefix', () => {
      expect(priv(agent).classifySecretType('Hardcoded credential', 'AKIAIOSFODNN7EXAMPLE')).toBe('aws_access_key')
    })

    it('classifies GitHub token by "github" in description', () => {
      expect(priv(agent).classifySecretType('GitHub Personal Access Token', undefined)).toBe('github_token')
    })

    it('classifies GitHub token by "ghp_" value prefix', () => {
      expect(priv(agent).classifySecretType('Token found', 'ghp_16C7e42F292c6912E7710c838347Ae178B4a')).toBe('github_token')
    })

    it('classifies Stripe key by "stripe" in description', () => {
      expect(priv(agent).classifySecretType('Stripe Secret Key', undefined)).toBe('stripe_key')
    })

    it('classifies Stripe key by "sk_" value prefix', () => {
      expect(priv(agent).classifySecretType('Hardcoded API key', 'sk_live_abc123def456')).toBe('stripe_key')
    })

    it('classifies OpenAI key by "openai" in description', () => {
      expect(priv(agent).classifySecretType('OpenAI API Key', undefined)).toBe('openai_key')
    })

    it('classifies OpenAI key by "sk-" value prefix', () => {
      expect(priv(agent).classifySecretType('API key found in source', 'sk-proj-abc123')).toBe('openai_key')
    })

    it('classifies Anthropic key by "anthropic" in description', () => {
      expect(priv(agent).classifySecretType('Anthropic API Key', undefined)).toBe('anthropic_key')
    })

    it('classifies database URL by "postgres" in description', () => {
      expect(priv(agent).classifySecretType('postgres connection string found', undefined)).toBe('database_url')
    })

    it('classifies database URL by "database" in description', () => {
      expect(priv(agent).classifySecretType('database url exposed', undefined)).toBe('database_url')
    })

    it('classifies JWT secret by "jwt" in description', () => {
      expect(priv(agent).classifySecretType('JWT signing secret', undefined)).toBe('jwt_secret')
    })

    it('classifies as "jwt_secret" when description contains "secret" (generic secret fallback)', () => {
      // "secret" is the last keyword before the generic fallback
      expect(priv(agent).classifySecretType('generic secret value', undefined)).toBe('jwt_secret')
    })

    it('falls back to "generic" for unrecognised descriptions and values', () => {
      expect(priv(agent).classifySecretType('unknown credential type', 'not-a-known-prefix')).toBe('generic')
    })
  })

  // -------------------------------------------------------------------------
  // computeSecurityScore — weighted scoring formula
  // -------------------------------------------------------------------------

  describe('computeSecurityScore', () => {
    it('returns score 100 and grade A when no scans exist in the last 30 days', async () => {
      vi.mocked(prisma.securityScan.findMany).mockResolvedValue([])
      const result = await agent.computeSecurityScore('proj-clean')
      expect(result.score).toBe(100)
      expect(result.grade).toBe('A')
      expect(result.projectId).toBe('proj-clean')
    })

    it('deducts 20 per DEPENDENCY_AUDIT critical vulnerability', async () => {
      vi.mocked(prisma.securityScan.findMany).mockResolvedValue([
        { id: '1', scanType: 'DEPENDENCY_AUDIT', data: { critical: 2, high: 0, medium: 0, low: 0 }, createdAt: new Date() } as never,
      ])
      const result = await agent.computeSecurityScore('proj-critical')
      expect(result.score).toBe(60) // 100 - 2*20
    })

    it('deducts 10 per DEPENDENCY_AUDIT high vulnerability', async () => {
      vi.mocked(prisma.securityScan.findMany).mockResolvedValue([
        { id: '1', scanType: 'DEPENDENCY_AUDIT', data: { critical: 0, high: 3, medium: 0, low: 0 }, createdAt: new Date() } as never,
      ])
      const result = await agent.computeSecurityScore('proj-high')
      expect(result.score).toBe(70) // 100 - 3*10
    })

    it('deducts 5 per DEPENDENCY_AUDIT medium vulnerability', async () => {
      vi.mocked(prisma.securityScan.findMany).mockResolvedValue([
        { id: '1', scanType: 'DEPENDENCY_AUDIT', data: { critical: 0, high: 0, medium: 4, low: 0 }, createdAt: new Date() } as never,
      ])
      const result = await agent.computeSecurityScore('proj-medium')
      expect(result.score).toBe(80) // 100 - 4*5
    })

    it('deducts 1 per DEPENDENCY_AUDIT low vulnerability', async () => {
      vi.mocked(prisma.securityScan.findMany).mockResolvedValue([
        { id: '1', scanType: 'DEPENDENCY_AUDIT', data: { critical: 0, high: 0, medium: 0, low: 10 }, createdAt: new Date() } as never,
      ])
      const result = await agent.computeSecurityScore('proj-low')
      expect(result.score).toBe(90) // 100 - 10*1
    })

    it('deducts 25 per exposed secret in SECRET_DETECTION scans', async () => {
      vi.mocked(prisma.securityScan.findMany).mockResolvedValue([
        { id: '1', scanType: 'SECRET_DETECTION', data: { secretsFound: 2 }, createdAt: new Date() } as never,
      ])
      const result = await agent.computeSecurityScore('proj-secrets')
      expect(result.score).toBe(50) // 100 - 2*25
    })

    it('deducts 10 per SAST high finding and 3 per SAST medium finding', async () => {
      vi.mocked(prisma.securityScan.findMany).mockResolvedValue([
        { id: '1', scanType: 'SAST', data: { high: 2, medium: 3 }, createdAt: new Date() } as never,
      ])
      const result = await agent.computeSecurityScore('proj-sast')
      expect(result.score).toBe(71) // 100 - 2*10 - 3*3 = 71
    })

    it('clamps score to a minimum of 0 when deductions exceed 100', async () => {
      vi.mocked(prisma.securityScan.findMany).mockResolvedValue([
        { id: '1', scanType: 'DEPENDENCY_AUDIT', data: { critical: 10, high: 5, medium: 5, low: 5 }, createdAt: new Date() } as never,
      ])
      const result = await agent.computeSecurityScore('proj-clamped')
      expect(result.score).toBe(0)
    })

    it('accumulates deductions across multiple scan records', async () => {
      vi.mocked(prisma.securityScan.findMany).mockResolvedValue([
        { id: '1', scanType: 'DEPENDENCY_AUDIT', data: { critical: 1, high: 0, medium: 0, low: 0 }, createdAt: new Date() } as never,
        { id: '2', scanType: 'SECRET_DETECTION', data: { secretsFound: 1 }, createdAt: new Date() } as never,
        { id: '3', scanType: 'SAST', data: { high: 1, medium: 0 }, createdAt: new Date() } as never,
      ])
      const result = await agent.computeSecurityScore('proj-combined')
      expect(result.score).toBe(45) // 100 - 20 - 25 - 10 = 45
    })
  })

  // -------------------------------------------------------------------------
  // Grade thresholds
  // -------------------------------------------------------------------------

  describe('grade thresholds', () => {
    /**
     * Helper: produce a score by controlling the number of low vulns
     * (each costs 1 point). Then return the grade from computeSecurityScore.
     */
    async function gradeForScore(targetScore: number): Promise<string> {
      const low = 100 - targetScore
      vi.mocked(prisma.securityScan.findMany).mockResolvedValue(
        low > 0
          ? [{ id: '1', scanType: 'DEPENDENCY_AUDIT', data: { critical: 0, high: 0, medium: 0, low }, createdAt: new Date() } as never]
          : [],
      )
      const result = await agent.computeSecurityScore('proj-grade')
      return result.grade
    }

    it('score 100 → grade A', async () => expect(await gradeForScore(100)).toBe('A'))
    it('score 90 → grade A', async () => expect(await gradeForScore(90)).toBe('A'))
    it('score 89 → grade B', async () => expect(await gradeForScore(89)).toBe('B'))
    it('score 80 → grade B', async () => expect(await gradeForScore(80)).toBe('B'))
    it('score 79 → grade C', async () => expect(await gradeForScore(79)).toBe('C'))
    it('score 70 → grade C', async () => expect(await gradeForScore(70)).toBe('C'))
    it('score 69 → grade D', async () => expect(await gradeForScore(69)).toBe('D'))
    it('score 60 → grade D', async () => expect(await gradeForScore(60)).toBe('D'))
    it('score 59 → grade F', async () => expect(await gradeForScore(59)).toBe('F'))
  })

  // -------------------------------------------------------------------------
  // runDependencyAudit — npm audit JSON mapping via mocked execFile
  // -------------------------------------------------------------------------

  describe('runDependencyAudit', () => {
    beforeEach(() => {
      vi.mocked(prisma.securityScan.create).mockResolvedValue({ id: 'scan-1' } as never)
      vi.mocked(prisma.project.findUniqueOrThrow).mockResolvedValue({
        id: 'proj-1',
        repoUrl: 'https://github.com/test/repo',
      } as never)

      // Default: npm audit exits 0 (no vulns) — callback receives stdout
      execFileMock.mockImplementation(
        (_cmd: string, _args: string[], _opts: object, callback: (err: null, result: { stdout: string; stderr: string }) => void) => {
          callback(null, {
            stdout: makeNpmAuditJson({ critical: 1 }),
            stderr: '',
          })
          return undefined
        },
      )
    })

    it('returns the correct vulnerability counts from npm audit JSON', () => {
      execFileMock.mockImplementationOnce(
        (_cmd: string, _args: string[], _opts: object, callback: (err: null, result: { stdout: string; stderr: string }) => void) => {
          callback(null, {
            stdout: makeNpmAuditJson({ critical: 1, high: 2, moderate: 3, low: 4 }),
            stderr: '',
          })
          return undefined
        },
      )

      return agent.runDependencyAudit('proj-1', '/tmp/test-repo').then((result) => {
        expect(result.critical).toBe(1)
        expect(result.high).toBe(2)
        expect(result.medium).toBe(3)
        expect(result.low).toBe(4)
        expect(result.totalVulnerabilities).toBe(10)
      })
    })

    it('maps the vulnerability package name and severity correctly', async () => {
      const result = await agent.runDependencyAudit('proj-1', '/tmp/test-repo')
      expect(result.vulnerabilities).toHaveLength(1)
      expect(result.vulnerabilities[0]!.severity).toBe('critical')
      expect(result.vulnerabilities[0]!.packageName).toBe('lodash')
    })

    it('sets fixedVersion from fixAvailable.version', async () => {
      const result = await agent.runDependencyAudit('proj-1', '/tmp/test-repo')
      expect(result.vulnerabilities[0]!.fixedVersion).toBe('4.17.21')
    })

    it('persists a DEPENDENCY_AUDIT security scan record to the database', async () => {
      await agent.runDependencyAudit('proj-1', '/tmp/test-repo')
      expect(prisma.securityScan.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            projectId: 'proj-1',
            scanType: 'DEPENDENCY_AUDIT',
          }),
        }),
      )
    })

    it('handles npm audit non-zero exit by reading stdout from the error object', async () => {
      // npm exits 1 when vulnerabilities are found — promisify wraps this in an error
      execFileMock.mockImplementationOnce(
        (_cmd: string, _args: string[], _opts: object, callback: (err: { stdout: string; code: number }, result: null) => void) => {
          callback({ stdout: makeNpmAuditJson({ critical: 2, high: 1 }), code: 1 }, null)
          return undefined
        },
      )

      const result = await agent.runDependencyAudit('proj-1', '/tmp/test-repo')
      expect(result.critical).toBe(2)
      expect(result.high).toBe(1)
      expect(result.totalVulnerabilities).toBe(3)
    })
  })
})
