/**
 * Several DSH processes sharing one `worktreeRoot`: the registry lock makes
 * check-and-reserve atomic and every transition sees lines other processes wrote.
 */

import { execFile, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WorktreeService, { REGISTRY_FILE_NAME, REGISTRY_LOCK_NAME, WorktreeError, WorktreeRegistry } from '../src/index.ts'
import type { Config } from '../src/index.ts'

const TEST_TIMEOUT_MS = 60_000
const run = promisify(execFile)
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'create-thread.ts')

/** Registry lock settings for the tests that build a registry directly. */
const LOCKING = { timeoutMs: 1_000, retryIntervalMs: 10, staleMs: 30_000 }

function git(args: readonly string[], cwd?: string): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim()
}

/** The Thread ids a limit error names, with its trailing "and N more" count removed. */
function summarizedThreadIds(message: string): string[] {
  const marker = 'archive one of these Threads first: '
  return message.slice(message.indexOf(marker) + marker.length).replace(/ and \d+ more$/u, '').split(', ')
}

const temporaries: string[] = []

function temporary(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  temporaries.push(dir)
  return dir
}

function repository(): string {
  const dir = temporary('dsh-wm-mp-')
  git(['init', '--quiet', '--initial-branch=main', dir])
  git(['config', 'user.email', 'worktree@example.test'], dir)
  git(['config', 'user.name', 'Worktree Test'], dir)
  writeFileSync(join(dir, 'README.md'), 'seed\n', 'utf8')
  git(['add', '.'], dir)
  git(['commit', '--quiet', '-m', 'seed'], dir)
  return dir
}

/** A second service instance on the same root, standing in for another process. */
async function mount(config: Config): Promise<WorktreeService> {
  const ctx = new Context()
  await ctx.plugin(WorktreeService, { pruneOnStart: false, ...config })
  return ctx.worktrees
}

const signal = () => new AbortController().signal

let worktreeRoot: string
let repoRoot: string

beforeEach(() => {
  worktreeRoot = temporary('dsh-wm-mp-root-')
  repoRoot = repository()
})

