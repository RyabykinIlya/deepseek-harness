/**
 * Session-header Thread roster for the current Project Session.
 *
 * The dropdown interaction is the one `SubagentHeaderLineage` established and
 * this component mirrors it rather than inventing a second one: 150ms hover to
 * open, 120ms grace on hover-out, a click pins the menu so only explicit
 * dismissal closes it, an outside pointer press closes it, and Escape closes it
 * and returns focus to the trigger. The roster itself is flat, so the rows use
 * listbox/option ARIA while keeping that key handling (ArrowUp/ArrowDown wrap,
 * Home/End jump) and the roving-focus model byte-for-byte.
 *
 * A Project session is the one place the control exists before it has anything
 * to show: outside a Project an empty roster is not a control, but inside one
 * the roster is the only way to start the first Thread, so the trigger stays and
 * the menu carries the add row.
 */
import {
  useEffect, useRef, useState,
  type CSSProperties, type KeyboardEvent, type MouseEvent,
} from 'react'
import { createPortal } from 'react-dom'
// Type-only: the `agentPreset` Session projection's key and value types.
import type {} from '@deepseek-ai/dsh-agent-preset-registry/types'
import type { ThreadStatusRow } from '@deepseek-ai/dsh-experimental-threads/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  IconChevronDownOutlineRegular, IconChevronRightOutlineRegular, IconCopyOutlineRegular, IconDatabaseOutlineRegular,
  IconPlusOutlineRegular, IconRefreshOutlineRegular, StateDot, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { OutcomeGlyph, threadStatus } from './ThreadStatus.tsx'
import {
  ArchiveThreadButton, keepActivation, StopThreadButton, threadLabel, useThreadActions,
  type RowActions, type ThreadActionsInjected,
} from './ThreadActions.tsx'
import { MemoryPanel, type MemoryInjected } from './MemoryPanel.tsx'
import { isProjectSession } from './project.ts'
import { type ThreadRosterRow } from './roster.ts'
import { useThreadRoster, type ThreadsSnapshot } from './useThreadRoster.ts'
import { NS } from './locales.ts'
import css from './ThreadsHeaderAction.module.css'

/** Business actions supplied by the slot registration. */
export interface ThreadsRosterInjected extends ThreadActionsInjected, MemoryInjected {
  /** Open the Thread as the main workspace conversation. */
  openThread: (threadId: ThreadStatusRow['threadId']) => void
  /** Open the Thread as a chat tab in the right Sidebar. */
  openThreadAside: (threadId: ThreadStatusRow['threadId']) => void
  /**
   * Agent preset ids this deployment treats as Project identities. Empty is the
   * shipped default and keeps every session outside a Project.
   */
  projectAgentPresets: readonly string[]
}

/** Full props for the session-header Thread roster. */
export type ThreadsHeaderActionProps =
  PropsRuntime<'conversation.session.header.actions'> & ThreadsRosterInjected & PropsLocale<typeof NS>

const MENU_VIEWPORT_MARGIN = 16

/**
 * Focusable rows, in document order: the listbox options plus the Project's
 * trailing add row, which is a button rather than an option (a listbox admits
 * no other child) yet joins the same roving walk so ArrowDown reaches it —
 * including from an empty roster, where it is the only row there is.
 */
const FOCUSABLE_MENU_ROWS = '[role="option"]:not([aria-disabled="true"]), [data-roster-action]:not([disabled])'

/** Focusable rows, in document order. */
function menuItems(root: HTMLDivElement | null): HTMLElement[] {
  return root === null
    ? []
    : Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_MENU_ROWS))
}

/** Place a portaled roster below its trigger without crossing the viewport edge. */
function rosterMenuPosition(trigger: HTMLButtonElement): CSSProperties {
  const rect = trigger.getBoundingClientRect()
  const width = Math.min(336, window.innerWidth - MENU_VIEWPORT_MARGIN * 2)
  return {
    top: rect.bottom + 5,
    left: Math.min(
      Math.max(MENU_VIEWPORT_MARGIN, rect.left),
      window.innerWidth - width - MENU_VIEWPORT_MARGIN,
    ),
  }
}

