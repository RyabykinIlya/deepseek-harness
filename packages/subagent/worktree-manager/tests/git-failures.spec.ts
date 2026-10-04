/**
 * How the git seam FAILS: a git that cannot be spawned, a subcommand that exits
 * non-zero, an add whose wording git alone can classify, and a bounded read whose
 * output exceeds the byte bound.
 *
 * These paths are reached through the REAL service wherever a caller would meet
 * them, with a scripted `git` first on `PATH` for the outcomes a healthy
 * repository never produces. Everything else — the repository, the worktrees, the
 * sidecar — is real, so a passing assertion still means the service classified a
 * genuine git failure rather than a mocked one.
 */

import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WorktreeService, { REGISTRY_FILE_NAME, resolveRepoTopLevel, runGit, threadSlug, WorktreeError } from '../src/index.ts'
import type { WorktreeRecord } from '../src/index.ts'

/** Real git subprocesses and a scripted shim run here; the 5s default is too tight. */
const GIT_TIMEOUT_MS = 30_000

function git(args: readonly string[], cwd?: string): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim()
}

/** Absolute paths git currently reports as worktrees of `repoRoot`. */
function worktreePaths(repoRoot: string): string[] {
  return git(['worktree', 'list', '--porcelain'], repoRoot)
    .split('\n')
    .filter(line => line.startsWith('worktree '))
    .map(line => line.slice('worktree '.length).trim())
}

/** Lifecycle states of the durable sidecar, in append order. */
function sidecarStates(root: string): string[] {
  return readFileSync(join(root, REGISTRY_FILE_NAME), 'utf8')
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => String((JSON.parse(line) as { state: unknown }).state))
}

const temporaries: string[] = []

/** A temp directory the suite removes afterwards. */
function temporary(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  temporaries.push(dir)
  return dir
}

/** A real git repository with one commit. */
function repository(): string {
  const dir = temporary('dsh-wm-gf-')
  git(['init', '--quiet', '--initial-branch=main', dir])
  git(['config', 'user.email', 'worktree@example.test'], dir)
  git(['config', 'user.name', 'Worktree Test'], dir)
  writeFileSync(join(dir, 'README.md'), 'seed\n', 'utf8')
  git(['add', '.'], dir)
  git(['commit', '--quiet', '-m', 'seed'], dir)
  return dir
}

/** Mount the service with the startup sweep disabled. */
async function mount(worktreeRoot: string): Promise<WorktreeService> {
  const ctx = new Context()
  await ctx.plugin(WorktreeService, { worktreeRoot, pruneOnStart: false })
  return ctx.worktrees
}

/** The argv substring a scripted `git` answers instead of running the real one. */
interface GitScript {
  /** Substring of the joined argv that selects this answer; everything else runs the real git. */
  readonly match: string
  /** Exit status (default `1`). */
  readonly code?: number
  /** stdout printed before exiting. */
  readonly out?: string
  /** stderr printed before exiting. */
  readonly err?: string
  /** Extra stderr the shim generates itself, to overrun the bounded stderr cap. */
  readonly errPadBytes?: number
  /** Bytes of stdout streamed in a loop that ignores SIGTERM, to overrun the stdout bound. */
  readonly floodBytes?: number
  /** Kill the shim with SIGTERM after writing `out`, so git never exits on its own. */
  readonly selfKill?: boolean
}

/**
 * Put a scripted `git` first on `PATH` until the returned function restores it.
 *
 * The shim is a POSIX shell script that pattern-matches the joined argv, so one
 * helper covers every failure mode without the test having to enumerate argv
 * positions; anything it does not match is handed to the real `git` untouched.
 * @param script - the canned answer and the argv it applies to.
 * @returns a function that puts the original `PATH` back.
 */
