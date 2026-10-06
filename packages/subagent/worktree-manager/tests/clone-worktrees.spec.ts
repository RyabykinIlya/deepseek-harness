/**
 * The clone-era acceptance matrix (design §6): every Thread worktree is a
 * self-contained local clone, so the Thread can edit AND commit under one
 * sandbox root. Every assertion is read back out of git itself — inside the
 * clone, or in the parent after an archive import.
 */

import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { realpathSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WorktreeService, { REGISTRY_FILE_NAME, WorktreeRegistry } from '../src/index.ts'
import type { Config } from '../src/index.ts'

/** Real git subprocesses run here; the 5s default is too tight when specs share the host. */
const GIT_TIMEOUT_MS = 30_000

/** Run git synchronously with an argv array; returns trimmed stdout. */
function git(args: readonly string[], cwd?: string): string {
  return execFileSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim()
}

/** Registry lock settings for tests that write the sidecar directly. */
const LOCKING = { timeoutMs: 5_000, retryIntervalMs: 10, staleMs: 30_000 }

const temporaries: string[] = []

/** A temp directory that the suite removes afterwards. */
function temporary(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  temporaries.push(dir)
  return dir
}

/** A real git repository with one commit on `main`. */
function repository(): string {
  const dir = temporary('dsh-wm-clone-')
  git(['init', '--quiet', '--initial-branch=main', dir])
  git(['config', 'user.email', 'worktree@example.test'], dir)
  git(['config', 'user.name', 'Worktree Test'], dir)
  writeFileSync(join(dir, 'README.md'), 'seed\n', 'utf8')
  git(['add', '.'], dir)
  git(['commit', '--quiet', '-m', 'seed'], dir)
  return dir
}

/** Write `content` into `file` under `cwd` and commit it. */
function commit(cwd: string, file: string, content: string, message: string): void {
  writeFileSync(join(cwd, file), content, 'utf8')
  git(['add', '.'], cwd)
  git(['-c', 'user.email=t@example.test', '-c', 'user.name=T', 'commit', '--quiet', '-m', message], cwd)
}

/** Mount the service with the startup sweep disabled unless a test asks for it. */
async function mount(config: Config = {}): Promise<{ ctx: Context; service: WorktreeService }> {
  const ctx = new Context()
  await ctx.plugin(WorktreeService, { pruneOnStart: false, ...config })
  return { ctx, service: ctx.worktrees }
}

/** Durable sidecar states, in append order. */
function sidecarStates(worktreeRoot: string): string[] {
  return readFileSync(join(worktreeRoot, REGISTRY_FILE_NAME), 'utf8')
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => String((JSON.parse(line) as { state: unknown }).state))
}

/**
 * Append one durable `reserved` line for a worktree that never materialized, as a
 * crashed process left it.
 * @param worktreeRoot - the configured root holding the sidecar.
 * @param threadId - the Thread the reservation belongs to.
 * @param path - the worktree path the reservation claims (absent on disk).
 * @param repoRoot - the parent repository the reservation names.
 */
function writeReservedLine(worktreeRoot: string, threadId: string, path: string, repoRoot: string): void {
  const registry = new WorktreeRegistry(worktreeRoot, LOCKING)
  mkdirSync(worktreeRoot, { recursive: true })
  appendFileSync(
    join(worktreeRoot, REGISTRY_FILE_NAME),
    `${JSON.stringify({ threadId, path, repoRoot, baseRef: 'HEAD', state: 'reserved', createdAt: 0 })}\n`,
    'utf8',
  )
  expect(registry.find(threadId)).toBeUndefined()
}

let worktreeRoot: string

beforeEach(() => {
  worktreeRoot = temporary('dsh-wm-clone-root-')
})

