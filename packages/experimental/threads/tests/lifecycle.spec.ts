/**
 * Thread lifecycle suite: the real continuable-subagent path (provider `thread`
 * backed by the in-process spawn driver) fires `subagent/start` and
 * `subagent/end`, and the Threads plugin turns them into `thread/*` events in
 * the Project log. Only the worktree service is a fake, because it needs git.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentRunEndInfo } from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { ThreadId, ThreadsService, threadNote } from '../src/index.ts'
import { TestSessionQuery } from '../../../subagent/subagent/tests/test-session-query.ts'

const SIGNAL = new AbortController().signal
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup()
})

/** Stand-in for the git-backed worktree service. */
class FakeWorktrees {
  clean = true
  readonly removed: Array<{ threadId: string; force: boolean | undefined }> = []
  get(threadId: string): Promise<unknown> {
    return Promise.resolve({
      threadId,
      path: `/wt/${threadId}`,
      branch: `dsh/${threadId}`,
      baseRef: 'HEAD',
      baseSha: 'abc123',
      state: 'ready',
      repoRoot: '/repo',
    })
  }
  status(): Promise<{ clean: boolean; changed: number; commitsAhead: number }> {
    return Promise.resolve({ clean: this.clean, changed: this.clean ? 0 : 2, commitsAhead: 3 })
  }
  remove(record: { threadId: string }, opts?: { force?: boolean }): Promise<void> {
    this.removed.push({ threadId: record.threadId, force: opts?.force })
    return Promise.resolve()
  }
}

/**
 * Model script where Thread turns answer from `replies` in order and the
 * Project's reaction to each settlement notice is a fixed acknowledgement, so
 * the two agents can share one adapter without racing for entries.
 */
function threadScript(...replies: string[]): ConstructorParameters<typeof MockAdapter>[0] {
  const queue = [...replies]
  return Array.from({ length: replies.length * 3 + 4 }, () => (options: GenerateOptions) => {
    const last = JSON.stringify(options.messages.at(-1))
    return textResponse(last.includes('subagent-settled') ? 'ack' : queue.shift() ?? 'exhausted')
  })
}

interface Harness {
  readonly ctx: Context
  readonly project: Agent
  readonly worktrees: FakeWorktrees
  readonly threads: Fiber
  readonly adapter: MockAdapter
  /** Events of the Project's own log whose type starts with `thread/`. */
  threadEvents(): SessionEvent[]
}

async function harness(
  script: ConstructorParameters<typeof MockAdapter>[0],
  options: { config?: { noteMaxBytes?: number }; worktrees?: boolean } = {},
): Promise<Harness> {
  const ctx = new Context()
  const root = mkdtempSync(join(tmpdir(), 'dsh-threads-lifecycle-'))
  await mountAgentLoopTestDependencies(ctx)
  const persistence = await ctx.plugin(JsonlSessionPersistence, { root })
  cleanups.push(async () => {
    await ctx.fiber.dispose()
    await persistence.dispose()
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  if (ctx.get('sessionProjections') === undefined) await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'thread' })
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  const worktrees = new FakeWorktrees()
  if (options.worktrees !== false) ctx.provide('worktrees', worktrees as never)
  const threads = await ctx.plugin(ThreadsService, {
    providerName: 'thread', noteMaxBytes: 600, archiveStopTimeoutMs: 30_000, projectPresets: ['project'],
    libraryMaxAttachments: 200, libraryMaxPresented: 200, libraryMaxThreads: 50, libraryMaxFiles: 100,
    ...options.config,
  })
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const project = await ctx.agentLoop.create(SessionId('project'), { provider: 'mock', model: 'mock' })
  return {
    ctx,
    project,
    worktrees,
    threads,
    adapter,
    threadEvents: () => project.session.ownEvents().filter(event => event.type.startsWith('thread/')),
  }
}

function startThread(h: Harness, provider = 'thread', label = 'port auth') {
  return h.ctx.subagents.startContinuable({
    provider,
    label,
    request: { prompt: [{ type: 'text', text: 'do it' }], parent: h.project },
    signal: SIGNAL,
  })
}

/** Resume a settled Thread with a follow-up prompt, which starts a new residency epoch. */
function promptThread(h: Harness, childId: SessionId, text: string) {
  return h.ctx.subagents.prompt({
    requestId: `request-${text}` as never,
    parentSessionId: h.project.id,
    childSessionId: childId,
    mode: 'continuable',
    delivery: 'queue',
    content: [{ type: 'text', text }],
  }, SIGNAL)
}

function statuses(h: Harness) {
  return h.threadEvents().flatMap(event => event.type === 'thread/status' ? [event.data] : [])
}

