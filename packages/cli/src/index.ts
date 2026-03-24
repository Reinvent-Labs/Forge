#!/usr/bin/env node
/**
 * index.ts — Forge CLI entry point
 *
 * Sets up the Commander program and registers all top-level commands:
 *   forge init       — interactive project onboarding wizard
 *   forge connect    — connect GitHub, Slack, or Telegram integrations
 *   forge status     — display agent health table
 *   forge logs       — tail recent agent activity
 *   forge deploy     — trigger a deployment
 *   forge approve    — approve a pending request
 *
 * Usage: forge <command> [options]
 */

import { Command } from 'commander'
import inquirer from 'inquirer'
import chalk from 'chalk'
import ora from 'ora'
import { z } from 'zod'

import { getForgeConfig, writeForgeConfig } from './config.js'
import type { ForgeProjectConfig } from './config.js'
import { getStatus, getLogs, triggerDeploy, processApproval } from './api.js'
import { printForgeHeader, formatTable } from './utils.js'

// ---------------------------------------------------------------------------
// Program root
// ---------------------------------------------------------------------------

const program = new Command()

program
  .name('forge')
  .description('Forge — connect your startup project to your AI CTO platform')
  .version('0.1.0')
  .addHelpText(
    'after',
    `
Examples:
  $ forge init                        Run the interactive project setup wizard
  $ forge connect github              Connect your GitHub repository
  $ forge status                      Show agent health and last-active times
  $ forge logs --agent builder        Tail builder agent activity
  $ forge deploy --env staging        Deploy to staging
  $ forge approve REQ-123 --reason "LGTM"
`,
  )

// ---------------------------------------------------------------------------
// forge init — interactive onboarding wizard
// ---------------------------------------------------------------------------

