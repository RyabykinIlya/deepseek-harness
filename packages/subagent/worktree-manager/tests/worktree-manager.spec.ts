/**
 * SBFT matrix rows A1–A9 (design §12) for the worktree service.
 *
 * These drive the REAL service against REAL temporary git repositories: every
 * assertion about a worktree, a branch, or cleanliness is read back out of git
 * itself, never out of the service's own bookkeeping.
 */

import { execFileSync } from 'node:child_process'
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { realpathSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WorktreeService, { REGISTRY_FILE_NAME, WorktreeRegistry, threadSlug } from '../src/index.ts'
import type { Config, WorktreeRecord, WorktreeState } from '../src/index.ts'

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

/** Absolute paths of the managed worktree directories currently on disk. */
function worktreePaths(worktreeRoot: string): string[] {
  if (!existsSync(worktreeRoot)) return []
  const paths: string[] = []
  for (const bucket of readdirSync(worktreeRoot, { withFileTypes: true })) {
    if (!bucket.isDirectory()) continue
    for (const entry of readdirSync(join(worktreeRoot, bucket.name), { withFileTypes: true })) {
      if (entry.isDirectory()) paths.push(join(worktreeRoot, bucket.name, entry.name))
    }
  }
  return paths
}

/** Branch names git currently reports for `repoRoot` (markers stripped). */
function branchNames(repoRoot: string): string[] {
  return git(['branch', '--list'], repoRoot)
    .split('\n')
    // `*` marks the checked-out branch, `+` one checked out in another worktree.
    .map(line => line.replace(/^[*+]\s*/u, '').trim())
    .filter(line => line !== '')
}

/** Registry lock settings for tests that build a registry directly. */
const LOCKING = { timeoutMs: 5_000, retryIntervalMs: 10, staleMs: 30_000 }

const temporaries: string[] = []

/** A temp directory that the suite removes afterwards. */
function temporary(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  temporaries.push(dir)
  return dir
}

/** A real git repository with one commit, or a bare directory when `init` is false. */
function repository({ init = true }: { init?: boolean } = {}): string {
  const dir = temporary('dsh-wm-')
  if (!init) return dir
  git(['init', '--quiet', '--initial-branch=main', dir])
  git(['config', 'user.email', 'worktree@example.test'], dir)
  git(['config', 'user.name', 'Worktree Test'], dir)
  writeFileSync(join(dir, 'README.md'), 'seed\n', 'utf8')
  git(['add', '.'], dir)
  git(['commit', '--quiet', '-m', 'seed'], dir)
  return dir
}

/** Mount the service with the startup sweep disabled unless a test asks for it. */
async function mount(config: Config = {}): Promise<{ ctx: Context; service: WorktreeService }> {
  const ctx = new Context()
  await ctx.plugin(WorktreeService, { pruneOnStart: false, ...config })
  return { ctx, service: ctx.worktrees }
}

/** Durable sidecar lines, in append order. */
function sidecar(worktreeRoot: string): Record<string, unknown>[] {
  return readFileSync(join(worktreeRoot, REGISTRY_FILE_NAME), 'utf8')
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line) as Record<string, unknown>)
}

/** Durable sidecar lines, or `[]` while no file exists yet. */
function sidecarOrEmpty(worktreeRoot: string): Record<string, unknown>[] {
  try {
    return sidecar(worktreeRoot)
  } catch {
    return []
  }
}

/**
 * Make every git checkout this process spawns slow enough to abort while creation is
 * genuinely in flight.
 *
 * A clone does not copy the parent's hooks, so the sleeping `post-checkout` hook is
 * delivered through `core.hooksPath` in git's config environment — which the clone's
 * single checkout consults.
 * @returns a function that restores the process environment.
 */
function slowCheckout(): () => void {
  const hooks = temporary('dsh-wm-hooks-')
  const hook = join(hooks, 'post-checkout')
  writeFileSync(hook, '#!/bin/sh\nsleep 0.4\n', 'utf8')
  chmodSync(hook, 0o755)
  const previousCount = process.env.GIT_CONFIG_COUNT
  const index = previousCount === undefined ? 0 : Number(previousCount)
  process.env.GIT_CONFIG_COUNT = String(index + 1)
  process.env[`GIT_CONFIG_KEY_${index}`] = 'core.hooksPath'
  process.env[`GIT_CONFIG_VALUE_${index}`] = hooks
  return () => {
    if (previousCount === undefined) delete process.env.GIT_CONFIG_COUNT
    else process.env.GIT_CONFIG_COUNT = previousCount
    delete process.env[`GIT_CONFIG_KEY_${index}`]
    delete process.env[`GIT_CONFIG_VALUE_${index}`]
  }
}

let worktreeRoot: string

beforeEach(() => {
  worktreeRoot = temporary('dsh-wm-root-')
})

