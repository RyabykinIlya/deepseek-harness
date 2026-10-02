/**
 * Lifecycle edge suite: the contained start/end listeners driven directly
 * through `installThreadLifecycle`, so every arm a real agent-loop run cannot
 * stage deterministically — a Project that unloads mid-flight, an agent that
 * stops resolving, a worktree service that rejects, a Thread that owns no
 * worktree, and each `warn` containment path — is pinned here. The end-to-end
 * path stays in lifecycle.spec.ts.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Message } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { SubagentRunId } from '@deepseek-ai/dsh-subagent'
import type { SubagentRunEndInfo, SubagentRunInfo } from '@deepseek-ai/dsh-subagent'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type { WorktreeRecord, WorktreeState } from '@deepseek-ai/dsh-worktree-manager'
import { installThreadLifecycle, threadStopReason } from '../src/lifecycle.ts'
import { threadsProjectionDefinition } from '../src/projection.ts'
import { ThreadsService } from '../src/index.ts'
import type { Config } from '../src/index.ts'
import { ThreadId } from '../src/types.ts'

/**
 * `SubagentStopReasonMap` is the subagent seam's documented extension point: a
 * backend may merge in its own terminal outcome, and consumers are told to
 * branch on the known cases and fall through. This suite is that backend, so it
 * widens the table exactly the way one would — no assertion to `unknown`.
 */
declare module '../../../subagent/subagent/src/types.ts' {
  interface SubagentStopReasonMap {
    /** A backend whose lease expired before the child settled. */
    'backend-lease-expired': 'backend-lease-expired'
  }
}

const PROJECT = SessionId('project')
const CHILD = SessionId('child-1')
const GHOST = SessionId('ghost-1')

/** The full Threads config; `ctx.plugin` needs every field, not a partial override. */
const THREADS_CONFIG: Config = {
  providerName: 'thread',
  noteMaxBytes: 600,
  archiveStopTimeoutMs: 30_000,
  projectPresets: ['project'],
  libraryMaxAttachments: 200,
  libraryMaxPresented: 200,
  libraryMaxThreads: 50,
  libraryMaxFiles: 100,
}

/** A promise plus the handle that settles it, so an await point can be held open. */
interface Gate<T> {
  /** Settle the gate with this value. */
  open(value: T): void
  /** What a service method returns while the gate is still closed. */
  readonly promise: Promise<T>
}

function gate<T>(): Gate<T> {
  let open!: (value: T) => void
  const promise = new Promise<T>((resolve) => { open = resolve })
  return { open, promise }
}

/**
 * One live agent as the lifecycle reads it: identity, session, and liveness.
 */
interface BenchAgent {
  /** Identity the registry keys on. */
  id: SessionId
  /** Session the `thread/*` events are appended to. */
  session: Session
  /** Live liveness `ThreadsService.isRunning` reports. */
  status: 'idle' | 'running'
}

/** Programmable live-agent registry: drop an agent or fail the whole read. */
class FakeAgents {
  readonly live = new Map<SessionId, BenchAgent>()
  /** When set, every read throws — a registry that failed under the listener. */
  failure: Error | undefined

  register(id: SessionId, session: Session, status: 'idle' | 'running' = 'idle'): BenchAgent {
    const agent: BenchAgent = { id, session, status }
    this.live.set(id, agent)
    return agent
  }

  drop(id: SessionId): void {
    this.live.delete(id)
  }

  get(id: SessionId): BenchAgent | undefined {
    if (this.failure !== undefined) throw this.failure
    return this.live.get(id)
  }
}

/** Git-free worktree stand-in whose record, lifecycle state, and failures are programmable. */
class FakeWorktrees {
  readonly base: WorktreeRecord = {
    threadId: CHILD,
    path: '/wt/child-1',
    branch: 'dsh/child-1',
    baseRef: 'HEAD',
    baseSha: 'abc123',
    state: 'ready',
    repoRoot: '/repo',
  }
  /** Whether the Thread still owns a worktree record at all. */
  present = true
  /** State the record is served in. */
  state: WorktreeState = 'ready'
  statusResult = { clean: true, changed: 0, commitsAhead: 3 }
  /** Fails `get`; the listener must contain it rather than let it escape. */
  getFailure: unknown
  /** Fails `status`; the settlement report must contain it too. */
  statusFailure: unknown
  /** Held-closed `get`, so an await point inside the listener can be reached. */
  getGate: Gate<WorktreeRecord | undefined> | undefined
  /** Held-closed `status`, for the await between the status append and its report. */
  statusGate: Gate<{ clean: boolean; changed: number; commitsAhead: number }> | undefined
  /** Fails `remove` with this error when set. */
  removeFailure: unknown
  readonly removed: Array<{ threadId: string; force: boolean | undefined }> = []

