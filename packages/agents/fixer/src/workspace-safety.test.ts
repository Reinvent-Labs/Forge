/**
 * Regression tests for the workspace containment and sandbox helpers that the
 * Fixer and Builder agents use when applying LLM-generated file changes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  applyWorkspaceFileChanges,
  buildSandboxArgs,
  sandboxCliEnv,
  resolveWorkspacePath,
  UnsafeWorkspacePathError,
} from '@forge/shared'

let base: string
let workDir: string

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-ws-test-'))
  workDir = path.join(base, 'work')
  fs.mkdirSync(workDir)
})

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true })
})

describe('resolveWorkspacePath', () => {
  it('resolves normal relative paths inside the work dir', () => {
    const resolved = resolveWorkspacePath(workDir, 'src/./a/b.ts')
    expect(resolved).toBe(path.join(fs.realpathSync(workDir), 'src', 'a', 'b.ts'))
  })

  it.each([
    '../x',
    'src/../../x',
    '/etc/passwd',
    'C:\\Windows\\x',
    'C:/x',
    '..\\x',
    '\\\\server\\share',
    '',
    '.',
    'a\0b',
  ])('rejects %j', (p) => {
    expect(() => resolveWorkspacePath(workDir, p)).toThrow(UnsafeWorkspacePathError)
  })

  it('rejects paths that traverse a symlink', () => {
    const outside = path.join(base, 'outside')
    fs.mkdirSync(outside)
    fs.symlinkSync(outside, path.join(workDir, 'link'))
    expect(() => resolveWorkspacePath(workDir, 'link/x.ts')).toThrow(UnsafeWorkspacePathError)
    fs.symlinkSync(path.join(outside, 'f'), path.join(workDir, 'filelink'))
    expect(() => resolveWorkspacePath(workDir, 'filelink')).toThrow(UnsafeWorkspacePathError)
  })
})

describe('applyWorkspaceFileChanges', () => {
  it('writes and deletes files inside the work dir', () => {
    applyWorkspaceFileChanges(workDir, [{ filePath: 'src/a.ts', content: 'a', action: 'create' }])
    expect(fs.readFileSync(path.join(workDir, 'src/a.ts'), 'utf-8')).toBe('a')
    applyWorkspaceFileChanges(workDir, [{ filePath: 'src/a.ts', content: '', action: 'delete' }])
    expect(fs.existsSync(path.join(workDir, 'src/a.ts'))).toBe(false)
  })

  it('writes nothing when any path escapes the work dir', () => {
    const victim = path.join(base, 'victim.txt')
    fs.writeFileSync(victim, 'keep')
    expect(() =>
      applyWorkspaceFileChanges(workDir, [
        { filePath: 'ok.ts', content: 'x', action: 'create' },
        { filePath: '../victim.txt', content: 'pwned', action: 'modify' },
      ]),
    ).toThrow(UnsafeWorkspacePathError)
    expect(fs.existsSync(path.join(workDir, 'ok.ts'))).toBe(false)
    expect(fs.readFileSync(victim, 'utf-8')).toBe('keep')

    expect(() =>
      applyWorkspaceFileChanges(workDir, [{ filePath: '../victim.txt', content: '', action: 'delete' }]),
    ).toThrow(UnsafeWorkspacePathError)
    expect(fs.existsSync(victim)).toBe(true)
  })

  it('does not write through a symlink', () => {
    const victim = path.join(base, 'victim.txt')
    fs.writeFileSync(victim, 'keep')
    fs.symlinkSync(victim, path.join(workDir, 'package.json'))
    expect(() =>
      applyWorkspaceFileChanges(workDir, [{ filePath: 'package.json', content: '{}', action: 'modify' }]),
    ).toThrow(UnsafeWorkspacePathError)
    expect(fs.readFileSync(victim, 'utf-8')).toBe('keep')
  })
})

describe('buildSandboxArgs', () => {
  it('isolates the container and never forwards host env', () => {
    process.env['FORGE_TEST_SECRET'] = 'super-secret'
    const args = buildSandboxArgs(workDir, ['npx', '--no-install', 'jest'], 'forge-sandbox-test')
    delete process.env['FORGE_TEST_SECRET']
    const joined = args.join(' ')
    expect(args.slice(args.indexOf('--network'), args.indexOf('--network') + 2)).toEqual(['--network', 'none'])
    expect(joined).toContain('--cap-drop ALL')
    expect(joined).toContain('--read-only')
    expect(joined).toContain('npm_config_ignore_scripts=true')
    expect(joined).not.toContain('super-secret')
    expect(args).not.toContain('--env-file')
    expect(args.slice(-3)).toEqual(['npx', '--no-install', 'jest'])
  })

  it('enables network only when requested', () => {
    const args = buildSandboxArgs(workDir, ['npm', 'ci', '--ignore-scripts'], 'n', { network: true })
    expect(args[args.indexOf('--network') + 1]).toBe('bridge')
  })

  it('blanks proxy env so Docker client config cannot inject proxy credentials', () => {
    const args = buildSandboxArgs(workDir, ['npm', 'ci', '--ignore-scripts'], 'n', { network: true })
    for (const key of ['HTTP_PROXY', 'https_proxy', 'NO_PROXY', 'all_proxy']) {
      expect(args[args.indexOf(`${key}=`) - 1]).toBe('--env')
    }
  })

  it('passes FORGE_SANDBOX_INSTALL_PROXY only to network-enabled installs', () => {
    process.env['FORGE_SANDBOX_INSTALL_PROXY'] = 'http://proxy.internal:3128'
    try {
      const install = buildSandboxArgs(workDir, ['npm', 'ci', '--ignore-scripts'], 'n', { network: true })
      expect(install[install.indexOf('HTTPS_PROXY') - 1]).toBe('--env')
      expect(install).toContain('NO_PROXY=')
      expect(install.join(' ')).not.toContain('proxy.internal')
      expect(sandboxCliEnv({ network: true })['HTTPS_PROXY']).toBe('http://proxy.internal:3128')
      const check = buildSandboxArgs(workDir, ['npx', '--no-install', 'jest'], 'n')
      expect(check).toContain('HTTPS_PROXY=')
      expect(check.join(' ')).not.toContain('proxy.internal')
      expect(sandboxCliEnv()['HTTPS_PROXY']).toBeUndefined()
    } finally {
      delete process.env['FORGE_SANDBOX_INSTALL_PROXY']
    }
  })
})