afterEach(() => {
  for (const dir of temporaries.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('SBFT A1 — create a worktree', { timeout: GIT_TIMEOUT_MS }, () => {
  it('publishes a ready record whose path git itself reports', async () => {
    const repoRoot = repository()
    const { service } = await mount({ worktreeRoot })

    const record = await service.create(
      { repoRoot, threadId: 'thread-a1', baseRef: 'HEAD' },
      new AbortController().signal,
    )

    expect(record.state).toBe('ready')
    expect(record.threadId).toBe('thread-a1')
    expect(record.baseRef).toBe('HEAD')
    expect(record.branch).toBe('dsh/thread-thread-a1')
    expect(record.repoRoot).toBe(repoRoot)
    expect(record.path.startsWith('/')).toBe(true)
    expect(worktreePaths(worktreeRoot)).toContain(record.path)
    expect(branchNames(record.path)).toContain('dsh/thread-thread-a1')
    // The durable intent is on disk BEFORE the add, so the log shows both steps.
    expect(sidecar(worktreeRoot).map(line => line.state)).toEqual(['reserved', 'ready'])
    // A ready worktree is clean: nothing was written into it yet.
    expect(await service.status(record)).toEqual({ clean: true, changed: 0, commitsAhead: 0 })
  })

  it('accepts a subdirectory of the checkout and normalizes to the top level', async () => {
    const repoRoot = repository()
    const nested = join(repoRoot, 'docs')
    mkdirSync(nested, { recursive: true })
    const { service } = await mount({ worktreeRoot })

    const record = await service.create(
      { repoRoot: nested, threadId: 'thread-sub', baseRef: 'HEAD' },
      new AbortController().signal,
    )

    expect(record.repoRoot).toBe(repoRoot)
    expect((await service.list(nested)).map(entry => entry.threadId)).toEqual(['thread-sub'])
  })
})

describe('SBFT A2 — re-create is idempotent', { timeout: GIT_TIMEOUT_MS }, () => {
  it('returns the same record and never adds a second worktree', async () => {
    const repoRoot = repository()
    const { service } = await mount({ worktreeRoot })
    const spec = { repoRoot, threadId: 'thread-a2', baseRef: 'HEAD' }

    const first = await service.create(spec, new AbortController().signal)
    const second = await service.create(spec, new AbortController().signal)

    expect(second).toEqual(first)
    // Exactly the one managed worktree we created, with its own branch inside it.
    expect(worktreePaths(worktreeRoot)).toHaveLength(1)
    expect(branchNames(first.path)).toHaveLength(2)
  })

  it('shares one attempt between concurrent creates of the same thread', async () => {
    const repoRoot = repository()
    const restore = slowCheckout()
    try {
      const { service } = await mount({ worktreeRoot })
      const spec = { repoRoot, threadId: 'thread-race', baseRef: 'HEAD' }
      const signal = new AbortController().signal

      const [a, b] = await Promise.all([service.create(spec, signal), service.create(spec, signal)])

      expect(b).toEqual(a)
      expect(worktreePaths(worktreeRoot)).toHaveLength(1)
    } finally {
      restore()
    }
  })
})

describe('SBFT A3 — a non-git directory is refused', { timeout: GIT_TIMEOUT_MS }, () => {
  it('rejects with NOT_A_GIT_REPO and creates nothing', async () => {
    const notARepo = repository({ init: false })
    const { service } = await mount({ worktreeRoot })

    await expect(service.create(
      { repoRoot: notARepo, threadId: 'thread-a3', baseRef: 'HEAD' },
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'NOT_A_GIT_REPO' })

    // No silent degradation: not even a reservation survives the refusal.
    expect(() => readFileSync(join(worktreeRoot, REGISTRY_FILE_NAME), 'utf8')).toThrow()
    await expect(service.list(notARepo)).rejects.toMatchObject({ code: 'NOT_A_GIT_REPO' })
  })

  it('rejects a relative repoRoot', async () => {
    const { service } = await mount({ worktreeRoot })
    await expect(service.create(
      { repoRoot: 'relative/repo', threadId: 'thread-rel', baseRef: 'HEAD' },
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'NOT_A_GIT_REPO' })
  })

  it('rejects an empty repoRoot under the default explicit resolution', async () => {
    const { service } = await mount({ worktreeRoot })
    await expect(service.create(
      { repoRoot: '', threadId: 'thread-empty', baseRef: 'HEAD' },
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'NOT_A_GIT_REPO' })
  })

  it('resolves an empty repoRoot from the launch checkout under parent-cwd', async () => {
    const repoRoot = repository()
    const previous = process.cwd()
    process.chdir(repoRoot)
    try {
      const { service } = await mount({ worktreeRoot, repoRootResolution: 'parent-cwd' })
      const record = await service.create(
        { repoRoot: '', threadId: 'thread-parent', baseRef: 'HEAD' },
        new AbortController().signal,
      )
      expect(record.repoRoot).toBe(repoRoot)
    } finally {
      process.chdir(previous)
    }
  })
})

describe('SBFT A4 — an existing branch is refused', { timeout: GIT_TIMEOUT_MS }, () => {
  it('rejects with WORKTREE_BRANCH_EXISTS and adds no worktree', async () => {
    const repoRoot = repository()
    git(['branch', 'dsh/thread-thread-a4'], repoRoot)
    const { service } = await mount({ worktreeRoot })

    await expect(service.create(
      { repoRoot, threadId: 'thread-a4', baseRef: 'HEAD' },
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'WORKTREE_BRANCH_EXISTS' })

    expect(worktreePaths(worktreeRoot)).toEqual([])
    expect(sidecarOrEmpty(worktreeRoot)).toEqual([])
  })

  it('refuses a worktree path that is already occupied on disk', async () => {
    const repoRoot = repository()
    const { service } = await mount({ worktreeRoot })
    const first = await service.create(
      { repoRoot, threadId: 'thread-path', baseRef: 'HEAD' },
      new AbortController().signal,
    )

    // A different Thread cannot be parked on another Thread's worktree path.
    const occupied = join(first.path)
    expect(occupied.startsWith(worktreeRoot)).toBe(true)
    await expect(service.create(
      { repoRoot, threadId: 'thread-path-2', baseRef: 'HEAD' },
      new AbortController().signal,
    )).resolves.toMatchObject({ state: 'ready' })
    expect(first.path).not.toBe(
      (await service.list(repoRoot)).find(entry => entry.threadId === 'thread-path-2')?.path,
    )
  })
})

describe('SBFT A5 — an already-aborted signal never reaches git', { timeout: GIT_TIMEOUT_MS }, () => {
  it('rejects before spawning git and creates no worktree', async () => {
    const repoRoot = repository()
    const { service } = await mount({ worktreeRoot })
    const controller = new AbortController()
    controller.abort()

    await expect(service.create(
      { repoRoot, threadId: 'thread-a5', baseRef: 'HEAD' },
      controller.signal,
    )).rejects.toMatchObject({ name: 'AbortError' })

    expect(worktreePaths(worktreeRoot)).toEqual([])
    expect(() => readFileSync(join(worktreeRoot, REGISTRY_FILE_NAME), 'utf8')).toThrow()
  })
})

describe('SBFT A6 — an abort mid-creation rolls the reservation back', { timeout: GIT_TIMEOUT_MS }, () => {
  it('removes the worktree in the provider finally and settles as rolled-back', async () => {
    const repoRoot = repository()
    // The clone's single checkout runs the sleeping post-checkout hook, so creation is
    // provably still in flight while the abort lands — no sleeps in the assertion path.
    const restore = slowCheckout()
    try {
      const { service } = await mount({ worktreeRoot })
      const controller = new AbortController()

      const attempt = service.create(
        { repoRoot, threadId: 'thread-a6', baseRef: 'HEAD' },
        controller.signal,
      )
      // Wait for the durable intent, which is written before the clone is spawned.
      while (sidecarOrEmpty(worktreeRoot).length === 0) {
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      controller.abort()

      await expect(attempt).rejects.toMatchObject({ name: 'AbortError' })

      expect(worktreePaths(worktreeRoot)).toEqual([])
      expect(sidecar(worktreeRoot).map(line => line.state)).toEqual(['reserved', 'rolled-back'])
      expect((await service.list(repoRoot))).toEqual([])
    } finally {
      restore()
    }
  })
})

describe('SBFT A7 — removal is explicit and refuses to eat unsaved work', { timeout: GIT_TIMEOUT_MS }, () => {
  it('refuses a dirty worktree without force and removes it with force', async () => {
    const repoRoot = repository()
    const { service } = await mount({ worktreeRoot })
    const record = await service.create(
      { repoRoot, threadId: 'thread-a7', baseRef: 'HEAD' },
      new AbortController().signal,
    )
    writeFileSync(join(record.path, 'work.txt'), 'unsaved\n', 'utf8')
    expect(await service.status(record)).toEqual({ clean: false, changed: 1, commitsAhead: 0 })

    await expect(service.remove(record)).rejects.toMatchObject({ code: 'REMOVE_DIRTY_WITHOUT_FORCE' })
    // The refusal left a `removing` tombstone, not a lost record.
    expect(worktreePaths(worktreeRoot)).toContain(record.path)
    expect((await service.list(repoRoot)).map(entry => entry.state)).toEqual(['removing'])

    await service.remove(record, { force: true })

    expect(worktreePaths(worktreeRoot)).toEqual([])
    expect(() => readFileSync(record.path, 'utf8')).toThrow()
    // Design §2: "what to delete on close" is keyed on `(threadId, path)`, NOT on
    // the branch — so the branch (and any commit only it reaches) survives removal.
    expect(branchNames(repoRoot)).toContain('dsh/thread-thread-a7')
    expect(git(['branch', '--list', '--format=%(worktreepath)', 'dsh/thread-thread-a7'], repoRoot)).toBe('')
    expect(await service.list(repoRoot)).toEqual([])
  })

  it('is idempotent for an already-removed record and loud for an unknown thread', async () => {
    const repoRoot = repository()
    const { service } = await mount({ worktreeRoot })
    const record = await service.create(
      { repoRoot, threadId: 'thread-a7b', baseRef: 'HEAD' },
      new AbortController().signal,
    )
    await service.remove(record)

    await expect(service.remove(record)).resolves.toBeUndefined()
    await expect(service.remove({ ...record, threadId: 'never-existed' })).rejects.toMatchObject({
      code: 'WORKTREE_NOT_FOUND',
    })
  })

  it('leaves a removing tombstone when a forced removal still fails', async () => {
    const repoRoot = repository()
    const { service } = await mount({ worktreeRoot })
    const record = await service.create({ repoRoot, threadId: 'thread-tombstone', baseRef: 'HEAD' }, new AbortController().signal)
    // The bucket refuses deletion, so the `rm` itself fails even with force.
    chmodSync(dirname(record.path), 0o500)
    try {
      await expect(service.remove(record, { force: true })).rejects.toMatchObject({ code: 'WORKTREE_OPERATION_FAILED' })

      expect((await service.get('thread-tombstone'))?.state).toBe('removing')
    } finally {
      chmodSync(dirname(record.path), 0o755)
    }
  })

  it('refuses a worktree path occupied by a plain file', async () => {
    const repoRoot = repository()
    const { service } = await mount({ worktreeRoot })
    const spec = { repoRoot, threadId: 'thread-file', baseRef: 'HEAD' }
    const first = await service.create(spec, new AbortController().signal)
    await service.remove(first)
    writeFileSync(first.path, 'not a directory\n', 'utf8')

    await expect(service.create(spec, new AbortController().signal))
      .rejects.toMatchObject({ code: 'WORKTREE_PATH_IN_USE' })
  })

  it('allows re-creating a thread after its worktree was removed', async () => {
    const repoRoot = repository()
    const { service } = await mount({ worktreeRoot })
    const spec = { repoRoot, threadId: 'thread-restart', baseRef: 'HEAD' }
    const first = await service.create(spec, new AbortController().signal)
    await service.remove(first)

    const second = await service.create(spec, new AbortController().signal)

    expect(second.state).toBe('ready')
    expect(second.path).toBe(first.path)
    expect(sidecar(worktreeRoot).map(line => line.state)).toEqual(['reserved', 'ready', 'removing', 'removed', 'reserved', 'ready'])
  })
})

describe('SBFT A8 — a vanished worktree is never reported clean', { timeout: GIT_TIMEOUT_MS }, () => {
  it('throws WORKTREE_NOT_FOUND instead of clean:true', async () => {
    const repoRoot = repository()
    const { service } = await mount({ worktreeRoot })
    const record: WorktreeRecord = await service.create(
      { repoRoot, threadId: 'thread-a8', baseRef: 'HEAD' },
      new AbortController().signal,
    )
    rmSync(record.path, { recursive: true, force: true })

    await expect(service.status(record)).rejects.toMatchObject({ code: 'WORKTREE_NOT_FOUND' })
  })

  it('throws WORKTREE_NOT_FOUND when the path is no longer a work tree', async () => {
    const repoRoot = repository()
    const { service } = await mount({ worktreeRoot })
    const record = await service.create(
      { repoRoot, threadId: 'thread-a8b', baseRef: 'HEAD' },
      new AbortController().signal,
    )
    // The checkout is dismantled but the directory stays: a bare directory is not a
    // live worktree, and git — not the filesystem — decides.
    rmSync(record.path, { recursive: true, force: true })
    mkdirSync(record.path, { recursive: true })

    await expect(service.status(record)).rejects.toMatchObject({ code: 'WORKTREE_NOT_FOUND' })
  })

  it('refuses to silently re-add over a record whose worktree vanished', async () => {
    const repoRoot = repository()
    const { service } = await mount({ worktreeRoot })
    const spec = { repoRoot, threadId: 'thread-a8c', baseRef: 'HEAD' }
    const record = await service.create(spec, new AbortController().signal)
    rmSync(record.path, { recursive: true, force: true })

    await expect(service.create(spec, new AbortController().signal)).rejects.toMatchObject({
      code: 'WORKTREE_ORPHANED',
    })
  })
})

describe('SBFT A9 — two threads stay disjoint', { timeout: GIT_TIMEOUT_MS }, () => {
  it('gives each thread its own path and branch and leaves the parent checkout clean', async () => {
    const repoRoot = repository()
    const { service } = await mount({ worktreeRoot })

    const a = await service.create({ repoRoot, threadId: 'thread-a', baseRef: 'HEAD' }, new AbortController().signal)
    const b = await service.create({ repoRoot, threadId: 'thread-b', baseRef: 'HEAD' }, new AbortController().signal)

    expect(a.path).not.toBe(b.path)
    expect(a.branch).not.toBe(b.branch)
    expect(new Set(worktreePaths(worktreeRoot))).toEqual(new Set([a.path, b.path]))
    // Each clone owns its own branch; the user's checkout gains none of them.
    expect(branchNames(repoRoot)).toEqual(['main'])
    expect(new Set(branchNames(a.path))).toEqual(new Set(['main', 'dsh/thread-thread-a']))
    expect(new Set(branchNames(b.path))).toEqual(new Set(['main', 'dsh/thread-thread-b']))
    // The whole point: the user's own checkout is untouched by Thread activity.
    expect(git(['status', '--porcelain'], repoRoot)).toBe('')
    expect(git(['status', '--porcelain'], a.path)).toBe('')
  })

  it('reports the worktree limit with the existing Thread ids, and frees it after remove', async () => {
    const repoRoot = repository()
    const { service } = await mount({ worktreeRoot, maxWorktreesPerRepo: 1 })
    const first = await service.create({ repoRoot, threadId: 'thread-cap-1', baseRef: 'HEAD' }, new AbortController().signal)

    const refused = service.create({ repoRoot, threadId: 'thread-cap-2', baseRef: 'HEAD' }, new AbortController().signal)
    await expect(refused).rejects.toMatchObject({ code: 'WORKTREE_LIMIT_REACHED' })
    await expect(refused).rejects.toThrow(/thread-cap-1/u)

    await service.remove(first)
    await expect(service.create({ repoRoot, threadId: 'thread-cap-2', baseRef: 'HEAD' }, new AbortController().signal))
      .resolves.toMatchObject({ state: 'ready' })
  })

  it('counts limits per repository', async () => {
    const one = repository()
    const two = repository()
    const { service } = await mount({ worktreeRoot, maxWorktreesPerRepo: 1 })
    await service.create({ repoRoot: one, threadId: 'thread-r1', baseRef: 'HEAD' }, new AbortController().signal)
    await expect(service.create({ repoRoot: two, threadId: 'thread-r2', baseRef: 'HEAD' }, new AbortController().signal))
      .resolves.toMatchObject({ state: 'ready' })
  })
})

describe('thread slug', { timeout: GIT_TIMEOUT_MS }, () => {
  it('uses one slug for directory and branch, keeps the full id in the record', async () => {
    const repoRoot = repository()
    const { service } = await mount({ worktreeRoot })
    const threadId = `weird id:${'x'.repeat(80)}`
    const record = await service.create({ repoRoot, threadId, baseRef: 'HEAD' }, new AbortController().signal)

    const slug = threadSlug(threadId)
    expect(record.threadId).toBe(threadId)
    expect(basename(record.path)).toBe(slug)
    expect(record.branch).toBe(`dsh/thread-${slug}`)
    expect(threadSlug('plain-id')).toBe('plain-id')
    expect(threadSlug('a b')).not.toBe(threadSlug('a-b'))
    expect(threadSlug('///')).toMatch(/^thread-[0-9a-f]{8}$/u)
  })
})

describe('get, baseSha, status and changes', { timeout: GIT_TIMEOUT_MS }, () => {
  /** Commit a file inside a worktree. */
  function commit(cwd: string, file: string, content: string, message: string): void {
    mkdirSync(dirname(join(cwd, file)), { recursive: true })
    writeFileSync(join(cwd, file), content, 'utf8')
    git(['add', '.'], cwd)
    git(['-c', 'user.email=t@example.test', '-c', 'user.name=T', 'commit', '--quiet', '-m', message], cwd)
  }

  it('get returns the latest record in any state', async () => {
    const repoRoot = repository()
    const { service } = await mount({ worktreeRoot })
    expect(await service.get('nope')).toBeUndefined()
    const record = await service.create({ repoRoot, threadId: 'thread-get', baseRef: 'HEAD' }, new AbortController().signal)
    expect((await service.get('thread-get'))?.state).toBe('ready')
    await service.remove(record)
    expect((await service.get('thread-get'))?.state).toBe('removed')
  })

  it('records the resolved base commit and persists it in the sidecar', async () => {
    const repoRoot = repository()
    const head = git(['rev-parse', 'HEAD'], repoRoot)
    const { service } = await mount({ worktreeRoot })
    const record = await service.create({ repoRoot, threadId: 'thread-sha', baseRef: 'main' }, new AbortController().signal)

    expect(record.baseSha).toBe(head)
    expect(sidecar(worktreeRoot).map(line => line.baseSha)).toEqual([undefined, head])
    const reloaded = await new WorktreeRegistry(worktreeRoot, LOCKING).load()
    expect(reloaded.find('thread-sha')?.baseSha).toBe(head)
    expect(typeof reloaded.find('thread-sha')?.createdAt).toBe('number')
  })

  it('loads an old record that has no baseSha and counts from baseRef', async () => {
    const repoRoot = repository()
    const { service } = await mount({ worktreeRoot })
    const created = await service.create({ repoRoot, threadId: 'thread-old', baseRef: 'main' }, new AbortController().signal)
    const { baseSha: _dropped, ...old } = created
    commit(created.path, 'a.txt', 'a\n', 'one')
    expect(await service.status(old)).toEqual({ clean: true, changed: 0, commitsAhead: 1 })
  })

  it('counts commits ahead and uncommitted entries', async () => {
    const repoRoot = repository()
    const { service } = await mount({ worktreeRoot })
    const record = await service.create({ repoRoot, threadId: 'thread-ahead', baseRef: 'HEAD' }, new AbortController().signal)
    commit(record.path, 'a.txt', 'a\n', 'one')
    commit(record.path, 'b.txt', 'b\n', 'two')
    writeFileSync(join(record.path, 'dirty.txt'), 'x', 'utf8')

    expect(await service.status(record)).toEqual({ clean: false, changed: 1, commitsAhead: 2 })
  })

  it('lists commits newest first and files with binary detection, bounded', async () => {
    const repoRoot = repository()
    const { service } = await mount({ worktreeRoot })
    const record = await service.create({ repoRoot, threadId: 'thread-chg', baseRef: 'HEAD' }, new AbortController().signal)
    commit(record.path, 'a.txt', 'a\nb\n', 'first | subject')
    writeFileSync(join(record.path, 'bin.dat'), Buffer.from([0, 1, 2, 0, 255]))
    commit(record.path, 'src/c.txt', 'c\n', 'second')
    writeFileSync(join(record.path, 'dirty.txt'), 'x', 'utf8')

    const all = await service.changes(record, { maxCommits: 10, maxFiles: 10 })
    expect(all.baseSha).toBe(record.baseSha)
    expect(all.headSha).toBe(git(['rev-parse', 'HEAD'], record.path))
    expect(all.commits.map(c => c.subject)).toEqual(['second', 'first | subject'])
    expect(all.commitsTotal).toBe(2)
    expect(all.filesTotal).toBe(3)
    expect(all.files).toEqual(expect.arrayContaining([
      { path: 'a.txt', added: 2, removed: 0 },
      { path: 'src/c.txt', added: 1, removed: 0 },
      { path: 'bin.dat', binary: true },
    ]))
    expect(all.uncommitted).toBe(1)

    const tiny = await service.changes(record, { maxCommits: 1, maxFiles: 2 })
    expect(tiny.commits.map(c => c.subject)).toEqual(['second'])
    expect(tiny.commitsTotal).toBe(2)
    expect(tiny.files).toHaveLength(2)
    expect(tiny.filesTotal).toBe(3)

    const none = await service.changes(record, { maxCommits: 0, maxFiles: 0 })
    expect(none.commits).toEqual([])
    expect(none.files).toEqual([])
    expect(none.commitsTotal).toBe(2)
    await expect(service.changes(record, { maxCommits: -1, maxFiles: 1 })).rejects.toMatchObject({ code: 'WORKTREE_OPERATION_FAILED' })
  })

  it('filePatch returns the committed diff, truncated by bytes on a character boundary', async () => {
    const repoRoot = repository()
    const { service } = await mount({ worktreeRoot })
    const record = await service.create({ repoRoot, threadId: 'thread-patch', baseRef: 'HEAD' }, new AbortController().signal)
    commit(record.path, 'u.txt', '日本語\n', 'cjk')
    writeFileSync(join(record.path, 'u.txt'), 'uncommitted\n', 'utf8')

    const full = await service.filePatch(record, 'u.txt', 100_000)
    expect(full.truncated).toBe(false)
    expect(full.patch).toContain('+日本語')
    expect(full.patch).not.toContain('uncommitted')

    const fullBytes = Buffer.byteLength(full.patch)
    const exact = await service.filePatch(record, 'u.txt', fullBytes)
    expect(exact).toEqual(full)

    const cutAt = Buffer.byteLength(full.patch.slice(0, full.patch.indexOf('日'))) + 1
    const cut = await service.filePatch(record, 'u.txt', cutAt)
    expect(cut.truncated).toBe(true)
    expect(cut.patch).not.toContain('\uFFFD')
    expect(Buffer.byteLength(cut.patch)).toBeLessThanOrEqual(cutAt)
    expect(cut.patch.endsWith('+')).toBe(true)

    const cutMid = await service.filePatch(record, 'u.txt', cutAt + 4)
    expect(cutMid.patch).not.toContain('\uFFFD')
    expect(cutMid.patch.endsWith('日')).toBe(true)

    expect(await service.filePatch(record, 'u.txt', 0)).toEqual({ patch: '', truncated: true })
    expect(await service.filePatch(record, 'untouched.txt', 100)).toEqual({ patch: '', truncated: false })
  })

  it('filePatch rejects absolute and parent-relative paths', async () => {
    const repoRoot = repository()
    const { service } = await mount({ worktreeRoot })
    const record = await service.create({ repoRoot, threadId: 'thread-bad-path', baseRef: 'HEAD' }, new AbortController().signal)
    for (const bad of ['/etc/passwd', '../x', 'a/../../x', '', 'C:\\x', 'a\\..\\b']) {
      await expect(service.filePatch(record, bad, 10)).rejects.toMatchObject({ code: 'WORKTREE_OPERATION_FAILED' })
    }
  })
})

describe('reconcile — startup sweep', { timeout: GIT_TIMEOUT_MS }, () => {
  /**
   * Append one durable sidecar line, as a process that died mid-operation left it.
   *
   * The line carries no `branch`: records written before that field existed are
   * still in the field, and the fold has to keep them branch-less.
   * @param createdAt - the `reserved` stamp, or `undefined` for a record written before the field existed.
   */
  function writeRecord(
    worktreeRoot: string,
    threadId: string,
    path: string,
    repoRoot: string,
    state: WorktreeState,
    createdAt?: number,
  ): void {
    const registry = new WorktreeRegistry(worktreeRoot, LOCKING)
    mkdirSync(worktreeRoot, { recursive: true })
    appendFileSync(
      join(worktreeRoot, REGISTRY_FILE_NAME),
      `${JSON.stringify({ threadId, path, repoRoot, baseRef: 'HEAD', state, ...createdAt === undefined ? {} : { createdAt } })}\n`,
      'utf8',
    )
    expect(registry.find(threadId)).toBeUndefined()
  }

  /** Write one durable `reserved` line, as a process that died mid-add would have left. */
  function writeReservedRecord(worktreeRoot: string, threadId: string, path: string, repoRoot: string, createdAt = 0): void {
    writeRecord(worktreeRoot, threadId, path, repoRoot, 'reserved', createdAt)
  }

  /** Materialize `path` as a self-contained clone of `repoRoot` with `branch` checked out. */
  function seedClone(repoRoot: string, path: string, branch: string): void {
    mkdirSync(dirname(path), { recursive: true })
    git(['clone', '--local', '--no-checkout', repoRoot, path], repoRoot)
    git(['checkout', '-b', branch, 'HEAD'], path)
  }

  it('detects a reserved record whose thread has no session and removes it', async () => {
    const repoRoot = repository()
    const orphanedPath = join(worktreeRoot, 'bucket', 'thread-orphan')
    seedClone(repoRoot, orphanedPath, 'dsh/thread-thread-orphan')
    writeReservedRecord(worktreeRoot, 'thread-orphan', orphanedPath, repoRoot)

    const { service } = await mount({ worktreeRoot })
    // The session half is gone: nothing answers "does this Thread still exist?".
    service.sessionExists = () => false

    const orphans = await service.reconcile()

    expect(orphans.map(entry => entry.threadId)).toEqual(['thread-orphan'])
    expect(orphans[0]?.state).toBe('orphaned')
    expect(worktreePaths(worktreeRoot)).toEqual([])
    // The crash-written record names no branch, so there is nothing to import back.
    expect(branchNames(repoRoot)).toEqual(['main'])
    expect(sidecar(worktreeRoot).map(line => line.state)).toEqual(['reserved', 'orphaned', 'removing', 'removed'])
    expect(await service.list(repoRoot)).toEqual([])
  })

  it('keeps a record whose session still exists', async () => {
    const repoRoot = repository()
    const { service } = await mount({ worktreeRoot })
    const record = await service.create(
      { repoRoot, threadId: 'thread-alive', baseRef: 'HEAD' },
      new AbortController().signal,
    )
    service.sessionExists = () => true

    expect(await service.reconcile()).toEqual([])
    expect(worktreePaths(worktreeRoot)).toContain(record.path)
  })

  it('removes a session-less worktree older than the grace period and keeps a younger one', async () => {
    const repoRoot = repository()
    const young = await mount({ worktreeRoot, adoptionGraceMs: 3_600_000 })
    const record = await young.service.create({ repoRoot, threadId: 'thread-young', baseRef: 'HEAD' }, new AbortController().signal)
    young.service.sessionExists = () => false
    expect(await young.service.reconcile()).toEqual([])
    expect(worktreePaths(worktreeRoot)).toContain(record.path)

    const old = await mount({ worktreeRoot, adoptionGraceMs: 0 })
    old.service.sessionExists = () => false
    expect((await old.service.reconcile()).map(entry => entry.threadId)).toEqual(['thread-young'])
    expect(worktreePaths(worktreeRoot)).toEqual([])
  })

  it('frees a limit slot held by an abandoned worktree when the next create runs', async () => {
    const repoRoot = repository()
    const { service } = await mount({ worktreeRoot, maxWorktreesPerRepo: 1, adoptionGraceMs: 0 })
    await service.create({ repoRoot, threadId: 'thread-lost', baseRef: 'HEAD' }, new AbortController().signal)
    service.sessionExists = threadId => threadId !== 'thread-lost'

    await expect(service.create({ repoRoot, threadId: 'thread-next', baseRef: 'HEAD' }, new AbortController().signal))
      .resolves.toMatchObject({ state: 'ready' })
    expect((await service.get('thread-lost'))?.state).toBe('removed')
  })

  it('treats no probe as "session existence is unknown" and sweeps nothing', async () => {
    const repoRoot = repository()
    const { service } = await mount({ worktreeRoot })
    const record = await service.create(
      { repoRoot, threadId: 'thread-noprobe', baseRef: 'HEAD' },
      new AbortController().signal,
    )

    expect(await service.reconcile()).toEqual([])
    expect(worktreePaths(worktreeRoot)).toContain(record.path)
  })

  it('rolls back a reservation whose worktree never materialized', async () => {
    const repoRoot = repository()
    writeReservedRecord(worktreeRoot, 'thread-ghost', join(worktreeRoot, 'bucket', 'thread-ghost'), repoRoot)

    const { service } = await mount({ worktreeRoot })
    service.sessionExists = () => false

    const orphans = await service.reconcile()

    expect(orphans.map(entry => entry.state)).toEqual(['orphaned'])
    expect(sidecar(worktreeRoot).map(line => line.state)).toEqual(['reserved', 'orphaned', 'rolled-back'])
  })

  it('runs the sweep on load when pruneOnStart is enabled', async () => {
    const repoRoot = repository()
    const orphanedPath = join(worktreeRoot, 'bucket', 'thread-startup')
    seedClone(repoRoot, orphanedPath, 'dsh/thread-thread-startup')
    writeReservedRecord(worktreeRoot, 'thread-startup', orphanedPath, repoRoot)

    const ctx = new Context()
    await ctx.plugin(WorktreeService, { worktreeRoot, pruneOnStart: true })
    ctx.worktrees.sessionExists = () => false
    // The load-time sweep runs without a probe, so drive the probe-aware pass here
    // and assert the startup sweep itself completed without leaving the record live.
    await ctx.worktrees.reconcile()

    expect(worktreePaths(worktreeRoot)).toEqual([])
    expect(await ctx.worktrees.list(repoRoot)).toEqual([])
    // Disposing the context disposes the startup sweep's effect.
    await ctx.fiber.dispose()
  })

  it('treats an unstamped record as older than any grace period', async () => {
    const repoRoot = repository()
    const readyPath = join(worktreeRoot, 'bucket', 'thread-stamp-ready')
    const reservedPath = join(worktreeRoot, 'bucket', 'thread-stamp-reserved')
    seedClone(repoRoot, readyPath, 'dsh/thread-a')
    seedClone(repoRoot, reservedPath, 'dsh/thread-b')
    writeRecord(worktreeRoot, 'thread-stamp-ready', readyPath, repoRoot, 'ready')
    writeRecord(worktreeRoot, 'thread-stamp-reserved', reservedPath, repoRoot, 'reserved')
    const { service } = await mount({ worktreeRoot, adoptionGraceMs: 0 })
    service.sessionExists = () => false

    expect((await service.reconcile()).map(entry => entry.threadId)).toEqual(['thread-stamp-ready', 'thread-stamp-reserved'])
    expect(worktreePaths(worktreeRoot)).toEqual([])
  })

  it('re-attaches an unstamped reservation instead of calling it another process\'s', async () => {
    const repoRoot = repository()
    const path = join(worktreeRoot, 'bucket', 'thread-unstamped')
    seedClone(repoRoot, path, 'dsh/thread-thread-unstamped')
    writeRecord(worktreeRoot, 'thread-unstamped', path, repoRoot, 'reserved')
    const { service } = await mount({ worktreeRoot, adoptionGraceMs: 0 })

    const record = await service.create({ repoRoot, threadId: 'thread-unstamped', baseRef: 'HEAD' }, new AbortController().signal)

    expect(record.state).toBe('reserved')
    expect(record.path).toBe(path)
    expect(worktreePaths(worktreeRoot)).toEqual([path])
  })

  it('rolls a crashed add back through an explicit remove', async () => {
    const repoRoot = repository()
    const path = join(worktreeRoot, 'bucket', 'thread-half')
    seedClone(repoRoot, path, 'dsh/thread-thread-half')
    writeReservedRecord(worktreeRoot, 'thread-half', path, repoRoot)
    const { service } = await mount({ worktreeRoot })
    const reserved = await service.get('thread-half')
    if (reserved === undefined) throw new Error('the reserved record must be readable')

    await service.remove(reserved)

    expect(worktreePaths(worktreeRoot)).toEqual([])
    expect((await service.get('thread-half'))?.state).toBe('rolled-back')
  })

  it('reports a corrupt registry and leaves the next sweep runnable', async () => {
    const repository2 = repository()
    mkdirSync(worktreeRoot, { recursive: true })
    writeFileSync(join(worktreeRoot, REGISTRY_FILE_NAME), 'not json\n', 'utf8')
    const { service } = await mount({ worktreeRoot })

    await expect(service.reconcile()).rejects.toMatchObject({ code: 'WORKTREE_CREATE_FAILED' })

    // The sweep queue absorbs the failure, so the next sweep RUNS rather than
    // rejecting on the one before it.
    writeFileSync(join(worktreeRoot, REGISTRY_FILE_NAME), '', 'utf8')
    expect(await service.reconcile()).toEqual([])
    expect(await service.list(repository2)).toEqual([])
  })
})

describe('configuration guards', { timeout: GIT_TIMEOUT_MS }, () => {
  it('refuses a worktreeRoot inside the registered checkout', async () => {
    await expect(mount({ worktreeRoot: join(process.cwd(), 'nested', 'worktrees') })).rejects.toThrow(
      /must not live inside the registered checkout/u,
    )
  })

  it('refuses the registered checkout itself as worktreeRoot', async () => {
    await expect(mount({ worktreeRoot: process.cwd() })).rejects.toThrow(/registered checkout/u)
  })

  it('refuses a relative worktreeRoot and an empty one', async () => {
    await expect(mount({ worktreeRoot: 'relative/worktrees' })).rejects.toThrow(/absolute path/u)
    await expect(mount({ worktreeRoot: '   ' })).rejects.toThrow(/must not be empty/u)
  })

  it('exposes the validated root and the resolved defaults', async () => {
    const { service } = await mount({ worktreeRoot })
    expect(service.worktreeRoot).toBe(worktreeRoot)
    expect(service.repoRootResolution).toBe('explicit')
    expect(service.base).toBe('head')
    expect(service.maxWorktreesPerRepo).toBe(32)
    expect(service.adoptionGraceMs).toBe(600_000)
    expect(service.pruneOnStart).toBe(false)
  })

  it('falls back to the documented home default when no worktreeRoot is configured', async () => {
    const { service } = await mount()

    expect(service.worktreeRoot).toBe(join(realpathSync(homedir()), '.dsh', 'worktrees'))
  })

  it('applies the interface defaults to a service constructed without them', async () => {
    // Cordis always validates `Config` through the schema, so a caller that builds
    // the Service directly is the only way the declared fallbacks are reached.
    const ctx = new Context()
    const service = new WorktreeService(ctx, { worktreeRoot })

    expect(service.repoRootResolution).toBe('explicit')
    expect(service.base).toBe('head')
    expect(service.pruneOnStart).toBe(true)
    expect(service.maxWorktreesPerRepo).toBe(32)
    expect(service.adoptionGraceMs).toBe(600_000)
    expect(service.registryLocking).toEqual({ timeoutMs: 10_000, retryIntervalMs: 50, staleMs: 30_000 })
    // Disposing runs the startup sweep's effect and disposes it.
    await ctx.fiber.dispose()
  })
})

describe('the durable state machine', { timeout: GIT_TIMEOUT_MS }, () => {
  it('rejects transitions that are not on the legal edge list', async () => {
    const registry = new WorktreeRegistry(worktreeRoot, LOCKING)
    await registry.load()
    const fields = { path: join(worktreeRoot, 'p'), repoRoot: '/repo', baseRef: 'HEAD', branch: 'dsh/thread-x' }
    await registry.transition('t', 'reserved', fields)
    await registry.transition('t', 'ready', fields)

    // ready → reserved and ready → rolled-back are both illegal.
    await expect(registry.transition('t', 'reserved', fields)).rejects.toMatchObject({
      code: 'WORKTREE_STATE_ILLEGAL',
    })
    await expect(registry.transition('t', 'rolled-back', fields)).rejects.toMatchObject({
      code: 'WORKTREE_STATE_ILLEGAL',
    })
    await registry.transition('t', 'removing', fields)
    await registry.transition('t', 'removed', fields)
    // `removed` is terminal apart from the documented restart edge.
    await expect(registry.transition('t', 'orphaned', fields)).rejects.toMatchObject({
      code: 'WORKTREE_STATE_ILLEGAL',
    })
    await expect(registry.transition('t', 'reserved', fields)).resolves.toMatchObject({ state: 'reserved' })
  })

  it('treats a repeated transition as an idempotent no-op', async () => {
    const registry = new WorktreeRegistry(worktreeRoot, LOCKING)
    await registry.load()
    const fields = { path: join(worktreeRoot, 'p'), repoRoot: '/repo', baseRef: 'HEAD' }
    const first = await registry.transition('t', 'reserved', fields)
    const second = await registry.transition('t', 'reserved', fields)

    expect(second).toEqual(first)
    expect(sidecar(worktreeRoot)).toHaveLength(1)
  })

  it('folds the append-only log and skips a torn final line', async () => {
    const registry = new WorktreeRegistry(worktreeRoot, LOCKING)
    await registry.load()
    const fields = { path: join(worktreeRoot, 'p'), repoRoot: '/repo', baseRef: 'HEAD' }
    await registry.transition('t', 'reserved', fields)
    await registry.transition('t', 'ready', fields)
    // Simulate a process killed mid-append: the last line is a truncated write.
    const lines = readFileSync(join(worktreeRoot, REGISTRY_FILE_NAME), 'utf8').split('\n').filter(l => l !== '')
    writeFileSync(join(worktreeRoot, REGISTRY_FILE_NAME), `${lines.join('\n')}\n{"threadId":`, 'utf8')

    const reloaded = await new WorktreeRegistry(worktreeRoot, LOCKING).load()

    expect(reloaded.find('t')).toMatchObject({ state: 'ready' })
  })

  it('refuses to read a log that is corrupt in the middle', async () => {
    mkdirSync(worktreeRoot, { recursive: true })
    writeFileSync(
      join(worktreeRoot, REGISTRY_FILE_NAME),
      `${JSON.stringify({ threadId: 'a', path: '/p', repoRoot: '/r', baseRef: 'HEAD', state: 'ready' })}\n`
      + 'not json\n'
      + `${JSON.stringify({ threadId: 'b', path: '/p', repoRoot: '/r', baseRef: 'HEAD', state: 'ready' })}\n`,
      'utf8',
    )

    await expect(new WorktreeRegistry(worktreeRoot, LOCKING).load()).rejects.toMatchObject({
      code: 'WORKTREE_CREATE_FAILED',
    })
  })
})

describe('unusable input', { timeout: GIT_TIMEOUT_MS }, () => {
  it('refuses a branch name git could not accept', async () => {
    const repoRoot = repository()
    const { service } = await mount({ worktreeRoot })
    await expect(service.create(
      { repoRoot, threadId: 'thread-bad-branch', baseRef: 'HEAD', branch: 'bad branch~name' },
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'WORKTREE_CREATE_FAILED' })
  })

  it('refuses a threadId that is not a single path segment', async () => {
    const repoRoot = repository()
    const { service } = await mount({ worktreeRoot })
    await expect(service.create(
      { repoRoot, threadId: '../escape', baseRef: 'HEAD' },
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'WORKTREE_CREATE_FAILED' })
  })

  it('reports a failing creation as WORKTREE_CREATE_FAILED', async () => {
    const repoRoot = repository()
    const { service } = await mount({ worktreeRoot })
    await expect(service.create(
      { repoRoot, threadId: 'thread-bad-ref', baseRef: 'no-such-ref' },
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'WORKTREE_CREATE_FAILED' })
    // The reservation was rolled back rather than left behind.
    expect(sidecar(worktreeRoot).map(line => line.state)).toEqual(['reserved', 'rolled-back'])
    expect(worktreePaths(worktreeRoot)).toEqual([])
  })
})
