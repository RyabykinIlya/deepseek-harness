/**
 * Thread actions shared by the header roster, the Thread chat header, and the
 * sidebar Thread row: Stop, Archive with the dirty-worktree confirmation and
 * forced retry, and Copy branch.
 *
 * The feedback they produce (a Toast and the confirmation dialog) is rendered
 * by the frame-wide overlay host in `ThreadActionOverlays.tsx`, not by the
 * action buttons: archiving the last Thread removes the row, the menu, and the
 * header that requested it, and the notice must outlive all of them. The row
 * registrations write notices and confirmation requests into the shared
 * feedback store of `feedback.ts`; the overlay reads it.
 */
import { useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import {
  IconArchiveOutlineRegular, IconStopFillRegular, Tooltip, writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ThreadStatusRow } from '@deepseek-ai/dsh-experimental-threads/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { WORKTREE_DIRTY_CODE, type ThreadActionResult } from './actions.ts'
import type { ThreadsFeedbackWrites } from './feedback.ts'
import type { NS } from './locales.ts'
import type { ThreadRosterRow } from './roster.ts'

/** Business actions supplied by the slot registration. */
export interface ThreadActionsInjected {
  /** Re-read the Project Session's `threads` projection. */
  refreshProjection: (parentSessionId: SessionId) => void
  /**
   * Interrupt a running Thread with the Project's authority (the durable
   * parent-address route, which works without a live parent turn).
   * @param parentSessionId - the Project Session that owns the Thread.
   * @param threadId - the Thread to interrupt.
   * @returns the Remote outcome; a failure carries the Host's code and message.
   */
  stopThread: (
    parentSessionId: SessionId, threadId: ThreadStatusRow['threadId'],
  ) => Promise<ThreadActionResult>
  /**
   * Archive a Thread: remove its worktree and drop it from the roster.
   * @param parentSessionId - the Project Session that owns the Thread.
   * @param threadId - the Thread to archive.
   * @param force - discard uncommitted worktree changes instead of refusing.
   * @returns the Remote outcome; `threads/worktree-dirty` means the worktree holds uncommitted changes.
   */
  archiveThread: (
    parentSessionId: SessionId, threadId: ThreadStatusRow['threadId'], force: boolean,
  ) => Promise<ThreadActionResult>
}

/** Row-action callbacks handed to every Thread row and to the Thread chat header. */
export interface RowActions {
  /** Interrupt the running Thread. */
  stop: (row: ThreadRosterRow) => void
  /** Archive the Thread, asking for confirmation when its worktree is dirty. */
  archive: (row: ThreadRosterRow) => void
  /** Copy the Thread's branch name to the clipboard. */
  copyBranch: (row: ThreadRosterRow) => void
  /** Thread ids with a Stop or Archive request in flight. */
  busy: ReadonlySet<string>
}

/** Result of {@link useThreadActions}. */
export interface UseThreadActions {
  /** Callbacks for the Thread buttons. */
  actions: RowActions
}

/** The archive one Thread is waiting on: its owner, its identity, and its display label. */
export interface ThreadArchiveRequest {
  /** The Project Session that owns the Thread. */
  readonly parentSessionId: SessionId
  /** The Thread to archive. */
  readonly threadId: ThreadStatusRow['threadId']
  /** Display label, already resolved (an empty label falls back to the identity). */
  readonly label: string
}

/** The Remote calls and feedback writes {@link submitThreadArchive} drives. */
export interface ThreadArchiveDeps {
  /** Interrupt-free archive; `threads/worktree-dirty` means the worktree holds uncommitted changes. */
  readonly archiveThread: ThreadActionsInjected['archiveThread']
  /** Re-read the Project Session's `threads` projection after a successful archive. */
  readonly refreshProjection: ThreadActionsInjected['refreshProjection']
  /** Shared feedback writes. */
  readonly feedback: ThreadsFeedbackWrites
  /** `threads` namespace translator. */
  readonly t: TranslateNS<typeof NS>
}

/**
 * Archive one Thread and publish the outcome: a success refreshes the
 * projection and raises a success notice; a dirty-worktree refusal asks for
 * confirmation instead of failing; anything else raises a warning notice. The
 * row actions and the overlay's forced retry share this one path, so every
 * surface reports the same archive the same way.
 * @param request - the Thread, its owner, and its display label.
 * @param force - discard uncommitted worktree changes instead of refusing.
 * @param deps - the Remote call, the projection refresh, the feedback writes, and the translator.
 */
export async function submitThreadArchive(
  request: ThreadArchiveRequest, force: boolean, deps: ThreadArchiveDeps,
): Promise<void> {
  const result = await deps.archiveThread(request.parentSessionId, request.threadId, force)
  if (result.ok) {
    deps.refreshProjection(request.parentSessionId)
    deps.feedback.notify(deps.t('toast.archived', { label: request.label }), 'success')
  } else if (!force && result.code === WORKTREE_DIRTY_CODE) {
    deps.feedback.requestDirtyArchive({
      parentSessionId: request.parentSessionId, threadId: request.threadId, label: request.label,
    })
  } else {
    deps.feedback.notify(deps.t('toast.archiveFailed', { label: request.label, message: result.message }), 'warning')
  }
}

/**
 * Keep Enter and Space on a nested button from activating the row that holds
 * it (Enter/Space on the roster option opens the Thread); arrow keys still
 * bubble to the roster's roving-focus walk.
 * @param event - the key event on a nested button.
 */
export function keepActivation(event: KeyboardEvent<HTMLElement>): void {
  if (event.key === 'Enter' || event.key === ' ') event.stopPropagation()
}

/**
 * The label a Thread is shown under: its label, else its identity.
 * @param row - the Thread row.
 * @returns the display label.
 */
export function threadLabel(row: Pick<ThreadRosterRow, 'label' | 'threadId'>): string {
  return row.label === '' ? row.threadId : row.label
}

/**
 * Own the Stop, Archive and Copy branch behavior for the Threads of one Project.
 * Notices and the dirty-worktree confirmation are published into the shared
 * feedback store through {@link ThreadsFeedbackWrites}; the frame-wide overlay
 * renders them, so a row that disappears still leaves its notice on screen.
 * @param options - the Project Session, the injected actions, the shared feedback writes, and the translator.
 * @returns the row callbacks and the in-flight set.
 */
export function useThreadActions({ parentSessionId, stopThread, archiveThread, refreshProjection, feedback, t }:
  ThreadActionsInjected & { parentSessionId: SessionId; feedback: ThreadsFeedbackWrites; t: TranslateNS<typeof NS> },
): UseThreadActions {
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set())
  const setPending = (threadId: string, pending: boolean): void => {
    setBusy((current) => {
      const next = new Set(current)
      if (pending) next.add(threadId)
      else next.delete(threadId)
      return next
    })
  }
  const deps: ThreadArchiveDeps = { archiveThread, refreshProjection, feedback, t }
  /** Archive one Thread; a dirty worktree asks for confirmation through the shared store. */
  async function archive(row: ThreadRosterRow, force: boolean): Promise<void> {
    setPending(row.threadId, true)
    try {
      await submitThreadArchive(
        { parentSessionId, threadId: row.threadId, label: threadLabel(row) }, force, deps,
      )
    } finally {
      setPending(row.threadId, false)
    }
  }
  const actions: RowActions = {
    busy,
    stop: (row) => {
      setPending(row.threadId, true)
      void stopThread(parentSessionId, row.threadId).then((result) => {
        if (!result.ok) {
          feedback.notify(t('toast.stopFailed', { label: threadLabel(row), message: result.message }), 'warning')
        }
      }).finally(() => { setPending(row.threadId, false) })
    },
    archive: (row) => { void archive(row, false) },
    copyBranch: (row) => {
      const branch = row.branch
      /* v8 ignore next -- the copy button renders only for a row with a branch */
      if (branch === undefined) return
      void writeClipboard(branch).then((copied) => {
        if (copied) feedback.notify(t('toast.branchCopied', { branch }), 'success')
        else feedback.notify(t('toast.copyFailed'), 'warning')
      })
    },
  }
  return { actions }
}

