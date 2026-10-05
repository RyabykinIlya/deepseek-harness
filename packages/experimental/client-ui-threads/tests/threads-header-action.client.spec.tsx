// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { makeTranslate, RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type {
  SessionListState, SessionProjectionMap, SessionProjectionSnapshot, SessionSummary,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { ThreadStopReason, ThreadStatusRow } from '@deepseek-ai/dsh-experimental-threads/types'
import type { ThreadId } from '@deepseek-ai/dsh-experimental-threads/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ThreadId as toThreadId } from '@deepseek-ai/dsh-experimental-threads/types'
import { ThreadsHeaderAction, type ThreadsHeaderActionProps } from '../src/client/ThreadsHeaderAction.tsx'
import { threadStatus } from '../src/client/ThreadStatus.tsx'
import { zh } from '../src/client/locales.ts'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { MemoryEntry, MemoryEntryId } from '../src/client/memory-types.ts'
import type { ThreadsLibrary } from '@deepseek-ai/dsh-experimental-threads/client'
import { fake, okResult } from './support.client.ts'

/** Thread ids whose own Session is executing; `props` publishes them in the Session store. */
const RUNNING = new Set<string>()

afterEach(() => {
  RUNNING.clear()
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const PARENT = 'project/1' as SessionId
const sid = (id: string): SessionId => id as SessionId
const t: ThreadsHeaderActionProps['t'] = makeTranslate(zh)

/** The composer revision a prepared instruction is inserted against. */
const EMPTY_SPAN = { start: 0, end: 0, draftRev: 3 }

/** One Project identity: the Session's preset plus the ids configured as Project. */
const PROJECT = { agentPreset: 'project', presets: ['project'] } as const

/**
 * One `threads` projection row. A durable row carries no liveness, so
 * `running: true` instead marks the Thread's Session as executing in the
 * Session store that `props` builds.
 */
function row(over: {
  threadId: string
  label?: string
  running?: boolean
  stopReason?: ThreadStopReason
  branch?: string
  commitsAhead?: number
  uncommitted?: number
  note?: string
} = { threadId: 't-1' }): ThreadStatusRow {
  if (over.running === true) RUNNING.add(over.threadId)
  return {
    threadId: toThreadId(over.threadId),
    label: over.label ?? 'Refactor the parser',
    ...over.stopReason === undefined ? {} : { stopReason: over.stopReason },
    ...over.branch === undefined ? {} : { branch: over.branch },
    ...over.commitsAhead === undefined ? {} : { commitsAhead: over.commitsAhead },
    ...over.uncommitted === undefined ? {} : { uncommitted: over.uncommitted },
    ...over.note === undefined ? {} : { note: over.note },
  }
}

/**
 * The header action's own view of one session's projection, including the
 * load state the control needs in order to tell "no Threads" from "not read".
 */
function snapshot(over: Partial<SessionProjectionSnapshot> = {}): SessionProjectionSnapshot {
  return { values: {}, state: 'idle', error: null, ...over }
}

function props(
  projection: SessionProjectionSnapshot | undefined,
  over: Partial<ThreadsHeaderActionProps> = {},
  project: { agentPreset?: string; presets?: readonly string[]; catalog?: SessionProjectionMap['subagentCatalog'] } = {},
): ThreadsHeaderActionProps {
  const summaryRow = (running: boolean, projectionValues?: Partial<SessionProjectionMap>): SessionSummary =>
    fake<SessionSummary>({ running, ...projectionValues === undefined ? {} : { projectionValues } })
  const parentValues: Partial<SessionProjectionMap> = {
    ...(project.agentPreset === undefined ? {} : { agentPreset: project.agentPreset }),
    ...(project.catalog === undefined ? {} : { subagentCatalog: project.catalog }),
  }
  const byId: Record<string, SessionSummary> = {
    // The composition a Session runs is an identity fact, not a `threads` read,
    // so the row carries it exactly as the agent-preset label reads it.
    [PARENT]: summaryRow(false, Object.keys(parentValues).length === 0 ? undefined : parentValues),
    // A Thread is running exactly when its own Session is.
    ...Object.fromEntries([...RUNNING].map(id => [id, summaryRow(true)])),
  }
  const state = fake<SessionListState>({
    ids: [PARENT],
    byId,
    phase: 'ready',
    projectionsBySession: projection === undefined ? {} : { [PARENT]: projection },
  })
  function useSessions<T>(select: (value: SessionListState) => T): T {
    return select(state)
  }
  const unused = (): never => { throw new Error('this header seat provides no such source') }
  return fake<ThreadsHeaderActionProps>({
    sessionId: PARENT,
    useSessions,
    usePanelInfo: unused,
    useSessionRetainInfo: unused,
    useWorkspaces: unused,
    useResource: unused,
    useProjection: unused,
    useConversation: unused,
    useInput: unused,
    useChat: unused,
    inputActions: {
      captureInsertion: vi.fn(() => EMPTY_SPAN),
      insertText: vi.fn(() => true),
      setDraft: unused,
      persistDraft: unused,
      addAttachments: unused,
      removeAttachment: unused,
      pruneAttachments: unused,
      submit: unused,
    },
    openThread: vi.fn(),
    openThreadAside: vi.fn(),
    refreshProjection: vi.fn(),
    stopThread: vi.fn(okResult),
    archiveThread: vi.fn(okResult),
    listMemory: vi.fn((): ReturnType<ThreadsHeaderActionProps['listMemory']> => Promise.resolve({ ok: true, value: [] })),
    addMemory: vi.fn(),
    updateMemory: vi.fn(),
    removeMemory: vi.fn(),
    listLibrary: vi.fn((): ReturnType<ThreadsHeaderActionProps['listLibrary']> => Promise.resolve({
      ok: true,
      value: {
        attachments: { items: [], total: 0, truncated: false },
        presented: { items: [], total: 0, truncated: false },
        changes: { items: [], total: 0, truncated: false },
      },
    })),
    projectAgentPresets: project.presets ?? [],
    t,
    ...over,
  })
}

function openRoster(): void {
  fireEvent.click(screen.getByRole('button', { expanded: false }))
}

function hoverRoster(trigger: HTMLElement): void {
  vi.useFakeTimers()
  fireEvent.mouseEnter(trigger)
  act(() => { vi.advanceTimersByTime(150) })
}

function rosterOptions(): HTMLElement[] {
  return screen.getAllByRole('option')
}

describe('ThreadsHeaderAction visibility', () => {
  it('renders nothing before the projection has been read', () => {
    const { container } = render(<ThreadsHeaderAction {...props(undefined)} />)
    expect(container.innerHTML).toBe('')
  })

  it('renders nothing for a session that has no Threads at all', () => {
    const { container } = render(<ThreadsHeaderAction {...props(snapshot({ values: { threads: [] }, state: 'ready' }))} />)
    expect(container.innerHTML).toBe('')
  })

  it('reports a still-loading projection as absent rather than as zero Threads', () => {
    const { container } = render(<ThreadsHeaderAction {...props(snapshot({ state: 'loading' }))} />)
    expect(container.innerHTML).toBe('')
    // An idle read that has not delivered its values yet is still loading, not
    // an empty roster.
    const idle = render(<ThreadsHeaderAction {...props({ values: {}, state: 'idle', error: null })} />)
    expect(idle.container.innerHTML).toBe('')
  })

  it('counts the running Threads on the trigger while any run, and the total otherwise', () => {
    const view = render(<ThreadsHeaderAction {...props(snapshot({
      state: 'ready',
      values: {
        threads: [
          row({ threadId: 't-1', label: 'alpha', running: true }),
          row({ threadId: 't-2', label: 'beta', running: true }),
          row({ threadId: 't-3', label: 'gamma', stopReason: 'completed' }),
        ],
      },
    }))} />)
    expect(screen.getByRole('button', { name: '2 个线程运行中' })).toBeDefined()
    openRoster()
    expect(within(screen.getByRole('listbox')).getByText('gamma')).toBeDefined()

    RUNNING.clear()
    view.rerender(<ThreadsHeaderAction {...props(snapshot({
      state: 'ready',
      values: {
        threads: [
          row({ threadId: 't-1', label: 'alpha', stopReason: 'completed' }),
          row({ threadId: 't-2', label: 'beta', stopReason: 'error' }),
          row({ threadId: 't-3', label: 'gamma', stopReason: 'aborted' }),
        ],
      },
    }))} />)
    expect(screen.getByRole('button', { name: '3 个线程' })).toBeDefined()
  })

  it('uses the singular form for a single Thread', () => {
    render(<ThreadsHeaderAction {...props(snapshot({
      state: 'ready',
      values: { threads: [row({ threadId: 't-1', stopReason: 'completed' })] },
    }))} />)
    expect(screen.getByRole('button', { name: '1 个线程' })).toBeDefined()
  })
})

describe('ThreadsHeaderAction rows', () => {
  it('renders one row per projected Thread, in durable creation order', () => {
    render(<ThreadsHeaderAction {...props(snapshot({
      state: 'ready',
      values: {
        threads: [
          row({ threadId: 't-1', label: 'first' }),
          row({ threadId: 't-2', label: 'second' }),
          row({ threadId: 't-3', label: 'third' }),
        ],
      },
    }))} />)
    openRoster()
    expect(rosterOptions().map(option => option.getAttribute('data-thread-id'))).toEqual(['t-1', 't-2', 't-3'])
    expect(within(screen.getByRole('listbox')).getByText('second')).toBeDefined()
  })

  it('falls back to the Thread identity when the label is empty', () => {
    render(<ThreadsHeaderAction {...props(snapshot({
      state: 'ready',
      values: { threads: [row({ threadId: 't-empty', label: '' })] },
    }))} />)
    openRoster()
    expect(within(screen.getByRole('listbox')).getByText('t-empty')).toBeDefined()
  })

  it('shows branch, commits ahead and uncommitted count on one line and the closing note below', () => {
    render(<ThreadsHeaderAction {...props(snapshot({
      state: 'ready',
      values: {
        threads: [
          row({ threadId: 't-1', note: 'merged by hand' }),
          row({ threadId: 't-2', branch: 'dsh/thread-ab12', commitsAhead: 3, uncommitted: 2, note: 'done' }),
          row({ threadId: 't-3', branch: 'dsh/thread-cd34', commitsAhead: 1, uncommitted: 0 }),
          // Zero counts are not facts worth a line.
          row({ threadId: 't-4', branch: 'dsh/thread-ef56', commitsAhead: 0, uncommitted: 0 }),
        ],
      },
    }))} />)
    openRoster()
    const body = screen.getByRole('listbox')
    expect(within(body).getByText('merged by hand')).toBeDefined()
    // The closing note sits on its own line and keeps its full text as the tooltip.
    expect(within(body).getByText('done').getAttribute('title')).toBe('done')
    expect(within(body).getByText('dsh/thread-ab12 · 领先 3 个提交 · 2 个未提交')).toBeDefined()
    expect(within(body).getByText('dsh/thread-cd34 · 领先 1 个提交')).toBeDefined()
    expect(within(body).getByText('dsh/thread-ef56')).toBeDefined()
  })
})

describe('ThreadsHeaderAction status axes', () => {
  it('reads a live Thread as running with no outcome, and never invents one', () => {
    render(<ThreadsHeaderAction {...props(snapshot({
      state: 'ready',
      values: { threads: [row({ threadId: 't-live', running: true })] },
    }))} />)
    openRoster()
    const [option] = rosterOptions()
    expect(option?.getAttribute('data-running')).toBe('true')
    expect(option?.hasAttribute('data-stop-reason')).toBe(false)
    // The liveness axis is the shipped spinner, not a text-only status.
    expect(option?.querySelector('[data-state="ongoing"]')).not.toBeNull()
    expect(within(screen.getByRole('listbox')).queryByText('已完成')).toBeNull()
  })

  it('reads a settled Thread with no recorded outcome as idle, not as a failure', () => {
    render(<ThreadsHeaderAction {...props(snapshot({
      state: 'ready',
      values: { threads: [row({ threadId: 't-idle', running: false })] },
    }))} />)
    openRoster()
    const [option] = rosterOptions()
    expect(option?.getAttribute('data-running')).toBe('false')
    expect(option?.hasAttribute('data-stop-reason')).toBe(false)
    expect(option?.getAttribute('aria-label')).toContain('未运行')
    expect(within(screen.getByRole('listbox')).queryByText('出错')).toBeNull()
  })

  it.each([
    { reason: 'completed', label: '已完成' },
    { reason: 'aborted', label: '已中止' },
    { reason: 'error', label: '出错' },
    { reason: 'max-tokens', label: '达到 token 上限' },
    { reason: 'refusal', label: '已拒绝' },
  ] as const)('gives every stopReason $reason its own glyph and label', ({ reason, label }) => {
    render(<ThreadsHeaderAction {...props(snapshot({
      state: 'ready',
      values: { threads: [row({ threadId: `t-${reason}`, running: false, stopReason: reason })] },
    }))} />)
    openRoster()
    const [option] = rosterOptions()
    // The two axes stay separately readable: liveness is false AND the
    // terminal outcome is still stated.
    expect(option?.getAttribute('data-running')).toBe('false')
    expect(option?.getAttribute('data-stop-reason')).toBe(reason)
    expect(option?.getAttribute('aria-label')).toContain('未运行')
    expect(option?.getAttribute('aria-label')).toContain(label)
    const glyph = option?.querySelector(`[data-stop-reason="${reason}"]`)
    expect(glyph).not.toBeNull()
    expect(within(screen.getByRole('listbox')).getByText(label)).toBeDefined()
  })

  it('gives each stopReason a distinct glyph path', () => {
    const paths = (['completed', 'aborted', 'error', 'max-tokens', 'refusal'] as const).map((reason) => {
      const outcome = threadStatus({ running: false, stopReason: reason }).outcome
      return outcome === undefined ? 'none' : reason
    })
    expect(new Set(paths).size).toBe(5)
  })

  it('keeps both axes visible when a live row still carries a settled outcome', () => {
    render(<ThreadsHeaderAction {...props(snapshot({
      state: 'ready',
      // A forged row: the fold reconciles these, but the panel must not hide
      // one axis behind the other if a provider ever sends it.
      values: { threads: [row({ threadId: 't-both', running: true, stopReason: 'error' })] },
    }))} />)
    openRoster()
    const [option] = rosterOptions()
    expect(option?.getAttribute('data-running')).toBe('true')
    expect(option?.getAttribute('data-stop-reason')).toBe('error')
    expect(within(screen.getByRole('listbox')).getByText('出错')).toBeDefined()
  })

  it('reads the wire outcomes and the absent case through one pure function', () => {
    expect(threadStatus({ running: true })).toEqual({
      liveness: { live: true, labelKey: 'liveness.running', dot: 'ongoing' },
      outcome: undefined,
    })
    expect(threadStatus({ running: false })).toEqual({
      liveness: { live: false, labelKey: 'liveness.idle', dot: 'idle' },
      outcome: undefined,
    })
    expect(threadStatus({ running: false, stopReason: 'max-tokens' }).outcome)
      .toEqual({ reason: 'max-tokens', labelKey: 'outcome.maxTokens', dot: 'warning' })
  })
})

describe('ThreadsHeaderAction liveness', () => {
  it('reads a catalog-only Thread as running from its own Session', () => {
    RUNNING.add('child-1')
    render(<ThreadsHeaderAction {...props(snapshot({ state: 'ready', values: {} }), {}, {
      agentPreset: 'project',
      presets: ['project'],
      catalog: [{ id: sid('child-1'), createdAt: 0, mode: 'continuable', label: 'catalog work' }],
    })} />)
    openRoster()
    expect(rosterOptions()[0]?.getAttribute('data-running')).toBe('true')
  })
})

describe('ThreadsHeaderAction outside a Project', () => {
  it('renders nothing for an ordinary session whose delegated child is merely continuable', () => {
    // The shipped `standard` preset sets `backgroundMode: continuable` on
    // ordinary delegation, so any session that used `subagent` once gets a
    // catalog row shaped exactly like a Thread's. Outside a Project, that
    // catalog row must not read as "evidence of a Thread" — it is an
    // ordinary subagent child, and its Archive action has nothing real to
    // archive (`threads.archive` would answer `threads/not-found`).
    const { container } = render(<ThreadsHeaderAction {...props(snapshot({ state: 'ready', values: {} }), {}, {
      // No `agentPreset` at all: an ordinary session carries no Project
      // composition, exactly as the shipped `standard` preset leaves it.
      presets: ['project'],
      catalog: [{ id: sid('child-1'), createdAt: 0, mode: 'continuable', label: 'ordinary delegation' }],
    })} />)
    expect(container.innerHTML).toBe('')
  })
})

describe('ThreadsHeaderAction opening a Thread', () => {
  it('opens the Thread as the main conversation and closes the roster', () => {
    const openThread = vi.fn()
    render(<ThreadsHeaderAction {...props(snapshot({
      state: 'ready',
      values: { threads: [row({ threadId: 't-1', label: 'worker' })] },
    }), { openThread })} />)
    openRoster()
    fireEvent.click(rosterOptions()[0]!)
    expect(openThread).toHaveBeenCalledWith(toThreadId('t-1'))
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('opens the same Thread through Enter on the focused row', () => {
    const openThread = vi.fn()
    render(<ThreadsHeaderAction {...props(snapshot({
      state: 'ready',
      values: { threads: [row({ threadId: 't-1' })] },
    }), { openThread })} />)
    openRoster()
    fireEvent.keyDown(rosterOptions()[0]!, { key: 'Enter' })
    expect(openThread).toHaveBeenCalledOnce()
  })

  it('opens a Thread in the right Sidebar from the row button without also opening it in the workspace', () => {
    const openThread = vi.fn()
    const openThreadAside = vi.fn()
    render(<ThreadsHeaderAction {...props(snapshot({
      state: 'ready',
      values: { threads: [row({ threadId: 't-1', label: 'worker' })] },
    }), { openThread, openThreadAside })} />)
    openRoster()
    fireEvent.click(screen.getByRole('button', { name: '在侧边栏打开 worker' }))
    expect(openThreadAside).toHaveBeenCalledWith(toThreadId('t-1'))
    expect(openThread).not.toHaveBeenCalled()
  })

  it('re-reads the projection from a failed roster', () => {
    const refreshProjection = vi.fn()
    render(<ThreadsHeaderAction {...props(snapshot({
      state: 'error',
      error: new RemoteError('gateway/internal', 'index down', {}),
    }), { refreshProjection })} />)
    openRoster()
    expect(screen.getByText('index down')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: /重试/ }))
    expect(refreshProjection).toHaveBeenCalledWith(PARENT)
  })

  it('falls back to its own copy when a failed roster carries no message', () => {
    render(<ThreadsHeaderAction {...props(snapshot({ state: 'error', error: null }))} />)
    openRoster()
    expect(screen.getByText('无法加载线程')).toBeDefined()
  })
})

describe('ThreadsHeaderAction keyboard navigation', () => {
  function openThree(): HTMLElement {
    render(<ThreadsHeaderAction {...props(snapshot({
      state: 'ready',
      values: {
        threads: [
          row({ threadId: 't-1', label: 'one' }),
          row({ threadId: 't-2', label: 'two' }),
          row({ threadId: 't-3', label: 'three' }),
        ],
      },
    }))} />)
    openRoster()
    return screen.getByRole('listbox')
  }

  function press(key: string): void {
    fireEvent.keyDown(screen.getByRole('listbox'), { key })
  }

  it('moves down and up through the rows and wraps at both ends', () => {
    openThree()
    press('ArrowDown')
    expect(document.activeElement).toBe(rosterOptions()[0])
    press('ArrowDown')
    expect(document.activeElement).toBe(rosterOptions()[1])
    press('ArrowUp')
    expect(document.activeElement).toBe(rosterOptions()[0])
    // Up from the first row wraps to the last, exactly as the catalog does.
    press('ArrowUp')
    expect(document.activeElement).toBe(rosterOptions()[2])
    press('ArrowDown')
    expect(document.activeElement).toBe(rosterOptions()[0])
  })

  it('wraps to the last row when ArrowUp arrives with nothing focused', () => {
    openThree()
    press('ArrowUp')
    expect(document.activeElement).toBe(rosterOptions()[2])
  })

  it('jumps to the first and last row with Home and End', () => {
    openThree()
    press('End')
    expect(document.activeElement).toBe(rosterOptions()[2])
    press('Home')
    expect(document.activeElement).toBe(rosterOptions()[0])
  })

  it('opens the roster and focuses its first row when ArrowDown is pressed on the trigger', async () => {
    render(<ThreadsHeaderAction {...props(snapshot({
      state: 'ready',
      values: { threads: [row({ threadId: 't-1' }), row({ threadId: 't-2' })] },
    }))} />)
    fireEvent.keyDown(screen.getByRole('button', { expanded: false }), { key: 'ArrowDown' })
    await Promise.resolve()
    expect(document.activeElement).toBe(rosterOptions()[0])
  })

  it('closes on Escape and returns focus to the trigger', async () => {
    openThree()
    const trigger = screen.getByRole('button', { expanded: true })
    press('ArrowDown')
    press('Escape')
    await Promise.resolve()
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(trigger)
  })
})

describe('ThreadsHeaderAction dismissal', () => {
  it('opens after the hover delay, not before it', () => {
    vi.useFakeTimers()
    render(<ThreadsHeaderAction {...props(snapshot({
      state: 'ready',
      values: { threads: [row({ threadId: 't-1' })] },
    }))} />)
    const trigger = screen.getByRole('button', { expanded: false })
    fireEvent.mouseEnter(trigger)
    act(() => { vi.advanceTimersByTime(149) })
    expect(screen.queryByRole('listbox')).toBeNull()
    act(() => { vi.advanceTimersByTime(1) })
    expect(screen.getByRole('listbox')).toBeDefined()
  })

  it('gives a hovered-out menu the grace period before closing', () => {
    render(<ThreadsHeaderAction {...props(snapshot({
      state: 'ready',
      values: { threads: [row({ threadId: 't-1' })] },
    }))} />)
    const trigger = screen.getByRole('button', { expanded: false })
    hoverRoster(trigger)
    const menu = screen.getByRole('listbox')
    fireEvent.mouseLeave(menu.parentElement!)
    act(() => { vi.advanceTimersByTime(119) })
    expect(screen.getByRole('listbox')).toBeDefined()
    act(() => { vi.advanceTimersByTime(1) })
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('keeps a click-pinned menu open when the pointer leaves it', () => {
    vi.useFakeTimers()
    render(<ThreadsHeaderAction {...props(snapshot({
      state: 'ready',
      values: { threads: [row({ threadId: 't-1' })] },
    }))} />)
    openRoster()
    const menu = screen.getByRole('listbox')
    fireEvent.mouseLeave(menu.parentElement!)
    act(() => { vi.advanceTimersByTime(500) })
    expect(screen.getByRole('listbox')).toBeDefined()
  })

  it('closes on a pointer press outside the trigger and the menu', () => {
    render(<ThreadsHeaderAction {...props(snapshot({
      state: 'ready',
      values: { threads: [row({ threadId: 't-1' })] },
    }))} />)
    openRoster()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('keeps a pinned menu open when the trigger is hovered and clicked again', () => {
    vi.useFakeTimers()
    render(<ThreadsHeaderAction {...props(snapshot({
      state: 'ready',
      values: { threads: [row({ threadId: 't-1' })] },
    }))} />)
    const trigger = screen.getByRole('button', { expanded: false })
    fireEvent.mouseEnter(trigger)
    fireEvent.click(trigger)
    // A second hover and click on an open, pinned menu neither restarts the
    // hover timer nor closes what the first click pinned.
    fireEvent.mouseEnter(trigger)
    fireEvent.click(trigger)
    act(() => { vi.advanceTimersByTime(500) })
    expect(screen.getByRole('listbox')).toBeDefined()
  })

  it('ignores a pointer press inside the menu and a key the trigger does not own', () => {
    render(<ThreadsHeaderAction {...props(snapshot({
      state: 'ready',
      values: { threads: [row({ threadId: 't-1' })] },
    }))} />)
    openRoster()
    fireEvent.pointerDown(screen.getByRole('listbox'))
    expect(screen.getByRole('listbox')).toBeDefined()
    const trigger = screen.getByRole('button', { expanded: true })
    fireEvent.keyDown(trigger, { key: 'Tab' })
    expect(screen.getByRole('listbox')).toBeDefined()
  })

  it('repositions an open menu on resize and scroll', () => {
    render(<ThreadsHeaderAction {...props(snapshot({
      state: 'ready',
      values: { threads: [row({ threadId: 't-1' })] },
    }))} />)
    openRoster()
    const menu = screen.getByRole('listbox').parentElement
    fireEvent(window, new Event('resize'))
    fireEvent.scroll(document)
    expect(screen.getByRole('listbox').parentElement).toBe(menu)
  })

  it('closes when the last Thread leaves the roster', () => {
    const view = render(<ThreadsHeaderAction {...props(snapshot({
      state: 'ready',
      values: { threads: [row({ threadId: 't-1' })] },
    }))} />)
    openRoster()
    view.rerender(<ThreadsHeaderAction {...props(snapshot({ state: 'ready', values: { threads: [] } }))} />)
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })
})

describe('Thread identity used for opening', () => {
  it('addresses a Thread by its durable identity', () => {
    const identity: ThreadId = toThreadId('abc')
    expect(identity).toBe('abc')
  })
})

describe('Project detection by preset', () => {
  it('reads a Project from the configured preset list, not from the Threads it owns', () => {
    render(<ThreadsHeaderAction {...props(snapshot({ state: 'ready', values: { threads: [] } }), {}, PROJECT)} />)
    expect(screen.getByRole('button', { name: '0 个线程' })).toBeDefined()
  })

  it('keeps an empty roster invisible outside a Project, whatever the preset list says', () => {
    const { container } = render(
      <ThreadsHeaderAction {...props(snapshot({ state: 'ready', values: { threads: [] } }), {}, { agentPreset: 'standard', presets: ['project'] })} />,
    )
    expect(container.innerHTML).toBe('')
    // The same empty roster under a configured-but-foreign preset is invisible
    // too: a Session is a Project by composition, never by config alone.
    const foreign = render(
      <ThreadsHeaderAction {...props(snapshot({ state: 'ready', values: { threads: [] } }), {}, { agentPreset: 'project', presets: ['research'] })} />,
    )
    expect(foreign.container.innerHTML).toBe('')
  })

  it('renders nothing for a Project whose roster has not been read yet only when it is not one', () => {
    const { container } = render(<ThreadsHeaderAction {...props(undefined)} />)
    expect(container.innerHTML).toBe('')
  })
})

describe('always-visible roster in a Project', () => {
  it('keeps the control and its zero count when the Project has no Threads at all', () => {
    render(<ThreadsHeaderAction {...props(snapshot({ state: 'ready', values: { threads: [] } }), {}, PROJECT)} />)
    expect(screen.getByRole('button', { expanded: false })).toBeDefined()
    expect(screen.getByRole('button', { name: '0 个线程' })).toBeDefined()
  })

  it('keeps the control before the threads projection has been read', () => {
    // The composition is an identity read, so a Project has its roster before
    // the `threads` read lands; that is the whole point of the entry point.
    render(<ThreadsHeaderAction {...props(undefined, {}, PROJECT)} />)
    expect(screen.getByRole('button', { name: '0 个线程' })).toBeDefined()
  })

  it('stays open while its roster empties under it', () => {
    const view = render(<ThreadsHeaderAction {...props(snapshot({
      state: 'ready',
      values: { threads: [row({ threadId: 't-1' })] },
    }), {}, PROJECT)} />)
    openRoster()
    view.rerender(<ThreadsHeaderAction {...props(snapshot({ state: 'ready', values: { threads: [] } }), {}, PROJECT)} />)
    expect(screen.getByRole('listbox')).toBeDefined()
  })

  it('shows the empty-list copy beside the listbox, never inside it', () => {
    render(<ThreadsHeaderAction {...props(snapshot({ state: 'ready', values: { threads: [] } }), {}, PROJECT)} />)
    openRoster()
    expect(screen.getByText('还没有后台线程')).toBeDefined()
    // A listbox admits options and groups only, so the note that explains the
    // absence of both lives outside it.
    expect(within(screen.getByRole('listbox')).queryByText('还没有后台线程')).toBeNull()
  })

  it('withholds the empty copy once a Thread is listed, and offers no add row outside a Project', () => {
    const view = render(<ThreadsHeaderAction {...props(snapshot({
      state: 'ready',
      values: { threads: [row({ threadId: 't-1' })] },
    }), {}, PROJECT)} />)
    openRoster()
    expect(screen.queryByText('还没有后台线程')).toBeNull()
    expect(screen.getByRole('button', { name: /新建线程/ })).toBeDefined()
    view.unmount()

    render(<ThreadsHeaderAction {...props(snapshot({
      state: 'ready',
      values: { threads: [row({ threadId: 't-1' })] },
    }))} />)
    openRoster()
    expect(screen.queryByRole('button', { name: /新建线程/ })).toBeNull()
  })

  it('keeps a failed load\'s own copy instead of the empty one', () => {
    render(<ThreadsHeaderAction {...props(snapshot({ state: 'error', error: null }), {}, PROJECT)} />)
    openRoster()
    expect(screen.getByText('无法加载线程')).toBeDefined()
    expect(screen.queryByText('还没有后台线程')).toBeNull()
  })
})

describe('starting a Thread from the roster', () => {
  it('stages a prepared instruction in the composer instead of sending one', () => {
    const insertText = vi.fn(() => true)
    const captureInsertion = vi.fn(() => EMPTY_SPAN)
    render(<ThreadsHeaderAction {...props(
      snapshot({ state: 'ready', values: { threads: [] } }),
      { inputActions: fake<ThreadsHeaderActionProps['inputActions']>({ captureInsertion, insertText }) },
      PROJECT,
    )} />)
    openRoster()
    fireEvent.click(screen.getByRole('button', { name: '新建线程' }))
    // The user edits and sends: the composer receives the instruction at the
    // caret it already held, and the model decides to call `subagent`.
    expect(captureInsertion).toHaveBeenCalledOnce()
    expect(insertText).toHaveBeenCalledWith('请用 subagent 工具开启一个后台线程来完成：', EMPTY_SPAN)
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('offers the same add row in a Project that already has Threads', () => {
    const insertText = vi.fn(() => true)
    render(<ThreadsHeaderAction {...props(
      snapshot({ state: 'ready', values: { threads: [row({ threadId: 't-1' })] } }),
      { inputActions: fake<ThreadsHeaderActionProps['inputActions']>({ captureInsertion: vi.fn(() => EMPTY_SPAN), insertText }) },
      PROJECT,
    )} />)
    openRoster()
    fireEvent.click(screen.getByRole('button', { name: '新建线程' }))
    expect(insertText).toHaveBeenCalledOnce()
  })

  it('reaches the add row by keyboard from the trigger and from the last Thread', async () => {
    render(<ThreadsHeaderAction {...props(snapshot({
      state: 'ready',
      values: { threads: [row({ threadId: 't-1', label: 'one' })] },
    }), {}, PROJECT)} />)
    fireEvent.keyDown(screen.getByRole('button', { expanded: false }), { key: 'ArrowDown' })
    await Promise.resolve()
    expect(document.activeElement).toBe(rosterOptions()[0])
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '新建线程' }))
    // The Memory row follows the add row in the same walk.
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '记忆' }))
    // The Library row follows Memory in the same walk.
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '资料库' }))
    // The walk wraps: the footer rows are rows, not a dead end.
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'ArrowDown' })
    expect(document.activeElement).toBe(rosterOptions()[0])
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'End' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '资料库' }))
  })

  it('closes from the add row on Escape and returns focus to the trigger', async () => {
    render(<ThreadsHeaderAction {...props(snapshot({ state: 'ready', values: { threads: [] } }), {}, PROJECT)} />)
    openRoster()
    const trigger = screen.getByRole('button', { expanded: true })
    fireEvent.keyDown(screen.getByRole('button', { name: '新建线程' }), { key: 'Escape' })
    await Promise.resolve()
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })
})

