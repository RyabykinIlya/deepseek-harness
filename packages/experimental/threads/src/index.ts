/**
 * Threads domain plugin: the log-only Thread events plus the `threads`
 * projection a Project Session folds over its own log.
 *
 * Registration is optional by construction. The unit is installed through
 * `ctx.inject(['sessionProjections'], …)`, so a headless assembly without the
 * registry stays unaffected and unloading this plugin reads to clients as
 * capability absence rather than corruption.
 *
 * @module @deepseek-ai/dsh-experimental-threads
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace-changes'
import type { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-agent-preset-registry/types'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-subagent'
import type { WorktreeRecord, WorktreeService } from '@deepseek-ai/dsh-worktree-manager'
import { installThreadLifecycle } from './lifecycle.ts'
import { threadsProjectionDefinition } from './projection.ts'
import type { ThreadsProjectionState } from './projection.ts'
import { attachmentsOf, bounded, lastChangesSeq, presentedOf, threadsOf } from './library.ts'
import type { LoggedThread } from './library.ts'
import type {
  LibraryChangedFile, LibraryThreadChanges, ThreadArchiveOptions, ThreadId, ThreadStatusRow, ThreadsLibrary,
  ThreadsLibraryRequest,
} from './types.ts'

export type * from './types.ts'
export { ThreadId } from './types.ts'
export {
  applyThreadsEvent,
  emptyThreadsState,
  isThreadEvent,
  threadsProjectionDefinition,
  threadsProjectionView,
} from './projection.ts'
export type { ThreadEventType, ThreadState, ThreadsProjectionState } from './projection.ts'
export { threadNote } from './note.ts'
export { threadStopReason } from './lifecycle.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    threads: ThreadsService
  }
}

/** Plugin configuration. */
export interface Config {
  /** Subagent provider name whose children are Threads (default `thread`). */
  providerName: string
  /** Maximum UTF-8 size of the note recorded from a Thread's closing message (default 600). */
  noteMaxBytes: number
  /** How long `archive` waits for a running Thread to stop after interrupting it (default 30000). */
  archiveStopTimeoutMs: number
  /** Agent preset ids whose Sessions are Projects and may be read by `library` (default `['project']`). */
  projectPresets: string[]
  /** Maximum attachments listed by `library` (default 200). */
  libraryMaxAttachments: number
  /** Maximum presented files listed by `library` (default 200). */
  libraryMaxPresented: number
  /** Maximum newest Threads whose logs and worktrees `library` reads (default 50). */
  libraryMaxThreads: number
  /** Maximum changed files listed per Thread by `library` (default 100). */
  libraryMaxFiles: number
}

/** A Session's header and committed log, read from the live store or persistence. */
interface LoggedSession {
  readonly header: SessionHeader
  readonly events: readonly SessionEvent[]
}

/** `ctx.threads`: owner of the `threads` projection key, the Thread event writer, and Thread archival. */
export class ThreadsService extends TypertRemoteService {
  static Config: z<Config> = z.object({
    providerName: z.string().default('thread'),
    noteMaxBytes: z.number().step(1).min(16).max(65536).default(600),
    archiveStopTimeoutMs: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(30000),
    projectPresets: z.array(z.string()).default(['project']),
    libraryMaxAttachments: z.number().step(1).min(0).max(10_000).default(200),
    libraryMaxPresented: z.number().step(1).min(0).max(10_000).default(200),
    libraryMaxThreads: z.number().step(1).min(0).max(1000).default(50),
    libraryMaxFiles: z.number().step(1).min(0).max(10_000).default(100),
  })

  /**
   * The projection registry, present only while this plugin and the registry
   * are both loaded. Its absence is capability absence, never corruption.
   */
  private registry: SessionProjectionRegistry | undefined

  constructor(ctx: Context, private config: Config) {
    super(ctx, 'threads')
    ctx.inject(['sessionProjections'], (projectionCtx) => {
      projectionCtx.sessionProjections.register(threadsProjectionDefinition)
      this.registry = projectionCtx.sessionProjections
    })
    ctx.effect(() => () => { this.registry = undefined })
    installThreadLifecycle(ctx, {
      providerName: config.providerName,
      noteMaxBytes: config.noteMaxBytes,
      registry: () => this.registry,
    })
  }

  /**
   * Whether the `threads` projection key is currently installed.
   * @returns whether a host carrying this plugin can serve Thread projections.
   */
  get available(): boolean {
    return this.registry !== undefined
  }

  /**
   * Read one Session's durable Thread state after materializing the unit at the
   * Session cursor. The returned value is live; callers must not mutate it.
   * @param session - the Project Session whose Threads state is read.
   * @returns the folded state, or `undefined` when the registry is absent.
   */
  stateOf(session: Session): ThreadsProjectionState | undefined {
    return this.registry?.stateOf(session, 'threads')
  }

