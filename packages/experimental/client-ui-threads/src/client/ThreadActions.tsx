/**
 * Thread actions shared by the header roster and the Thread chat header: Stop,
 * Archive with the dirty-worktree confirmation and forced retry, and Copy
 * branch, together with the feedback they produce.
 *
 * The feedback (a Toast and the confirmation dialog) is rendered by the host
 * component through {@link UseThreadActions.overlays}, not by the action
 * buttons: archiving the last Thread removes the row, the menu, and the header
 * that requested it, and the notice must outlive all of them.
 */
import { useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import {
  IconArchiveOutlineRegular, IconStopFillRegular, IconWarningOutlineRegular, RiskConfirmation, Toast,
  Tooltip, writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ThreadStatusRow } from '@deepseek-ai/dsh-experimental-threads/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { WORKTREE_DIRTY_CODE, type ThreadActionResult } from './actions.ts'
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
  /** The Toast and the dirty-archive confirmation; render once, in a component that outlives the row. */
  overlays: ReactNode
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
 * @param options - the Project Session, the injected actions, and the translator.
 * @returns the row callbacks and the feedback overlays to render.
 */
export function useThreadActions({ parentSessionId, stopThread, archiveThread, refreshProjection, t }:
  ThreadActionsInjected & { parentSessionId: SessionId; t: TranslateNS<typeof NS> }): UseThreadActions {
  const toastSeq = useRef(0)
  const [toast, setToast] = useState<{ seq: number; text: string; tone: 'success' | 'warning' } | null>(null)
  const [dirtyRow, setDirtyRow] = useState<ThreadRosterRow | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set())
  const notify = (text: string, tone: 'success' | 'warning'): void => {
    toastSeq.current += 1
    setToast({ seq: toastSeq.current, text, tone })
  }
  const setPending = (threadId: string, pending: boolean): void => {
    setBusy((current) => {
      const next = new Set(current)
      if (pending) next.add(threadId)
      else next.delete(threadId)
      return next
    })
  }
  /** Archive one Thread; a dirty worktree asks for confirmation before the forced retry. */
  async function archive(row: ThreadRosterRow, force: boolean): Promise<void> {
    setPending(row.threadId, true)
    try {
      const result = await archiveThread(parentSessionId, row.threadId, force)
      if (result.ok) {
        refreshProjection(parentSessionId)
        notify(t('toast.archived', { label: threadLabel(row) }), 'success')
      } else if (!force && result.code === WORKTREE_DIRTY_CODE) {
        setAcknowledged(false)
        setDirtyRow(row)
      } else {
        notify(t('toast.archiveFailed', { label: threadLabel(row), message: result.message }), 'warning')
      }
    } finally {
      setPending(row.threadId, false)
    }
  }
  const actions: RowActions = {
    busy,
    stop: (row) => {
      setPending(row.threadId, true)
      void stopThread(parentSessionId, row.threadId).then((result) => {
        if (!result.ok) notify(t('toast.stopFailed', { label: threadLabel(row), message: result.message }), 'warning')
      }).finally(() => { setPending(row.threadId, false) })
    },
    archive: (row) => { void archive(row, false) },
    copyBranch: (row) => {
      const branch = row.branch
      /* v8 ignore next -- the copy button renders only for a row with a branch */
      if (branch === undefined) return
      void writeClipboard(branch).then((copied) => {
        if (copied) notify(t('toast.branchCopied', { branch }), 'success')
        else notify(t('toast.copyFailed'), 'warning')
      })
    },
  }
  const overlays = (
    <>
      {toast !== null && (
        <Toast
          key={toast.seq}
          text={toast.text}
          {...toast.tone === 'success' ? { tone: 'success' as const } : { icon: <IconWarningOutlineRegular /> }}
          holdMs={6000}
          onDone={() => { setToast(null) }}
        />
      )}
      <RiskConfirmation
        open={dirtyRow !== null}
        title={t('archive.dirty.title')}
        description={dirtyRow === null ? '' : t('archive.dirty.body', { label: threadLabel(dirtyRow) })}
        acknowledgeLabel={t('archive.dirty.acknowledge')}
        cancelLabel={t('archive.dirty.cancel')}
        closeLabel={t('archive.dirty.close')}
        confirmLabel={t('archive.dirty.confirm')}
        acknowledged={acknowledged}
        onAcknowledgedChange={setAcknowledged}
        onCancel={() => { setDirtyRow(null) }}
        onConfirm={() => {
          const row = dirtyRow
          setDirtyRow(null)
          /* v8 ignore next -- the dialog confirms only while a dirty row is pending */
          if (row !== null) void archive(row, true)
        }}
      />
    </>
  )
  return { actions, overlays }
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