  // Each failure throws rather than rejecting: a git CLI hands back a bare
  // string, and these arms must prove the containment path renders whatever it
  // was given rather than assuming an `Error`.
  get(threadId: string): Promise<WorktreeRecord | undefined> {
    if (this.getGate !== undefined) return this.getGate.promise
    if (this.getFailure !== undefined) throw this.getFailure
    return Promise.resolve(this.present ? { ...this.base, threadId, state: this.state } : undefined)
  }

  status(): Promise<{ clean: boolean; changed: number; commitsAhead: number }> {
    if (this.statusGate !== undefined) return this.statusGate.promise
    if (this.statusFailure !== undefined) throw this.statusFailure
    return Promise.resolve(this.statusResult)
  }

  remove(record: WorktreeRecord, options?: { force?: boolean }): Promise<void> {
    if (this.removeFailure !== undefined) throw this.removeFailure
    this.removed.push({ threadId: record.threadId, force: options?.force })
    return Promise.resolve()
  }
}

/**
 * Lifecycle edges are published on a scope carrier; a Project and its Threads
 * are root-scoped in every real assembly, and a root listener admits every
 * carrier. Driving the bus directly (rather than `ctx.emit`, whose receiver is
 * typed as the runtime's own scoped service) is what lets this suite stage
 * edges the real publisher will not produce.
 */
const RECEIVER = { edge: true }

/** Collect this context's warnings, which is how each containment arm is proven. */
function captureWarnings(ctx: Context): () => string[] {
  const warnings: string[] = []
  ctx.logger.exporter({
    // The default export threshold stops at `info`; a containment path is only
    // observable through its warning, so this bench listens at every level.
    levels: { default: 3 },
    export(message: Message): void {
      if (message.type === 'warn') warnings.push(String(message.args[0]))
    },
  })
  return () => warnings
}

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0).toReversed()) await ctx.fiber.dispose()
})

/** Every retained-agent double is read back through the accessor the plugin itself uses. */
function liveAgent(ctx: Context, id: SessionId): Agent {
  const agent = ctx.agents.get(id)
  if (agent === undefined) throw new Error(`bench: no live agent ${id}`)
  return agent
}

interface Bench {
  readonly ctx: Context
  readonly parent: Session
  readonly agents: FakeAgents
  readonly worktrees: FakeWorktrees
  readonly warnings: () => string[]
  /** The Project log's `thread/*` events. */
  threadEvents(): SessionEvent[]
}

/** Own the edge seam: a Project, a Thread, a controllable registry, worktrees, and the listeners. */
async function bench(options: {
  registry?: boolean
  worktrees?: boolean
  orphanChild?: boolean
} = {}): Promise<Bench> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  ctx.sessionProjections.register(threadsProjectionDefinition)
  const agents = new FakeAgents()
  ctx.provide('agents', agents as never)
  const worktrees = new FakeWorktrees()
  if (options.worktrees !== false) ctx.provide('worktrees', worktrees as never)
  const parent = ctx.sessions.create(PROJECT, { meta: { cwd: '/repo' } })
  const child = ctx.sessions.create(CHILD, {
    meta: { cwd: '/wt/child-1', ...options.orphanChild === true ? {} : { parentSession: PROJECT } },
  })
  agents.register(PROJECT, parent)
  agents.register(CHILD, child)
  const registry = ctx.sessionProjections
  const warnings = captureWarnings(ctx)
  installThreadLifecycle(ctx, {
    providerName: 'thread',
    noteMaxBytes: 600,
    registry: () => (options.registry === false ? undefined : registry),
  })
  contexts.push(ctx)
  return {
    ctx,
    parent,
    agents,
    worktrees,
    warnings,
    threadEvents: () => parent.ownEvents().filter(event => event.type.startsWith('thread/')),
  }
}

/** Publish one `subagent/start` edge for the Thread provider. */
function startEdge(ctx: Context, id: SessionId = CHILD, provider = 'thread'): void {
  const info: SubagentRunInfo = { runId: SubagentRunId(`run-${id}`), provider, id, local: true }
  ctx.events.emit(RECEIVER, 'subagent/start', info)
}

/**
 * Publish one `subagent/end` edge, defaulting to a completed run with a closing
 * message. `withoutClosingMessage` omits the key entirely rather than setting it
 * to `undefined`, which is what a run with no assistant turn actually reports
 * under `exactOptionalPropertyTypes`.
 * @param ctx - context owning the runtime receiver.
 * @param overrides - edge fields to replace; `id` is required.
 * @param options - set `withoutClosingMessage` to drop the closing message.
 */