afterEach(() => {
  for (const dir of temporaries.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('shared worktreeRoot', { timeout: TEST_TIMEOUT_MS }, () => {
  it('lets exactly one of two instances create the same Thread', async () => {
    const a = await mount({ worktreeRoot })
    const b = await mount({ worktreeRoot })

    const results = await Promise.allSettled([
      a.create({ repoRoot, threadId: 'same', baseRef: 'HEAD' }, signal()),
      b.create({ repoRoot, threadId: 'same', baseRef: 'HEAD' }, signal()),
    ])

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find(result => result.status === 'rejected')
    expect(rejected).toMatchObject({ reason: { code: 'WORKTREE_PATH_IN_USE' } })
    const lines = readFileSync(join(worktreeRoot, REGISTRY_FILE_NAME), 'utf8').trim().split('\n')
    expect(lines.map(line => (JSON.parse(line) as { state: string }).state)).toEqual(['reserved', 'ready'])
  })

  it('refuses a branch another instance already claimed for a different Thread', async () => {
    const a = await mount({ worktreeRoot })
    const b = await mount({ worktreeRoot })
    await a.create({ repoRoot, threadId: 'one', baseRef: 'HEAD', branch: 'shared-branch' }, signal())

    await expect(b.create({ repoRoot, threadId: 'two', baseRef: 'HEAD', branch: 'shared-branch' }, signal()))
      .rejects.toMatchObject({ code: 'WORKTREE_BRANCH_EXISTS' })
  })

  it('shows instance B a record instance A wrote after B loaded', async () => {
    const a = await mount({ worktreeRoot })
    const b = await mount({ worktreeRoot })
    expect(await b.get('late')).toBeUndefined()

    const created = await a.create({ repoRoot, threadId: 'late', baseRef: 'HEAD' }, signal())

    expect(await b.get('late')).toEqual(created)
    expect(await b.list(repoRoot)).toEqual([created])
    // B validates its transition against A's line, not its stale fold.
    await b.remove(created)
    expect((await a.get('late'))?.state).toBe('removed')
  })

  it('enforces maxWorktreesPerRepo across instances', async () => {
    const a = await mount({ worktreeRoot, maxWorktreesPerRepo: 1 })
    const b = await mount({ worktreeRoot, maxWorktreesPerRepo: 1 })

    const results = await Promise.allSettled([
      a.create({ repoRoot, threadId: 'one', baseRef: 'HEAD' }, signal()),
      b.create({ repoRoot, threadId: 'two', baseRef: 'HEAD' }, signal()),
    ])

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'WORKTREE_LIMIT_REACHED' } })
  })

  it('refuses a path occupied on disk and a young reservation held by another instance', async () => {
    const a = await mount({ worktreeRoot })
    const b = await mount({ worktreeRoot })
    const record = await a.create({ repoRoot, threadId: 'occupied', baseRef: 'HEAD' }, signal())
    await a.remove(record, { force: true })
    mkdirSync(record.path, { recursive: true })
    await expect(b.create({ repoRoot, threadId: 'occupied', baseRef: 'HEAD' }, signal()))
      .rejects.toMatchObject({ code: 'WORKTREE_PATH_IN_USE' })

    const registry = new WorktreeRegistry(worktreeRoot, LOCKING)
    await registry.reserve('young', { path: join(worktreeRoot, 'y'), repoRoot, baseRef: 'HEAD', branch: 'y' }, async () => undefined)
    await expect(b.create({ repoRoot, threadId: 'young', baseRef: 'HEAD' }, signal()))
      .rejects.toMatchObject({ code: 'WORKTREE_PATH_IN_USE', message: expect.stringContaining('another process') as string })
  })

  it('summarizes a long list of Threads in the limit error', async () => {
    // The behaviour under test is the LIMIT ERROR and the Thread ids it names, not
    // the creation. Driving 52 real creations through `create` also runs 52
    // reconcile sweeps over a growing fold — each record costs one liveness probe,
    // so the sweep alone is O(n²) subprocesses, which is what blew the budget under
    // coverage. Seeding the fold directly reaches the same registry state: a fresh
    // `reserved` intent is inside the adoption grace period, so the sweep leaves it
    // alone and the limit counts it as active.
    const registry = new WorktreeRegistry(worktreeRoot, LOCKING)
    const seeded = Array.from({ length: 52 }, (_unused, index) => `t${String(index).padStart(2, '0')}`)
    for (const threadId of seeded) {
      await registry.transition(threadId, 'reserved', {
        path: join(worktreeRoot, 'bucket', threadId),
        repoRoot,
        baseRef: 'HEAD',
        branch: `dsh/thread-${threadId}`,
      })
    }
    // Nothing was materialized: the whole point of seeding is that no real git ran.
    expect(git(['worktree', 'list', '--porcelain'], repoRoot).match(/^worktree /gmu)).toHaveLength(1)

    const limited = await mount({ worktreeRoot, maxWorktreesPerRepo: 52 })
    const refusal = await limited.create({ repoRoot, threadId: 'extra', baseRef: 'HEAD' }, signal())
      .then(
        (record) => { throw new Error(`the limit must be enforced, got a ${record.state} record`) },
        (error: unknown) => error,
      )
    if (!(refusal instanceof WorktreeError)) throw new Error(`expected a WorktreeError, got ${String(refusal)}`)

    expect(refusal.code).toBe('WORKTREE_LIMIT_REACHED')
    expect(refusal.message).toContain('and 2 more')
    // The message names the Threads an operator would have to archive: the first
    // 50 of the 52, in the registry's own order.
    expect(summarizedThreadIds(refusal.message)).toEqual(seeded.slice(0, 50))
  })

  it('does not sweep a young reservation another instance is still adding', async () => {
    const a = await mount({ worktreeRoot })
    const b = await mount({ worktreeRoot })
    const registry = new WorktreeRegistry(worktreeRoot, LOCKING)
    await registry.reserve('pending', { path: join(worktreeRoot, 'nowhere'), repoRoot, baseRef: 'HEAD', branch: 'p' }, async () => undefined)

    expect(await b.reconcile()).toEqual([])
    expect((await a.get('pending'))?.state).toBe('reserved')
  })

  it('creates two Threads from two real processes under a limit of one', async () => {
    const spawn = (threadId: string) => run(
      process.execPath,
      ['--import', 'tsx/esm', FIXTURE, worktreeRoot, repoRoot, threadId, `branch-${threadId}`, '1'],
      { cwd: dirname(FIXTURE), encoding: 'utf8' },
    ).then(({ stdout }) => JSON.parse(stdout) as { ok: boolean; code?: string })

    const outcomes = await Promise.all([spawn('p1'), spawn('p2')])

    expect(outcomes.filter(outcome => outcome.ok)).toHaveLength(1)
    expect(outcomes.find(outcome => !outcome.ok)).toEqual({ ok: false, code: 'WORKTREE_LIMIT_REACHED' })
  })
})