  /**
   * Read one Session's client-visible Thread rows at a single consistent cut.
   * @param session - the Project Session whose Thread rows are read.
   * @returns the status rows in durable creation order; empty when unavailable.
   */
  viewOf(session: Session): ThreadStatusRow[] {
    return this.registry?.snapshot(session, ['threads']).values.threads ?? []
  }

  /**
   * Live runtime liveness of one Thread: its Agent is registered and a driver
   * is active (a turn, or pre-step/close processing). Never persisted — the log
   * records outcomes, not liveness, so a Thread that died with its process reads
   * as not running after restart.
   * @param threadId - the Thread (its child Session id).
   * @returns whether the Thread's Agent is currently executing.
   */
  isRunning(threadId: ThreadId): boolean {
    return this.ctx.get('agents')?.get(SessionId(threadId))?.status === 'running'
  }

  /**
   * Archive a Thread: stop it if it runs, remove its worktree, and record
   * `thread/removed`. The branch and the Thread's session are kept.
   *
   * A dirty worktree without `force` is refused before anything is stopped or
   * recorded. A worktree removal that fails after the Thread was interrupted
   * leaves the row in place so the call can be repeated.
   * @param agent - the Project agent whose projection owns the Thread.
   * @param threadId - the Thread to archive.
   * @param options - `force` discards uncommitted work.
   * @throws {RemoteError} `threads/not-found`, `threads/worktree-dirty`, or `threads/stop-timeout`.
   * @throws {Error} when the worktree service is not loaded.
   */
  @Remote('archive')
  async archive(agent: Agent, threadId: ThreadId, options?: ThreadArchiveOptions): Promise<void> {
    const project = agent
    if (this.stateOf(project.session)?.threads.some(thread => thread.threadId === threadId) !== true) {
      throw new RemoteError('threads/not-found', `Unknown thread: ${threadId}`, { threadId })
    }
    const worktrees = this.ctx.get('worktrees')
    if (worktrees === undefined) throw new Error('threads: archiving a thread requires the worktrees service')
    const force = options?.force === true
    const record = await worktrees.get(threadId)
    const owned = record !== undefined && record.state === 'ready'
    const dirty = (): never => {
      throw new RemoteError('threads/worktree-dirty', `Thread ${threadId} has uncommitted changes`, { threadId })
    }
    if (owned && !force && !(await worktrees.status(record)).clean) dirty()
    if (this.isRunning(threadId)) await this.stop(project, threadId)
    if (owned) await this.removeWorktree(worktrees, record, force, dirty)
    project.session.append('thread/removed', { threadId }, { ignorable: true })
  }

  /**
   * Read a Project's Library: the attachments sent in its chat, the files it and
   * its Threads presented, and the files each Thread changed. Nothing is stored;
   * every call derives the result from the Session logs and live worktrees.
   * Thread sessions are read from the live store first and persistence second;
   * a Thread whose session is in neither contributes no presented files.
   * @param request - the Project Session to read.
   * @returns the three bounded sections, see {@link ThreadsLibrary}.
   * @throws {RemoteError} `threads/project-not-found` when the id is unknown or its preset is not a Project preset.
   */
  @Remote('library')
  async library(request: ThreadsLibraryRequest): Promise<ThreadsLibrary> {
    const { projectId } = request
    const project = await this.loadSession(projectId)
    if (project === undefined) {
      throw new RemoteError('threads/project-not-found', `Unknown project: ${projectId}`, { projectId, reason: 'unknown' })
    }
    const preset = this.projectPresetOf(projectId, project.header)
    if (preset === undefined || !this.config.projectPresets.includes(preset)) {
      throw new RemoteError('threads/project-not-found', `Session ${projectId} is not a project`, { projectId, reason: 'not-project' })
    }
    const threads = threadsOf(project.events)
    const considered = threads.slice(0, this.config.libraryMaxThreads)
    const presented = presentedOf(projectId, undefined, project.events)
    const changes: LibraryThreadChanges[] = []
    for (const thread of considered) {
      const session = await this.loadSession(SessionId(thread.threadId))
      if (session !== undefined) presented.push(...presentedOf(SessionId(thread.threadId), thread.threadId, session.events))
      const changed = thread.archived
        ? this.archivedChanges(thread, session)
        : await this.liveChanges(thread)
      if (changed !== undefined) changes.push(changed)
    }
    presented.sort((a, b) => b.time - a.time)
    return {
      attachments: bounded(attachmentsOf(project.events), this.config.libraryMaxAttachments),
      presented: bounded(presented, this.config.libraryMaxPresented),
      changes: { items: changes, total: threads.length, truncated: threads.length > considered.length },
    }
  }

