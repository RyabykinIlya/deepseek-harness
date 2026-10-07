/**
 * Threads tools suite: `thread_status` and `thread_diff` over the calling
 * Project Session's `threads` projection and a fake worktree service.
 *
 * The threads are real fold inputs appended to real Sessions, so every case
 * exercises the same durable rows the clients render rather than a stubbed
 * service value.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ThreadId, ThreadsService } from '@deepseek-ai/dsh-experimental-threads'
import type { ThreadStopReason } from '@deepseek-ai/dsh-experimental-threads'
import type { WorktreeChanges, WorktreeMergeCheck, WorktreeRecord } from '@deepseek-ai/dsh-worktree-manager'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as tool from '../src/index.ts'
import { renderOverview } from '../src/overview.ts'
import type { ThreadOverviewResult } from '../src/overview.ts'

const SIGNAL = new AbortController().signal

const roots: string[] = []
const contexts = new Set<Context>()

afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts) await ctx.fiber.dispose()
  contexts.clear()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** One Thread to record into a Project Session's log. */
interface ThreadSpec {
  readonly id: string
  readonly label: string
  readonly stopReason?: ThreadStopReason
  readonly branch?: string
  readonly note?: string
  readonly commitsAhead?: number
  readonly uncommitted?: number
}

/** Append creation plus, when given, one status report for one Thread. */
function seedThread(session: Session, spec: ThreadSpec): void {
  const threadId = ThreadId(spec.id)
  session.append('thread/created', {
    threadId,
    label: spec.label,
    ...spec.branch === undefined ? {} : { branch: spec.branch },
  }, { ignorable: true })
  if (spec.stopReason === undefined && spec.note === undefined && spec.commitsAhead === undefined
    && spec.uncommitted === undefined) return
  session.append('thread/status', {
    threadId,
    ...spec.stopReason === undefined ? {} : { stopReason: spec.stopReason },
    ...spec.note === undefined ? {} : { note: spec.note },
    ...spec.commitsAhead === undefined ? {} : { commitsAhead: spec.commitsAhead },
    ...spec.uncommitted === undefined ? {} : { uncommitted: spec.uncommitted },
  }, { ignorable: true })
}

/** Scriptable stand-in for the worktree service. */
interface FakeWorktrees {
  records: Map<string, WorktreeRecord>
  changes: WorktreeChanges
  patch: { patch: string; truncated: boolean }
  calls: string[]
  /** Per-Thread changes overriding `changes`. */
  changesById: Map<string, WorktreeChanges | Error>
  /** Answers `mergeCheck`; keyed `<threadId> <target>`, `clean` when absent. */
  merges: Map<string, WorktreeMergeCheck | Error>
  /** Thread ids whose `get` rejects. */
  failGet: Map<string, unknown>
  get(threadId: string): Promise<WorktreeRecord | undefined>
  changesOf(record: WorktreeRecord, opts: { maxCommits: number; maxFiles: number }): Promise<WorktreeChanges>
  filePatch(record: WorktreeRecord, path: string, maxBytes: number): Promise<{ patch: string; truncated: boolean }>
  mergeCheckOf(record: WorktreeRecord, target: string, max: number): Promise<WorktreeMergeCheck>
}

/** A ready worktree record for `threadId`. */
function record(threadId: string, extra: Partial<WorktreeRecord> = {}): WorktreeRecord {
  return {
    threadId,
    path: `/wt/${threadId}`,
    branch: `dsh/${threadId}`,
    baseRef: 'main',
    baseSha: 'b'.repeat(40),
    state: 'ready',
    repoRoot: '/repo',
    ...extra,
  }
}

/** Create a fake worktree service with one ready record per id. */
function fakeWorktrees(ids: string[]): FakeWorktrees {
  const fake: FakeWorktrees = {
    records: new Map(ids.map(id => [id, record(id)])),
    changes: {
      baseSha: 'b'.repeat(40),
      headSha: 'h'.repeat(40),
      commits: [{ sha: 'c'.repeat(40), subject: 'add auth' }, { sha: 'd'.repeat(40), subject: 'init' }],
      commitsTotal: 2,
      files: [{ path: 'src/auth.ts', added: 10, removed: 2 }, { path: 'logo.png', binary: true }],
      filesTotal: 2,
      uncommitted: 1,
    },
    patch: { patch: 'diff --git a/src/auth.ts b/src/auth.ts\n+x', truncated: false },
    calls: [],
    changesById: new Map(),
    merges: new Map(),
    failGet: new Map(),
    get(threadId) {
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- exercises a non-Error rejection
      if (fake.failGet.has(threadId)) return Promise.reject(fake.failGet.get(threadId))
      return Promise.resolve(fake.records.get(threadId))
    },
    changesOf(rec, opts) {
      fake.calls.push(`changes ${opts.maxCommits} ${opts.maxFiles}`)
      const own = fake.changesById.get(rec.threadId)
      if (own instanceof Error) return Promise.reject(own)
      return Promise.resolve(own ?? fake.changes)
    },
    mergeCheckOf(rec, target, max) {
      fake.calls.push(`merge ${rec.threadId} ${target} ${max}`)
      const answer = fake.merges.get(`${rec.threadId} ${target}`) ?? {
        supported: true, targetSha: 't'.repeat(40), headSha: 'h'.repeat(40), clean: true, conflicts: [], conflictsTotal: 0,
      }
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)
    },
    filePatch(_record, path, maxBytes) {
      fake.calls.push(`patch ${path} ${maxBytes}`)
      return Promise.resolve(fake.patch)
    },
  }
  return fake
}