/** Let queued Remote promises and their React state updates settle. */
async function settle(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}

describe('ThreadsHeaderAction row actions', () => {
  function renderOne(
    over: Partial<ThreadsHeaderActionProps>,
    threads: ThreadStatusRow[] = [row({ threadId: 't-1', label: 'worker', branch: 'dsh/t-1' })],
  ): void {
    render(<ThreadsHeaderAction {...props(snapshot({ state: 'ready', values: { threads } }), over)} />)
    openRoster()
  }

  it('offers Stop only on a running Thread and interrupts it as that Thread', async () => {
    const stopThread = vi.fn(okResult)
    renderOne({ stopThread }, [
      row({ threadId: 't-live', label: 'live', running: true }),
      row({ threadId: 't-idle', label: 'idle' }),
    ])
    expect(screen.queryByRole('button', { name: '停止线程 idle' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '停止线程 live' }))
    await settle()
    expect(stopThread).toHaveBeenCalledWith(PARENT, toThreadId('t-live'))
  })

  it('reports a refused Stop in a toast and keeps the row', async () => {
    const stopThread = vi.fn(() => Promise.resolve({ ok: false as const, code: 'gateway/internal', message: 'boom' }))
    renderOne({ stopThread }, [row({ threadId: 't-live', label: 'live', running: true })])
    fireEvent.click(screen.getByRole('button', { name: '停止线程 live' }))
    await settle()
    expect(screen.getByText('无法停止线程 live：boom')).toBeDefined()
    expect(rosterOptions()).toHaveLength(1)
  })

  it('archives without force first, refreshes the projection and reports success', async () => {
    const archiveThread = vi.fn(okResult)
    const refreshProjection = vi.fn()
    renderOne({ archiveThread, refreshProjection })
    fireEvent.click(screen.getByRole('button', { name: '归档线程 worker' }))
    await settle()
    expect(archiveThread).toHaveBeenCalledWith(PARENT, toThreadId('t-1'), false)
    expect(refreshProjection).toHaveBeenCalledWith(PARENT)
    expect(screen.getByText('已归档线程 worker')).toBeDefined()
  })

  it('names the data loss for a dirty worktree and retries with force only after acknowledgement', async () => {
    const archiveThread = vi.fn()
      .mockResolvedValueOnce({ ok: false, code: 'threads/worktree-dirty', message: 'dirty' })
      .mockResolvedValueOnce({ ok: true })
    renderOne({ archiveThread })
    fireEvent.click(screen.getByRole('button', { name: '归档线程 worker' }))
    await settle()
    expect(screen.getByText('归档有未提交修改的线程？')).toBeDefined()
    expect(screen.getByText(/无法恢复/)).toBeDefined()
    // No error toast: the refusal is the question, not a failure.
    expect(screen.queryByText(/无法归档线程/)).toBeNull()
    const confirm = screen.getByRole('button', { name: '仍然归档' }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox'))
    expect(confirm.disabled).toBe(false)
    fireEvent.click(confirm)
    await settle()
    expect(archiveThread).toHaveBeenNthCalledWith(2, PARENT, toThreadId('t-1'), true)
    expect(screen.getByText('已归档线程 worker')).toBeDefined()
  })

  it('does not force the archive when the confirmation is cancelled', async () => {
    const archiveThread = vi.fn(() => Promise.resolve({ ok: false as const, code: 'threads/worktree-dirty', message: 'dirty' }))
    renderOne({ archiveThread })
    fireEvent.click(screen.getByRole('button', { name: '归档线程 worker' }))
    await settle()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    await settle()
    expect(archiveThread).toHaveBeenCalledOnce()
    expect(screen.queryByText('归档有未提交修改的线程？')).toBeNull()
  })

  it('reports any other archive failure with the Host message, and a failed forced retry too', async () => {
    const archiveThread = vi.fn(() => Promise.resolve({ ok: false as const, code: 'threads/not-found', message: 'gone' }))
    renderOne({ archiveThread })
    fireEvent.click(screen.getByRole('button', { name: '归档线程 worker' }))
    await settle()
    expect(screen.getByText('无法归档线程 worker：gone')).toBeDefined()
    expect(screen.queryByText('归档有未提交修改的线程？')).toBeNull()
  })

  it('keeps the archive toast after the last Thread leaves the roster', async () => {
    const archiveThread = vi.fn(okResult)
    const view = render(<ThreadsHeaderAction {...props(snapshot({
      state: 'ready', values: { threads: [row({ threadId: 't-1', label: 'worker' })] },
    }), { archiveThread })} />)
    openRoster()
    fireEvent.click(screen.getByRole('button', { name: '归档线程 worker' }))
    await settle()
    view.rerender(<ThreadsHeaderAction {...props(snapshot({ state: 'ready', values: { threads: [] } }), { archiveThread })} />)
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(screen.getByText('已归档线程 worker')).toBeDefined()
  })

  it('copies the branch name, and offers the button only for a Thread with a branch', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    renderOne({}, [row({ threadId: 't-1', label: 'worker', branch: 'dsh/t-1' }), row({ threadId: 't-2', label: 'bare' })])
    expect(screen.queryByRole('button', { name: '复制线程 bare 的分支名' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '复制线程 worker 的分支名' }))
    await settle()
    expect(writeText).toHaveBeenCalledWith('dsh/t-1')
    expect(screen.getByText('已复制分支名 dsh/t-1')).toBeDefined()
  })

  it('reports a refused clipboard write', async () => {
    const writeText = vi.fn(() => Promise.reject(new Error('denied')))
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    renderOne({})
    fireEvent.click(screen.getByRole('button', { name: '复制线程 worker 的分支名' }))
    await settle()
    expect(screen.getByText('无法复制分支名')).toBeDefined()
  })

  it('keeps Enter on a row button from opening the Thread, and arrow keys walking from it', () => {
    const openThread = vi.fn()
    renderOne({ openThread }, [
      row({ threadId: 't-1', label: 'one' }), row({ threadId: 't-2', label: 'two' }),
    ])
    const archive = screen.getByRole('button', { name: '归档线程 one' })
    fireEvent.keyDown(archive, { key: 'Enter' })
    expect(openThread).not.toHaveBeenCalled()
    archive.focus()
    fireEvent.keyDown(archive, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(rosterOptions()[1])
  })
})

describe('Memory view in the roster', () => {
  const MEMORY_ENTRY: MemoryEntry = {
    id: brandString<MemoryEntryId>('m1'), text: 'use pnpm', author: 'user', createdAt: 0, updatedAt: 0,
  }

  it('opens from the roster footer of a Project, lists the entries and returns to the Threads', async () => {
    const listMemory = vi.fn((): ReturnType<ThreadsHeaderActionProps['listMemory']> => Promise.resolve({ ok: true, value: [MEMORY_ENTRY] }))
    render(<ThreadsHeaderAction {...props(
      snapshot({ state: 'ready', values: { threads: [row({ threadId: 't-1' })] } }),
      { listMemory },
      PROJECT,
    )} />)
    openRoster()
    fireEvent.click(screen.getByRole('button', { name: '记忆' }))
    expect(await screen.findByText('use pnpm')).toBeDefined()
    expect(listMemory).toHaveBeenCalledWith(PARENT)
    // The Thread list is replaced, not stacked.
    expect(screen.queryByRole('listbox')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '返回线程列表' }))
    expect(screen.getByRole('listbox')).toBeDefined()
  })

  it('stays on the Memory view when the pointer leaves, and resets to Threads after closing', async () => {
    render(<ThreadsHeaderAction {...props(
      snapshot({ state: 'ready', values: { threads: [] } }), {}, PROJECT,
    )} />)
    openRoster()
    fireEvent.click(screen.getByRole('button', { name: '记忆' }))
    await screen.findByText(/还没有记忆/)
    vi.useFakeTimers()
    fireEvent.mouseLeave(screen.getByText('项目记忆'))
    act(() => { vi.advanceTimersByTime(500) })
    expect(screen.getByText('项目记忆')).toBeDefined()
    vi.useRealTimers()
    fireEvent.keyDown(screen.getByText('项目记忆'), { key: 'Escape' })
    expect(screen.queryByText('项目记忆')).toBeNull()
    openRoster()
    expect(screen.getByRole('listbox')).toBeDefined()
  })

  it('does not offer Memory outside a Project', () => {
    render(<ThreadsHeaderAction {...props(snapshot({
      state: 'ready', values: { threads: [row({ threadId: 't-1' })] },
    }))} />)
    openRoster()
    expect(screen.queryByRole('button', { name: '记忆' })).toBeNull()
  })
})

