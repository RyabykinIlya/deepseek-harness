// @vitest-environment jsdom
/** The Thread header: status, branch, and the Stop and Archive actions shared with the roster. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionListState, SessionProjectionSnapshot, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ThreadId as toThreadId, type ThreadStatusRow } from '@deepseek-ai/dsh-experimental-threads/types'
import { ThreadChatHeader, ThreadHeaderAction, type ThreadChatHeaderProps, type ThreadHeaderActionProps } from '../src/client/ThreadChatHeader.tsx'
import { zh } from '../src/client/locales.ts'
import { threadSessionId } from '../src/client/thread-chat/index.tsx'
import { fake, okResult } from './support.client.ts'

afterEach(cleanup)

const PARENT = 'project/1' as SessionId
const THREAD = toThreadId('thread-1')
const THREAD_SESSION = threadSessionId(THREAD)
const t: ThreadChatHeaderProps['t'] = makeTranslate(zh)

function sessionsHook(rows: readonly ThreadStatusRow[] | undefined, running: boolean): ThreadChatHeaderProps['useSessions'] {
  const projection: SessionProjectionSnapshot | undefined = rows === undefined
    ? undefined
    : { state: 'ready', error: null, values: { threads: [...rows] } }
  const state = fake<SessionListState>({
    ids: [PARENT],
    byId: {
      [PARENT]: fake<SessionSummary>({ running: false }),
      [THREAD]: fake<SessionSummary>({ running, parentId: PARENT }),
    },
    phase: 'ready',
    projectionsBySession: projection === undefined ? {} : { [PARENT]: projection },
  })
  const hook = <T,>(select: (value: SessionListState) => T): T => select(state)
  return hook
}

type HeaderOverrides = Partial<ThreadChatHeaderProps> & { rows?: readonly ThreadStatusRow[]; running?: boolean }

function headerProps(over: HeaderOverrides = {}): ThreadChatHeaderProps {
  const { rows, running = false, ...rest } = over
  return {
    parentSessionId: PARENT,
    threadId: THREAD,
    useSessions: sessionsHook(rows ?? [{ threadId: THREAD, label: 'Indexer', branch: 'dsh/thread-1', stopReason: 'completed' }], running),
    refreshProjection: vi.fn(),
    stopThread: vi.fn(okResult),
    archiveThread: vi.fn(okResult),
    placement: 'tab',
    t,
    ...rest,
  }
}

describe('ThreadChatHeader', () => {
  it('shows the label, the last outcome, the idle state and the branch', () => {
    render(<ThreadChatHeader {...headerProps()} />)
    const header = screen.getByRole('group', { name: '线程 Indexer' })
    expect(header.getAttribute('data-thread-header')).toBe('tab')
    expect(header.textContent).toContain('Indexer')
    expect(header.textContent).toContain('未运行')
    expect(header.textContent).toContain('已完成')
    expect(screen.getByText('dsh/thread-1').getAttribute('title')).toBe('dsh/thread-1')
    // A settled Thread offers no Stop.
    expect(screen.queryByRole('button', { name: '停止线程 Indexer' })).toBeNull()
  })

  it('shows a running Thread without an outcome and stops it', async () => {
    const stopThread = vi.fn(okResult)
    render(<ThreadChatHeader {...headerProps({
      rows: [{ threadId: THREAD, label: '' }], running: true, stopThread,
    })} />)
    expect(screen.getByText('运行中')).toBeDefined()
    // An empty label falls back to the identity; no branch, no outcome.
    expect(screen.getByRole('group', { name: '线程 thread-1' })).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: '停止线程 thread-1' }))
    expect(stopThread).toHaveBeenCalledWith(PARENT, THREAD)
    await waitFor(() => { expect(screen.getByRole<HTMLButtonElement>('button', { name: '停止线程 thread-1' }).disabled).toBe(false) })
  })

  it('reports a failed stop in a toast', async () => {
    render(<ThreadChatHeader {...headerProps({
      running: true,
      stopThread: () => Promise.resolve({ ok: false, code: 'x', message: 'down' }),
    })} />)
    fireEvent.click(screen.getByRole('button', { name: '停止线程 Indexer' }))
    expect(await screen.findByText('无法停止线程 Indexer：down')).toBeDefined()
  })

  it('archives, refreshes the projection and confirms in a toast', async () => {
    const props = headerProps()
    render(<ThreadChatHeader {...props} />)
    fireEvent.click(screen.getByRole('button', { name: '归档线程 Indexer' }))
    expect(await screen.findByText('已归档线程 Indexer')).toBeDefined()
    expect(props.archiveThread).toHaveBeenCalledWith(PARENT, THREAD, false)
    expect(props.refreshProjection).toHaveBeenCalledWith(PARENT)
  })

  it('asks before discarding a dirty worktree, then forces the archive', async () => {
    const archiveThread = vi.fn((_owner: SessionId, _id: ThreadStatusRow['threadId'], force: boolean) =>
      Promise.resolve(force ? { ok: true as const } : { ok: false as const, code: 'threads/worktree-dirty', message: 'dirty' }))
    render(<ThreadChatHeader {...headerProps({ archiveThread })} />)
    fireEvent.click(screen.getByRole('button', { name: '归档线程 Indexer' }))
    fireEvent.click(await screen.findByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: '仍然归档' }))
    expect(await screen.findByText('已归档线程 Indexer')).toBeDefined()
    expect(archiveThread.mock.calls.map(call => call[2])).toEqual([false, true])
  })

  it('keeps the dirty confirmation closed when it is cancelled', async () => {
    render(<ThreadChatHeader {...headerProps({
      archiveThread: () => Promise.resolve({ ok: false, code: 'threads/worktree-dirty', message: 'dirty' }),
    })} />)
    fireEvent.click(screen.getByRole('button', { name: '归档线程 Indexer' }))
    fireEvent.click(await screen.findByRole('button', { name: '取消' }))
    await waitFor(() => { expect(screen.queryByRole('checkbox')).toBeNull() })
  })

  it('reports a refused archive', async () => {
    render(<ThreadChatHeader {...headerProps({
      archiveThread: () => Promise.resolve({ ok: false, code: 'x', message: 'busy' }),
    })} />)
    fireEvent.click(screen.getByRole('button', { name: '归档线程 Indexer' }))
    expect(await screen.findByText('无法归档线程 Indexer：busy')).toBeDefined()
  })

  it('renders nothing while the Project has no row for the Thread', () => {
    const { container } = render(<ThreadChatHeader {...headerProps({ rows: [] })} />)
    expect(container.querySelector('[data-thread-header]')).toBeNull()
  })
})

describe('ThreadHeaderAction', () => {
  function actionProps(parentId: SessionId | undefined): ThreadHeaderActionProps {
    const state = fake<SessionListState>({
      ids: [THREAD_SESSION],
      byId: { [THREAD]: fake<SessionSummary>({ running: false, ...parentId === undefined ? {} : { parentId } }) },
      phase: 'ready',
      projectionsBySession: { [PARENT]: { state: 'ready', error: null, values: { threads: [{ threadId: THREAD, label: 'Indexer' }] } } },
    })
    return fake<ThreadHeaderActionProps>({
      sessionId: THREAD_SESSION,
      useSessions: <T,>(select: (value: SessionListState) => T): T => select(state),
      refreshProjection: vi.fn(),
      stopThread: vi.fn(okResult),
      archiveThread: vi.fn(okResult),
      t,
    })
  }

  it('shows the header of a Thread opened as the main conversation, in the header band', () => {
    render(<ThreadHeaderAction {...actionProps(PARENT)} />)
    expect(screen.getByRole('group', { name: '线程 Indexer' }).getAttribute('data-thread-header')).toBe('header')
  })

  it('renders nothing for a Session that has no parent', () => {
    const { container } = render(<ThreadHeaderAction {...actionProps(undefined)} />)
    expect(container.innerHTML).toBe('')
  })
})