/** Mount the tools with the Threads domain, a real AgentLoop, and two Project Sessions. */
async function setup(
  spec: { readonly threads?: boolean; readonly worktrees?: FakeWorktrees; readonly config?: tool.Config } = {},
): Promise<{ ctx: Context; project: Agent; other: Agent; fiber: Fiber; running: Set<string> }> {
  const { threads = true, config, worktrees } = spec
  const ctx = new Context()
  contexts.add(ctx)
  await mountAgentLoopTestDependencies(ctx)
  const root = mkdtempSync(join(tmpdir(), 'dsh-tool-threads-'))
  roots.push(root)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(AgentLoop, { agents: [] })
  const running = new Set<string>()
  if (threads) {
    await ctx.plugin(ThreadsService)
    // Own property shadows the prototype method, so the test does not depend on the runtime liveness source.
    Object.defineProperty(ctx.threads, 'isRunning', { configurable: true, value: (id: string) => running.has(id) })
  }
  if (worktrees) {
    ctx.provide('worktrees', {
      get: (threadId: string) => worktrees.get(threadId),
      changes: (rec: WorktreeRecord, opts: { maxCommits: number; maxFiles: number }) => worktrees.changesOf(rec, opts),
      filePatch: (rec: WorktreeRecord, path: string, max: number) => worktrees.filePatch(rec, path, max),
      mergeCheck: (rec: WorktreeRecord, opts: { target: string }, max: number) => worktrees.mergeCheckOf(rec, opts.target, max),
    } as never)
  }
  const fiber = await ctx.plugin(tool, config)
  ctx.llm.registerAdapter(['mock'], new MockAdapter([]))
  const project = await ctx.agentLoop.create(SessionId('project'), { provider: 'mock', model: 'mock' })
  const other = await ctx.agentLoop.create(SessionId('other-project'), { provider: 'mock', model: 'mock' })
  return { ctx, project, other, fiber, running }
}

/** Mount with the projection registry removed so `ctx.threads.available` is false. */
async function setupWithoutProjectionRegistry(): Promise<{ ctx: Context; project: Agent }> {
  const ctx = new Context()
  contexts.add(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  const registry = await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  const root = mkdtempSync(join(tmpdir(), 'dsh-tool-threads-'))
  roots.push(root)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], new MockAdapter([]))
  const project = await ctx.agentLoop.create(SessionId('project'), { provider: 'mock', model: 'mock' })
  seedThread(project.session, { id: 'thread-a', label: 'port auth' })
  await registry.dispose()
  await ctx.plugin(ThreadsService)
  await ctx.plugin(tool)
  return { ctx, project }
}

let callNumber = 0

/** Execute a Thread tool as the given calling agent. */
function callTool(ctx: Context, agent: Agent | undefined, args: unknown, name = 'thread_status') {
  return ctx.tools.execute({
    signal: SIGNAL,
    callId: ToolCallId(`threads-call-${++callNumber}`),
    name,
    arguments: args,
    ...agent === undefined ? {} : { agent },
  })
}

