/**
 * T2.4 — the base policy: `head` versus `head-with-uncommitted`.
 *
 * Everything here runs the REAL service against REAL temporary git repositories, because
 * the whole point of the policy is what git itself does with a working tree. Nothing is
 * mocked: the assertions read the created worktree's files off disk, the parent's
 * `git status --porcelain`, the sidecar lines, and `git stash list` — which is exactly how
 * a `git stash create` is told apart from the `git stash push`/`pop` it replaced.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WorktreeService, { REGISTRY_FILE_NAME, threadSlug } from '../src/index.ts'
import type { Config, WorktreeBasePolicy, WorktreeRecord } from '../src/index.ts'

/** Real git subprocesses run here; the 5s default is too tight when specs share the host. */
const GIT_TIMEOUT_MS = 30_000

function git(args: readonly string[], cwd?: string): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim()
}

/** A fresh abort signal; the specs never cancel. */
function signal(): AbortSignal {
  return new AbortController().signal
}

const temporaries: string[] = []

/** A temp directory the suite removes afterwards. */
function temporary(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  temporaries.push(dir)
  return dir
}

/** A real git repository with one commit on `main`. */
function repository(): string {
  const dir = temporary('dsh-wm-base-')
  git(['init', '--quiet', '--initial-branch=main', dir])
  git(['config', 'user.email', 'worktree@example.test'], dir)
  git(['config', 'user.name', 'Worktree Test'], dir)
  writeFileSync(join(dir, 'README.md'), 'seed\n', 'utf8')
  writeFileSync(join(dir, 'notes.txt'), 'notes\n', 'utf8')
  git(['add', '.'], dir)
  git(['commit', '--quiet', '-m', 'seed'], dir)
  return dir
}

/** The committed `HEAD` of `repoRoot`, read back from git. */
function headSha(repoRoot: string): string {
  return git(['rev-parse', 'HEAD^{commit}'], repoRoot)
}

/** Commit everything currently staged in `dir`, the way a Thread would. */
function commitAll(dir: string, message: string): void {
  git(['-c', 'user.email=t@example.test', '-c', 'user.name=T', 'add', '.'], dir)
  git(['-c', 'user.email=t@example.test', '-c', 'user.name=T', 'commit', '--quiet', '-m', message], dir)
}

/** Mount the service with the startup sweep disabled unless a test asks for it. */
async function mount(config: Config = {}): Promise<WorktreeService> {
  const ctx = new Context()
  await ctx.plugin(WorktreeService, { pruneOnStart: false, ...config })
  return ctx.worktrees
}

/**
 * Mount the service from a configuration assembled at runtime.
 *
 * This exists for the one case a typed call site cannot express: handing the loader a policy
 * name that does not exist. `Record<string, unknown>` is the honest input type for untyped YAML,
 * so the test needs neither a cast nor an `any` — and it stays pinned to what an operator who
 * typos `base` in YAML actually gets.
 */
async function mountUntyped(config: Record<string, unknown>): Promise<WorktreeService> {
  // No `pruneOnStart` switch: an invalid configuration is refused while it is validated,
  // before any effect runs, so there is no sweep left to suppress.
  const ctx = new Context()
  await ctx.plugin(WorktreeService, config)
  return ctx.worktrees
}

/** Durable sidecar lines, in append order. */
function sidecar(worktreeRoot: string): Record<string, unknown>[] {
  return readFileSync(join(worktreeRoot, REGISTRY_FILE_NAME), 'utf8')
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line) as Record<string, unknown>)
}

/** Commits the worktree's HEAD is ahead of the base its record names. */
function commitsSinceBase(record: WorktreeRecord): number {
  return Number(git(['rev-list', '--count', `${record.baseSha ?? record.baseRef}..HEAD`], record.path))
}

let worktreeRoot: string

beforeEach(() => {
  worktreeRoot = temporary('dsh-wm-base-root-')
})

