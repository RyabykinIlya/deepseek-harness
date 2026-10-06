/**
 * `WorktreeService.mergeCheck` against real temporary git repositories: the
 * prediction is compared with what `git merge` itself would do.
 */

import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WorktreeService from '../src/index.ts'
import type { WorktreeRecord } from '../src/index.ts'

const GIT_TIMEOUT_MS = 30_000

function git(args: readonly string[], cwd?: string): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim()
}

const temporaries: string[] = []

function temporary(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  temporaries.push(dir)
  return dir
}

/** A repository whose `main` holds `a.txt`, `b.txt` and `with space.txt`. */
function repository(): string {
  const dir = temporary('dsh-wm-mc-')
  git(['init', '--quiet', '--initial-branch=main', dir])
  git(['config', 'user.email', 'worktree@example.test'], dir)
  git(['config', 'user.name', 'Worktree Test'], dir)
  for (const name of ['a.txt', 'b.txt', 'with space.txt']) writeFileSync(join(dir, name), 'seed\n', 'utf8')
  git(['add', '.'], dir)
  git(['commit', '--quiet', '-m', 'seed'], dir)
  return dir
}

/** Write `content` to `file` in `cwd` and commit it. */
function commitFile(cwd: string, file: string, content: string): void {
  writeFileSync(join(cwd, file), content, 'utf8')
  git(['add', '.'], cwd)
  git(['commit', '--quiet', '-m', `edit ${file}`], cwd)
}

let worktreeRoot: string
let service: WorktreeService
let repoRoot: string

async function createThread(threadId: string): Promise<WorktreeRecord> {
  return service.create({ repoRoot, threadId, baseRef: 'HEAD' }, new AbortController().signal)
}

beforeEach(async () => {
  worktreeRoot = temporary('dsh-wm-mc-root-')
  repoRoot = repository()
  const ctx = new Context()
  await ctx.plugin(WorktreeService, { worktreeRoot, pruneOnStart: false })
  service = ctx.worktrees
})

afterEach(() => {
  for (const dir of temporaries.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('mergeCheck', { timeout: GIT_TIMEOUT_MS }, () => {
  it('reports a clean merge into the main checkout HEAD', async () => {
    const record = await createThread('clean')
    commitFile(record.path, 'a.txt', 'thread\n')
    commitFile(repoRoot, 'b.txt', 'main\n')

    const result = await service.mergeCheck(record, { target: 'HEAD' }, 10)

    expect(result).toEqual({
      supported: true,
      targetSha: git(['rev-parse', 'HEAD'], repoRoot),
      headSha: git(['rev-parse', 'HEAD'], record.path),
      clean: true,
      conflicts: [],
      conflictsTotal: 0,
    })
    // Prediction only: nothing moved.
    expect(git(['status', '--porcelain'], repoRoot)).toBe('')
  })

  it('lists conflicting paths, including one with a space, and cuts at maxConflicts', async () => {
    const record = await createThread('conflict')
    for (const file of ['a.txt', 'b.txt', 'with space.txt']) writeFileSync(join(record.path, file), 'thread\n', 'utf8')
    git(['add', '.'], record.path)
    git(['commit', '--quiet', '-m', 'thread edits'], record.path)
    for (const file of ['a.txt', 'b.txt', 'with space.txt']) writeFileSync(join(repoRoot, file), 'main\n', 'utf8')
    git(['add', '.'], repoRoot)
    git(['commit', '--quiet', '-m', 'main edits'], repoRoot)

    const all = await service.mergeCheck(record, { target: 'HEAD' }, 10)
    expect(all).toMatchObject({ supported: true, clean: false, conflictsTotal: 3 })
    if (!all.supported) throw new Error('unreachable')
    expect([...all.conflicts].sort()).toEqual(['a.txt', 'b.txt', 'with space.txt'])

    const cut = await service.mergeCheck(record, { target: 'HEAD' }, 2)
    expect(cut).toMatchObject({ supported: true, clean: false, conflictsTotal: 3 })
    if (!cut.supported) throw new Error('unreachable')
    expect(cut.conflicts).toHaveLength(2)

    const none = await service.mergeCheck(record, { target: 'HEAD' }, 0)
    expect(none).toMatchObject({ supported: true, conflicts: [], conflictsTotal: 3 })
  })

  it('accepts another Thread branch as the target', async () => {
    const first = await createThread('first')
    const second = await createThread('second')
    commitFile(first.path, 'a.txt', 'first\n')
    commitFile(second.path, 'a.txt', 'second\n')

    const result = await service.mergeCheck(second, { target: first.branch ?? '' }, 10)

    // The branch lives in the first Thread's own clone; the prediction is served from there.
    expect(result).toMatchObject({
      supported: true,
      targetSha: git(['rev-parse', first.branch ?? ''], first.path),
      clean: false,
      conflicts: ['a.txt'],
      conflictsTotal: 1,
    })
  })

  it('rejects an unknown target ref and a negative bound', async () => {
    const record = await createThread('unknown')
    await expect(service.mergeCheck(record, { target: 'no-such-ref' }, 10))
      .rejects.toMatchObject({ code: 'WORKTREE_OPERATION_FAILED' })
    await expect(service.mergeCheck(record, { target: 'HEAD' }, -1))
      .rejects.toMatchObject({ code: 'WORKTREE_OPERATION_FAILED' })
  })

  it('throws WORKTREE_NOT_FOUND for a missing worktree', async () => {
    const record = await createThread('gone')
    await service.remove(record)

    await expect(service.mergeCheck(record, { target: 'HEAD' }, 10)).rejects.toMatchObject({ code: 'WORKTREE_NOT_FOUND' })
  })

  it('reports { supported: false } when git rejects --write-tree with exit 129', async () => {
    const record = await createThread('old-git')
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
    const shimDir = temporary('dsh-wm-shim-')
    const shim = join(shimDir, 'git')
    writeFileSync(shim, `#!/bin/sh\nfor arg in "$@"; do [ "$arg" = merge-tree ] && exit 129; done\nexec "${realGit}" "$@"\n`, 'utf8')
    chmodSync(shim, 0o755)
    const originalPath = process.env.PATH
    process.env.PATH = `${shimDir}:${originalPath ?? ''}`
    try {
      await expect(service.mergeCheck(record, { target: 'HEAD' }, 10)).resolves.toEqual({ supported: false })
    } finally {
      process.env.PATH = originalPath
    }
  })

  it('fails loud on another merge-tree error', async () => {
    const record = await createThread('merge-tree-error')
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
    const shimDir = temporary('dsh-wm-shim-')
    const shim = join(shimDir, 'git')
    writeFileSync(shim, `#!/bin/sh\nfor arg in "$@"; do [ "$arg" = merge-tree ] && { echo boom >&2; exit 2; }; done\nexec "${realGit}" "$@"\n`, 'utf8')
    chmodSync(shim, 0o755)
    const originalPath = process.env.PATH
    process.env.PATH = `${shimDir}:${originalPath ?? ''}`
    try {
      await expect(service.mergeCheck(record, { target: 'HEAD' }, 10)).rejects.toMatchObject({ code: 'WORKTREE_OPERATION_FAILED' })
    } finally {
      process.env.PATH = originalPath
    }
  })
})