/** The model's rendered text for one tool result. */
function text(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

const bytes = (value: string): number => Buffer.byteLength(value, 'utf8')

describe('thread_status', () => {
  it('registers both tools with their parameters', async () => {
    const { ctx } = await setup()
    const status = ctx.tools.schemas().find(schema => schema.name === 'thread_status')!
    const statusParams = status.parameters as { properties?: Record<string, { enum?: string[]; description?: string }> }
    expect(Object.keys(statusParams.properties ?? {})).toEqual(['status', 'limit'])
    expect(statusParams.properties?.status?.enum)
      .toEqual(['running', 'idle', 'completed', 'aborted', 'error', 'max-tokens', 'refusal'])
    expect(statusParams.properties?.limit?.description).toContain('1 through 100')
    const diff = ctx.tools.schemas().find(schema => schema.name === 'thread_diff')!
    const diffParams = diff.parameters as { properties?: Record<string, unknown>; required?: string[] }
    expect(Object.keys(diffParams.properties ?? {})).toEqual(['thread_id', 'path'])
    expect(diffParams.required ?? []).toEqual([])
  })

  it('returns only the calling session Threads, with idle vs running from the runtime', async () => {
    const { ctx, project, other, running } = await setup()
    seedThread(project.session, { id: 'thread-a', label: 'port auth' })
    seedThread(project.session, { id: 'thread-b', label: 'write docs' })
    seedThread(other.session, { id: 'thread-foreign', label: 'someone else' })
    running.add('thread-a')

    const result = await callTool(ctx, project, {})

    expect(result.isError).toBe(false)
    expect(text(result)).toBe('thread-a [running] port auth\nthread-b [idle] write docs')
  })

  it('renders branch, counts, note and outcome on one line', async () => {
    const { ctx, project } = await setup()
    seedThread(project.session, {
      id: 'thread-done', label: 'write docs', stopReason: 'completed', branch: 'dsh/thread-done',
      commitsAhead: 3, uncommitted: 0, note: 'Docs\nwritten.',
    })
    seedThread(project.session, { id: 'thread-ref', label: 'x', stopReason: 'refusal' })

    const result = await callTool(ctx, project, {})

    expect(text(result)).toBe([
      'thread-done [completed] write docs | branch dsh/thread-done | 3 commits ahead, 0 uncommitted | note: Docs written.',
      'thread-ref [refusal] x',
    ].join('\n'))
  })

  it('filters by state before limiting and reports an explicit empty answer', async () => {
    const { ctx, project, running } = await setup()
    seedThread(project.session, { id: 'thread-a', label: 'a' })
    seedThread(project.session, { id: 'thread-b', label: 'b' })
    seedThread(project.session, { id: 'thread-c', label: 'c', stopReason: 'completed' })
    running.add('thread-a')

    expect(text(await callTool(ctx, project, { status: 'completed', limit: 1 }))).toBe('thread-c [completed] c')
    expect(text(await callTool(ctx, project, { status: 'idle' }))).toBe('thread-b [idle] b')
    expect(text(await callTool(ctx, project, { status: 'running' }))).toBe('thread-a [running] a')
    expect(text(await callTool(ctx, project, { status: 'aborted' }))).toBe('(no threads)')
  })

  it('says how many were omitted by limit', async () => {
    const { ctx, project } = await setup()
    for (let index = 0; index < 5; index += 1) seedThread(project.session, { id: `t${index}`, label: `task ${index}` })

    const result = await callTool(ctx, project, { limit: 2 })

    expect(text(result)).toBe([
      't0 [idle] task 0',
      't1 [idle] task 1',
      '(3 of 5 threads omitted; filter by state or raise limit)',
    ].join('\n'))
  })

  it('bounds the complete text in bytes: tiny, exact, and multibyte', async () => {
    const lines = (count: number): string[] =>
      Array.from({ length: count }, (_, index) => `t${index} [idle] 任务${index}`)
    const seed = async (maxResultBytes: number) => {
      const { ctx, project } = await setup({ config: { maxResultBytes } })
      for (let index = 0; index < 6; index += 1) seedThread(project.session, { id: `t${index}`, label: `任务${index}` })
      return { ctx, project }
    }

    // Exact fit: all six rows, no footer.
    const full = lines(6).join('\n')
    const exact = await seed(Math.max(1024, bytes(full)))
    const exactText = text(await callTool(exact.ctx, exact.project, {}))
    expect(exactText).toBe(full)

    // Tiny bound (the 1024 floor) with long labels: footer present, text within bound.
    const { ctx, project } = await setup({ config: { maxResultBytes: 1024 } })
    for (let index = 0; index < 40; index += 1) {
      seedThread(project.session, { id: `thread-${index}`, label: '多字节标签'.repeat(30) })
    }
    const result = await callTool(ctx, project, { limit: 40 })
    const out = text(result)
    expect(bytes(out)).toBeLessThanOrEqual(1024)
    expect(out).toMatch(/\(\d+ of 40 threads omitted; filter by state or raise limit\)$/)
    expect(out).not.toContain('\ufffd')
  })

  it('shortens an oversized single label instead of exceeding the bound', async () => {
    const { ctx, project } = await setup({ config: { maxResultBytes: 1024 } })
    seedThread(project.session, { id: 'thread-a', label: 'x'.repeat(5000), note: 'n'.repeat(5000) })
    const out = text(await callTool(ctx, project, {}))
    expect(bytes(out)).toBeLessThanOrEqual(1024)
    expect(out).toContain('…')
  })

  it('fails loudly without the Threads domain or projection registry', async () => {
    const absent = await setup({ threads: false })
    const first = await callTool(absent.ctx, absent.project, {})
    expect(first.isError).toBe(true)
    expect(text(first)).toContain('@deepseek-ai/dsh-experimental-threads is not loaded')

    const noRegistry = await setupWithoutProjectionRegistry()
    const second = await callTool(noRegistry.ctx, noRegistry.project, {})
    expect(second.isError).toBe(true)
    expect(text(second)).toContain('the `threads` Session projection is unavailable')
    expect(text(second)).not.toContain('(no threads)')
  })

  it('rejects out-of-range limits and a missing calling agent', async () => {
    const { ctx, project } = await setup()
    for (const limit of [0, 101, 2.5]) {
      const result = await callTool(ctx, project, { limit })
      expect(result.isError).toBe(true)
    }
    const noAgent = await callTool(ctx, undefined, {})
    expect(noAgent.isError).toBe(true)
    expect(text(noAgent)).toContain('requires a calling agent')
  })

  it('honours configured page sizes and clamps direct-apply values', async () => {
    const { ctx, project } = await setup({ config: { defaultLimit: 2, maxLimit: 3 } })
    for (let index = 0; index < 6; index += 1) seedThread(project.session, { id: `t${index}`, label: `task ${index}` })
    expect(text(await callTool(ctx, project, {}))).toContain('(4 of 6 threads omitted')
    expect(text(await callTool(ctx, project, { limit: 5 }))).toContain('(3 of 6 threads omitted')

    const direct = await setup()
    await direct.fiber.dispose()
    tool.apply(direct.ctx, { defaultLimit: 250, maxLimit: 500, maxResultBytes: 1 })
    const schema = direct.ctx.tools.schemas().find(candidate => candidate.name === 'thread_status')
    expect((schema?.parameters as { properties?: { limit?: { description?: string } } })
      .properties?.limit?.description).toContain('Defaults to 100')
  })

  it('unregisters with its plugin fiber and keeps the function-plugin export shape', async () => {
    const ctx = new Context()
    contexts.add(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    const fiber = await ctx.plugin(tool)
    expect(ctx.tools.schemas().map(schema => schema.name)).toEqual(expect.arrayContaining(['thread_status', 'thread_diff']))
    await fiber.dispose()
    expect(ctx.tools.schemas().some(schema => schema.name === 'thread_diff')).toBe(false)
    expect('default' in tool).toBe(false)
    expect(tool.name).toBe('tool-threads')
    expect(tool.inject).toEqual(['tools'])
  })
})

describe('thread_diff', () => {
  // `undefined` models a tool call the executor made without a calling Agent.
  const diff = (ctx: Context, agent: Agent | undefined, args: unknown) => callTool(ctx, agent, args, 'thread_diff')

  it('summarizes commits, files, uncommitted count and the merge command', async () => {
    const worktrees = fakeWorktrees(['thread-a'])
    const { ctx, project } = await setup({ worktrees })
    seedThread(project.session, { id: 'thread-a', label: 'port auth' })

    const result = await diff(ctx, project, { thread_id: 'thread-a' })

    expect(result.isError).toBe(false)
    expect(text(result)).toBe([
      'Thread thread-a',
      'branch dsh/thread-a: import it into the Project checkout with `git fetch /wt/thread-a dsh/thread-a:dsh/thread-a`, then merge with `git merge --no-ff dsh/thread-a`',
      `base ${'b'.repeat(12)}, head ${'h'.repeat(12)}; 1 uncommitted in /wt/thread-a (not on the branch until committed)`,
      'commits (2, newest first):',
      `  ${'c'.repeat(12)} add auth`,
      `  ${'d'.repeat(12)} init`,
      'committed files (2):',
      '  +10 -2 src/auth.ts',
      '  binary logo.png',
    ].join('\n'))
    expect(worktrees.calls).toEqual(['changes 30 100'])
  })

  it('rejects threads outside the caller projection', async () => {
    const worktrees = fakeWorktrees(['thread-foreign'])
    const { ctx, project, other } = await setup({ worktrees })
    seedThread(other.session, { id: 'thread-foreign', label: 'x' })
    const result = await diff(ctx, project, { thread_id: 'thread-foreign' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('unknown thread id thread-foreign; call thread_status')
    expect(worktrees.calls).toEqual([])
  })

  it('returns a file patch and marks truncation within the byte bound', async () => {
    const worktrees = fakeWorktrees(['thread-a'])
    const { ctx, project } = await setup({ worktrees, config: { maxResultBytes: 1024, maxPatchBytes: 512 } })
    seedThread(project.session, { id: 'thread-a', label: 'a' })

    const small = await diff(ctx, project, { thread_id: 'thread-a', path: 'src/auth.ts' })
    expect(text(small)).toBe([
      'Thread thread-a branch dsh/thread-a, committed changes to src/auth.ts',
      'diff --git a/src/auth.ts b/src/auth.ts\n+x',
    ].join('\n'))
    expect(worktrees.calls).toEqual(['patch src/auth.ts 512'])

    worktrees.patch = { patch: '多'.repeat(600), truncated: true }
    const cut = text(await diff(ctx, project, { thread_id: 'thread-a', path: 'src/auth.ts' }))
    expect(bytes(cut)).toBeLessThanOrEqual(1024)
    expect(cut).toContain('[patch truncated here;')
    expect(cut).not.toContain('\ufffd')

    worktrees.patch = { patch: '', truncated: false }
    expect(text(await diff(ctx, project, { thread_id: 'thread-a', path: 'x.ts' })))
      .toContain('(no committed changes to this file)')
  })

  it('renders a detached worktree and points a cut patch at BASE without a recorded base', async () => {
    const worktrees = fakeWorktrees(['thread-a', 'thread-b'])
    const { branch: _summaryBranch, ...detached } = record('thread-a')
    const { branch: _patchBranch, ...noBase } = record('thread-b')
    const { baseSha: _noBaseSha, ...unbased } = noBase
    worktrees.records.set('thread-a', detached)
    worktrees.records.set('thread-b', unbased)
    worktrees.patch = { patch: '多'.repeat(600), truncated: true }
    const { ctx, project } = await setup({ worktrees, config: { maxResultBytes: 1024 } })
    seedThread(project.session, { id: 'thread-a', label: 'a' })
    seedThread(project.session, { id: 'thread-b', label: 'b' })

    const summary = text(await diff(ctx, project, { thread_id: 'thread-a' }))
    expect(summary).toContain(`no branch (detached): fetch commit ${'h'.repeat(40)} from /wt/thread-a into the Project checkout and merge it`)

    const cut = text(await diff(ctx, project, { thread_id: 'thread-b', path: 'src/auth.ts' }))
    expect(bytes(cut)).toBeLessThanOrEqual(1024)
    expect(cut).toContain('Thread thread-b, committed changes to src/auth.ts')
    expect(cut).toContain('read the rest with git -C /wt/thread-b diff BASE..HEAD -- src/auth.ts]')
  })

  it('bounds the summary by dropping files then commits and says so', async () => {
    const worktrees = fakeWorktrees(['thread-a'])
    worktrees.changes = {
      ...worktrees.changes,
      commits: Array.from({ length: 30 }, (_, i) => ({ sha: String(i).padStart(40, '0'), subject: `commit ${i} ${'s'.repeat(150)}` })),
      commitsTotal: 45,
      files: Array.from({ length: 100 }, (_, i) => ({ path: `src/dir/file-${i}.ts`, added: i, removed: 0 })),
      filesTotal: 140,
    }
    const { ctx, project } = await setup({ worktrees, config: { maxResultBytes: 1024 } })
    seedThread(project.session, { id: 'thread-a', label: 'a' })

    const out = text(await diff(ctx, project, { thread_id: 'thread-a' }))

    expect(bytes(out)).toBeLessThanOrEqual(1024)
    expect(out).toMatch(/more files omitted; pass path to read one patch\)/)
    expect(out).toMatch(/more commits omitted\)/)
  })

  it('explains an archived or missing worktree', async () => {
    const worktrees = fakeWorktrees(['thread-a'])
    worktrees.records.set('thread-a', record('thread-a', { state: 'removed' }))
    const { ctx, project } = await setup({ worktrees })
    seedThread(project.session, { id: 'thread-a', label: 'a' })
    seedThread(project.session, { id: 'thread-b', label: 'b' })

    const archived = await diff(ctx, project, { thread_id: 'thread-a' })
    expect(archived.isError).toBe(true)
    expect(text(archived)).toContain('was archived')
    expect(text(archived)).toContain('git log dsh/thread-a')

    const missing = await diff(ctx, project, { thread_id: 'thread-b' })
    expect(missing.isError).toBe(true)
    expect(text(missing)).toContain('no worktree is recorded for thread thread-b')
  })

  it('names every unusable worktree state and the branch a missing record may still hold', async () => {
    const worktrees = fakeWorktrees(['thread-a', 'thread-b', 'thread-c'])
    // Neither the record nor the Thread row names a branch, so there is nothing to point at.
    const { branch: _detachedA, ...detachedA } = record('thread-a', { state: 'reserved' })
    // The row still names the branch, so the Thread's commits stay reachable there.
    const { branch: _detachedB, ...detachedB } = record('thread-b', { state: 'reserved' })
    worktrees.records.set('thread-a', detachedA)
    worktrees.records.set('thread-b', detachedB)
    worktrees.records.delete('thread-c')
    const { ctx, project } = await setup({ worktrees })
    seedThread(project.session, { id: 'thread-a', label: 'a' })
    seedThread(project.session, { id: 'thread-b', label: 'b', branch: 'dsh/thread-b' })
    seedThread(project.session, { id: 'thread-c', label: 'c', branch: 'dsh/thread-c' })

    const unreadable = await diff(ctx, project, { thread_id: 'thread-a' })
    expect(text(unreadable)).toBe('Error: the worktree of thread thread-a '
      + 'is not readable right now (state reserved); try again later.')

    const pointed = await diff(ctx, project, { thread_id: 'thread-b' })
    expect(text(pointed)).toContain('is not readable right now (state reserved); try again later. '
      + 'Its commits may still be on branch dsh/thread-b: inspect with git log dsh/thread-b')

    const missing = await diff(ctx, project, { thread_id: 'thread-c' })
    expect(text(missing)).toContain('no worktree is recorded for thread thread-c; '
      + 'it was never created or has been cleaned up. Its commits may still be on branch dsh/thread-c.')
  })

  it('rejects unsafe paths and fails loudly without services', async () => {
    const worktrees = fakeWorktrees(['thread-a'])
    const { ctx, project } = await setup({ worktrees })
    seedThread(project.session, { id: 'thread-a', label: 'a' })
    for (const path of ['../x', '/etc/passwd', '--output=x', '']) {
      const result = await diff(ctx, project, { thread_id: 'thread-a', path })
      expect(result.isError, path).toBe(true)
      expect(text(result)).toContain('repo-relative')
    }
    expect(worktrees.calls).toEqual([])

    const noWorktrees = await setup()
    seedThread(noWorktrees.project.session, { id: 'thread-a', label: 'a' })
    const missingService = await diff(noWorktrees.ctx, noWorktrees.project, { thread_id: 'thread-a' })
    expect(missingService.isError).toBe(true)
    expect(text(missingService)).toContain('dsh-worktree-manager is not loaded')

    const noThreads = await setup({ threads: false })
    const missingThreads = await diff(noThreads.ctx, noThreads.project, { thread_id: 'thread-a' })
    expect(text(missingThreads)).toContain('dsh-experimental-threads is not loaded')

    const noAgent = await diff(ctx, undefined, { thread_id: 'thread-a' })
    expect(noAgent.isError).toBe(true)
    expect(text(noAgent)).toContain('thread_diff requires a calling agent')
  })
})

describe('thread_diff overview', () => {
  const overview = (ctx: Context, agent: Agent, args: unknown = {}) => callTool(ctx, agent, args, 'thread_diff')

  /** Committed changes touching `paths`. */
  const touching = (paths: string[], extra: Partial<WorktreeChanges> = {}): WorktreeChanges => ({
    baseSha: 'b'.repeat(40),
    headSha: 'h'.repeat(40),
    commits: [],
    commitsTotal: 1,
    files: paths.map(path => ({ path, added: 1, removed: 0 })),
    filesTotal: paths.length,
    uncommitted: 0,
    ...extra,
  })

  const merge = (clean: boolean, conflicts: string[] = [], total = conflicts.length): WorktreeMergeCheck => ({
    supported: true, targetSha: 't'.repeat(40), headSha: 'h'.repeat(40), clean, conflicts, conflictsTotal: total,
  })

  async function seeded(ids: string[], config?: tool.Config) {
    const worktrees = fakeWorktrees(ids)
    const mounted = await setup({ worktrees, ...config === undefined ? {} : { config } })
    for (const id of ids) seedThread(mounted.project.session, { id, label: `task ${id}` })
    return { worktrees, ...mounted }
  }

  it('describes the overview in the schema and keeps thread_id optional', async () => {
    const { ctx } = await setup()
    const schema = ctx.tools.schemas().find(candidate => candidate.name === 'thread_diff')!
    const params = schema.parameters as { required?: string[]; properties?: Record<string, { description?: string }> }
    expect(params.required ?? []).toEqual([])
    expect(params.properties?.thread_id?.description).toContain('before merging several Threads')
    expect(schema.description).toContain('Without thread_id: an overview')
  })

  it('answers (no threads) for a Project without Threads', async () => {
    const worktrees = fakeWorktrees([])
    const { ctx, project } = await setup({ worktrees })
    const result = await overview(ctx, project)
    expect(result.isError).toBe(false)
    expect(text(result)).toBe('(no threads)')
    expect(worktrees.calls).toEqual([])
  })

  it('reports one Thread with its HEAD prediction and order', async () => {
    const { ctx, project, worktrees } = await seeded(['thread-a'])
    worktrees.changesById.set('thread-a', touching(['src/a.ts', 'src/b.ts'], { commitsTotal: 3, uncommitted: 2 }))

    expect(text(await overview(ctx, project))).toBe([
      'Overview of 1 Thread with a live worktree (read-only; committed work only, uncommitted edits are not part of overlaps or predictions)',
      'thread-a [dsh/thread-a] task thread-a | 3 commits, 2 files, 2 uncommitted | into HEAD: merges cleanly',
      'overlaps: none (no committed path is touched by two Threads)',
      RULE,
      'merge order: thread-a',
    ].join('\n'))
    expect(worktrees.calls).toEqual(['changes 0 100', 'merge thread-a HEAD 5'])
  })

  it('predicts conflicts for overlapping Threads and orders independent work first', async () => {
    const { ctx, project, worktrees } = await seeded(['thread-a', 'thread-b', 'thread-c'])
    worktrees.changesById.set('thread-a', touching(['shared.ts', 'a.ts']))
    worktrees.changesById.set('thread-b', touching(['shared.ts']))
    worktrees.changesById.set('thread-c', touching(['c.ts']))
    worktrees.merges.set('thread-b HEAD', merge(false, ['x1', 'x2', 'x3', 'x4', 'x5'], 7))
    worktrees.merges.set('thread-a dsh/thread-b', merge(false, ['shared.ts']))

    const out = text(await overview(ctx, project))

    expect(out).toBe([
      'Overview of 3 Threads with a live worktree (read-only; committed work only, uncommitted edits are not part of overlaps or predictions)',
      'thread-a [dsh/thread-a] task thread-a | 1 commit, 2 files, 0 uncommitted | into HEAD: merges cleanly',
      'thread-b [dsh/thread-b] task thread-b | 1 commit, 1 file, 0 uncommitted | into HEAD: conflicts in 7 paths: x1, x2, x3, x4, x5 (+2 more)',
      'thread-c [dsh/thread-c] task thread-c | 1 commit, 1 file, 0 uncommitted | into HEAD: merges cleanly',
      'overlaps (1 committed path touched by 2+ Threads):',
      '  shared.ts: thread-a, thread-b',
      'pair checks (one Thread\'s branch merged into the other):',
      '  thread-a + thread-b: conflicts in 1 path: shared.ts',
      RULE,
      'merge order: thread-c, thread-a, thread-b',
    ].join('\n'))
    expect(worktrees.calls.filter(call => call.startsWith('merge'))).toEqual([
      'merge thread-a HEAD 5', 'merge thread-b HEAD 5', 'merge thread-c HEAD 5', 'merge thread-a dsh/thread-b 5',
    ])
  })

  it('reports overlapping Threads that merge cleanly into each other', async () => {
    const { ctx, project, worktrees } = await seeded(['thread-a', 'thread-b'])
    worktrees.changesById.set('thread-a', touching(['z.ts', 'a.ts', 'm.ts']))
    worktrees.changesById.set('thread-b', touching(['z.ts', 'a.ts', 'm.ts']))
    const out = text(await overview(ctx, project))
    expect(out).toContain('  a.ts: thread-a, thread-b\n  m.ts: thread-a, thread-b\n  z.ts: thread-a, thread-b')
    expect(out).toContain('  thread-a + thread-b: merges cleanly')
    expect(out).toContain('merge order: thread-a, thread-b')
  })

  it('still reports overlaps when git cannot predict merges', async () => {
    const { ctx, project, worktrees } = await seeded(['thread-a', 'thread-b'])
    worktrees.changesById.set('thread-a', touching(['shared.ts']))
    worktrees.changesById.set('thread-b', touching(['shared.ts']))
    worktrees.merges.set('thread-a HEAD', { supported: false })
    const out = text(await overview(ctx, project))
    expect(out).toContain('  shared.ts: thread-a, thread-b')
    expect(out).toContain('conflict prediction needs git 2.38+ (git merge-tree --write-tree)')
    expect(out).not.toContain('into HEAD')
    expect(out).not.toContain('pair checks')
    expect(out).toContain('merge order: thread-a, thread-b')
    expect(worktrees.calls.filter(call => call.startsWith('merge'))).toEqual(['merge thread-a HEAD 5'])
  })

  it('keeps going when a pair check meets an unsupported git after a failed HEAD check', async () => {
    const { ctx, project, worktrees } = await seeded(['thread-a', 'thread-b'])
    worktrees.changesById.set('thread-a', touching(['shared.ts']))
    worktrees.changesById.set('thread-b', touching(['shared.ts']))
    worktrees.merges.set('thread-a HEAD', new Error('boom'))
    worktrees.merges.set('thread-a dsh/thread-b', { supported: false })
    const out = text(await overview(ctx, project))
    expect(out).toContain('into HEAD: check failed: boom')
    expect(out).toContain('conflict prediction needs git 2.38+')
    expect(out).toContain('merge order: thread-a, thread-b')
  })

  it('renders a failed outcome without a message', () => {
    const value: ThreadOverviewResult = {
      mode: 'overview', threads: [], threadsTotal: 1, skipped: [], skippedTotal: 0, unexamined: 0, overlaps: [],
      overlapsTotal: 0, filesCapped: false, predictionSupported: true, pairs: [], pairsTotal: 0, pairsUnchecked: 0, order: [],
    }
    const withThread: ThreadOverviewResult = {
      ...value,
      threads: [{ threadId: 't', label: 'l', commitsTotal: 0, filesTotal: 0, uncommitted: 0,
        merge: { status: 'failed', conflicts: [], conflictsTotal: 0 } }],
    }
    expect(renderOverview(withThread, 4096)).toContain('t [detached] l | 0 commits, 0 files, 0 uncommitted | into HEAD: check failed: unknown error')
  })

  it('lists Threads without a readable worktree as skipped', async () => {
    const { ctx, project, worktrees } = await seeded(
      ['thread-a', 'thread-b', 'thread-c', 'thread-d', 'thread-e', 'thread-f', 'thread-g'],
    )
    worktrees.records.delete('thread-a')
    worktrees.records.set('thread-b', record('thread-b', { state: 'removed' }))
    worktrees.records.set('thread-c', record('thread-c', { state: 'reserved' }))
    worktrees.failGet.set('thread-d', 'registry offline')
    worktrees.changesById.set('thread-e', new Error('git exploded\nbadly'))
    worktrees.changesById.set('thread-f', touching(['f.ts']))
    worktrees.changesById.set('thread-g', touching([], { commitsTotal: 0, filesTotal: 0 }))
    worktrees.merges.set('thread-f HEAD', new Error('merge-tree failed'))

    const out = text(await overview(ctx, project))

    expect(out).toContain('Overview of 2 Threads with a live worktree')
    expect(out).toContain('thread-f [dsh/thread-f] task thread-f | 1 commit, 1 file, 0 uncommitted | into HEAD: check failed: merge-tree failed')
    expect(out).toContain('thread-g [dsh/thread-g] task thread-g | 0 commits, 0 files, 0 uncommitted | into HEAD: merges cleanly')
    expect(out).toContain('skipped thread-a: no worktree is recorded (never created or cleaned up)')
    expect(out).toContain('skipped thread-b: worktree archived (removed)')
    expect(out).toContain('skipped thread-c: worktree not readable (state reserved)')
    expect(out).toContain('skipped thread-d: worktree lookup failed: registry offline')
    expect(out).toContain('skipped thread-e: changes unreadable: git exploded badly')
    expect(out).toContain('merge order: thread-f')
  })

  it('reports only skipped Threads, not an error, when no worktree is live', async () => {
    const { ctx, project, worktrees } = await seeded(['thread-a'])
    worktrees.records.clear()
    const result = await overview(ctx, project)
    expect(result.isError).toBe(false)
    expect(text(result)).toContain('Overview of 0 Threads with a live worktree')
    expect(text(result)).toContain('skipped thread-a:')
    expect(text(result)).toContain('merge order: nothing to merge')
  })

  it('counts detached and over-limit pairs as unchecked and flags capped file lists', async () => {
    const { ctx, project, worktrees } = await seeded(
      ['thread-a', 'thread-b', 'thread-c', 'thread-d'],
      { maxFiles: 1, maxOverviewThreads: 3, maxPairChecks: 1 },
    )
    const { branch: _detached, ...detached } = record('thread-b')
    worktrees.records.set('thread-b', detached)
    worktrees.changesById.set('thread-a', touching(['shared.ts'], { filesTotal: 4 }))
    worktrees.changesById.set('thread-b', touching(['shared.ts']))
    worktrees.changesById.set('thread-c', touching(['shared.ts']))

    const out = text(await overview(ctx, project))

    expect(out).toContain('(1 later Thread not examined; call thread_diff with their thread_id)')
    expect(out).toContain('(overlaps use only the first committed files of Threads that changed more')
    expect(out).toContain('thread-b [detached]')
    expect(out).toContain('  thread-a + thread-c: merges cleanly')
    expect(out).toContain('(2 overlapping pairs not checked: detached worktree or pair-check limit)')
    expect(out).toContain('  shared.ts: thread-a, thread-b, thread-c')
  })

  it('cuts overlaps, pair checks, skipped Threads, then Threads to the byte bound with an omission line', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `thread-${String(i).padStart(2, '0')}`)
    const { ctx, project, worktrees } = await seeded(ids, { maxResultBytes: 1024 })
    const paths = Array.from({ length: 30 }, (_, i) => `src/module-${i}/index.ts`)
    for (const id of ids) worktrees.changesById.set(id, touching(paths))
    worktrees.records.delete('thread-11')

    const out = text(await overview(ctx, project))

    expect(bytes(out)).toBeLessThanOrEqual(1024)
    expect(out).toMatch(/\(\d+ more overlapping paths omitted\)/)
    expect(out).toMatch(/\(\d+ more pair checks omitted\)/)
    expect(out).toContain('merge order: thread-00, thread-01')
  })

  it('drops skipped and Thread lines when even that does not fit', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `thread-${String(i).padStart(2, '0')}`)
    const { ctx, project, worktrees } = await seeded(ids, { maxResultBytes: 1024 })
    worktrees.changesById.set('thread-00', touching(['x']))
    for (const id of ids.slice(1)) worktrees.records.set(id, record(id, { state: 'removed' }))
    const out = text(await overview(ctx, project))
    expect(bytes(out)).toBeLessThanOrEqual(1024)
    expect(out).toMatch(/\(\d+ more skipped Threads omitted\)/)
  })

  it('omits Thread lines last when the budget leaves no room for them', async () => {
    const ids = Array.from({ length: 30 }, (_, i) => `thread-with-a-long-identifier-${String(i).padStart(2, '0')}`)
    const { ctx, project } = await seeded(ids, { maxResultBytes: 1024, maxOverviewThreads: 30 })
    const out = text(await overview(ctx, project))
    expect(bytes(out)).toBeLessThanOrEqual(1024)
    expect(out).toMatch(/\(\d+ more Threads omitted\)/)
  })

  it('rejects path without thread_id and fails loudly without the worktree service', async () => {
    const { ctx, project } = await seeded(['thread-a'])
    const pathOnly = await overview(ctx, project, { path: 'a.ts' })
    expect(pathOnly.isError).toBe(true)
    expect(text(pathOnly)).toContain('path needs thread_id')

    const bare = await setup()
    const missing = await overview(bare.ctx, bare.project)
    expect(missing.isError).toBe(true)
    expect(text(missing)).toContain('dsh-worktree-manager is not loaded')
  })
})

const RULE = 'merge order rule: Threads with commits, no overlapping Thread, and no predicted conflict with HEAD first; '
  + 'then the rest by fewest overlapping Threads, ties by creation order. Merge one, then call thread_diff again.'