program
  .command('init')
  .description('Run the interactive wizard to connect your project to Forge')
  .action(async () => {
    printForgeHeader()
    console.log(chalk.bold.white('Project Setup Wizard\n'))

    // ------------------------------------------------------------------
    // Step 1 — project name
    // ------------------------------------------------------------------
    const { projectName } = await inquirer.prompt<{ projectName: string }>([
      {
        type: 'input',
        name: 'projectName',
        message: 'What is your project name?',
        validate: (input: string) =>
          input.trim().length > 0 ? true : 'Project name cannot be empty.',
      },
    ])

    // ------------------------------------------------------------------
    // Step 2 — GitHub repo URL
    // ------------------------------------------------------------------
    const urlSchema = z.string().url()

    const { githubRepo } = await inquirer.prompt<{ githubRepo: string }>([
      {
        type: 'input',
        name: 'githubRepo',
        message: 'GitHub repository URL (e.g. https://github.com/org/repo):',
        validate: (input: string) => {
          const result = urlSchema.safeParse(input)
          return result.success ? true : 'Please enter a valid URL (include https://).'
        },
      },
    ])

    // ------------------------------------------------------------------
    // Step 3 — autonomy level
    // ------------------------------------------------------------------
    const { autonomyLevel } = await inquirer.prompt<{
      autonomyLevel: 'ask-everything' | 'balanced' | 'autonomous'
    }>([
      {
        type: 'list',
        name: 'autonomyLevel',
        message: 'How much autonomy should Forge have?',
        choices: [
          {
            value: 'ask-everything',
            name: 'Ask everything  — Forge asks before every action (safest)',
          },
          {
            value: 'balanced',
            name: 'Balanced        — Forge acts on low-risk tasks, asks for the rest',
          },
          {
            value: 'autonomous',
            name: 'Autonomous      — Forge acts independently unless risk is critical',
          },
        ],
      },
    ])

    // ------------------------------------------------------------------
    // Step 4 — notification channel
    // ------------------------------------------------------------------
    const { notificationChannel } = await inquirer.prompt<{
      notificationChannel: 'slack' | 'telegram' | 'both' | 'none'
    }>([
      {
        type: 'list',
        name: 'notificationChannel',
        message: 'Where should Forge send notifications?',
        choices: [
          { value: 'slack', name: 'Slack' },
          { value: 'telegram', name: 'Telegram' },
          { value: 'both', name: 'Both Slack and Telegram' },
          { value: 'none', name: 'None' },
        ],
      },
    ])

    // ------------------------------------------------------------------
    // Step 5a — Slack webhook URL (if slack or both)
    // ------------------------------------------------------------------
    let slackWebhookUrl: string | undefined

    if (notificationChannel === 'slack' || notificationChannel === 'both') {
      const { webhook } = await inquirer.prompt<{ webhook: string }>([
        {
          type: 'input',
          name: 'webhook',
          message: 'Slack incoming webhook URL:',
          validate: (input: string) => {
            const result = urlSchema.safeParse(input)
            return result.success ? true : 'Please enter a valid webhook URL.'
          },
        },
      ])
      slackWebhookUrl = webhook
    }

    // ------------------------------------------------------------------
    // Step 5b — Telegram credentials (if telegram or both)
    // ------------------------------------------------------------------
    let telegramBotToken: string | undefined
    let telegramChatId: string | undefined

    if (notificationChannel === 'telegram' || notificationChannel === 'both') {
      const answers = await inquirer.prompt<{
        botToken: string
        chatId: string
      }>([
        {
          type: 'input',
          name: 'botToken',
          message: 'Telegram bot token:',
          validate: (input: string) =>
            input.trim().length > 0 ? true : 'Bot token cannot be empty.',
        },
        {
          type: 'input',
          name: 'chatId',
          message: 'Telegram chat ID:',
          validate: (input: string) =>
            input.trim().length > 0 ? true : 'Chat ID cannot be empty.',
        },
      ])
      telegramBotToken = answers.botToken
      telegramChatId = answers.chatId
    }

    // ------------------------------------------------------------------
    // Spinner — "connecting to Forge API"
    // ------------------------------------------------------------------
    const spinner = ora('Connecting to Forge API…').start()

    await new Promise<void>((resolve) => setTimeout(resolve, 1200))

    const projectConfig: ForgeProjectConfig = {
      projectName: projectName.trim(),
      githubRepo,
      autonomyLevel,
      notificationChannel,
      ...(slackWebhookUrl ? { slackWebhookUrl } : {}),
      ...(telegramBotToken ? { telegramBotToken } : {}),
      ...(telegramChatId ? { telegramChatId } : {}),
      createdAt: new Date().toISOString(),
    }

    writeForgeConfig(projectConfig)
    spinner.succeed(chalk.green('forge.config.json written successfully'))

    // ------------------------------------------------------------------
    // Success summary
    // ------------------------------------------------------------------
    console.log('')
    console.log(chalk.bold.white('Setup Complete'))
    console.log(chalk.dim('─'.repeat(44)))
    console.log(`  ${chalk.dim('Project:')}           ${chalk.white(projectConfig.projectName)}`)
    console.log(`  ${chalk.dim('Repo:')}              ${chalk.cyan(projectConfig.githubRepo)}`)
    console.log(`  ${chalk.dim('Autonomy:')}          ${chalk.white(projectConfig.autonomyLevel)}`)
    console.log(`  ${chalk.dim('Notifications:')}     ${chalk.white(projectConfig.notificationChannel)}`)
    if (projectConfig.slackWebhookUrl) {
      console.log(`  ${chalk.dim('Slack webhook:')}     ${chalk.green('configured')}`)
    }
    if (projectConfig.telegramBotToken) {
      console.log(`  ${chalk.dim('Telegram:')}          ${chalk.green('configured')}`)
    }
    console.log('')
    console.log(
      chalk.dim(
        'Run `forge status` to check your agents, or `forge connect github` to link your repo.',
      ),
    )
    console.log('')
  })

// ---------------------------------------------------------------------------
// forge connect — integration sub-commands
// ---------------------------------------------------------------------------

const connectCmd = program
  .command('connect')
  .description('Connect an external integration (github | slack | telegram)')
  .addHelpText(
    'after',
    `
Sub-commands:
  forge connect github     Link your GitHub repository
  forge connect slack      Add or update a Slack webhook
  forge connect telegram   Add or update Telegram credentials
`,
  )

// -- forge connect github --------------------------------------------------

