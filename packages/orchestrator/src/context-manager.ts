/**
 * Context Manager
 *
 * Maintains the codebase knowledge graph for each project.
 * - Embeds changed files on every PR merge
 * - Updates module descriptions via Haiku
 * - Provides context injection for Claude Code sessions
 * - Retrieves relevant modules via vector similarity search
 */

import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { createLogger } from '@forge/shared'
import type { CodebaseContext, ModuleNode, DebtItem, IncidentRecord } from '@forge/shared'
import { prisma, findSimilarModules } from '@forge/database'

const log = createLogger('context-manager')

const anthropic = new Anthropic({ apiKey: process.env['ANTHROPIC_API_KEY'] })
const openai = new OpenAI({ apiKey: process.env['OPENAI_API_KEY'] ?? '' })

// ---------------------------------------------------------------------------
// Context Manager
// ---------------------------------------------------------------------------

export class ContextManager {
  /**
   * Get the full codebase context for a project.
   * Includes modules, recent changes, incidents, debt, and ADRs.
   */
  async getContext(projectId: string): Promise<CodebaseContext | null> {
    const ctx = await prisma.codebaseContext.findFirst({
      where: { projectId },
      include: {
        modules: true,
        adrs: true,
      },
      orderBy: { lastUpdated: 'desc' },
    })

    if (!ctx) return null

    // Fetch supporting data
    const [recentIncidents, debtItems, recentChanges] = await Promise.all([
      prisma.incident.findMany({
        where: {
          projectId,
          detectedAt: { gte: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) },
        },
        orderBy: { detectedAt: 'desc' },
        take: 20,
      }),
      prisma.debtItem.findMany({
        where: { projectId, resolvedAt: null },
        orderBy: { severity: 'desc' },
        take: 30,
      }),
      prisma.agentTask.findMany({
        where: {
          projectId,
          type: { in: ['BUILD_FEATURE', 'FIX_BUG', 'REFACTOR'] as never[] },
          status: 'COMPLETED',
          createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
        },
        orderBy: { completedAt: 'desc' },
        take: 5,
      }),
    ])