afterEach(() => {
  for (const dir of temporaries.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('a created worktree is self-contained', { timeout: GIT_TIMEOUT_MS }, () => {
  it('keeps its git metadata inside the worktree and works with the parent gone', async () => {
    const repoRoot = repository()
    const { service } = await mount({ worktreeRoot })
    const record = await service.create(
      { repoRoot, threadId: 'thread-standalone', baseRef: 'HEAD' },
      new AbortController().signal,
    )

    const gitDir = git(['rev-parse', '--git-dir'], record.path)
    expect(resolve(record.path, gitDir).startsWith(record.path + sep)).toBe(true)

    // The parent repository is not reachable at all and the checkout still works:
    // this is the property that makes a Thread's commits sandbox-legal.
    renameSync(repoRoot, `${repoRoot}-moved`)
    expect(git(['status', '--porcelain'], record.path)).toBe('')
  })

  it('lets the Thread commit inside its own root, and reports the commit', async () => {
    const repoRoot = repository()
    const { service } = await mount({ worktreeRoot })
    const record = await service.create(
      { repoRoot, threadId: 'thread-commit', baseRef: 'HEAD' },
      new AbortController().signal,
    )

    commit(record.path, 'work.txt', 'thread work\n', 'thread work')

    expect(git(['rev-parse', 'HEAD'], record.path)).not.toBe(git(['rev-parse', 'HEAD'], repoRoot))
    const changes = await service.changes(record, { maxCommits: 10, maxFiles: 10 })
    expect(changes.commits.map(entry => entry.subject)).toEqual(['thread work'])
    expect(changes.files.map(entry => entry.path)).toEqual(['work.txt'])
    expect(changes.uncommitted).toBe(0)
    expect(await service.status(record)).toEqual({ clean: true, changed: 0, commitsAhead: 1 })
  })

  it('delivers head-with-uncommitted edits with a resolvable base commit', async () => {
    const repoRoot = repository()
    writeFileSync(join(repoRoot, 'README.md'), 'seed\nparent edit\n', 'utf8')
    const { service } = await mount({ worktreeRoot })

    const record = await service.create(
      { repoRoot, threadId: 'thread-snapshot', baseRef: 'HEAD', base: 'head-with-uncommitted' },
      new AbortController().signal,
    )

    expect(readFileSync(join(record.path, 'README.md'), 'utf8')).toBe('seed\nparent edit\n')
    // The snapshot commit is present in the clone by construction, not by luck.
    expect(record.baseSha).toBe(git(['rev-parse', '--verify', `${record.baseSha ?? ''}^{commit}`], record.path))
    const changes = await service.changes(record, { maxCommits: 10, maxFiles: 10 })
    expect(changes.baseSha).toBe(record.baseSha)
    expect(changes.commitsTotal).toBe(0)
    expect(changes.uncommitted).toBe(0)
  })
})

describe('archive keeps the branch', { timeout: GIT_TIMEOUT_MS }, () => {
  it('imports the branch at the Thread tip and a restart re-attaches with commits intact', async () => {
    const repoRoot = repository()
    const { service } = await mount({ worktreeRoot })
    const spec = { repoRoot, threadId: 'thread-archive', baseRef: 'HEAD' }
    const first = await service.create(spec, new AbortController().signal)
    commit(first.path, 'work.txt', 'thread work\n', 'thread work')
    const tip = git(['rev-parse', 'HEAD'], first.path)

    await service.remove(first)

    expect(existsSync(first.path)).toBe(false)
    expect(git(['rev-parse', '--verify', 'dsh/thread-thread-archive'], repoRoot)).toBe(tip)
    expect((await service.get('thread-archive'))?.state).toBe('removed')

    const second = await service.create(spec, new AbortController().signal)

    expect(second.state).toBe('ready')
    expect(git(['rev-parse', 'HEAD'], second.path)).toBe(tip)
    expect(readFileSync(join(second.path, 'work.txt'), 'utf8')).toBe('thread work\n')
    expect(git(['log', '-1', '--format=%s'], second.path)).toBe('thread work')
  })

  it('refuses to eat unsaved work without force and imports the branch with force', async () => {
    const repoRoot = repository()
    const { service } = await mount({ worktreeRoot })
    const record = await service.create(
      { repoRoot, threadId: 'thread-dirty', baseRef: 'HEAD' },
      new AbortController().signal,
    )
    writeFileSync(join(record.path, 'unsaved.txt'), 'unsaved\n', 'utf8')

    await expect(service.remove(record)).rejects.toMatchObject({ code: 'REMOVE_DIRTY_WITHOUT_FORCE' })
    expect(existsSync(record.path)).toBe(true)

    await service.remove(record, { force: true })

    expect(existsSync(record.path)).toBe(false)
    expect(git(['rev-parse', '--verify', 'dsh/thread-thread-dirty'], repoRoot)).toBe(record.baseSha ?? '')
  })

  it('refuses a removal whose branch cannot be imported into the parent', async () => {
    const repoRoot = repository()
    const { service } = await mount({ worktreeRoot })
    const record = await service.create(
      { repoRoot, threadId: 'thread-import', baseRef: 'HEAD' },
      new AbortController().signal,
    )
    // The clone is gone, so the archive contract ("the branch is kept") cannot be
    // honoured; dropping the branch anyway would be the silent degradation.
    rmSync(record.path, { recursive: true, force: true })

    await expect(service.remove(record, { force: true })).rejects.toMatchObject({ code: 'WORKTREE_OPERATION_FAILED' })

    expect((await service.get('thread-import'))?.state).toBe('removing')
    expect(git(['branch', '--list', 'dsh/thread-thread-import'], repoRoot)).toBe('')
  })
})

describe('mergeCheck across clones', { timeout: GIT_TIMEOUT_MS }, () => {
  it('answers for a parent that moved past the clone base', async () => {
    const repoRoot = repository()
    const { service } = await mount({ worktreeRoot })
    const record = await service.create(
      { repoRoot, threadId: 'thread-parent-moved', baseRef: 'HEAD' },
      new AbortController().signal,
    )
    commit(repoRoot, 'parent.txt', 'parent work\n', 'parent work')

    const result = await service.mergeCheck(record, { target: 'HEAD' }, 10)

    expect(result).toMatchObject({
      supported: true,
      targetSha: git(['rev-parse', 'HEAD'], repoRoot),
      clean: true,
      conflictsTotal: 0,
    })
  })

  it('answers a target that names another Thread\'s branch from that Thread\'s clone', async () => {
    const repoRoot = repository()
    const { service } = await mount({ worktreeRoot })
    const first = await service.create(
      { repoRoot, threadId: 'thread-sibling-a', baseRef: 'HEAD' },
      new AbortController().signal,
    )
    const second = await service.create(
      { repoRoot, threadId: 'thread-sibling-b', baseRef: 'HEAD' },
      new AbortController().signal,
    )
    commit(first.path, 'a.txt', 'first\n', 'first work')
    commit(second.path, 'a.txt', 'second\n', 'second work')

    const result = await service.mergeCheck(second, { target: first.branch ?? '' }, 10)

    expect(result).toMatchObject({
      supported: true,
      targetSha: git(['rev-parse', first.branch ?? ''], first.path),
      clean: false,
      conflicts: ['a.txt'],
      conflictsTotal: 1,
    })
  })
})

describe('sweep independence', { timeout: GIT_TIMEOUT_MS }, () => {
  it('settles records whose parent repository was renamed away instead of throwing', async () => {
    const repoRoot = repository()
    const { service } = await mount({ worktreeRoot, adoptionGraceMs: 0 })
    const record = await service.create(
      { repoRoot, threadId: 'thread-orphan-live', baseRef: 'HEAD', detached: true },
      new AbortController().signal,
    )
    writeReservedLine(worktreeRoot, 'thread-orphan-ghost', join(worktreeRoot, 'bucket', 'thread-orphan-ghost'), repoRoot)
    service.sessionExists = () => false

    renameSync(repoRoot, `${repoRoot}-moved`)

    const orphans = await service.reconcile()

    expect(orphans.map(entry => entry.threadId)).toEqual(['thread-orphan-ghost', 'thread-orphan-live'])
    expect((await service.get('thread-orphan-live'))?.state).toBe('removed')
    expect((await service.get('thread-orphan-ghost'))?.state).toBe('rolled-back')
    expect(existsSync(record.path)).toBe(false)
    expect(sidecarStates(worktreeRoot)).toEqual([
      'reserved', 'ready',
      'reserved',
      'orphaned', 'rolled-back',
      'orphaned', 'removing', 'removed',
    ])
  })
})

describe('detached worktrees', { timeout: GIT_TIMEOUT_MS }, () => {
  it('checks out at the base and records no branch', async () => {
    const repoRoot = repository()
    const { service } = await mount({ worktreeRoot })

    const record = await service.create(
      { repoRoot, threadId: 'thread-detached', baseRef: 'HEAD', detached: true },
      new AbortController().signal,
    )

    expect(record.branch).toBeUndefined()
    expect('branch' in record).toBe(false)
    expect(git(['branch', '--show-current'], record.path)).toBe('')
    expect(git(['rev-parse', 'HEAD'], record.path)).toBe(record.baseSha ?? '')
    const lines = readFileSync(join(worktreeRoot, REGISTRY_FILE_NAME), 'utf8')
      .split('\n')
      .filter(line => line.trim() !== '')
      .map(line => JSON.parse(line) as Record<string, unknown>)
    expect(lines).toHaveLength(2)
    expect(lines.every(line => !('branch' in line))).toBe(true)
  })
})