connectCmd
  .command('github')
  .description('Connect your GitHub repository to Forge')
  .action(async () => {
    const existing = getForgeConfig()
    const urlSchema = z.string().url()

    const { githubRepo } = await inquirer.prompt<{ githubRepo: string }>([
      {
        type: 'input',
        name: 'githubRepo',
        message: 'GitHub repository URL:',
        default: existing?.githubRepo,
        validate: (input: string) => {
          const result = urlSchema.safeParse(input)
          return result.success ? true : 'Please enter a valid URL (include https://).'
        },
      },
    ])

    const spinner = ora('Validating GitHub connection…').start()
    await new Promise<void>((resolve) => setTimeout(resolve, 800))
    spinner.succeed(chalk.green('GitHub repository connected'))

    if (existing) {
      writeForgeConfig({ ...existing, githubRepo })
    } else {
      console.log(
        chalk.yellow(
          '\nNo forge.config.json found. Run `forge init` first to set up the full project.',
        ),
      )
    }

    console.log(`  ${chalk.dim('Repo:')} ${chalk.cyan(githubRepo)}\n`)
    console.log(chalk.dim('Status: connected'))
  })

// -- forge connect slack ---------------------------------------------------

connectCmd
  .command('slack')
  .description('Connect a Slack incoming webhook for notifications')
  .action(async () => {
    const existing = getForgeConfig()
    const urlSchema = z.string().url()

    const { webhookUrl } = await inquirer.prompt<{ webhookUrl: string }>([
      {
        type: 'input',
        name: 'webhookUrl',
        message: 'Slack incoming webhook URL:',
        default: existing?.slackWebhookUrl,
        validate: (input: string) => {
          const result = urlSchema.safeParse(input)
          return result.success ? true : 'Please enter a valid webhook URL.'
        },
      },
    ])

    const spinner = ora('Verifying Slack webhook…').start()
    await new Promise<void>((resolve) => setTimeout(resolve, 800))
    spinner.succeed(chalk.green('Slack webhook validated'))

    if (existing) {
      writeForgeConfig({
        ...existing,
        slackWebhookUrl: webhookUrl,
        notificationChannel:
          existing.notificationChannel === 'telegram' ? 'both' : 'slack',
      })
    } else {
      console.log(
        chalk.yellow('\nNo forge.config.json found. Run `forge init` to create one.'),
      )
    }

    console.log(`  ${chalk.dim('Webhook:')} ${chalk.cyan(webhookUrl)}\n`)
    console.log(chalk.dim('Status: connected'))
  })

// -- forge connect telegram -------------------------------------------------

connectCmd
  .command('telegram')
  .description('Connect a Telegram bot for notifications')
  .action(async () => {
    const existing = getForgeConfig()

    const answers = await inquirer.prompt<{ botToken: string; chatId: string }>([
      {
        type: 'input',
        name: 'botToken',
        message: 'Telegram bot token:',
        default: existing?.telegramBotToken,
        validate: (input: string) =>
          input.trim().length > 0 ? true : 'Bot token cannot be empty.',
      },
      {
        type: 'input',
        name: 'chatId',
        message: 'Telegram chat ID:',
        default: existing?.telegramChatId,
        validate: (input: string) =>
          input.trim().length > 0 ? true : 'Chat ID cannot be empty.',
      },
    ])

    const spinner = ora('Verifying Telegram credentials…').start()
    await new Promise<void>((resolve) => setTimeout(resolve, 800))
    spinner.succeed(chalk.green('Telegram bot connected'))

    if (existing) {
      writeForgeConfig({
        ...existing,
        telegramBotToken: answers.botToken,
        telegramChatId: answers.chatId,
        notificationChannel:
          existing.notificationChannel === 'slack' ? 'both' : 'telegram',
      })
    } else {
      console.log(
        chalk.yellow('\nNo forge.config.json found. Run `forge init` to create one.'),
      )
    }

    console.log(`  ${chalk.dim('Chat ID:')} ${chalk.white(answers.chatId)}\n`)
    console.log(chalk.dim('Status: connected'))
  })

// ---------------------------------------------------------------------------
// forge status — agent health table
// ---------------------------------------------------------------------------

program
  .command('status')
  .description('Show the health and last-active time of each Forge agent')
  .action(async () => {
    const spinner = ora('Fetching agent status…').start()

    try {
      const agents = await getStatus()
      spinner.stop()

      if (agents.length === 0) {
        console.log(chalk.yellow('\nNo agent data returned by the API.\n'))
        return
      }

      const rows = [
        ['Agent', 'Status', 'Last Active'],
        ...agents.map((a) => {
          const statusText =
            a.status === 'running'
              ? chalk.green(a.status)
              : a.status === 'stopped'
                ? chalk.yellow(a.status)
                : chalk.red(a.status)

          // Format ISO timestamp into a readable local date-time string
          const lastActive = new Date(a.lastActive).toLocaleString()

          return [chalk.white(a.name), statusText, chalk.dim(lastActive)]
        }),
      ]

      console.log('')
      console.log(formatTable(rows))
      console.log('')
    } catch (err) {
      spinner.fail(chalk.red((err as Error).message))
    }
  })