/** One Thread row: its two status axes, its durable work facts, then its actions. */
function ThreadRow({ row, openThread, openThreadAside, actions, close, t }: {
  row: ThreadRosterRow
  openThread: ThreadsRosterInjected['openThread']
  openThreadAside: ThreadsRosterInjected['openThreadAside']
  actions: RowActions
  close: () => void
  t: TranslateNS<typeof NS>
}) {
  const status = threadStatus(row)
  const label = threadLabel(row)
  // Two axes, two elements: the liveness marker and the outcome chip are never
  // merged into one word, so a running Thread reads as running and a settled
  // one still says how it ended.
  const meta = [
    row.branch,
    row.commitsAhead === undefined || row.commitsAhead === 0
      ? undefined
      : t(row.commitsAhead === 1 ? 'commitsAhead.one' : 'commitsAhead.other', { count: row.commitsAhead }),
    row.uncommitted === undefined || row.uncommitted === 0
      ? undefined
      : t('uncommitted', { count: row.uncommitted }),
  ].filter(value => value !== undefined && value !== '').join(' · ')
  const open = (): void => {
    openThread(row.threadId)
    close()
  }
  const act = (run: () => void) => (event: MouseEvent<HTMLButtonElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    run()
  }
  const openAside = act(() => {
    openThreadAside(row.threadId)
    close()
  })
  const handleKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    event.stopPropagation()
    open()
  }
  return (
    <div
      role="option"
      tabIndex={0}
      aria-selected={false}
      data-thread-id={row.threadId}
      data-running={status.liveness.live}
      {...status.outcome === undefined ? {} : { 'data-stop-reason': status.outcome.reason }}
      aria-label={[label, t(status.liveness.labelKey), status.outcome === undefined
        ? undefined
        : t(status.outcome.labelKey), meta, row.note]
        .filter(value => value !== undefined && value !== '')
        .join(' ')}
      className={css.row}
      onClick={open}
      onKeyDown={handleKey}
    >
      <div className={css.clickarea}>
        {/* Axis one: runtime liveness. `ongoing` is the shipped spinner. */}
        <span className={css.livenessSlot}>
          <StateDot state={status.liveness.dot} />
        </span>
        <span className={css.content}>
          <span className={css.label}>{label}</span>
          {meta !== '' && <span className={css.summary}>{meta}</span>}
          {row.note !== undefined && row.note !== '' && (
            <span className={css.note} title={row.note}>{row.note}</span>
          )}
        </span>
        {/* Axis two: the terminal outcome, absent while a turn is in flight. */}
        {status.outcome !== undefined && (
          <span className={css.outcome} data-stop-reason={status.outcome.reason}>
            <OutcomeGlyph outcome={status.outcome} />
            {t(status.outcome.labelKey)}
          </span>
        )}
        <StopThreadButton row={row} actions={actions} t={t} className={css.rowButton} />
        {row.branch !== undefined && (
          <Tooltip label={t('action.copyBranch')} side="bottom" align="end">
            <button
              type="button"
              className={css.rowButton}
              aria-label={t('action.copyBranch.aria', { label })}
              onClick={act(() => { actions.copyBranch(row) })}
              onKeyDown={keepActivation}
            >
              <IconCopyOutlineRegular />
            </button>
          </Tooltip>
        )}
        <ArchiveThreadButton row={row} actions={actions} t={t} className={css.rowButton} />
        <Tooltip label={t('open.sidebar')} side="bottom" align="end">
          <button
            type="button"
            className={css.rowButton}
            aria-label={t('open.sidebar.aria', { label })}
            onClick={openAside}
            onKeyDown={keepActivation}
          >
            <IconChevronRightOutlineRegular />
          </button>
        </Tooltip>
      </div>
    </div>
  )
}

