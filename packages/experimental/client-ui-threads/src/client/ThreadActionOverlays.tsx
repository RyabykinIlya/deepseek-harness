/**
 * The `'shell.overlay'` host of every Thread action's feedback.
 *
 * The frame-wide layer outlives every Thread row: archiving a Thread drops it
 * from the projection, and with it the row, the roster menu, and the header
 * seat that requested the archive, while the notice for that archive must
 * stay on screen. The row registrations publish into the shared feedback
 * store; this host reads the store through its bound hook and renders the
 * Toast and the dirty-worktree confirmation, including the forced retry a
 * confirmation leads to.
 */
import { useState, type ReactNode } from 'react'
import { IconWarningOutlineRegular, RiskConfirmation, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { submitThreadArchive, type ThreadActionsInjected } from './ThreadActions.tsx'
import type { ThreadsDirtyArchive, ThreadsFeedbackState, ThreadsFeedbackWrites } from './feedback.ts'
import type { NS } from './locales.ts'

/** How long the Toast holds: a failure that names what broke takes longer to read than a one-line note. */
const TOAST_HOLD_MS = 6000

/** Injected face of the overlay host: the shared feedback store's source plus the writes and Remote calls it drives. */
export interface ThreadsOverlayInjected {
  hooks: {
    /** The shared feedback state; bound to `useFeedback` on the component side. */
    feedback: HostObservable<ThreadsFeedbackState>
  }
  /** The write callbacks the row registrations use; a confirmed retry publishes its outcome through them. */
  readonly writes: ThreadsFeedbackWrites
  /** Withdraw the notice on display. */
  readonly dismissToast: () => void
  /** Close the dirty-worktree confirmation. */
  readonly settleDirtyArchive: () => void
  /** Interrupt-free archive; the forced retry runs it with `force: true`. */
  readonly archiveThread: ThreadActionsInjected['archiveThread']
  /** Re-read the Project Session's `threads` projection after a successful archive. */
  readonly refreshProjection: ThreadActionsInjected['refreshProjection']
}

/** Full props of the Thread action feedback host. */
export type ThreadActionOverlaysProps =
  PropsRuntime<'shell.overlay'> & InjectFace<ThreadsOverlayInjected> & PropsLocale<typeof NS>

/**
 * Render the shared Toast and the dirty-worktree confirmation of every Thread action.
 * @param props - the feedback hook and write callbacks, the Remote calls, and the translator.
 * @returns the notice and the confirmation, or nothing while neither is pending.
 */
export function ThreadActionOverlays({
  useFeedback, writes, dismissToast, settleDirtyArchive, archiveThread, refreshProjection, t,
}: ThreadActionOverlaysProps): ReactNode {
  const state = useFeedback(current => current)
  const dirty = state.dirty
  return (
    <>
      {state.toast !== null && (
        <Toast
          key={state.toast.seq}
          text={state.toast.text}
          {...state.toast.tone === 'success' ? { tone: 'success' as const } : { icon: <IconWarningOutlineRegular /> }}
          holdMs={TOAST_HOLD_MS}
          onDone={dismissToast}
        />
      )}
      {dirty !== null && (
        <DirtyArchiveConfirmation
          key={`${String(dirty.parentSessionId)}/${String(dirty.threadId)}`}
          request={dirty}
          archiveThread={archiveThread}
          refreshProjection={refreshProjection}
          feedback={writes}
          settle={settleDirtyArchive}
          t={t}
        />
      )}
    </>
  )
}

/**
 * One pending dirty-worktree confirmation. Keyed by its request, so its
 * acknowledgement checkbox starts unchecked for every new request.
 * @param props - the archive to confirm, the Remote calls, the feedback writes, the settle callback, and the translator.
 * @returns the confirmation dialog.
 */
function DirtyArchiveConfirmation({ request, archiveThread, refreshProjection, feedback, settle, t }: {
  request: ThreadsDirtyArchive
  archiveThread: ThreadActionsInjected['archiveThread']
  refreshProjection: ThreadActionsInjected['refreshProjection']
  feedback: ThreadsFeedbackWrites
  settle: () => void
  t: ThreadActionOverlaysProps['t']
}): ReactNode {
  const [acknowledged, setAcknowledged] = useState(false)
  return (
    <RiskConfirmation
      open
      title={t('archive.dirty.title')}
      description={t('archive.dirty.body', { label: request.label })}
      acknowledgeLabel={t('archive.dirty.acknowledge')}
      cancelLabel={t('archive.dirty.cancel')}
      closeLabel={t('archive.dirty.close')}
      confirmLabel={t('archive.dirty.confirm')}
      acknowledged={acknowledged}
      onAcknowledgedChange={setAcknowledged}
      onCancel={settle}
      onConfirm={() => {
        settle()
        void submitThreadArchive(
          { parentSessionId: request.parentSessionId, threadId: request.threadId, label: request.label },
          true,
          { archiveThread, refreshProjection, feedback, t },
        )
      }}
    />
  )
}