describe('registry lock', { timeout: TEST_TIMEOUT_MS }, () => {
  const fields = () => ({ path: join(worktreeRoot, 'p'), repoRoot: '/repo', baseRef: 'HEAD' })

  /** Hold the registry lock through a second registry until `release()` is called. */
  async function holdLock(): Promise<{ release: () => Promise<void> }> {
    let open!: () => void
    const gate = new Promise<void>((resolve) => { open = resolve })
    let acquired!: () => void
    const held = new Promise<void>((resolve) => { acquired = resolve })
    const holder = new WorktreeRegistry(worktreeRoot, LOCKING)
    const done = holder.reserve('holder', { ...fields(), path: join(worktreeRoot, 'holder') }, async () => {
      acquired()
      await gate
      return undefined
    })
    await held
    return { release: async () => { open(); await done } }
  }

  it('fails loud with WORKTREE_REGISTRY_LOCKED when the lock is held past the timeout', async () => {
    const holder = await holdLock()
    try {
      const registry = new WorktreeRegistry(worktreeRoot, { timeoutMs: 100, retryIntervalMs: 10, staleMs: 30_000 })
      await expect(registry.transition('t', 'reserved', fields())).rejects.toMatchObject({ code: 'WORKTREE_REGISTRY_LOCKED' })
      const service = await mount({ worktreeRoot, lockTimeoutMs: 50, lockRetryIntervalMs: 10 })
      await expect(service.create({ repoRoot, threadId: 'blocked', baseRef: 'HEAD' }, signal()))
        .rejects.toMatchObject({ code: 'WORKTREE_REGISTRY_LOCKED' })
    } finally {
      await holder.release()
    }
  })

  it('proceeds once the holder releases within the timeout', async () => {
    const holder = await holdLock()
    setTimeout(() => { void holder.release() }, 150)
    const registry = new WorktreeRegistry(worktreeRoot, { timeoutMs: 5_000, retryIntervalMs: 10, staleMs: 30_000 })

    await expect(registry.transition('t', 'reserved', fields())).resolves.toMatchObject({ state: 'reserved' })
  })

  it('reports a lock lost mid-transition', async () => {
    const registry = new WorktreeRegistry(worktreeRoot, { timeoutMs: 1_000, retryIntervalMs: 10, staleMs: 5_000 })

    await expect(registry.reserve('t', fields(), async () => {
      // Deleting the lock directory makes the library's next refresh (every staleMs/2) fail.
      rmSync(join(worktreeRoot, REGISTRY_LOCK_NAME), { recursive: true })
      await new Promise(resolve => setTimeout(resolve, 3_500))
      return undefined
    })).rejects.toMatchObject({ code: 'WORKTREE_REGISTRY_LOCKED' })
  })

  it('rejects the new config bounds', async () => {
    await expect(mount({ worktreeRoot, lockStaleMs: 1_000 })).rejects.toThrow()
    await expect(mount({ worktreeRoot, lockRetryIntervalMs: 0 })).rejects.toThrow()
  })
})

describe('registry log reading', { timeout: TEST_TIMEOUT_MS }, () => {
  const locking = { timeoutMs: 1_000, retryIntervalMs: 10, staleMs: 30_000 }
  const valid = { threadId: 't', path: '/p', repoRoot: '/r', baseRef: 'HEAD', state: 'ready' }

  it('folds appended lines incrementally and lists records ordered by threadId', async () => {
    const registry = await new WorktreeRegistry(worktreeRoot, locking).load()
    const other = new WorktreeRegistry(worktreeRoot, locking)
    const fields = { path: '/p', repoRoot: '/r', baseRef: 'HEAD' }
    await other.transition('b', 'ready', fields)
    await other.transition('c', 'reserved', fields)
    await other.transition('a', 'ready', fields)

    expect(registry.all()).toEqual([])
    await registry.refresh()
    expect(registry.all().map(record => record.threadId)).toEqual(['a', 'b', 'c'])
    expect(registry.find('b')).toMatchObject({ state: 'ready' })
  })

  it('refuses a transition that is illegal against the fresh log', async () => {
    const a = new WorktreeRegistry(worktreeRoot, locking)
    const b = await new WorktreeRegistry(worktreeRoot, locking).load()
    const fields = { path: '/p', repoRoot: '/r', baseRef: 'HEAD' }
    await a.transition('t', 'reserved', fields)
    await a.transition('t', 'ready', fields)

    await expect(b.transition('t', 'rolled-back', fields)).rejects.toMatchObject({ code: 'WORKTREE_STATE_ILLEGAL' })
  })

  it('reports an unreadable log as WORKTREE_CREATE_FAILED', async () => {
    mkdirSync(join(worktreeRoot, REGISTRY_FILE_NAME), { recursive: true })

    await expect(new WorktreeRegistry(worktreeRoot, locking).load()).rejects.toMatchObject({ code: 'WORKTREE_CREATE_FAILED' })
  })

  it.each([
    ['threadId', { threadId: '' }],
    ['path', { path: '' }],
    ['baseRef', { baseRef: '' }],
    ['repoRoot', { repoRoot: '' }],
    ['state', { state: 'bogus' }],
    ['branch', { branch: 1 }],
    ['base', { base: 'working-tree' }],
    ['baseSha', { baseSha: 1 }],
    ['createdAt', { createdAt: 'x' }],
    ['object', 'text'],
  ])('refuses a terminated line with a bad %s', async (_field, patch) => {
    mkdirSync(worktreeRoot, { recursive: true })
    const bad = typeof patch === 'string' ? JSON.stringify(patch) : JSON.stringify({ ...valid, ...patch })
    writeFileSync(join(worktreeRoot, REGISTRY_FILE_NAME), `${bad}\n${JSON.stringify(valid)}\n`, 'utf8')

    await expect(new WorktreeRegistry(worktreeRoot, locking).load()).rejects.toMatchObject({ code: 'WORKTREE_CREATE_FAILED' })
  })
})
