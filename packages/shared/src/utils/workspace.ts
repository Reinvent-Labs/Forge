/**
 * Workspace safety utilities for agents that apply LLM-generated code.
 *
 * - `resolveWorkspacePath` / `applyWorkspaceFileChanges` keep every write and
 *   delete inside the agent's temp work dir (no absolute paths, no `..`,
 *   no symlinked components).
 * - `runInSandbox` executes commands against the work dir inside a throwaway
 *   container: no host env/secrets, no network unless explicitly requested,
 *   no capabilities, read-only root fs, and npm lifecycle scripts disabled.
 *
 * Generated code (package.json scripts, jest/eslint configs, tests) must never
 * run directly on the agent host.
 */

import { execFileSync } from 'child_process'
import { randomBytes } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'

export class UnsafeWorkspacePathError extends Error {
  constructor(filePath: string, reason: string) {
    super(`Refusing unsafe workspace path ${JSON.stringify(filePath)}: ${reason}`)
    this.name = 'UnsafeWorkspacePathError'
  }
}

export class SandboxUnavailableError extends Error {
  constructor(detail: string) {
    super(`Sandbox runtime unavailable; refusing to run generated code on the host: ${detail}`)
    this.name = 'SandboxUnavailableError'
  }
}

export interface WorkspaceFileChange {
  filePath: string
  content: string
  action: 'create' | 'modify' | 'delete'
}

/**
 * Resolve a relative path inside `workDir`, rejecting anything that could
 * escape it: absolute paths, drive letters, `..` segments, backslashes,
 * NUL bytes, and existing symlinks anywhere along the path.
 */
export function resolveWorkspacePath(workDir: string, filePath: string): string {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw new UnsafeWorkspacePathError(String(filePath), 'empty path')
  }
  if (filePath.includes('\0')) {
    throw new UnsafeWorkspacePathError(filePath, 'contains NUL byte')
  }
  if (filePath.includes('\\')) {
    throw new UnsafeWorkspacePathError(filePath, 'contains backslash')
  }
  if (path.posix.isAbsolute(filePath) || path.win32.isAbsolute(filePath) || /^[a-zA-Z]:/.test(filePath)) {
    throw new UnsafeWorkspacePathError(filePath, 'absolute paths are not allowed')
  }
  const segments = filePath.split('/').filter((s) => s !== '' && s !== '.')
  if (segments.length === 0) {
    throw new UnsafeWorkspacePathError(filePath, 'path resolves to the workspace root')
  }
  if (segments.includes('..')) {
    throw new UnsafeWorkspacePathError(filePath, 'parent-directory segments are not allowed')
  }

  const root = fs.realpathSync(workDir)
  const resolved = path.resolve(root, ...segments)
  if (!resolved.startsWith(root + path.sep)) {
    throw new UnsafeWorkspacePathError(filePath, 'resolves outside the workspace')
  }

  let current = root
  for (const segment of segments) {
    current = path.join(current, segment)
    let stat: fs.Stats
    try {
      stat = fs.lstatSync(current)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') break
      throw err
    }
    if (stat.isSymbolicLink()) {
      throw new UnsafeWorkspacePathError(filePath, 'path traverses a symlink')
    }
  }

  return resolved
}

/**
 * Apply file changes inside `workDir`. Every path is validated before any
 * write happens, so a single unsafe path aborts the whole batch.
 */
export function applyWorkspaceFileChanges(workDir: string, changes: WorkspaceFileChange[]): void {
  const resolved = changes.map((change) => ({ change, fullPath: resolveWorkspacePath(workDir, change.filePath) }))

  for (const { change, fullPath } of resolved) {
    if (change.action === 'delete') {
      try {
        if (fs.lstatSync(fullPath).isFile()) fs.unlinkSync(fullPath)
      } catch {
        // file may not exist
      }
      continue
    }
    fs.mkdirSync(path.dirname(fullPath), { recursive: true })
    // Re-validate after mkdir so the final path is still symlink-free.
    resolveWorkspacePath(workDir, change.filePath)
    fs.writeFileSync(fullPath, change.content, 'utf-8')
  }
}

export interface SandboxOptions {
  /** Kill the container after this many ms. Default 120s. */
  timeoutMs?: number
  /**
   * Allow outbound network (needed only for dependency installs, which always
   * run with lifecycle scripts disabled). Default false.
   */
  network?: boolean
}