/** Props of the Thread action buttons. */
interface ThreadButtonProps {
  /** The Thread the button acts on. */
  row: ThreadRosterRow
  /** Callbacks and the in-flight set from {@link useThreadActions}. */
  actions: RowActions
  /** `threads` namespace translator. */
  t: TranslateNS<typeof NS>
  /** Button skin supplied by the hosting surface. */
  className: string | undefined
}

/** Run a button action without letting the click or key reach the surrounding row. */
function act(run: () => void) {
  return (event: MouseEvent<HTMLButtonElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    run()
  }
}

/**
 * Stop button, rendered only while the Thread is running.
 * @param props - the Thread, the shared actions, the translator, and the skin.
 * @returns the icon button, or null for a Thread that is not running.
 */
export function StopThreadButton({ row, actions, t, className }: ThreadButtonProps): ReactNode {
  if (!row.running) return null
  return (
    <Tooltip label={t('action.stop')} side="bottom" align="end">
      <button
        type="button"
        className={className}
        aria-label={t('action.stop.aria', { label: threadLabel(row) })}
        disabled={actions.busy.has(row.threadId)}
        onClick={act(() => { actions.stop(row) })}
        onKeyDown={keepActivation}
      >
        <IconStopFillRegular />
      </button>
    </Tooltip>
  )
}

/**
 * Archive button; a dirty worktree is confirmed through the host's overlays.
 * @param props - the Thread, the shared actions, the translator, and the skin.
 * @returns the icon button.
 */
export function ArchiveThreadButton({ row, actions, t, className }: ThreadButtonProps): ReactNode {
  return (
    <Tooltip label={t('action.archive')} side="bottom" align="end">
      <button
        type="button"
        className={className}
        aria-label={t('action.archive.aria', { label: threadLabel(row) })}
        disabled={actions.busy.has(row.threadId)}
        onClick={act(() => { actions.archive(row) })}
        onKeyDown={keepActivation}
      >
        <IconArchiveOutlineRegular />
      </button>
    </Tooltip>
  )
}
