/**
 * The sidebar Thread row actions: Stop and Archive buttons on the Thread rows
 * nested under a Project row in the Workspace browser.
 *
 * The row's hover strip is the `sidebar.workspaces.thread.row.action` list
 * declared by `ui-workspace`, which owns no Thread lifecycle: the buttons live
 * here, beside the roster's, and run the same {@link useThreadActions}
 * behavior, so a dirty worktree raises the same confirmation and a success the
 * same notice from the frame-wide feedback host. Notices and the confirmation
 * are published into the shared feedback store rather than rendered here,
 * because archiving the Thread removes this row while its notice must stay.
 */
import type { ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { ArchiveThreadButton, StopThreadButton, useThreadActions, type ThreadActionsInjected } from './ThreadActions.tsx'
import type { ThreadsFeedbackWrites } from './feedback.ts'
import { threadIdOfSession, type ThreadRosterRow } from './roster.ts'
import type { NS } from './locales.ts'
import css from './SidebarThreadAction.module.css'

/** Injected face of the sidebar Thread row action: the shared Remote calls and feedback writes. */
export interface SidebarThreadActionInjected {
  /** Interrupt a running Thread with the Project's authority. */
  readonly stopThread: ThreadActionsInjected['stopThread']
  /** Archive a Thread; a dirty worktree refuses with `threads/worktree-dirty`. */
  readonly archiveThread: ThreadActionsInjected['archiveThread']
  /** Re-read the Project Session's `threads` projection after a successful archive. */
  readonly refreshProjection: ThreadActionsInjected['refreshProjection']
  /** Shared feedback writes: notices and the dirty-archive confirmation. */
  readonly feedback: ThreadsFeedbackWrites
}

/** Full props of the sidebar Thread row action. */
export type SidebarThreadActionProps =
  PropsRuntime<'sidebar.workspaces.thread.row.action'> & InjectFace<SidebarThreadActionInjected> & PropsLocale<typeof NS>

/**
 * Stop (while the Thread runs) and Archive buttons for one sidebar Thread row.
 * @param props - the Thread and its owning Project, the Remote calls, the feedback writes, and the translator.
 * @returns the row buttons.
 */
export function SidebarThreadAction({
  threadId, projectSessionId, label, useSessions, stopThread, archiveThread, refreshProjection, feedback, t,
}: SidebarThreadActionProps): ReactNode {
  // The owner props carry no liveness fact, so it is read from the Session
  // store exactly where the roster reads it.
  const running = useSessions(state => state.byId[threadId]?.running === true)
  const { actions } = useThreadActions({
    parentSessionId: projectSessionId, stopThread, archiveThread, refreshProjection, feedback, t,
  })
  const row: ThreadRosterRow = { threadId: threadIdOfSession(threadId), label, running }
  return (
    <>
      <StopThreadButton row={row} actions={actions} t={t} className={css.action} />
      <ArchiveThreadButton row={row} actions={actions} t={t} className={css.action} />
    </>
  )
}
