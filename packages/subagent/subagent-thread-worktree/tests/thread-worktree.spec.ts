import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WorktreeService from '@deepseek-ai/dsh-worktree-manager'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContinuableCreateRequest, ResolvedSubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { startInProcessRun } from '@deepseek-ai/dsh-subagent-in-process-driver'
import { apply, ThreadWorktreeProvider } from '../src/index.ts'
import type { Config } from '../src/index.ts'

// The one-shot `start` path is inherited from the shared driver; what this
// package contributes there is the empty fork seed, which only a spy can observe
// without booting a whole child agent.
vi.mock('@deepseek-ai/dsh-subagent-in-process-driver', async importOriginal => ({
  ...await importOriginal<typeof import('@deepseek-ai/dsh-subagent-in-process-driver')>(),
  startInProcessRun: vi.fn(),
}))

/** Real git subprocesses run here; the 5s default is too tight when specs share the host. */
const GIT_TIMEOUT_MS = 30_000

const temporaries: string[] = []

afterEach(() => {
  for (const dir of temporaries.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Run git with an argv array. */
function git(args: readonly string[], cwd: string): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8' }).trim()
}

/** A temp directory removed after each test. */
function temporary(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  temporaries.push(dir)
  return dir
}

/** A real git repository with a tracked `README.md` and `pkg/lib/code.txt`. */
function repository(): string {
  const dir = temporary('dsh-tw-repo-')
  git(['init', '--quiet', '--initial-branch=main'], dir)
  git(['config', 'user.email', 't@example.test'], dir)
  git(['config', 'user.name', 'T'], dir)
  mkdirSync(join(dir, 'pkg', 'lib'), { recursive: true })
  writeFileSync(join(dir, 'README.md'), 'seed\n')
  writeFileSync(join(dir, 'pkg', 'lib', 'code.txt'), 'code\n')
  git(['add', '.'], dir)
  git(['commit', '--quiet', '-m', 'seed'], dir)
  return dir
}

/** The real service mounted over a temp worktree root. */
async function realService(config: { adoptionGraceMs?: number } = {}): Promise<WorktreeService> {
  const ctx = new Context()
  await ctx.plugin(WorktreeService, { worktreeRoot: temporary('dsh-tw-root-'), pruneOnStart: false, ...config })
  return ctx.worktrees
}

interface CreateCall { repoRoot: string; threadId: string; baseRef: string; branch?: string }
interface RemoveCall { threadId: string; force?: boolean }

/** A minimal parent Agent carrying only the header fields the provider reads. */
function parent(cwd: string | undefined): Agent {
  return {
    id: 'parent-1',
    session: { header: { id: 'parent-1', ...cwd === undefined ? {} : { cwd } } },
  } as Agent
}

/** A WorktreeService double that records create/remove and can abort mid-create. */
function fakeWorktrees(opts: { onCreate?: () => void } = {}) {
  const repoRoot = repository()
  const worktreePath = temporary('dsh-tw-fake-')
  const creates: CreateCall[] = []
  const removes: RemoveCall[] = []
  return {
    repoRoot,
    worktreePath,
    creates,
    removes,
    service: {
      create: vi.fn(async (spec: CreateCall) => {
        creates.push(spec)
        opts.onCreate?.()
        return {
          threadId: spec.threadId,
          path: worktreePath,
          repoRoot,
          ...spec.branch === undefined ? {} : { branch: spec.branch },
          baseRef: spec.baseRef,
          state: 'ready' as const,
        }
      }),
      remove: vi.fn(async (record: { threadId: string }, removeOpts?: { force?: boolean }) => {
        removes.push({ threadId: record.threadId, ...removeOpts })
      }),
      list: vi.fn(async () => []),
      status: vi.fn(async () => ({ clean: true, changed: 0 })),
      reconcile: vi.fn(async () => []),
    },
  }
}

function providerFor(
  worktrees: ReturnType<typeof fakeWorktrees>,
  config: Partial<Config> = {},
) {
  return new ThreadWorktreeProvider(
    'thread',
    worktrees.service as never,
    { providerName: 'thread', branchPerThread: true, branchTemplate: 'dsh/thread-{{id}}', baseRef: 'head', ...config },
  )
}

function request(parentCwd: string | undefined, signal: AbortSignal, sessionId = 'abcdef12-3456'): ContinuableCreateRequest {
  return { sessionId, parent: parent(parentCwd), signal } as ContinuableCreateRequest
}

/** A one-shot start request, which carries the resolved descriptor the service appends. */
function startRequest(parentCwd: string, signal: AbortSignal): ResolvedSubagentStartRequest {
  return {
    prompt: [],
    parent: parent(parentCwd),
    signal,
    descriptor: { version: 1, mode: 'one-shot', provider: 'thread' },
  }
}

/**
 * Put a `git` first on `PATH` that fails `stash create`, until the returned
 * function restores the original `PATH`.
 */
function failingGitStash(): () => void {
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
  const dir = temporary('dsh-tw-shim-')
  const shim = join(dir, 'git')
  writeFileSync(shim, `#!/bin/sh\ncase "$*" in *"stash create"*) echo 'fatal: not a git repository' >&2; exit 128;; esac\nexec '${realGit}' "$@"\n`, 'utf8')
  chmodSync(shim, 0o755)
  const previous = process.env.PATH
  process.env.PATH = `${dir}:${previous ?? ''}`
  return () => { process.env.PATH = previous }
}

describe('thread worktree provider', () => {
  it('advertises no inherited context so each Thread gets an independent window', () => {
    expect(providerFor(fakeWorktrees()).inheritsParentContext).toBe(false)
  })

  it('starts a one-shot child on the shared driver with no fork seed', async () => {
    const worktrees = fakeWorktrees()
    const started = startRequest(worktrees.repoRoot, new AbortController().signal)

    await providerFor(worktrees).start(started)

    // One-shot children share the parent's cwd: the driver cannot relocate a child.
    expect(startInProcessRun).toHaveBeenCalledWith(started, {})
  })

  it('creates a worktree rooted at the parent cwd and returns it as the child cwd', async () => {
    const worktrees = fakeWorktrees()
    const spec = await providerFor(worktrees).prepareContinuable(request(worktrees.repoRoot, new AbortController().signal))

    expect(spec.cwd).toBe(worktrees.worktreePath)
    expect(worktrees.creates).toEqual([
      { repoRoot: worktrees.repoRoot, threadId: 'abcdef12-3456', baseRef: 'HEAD', branch: 'dsh/thread-abcdef12-3456' },
    ])
  })

  it('omits the branch when branchPerThread is disabled', async () => {
    const worktrees = fakeWorktrees()
    await providerFor(worktrees, { branchPerThread: false }).prepareContinuable(request(worktrees.repoRoot, new AbortController().signal))

    expect(worktrees.creates[0]?.branch).toBeUndefined()
  })

  it('fails loud when the parent session has no cwd, without touching git', async () => {
    const worktrees = fakeWorktrees()
    await expect(providerFor(worktrees).prepareContinuable(request(undefined, new AbortController().signal)))
      .rejects.toThrow(/cwd/)
    expect(worktrees.creates).toEqual([])
  })

  it('rejects before creating anything when the signal is already aborted', async () => {
    const worktrees = fakeWorktrees()
    const controller = new AbortController()
    controller.abort()

    await expect(providerFor(worktrees).prepareContinuable(request(worktrees.repoRoot, controller.signal)))
      .rejects.toThrow()
    expect(worktrees.creates).toEqual([])
  })

  it('removes the worktree it created when the signal aborts after creation', async () => {
    // The continuation manager cannot reclaim this: the child is not published yet and
    // the create spec carries no compensating callback, so the provider owns the rollback.
    const controller = new AbortController()
    const worktrees = fakeWorktrees({ onCreate: () => { controller.abort() } })

    await expect(providerFor(worktrees).prepareContinuable(request(worktrees.repoRoot, controller.signal)))
      .rejects.toThrow()
    expect(worktrees.removes).toEqual([{ threadId: 'abcdef12-3456', force: true }])
  })

  it('gives two Threads disjoint worktrees', async () => {
    const worktrees = fakeWorktrees()
    const provider = providerFor(worktrees)
    await provider.prepareContinuable(request(worktrees.repoRoot, new AbortController().signal, 'aaaa1111-0000'))
    await provider.prepareContinuable(request(worktrees.repoRoot, new AbortController().signal, 'bbbb2222-0000'))

    expect(worktrees.creates.map(c => c.branch)).toEqual(['dsh/thread-aaaa1111-0000', 'dsh/thread-bbbb2222-0000'])
    expect(worktrees.creates.map(c => c.threadId)).toEqual(['aaaa1111-0000', 'bbbb2222-0000'])
  })
})

describe('thread worktree provider with a real worktree service', { timeout: GIT_TIMEOUT_MS }, () => {
  it('maps a monorepo subdirectory cwd into the worktree and returns the configured preset', async () => {
    const repo = repository()
    const service = await realService()
    const provider = new ThreadWorktreeProvider(
      'thread',
      service,
      { providerName: 'thread', branchPerThread: true, branchTemplate: 'dsh/thread-{{id}}', baseRef: 'head', childAgentPreset: 'project-thread' },
    )
    const spec = await provider.prepareContinuable(request(join(repo, 'pkg', 'lib'), new AbortController().signal, 'sub-1'))
    const record = await service.get('sub-1')

    expect(record?.baseSha).toBe(git(['rev-parse', 'HEAD'], repo))
    expect(spec.cwd).toBe(join(record?.path ?? '', 'pkg', 'lib'))
    expect(spec.agentPreset).toBe('project-thread')
  })

  it('omits agentPreset when none is configured', async () => {
    const repo = repository()
    const spec = await providerFor({ ...fakeWorktrees(), service: await realService() } as never)
      .prepareContinuable(request(repo, new AbortController().signal, 'nopreset'))
    expect(spec).not.toHaveProperty('agentPreset')
  })

  it('fails loud when git cannot capture the parent\'s uncommitted changes', async () => {
    const repo = repository()
    const worktrees = fakeWorktrees()
    const restore = failingGitStash()
    try {
      await expect(providerFor(worktrees, { baseRef: 'head-with-uncommitted' })
        .prepareContinuable(request(repo, new AbortController().signal, 'stash-fail')))
        .rejects.toMatchObject({ code: 'WORKTREE_CREATE_FAILED' })
    } finally {
      restore()
    }
    // Nothing was created: the base ref is resolved before the worktree exists.
    expect(worktrees.creates).toEqual([])
  })

  it('refuses a parent cwd that resolves to no repository at all', async () => {
    const worktrees = fakeWorktrees()
    const outside = temporary('dsh-tw-outside-')

    // Loud, not a cwd that climbed out of the worktree: the relative path has to
    // be measured from the parent's OWN repository top level.
    await expect(providerFor(worktrees).prepareContinuable(request(outside, new AbortController().signal, 'no-repo')))
      .rejects.toMatchObject({ code: 'NOT_A_GIT_REPO' })
    // The provider owns the rollback: the worktree it already made goes away.
    expect(worktrees.removes).toEqual([{ threadId: 'no-repo', force: true }])
  })

  it('rolls back the worktree and fails loud when the subdirectory is not in the base commit', async () => {
    const repo = repository()
    mkdirSync(join(repo, 'untracked-dir'))
    const service = await realService()
    const provider = providerFor({ service } as never)

    await expect(provider.prepareContinuable(request(join(repo, 'untracked-dir'), new AbortController().signal, 'sub-2')))
      .rejects.toMatchObject({ code: 'WORKTREE_SUBDIRECTORY_MISSING' })
    expect((await service.get('sub-2'))?.state).toBe('removed')
    expect(git(['worktree', 'list', '--porcelain'], repo).match(/^worktree /gmu)).toHaveLength(1)
  })

  it('head ignores a tracked modification, head-with-uncommitted includes it', async () => {
    const repo = repository()
    writeFileSync(join(repo, 'README.md'), 'modified\n')
    writeFileSync(join(repo, 'untracked.txt'), 'u\n')
    const service = await realService()

    const plain = await providerFor({ service } as never).prepareContinuable(request(repo, new AbortController().signal, 'base-head'))
    const withChanges = await providerFor({ service } as never, { baseRef: 'head-with-uncommitted' })
      .prepareContinuable(request(repo, new AbortController().signal, 'base-dirty'))

    expect(git(['show', 'HEAD:README.md'], plain.cwd as string)).toBe('seed')
    expect(git(['status', '--porcelain'], withChanges.cwd as string)).toBe('')
    const record = await service.get('base-dirty')
    expect(record?.baseSha).not.toBe(git(['rev-parse', 'HEAD'], repo))
    expect(git(['show', 'HEAD:README.md'], withChanges.cwd as string)).toBe('modified')
    expect(git(['ls-files', '--others'], withChanges.cwd as string)).toBe('')
    expect(git(['status', '--porcelain'], repo)).toContain('README.md')
  })

  it('head-with-uncommitted falls back to HEAD on a clean checkout', async () => {
    const repo = repository()
    const service = await realService()
    await providerFor({ service } as never, { baseRef: 'head-with-uncommitted' })
      .prepareContinuable(request(repo, new AbortController().signal, 'clean'))
    expect((await service.get('clean'))?.baseSha).toBe(git(['rev-parse', 'HEAD'], repo))
  })
})

describe('thread worktree provider wiring', { timeout: GIT_TIMEOUT_MS }, () => {
  /** A minimal Context double exposing what `apply` touches. */
  function fakeContext(service: unknown, persistence: unknown) {
    const warns: string[] = []
    const disposers: (() => void)[] = []
    const ctx = {
      worktrees: service,
      subagents: { registerProvider: vi.fn() },
      get: (name: string) => (name === 'sessionPersistence' ? persistence : undefined),
      logger: { warn: (message: string) => { warns.push(message) } },
      effect: (fn: () => () => void) => { disposers.push(fn()) },
    }
    return { ctx, warns, dispose: () => { for (const d of disposers) d() } }
  }

  it('installs a session probe backed by persistence.stat and uninstalls it on disposal', async () => {
    const service: { sessionExists?: (id: string) => Promise<boolean> | boolean } = {}
    const known = new Set(['alive'])
    const persistence = { stat: vi.fn(async (id: string) => (known.has(id) ? {} : undefined)) }
    const { ctx, dispose } = fakeContext(service, persistence)

    apply(ctx as never, { providerName: 'thread', branchPerThread: true, branchTemplate: 'x', baseRef: 'head' })

    expect(await service.sessionExists?.('alive')).toBe(true)
    expect(await service.sessionExists?.('missing')).toBe(false)
    dispose()
    expect(service.sessionExists).toBeUndefined()
  })

  it('treats a missing persistence service as unknown and logs once', async () => {
    const service: { sessionExists?: (id: string) => Promise<boolean> | boolean } = {}
    const { ctx, warns } = fakeContext(service, undefined)
    apply(ctx as never, { providerName: 'thread', branchPerThread: true, branchTemplate: 'x', baseRef: 'head' })

    expect(await service.sessionExists?.('a')).toBe(true)
    expect(await service.sessionExists?.('b')).toBe(true)
    expect(warns).toHaveLength(1)
  })

  it('leaves a probe another owner installed alone on disposal', async () => {
    const service: { sessionExists?: (id: string) => Promise<boolean> | boolean } = {}
    const { ctx, dispose } = fakeContext(service, { stat: async () => ({}) })
    apply(ctx as never, { providerName: 'thread', branchPerThread: true, branchTemplate: 'x', baseRef: 'head' })
    const theirs = () => true
    service.sessionExists = theirs

    dispose()

    expect(service.sessionExists).toBe(theirs)
  })

  it('end to end: a worktree whose session never appeared is swept after the grace period', async () => {
    const repo = repository()
    const service = await realService({ adoptionGraceMs: 0 })
    const { ctx } = fakeContext(service, { stat: async () => undefined })
    apply(ctx as never, { providerName: 'thread', branchPerThread: true, branchTemplate: 'dsh/thread-{{id}}', baseRef: 'head' })
    await providerFor({ service } as never).prepareContinuable(request(repo, new AbortController().signal, 'lost'))

    expect((await service.reconcile()).map(r => r.threadId)).toEqual(['lost'])
    expect((await service.get('lost'))?.state).toBe('removed')
  })
})