function scriptGit(script: GitScript): () => void {
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
  const dir = temporary('dsh-wm-shim-')
  // Payload travels as files, never as quoted shell words: git's own wording is
  // full of apostrophes, and a shim that cannot be spelled is a shim that fails
  // for the wrong reason.
  const lines: string[] = []
  if (script.out !== undefined) {
    writeFileSync(join(dir, 'stdout'), script.out, 'utf8')
    lines.push(`    cat '${join(dir, 'stdout')}'`)
  }
  if (script.err !== undefined) {
    writeFileSync(join(dir, 'stderr'), script.err, 'utf8')
    lines.push(`    cat '${join(dir, 'stderr')}' >&2`)
  }
  if (script.errPadBytes !== undefined) {
    lines.push(`    dd if=/dev/zero bs=65536 count=${Math.ceil(script.errPadBytes / 65_536)} 2>/dev/null | tr '\\0' 'e' >&2`)
  }
  if (script.floodBytes !== undefined) {
    lines.push(
      '    # A bounded read stops git itself; ignoring the signal proves the bound holds either way.',
      "    trap '' TERM",
      `    dd if=/dev/zero bs=16384 count=${Math.ceil(script.floodBytes / 16_384)} 2>/dev/null | tr '\\0' 'a'`,
    )
  }
  if (script.selfKill === true) lines.push('    kill -TERM $$', '    sleep 2')
  lines.push(`    exit ${script.code ?? 1}`)

  const body = [
    '#!/bin/sh',
    `m='${script.match}'`,
    'case "$*" in',
    '  *"$m"*)',
    ...lines,
    '    ;;',
    'esac',
    `exec '${realGit}' "$@"`,
    '',
  ].join('\n')
  const shim = join(dir, 'git')
  writeFileSync(shim, body, 'utf8')
  chmodSync(shim, 0o755)
  const previous = process.env.PATH
  process.env.PATH = `${dir}:${previous ?? ''}`
  return () => { process.env.PATH = previous }
}

/** Put `dir` alone on `PATH`, so no `git` can be found there. */
function withoutGit(dir: string): () => void {
  const previous = process.env.PATH
  process.env.PATH = dir
  return () => { process.env.PATH = previous }
}

/**
 * A `git` that answers normally, then deletes the worktree it is standing in.
 *
 * `filePatch` proves the worktree is live before it reads the patch, so the only
 * way to reach the bounded reader's "git could not be spawned" branch is for git
 * to stop existing between those two steps. The `rev-parse` that separates them
 * is the last git process running with that directory as its cwd.
 * @returns a function that puts the original `PATH` back.
 */
function gitThatVanishesFromItsWorktree(): () => void {
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
  const dir = temporary('dsh-wm-vanish-')
  const shim = join(dir, 'git')
  writeFileSync(shim, [
    '#!/bin/sh',
    'case "$*" in',
    '  *"rev-parse --verify"*)',
    '    status=0',
    `    '${realGit}' "$@" || status=$?`,
    '    rm -rf "$PWD"',
    '    exit $status',
    '    ;;',
    'esac',
    `exec '${realGit}' "$@"`,
    '',
  ].join('\n'), 'utf8')
  chmodSync(shim, 0o755)
  const previous = process.env.PATH
  process.env.PATH = `${dir}:${previous ?? ''}`
  return () => { process.env.PATH = previous }
}

/** The message of a rejected promise, or `undefined` when it resolved. */
async function failureOf(promise: Promise<unknown>): Promise<string | undefined> {
  return promise.then(() => undefined, (error: unknown) => error instanceof WorktreeError ? error.message : String(error))
}

let worktreeRoot: string
let repoRoot: string

beforeEach(() => {
  worktreeRoot = temporary('dsh-wm-gf-root-')
  repoRoot = repository()
})

