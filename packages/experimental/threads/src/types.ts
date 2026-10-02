/** Threads domain vocabulary: durable Thread identity, the log-only events a Project records, and the client status row. */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Identifies one background Thread owned by a Project Session. */
export type ThreadId = Branded<'ThreadId'>

/**
 * Brand a validated Thread id.
 * @param id - Thread identity.
 * @returns the same string branded as a Thread identity.
 */
export function ThreadId(id: string): ThreadId {
  return id as ThreadId
}

/**
 * Terminal outcome of a Thread's last turn.
 *
 * The runtime folds the session-level `interrupted` stop reason into `aborted`
 * before it reaches this projection, so an interrupted-and-resumed Thread reads
 * as `aborted` here. A Thread that declined its task reads as `refusal`.
 */
export type ThreadStopReason = 'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal'

/**
 * One Thread status row published to clients through the `threads` Session
 * projection. Durable facts only: live "is a turn active" is computed from the
 * runtime (`ThreadsService.isRunning`) and is never part of the row.
 */
export interface ThreadStatusRow {
  /** Durable Thread identity. */
  readonly threadId: ThreadId
  /** The task this Thread was given at spawn; freely renameable, never identity. */
  readonly label: string
  /** Outcome of the last finished turn; absent before the first one finishes. */
  readonly stopReason?: ThreadStopReason
  /** `dsh/<thread-short>` branch, absent for a detached worktree. */
  readonly branch?: string
  /** Absolute path of the Thread's working directory. */
  readonly worktree?: string
  /** Commit the worktree was created at. */
  readonly baseSha?: string
  /** Commits on the worktree's HEAD since {@link baseSha}, as last reported at settlement. */
  readonly commitsAhead?: number
  /** Uncommitted entries in the worktree, as last reported at settlement. */
  readonly uncommitted?: number
  /** Bounded start of the Thread's closing message. */
  readonly note?: string
}

/** Options of the `threads.archive` Remote method. */
export interface ThreadArchiveOptions {
  /** Discard uncommitted work in the Thread's worktree instead of refusing. */
  readonly force?: boolean
}

/** Request of the `threads.library` Remote method. */
export interface ThreadsLibraryRequest {
  /** The Project Session whose library is read. */
  readonly projectId: SessionId
}

/** One bounded list of the Library: newest or first entries up to a configured bound, plus the complete count. */
export interface LibraryList<T> {
  /** Entries within the configured bound. */
  readonly items: readonly T[]
  /** Complete number of entries, including those not listed. */
  readonly total: number
  /** Whether `total` exceeds the entries listed. */
  readonly truncated: boolean
}

/** An image or file the user sent in the Project chat. */
export interface LibraryAttachment {
  /** `image` for a normalized raster image, `file` for a verbatim file. */
  readonly kind: 'image' | 'file'
  /** Opaque content-addressed attachment id; resolve it through the attachment service, never as a path. */
  readonly attachmentId: string
  /** Sanitized display name, when one was recorded. */
  readonly name?: string
  /** Verified media type; recorded for images only. */
  readonly mediaType?: string
  /** Exact byte length. */
  readonly bytes: number
  /** Sequence number of the carrying `user/message` event in the Project log. */
  readonly seq: number
  /** Event time in Unix epoch milliseconds. */
  readonly time: number
}

/** A file declared with `present` by the Project or by one of its Threads. */
export interface LibraryPresentedFile {
  /** Path as declared: absolute, or relative to the presenting Session's working directory. */
  readonly path: string
  /** Description supplied by the presenting model. */
  readonly description?: string
  /** The Session that presented the file; the Project itself or a Thread session. */
  readonly sessionId: SessionId
  /** Set when a Thread presented the file; absent for the Project. */
  readonly threadId?: ThreadId
  /** Sequence number of the `deliverables/presented` event in `sessionId`'s log. */
  readonly seq: number
  /** Index of the file in that event's `files`; with `sessionId` and `seq` it addresses the present-open route. */
  readonly index: number
  /** Event time in Unix epoch milliseconds. */
  readonly time: number
}

/** One file a Thread changed. */
export interface LibraryChangedFile {
  /** Repository-relative path for a live worktree; the summary path of the turn for an archived Thread. */
  readonly path: string
  /** Added line count; absent for binary files. */
  readonly added?: number
  /** Removed line count; absent for binary files. */
  readonly removed?: number
  /** True when the file is binary. */
  readonly binary?: true
}

/** Changed files of one Thread. */
export interface LibraryThreadChanges {
  /** The Thread. */
  readonly threadId: ThreadId
  /** Task label recorded at creation. */
  readonly label: string
  /** `live` when read from the Thread's worktree; `archived` when read from its last recorded change summary. */
  readonly source: 'live' | 'archived'
  /** `dsh/<thread-short>` branch of a live worktree. */
  readonly branch?: string
  /** Absolute worktree root of a live Thread; changed `path` values are relative to it. */
  readonly worktree?: string
  /** Changed files within the configured bound. */
  readonly files: readonly LibraryChangedFile[]
  /** Complete changed-file count, including files not listed. */
  readonly filesTotal: number
  /** Commits since the worktree base; live Threads only. */
  readonly commitsTotal?: number
  /** Uncommitted entries in the worktree; live Threads only. */
  readonly uncommitted?: number
}

/** Read model of a Project's Library: nothing stored, everything derived from logs and worktrees at call time. */
export interface ThreadsLibrary {
  /** Attachments sent in the Project chat, newest first. */
  readonly attachments: LibraryList<LibraryAttachment>
  /** Files presented by the Project and its Threads, newest first. */
  readonly presented: LibraryList<LibraryPresentedFile>
  /**
   * Changed files per Thread, newest Thread first. Only the newest `libraryMaxThreads` Threads are read;
   * `total` counts every Thread the Project created, and a read Thread without a live worktree or recorded summary is omitted from `items`.
   */
  readonly changes: LibraryList<LibraryThreadChanges>
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The id names no Session, or a Session that is not a Project. */
    'threads/project-not-found': { readonly projectId: SessionId; readonly reason: 'unknown' | 'not-project' }
    /** The Project's `threads` projection holds no Thread with that id. */
    'threads/not-found': { readonly threadId: ThreadId }
    /** The Thread's worktree has uncommitted work and `force` was not set; nothing was changed. */
    'threads/worktree-dirty': { readonly threadId: ThreadId }
    /** The running Thread did not stop within the configured wait; its worktree was left in place. */
    'threads/stop-timeout': { readonly threadId: ThreadId }
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /**
     * Threads owned by the projected Project Session, in durable creation
     * order. One row per Thread; a removed Thread leaves the array.
     */
    threads: ThreadStatusRow[]
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * A Thread came into existence. Carries the whole post-create row, so the
     * fold is trivially cheap and every served value self-describing. Appended
     * with `ignorable: true`: a build that does not know the type skips it.
     */
    'thread/created': { threadId: ThreadId; label: string; worktree?: string; branch?: string; baseSha?: string }
    /**
     * A durable status report for one Thread. Field-wise partial update: a
     * field absent from the event is left untouched, so a worktree-facts report
     * never erases a recorded outcome. Log-only and `ignorable: true`; it is
     * never joined into the model-visible surface.
     */
    'thread/status': {
      threadId: ThreadId
      stopReason?: ThreadStopReason
      note?: string
      commitsAhead?: number
      uncommitted?: number
    }
    /** A Thread was archived. The fold drops the row; branch and session are kept. */
    'thread/removed': { threadId: ThreadId }
  }
}