/** One trigger-plus-roster dropdown over the Threads owned by `rootSessionId`. */
function ThreadsRoster({
  rootSessionId, roster, project, startThread, openThread, openThreadAside, refreshProjection, actions, memory, t,
}: {
  rootSessionId: SessionId
  roster: ThreadsSnapshot
  /** Whether this Session is a Project: the roster then exists to start Threads, not only to list them. */
  project: boolean
  /** Stage the prepared start-a-Thread instruction in this Session's composer. */
  startThread: () => void
  /** Row-action callbacks and their in-flight set. */
  actions: RowActions
  /** Project memory requests behind the Memory view. */
  memory: MemoryInjected
} & Pick<ThreadsRosterInjected, 'openThread' | 'openThreadAside' | 'refreshProjection'>
& { t: TranslateNS<typeof NS> }) {
  const [open, setOpen] = useState(false)
  const [menuPosition, setMenuPosition] = useState<CSSProperties>()
  const [view, setView] = useState<'threads' | 'memory'>('threads')
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const hoverOpenTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const hoverCloseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // A click-opened (pinned) menu ignores hover-out; only explicit dismissal closes it.
  const pinnedRef = useRef(false)

  const runningCount = roster.entries.filter(row => row.running).length
  const countKey = runningCount > 0
    ? (runningCount === 1 ? 'count.running.one' : 'count.running.other')
    : (roster.entries.length === 1 ? 'count.total.one' : 'count.total.other')
  const count = runningCount > 0 ? runningCount : roster.entries.length

  const cancelHoverClose = (): void => {
    if (hoverCloseTimer.current === undefined) return
    clearTimeout(hoverCloseTimer.current)
    hoverCloseTimer.current = undefined
  }

  const cancelHoverOpen = (): void => {
    if (hoverOpenTimer.current === undefined) return
    clearTimeout(hoverOpenTimer.current)
    hoverOpenTimer.current = undefined
  }

  const changeOpen = (next: boolean, restoreFocus = false): void => {
    cancelHoverOpen()
    cancelHoverClose()
    if (next) {
      const trigger = triggerRef.current
      /* v8 ignore next -- a queued callback can outlive the trigger */
      if (trigger === null) return
      setOpen(true)
      setMenuPosition(rosterMenuPosition(trigger))
    }
    else {
      pinnedRef.current = false
      setOpen(false)
      setView('threads')
      setMenuPosition(undefined)
    }
    if (restoreFocus) queueMicrotask(() => { triggerRef.current?.focus() })
  }

  const scheduleHoverOpen = (): void => {
    cancelHoverOpen()
    cancelHoverClose()
    if (open) return
    hoverOpenTimer.current = setTimeout(() => {
      hoverOpenTimer.current = undefined
      changeOpen(true)
    }, 150)
  }

  const scheduleHoverClose = (): void => {
    cancelHoverOpen()
    cancelHoverClose()
    if (pinnedRef.current) return
    hoverCloseTimer.current = setTimeout(() => {
      hoverCloseTimer.current = undefined
      changeOpen(false)
    }, 120)
  }

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent): void => {
      if (
        event.target instanceof Node
        && !rootRef.current?.contains(event.target)
        && !menuRef.current?.contains(event.target)
      ) {
        changeOpen(false)
      }
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => { document.removeEventListener('pointerdown', closeOutside) }
  }, [open])

  useEffect(() => {
    if (!open) return
    const placeMenu = (): void => {
      const trigger = triggerRef.current
      /* v8 ignore next -- native resize or scroll can outlive the trigger */
      if (trigger === null) return
      setMenuPosition(rosterMenuPosition(trigger))
    }
    window.addEventListener('resize', placeMenu)
    document.addEventListener('scroll', placeMenu, true)
    return () => {
      window.removeEventListener('resize', placeMenu)
      document.removeEventListener('scroll', placeMenu, true)
    }
  }, [open])

  useEffect(() => () => {
    cancelHoverOpen()
    cancelHoverClose()
  }, [])

  // Outside a Project, an emptied roster has nothing to list and nothing to
  // offer: close rather than leave a trigger open over a panel with no rows in
  // it. Inside a Project the roster is the way to start a Thread, so zero
  // Threads is a state the control stays in. Visibility needs evidence of a
  // Thread or a failed load worth retrying — a loading projection is neither —
  // except in a Project, which is itself that evidence.
  const visible = project || roster.state === 'error' || roster.entries.length > 0
  useEffect(() => {
    if (visible) return
    cancelHoverOpen()
    cancelHoverClose()
    if (!open) return
    pinnedRef.current = false
    setOpen(false)
  }, [visible, open])

  if (!visible) return null

  const focusAt = (index: number): void => {
    const items = menuItems(menuRef.current)
    if (items.length === 0) return
    items[(index + items.length) % items.length]?.focus()
  }

  const navigate = (event: KeyboardEvent<HTMLDivElement>): void => {
    const items = menuItems(menuRef.current)
    // A focused row button belongs to its row for the walk.
    const index = items.findIndex(item => item.contains(document.activeElement))
    if (event.key === 'Escape') {
      event.preventDefault()
      changeOpen(false, true)
    } else if (event.key === 'Home') {
      event.preventDefault()
      focusAt(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      focusAt(items.length - 1)
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      focusAt(index + 1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      focusAt(index < 0 ? items.length - 1 : index - 1)
    }
  }

  return (
    <div
      className={css.root}
      ref={rootRef}
      onKeyDown={navigate}
      onMouseLeave={scheduleHoverClose}
    >
      <button
        ref={triggerRef}
        onMouseEnter={scheduleHoverOpen}
        type="button"
        className={css.trigger}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t(countKey, { count })}
        onClick={() => {
          cancelHoverOpen()
          cancelHoverClose()
          pinnedRef.current = true
          if (!open) changeOpen(true)
        }}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown') return
          event.preventDefault()
          if (!open) changeOpen(true)
          queueMicrotask(() => { focusAt(0) })
        }}
      >
        {runningCount > 0 && (
          <span className={css.activitySlot}>
            <StateDot state="ongoing" />
          </span>
        )}
        <span className={css.count}>{t(countKey, { count })}</span>
        <IconChevronDownOutlineRegular className={open ? css.triggerOpen : undefined} />
      </button>
      {open && createPortal((
        <div
          ref={menuRef}
          className={css.menu}
          style={menuPosition}
          onMouseEnter={cancelHoverClose}
          onMouseLeave={scheduleHoverClose}
        >
          {view === 'memory'
            ? <MemoryPanel projectId={rootSessionId} {...memory} onBack={() => { setView('threads') }} t={t} />
            : (
              <>
                <div className={css.menuBody} role="listbox" aria-label={t('list.aria')}>
                  {roster.state === 'error' && (
                    <div className={css.error}>
                      <span>{roster.error?.message ?? t('load.error')}</span>
                      <button
                        type="button"
                        className={css.refresh}
                        onClick={() => { refreshProjection(rootSessionId) }}
                      >
                        <IconRefreshOutlineRegular size={14} />
                        {t('retry')}
                      </button>
                    </div>
                  )}
                  {roster.entries.map(row => (
                    <ThreadRow
                      key={row.threadId}
                      row={row}
                      openThread={openThread}
                      openThreadAside={openThreadAside}
                      actions={actions}
                      close={() => { changeOpen(false) }}
                      t={t}
                    />
                  ))}
                </div>
                {/* The empty note and the add row sit beside the listbox, never inside
                    it: a listbox admits options and groups only, and an empty Project
                    roster would otherwise render a labeled box around nothing. */}
                {project && roster.entries.length === 0 && roster.state !== 'error' && (
                  <p className={css.notice}>{t('list.empty')}</p>
                )}
                {project && (
                  <div className={css.footer}>
                    <button
                      type="button"
                      data-roster-action=""
                      className={css.start}
                      onClick={() => {
                        startThread()
                        changeOpen(false)
                      }}
                    >
                      <IconPlusOutlineRegular size={14} />
                      {t('start.thread')}
                    </button>
                    <button
                      type="button"
                      data-roster-action=""
                      className={css.start}
                      onClick={() => {
                        // Leaving the Thread list must not let a hover-out close the view.
                        pinnedRef.current = true
                        setView('memory')
                      }}
                    >
                      <IconDatabaseOutlineRegular size={14} />
                      {t('memory.open')}
                    </button>
                  </div>
                )}
              </>
            )}
        </div>
      ), document.body)}
    </div>
  )
}

