/**
 * Confidence Engine
 *
 * Scores every proposed deployment/action 0-100 based on observable signals.
 * Produces a human-readable recommendation and risk factors.
 *
 * Thresholds:
 * - 85+: auto_deploy
 * - 65-84: recommend (show to founder, one-click approve)
 * - 40-64: hold (requires explicit approval + justification)
 * - <40: block (don't allow even with approval until issues resolved)
 */

import { createLogger } from '@forge/shared'
import type { ConfidenceScore, ConfidenceRecommendation } from '@forge/shared'
import { prisma } from '@forge/database'

const log = createLogger('confidence-engine')

// ---------------------------------------------------------------------------
// Score inputs
// ---------------------------------------------------------------------------

export interface ConfidenceInputs {
  projectId: string
  commitSha?: string
  prNumber?: number

  // CI/CD signals
  ciPassing: boolean
  ciCoverage?: number          // 0-100

  // Staging signals
  stagingDeployedAt?: Date     // when was staging last deployed?
  stagingErrorRate?: number    // errors per minute in staging
  stagingMinutesStable?: number

  // Security signals
  securityScanPassed: boolean
  criticalVulnerabilities?: number
  highVulnerabilities?: number
  secretsFound?: boolean

  // Module stability signals
  changedFiles?: string[]
  incidentRateForChangedModules?: number  // incidents per 30 days across changed modules

  // Timing signals
  deploymentTime?: Date  // when deploy is planned
}

// ---------------------------------------------------------------------------
// Confidence Engine
// ---------------------------------------------------------------------------

export class ConfidenceEngine {
  /**
   * Compute a full confidence score for a proposed action.
   */
  async compute(inputs: ConfidenceInputs): Promise<ConfidenceScore> {
    const breakdown = {
      testCoverage: this.scoreTestCoverage(inputs),      // max 20
      moduleStability: await this.scoreModuleStability(inputs),  // max 15
      ciPassing: this.scoreCi(inputs),                   // max 20
      stagingStability: this.scoreStagingStability(inputs), // max 20
      securityClean: this.scoreSecurityClean(inputs),    // max 15
      deployTiming: this.scoreDeployTiming(inputs),      // max 10
    }

    const total = Object.values(breakdown).reduce((sum, v) => sum + v, 0)
    const clamped = Math.max(0, Math.min(100, Math.round(total)))

    const recommendation = this.getRecommendation(clamped)
    const riskFactors = this.collectRiskFactors(inputs, breakdown)
    const humanReadableSummary = this.buildSummary(clamped, recommendation, riskFactors)

    log.info(
      { projectId: inputs.projectId, total: clamped, recommendation },
      'Confidence score computed',
    )

    return {
      total: clamped,
      breakdown,
      recommendation,
      humanReadableSummary,
      riskFactors,
    }
  }

  // ---------------------------------------------------------------------------
  // Individual scorers
  // ---------------------------------------------------------------------------

  private scoreTestCoverage(inputs: ConfidenceInputs): number {
    // Max 20 points
    if (!inputs.ciPassing) return 0  // CI must pass first
    const coverage = inputs.ciCoverage ?? 0

    if (coverage >= 80) return 20
    if (coverage >= 60) return 15
    if (coverage >= 40) return 10
    if (coverage >= 20) return 5
    return 0
  }

  private async scoreModuleStability(inputs: ConfidenceInputs): Promise<number> {
    // Max 15 points
    // Based on incident history of changed modules
    if (!inputs.changedFiles || inputs.changedFiles.length === 0) return 15

    try {
      // Count recent incidents in modules that were changed
      const recentIncidents = await prisma.incident.count({
        where: {
          projectId: inputs.projectId,
          detectedAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
          affectedModules: { hasSome: inputs.changedFiles },
        },
      })

      if (recentIncidents === 0) return 15
      if (recentIncidents === 1) return 10
      if (recentIncidents <= 3) return 5
      return 0
    } catch {
      // If we can't query, return partial score
      return 8
    }
  }

