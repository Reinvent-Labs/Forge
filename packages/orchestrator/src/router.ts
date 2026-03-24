/**
 * Agent Router
 *
 * Decides which specialized agent handles each task type.
 * Routes are deterministic and based on TaskType.
 * Priority and autonomy level are factored into queue priority.
 */

import { createLogger } from '@forge/shared'
import type { AgentTask, AgentType, TaskType } from '@forge/shared'

const log = createLogger('agent-router')

// ---------------------------------------------------------------------------
// Routing table: TaskType → AgentType
// ---------------------------------------------------------------------------

const TASK_ROUTING: Record<TaskType, AgentType> = {
  // Code work → Builder/Fixer (both use Claude Code under the hood)
  build_feature: 'builder',
  fix_bug: 'fixer',
  fix_incident: 'fixer',
  refactor: 'builder',
  generate_tests: 'builder',
  review_pr: 'builder',

  // Security → Security Agent
  security_patch: 'security',

  // Monitoring & maintenance → Watcher/Debt
  analyze_logs: 'watcher',
  classify_alert: 'watcher',
  dependency_update: 'watcher',
  update_debt_ledger: 'debt',

  // DevOps → DevOps Agent
  deploy: 'devops',
  rollback: 'devops',
  cost_analysis: 'devops',

  // Communication → Intent Agent
  translate_intent: 'intent',

  // Onboarding & analysis → Onboarding Agent
  onboard_project: 'onboarding',
  onboard_developer: 'onboarding',
  generate_postmortem: 'onboarding',
}

// ---------------------------------------------------------------------------
// Risk classification (affects autonomy gate)
// ---------------------------------------------------------------------------

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical'

const TASK_RISK: Record<TaskType, RiskLevel> = {
  build_feature: 'medium',
  fix_bug: 'medium',
  fix_incident: 'high',
  security_patch: 'high',
  dependency_update: 'low',
  refactor: 'medium',
  generate_tests: 'low',
  review_pr: 'low',
  deploy: 'high',
  rollback: 'high',
  onboard_project: 'medium',
  onboard_developer: 'low',
  analyze_logs: 'low',
  classify_alert: 'low',
  translate_intent: 'low',
  update_debt_ledger: 'low',
  generate_postmortem: 'low',
  cost_analysis: 'low',
}

// ---------------------------------------------------------------------------
// AgentRouter
// ---------------------------------------------------------------------------

export interface RoutingDecision {
  agentType: AgentType
  riskLevel: RiskLevel
  requiresApproval: boolean
  reason: string
}

export class AgentRouter {
  /**
   * Route a task to the appropriate agent.
   * Determines risk level and whether approval is required based on
   * task type + project autonomy level.
   */
  route(task: AgentTask): RoutingDecision {
    const agentType = TASK_ROUTING[task.type]
    const riskLevel = TASK_RISK[task.type]

    if (!agentType) {
      throw new Error(`No routing rule for task type: ${task.type}`)
    }

    const requiresApproval = this.shouldRequireApproval(
      task.autonomyLevel,
      riskLevel,
    )

    const reason = this.buildReason(task.type, agentType, riskLevel, requiresApproval)

    log.info(
      {
        taskId: task.id,
        taskType: task.type,
        agentType,
        riskLevel,
        requiresApproval,
        autonomyLevel: task.autonomyLevel,
      },
      'Task routed',
    )

    return { agentType, riskLevel, requiresApproval, reason }
  }

  /**
   * Determine if human approval is required.
   *
   * Rules:
   * - autonomy=suggest: ALWAYS require approval (except classify/analyze)
   * - autonomy=semi: require approval for medium+ risk
   * - autonomy=autonomous: require approval for high+ risk
   * - critical risk: ALWAYS require approval regardless of autonomy level
   */
  private shouldRequireApproval(autonomyLevel: AgentTask['autonomyLevel'], riskLevel: RiskLevel): boolean {
    // Critical risk always requires approval
    if (riskLevel === 'critical') return true

    switch (autonomyLevel) {
      case 'suggest':
        // Suggest mode: always ask except for read-only tasks
        return riskLevel !== 'low'

      case 'semi':
        // Semi mode: approve medium and above
        return riskLevel === 'medium' || riskLevel === 'high'

      case 'autonomous':
        // Autonomous mode: only approve high risk
        return riskLevel === 'high'

      default:
        return true  // safe default
    }
  }

  private buildReason(
    taskType: TaskType,
    agentType: AgentType,
    riskLevel: RiskLevel,
    requiresApproval: boolean,
  ): string {
    return (
      `Task '${taskType}' routed to ${agentType} agent. ` +
      `Risk level: ${riskLevel}. ` +
      (requiresApproval ? 'Human approval required before execution.' : 'Will execute autonomously.')
    )
  }

  /**
   * Get all task types handled by a specific agent.
   */
  getTasksForAgent(agentType: AgentType): TaskType[] {
    return (Object.entries(TASK_ROUTING) as [TaskType, AgentType][])
      .filter(([, agent]) => agent === agentType)
      .map(([taskType]) => taskType)
  }
}