/**
 * Session-header entry point for the current Project Session's background
 * Threads. Outside a Project this renders nothing while the projection has not
 * been read, is still loading with no rows, or settled empty — an empty roster
 * is not a control. In a Project the trigger is always there, with the add row
 * that starts the first Thread.
 * @param props - session standard props, the roster actions, and the translator.
 * @returns The count dropdown over the session's Threads.
 */
export function ThreadsHeaderAction({
  sessionId, useSessions, projectAgentPresets, openThread, openThreadAside, refreshProjection,
  stopThread, archiveThread, listMemory, addMemory, updateMemory, removeMemory, inputActions, t,
}: ThreadsHeaderActionProps) {
  const { snapshot, roster } = useThreadRoster(useSessions, sessionId)
  // The composition a Session runs is its identity, so it is read from the list
  // row the roster already depends on rather than from the `threads` read: a
  // Project is known before either read lands, which is what lets the control
  // exist at all in a session that has no Threads yet.
  const agentPreset = useSessions(state => state.byId[sessionId]?.projectionValues?.agentPreset)
  const project = isProjectSession(agentPreset, projectAgentPresets)
  // Feedback and the confirmation are rendered here, not in the roster menu: the
  // menu closes and the roster hides when its last Thread is archived, and the
  // notice for that archive must outlive both.
  const { actions, overlays } = useThreadActions({
    parentSessionId: sessionId, stopThread, archiveThread, refreshProjection, t,
  })
  // The model, not this plugin, decides that a Thread is started: the composer
  // receives a prepared instruction the user edits and sends, and the model
  // reaches for the `subagent` tool itself. The insertion is revision-guarded
  // and lands at the caret, so an in-progress draft keeps every word of it.
  const startThread = (): void => {
    inputActions.insertText(t('start.prompt'), inputActions.captureInsertion())
  }
  if (snapshot === undefined && !project) return null
  return (
    <>
      <ThreadsRoster
        key={sessionId}
        rootSessionId={sessionId}
        roster={roster}
        project={project}
        startThread={startThread}
        openThread={openThread}
        openThreadAside={openThreadAside}
        refreshProjection={refreshProjection}
        actions={actions}
        memory={{ listMemory, addMemory, updateMemory, removeMemory }}
        t={t}
      />
      {overlays}
    </>
  )
}