afterEach(() => {
  for (const dir of temporaries.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('base policy `head` — the default', { timeout: GIT_TIMEOUT_MS }, () => {
  it('leaves the parent uncommitted edit out of the Thread', async () => {
    const repoRoot = repository()
    writeFileSync(join(repoRoot, 'README.md'), 'seed\nparent edit\n', 'utf8')
    const service = await mount({ worktreeRoot })

    const record = await service.create({ repoRoot, threadId: 'thread-head', baseRef: 'HEAD' }, signal())

    // The Thread's own checkout of the file is the last COMMIT, not the parent's edit.
    expect(readFileSync(join(record.path, 'README.md'), 'utf8')).toBe('seed\n')
    expect(record.base).toBe('head')
    expect(record.baseRef).toBe('HEAD')
    expect(record.baseSha).toBe(headSha(repoRoot))
    expect(await service.status(record)).toEqual({ clean: true, changed: 0, commitsAhead: 0 })
    // The parent is still mid-edit; the service took nothing from it.
    // `git()` trims, so the porcelain leading column survives only as its trailing marker.
    expect(git(['status', '--porcelain'], repoRoot)).toBe('M README.md')
  })

  it('states the policy on the durable intent line as well as the ready one', async () => {
    const repoRoot = repository()
    const service = await mount({ worktreeRoot })

    await service.create({ repoRoot, threadId: 'thread-durable', baseRef: 'HEAD' }, signal())

    // The `reserved` line is written BEFORE any git runs, so it can only state the policy
    // that was requested. The `ready` line states the one that was applied.
    const lines = sidecar(worktreeRoot)
    expect(lines.map(line => line.state)).toEqual(['reserved', 'ready'])
    expect(lines.every(line => line.base === 'head')).toBe(true)
  })

  it('records the service default even when the config never mentions a policy', async () => {
    const service = await mount({ worktreeRoot })

    expect(service.base).toBe('head')
  })

  it('refuses an unknown policy at load rather than defaulting silently', async () => {
    // A typo in `base` must fail the mount, not quietly fall back to `head` and move
    // every Thread's base without a word.
    await expect(mountUntyped({ worktreeRoot, base: 'head-with-untracked' })).rejects.toThrow()
  })
})

describe('base policy `head-with-uncommitted`', { timeout: GIT_TIMEOUT_MS }, () => {
  it('starts the Thread from the parent working state', async () => {
    const repoRoot = repository()
    writeFileSync(join(repoRoot, 'README.md'), 'seed\nparent edit\n', 'utf8')
    writeFileSync(join(repoRoot, 'notes.txt'), 'notes\nparent edit\n', 'utf8')
    const service = await mount({ worktreeRoot })

    const record = await service.create(
      { repoRoot, threadId: 'thread-dirty', baseRef: 'HEAD', base: 'head-with-uncommitted' },
      signal(),
    )

    // The whole point: the Thread SEES the work in progress, so it never has to guess at
    // (or collide on) lines the parent never committed.
    expect(readFileSync(join(record.path, 'README.md'), 'utf8')).toBe('seed\nparent edit\n')
    expect(readFileSync(join(record.path, 'notes.txt'), 'utf8')).toBe('notes\nparent edit\n')
    expect(record.base).toBe('head-with-uncommitted')
    // `baseRef` stays the ref the REQUEST named; the commit actually used is `baseSha`.
    expect(record.baseRef).toBe('HEAD')
    expect(record.baseSha).not.toBe(headSha(repoRoot))
    // The snapshot is the Thread's starting point, so it counts as zero commits of its own.
    expect(git(['rev-parse', 'HEAD^{commit}'], record.path)).toBe(record.baseSha)
    expect(await service.status(record)).toEqual({ clean: true, changed: 0, commitsAhead: 0 })
    expect(await service.changes(record, { maxCommits: 10, maxFiles: 10 })).toEqual({
      baseSha: record.baseSha,
      headSha: record.baseSha,
      commits: [],
      commitsTotal: 0,
      files: [],
      filesTotal: 0,
      uncommitted: 0,
    })
  })

  it('leaves the parent working tree and index untouched and stores no stash', async () => {
    const repoRoot = repository()
    writeFileSync(join(repoRoot, 'README.md'), 'seed\nunstaged edit\n', 'utf8')
    writeFileSync(join(repoRoot, 'staged.txt'), 'staged\n', 'utf8')
    git(['add', 'staged.txt'], repoRoot)
    writeFileSync(join(repoRoot, 'untracked.txt'), 'untracked\n', 'utf8')
    const before = git(['status', '--porcelain'], repoRoot)
    const service = await mount({ worktreeRoot })

    const record = await service.create(
      { repoRoot, threadId: 'thread-untouched', baseRef: 'HEAD', base: 'head-with-uncommitted' },
      signal(),
    )

    // `git stash create` writes object-database entries only. A `push`/`pop` would have
    // emptied the parent's working tree here — and two Threads starting at once would
    // have popped each other's stash out from under each other.
    expect(readFileSync(join(repoRoot, 'README.md'), 'utf8')).toBe('seed\nunstaged edit\n')
    expect(git(['status', '--porcelain'], repoRoot)).toBe(before)
    expect(git(['stash', 'list'], repoRoot)).toBe('')
    // The Thread really did get the snapshot, so the assertions above are not vacuous.
    expect(readFileSync(join(record.path, 'README.md'), 'utf8')).toBe('seed\nunstaged edit\n')
  })

  it('carries staged additions but not untracked files, as git itself defines a stash', async () => {
    const repoRoot = repository()
    writeFileSync(join(repoRoot, 'staged.txt'), 'staged\n', 'utf8')
    git(['add', 'staged.txt'], repoRoot)
    writeFileSync(join(repoRoot, 'untracked.txt'), 'untracked\n', 'utf8')
    const service = await mount({ worktreeRoot })

    const record = await service.create(
      { repoRoot, threadId: 'thread-staged', baseRef: 'HEAD', base: 'head-with-uncommitted' },
      signal(),
    )

    // A staged addition is part of the index, so it is in the stash; `-u` would be needed
    // for the untracked file, and deliberately is not used. Documented, and pinned here.
    expect(existsSync(join(record.path, 'staged.txt'))).toBe(true)
    expect(existsSync(join(record.path, 'untracked.txt'))).toBe(false)
  })

  it('falls back to the committed base when nothing tracked is modified', async () => {
    const repoRoot = repository()
    writeFileSync(join(repoRoot, 'untracked.txt'), 'untracked\n', 'utf8')
    const service = await mount({ worktreeRoot })

    // `git stash create` exits 0 with empty output for a clean tree. That is not a failure.
    const record = await service.create(
      { repoRoot, threadId: 'thread-clean', baseRef: 'HEAD', base: 'head-with-uncommitted' },
      signal(),
    )

    expect(record.base).toBe('head-with-uncommitted')
    expect(record.baseSha).toBe(headSha(repoRoot))
    expect(readFileSync(join(record.path, 'README.md'), 'utf8')).toBe('seed\n')
    expect(await service.status(record)).toEqual({ clean: true, changed: 0, commitsAhead: 0 })
  })

  it('is refused on a base ref that names no commit, before git is asked to snapshot anything', async () => {
    const repoRoot = repository()
    writeFileSync(join(repoRoot, 'README.md'), 'seed\nparent edit\n', 'utf8')
    const service = await mount({ worktreeRoot })

    await expect(service.create(
      { repoRoot, threadId: 'thread-badref', baseRef: 'no-such-ref', base: 'head-with-uncommitted' },
      signal(),
    )).rejects.toMatchObject({ code: 'WORKTREE_CREATE_FAILED' })
    // The reservation was rolled back, so nothing was left claiming a worktree.
    expect(sidecar(worktreeRoot).map(line => line.state)).toEqual(['reserved', 'rolled-back'])
  })
})

describe('where the policy comes from', { timeout: GIT_TIMEOUT_MS }, () => {
  it('uses the configured default when the spec names none', async () => {
    const repoRoot = repository()
    writeFileSync(join(repoRoot, 'README.md'), 'seed\nparent edit\n', 'utf8')
    const service = await mount({ worktreeRoot, base: 'head-with-uncommitted' })

    const record = await service.create({ repoRoot, threadId: 'thread-configured', baseRef: 'HEAD' }, signal())

    expect(service.base).toBe('head-with-uncommitted')
    expect(readFileSync(join(record.path, 'README.md'), 'utf8')).toBe('seed\nparent edit\n')
  })

  it('lets a spec override the configured default in both directions', async () => {
    const repoRoot = repository()
    writeFileSync(join(repoRoot, 'README.md'), 'seed\nparent edit\n', 'utf8')

    const configured = await mount({ worktreeRoot, base: 'head' })
    const opted = await configured.create(
      { repoRoot, threadId: 'thread-opt-in', baseRef: 'HEAD', base: 'head-with-uncommitted' },
      signal(),
    )
    const untouched = await configured.create({ repoRoot, threadId: 'thread-default', baseRef: 'HEAD' }, signal())

    const inverted = await mount({ worktreeRoot, base: 'head-with-uncommitted' })
    const forced = await inverted.create(
      { repoRoot, threadId: 'thread-opt-out', baseRef: 'HEAD', base: 'head' },
      signal(),
    )

    expect(readFileSync(join(opted.path, 'README.md'), 'utf8')).toBe('seed\nparent edit\n')
    expect(readFileSync(join(untouched.path, 'README.md'), 'utf8')).toBe('seed\n')
    expect(readFileSync(join(forced.path, 'README.md'), 'utf8')).toBe('seed\n')
    expect(forced.base).toBe('head')
  })
})

describe('the durable record and recovery', { timeout: GIT_TIMEOUT_MS }, () => {
  it('keeps the first lineage base when a Thread is restarted', async () => {
    const repoRoot = repository()
    writeFileSync(join(repoRoot, 'README.md'), 'seed\nfirst parent edit\n', 'utf8')
    const service = await mount({ worktreeRoot })
    const spec: { repoRoot: string; threadId: string; baseRef: string; base: WorktreeBasePolicy } = {
      repoRoot,
      threadId: 'thread-resumed',
      baseRef: 'HEAD',
      base: 'head-with-uncommitted',
    }

    const first = await service.create(spec, signal())
    writeFileSync(join(first.path, 'notes.txt'), 'notes\nthread edit\n', 'utf8')
    commitAll(first.path, 'thread work')
    await service.remove(first)
    // The parent moved on after the Thread was removed.
    writeFileSync(join(repoRoot, 'README.md'), 'seed\nsecond parent edit\n', 'utf8')

    const second = await service.create(spec, signal())

    // Re-snapshotting now would record a base that is not an ancestor of the Thread's own
    // history, so `changes` would diff it against work it never did. The lineage is kept.
    expect(second.baseSha).toBe(first.baseSha)
    expect(second.base).toBe('head-with-uncommitted')
    expect(commitsSinceBase(second)).toBe(1)
    expect(git(['log', '-1', '--format=%s'], second.path)).toBe('thread work')
    expect(readFileSync(join(second.path, 'notes.txt'), 'utf8')).toBe('notes\nthread edit\n')
    expect(readFileSync(join(second.path, 'README.md'), 'utf8')).toBe('seed\nfirst parent edit\n')
    expect(await service.status(second)).toEqual({ clean: true, changed: 0, commitsAhead: 1 })
  })

  it('restarts a record written before the policy existed under the requested one', async () => {
    const repoRoot = repository()
    const seed = headSha(repoRoot)
    const threadId = 'thread-legacy'
    const branch = `dsh/thread-${threadSlug(threadId)}`
    git(['branch', branch], repoRoot)
    writeFileSync(join(repoRoot, 'README.md'), 'seed\nparent edit\n', 'utf8')
    const bucket = join(worktreeRoot, 'legacy')
    // A `removed` line exactly as the previous version wrote it: `baseSha`, no `base`.
    writeFileSync(
      join(worktreeRoot, REGISTRY_FILE_NAME),
      `${JSON.stringify({
        threadId,
        path: join(bucket, threadSlug(threadId)),
        repoRoot,
        branch,
        baseRef: 'HEAD',
        baseSha: seed,
        state: 'removed',
      })}\n`,
      'utf8',
    )
    const service = await mount({ worktreeRoot })

    const record = await service.create(
      { repoRoot, threadId, baseRef: 'HEAD', base: 'head-with-uncommitted' },
      signal(),
    )

    // The old lineage's base is inherited and the policy that produced it is recorded as the
    // one now in force, so no snapshot is taken and no dangling base is written.
    expect(record.baseSha).toBe(seed)
    expect(record.base).toBe('head-with-uncommitted')
    expect(readFileSync(join(record.path, 'README.md'), 'utf8')).toBe('seed\n')
    expect(await service.status(record)).toEqual({ clean: true, changed: 0, commitsAhead: 0 })
  })

  it('reads the policy and the base back after the service itself restarts', async () => {
    const repoRoot = repository()
    writeFileSync(join(repoRoot, 'README.md'), 'seed\nparent edit\n', 'utf8')
    const first = await mount({ worktreeRoot })
    const created = await first.create(
      { repoRoot, threadId: 'thread-restarted-service', baseRef: 'HEAD', base: 'head-with-uncommitted' },
      signal(),
    )

    // A brand new process on the same root folds the sidecar from scratch.
    const second = await mount({ worktreeRoot })
    const reloaded = await second.get('thread-restarted-service')

    expect(reloaded?.base).toBe('head-with-uncommitted')
    expect(reloaded?.baseSha).toBe(created.baseSha)
    expect(second.base).toBe('head')
    // `status` re-resolves `baseSha` inside the worktree, which only works if the snapshot
    // commit really is reachable from the Thread's own branch.
    expect(await second.status(created)).toEqual({ clean: true, changed: 0, commitsAhead: 0 })
  })
})
