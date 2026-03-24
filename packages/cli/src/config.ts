/**
 * config.ts
 *
 * Manages CLI-level persistent configuration (API URL, auth token) using the
 * `conf` package, which stores values in the OS-appropriate config directory.
 *
 * Also provides `getForgeConfig()` which reads the project-level
 * forge.config.json from the current working directory.
 */

import Conf from 'conf'
import fs from 'fs'
import path from 'path'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Shape of the persistent CLI config stored by `conf`. */
export interface CliConfig {
  /** Base URL of the Forge API. Defaults to http://localhost:4000. */
  apiUrl: string
  /** Bearer token for authenticated API calls. */
  authToken: string
}

/** Shape of the per-project forge.config.json written by `forge init`. */
export interface ForgeProjectConfig {
  projectName: string
  githubRepo: string
  autonomyLevel: 'ask-everything' | 'balanced' | 'autonomous'
  notificationChannel: 'slack' | 'telegram' | 'both' | 'none'
  slackWebhookUrl?: string
  telegramBotToken?: string
  telegramChatId?: string
  createdAt: string
}

// ---------------------------------------------------------------------------
// Internal conf instance
// ---------------------------------------------------------------------------

const store = new Conf<CliConfig>({
  projectName: 'forge-cli',
  defaults: {
    apiUrl: process.env['FORGE_API_URL'] ?? 'http://localhost:4000',
    authToken: '',
  },
})

// ---------------------------------------------------------------------------
// Public functions
// ---------------------------------------------------------------------------

/**
 * Returns the current CLI config values.
 * Reads live from the persistent store on every call.
 */
export function getConfig(): CliConfig {
  return {
    apiUrl: store.get('apiUrl'),
    authToken: store.get('authToken'),
  }
}

/**
 * Persists one or more CLI config keys.
 *
 * @param updates - Partial config object with the keys to update.
 */
export function setConfig(updates: Partial<CliConfig>): void {
  for (const [key, value] of Object.entries(updates) as Array<[keyof CliConfig, string]>) {
    store.set(key, value)
  }
}

/**
 * Reads and returns the forge.config.json from the current working directory.
 * Returns null if the file does not exist or cannot be parsed.
 */
export function getForgeConfig(): ForgeProjectConfig | null {
  const configPath = path.join(process.cwd(), 'forge.config.json')

  if (!fs.existsSync(configPath)) {
    return null
  }

  try {
    const raw = fs.readFileSync(configPath, 'utf-8')
    return JSON.parse(raw) as ForgeProjectConfig
  } catch {
    // File exists but is malformed — treat as missing
    return null
  }
}

/**
 * Writes a ForgeProjectConfig to forge.config.json in the current directory.
 *
 * @param cfg - The project config to persist.
 */
export function writeForgeConfig(cfg: ForgeProjectConfig): void {
  const configPath = path.join(process.cwd(), 'forge.config.json')
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n', 'utf-8')
}