  /**
   * The preset a Project Session currently runs.
   *
   * `SessionHeader.agentPreset` is a creation fact and stays frozen, while
   * `agentPresets.select` changes the mounted composition of a still-blank Session —
   * which is exactly how a New Project is composed. The `agentPreset` Session
   * projection is the effective value, so it wins whenever the registry is loaded;
   * the header answers only for a Session that is not live or whose projection
   * registry is absent.
   * @param id - the Session being classified.
   * @param header - its header, used when no live projection is available.
   * @returns the effective preset id, or undefined when the Session runs none.
   */
  private projectPresetOf(id: SessionId, header: SessionHeader): string | undefined {
    const live = this.ctx.get('sessions')?.get(id)
    const projected = live === undefined ? undefined : this.registry?.stateOf(live, 'agentPreset')
    return projected === undefined ? header.agentPreset : projected ?? undefined
  }

  private async loadSession(id: SessionId): Promise<LoggedSession | undefined> {
    const live = this.ctx.get('sessions')?.get(id)
    if (live !== undefined) {
      // oxlint-disable-next-line typescript/no-deprecated -- Deferred migration: whole-log read, no paged reader yet.
      return { header: live.header, events: live.snapshotEvents() }
    }
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined || await persistence.stat(id) === undefined) return undefined
    const handle = await persistence.open(id, 'read')
    try {
      const { events } = await handle.read()
      return { header: handle.header, events }
    } finally {
      await handle.close()
    }
  }

  private async liveChanges(thread: LoggedThread): Promise<LibraryThreadChanges | undefined> {
    const worktrees = this.ctx.get('worktrees')
    const record = await worktrees?.get(thread.threadId)
    if (worktrees === undefined || record === undefined || record.state !== 'ready') return undefined
    const bounds = { maxCommits: 0, maxFiles: this.config.libraryMaxFiles }
    const changes = await worktrees.changes(record, bounds).catch((error: unknown) => {
      // A worktree directory that vanished or a git failure leaves nothing to list; the rest of the Library is still served.
      this.ctx.logger('threads').warn(`library: cannot read changes of ${thread.threadId}: ${String(error)}`)
      return undefined
    })
    if (changes === undefined) return undefined
    const files: LibraryChangedFile[] = changes.files.map(file => ({
      path: file.path,
      ...file.added === undefined ? {} : { added: file.added },
      ...file.removed === undefined ? {} : { removed: file.removed },
      ...file.binary === true ? { binary: true as const } : {},
    }))
    return {
      threadId: thread.threadId, label: thread.label, source: 'live', worktree: record.path,
      ...record.branch === undefined ? {} : { branch: record.branch },
      files, filesTotal: changes.filesTotal, commitsTotal: changes.commitsTotal, uncommitted: changes.uncommitted,
    }
  }

  private archivedChanges(thread: LoggedThread, session: LoggedSession | undefined): LibraryThreadChanges | undefined {
    const seq = session === undefined ? undefined : lastChangesSeq(session.events)
    const summary = seq === undefined ? undefined : this.ctx.get('workspaceChanges')?.summary(SessionId(thread.threadId), seq)
    if (summary === undefined) return undefined
    const files = summary.files.slice(0, this.config.libraryMaxFiles).map((file): LibraryChangedFile => ({
      path: file.display,
      ...file.binary === true ? { binary: true as const } : { added: file.added, removed: file.deleted },
    }))
    return {
      threadId: thread.threadId, label: thread.label, source: 'archived',
      ...thread.branch === undefined ? {} : { branch: thread.branch },
      files, filesTotal: summary.total,
    }
  }

  private async removeWorktree(worktrees: WorktreeService, record: WorktreeRecord, force: boolean, dirty: () => never): Promise<void> {
    try {
      await worktrees.remove(record, { force })
    } catch (error) {
      if ((error as { code?: unknown }).code === 'REMOVE_DIRTY_WITHOUT_FORCE') dirty()
      throw error
    }
  }

  private async stop(project: Agent, threadId: ThreadId): Promise<void> {
    const subagents = this.ctx.get('subagents')
    if (subagents === undefined) throw new Error('threads: stopping a running thread requires the subagents service')
    subagents.interrupt(SessionId(threadId), { kind: 'user', parentSessionId: project.id })
    const deadline = Date.now() + this.config.archiveStopTimeoutMs
    while (this.isRunning(threadId)) {
      if (Date.now() >= deadline) {
        throw new RemoteError('threads/stop-timeout', `Thread ${threadId} did not stop in time`, { threadId })
      }
      await new Promise<void>((resolve) => { setTimeout(resolve, 20) })
    }
  }
}

export default ThreadsService
