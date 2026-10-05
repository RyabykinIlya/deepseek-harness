/**
 * Compact header of a Thread chat: label, status, branch, and the Stop and
 * Archive actions the roster offers, through the same {@link useThreadActions}.
 * It is shown above the right-Sidebar Thread chat and, for a Thread opened as
 * the main conversation, in the session header actions band.
 */
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ThreadId } from '@deepseek-ai/dsh-experimental-threads/client'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { ArchiveThreadButton, StopThreadButton, threadLabel, useThreadActions, type ThreadActionsInjected } from './ThreadActions.tsx'
import { OutcomeGlyph, threadStatus } from './ThreadStatus.tsx'
import { useThreadRoster, type UseSessions } from './useThreadRoster.ts'
import type { NS } from './locales.ts'
import css from './ThreadChatHeader.module.css'

/** Props of {@link ThreadChatHeader}. */
export interface ThreadChatHeaderProps extends ThreadActionsInjected {
  /** The Project Session that owns the Thread. */
  parentSessionId: SessionId
  /** The Thread shown. */
  threadId: ThreadId
  /** Session-list selector hook. */
  useSessions: UseSessions
  /** Agent preset ids this deployment treats as Project identities. */
  projectAgentPresets: readonly string[]
  /** `threads` namespace translator. */
  t: TranslateNS<typeof NS>
  /** Where the header sits: above a Sidebar chat body, or in the session header band. */
  placement: 'tab' | 'header'
}

/**
 * Render the Thread header, or nothing while the Project has no row for the Thread.
 * @param props - the owning Project, the Thread, the actions, and the translator.
 * @returns the header and the action feedback overlays.
 */
export function ThreadChatHeader({
  parentSessionId, threadId, useSessions, projectAgentPresets, stopThread, archiveThread, refreshProjection, placement, t,
}: ThreadChatHeaderProps) {
  const { roster } = useThreadRoster(useSessions, parentSessionId, projectAgentPresets)
  const { actions, overlays } = useThreadActions({ parentSessionId, stopThread, archiveThread, refreshProjection, t })
  const row = roster.entries.find(candidate => candidate.threadId === threadId)
  if (row === undefined) return <>{overlays}</>
  const status = threadStatus(row)
  return (
    <>
      <div className={css.header} data-thread-header={placement} role="group" aria-label={t('chat.header.aria', { label: threadLabel(row) })}>
        <span className={css.dot}><StateDot state={status.liveness.dot} /></span>
        <span className={css.label}>{threadLabel(row)}</span>
        <span className={css.status}>{t(status.liveness.labelKey)}</span>
        {status.outcome !== undefined && (
          <span className={css.outcome} data-stop-reason={status.outcome.reason}>
            <OutcomeGlyph outcome={status.outcome} />
            {t(status.outcome.labelKey)}
          </span>
        )}
        {row.branch !== undefined && <span className={css.branch} title={row.branch}>{row.branch}</span>}
        <span className={css.buttons}>
          <StopThreadButton row={row} actions={actions} t={t} className={css.button} />
          <ArchiveThreadButton row={row} actions={actions} t={t} className={css.button} />
        </span>
      </div>
      {overlays}
    </>
  )
}

/** Props of the session-header entry that shows the header for a Thread opened as the main conversation. */
export type ThreadHeaderActionProps =
  PropsRuntime<'conversation.session.header.actions'>
  & ThreadActionsInjected
  & { projectAgentPresets: readonly string[] }
  & PropsLocale<typeof NS>

/**
 * Session-header entry for a Thread opened as the main conversation: the
 * owning Project is the Session's parent, and nothing renders for a Session that
 * has no parent or is not a Thread of it.
 * @param props - session standard props, the Thread actions, and the translator.
 * @returns the Thread header, or null.
 */
export function ThreadHeaderAction({
  sessionId, useSessions, projectAgentPresets, stopThread, archiveThread, refreshProjection, t,
}: ThreadHeaderActionProps) {
  const parentId = useSessions(state => state.byId[sessionId]?.parentId)
  if (parentId === undefined) return null
  return (
    <ThreadChatHeader
      parentSessionId={parentId}
      threadId={threadIdOfSession(sessionId)}
      useSessions={useSessions}
      projectAgentPresets={projectAgentPresets}
      stopThread={stopThread}
      archiveThread={archiveThread}
      refreshProjection={refreshProjection}
      placement="header"
      t={t}
    />
  )
}

/** The Thread a Session hosts: both brands wrap the same string. */
function threadIdOfSession(sessionId: string): ThreadId {
  return sessionId as ThreadId
}