    return {
      projectId,
      lastUpdated: ctx.lastUpdated,
      modules: ctx.modules.map((m) => ({
        path: m.path,
        plainEnglishDescription: m.plainEnglishDescription,
        lastModified: m.lastModified,
        lastModifiedBy: m.lastModifiedBy,
        incidentCount: m.incidentCount,
        testCoverage: m.testCoverage,
        complexityScore: m.complexityScore,
        embeddingId: m.embeddingId ?? undefined,
      })),
      dependencies: [],
      recentChanges: recentChanges.map((t) => ({
        timestamp: t.completedAt ?? t.createdAt,
        summary: `${t.type}: task ${t.id}`,
        filesChanged: [],
        authorName: 'forge-agent',
      })),
      incidentHistory: recentIncidents.map((i): IncidentRecord => ({
        id: i.id,
        title: i.title,
        severity: i.severity.toLowerCase() as IncidentRecord['severity'],
        resolvedAt: i.resolvedAt ?? undefined,
        affectedModules: i.affectedModules,
      })),
      debtItems: debtItems.map((d): DebtItem => ({
        id: d.id,
        type: d.type.toLowerCase() as DebtItem['type'],
        severity: d.severity.toLowerCase() as DebtItem['severity'],
        filePath: d.filePath,
        plainEnglishDescription: d.plainEnglishDescription,
        estimatedHours: d.estimatedHours,
        businessRisk: d.businessRisk,
      })),
      techStack: ctx.techStack as CodebaseContext['techStack'],
      teamMembers: ctx.teamMembers as CodebaseContext['teamMembers'],
      adrs: ctx.adrs.map((adr) => ({
        id: adr.id,
        title: adr.title,
        status: adr.status.toLowerCase() as 'proposed' | 'accepted' | 'deprecated' | 'superseded',
        decision: adr.decision,
        consequences: adr.consequences,
        createdAt: adr.createdAt,
      })),
    }
  }

  /**
   * Retrieve the most relevant modules for a given task description.
   * Uses vector similarity search + recency + incident correlation.
   *
   * @param projectId - The project to search
   * @param taskDescription - Natural language description of the task
   * @param topK - Number of modules to return
   */
  async getRelevantModules(
    projectId: string,
    taskDescription: string,
    topK = 10,
  ): Promise<ModuleNode[]> {
    // 1. Generate embedding for the task description
    const embedding = await this.embedText(taskDescription)

    // 2. Find context ID
    const ctx = await prisma.codebaseContext.findFirst({
      where: { projectId },
      select: { id: true },
      orderBy: { lastUpdated: 'desc' },
    })

    if (!ctx) return []

    // 3. Vector similarity search
    const similar = await findSimilarModules(ctx.id, embedding, topK)

    // 4. Load full module data
    const modules = await prisma.moduleNode.findMany({
      where: { id: { in: similar.map((s) => s.moduleId) } },
    })

    return modules.map((m): ModuleNode => ({
      path: m.path,
      plainEnglishDescription: m.plainEnglishDescription,
      lastModified: m.lastModified,
      lastModifiedBy: m.lastModifiedBy,
      incidentCount: m.incidentCount,
      testCoverage: m.testCoverage,
      complexityScore: m.complexityScore,
      embeddingId: m.embeddingId ?? undefined,
    }))
  }

  /**
   * Build the XML context block injected into every Claude Code session.
   * This is the core context injection that makes the AI "know" the codebase.
   */
  async buildContextPrompt(projectId: string, taskDescription: string): Promise<string> {
    const [context, relevantModules] = await Promise.all([
      this.getContext(projectId),
      this.getRelevantModules(projectId, taskDescription, 8),
    ])

    if (!context) {
      return '<codebase_context>\n  <note>No codebase context available yet. This may be a new project.</note>\n</codebase_context>'
    }

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { name: true, description: true, startupStage: true, codingStandards: true },
    })

    const activeIncidents = context.incidentHistory
      .filter((i) => !i.resolvedAt)
      .slice(0, 3)

    const highDebt = context.debtItems
      .filter((d) => d.severity === 'high' || d.severity === 'critical')
      .slice(0, 5)

    return `<codebase_context>
  <project_summary>${project?.description ?? 'No description available'}</project_summary>
  <tech_stack>${JSON.stringify(context.techStack, null, 2)}</tech_stack>
  <stage>${project?.startupStage ?? 'MVP'}</stage>

  <relevant_modules>
${relevantModules.map((m) => `    <module path="${m.path}" incidents="${m.incidentCount}" coverage="${m.testCoverage}%">
      ${m.plainEnglishDescription}
    </module>`).join('\n')}
  </relevant_modules>

  <recent_changes>
${context.recentChanges.slice(0, 5).map((c) => `    <change timestamp="${c.timestamp.toISOString()}">${c.summary}</change>`).join('\n')}
  </recent_changes>

  <open_incidents>
${activeIncidents.length > 0
  ? activeIncidents.map((i) => `    <incident severity="${i.severity}">${i.title}</incident>`).join('\n')
  : '    <none/>'}
  </open_incidents>

  <debt_items>
${highDebt.length > 0
  ? highDebt.map((d) => `    <debt severity="${d.severity}" file="${d.filePath}">${d.plainEnglishDescription}</debt>`).join('\n')
  : '    <none/>'}
  </debt_items>

  <coding_standards>
${project?.codingStandards ?? 'Follow TypeScript strict mode. Write tests for all new logic. Use Pino for logging. Validate with Zod.'}
  </coding_standards>

  <architecture_decisions>
${context.adrs.filter((a) => a.status === 'accepted').slice(0, 5).map((a) => `    <adr>${a.title}: ${a.decision}</adr>`).join('\n')}
  </architecture_decisions>
</codebase_context>`
  }

  /**
   * Update module descriptions and re-embed changed files after a PR merge.
   * Call this from the GitHub webhook handler on every merge.
   *
   * @param projectId - The project
   * @param changedFiles - Files changed in the PR
   * @param fileContents - Map of file path → file content
   */
  async updateModules(
    projectId: string,
    changedFiles: string[],
    fileContents: Record<string, string>,
  ): Promise<void> {
    log.info({ projectId, fileCount: changedFiles.length }, 'Updating codebase context')

    let ctx = await prisma.codebaseContext.findFirst({
      where: { projectId },
      orderBy: { lastUpdated: 'desc' },
    })

    if (!ctx) {
      const project = await prisma.project.findUnique({ where: { id: projectId } })
      if (!project) throw new Error(`Project not found: ${projectId}`)

      ctx = await prisma.codebaseContext.create({
        data: {
          projectId,
          techStack: {},
          teamMembers: [],
        },
      })
    }

    // Process each changed file
    await Promise.all(
      changedFiles.map(async (filePath) => {
        const content = fileContents[filePath]
        if (!content) return

        // Generate plain English description via Haiku (fast + cheap)
        const description = await this.describeModule(filePath, content)

        // Embed the file for vector search
        const embedding = await this.embedText(`${filePath}\n\n${description}\n\n${content.substring(0, 2000)}`)

        // Upsert module node
        const existing = await prisma.moduleNode.findFirst({
          where: { contextId: ctx!.id, path: filePath },
        })

        if (existing) {
          await prisma.moduleNode.update({
            where: { id: existing.id },
            data: {
              plainEnglishDescription: description,
              lastModified: new Date(),
              lastModifiedBy: 'forge-agent',
            },
          })

          // Add new embedding
          await prisma.moduleEmbedding.create({
            data: {
              moduleId: existing.id,
              content: content.substring(0, 4000),
              // @ts-expect-error - pgvector not typed in Prisma
              embedding: embedding,
            },
          })
        } else {
          const module = await prisma.moduleNode.create({
            data: {
              contextId: ctx!.id,
              path: filePath,
              plainEnglishDescription: description,
              lastModified: new Date(),
              lastModifiedBy: 'forge-agent',
              incidentCount: 0,
              testCoverage: 0,
              complexityScore: 0,
            },
          })

          await prisma.moduleEmbedding.create({
            data: {
              moduleId: module.id,
              content: content.substring(0, 4000),
              // @ts-expect-error - pgvector not typed in Prisma
              embedding: embedding,
            },
          })
        }
      }),
    )

    // Update context timestamp
    await prisma.codebaseContext.update({
      where: { id: ctx.id },
      data: { lastUpdated: new Date() },
    })

    log.info({ projectId, filesUpdated: changedFiles.length }, 'Context update complete')
  }

  /**
   * Generate a plain-English description of a source file.
   * Uses Haiku for speed and cost efficiency.
   */
  private async describeModule(filePath: string, content: string): Promise<string> {
    try {
      const response = await anthropic.messages.create({
        model: process.env['HAIKU_MODEL'] ?? 'claude-haiku-4-5-20251001',
        max_tokens: 150,
        messages: [
          {
            role: 'user',
            content: `Describe this file in 1-2 plain English sentences for a non-technical founder. Focus on what it does, not how.

File: ${filePath}
\`\`\`
${content.substring(0, 3000)}
\`\`\`

Reply with only the description, no preamble.`,
          },
        ],
      })

      const text = response.content[0]
      return text?.type === 'text' ? text.text.trim() : filePath
    } catch (err) {
      log.warn({ error: (err as Error).message, filePath }, 'Failed to describe module')
      return `Source file: ${filePath}`
    }
  }

  /**
   * Generate a text embedding using OpenAI's text-embedding-3-small.
   * Falls back to a zero vector on error (graceful degradation).
   */
  private async embedText(text: string): Promise<number[]> {
    try {
      const response = await openai.embeddings.create({
        model: process.env['EMBEDDING_MODEL'] ?? 'text-embedding-3-small',
        input: text.substring(0, 8000),
        dimensions: 1536,
      })

      return response.data[0]?.embedding ?? new Array(1536).fill(0) as number[]
    } catch (err) {
      log.warn({ error: (err as Error).message }, 'Embedding failed, using zero vector')
      return new Array(1536).fill(0) as number[]
    }
  }
}