// ---------------------------------------------------------------------------
// forge logs — tail recent agent activity
// ---------------------------------------------------------------------------

program
  .command('logs')
  .description('Tail recent activity logs from Forge agents')
  .option('--agent <name>', 'Filter logs by agent name (e.g. builder, fixer, watcher)')
  .option('--tail <n>', 'Number of log entries to show (default: 50)', '50')
  .action(async (opts: { agent?: string; tail: string }) => {
    const tail = parseInt(opts.tail, 10)

    if (isNaN(tail) || tail < 1) {
      console.error(chalk.red('--tail must be a positive integer'))
      process.exit(1)
    }

    const spinner = ora('Fetching logs…').start()

    try {
      const logsQuery = opts.agent !== undefined ? { agent: opts.agent, tail } : { tail }
      const entries = await getLogs(logsQuery)
      spinner.stop()

      if (entries.length === 0) {
        console.log(chalk.dim('\nNo log entries found.\n'))
        return
      }

      console.log('')

      for (const entry of entries) {
        // Format: [2024-01-15 14:23:01] [builder] Built feature: user authentication PR #42
        const ts = new Date(entry.timestamp)
        const dateStr = ts.toISOString().replace('T', ' ').substring(0, 19)

        const levelColor =
          entry.level === 'error'
            ? chalk.red
            : entry.level === 'warn'
              ? chalk.yellow
              : chalk.dim

        const agentTag = chalk.cyan(`[${entry.agent}]`)
        const tsTag = chalk.dim(`[${dateStr}]`)

        console.log(`${tsTag} ${agentTag} ${levelColor(entry.message)}`)
      }

      console.log('')
    } catch (err) {
      spinner.fail(chalk.red((err as Error).message))
    }
  })

// ---------------------------------------------------------------------------
// forge deploy — trigger deployment
// ---------------------------------------------------------------------------

program
  .command('deploy')
  .description('Trigger a deployment via the Forge DevOps agent')
  .option(
    '--env <environment>',
    'Target environment: staging | production (default: staging)',
    'staging',
  )
  .action(async (opts: { env: string }) => {
    const env = opts.env as 'staging' | 'production'

    if (env !== 'staging' && env !== 'production') {
      console.error(chalk.red('--env must be "staging" or "production"'))
      process.exit(1)
    }

    const spinner = ora(`Deploying to ${chalk.bold(env)}…`).start()

    try {
      const result = await triggerDeploy({ env })
      spinner.succeed(chalk.green(`Deployment triggered (ID: ${result.deploymentId})`))

      if (result.url) {
        console.log(`\n  ${chalk.dim('Live at:')} ${chalk.cyan(result.url)}\n`)
      } else {
        console.log(chalk.dim(`\n  ${result.message}\n`))
      }
    } catch (err) {
      spinner.fail(chalk.red((err as Error).message))
    }
  })

// ---------------------------------------------------------------------------
// forge approve — approve a pending request
// ---------------------------------------------------------------------------

program
  .command('approve <approval-id>')
  .description('Approve a pending approval request by its ID')
  .requiredOption('--reason <text>', 'Human-readable reason for approving this request')
  .action(async (approvalId: string, opts: { reason: string }) => {
    const spinner = ora(`Approving request ${chalk.bold(approvalId)}…`).start()

    try {
      const result = await processApproval(approvalId, { reason: opts.reason })
      spinner.succeed(chalk.green(`Approved — status: ${result.status}`))
      console.log(`  ${chalk.dim('Processed at:')} ${chalk.white(result.processedAt)}`)
      console.log(`  ${chalk.dim('Message:')}      ${chalk.white(result.message)}\n`)
    } catch (err) {
      spinner.fail(chalk.red((err as Error).message))
    }
  })

// ---------------------------------------------------------------------------
// Parse argv and show help when called with no arguments
// ---------------------------------------------------------------------------

program.parseAsync(process.argv).then(() => {
  if (process.argv.slice(2).length === 0) {
    program.outputHelp()
  }
})