describe('Thread lifecycle emitter', () => {
  it('records created and status events with ignorable envelopes and a projection row', async () => {
    const h = await harness(threadScript('All   done.\n\nMerged the branch.'))
    const cwds: Array<string | undefined> = []
    h.ctx.on('subagent/start', (info) => { cwds.push(h.ctx.agents.get(info.id)?.session.header.cwd) })
    const started = await startThread(h)
    await vi.waitFor(() => { expect(statuses(h).some(s => s.commitsAhead === 3)).toBe(true) })

    const events = h.threadEvents()
    expect(events.map(event => event.type)).toEqual(['thread/created', 'thread/status', 'thread/status'])
    expect(events.every(event => event.ignorable === true)).toBe(true)
    expect(events[0]?.data).toEqual({
      threadId: started.childId,
      label: 'port auth',
      branch: `dsh/${started.childId}`,
      baseSha: 'abc123',
      ...cwds[0] === undefined ? {} : { worktree: cwds[0] },
    })
    expect(events[1]?.data).toEqual({ threadId: started.childId, stopReason: 'completed', note: 'All done. Merged the branch.' })
    expect(events[2]?.data).toEqual({ threadId: started.childId, commitsAhead: 3, uncommitted: 0 })
    expect(h.ctx.threads.viewOf(h.project.session)).toEqual([expect.objectContaining({
      threadId: started.childId,
      label: 'port auth',
      stopReason: 'completed',
      commitsAhead: 3,
      uncommitted: 0,
    })])
  })

  it('ignores children of other providers', async () => {
    const h = await harness(threadScript('done'))
    const ends: SubagentRunEndInfo[] = []
    h.ctx.on('subagent/end', (info) => { ends.push(info) })
    await startThread(h, 'spawn')
    await vi.waitFor(() => { expect(ends).toHaveLength(1) })
    expect(h.threadEvents()).toEqual([])
  })

  it('bounds the recorded note by the configured byte limit', async () => {
    const h = await harness(threadScript('ééééééééééééééééééééééé'), { config: { noteMaxBytes: 16 } })
    await startThread(h)
    await vi.waitFor(() => { expect(statuses(h)).not.toHaveLength(0) })
    const note = statuses(h)[0]?.note
    expect(note).toBe('éééééé…')
    expect(new TextEncoder().encode(note).length).toBeLessThanOrEqual(16)
  })

  it('does not repeat thread/created when a settled Thread resumes', async () => {
    const h = await harness(threadScript('first', 'second'))
    const started = await startThread(h)
    await vi.waitFor(() => { expect(statuses(h).filter(s => s.stopReason !== undefined)).toHaveLength(1) })
    await vi.waitFor(() => { expect(h.ctx.agents.get(started.childId)).toBeUndefined() })
    await promptThread(h, started.childId, 'again')
    await vi.waitFor(() => { expect(statuses(h).filter(s => s.stopReason !== undefined)).toHaveLength(2) })

    expect(h.threadEvents().filter(event => event.type === 'thread/created')).toHaveLength(1)
    expect(statuses(h).filter(s => s.stopReason !== undefined).map(s => s.note)).toEqual(['first', 'second'])
  })

  it('stops writing events once the plugin is disposed', async () => {
    const h = await harness(threadScript('first', 'second'))
    const started = await startThread(h)
    await vi.waitFor(() => { expect(statuses(h).filter(s => s.stopReason !== undefined)).toHaveLength(1) })
    await vi.waitFor(() => { expect(h.ctx.agents.get(started.childId)).toBeUndefined() })
    const before = h.threadEvents().length
    await h.threads.dispose()
    const ends: SubagentRunEndInfo[] = []
    h.ctx.on('subagent/end', (info) => { ends.push(info) })
    await promptThread(h, started.childId, 'again')
    await vi.waitFor(() => { expect(ends).toHaveLength(1) })
    expect(h.threadEvents()).toHaveLength(before)
  })

  it('works without the worktree service, omitting branch facts', async () => {
    const h = await harness(threadScript('done'), { worktrees: false })
    await startThread(h)
    await vi.waitFor(() => { expect(statuses(h)).toHaveLength(1) })
    const created = h.threadEvents()[0]
    expect(created?.data).not.toHaveProperty('branch')
    expect(created?.data).not.toHaveProperty('baseSha')
  })

  it('reports liveness from the runtime and never from the log', async () => {
    const h = await harness(['hang'])
    const started = await startThread(h)
    const id = ThreadId(started.childId)
    await vi.waitFor(() => { expect(h.ctx.threads.isRunning(id)).toBe(true) })
    expect(h.threadEvents().some(event => JSON.stringify(event.data).includes('running'))).toBe(false)
    expect(h.ctx.threads.isRunning(ThreadId('missing'))).toBe(false)
  })
})

