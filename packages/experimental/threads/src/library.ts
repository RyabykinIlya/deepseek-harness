/** Pure derivations of the Library read model from Session logs. */

import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tool-present/types'
import type {} from '@deepseek-ai/dsh-workspace-changes/types'
import type {
  LibraryAttachment, LibraryList, LibraryPresentedFile, ThreadId,
} from './types.ts'
import { ThreadId as toThreadId } from './types.ts'

/** One Thread as reconstructed from the Project's own `thread/*` events. */
export interface LoggedThread {
  /** Durable Thread identity. */
  readonly threadId: ThreadId
  /** Label of the latest `thread/created` for this Thread. */
  readonly label: string
  /** Branch recorded at creation. */
  readonly branch?: string
  /** Whether a `thread/removed` followed the latest creation. */
  readonly archived: boolean
}

/**
 * Bound a list, keeping the leading entries.
 * @param entries - complete list, already in the order that matters.
 * @param max - maximum number of entries kept.
 * @returns the bounded list with its complete count.
 */
export function bounded<T>(entries: readonly T[], max: number): LibraryList<T> {
  return { items: entries.slice(0, max), total: entries.length, truncated: entries.length > max }
}

/**
 * List the attachments of `user/message` events.
 * @param events - a Session's committed log.
 * @returns attachments newest first.
 */
export function attachmentsOf(events: readonly SessionEvent[]): LibraryAttachment[] {
  const found: LibraryAttachment[] = []
  for (const event of events) {
    if (event.type !== 'user/message') continue
    for (const block of event.data.content) {
      if (block.type === 'image') {
        const { attachmentId, name, mediaType, bytes } = block.attachment
        found.push({
          kind: 'image', attachmentId, mediaType, bytes, seq: event.seq, time: event.time,
          ...name === undefined ? {} : { name },
        })
      } else if (block.type === 'file') {
        const { attachmentId, name, bytes } = block.attachment
        found.push({ kind: 'file', attachmentId, name, bytes, seq: event.seq, time: event.time })
      }
    }
  }
  return found.reverse()
}

/**
 * List the files declared by `deliverables/presented` events.
 * @param sessionId - the Session owning the log.
 * @param threadId - the Thread the Session is, absent for the Project.
 * @param events - the Session's committed log.
 * @returns declared files in log order.
 */
export function presentedOf(sessionId: SessionId, threadId: ThreadId | undefined, events: readonly SessionEvent[]): LibraryPresentedFile[] {
  const found: LibraryPresentedFile[] = []
  for (const event of events) {
    if (event.type !== 'deliverables/presented') continue
    event.data.files.forEach((file, index) => {
      found.push({
        path: file.path, sessionId, seq: event.seq, index, time: event.time,
        ...file.description === undefined ? {} : { description: file.description },
        ...threadId === undefined ? {} : { threadId },
      })
    })
  }
  return found
}

/**
 * Reconstruct the Threads a Project ever created from its own log.
 * @param events - the Project's committed log.
 * @returns Threads newest first, archived ones included.
 */
export function threadsOf(events: readonly SessionEvent[]): LoggedThread[] {
  const threads = new Map<string, LoggedThread>()
  for (const event of events) {
    if (event.type === 'thread/created') {
      const { threadId, label, branch } = event.data
      threads.set(threadId, { threadId: toThreadId(threadId), label, archived: false, ...branch === undefined ? {} : { branch } })
    } else if (event.type === 'thread/removed') {
      const known = threads.get(event.data.threadId)
      if (known !== undefined) threads.set(known.threadId, { ...known, archived: true })
    }
  }
  return [...threads.values()].reverse()
}

/**
 * Find the newest `workspace/changes` event of a log.
 * @param events - a Session's committed log.
 * @returns its sequence number, or `undefined` when the log has none.
 */
export function lastChangesSeq(events: readonly SessionEvent[]): number | undefined {
  return events.findLast(event => event.type === 'workspace/changes')?.seq
}
