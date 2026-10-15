/**
 * Shared feedback state of every Thread action.
 *
 * One notice and one pending dirty-worktree confirmation at a time, held in a
 * store that belongs to the plugin rather than to any Thread row. Archiving a
 * Thread drops its row from the `threads` projection, which unmounts the row,
 * the roster menu, and the header seat that requested the action, so feedback
 * raised by a row must live somewhere that outlives all three. The row
 * registrations receive the write callbacks; the frame-wide `'shell.overlay'`
 * entry reads the store through its bound hook and renders the Toast and the
 * confirmation.
 */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ThreadId } from '@deepseek-ai/dsh-experimental-threads/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** One transient notice raised by a Thread action. */
export interface ThreadsFeedbackToast {
  /** Remount key: a repeated notice restarts the Toast's hold. */
  readonly seq: number
  /** Fully localized notice text. */
  readonly text: string
  /** Success renders the check glyph; anything else is a warning. */
  readonly tone: 'success' | 'warning'
}

/** The archive a dirty worktree is holding for confirmation. */
export interface ThreadsDirtyArchive {
  /** The Project Session that owns the Thread. */
  readonly parentSessionId: SessionId
  /** The Thread the confirmation names. */
  readonly threadId: ThreadId
  /** Display label of the Thread, already resolved (empty label falls back to the identity). */
  readonly label: string
}

/** Feedback state: one notice and one pending confirmation. */
export interface ThreadsFeedbackState {
  /** The notice on display, absent while none is raised. */
  readonly toast: ThreadsFeedbackToast | null
  /** The dirty-worktree archive waiting on confirmation, absent while none is pending. */
  readonly dirty: ThreadsDirtyArchive | null
}

/** The notices and confirmation requests Thread actions publish. */
export interface ThreadsFeedbackWrites {
  /** Raise a notice, replacing whatever is on display. */
  readonly notify: (text: string, tone: 'success' | 'warning') => void
  /** Ask the user to confirm archiving a dirty worktree. */
  readonly requestDirtyArchive: (request: ThreadsDirtyArchive) => void
}

/** The feedback store plus the callbacks every registration reaches it through. */
export interface ThreadsFeedbackHandle {
  /** Bare observable the overlay's `hooks` compartment binds to a selector hook. */
  readonly source: SnapshotStore<ThreadsFeedbackState>
  /** The writes every Thread action registration receives. */
  readonly writes: ThreadsFeedbackWrites
  /** Withdraw the notice on display (Toast completion or dismissal). */
  readonly dismissToast: () => void
  /** Close the dirty-worktree confirmation, on cancel or on confirm. */
  readonly settleDirtyArchive: () => void
}

/**
 * Create the shared feedback store of one Threads plugin instance.
 * @returns the store source and its write callbacks.
 */
export function createThreadsFeedbackStore(): ThreadsFeedbackHandle {
  const source = createSnapshotStore<ThreadsFeedbackState>({ toast: null, dirty: null })
  let seq = 0
  return {
    source,
    writes: {
      notify: (text, tone) => {
        seq += 1
        source.set({ toast: { seq, text, tone }, dirty: source.getSnapshot().dirty })
      },
      requestDirtyArchive: (request) => {
        const { toast } = source.getSnapshot()
        source.set({ toast, dirty: request })
      },
    },
    dismissToast: () => {
      const { dirty } = source.getSnapshot()
      source.set({ toast: null, dirty })
    },
    settleDirtyArchive: () => {
      const { toast } = source.getSnapshot()
      source.set({ toast, dirty: null })
    },
  }
}