describe('threadNote', () => {
  it('keeps text at exactly the limit and cuts one byte over', () => {
    const text = [{ type: 'text' as const, text: 'a'.repeat(10) }]
    expect(threadNote(text, 10)).toBe('a'.repeat(10))
    expect(threadNote(text, 9)).toBe(`${'a'.repeat(6)}…`)
  })

  it('never splits a multibyte character', () => {
    expect(threadNote([{ type: 'text', text: '日本語日本語' }], 10)).toBe('日本…')
    expect(threadNote([{ type: 'text', text: '😀😀😀😀' }], 11)).toBe('😀😀…')
  })

  it('returns nothing for a message without text', () => {
    expect(threadNote([], 600)).toBeUndefined()
    expect(threadNote([{ type: 'text', text: ' \n ' }], 600)).toBeUndefined()
  })

  it('reads text blocks only, never a non-text block that carries text', () => {
    // A reasoning block is model-private: its text must not leak into the note.
    expect(threadNote([{ type: 'reasoning', text: 'private chain of thought' }], 600)).toBeUndefined()
    expect(threadNote([{ type: 'reasoning', text: 'private' }, { type: 'text', text: 'public' }], 600)).toBe('public')
  })

  it('drops an over-long message whose byte limit cannot even hold the ellipsis', () => {
    // 3 bytes of message against a 2-byte bound: the ellipsis alone does not fit.
    expect(threadNote([{ type: 'text', text: 'abc' }], 2)).toBeUndefined()
    // The smallest bound that still admits the marker truncates normally.
    expect(threadNote([{ type: 'text', text: 'abcde' }], 4)).toBe('a…')
  })
})

describe('ThreadsService.archive', () => {
  async function archived(script: ConstructorParameters<typeof MockAdapter>[0] = threadScript('done')) {
    const h = await harness(script)
    const started = await startThread(h)
    await vi.waitFor(() => { expect(statuses(h).some(s => s.commitsAhead === 3)).toBe(true) })
    return { h, id: ThreadId(started.childId) }
  }

  it('removes the worktree and records thread/removed', async () => {
    const { h, id } = await archived()
    await h.ctx.threads.archive(h.project, id)
    expect(h.worktrees.removed).toEqual([{ threadId: id, force: false }])
    const removed = h.threadEvents().at(-1)
    expect(removed).toMatchObject({ type: 'thread/removed', data: { threadId: id }, ignorable: true })
    expect(h.ctx.threads.viewOf(h.project.session)).toEqual([])
  })

  it('refuses a dirty worktree without force and changes nothing', async () => {
    const { h, id } = await archived()
    h.worktrees.clean = false
    const before = h.threadEvents().length
    const failure = await h.ctx.threads.archive(h.project, id).catch((error: unknown) => error)
    expect(remoteErrorOf(failure)).toMatchObject({ code: 'threads/worktree-dirty', details: { threadId: id } })
    expect(h.worktrees.removed).toEqual([])
    expect(h.threadEvents()).toHaveLength(before)

    await h.ctx.threads.archive(h.project, id, { force: true })
    expect(h.worktrees.removed).toEqual([{ threadId: id, force: true }])
  })

  it('maps the worktree service refusal of a dirty tree to the same remote error', async () => {
    const { h, id } = await archived()
    h.worktrees.remove = () => Promise.reject(Object.assign(new Error('dirty'), { code: 'REMOVE_DIRTY_WITHOUT_FORCE' }))
    const failure = await h.ctx.threads.archive(h.project, id).catch((error: unknown) => error)
    expect(remoteErrorOf(failure)).toMatchObject({ code: 'threads/worktree-dirty' })
    expect(h.threadEvents().at(-1)?.type).toBe('thread/status')
  })

  it('rejects a Thread outside the Project projection', async () => {
    const { h } = await archived()
    const failure = await h.ctx.threads.archive(h.project, ThreadId('ghost')).catch((error: unknown) => error)
    expect(remoteErrorOf(failure)).toMatchObject({ code: 'threads/not-found', details: { threadId: 'ghost' } })
    expect(h.worktrees.removed).toEqual([])
  })

  it('fails loud when the worktree service is absent', async () => {
    const h = await harness(threadScript('done'), { worktrees: false })
    const started = await startThread(h)
    await vi.waitFor(() => { expect(statuses(h)).toHaveLength(1) })
    await expect(h.ctx.threads.archive(h.project, ThreadId(started.childId))).rejects.toThrow(/worktrees service/)
    expect(h.threadEvents().at(-1)?.type).toBe('thread/status')
  })

  it('interrupts a running Thread, waits for it to stop, then removes the worktree', async () => {
    const h = await harness(['hang'])
    const started = await startThread(h)
    const id = ThreadId(started.childId)
    await vi.waitFor(() => { expect(h.ctx.threads.isRunning(id)).toBe(true) })
    await h.ctx.threads.archive(h.project, id)
    expect(h.ctx.threads.isRunning(id)).toBe(false)
    expect(h.worktrees.removed).toEqual([{ threadId: id, force: false }])
    expect(h.threadEvents().at(-1)?.type).toBe('thread/removed')
  })
})