const SANDBOX_WORKDIR = '/workspace'

const PROXY_ENV_KEYS = [
  'HTTP_PROXY', 'http_proxy',
  'HTTPS_PROXY', 'https_proxy',
  'FTP_PROXY', 'ftp_proxy',
  'NO_PROXY', 'no_proxy',
  'ALL_PROXY', 'all_proxy',
]

function sandboxRuntime(): string {
  return process.env['FORGE_SANDBOX_RUNTIME'] ?? 'docker'
}

function sandboxImage(): string {
  return process.env['FORGE_SANDBOX_IMAGE'] ?? 'node:20-alpine'
}

/** Env for the container runtime CLI itself; never forwarded into the container. */
function runtimeCliEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY']) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

/** Throws SandboxUnavailableError when the container runtime cannot be reached. */
export function assertSandboxAvailable(): void {
  try {
    execFileSync(sandboxRuntime(), ['version', '--format', '{{.Server.Version}}'], {
      env: runtimeCliEnv(),
      stdio: 'pipe',
      timeout: 15_000,
    })
  } catch (err) {
    throw new SandboxUnavailableError(String(err).slice(0, 200))
  }
}

/** Build the container runtime argv for running `command` against `workDir`. */
export function buildSandboxArgs(workDir: string, command: string[], name: string, options: SandboxOptions = {}): string[] {
  if (command.length === 0) throw new Error('Sandbox command must not be empty')
  const root = fs.realpathSync(workDir)
  const args = [
    'run', '--rm',
    '--name', name,
    '--network', options.network ? 'bridge' : 'none',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--read-only',
    '--tmpfs', '/tmp:rw,exec,size=512m',
    '--pids-limit', '512',
    '--memory', '2g',
    '--cpus', '2',
    '--volume', `${root}:${SANDBOX_WORKDIR}:rw`,
    '--workdir', SANDBOX_WORKDIR,
    '--env', 'HOME=/tmp',
    '--env', 'CI=true',
    '--env', 'npm_config_ignore_scripts=true',
    '--env', 'npm_config_update_notifier=false',
    '--env', 'npm_config_audit=false',
    '--env', 'npm_config_fund=false',
  ]
  // Explicit empty values stop the Docker CLI from injecting proxy URLs (and
  // any credentials in them) from the host's ~/.docker/config.json.
  for (const key of PROXY_ENV_KEYS) args.push('--env', `${key}=`)
  const uid = process.getuid?.()
  const gid = process.getgid?.()
  if (uid !== undefined && gid !== undefined) args.push('--user', `${uid}:${gid}`)
  args.push(sandboxImage(), ...command)
  return args
}

/**
 * Run `command` (argv, no shell) in a throwaway container with `workDir`
 * mounted at /workspace. Returns stdout; throws on non-zero exit or timeout,
 * mirroring execSync.
 */
export function runInSandbox(workDir: string, command: string[], options: SandboxOptions = {}): string {
  const name = `forge-sandbox-${randomBytes(8).toString('hex')}`
  const args = buildSandboxArgs(workDir, command, name, options)
  try {
    return execFileSync(sandboxRuntime(), args, {
      env: runtimeCliEnv(),
      stdio: 'pipe',
      timeout: options.timeoutMs ?? 120_000,
      maxBuffer: 16 * 1024 * 1024,
    }).toString()
  } catch (err) {
    try {
      execFileSync(sandboxRuntime(), ['rm', '-f', name], { env: runtimeCliEnv(), stdio: 'ignore', timeout: 15_000 })
    } catch {
      // container already gone
    }
    throw err
  }
}

/**
 * Install the workspace's dependencies inside the sandbox with lifecycle
 * scripts disabled. Network is enabled only for this step.
 */
export function installSandboxDependencies(workDir: string, options: { timeoutMs?: number } = {}): void {
  const root = fs.realpathSync(workDir)
  if (!fs.existsSync(path.join(root, 'package.json'))) return
  const hasLock = fs.existsSync(path.join(root, 'package-lock.json'))
  const command = hasLock
    ? ['npm', 'ci', '--ignore-scripts', '--silent']
    : ['npm', 'install', '--ignore-scripts', '--silent']
  runInSandbox(workDir, command, { network: true, timeoutMs: options.timeoutMs ?? 180_000 })
}