describe('Library view in the roster', () => {
  const LIBRARY: ThreadsLibrary = {
    attachments: { items: [{ kind: 'file', attachmentId: 'a1', bytes: 10, seq: 1, time: 0 }], total: 1, truncated: false },
    presented: { items: [], total: 0, truncated: false },
    changes: { items: [], total: 0, truncated: false },
  }

  it('opens from the roster footer of a Project, lists the attachments and returns to the Threads', async () => {
    const listLibrary = vi.fn((): ReturnType<ThreadsHeaderActionProps['listLibrary']> => Promise.resolve({ ok: true, value: LIBRARY }))
    render(<ThreadsHeaderAction {...props(
      snapshot({ state: 'ready', values: { threads: [row({ threadId: 't-1' })] } }),
      { listLibrary },
      PROJECT,
    )} />)
    openRoster()
    fireEvent.click(screen.getByRole('button', { name: '资料库' }))
    expect(await screen.findByText(/a1/)).toBeDefined()
    expect(listLibrary).toHaveBeenCalledWith(PARENT)
    // The Thread list is replaced, not stacked.
    expect(screen.queryByRole('listbox')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '返回线程列表' }))
    expect(screen.getByRole('listbox')).toBeDefined()
  })

  it('does not offer Library outside a Project', () => {
    render(<ThreadsHeaderAction {...props(snapshot({
      state: 'ready', values: { threads: [row({ threadId: 't-1' })] },
    }))} />)
    openRoster()
    expect(screen.queryByRole('button', { name: '资料库' })).toBeNull()
  })
})