function endEdge(
  ctx: Context,
  overrides: Partial<SubagentRunEndInfo> & { id: SessionId },
  options: { withoutClosingMessage?: boolean } = {},
): void {
  const info: SubagentRunEndInfo = {
    runId: SubagentRunId(`run-${overrides.id}`),
    provider: 'thread',
    local: true,
    stopReason: 'completed',
    ...options.withoutClosingMessage === true ? {} : { lastAssistantMessage: [{ type: 'text', text: 'shipped it' }] },
    ...overrides,
  }
  ctx.events.emit(RECEIVER, 'subagent/end', info)
}

describe('threadStopReason', () => {
  it('passes every known outcome through unchanged', () => {
    for (const known of ['completed', 'aborted', 'error', 'max-tokens', 'refusal'] as const) {
      expect(threadStopReason(known)).toBe(known)
    }
  })

  it('reads a backend-merged outcome this build does not name as an error, never success', () => {
    expect(threadStopReason('backend-lease-expired')).toBe('error')
  })
})

describe('installThreadLifecycle start edge', () => {
  it('records thread/created labelled with the Thread id when no subagent descriptor exists', async () => {
    const b = await bench()
    startEdge(b.ctx)
    await vi.waitFor(() => { expect(b.threadEvents()).toHaveLength(1) })
    expect(b.threadEvents()[0]).toMatchObject({
      type: 'thread/created',
      ignorable: true,
      data: { threadId: ThreadId(CHILD), label: ThreadId(CHILD), worktree: '/wt/child-1', branch: 'dsh/child-1', baseSha: 'abc123' },
    })
  })

  it('records nothing while the projection registry is absent but still settles the run', async () => {
    const b = await bench({ registry: false })
    startEdge(b.ctx)
    endEdge(b.ctx, { id: CHILD })
    await vi.waitFor(() => { expect(b.threadEvents()).toHaveLength(2) })
    expect(b.threadEvents().map(event => event.type)).toEqual(['thread/status', 'thread/status'])
    expect(b.warnings()).toEqual([])
  })

  it('warns and skips a start whose child agent does not resolve', async () => {
    const b = await bench()
    startEdge(b.ctx, GHOST)
    await vi.waitFor(() => { expect(b.warnings()).toHaveLength(1) })
    expect(b.warnings()[0]).toContain(`threads: thread ${GHOST} started without a resolvable Project agent`)
    expect(b.threadEvents()).toEqual([])
  })

  it('warns and skips a start whose Project agent does not resolve', async () => {
    const b = await bench({ orphanChild: true })
    startEdge(b.ctx)
    await vi.waitFor(() => { expect(b.warnings()).toHaveLength(1) })
    expect(b.warnings()[0]).toContain(`threads: thread ${CHILD} started without a resolvable Project agent`)
    expect(b.threadEvents()).toEqual([])
  })

  it('contains a worktree read that rejects instead of losing the start edge', async () => {
    const b = await bench()
    b.worktrees.getFailure = new Error('git exploded')
    startEdge(b.ctx)
    await vi.waitFor(() => { expect(b.warnings()).toHaveLength(1) })
    expect(b.warnings()[0]).toBe('threads: thread/created for child-1: git exploded')
  })

  it('contains an agent registry that throws while resolving the child', async () => {
    const b = await bench()
    b.agents.failure = new Error('registry offline')
    startEdge(b.ctx)
    expect(b.warnings()).toEqual(['threads: subagent/start for child-1: registry offline'])
    expect(b.threadEvents()).toEqual([])
  })

  it('ignores edges published by a provider this plugin does not own', async () => {
    const b = await bench()
    startEdge(b.ctx, CHILD, 'spawn')
    endEdge(b.ctx, { id: CHILD, provider: 'spawn' })
    expect(b.threadEvents()).toEqual([])
    expect(b.warnings()).toEqual([])
  })
})

