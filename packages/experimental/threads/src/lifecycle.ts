/** Writes `thread/*` events into a Project Session from `subagent/start` and `subagent/end` of the Thread provider. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentRunEndInfo, SubagentRunInfo } from '@deepseek-ai/dsh-subagent'
import type { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-worktree-manager'
import { threadNote } from './note.ts'
import { ThreadId } from './types.ts'
import type { ThreadStopReason } from './types.ts'

/** Lifecycle settings resolved from the plugin config. */
export interface ThreadLifecycleOptions {
  /** Subagent provider name whose children are Threads. */
  readonly providerName: string
  /** Maximum UTF-8 size of a recorded note. */
  readonly noteMaxBytes: number
  /** The projection registry while installed; Thread events are only written when it is. */
  readonly registry: () => SessionProjectionRegistry | undefined
}

/** Facts remembered between a Thread's start and end edges. */
interface Live {
  readonly parent: Agent
  /** Settles when `thread/created` is in the Project log (or was skipped). */
  readonly created: Promise<void>
  /** Whether {@link created} has settled, so the end edge can append without yielding. */
  createdSettled: boolean
}

/**
 * Map a subagent stop reason to the Thread vocabulary.
 * @param reason - the stop reason the subagent runtime reported.
 * @returns the same reason for the known outcomes; `error` for a variant a backend merged in.
 */
export function threadStopReason(reason: SubagentRunEndInfo['stopReason']): ThreadStopReason {
  switch (reason) {
    case 'completed':
    case 'aborted':
    case 'error':
    case 'max-tokens':
    case 'refusal':
      return reason
    // SubagentStopReason is merge-extensible; an unnameable outcome is not success.
    default:
      return 'error'
  }
}

/**
 * Install the start/end listeners. Every listener is contained: a failure is
 * logged as a warning and never reaches the subagent runtime.
 * @param ctx - the owning plugin context; unloading it removes the listeners.
 * @param options - provider filter, note bound, and idempotency probe.
 */
export function installThreadLifecycle(ctx: Context, options: ThreadLifecycleOptions): void {
  const live = new Map<SessionId, Live>()
  let disposed = false
  ctx.effect(() => () => {
    disposed = true
    live.clear()
  }, 'threads.lifecycle()')

  const registered = (id: SessionId): Agent | undefined => ctx.get('agents')?.get(id)

  const warn = (what: string, error: unknown): void => {
    ctx.logger.warn(`threads: ${what}: ${error instanceof Error ? error.message : String(error)}`)
  }

  const announce = async (child: Agent, parent: Agent, threadId: ThreadId): Promise<void> => {
    const registry = options.registry()
    if (registry === undefined) return
    if (registry.stateOf(parent.session, 'threads')?.threads.some(thread => thread.threadId === threadId)) return
    // The child's own descriptor carries the creation label the provider froze.
    const label = registry.snapshot(child.session, ['subagent']).values.subagent?.label ?? threadId
    const record = await ctx.get('worktrees')?.get(threadId)
    // The Project may have unloaded or archived while the record was read.
    if (disposed || registered(parent.id) !== parent || registry.stateOf(parent.session, 'threads')?.threads.some(thread => thread.threadId === threadId) === true) return
    const cwd = child.session.header.cwd
    parent.session.append('thread/created', {
      threadId,
      label,
      ...cwd === undefined ? {} : { worktree: cwd },
      ...record?.branch === undefined ? {} : { branch: record.branch },
      ...record?.baseSha === undefined ? {} : { baseSha: record.baseSha },
    }, { ignorable: true })
  }

  ctx.on('subagent/start', (info: SubagentRunInfo) => {
    if (info.provider !== options.providerName) return
    try {
      const child = registered(info.id)
      const parentId = child?.session.header.parentSession
      const parent = parentId === undefined ? undefined : registered(parentId)
      if (child === undefined || parent === undefined) {
        ctx.logger.warn(`threads: thread ${info.id} started without a resolvable Project agent; no thread/created recorded`)
        return
      }
      const entry: Live = {
        parent,
        createdSettled: false,
        created: announce(child, parent, ThreadId(info.id))
          .catch((error: unknown) => { warn(`thread/created for ${info.id}`, error) })
          .finally(() => { entry.createdSettled = true }),
      }
      live.set(info.id, entry)
    } catch (error) {
      warn(`subagent/start for ${info.id}`, error)
    }
  })

  ctx.on('subagent/end', (info: SubagentRunEndInfo) => {
    if (info.provider !== options.providerName) return
    const entry = live.get(info.id)
    live.delete(info.id)
    if (entry === undefined) return
    const threadId = ThreadId(info.id)
    const note = info.lastAssistantMessage === undefined ? undefined : threadNote(info.lastAssistantMessage, options.noteMaxBytes)
    const settle = (): void => {
      if (disposed || registered(entry.parent.id) !== entry.parent) return
      entry.parent.session.append('thread/status', {
        threadId,
        stopReason: threadStopReason(info.stopReason),
        ...note === undefined ? {} : { note },
      }, { ignorable: true })
    }
    const report = (): Promise<void> => {
      try { settle() } catch (error) { warn(`thread/status for ${info.id}`, error) }
      return reportWorktree(entry.parent, threadId)
    }
    // Appending without yielding keeps the report ahead of parent teardown; only
    // a creation still reading the worktree record must be waited for.
    const done = entry.createdSettled ? report() : entry.created.then(report)
    done.catch((error: unknown) => { warn(`worktree status for ${info.id}`, error) })
  })

  const reportWorktree = async (parent: Agent, threadId: ThreadId): Promise<void> => {
    const worktrees = ctx.get('worktrees')
    if (worktrees === undefined) return
    const record = await worktrees.get(threadId)
    if (record === undefined || record.state !== 'ready') return
    const status = await worktrees.status(record)
    if (disposed || registered(parent.id) !== parent) return
    parent.session.append('thread/status', {
      threadId,
      commitsAhead: status.commitsAhead,
      uncommitted: status.changed,
    }, { ignorable: true })
  }
}