  private scoreCi(inputs: ConfidenceInputs): number {
    // Max 20 points
    if (!inputs.ciPassing) return 0
    return 20
  }

  private scoreStagingStability(inputs: ConfidenceInputs): number {
    // Max 20 points
    if (!inputs.stagingDeployedAt) return 5  // no staging = partial score

    const minutesInStaging = inputs.stagingMinutesStable ?? 0
    const errorRate = inputs.stagingErrorRate ?? 0

    // Penalize high error rates in staging
    if (errorRate > 10) return 0
    if (errorRate > 5) return 5

    // Reward time stability in staging
    if (minutesInStaging >= 60) return 20
    if (minutesInStaging >= 30) return 15
    if (minutesInStaging >= 15) return 10
    if (minutesInStaging >= 5) return 7
    return 3
  }

  private scoreSecurityClean(inputs: ConfidenceInputs): number {
    // Max 15 points
    if (inputs.secretsFound) return 0  // secrets = immediate block
    if (!inputs.securityScanPassed) return 0

    let score = 15

    // Deduct for vulnerabilities
    score -= (inputs.criticalVulnerabilities ?? 0) * 5
    score -= (inputs.highVulnerabilities ?? 0) * 2

    return Math.max(0, score)
  }

  private scoreDeployTiming(inputs: ConfidenceInputs): number {
    // Max 10 points
    // Penalize deployments on Fridays/weekends and outside business hours
    const deployAt = inputs.deploymentTime ?? new Date()
    const day = deployAt.getDay()      // 0=Sun, 6=Sat
    const hour = deployAt.getUTCHours()

    // Weekend
    if (day === 0 || day === 6) return 2

    // Friday afternoon (high-risk window)
    if (day === 5 && hour >= 14) return 3

    // Outside business hours (roughly 8am-6pm UTC)
    if (hour < 8 || hour >= 18) return 5

    return 10
  }

  // ---------------------------------------------------------------------------
  // Thresholds & output builders
  // ---------------------------------------------------------------------------

  private getRecommendation(total: number): ConfidenceRecommendation {
    if (total >= 85) return 'auto_deploy'
    if (total >= 65) return 'recommend'
    if (total >= 40) return 'hold'
    return 'block'
  }

  private collectRiskFactors(
    inputs: ConfidenceInputs,
    breakdown: ConfidenceScore['breakdown'],
  ): string[] {
    const factors: string[] = []

    if (!inputs.ciPassing) factors.push('CI tests are failing')
    if (inputs.secretsFound) factors.push('Secrets detected in code — must rotate before deploying')
    if ((inputs.criticalVulnerabilities ?? 0) > 0) {
      factors.push(`${inputs.criticalVulnerabilities} critical security vulnerabilities`)
    }
    if ((inputs.highVulnerabilities ?? 0) >= 3) {
      factors.push(`${inputs.highVulnerabilities} high severity vulnerabilities`)
    }
    if (breakdown.stagingStability < 10) {
      factors.push('Insufficient stability time in staging')
    }
    if (breakdown.testCoverage < 10) {
      factors.push('Test coverage is low (under 60%)')
    }
    if (breakdown.deployTiming < 5) {
      factors.push('Deploying on Friday afternoon or weekend — high risk window')
    }
    if (breakdown.moduleStability < 8) {
      factors.push('Changed modules have recent incident history')
    }

    return factors
  }

  private buildSummary(
    total: number,
    recommendation: ConfidenceRecommendation,
    riskFactors: string[],
  ): string {
    const messages: Record<ConfidenceRecommendation, string> = {
      auto_deploy: `Score ${total}/100 — all signals green. Safe to deploy automatically.`,
      recommend: `Score ${total}/100 — mostly ready. Recommend deploying with founder approval.`,
      hold: `Score ${total}/100 — some concerns. ${riskFactors[0] ?? 'Review before deploying'}.`,
      block: `Score ${total}/100 — not safe to deploy. Critical issues: ${riskFactors.slice(0, 2).join('; ')}.`,
    }

    return messages[recommendation]
  }
}