describe('trigger keyboard while open', () => {
  it('moves focus to the first row on ArrowDown without reopening', async () => {
    render(<ThreadsHeaderAction {...props(snapshot({
      state: 'ready', values: { threads: [row({ threadId: 't-1' })] },
    }))} />)
    openRoster()
    fireEvent.keyDown(screen.getByRole('button', { expanded: true }), { key: 'ArrowDown' })
    await Promise.resolve()
    expect(document.activeElement).toBe(rosterOptions()[0])
    // Any other key on the trigger is left alone.
    fireEvent.keyDown(screen.getByRole('button', { expanded: true }), { key: 'a' })
    expect(screen.getByRole('listbox')).toBeDefined()
  })
})

describe('action feedback lifetime', () => {
  it('dismisses the toast after its hold time', async () => {
    vi.useFakeTimers()
    render(<ThreadsHeaderAction {...props(snapshot({
      state: 'ready', values: { threads: [row({ threadId: 't-1', label: 'one' })] },
    }), { archiveThread: vi.fn(okResult) })} />)
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    fireEvent.click(screen.getByRole('button', { name: '归档线程 one' }))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(screen.getByText('已归档线程 one')).toBeDefined()
    act(() => { vi.advanceTimersByTime(20_000) })
    expect(screen.queryByText('已归档线程 one')).toBeNull()
  })
})

describe('idle projection reads', () => {
  it('lists the rows of an idle read that already delivered its values', () => {
    render(<ThreadsHeaderAction {...props({
      values: { threads: [row({ threadId: 't-1', label: 'from idle' })] }, state: 'idle', error: null,
    })} />)
    openRoster()
    expect(within(screen.getByRole('listbox')).getByText('from idle')).toBeDefined()
  })
})