describe('installThreadLifecycle create arm', () => {
  it('drops thread/created when the plugin is disposed while the worktree record is read', async () => {
    const b = await bench()
    const reading = gate<WorktreeRecord | undefined>()
    b.worktrees.getGate = reading
    startEdge(b.ctx)
    contexts.splice(contexts.indexOf(b.ctx), 1)
    await b.ctx.fiber.dispose()
    reading.open(b.worktrees.base)
    await vi.waitFor(() => { expect(b.threadEvents()).toEqual([]) })
  })

  it('drops thread/created when the Project agent stops resolving mid-read', async () => {
    const b = await bench()
    const reading = gate<WorktreeRecord | undefined>()
    b.worktrees.getGate = reading
    startEdge(b.ctx)
    b.agents.drop(PROJECT)
    reading.open(b.worktrees.base)
    await vi.waitFor(() => { expect(b.threadEvents()).toEqual([]) })
  })

  it('drops thread/created when the Project log gained the Thread while the record was read', async () => {
    const b = await bench()
    const reading = gate<WorktreeRecord | undefined>()
    b.worktrees.getGate = reading
    startEdge(b.ctx)
    b.parent.append('thread/created', { threadId: ThreadId(CHILD), label: 'recorded elsewhere' })
    reading.open(b.worktrees.base)
    await vi.waitFor(() => { expect(b.threadEvents()).toHaveLength(1) })
    expect(b.threadEvents()[0]?.data).toMatchObject({ label: 'recorded elsewhere' })
  })
})

describe('installThreadLifecycle end edge', () => {
  it('ignores an end edge with no remembered start', async () => {
    const b = await bench()
    endEdge(b.ctx, { id: CHILD })
    expect(b.threadEvents()).toEqual([])
  })

  it('records a status without a note when the run produced no closing message', async () => {
    const b = await bench()
    startEdge(b.ctx)
    await vi.waitFor(() => { expect(b.threadEvents()).toHaveLength(1) })
    endEdge(b.ctx, { id: CHILD }, { withoutClosingMessage: true })
    await vi.waitFor(() => { expect(b.threadEvents()).toHaveLength(2) })
    expect(b.threadEvents()[1]?.data).toEqual({ threadId: ThreadId(CHILD), stopReason: 'completed' })
  })

  it('drops the status when the Project agent stopped resolving before the end edge', async () => {
    const b = await bench()
    startEdge(b.ctx)
    await vi.waitFor(() => { expect(b.threadEvents()).toHaveLength(1) })
    b.agents.drop(PROJECT)
    endEdge(b.ctx, { id: CHILD })
    await vi.waitFor(() => { expect(b.warnings()).toEqual([]) })
    expect(b.threadEvents()).toHaveLength(1)
  })

  it('settles an end edge that arrived before thread/created finished reading', async () => {
    const b = await bench()
    const reading = gate<WorktreeRecord | undefined>()
    b.worktrees.getGate = reading
    startEdge(b.ctx)
    endEdge(b.ctx, { id: CHILD })
    // The report must stay behind the creation still reading the record.
    expect(b.threadEvents()).toEqual([])
    reading.open(b.worktrees.base)
    await vi.waitFor(() => {
      expect(b.threadEvents().map(event => event.type)).toEqual(['thread/created', 'thread/status', 'thread/status'])
    })
  })

  it('contains a rejected Project append instead of losing the worktree report', async () => {
    const b = await bench()
    startEdge(b.ctx)
    await vi.waitFor(() => { expect(b.threadEvents()).toHaveLength(1) })
    vi.spyOn(b.parent, 'append').mockImplementation(() => { throw new Error('log sealed') })
    endEdge(b.ctx, { id: CHILD })
    await vi.waitFor(() => { expect(b.warnings()).toHaveLength(2) })
    expect(b.warnings()).toEqual([
      'threads: thread/status for child-1: log sealed',
      'threads: worktree status for child-1: log sealed',
    ])
  })

  it('renders a non-Error worktree rejection instead of dropping the report', async () => {
    const b = await bench()
    startEdge(b.ctx)
    await vi.waitFor(() => { expect(b.threadEvents()).toHaveLength(1) })
    // A bare string is how a git CLI rejection arrives; containment must still
    // render it rather than logging `[object Object]`-shaped noise.
    b.worktrees.statusFailure = 'git gone'
    endEdge(b.ctx, { id: CHILD })
    await vi.waitFor(() => { expect(b.warnings()).toHaveLength(1) })
    expect(b.warnings()[0]).toBe('threads: worktree status for child-1: git gone')
  })

  it('records no worktree facts for a Thread whose worktree is not ready', async () => {
    const b = await bench()
    b.worktrees.state = 'removing'
    startEdge(b.ctx)
    endEdge(b.ctx, { id: CHILD })
    await vi.waitFor(() => {
      expect(b.threadEvents().map(event => event.type)).toEqual(['thread/created', 'thread/status'])
    })
    expect(b.threadEvents()[1]?.data).toEqual({ threadId: ThreadId(CHILD), stopReason: 'completed', note: 'shipped it' })
  })

  it('records no worktree facts for a Thread that owns no worktree at all', async () => {
    const b = await bench()
    b.worktrees.present = false
    startEdge(b.ctx)
    endEdge(b.ctx, { id: CHILD })
    await vi.waitFor(() => {
      expect(b.threadEvents().map(event => event.type)).toEqual(['thread/created', 'thread/status'])
    })
  })

  it('drops the worktree facts when the Project agent stops resolving before the report', async () => {
    const b = await bench()
    startEdge(b.ctx)
    await vi.waitFor(() => { expect(b.threadEvents()).toHaveLength(1) })
    const reporting = gate<{ clean: boolean; changed: number; commitsAhead: number }>()
    b.worktrees.statusGate = reporting
    endEdge(b.ctx, { id: CHILD })
    b.agents.drop(PROJECT)
    reporting.open({ clean: false, changed: 1, commitsAhead: 5 })
    await vi.waitFor(() => { expect(b.threadEvents()).toHaveLength(2) })
    expect(b.threadEvents()[1]?.data).toEqual({ threadId: ThreadId(CHILD), stopReason: 'completed', note: 'shipped it' })
  })
})