afterEach(() => {
  for (const dir of temporaries.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('a git that cannot be spawned', { timeout: GIT_TIMEOUT_MS }, () => {
  it('rejects with GIT_SPAWN_FAILED naming the invocation, and names git alone without one', async () => {
    const restore = withoutGit(temporary('dsh-wm-nopath-'))
    try {
      await expect(runGit(['status', '--porcelain'], worktreeRoot)).rejects.toMatchObject({ code: 'GIT_SPAWN_FAILED' })
      expect(await failureOf(runGit(['status', '--porcelain'], worktreeRoot)))
        .toContain('could not spawn git (status --porcelain):')
      // No subcommand at all: the diagnostic names git on its own.
      expect(await failureOf(runGit([], worktreeRoot))).toMatch(/^worktree-manager: could not spawn git: /u)
    } finally {
      restore()
    }
  })

  it('reports the same failure from the bounded reader when git stops existing mid-read', async () => {
    const service = await mount(worktreeRoot)
    const record = await service.create({ repoRoot, threadId: 'spawn', baseRef: 'HEAD' }, new AbortController().signal)
    const restore = gitThatVanishesFromItsWorktree()
    try {
      await expect(service.filePatch(record, 'README.md', 100))
        .rejects.toMatchObject({ code: 'GIT_SPAWN_FAILED' })
    } finally {
      restore()
    }
  })
})

describe('a subcommand git answers with a failure', { timeout: GIT_TIMEOUT_MS }, () => {
  it('returns no top level when --show-toplevel exits non-zero', async () => {
    const restore = scriptGit({ match: '--show-toplevel', code: 128, err: 'fatal: bad revision' })
    try {
      expect(await resolveRepoTopLevel(repoRoot)).toBeUndefined()
    } finally {
      restore()
    }
  })

  it('returns no top level when --show-toplevel succeeds but names nothing', async () => {
    const restore = scriptGit({ match: '--show-toplevel', code: 0, out: '' })
    try {
      expect(await resolveRepoTopLevel(repoRoot)).toBeUndefined()
    } finally {
      restore()
    }
  })

  it('reports an unreadable worktree list as WORKTREE_OPERATION_FAILED', async () => {
    const service = await mount(worktreeRoot)
    const record = await service.create({ repoRoot, threadId: 'list', baseRef: 'HEAD' }, new AbortController().signal)
    const restore = scriptGit({ match: 'worktree list', code: 129, err: 'fatal: unrecognized option' })
    try {
      await expect(service.status(record)).rejects.toMatchObject({ code: 'WORKTREE_OPERATION_FAILED' })
    } finally {
      restore()
    }
  })

  it('reports an unreadable branch list as WORKTREE_OPERATION_FAILED and reserves nothing', async () => {
    const service = await mount(worktreeRoot)
    const restore = scriptGit({ match: 'branch --list', code: 129, err: 'fatal: unrecognized option' })
    try {
      await expect(service.create({ repoRoot, threadId: 'branch-list', baseRef: 'HEAD' }, new AbortController().signal))
        .rejects.toMatchObject({ code: 'WORKTREE_OPERATION_FAILED' })
    } finally {
      restore()
    }
    expect(worktreePaths(repoRoot)).toEqual([repoRoot])
  })
})

describe('a detached worktree', { timeout: GIT_TIMEOUT_MS }, () => {
  it('reads a record whose worktree git registered without a branch', async () => {
    const detachedPath = join(worktreeRoot, 'bucket', 'detached')
    mkdirSync(dirname(detachedPath), { recursive: true })
    git(['worktree', 'add', '--quiet', '--detach', detachedPath, 'HEAD'], repoRoot)
    const record: WorktreeRecord = {
      threadId: 'detached',
      path: detachedPath,
      repoRoot,
      baseRef: 'HEAD',
      state: 'ready',
    }

    expect(await mount(worktreeRoot).then(service => service.status(record)))
      .toEqual({ clean: true, changed: 0, commitsAhead: 0 })
  })
})

describe('classifying a failing git worktree add', { timeout: GIT_TIMEOUT_MS }, () => {
  /** Create `threadId` while `git worktree add` fails with `err`. */
  async function createWithAddFailure(service: WorktreeService, threadId: string, err: string): Promise<WorktreeError> {
    const restore = scriptGit({ match: 'worktree add', err })
    try {
      const settled = await service
        .create({ repoRoot, threadId, baseRef: 'HEAD' }, new AbortController().signal)
        .then(
          (record) => { throw new Error(`the add should have failed with: ${err} (got a ${record.state} record)`) },
          (error: unknown) => error,
        )
      if (!(settled instanceof WorktreeError)) throw new Error(`expected a WorktreeError, got ${String(settled)}`)
      return settled
    } finally {
      restore()
    }
  }

  it('reads a repository that vanished as NOT_A_GIT_REPO', async () => {
    const service = await mount(worktreeRoot)
    const error = await createWithAddFailure(service, 'not-a-repo', 'fatal: not a git repository: .git')
    expect(error.code).toBe('NOT_A_GIT_REPO')
  })

  it('reads git\'s own "branch ... already exists" wording as WORKTREE_BRANCH_EXISTS', async () => {
    const service = await mount(worktreeRoot)
    const branch = `dsh/thread-${threadSlug('branch-worded')}`
    const error = await createWithAddFailure(service, 'branch-worded', `fatal: a branch named '${branch}' already exists`)
    expect(error.code).toBe('WORKTREE_BRANCH_EXISTS')
  })

  it('reads a bare "already exists" that names the branch as WORKTREE_BRANCH_EXISTS', async () => {
    const service = await mount(worktreeRoot)
    const branch = `dsh/thread-${threadSlug('branch-bare')}`
    const error = await createWithAddFailure(service, 'branch-bare', `fatal: could not set up HEAD: '${branch}' already exists`)
    expect(error.code).toBe('WORKTREE_BRANCH_EXISTS')
  })

  it('reads a path git names as WORKTREE_PATH_IN_USE', async () => {
    const service = await mount(worktreeRoot)
    // The path the service derives is a bucket hash of the repository, so it is
    // read back from a rolled-back record rather than recomputed here.
    await createWithAddFailure(service, 'path-probe', 'fatal: cannot lock ref: is at 1 but expected 2')
    const probe = await service.get('path-probe')
    const path = join(dirname(probe?.path ?? ''), threadSlug('path-named'))
    const error = await createWithAddFailure(service, 'path-named', `fatal: '${path}' is already used by another checkout`)
    expect(error.code).toBe('WORKTREE_PATH_IN_USE')
  })

  it('reads a path git reports as registered as WORKTREE_PATH_IN_USE', async () => {
    const service = await mount(worktreeRoot)
    const error = await createWithAddFailure(service, 'registered', "fatal: '/elsewhere' is already registered with this repository")
    expect(error.code).toBe('WORKTREE_PATH_IN_USE')
  })

  it('falls through to the generic WORKTREE_CREATE_FAILED when nothing else matches', async () => {
    const service = await mount(worktreeRoot)
    const error = await createWithAddFailure(service, 'unknown', 'fatal: cannot lock ref: is at 1 but expected 2')
    expect(error.code).toBe('WORKTREE_CREATE_FAILED')
    expect(error.message).toContain('git worktree add failed')
  })
})

describe('a git that refuses to snapshot the working tree', { timeout: GIT_TIMEOUT_MS }, () => {
  it('fails the create loudly instead of quietly basing the Thread on HEAD', async () => {
    const service = await mount(worktreeRoot)
    writeFileSync(join(repoRoot, 'README.md'), 'seed\nparent edit\n', 'utf8')
    const restore = scriptGit({ match: 'stash create', code: 128, err: 'fatal: cannot save the current index state' })
    let error: WorktreeError
    try {
      const settled = await service
        .create({ repoRoot, threadId: 'stash', baseRef: 'HEAD', base: 'head-with-uncommitted' }, new AbortController().signal)
        .then(
          (record) => { throw new Error(`the snapshot should have failed (got a ${record.state} record)`) },
          (reason: unknown) => reason,
        )
      if (!(settled instanceof WorktreeError)) throw new Error(`expected a WorktreeError, got ${String(settled)}`)
      error = settled
    } finally {
      restore()
    }
    // A Thread silently based somewhere other than where it was asked to start is the exact
    // degradation this service refuses, so a failing snapshot takes the whole create down.
    expect(error.code).toBe('WORKTREE_CREATE_FAILED')
    expect(error.message).toContain('git stash create failed')
    expect(worktreePaths(repoRoot)).toEqual([repoRoot])
    // The reservation is settled, so the next create is not refused by this Thread's own record.
    expect(sidecarStates(worktreeRoot)).toEqual(['reserved', 'rolled-back'])
  })

  it('never asks git to snapshot anything under the plain head policy', async () => {
    const service = await mount(worktreeRoot)
    writeFileSync(join(repoRoot, 'README.md'), 'seed\nparent edit\n', 'utf8')
    const restore = scriptGit({ match: 'stash create', out: 'not-a-commit\n' })
    try {
      // Had the snapshot been taken, the branch would have been created at `not-a-commit`
      // and the add would have failed with it.
      const record = await service.create({ repoRoot, threadId: 'no-stash', baseRef: 'HEAD' }, new AbortController().signal)
      expect(record.base).toBe('head')
      expect(record.baseSha).toBe(git(['rev-parse', 'HEAD^{commit}'], repoRoot))
    } finally {
      restore()
    }
  })
})

describe('a bounded read of git output', { timeout: GIT_TIMEOUT_MS }, () => {
  /** A ready record whose file `README.md` carries a committed edit. */
  async function readyRecord(service: WorktreeService, threadId: string): Promise<WorktreeRecord> {
    const record = await service.create({ repoRoot, threadId, baseRef: 'HEAD' }, new AbortController().signal)
    writeFileSync(join(record.path, 'README.md'), 'edited\n', 'utf8')
    git(['add', '.'], record.path)
    git(['-c', 'user.email=t@example.test', '-c', 'user.name=T', 'commit', '--quiet', '-m', 'edit'], record.path)
    return record
  }

  it('keeps git stderr without letting it reach the patch', async () => {
    const service = await mount(worktreeRoot)
    const record = await readyRecord(service, 'stderr')
    const restore = scriptGit({ match: '--no-textconv', code: 0, out: 'diff --git a/README.md b/README.md\n', err: 'warning: LF will be replaced\n' })
    try {
      expect(await service.filePatch(record, 'README.md', 100_000)).toEqual({
        patch: 'diff --git a/README.md b/README.md\n',
        truncated: false,
      })
    } finally {
      restore()
    }
  })

  it('stops collecting stderr at the cap and still returns the whole patch', async () => {
    const service = await mount(worktreeRoot)
    const record = await readyRecord(service, 'stderr-cap')
    const restore = scriptGit({ match: '--no-textconv', code: 0, out: 'patch body\n', errPadBytes: 512 * 1024 })
    try {
      expect(await service.filePatch(record, 'README.md', 100_000)).toEqual({ patch: 'patch body\n', truncated: false })
    } finally {
      restore()
    }
  })

  it('truncates at the bound even when git ignores the stop signal', async () => {
    const service = await mount(worktreeRoot)
    const record = await readyRecord(service, 'flood')
    const restore = scriptGit({ match: '--no-textconv', code: 0, floodBytes: 1024 * 1024 })
    try {
      const cut = await service.filePatch(record, 'README.md', 64)
      expect(cut.truncated).toBe(true)
      expect(Buffer.byteLength(cut.patch)).toBeLessThanOrEqual(64)
    } finally {
      restore()
    }
  })

  it('reports a git killed by a signal as a failure, not as a short patch', async () => {
    const service = await mount(worktreeRoot)
    const record = await readyRecord(service, 'signalled')
    const restore = scriptGit({ match: '--no-textconv', out: 'partial diff\n', selfKill: true })
    try {
      await expect(service.filePatch(record, 'README.md', 100_000)).rejects.toMatchObject({
        code: 'WORKTREE_OPERATION_FAILED',
      })
    } finally {
      restore()
    }
  })
})