describe('ThreadsService.archive containment', () => {
  interface ArchiveBench {
    readonly ctx: Context
    readonly threads: ThreadsService
    readonly worktrees: FakeWorktrees
    /** The Project Session whose `thread/created` seeded the projection. */
    readonly project: Session
  }

  /** A Project whose projection owns one Thread, with no subagents service unless asked for. */
  async function archiveBench(options: {
    ownsWorktree?: boolean
    subagents?: boolean
    running?: boolean
    stopTimeoutMs?: number
  } = {}): Promise<ArchiveBench> {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const agents = new FakeAgents()
    ctx.provide('agents', agents as never)
    const worktrees = new FakeWorktrees()
    worktrees.present = options.ownsWorktree ?? true
    ctx.provide('worktrees', worktrees as never)
    if (options.subagents === true) ctx.provide('subagents', { interrupt: (): void => {} } as never)
    const threads = await ctx.plugin(ThreadsService, {
      ...THREADS_CONFIG,
      ...options.stopTimeoutMs === undefined ? {} : { archiveStopTimeoutMs: options.stopTimeoutMs },
    })
    if (threads === undefined) throw new Error('bench: the Threads service did not mount')
    const project = ctx.sessions.create(PROJECT, { meta: { cwd: '/repo' } })
    agents.register(PROJECT, project)
    if (options.running === true) agents.register(CHILD, ctx.sessions.create(CHILD), 'running')
    project.append('thread/created', { threadId: ThreadId(CHILD), label: 'port auth' })
    contexts.push(ctx)
    return { ctx, threads: ctx.threads, worktrees, project }
  }

  it('removes nothing and still records thread/removed when the Thread owns no worktree', async () => {
    const b = await archiveBench({ ownsWorktree: false })
    await b.threads.archive(liveAgent(b.ctx, PROJECT), ThreadId(CHILD))
    expect(b.worktrees.removed).toEqual([])
    expect(b.ctx.threads.viewOf(b.project)).toEqual([])
  })

  it('rethrows a worktree removal failure that is not a dirty-tree refusal', async () => {
    const b = await archiveBench()
    b.worktrees.removeFailure = new Error('device busy')
    const failure = await b.threads.archive(liveAgent(b.ctx, PROJECT), ThreadId(CHILD)).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect(failure).toHaveProperty('message', 'device busy')
    expect(b.ctx.threads.viewOf(b.project)).toHaveLength(1)
  })

  it('fails loud when a running Thread must be stopped and no subagents service is loaded', async () => {
    const b = await archiveBench({ running: true })
    await expect(b.threads.archive(liveAgent(b.ctx, PROJECT), ThreadId(CHILD))).rejects.toThrow(/subagents service/)
    expect(b.worktrees.removed).toEqual([])
  })

  it('leaves the Thread in place when it does not stop within the configured bound', async () => {
    const b = await archiveBench({ running: true, subagents: true, stopTimeoutMs: 0 })
    const failure = await b.threads.archive(liveAgent(b.ctx, PROJECT), ThreadId(CHILD)).catch((error: unknown) => error)
    expect(remoteErrorOf(failure)).toMatchObject({ code: 'threads/stop-timeout', details: { threadId: ThreadId(CHILD) } })
    expect(b.worktrees.removed).toEqual([])
    expect(b.ctx.threads.viewOf(b.project)).toHaveLength(1)
  })
})
