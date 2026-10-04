// @vitest-environment jsdom
/** The Project header's token ledger: membership, the empty reading, and liveness of the figure. */
import { useSyncExternalStore } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionListState, SessionProjectionSnapshot, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ThreadId } from '@deepseek-ai/dsh-experimental-threads/types'
import { ThreadId as toThreadId } from '@deepseek-ai/dsh-experimental-threads/types'
import { ProjectTokenUsage, type ProjectTokenUsageProps } from '../src/client/ProjectTokenUsage.tsx'
import { en, zh } from '../src/client/locales.ts'
import { fake } from './support.client.ts'

afterEach(cleanup)

const PARENT = 'project/1' as SessionId
const t: ProjectTokenUsageProps['t'] = makeTranslate(zh)

/** One published `tokenUsage` value; every bucket defaults to zero. */
type PublishedUsage = {
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

function usage(over: Partial<PublishedUsage> = {}): PublishedUsage {
  return { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, ...over }
}

/** One Session's ready projection block. */
function block(values: SessionProjectionSnapshot['values']): SessionProjectionSnapshot {
  return { state: 'ready', error: null, values }
}

/** The Project's durable Thread rows, plus the Threads themselves as list rows. */
function threadValues(threads: readonly ThreadId[]): SessionProjectionSnapshot['values'] {
  return { threads: threads.map(threadId => ({ threadId, label: String(threadId) })) }
}

/**
 * One list snapshot: the Project row with its composition, its Threads' rows,
 * and the projection block each named Session published.
 * @param state.threads - the Threads the Project's roster owns.
 * @param state.blocks - a published block per Session, the Project included.
 */
function listState(state: {
  threads?: readonly ThreadId[]
  blocks?: Record<string, SessionProjectionSnapshot>
  agentPreset?: string
}): SessionListState {
  const threads = state.threads ?? []
  const { [PARENT]: projectBlock, ...threadBlocks } = state.blocks ?? {}
  const byId: Record<string, SessionSummary> = {
    [PARENT]: fake<SessionSummary>({
      running: false,
      ...state.agentPreset === undefined ? {} : { projectionValues: { agentPreset: state.agentPreset } },
    }),
    ...Object.fromEntries(threads.map(threadId => [
      threadId, fake<SessionSummary>({ running: false, parentId: PARENT }),
    ])),
  }
  return fake<SessionListState>({
    ids: [PARENT],
    byId,
    phase: 'ready',
    projectionsBySession: {
      [PARENT]: block({ ...threadValues(threads), ...projectBlock?.values }),
      ...threadBlocks,
    },
  })
}

/** A selector hook over one fixed snapshot, as every Session-scoped seat gets. */
function fixedSessions(state: SessionListState): ProjectTokenUsageProps['useSessions'] {
  return <T,>(select: (value: SessionListState) => T): T => select(state)
}

/** The Project identity this suite runs under. */
const PROJECT = { agentPreset: 'project' } as const

function props(over: Partial<ProjectTokenUsageProps> = {}): ProjectTokenUsageProps {
  return fake<ProjectTokenUsageProps>({
    sessionId: PARENT,
    useSessions: fixedSessions(listState(PROJECT)),
    projectAgentPresets: ['project'],
    t,
    ...over,
  })
}

describe('ProjectTokenUsage', () => {
  it('adds the Project\'s own usage to every Thread it owns', () => {
    render(<ProjectTokenUsage {...props({
      useSessions: fixedSessions(listState({
        ...PROJECT,
        threads: [toThreadId('thread-1'), toThreadId('thread-2')],
        blocks: {
          [PARENT]: block({ tokenUsage: usage({ uncachedInputTokens: 100, outputTokens: 20 }) }),
          'thread-1': block({ tokenUsage: usage({ uncachedInputTokens: 1_000, cacheReadTokens: 500, cacheWriteTokens: 200 }) }),
          'thread-2': block({ tokenUsage: usage({ outputTokens: 80 }) }),
        },
      })),
    })} />)
    // 100 + 20 + 1000 + 500 + 200 + 80 = 1900, over every Thread's four buckets.
    const ledger = screen.getByRole('group', { name: '项目 token 消耗：共 1.9K token' })
    expect(ledger.textContent).toBe('共 1.9K token')
    expect(ledger.getAttribute('title')).toBe('输入 1.1K · 输出 100 · 缓存读 500 · 缓存写 200')
  })

  it('counts a Thread the Project still owns after its durable row was archived', () => {
    // Archiving drops the durable row and the worktree but keeps the Thread's
    // Session and the Project's catalog entry, so the spend stays in the ledger.
    render(<ProjectTokenUsage {...props({
      useSessions: fixedSessions(listState({
        ...PROJECT,
        threads: [toThreadId('archived-thread')],
        blocks: {
          'archived-thread': block({ tokenUsage: usage({ uncachedInputTokens: 4_000 }) }),
        },
      })),
    })} />)
    expect(screen.getByText('共 4K token')).toBeDefined()
  })

  it('states that nothing has been recorded yet instead of showing a zero', () => {
    render(<ProjectTokenUsage {...props({
      useSessions: fixedSessions(listState({
        ...PROJECT,
        threads: [toThreadId('thread-1')],
        blocks: {
          [PARENT]: block({ tokenUsage: usage() }),
          'thread-1': block({ tokenUsage: usage() }),
        },
      })),
    })} />)
    const ledger = screen.getByRole('group', { name: '项目 token 消耗：尚未记录 token 消耗' })
    expect(ledger.textContent).toBe('尚未记录 token 消耗')
    // An empty reading carries no breakdown to state.
    expect(ledger.getAttribute('title')).toBeNull()
  })

  it('ignores a Thread whose projection block has not been published', () => {
    render(<ProjectTokenUsage {...props({
      useSessions: fixedSessions(listState({
        ...PROJECT,
        threads: [toThreadId('thread-1'), toThreadId('thread-2')],
        blocks: {
          [PARENT]: block({ tokenUsage: usage({ outputTokens: 250 }) }),
          'thread-2': block({ tokenUsage: usage({ outputTokens: 750 }) }),
        },
      })),
    })} />)
    // thread-1 is in the roster and has published nothing: nothing is estimated
    // for it, so the ledger is the two real readings and no more.
    expect(screen.getByRole('group', { name: '项目 token 消耗：共 1K token' }).textContent).toBe('共 1K token')
  })

  it('renders nothing outside a Project, whatever usage the Session published', () => {
    const { container } = render(<ProjectTokenUsage {...props({
      useSessions: fixedSessions(listState({
        agentPreset: 'standard',
        blocks: { [PARENT]: block({ tokenUsage: usage({ uncachedInputTokens: 900 }) }) },
      })),
      projectAgentPresets: ['project'],
    })} />)
    expect(container.innerHTML).toBe('')
    // A Session whose composition has not been read yet is unknown, not a Project.
    const unknown = render(<ProjectTokenUsage {...props({ useSessions: fixedSessions(listState({})) })} />)
    expect(unknown.container.innerHTML).toBe('')
  })

  it('speaks through the English dictionary when that is the active locale', () => {
    render(<ProjectTokenUsage {...props({
      useSessions: fixedSessions(listState({
        ...PROJECT,
        blocks: { [PARENT]: block({ tokenUsage: usage({ uncachedInputTokens: 12_249 }) }) },
      })),
      t: makeTranslate(en),
    })} />)
    const ledger = screen.getByRole('group', { name: 'Project token spend: 12.2K tokens' })
    expect(ledger.textContent).toBe('12.2K tokens')
    expect(ledger.getAttribute('title')).toBe('in 12.2K · out 0 · cache read 0 · cache write 0')
  })
})

describe('the ledger is live', () => {
  /** The real selector-hook shape: a uSES binding over a reactive snapshot. */
  function storeSessions(store: SnapshotStore<SessionListState>): ProjectTokenUsageProps['useSessions'] {
    return <T,>(select: (value: SessionListState) => T): T =>
      useSyncExternalStore(listener => store.subscribe(listener), () => select(store.getSnapshot()))
  }

  it('re-reads the projection when the store publishes a new value', () => {
    const store = createSnapshotStore(listState({
      ...PROJECT,
      threads: [toThreadId('thread-1')],
      blocks: {
        [PARENT]: block({ tokenUsage: usage({ uncachedInputTokens: 300 }) }),
        'thread-1': block({ tokenUsage: usage({ uncachedInputTokens: 200 }) }),
      },
    }))
    render(<ProjectTokenUsage {...props({ useSessions: storeSessions(store) })} />)
    expect(screen.getByText('共 500 token')).toBeDefined()

    // A Thread settles and the Project's own turn is billed: the same mounted
    // component must show the new sum without anything re-mounting it.
    act(() => {
      store.set(listState({
        ...PROJECT,
        threads: [toThreadId('thread-1')],
        blocks: {
          [PARENT]: block({ tokenUsage: usage({ uncachedInputTokens: 300, outputTokens: 150 }) }),
          'thread-1': block({ tokenUsage: usage({ uncachedInputTokens: 200, cacheReadTokens: 1_400 }) }),
        },
      }))
    })
    expect(screen.getByText('共 2.1K token')).toBeDefined()

    // A Thread is archived: it leaves the roster's durable rows, and with them
    // the figure a user has already seen does not silently shrink.
    act(() => {
      store.set(listState({
        ...PROJECT,
        blocks: { [PARENT]: block({ tokenUsage: usage({ uncachedInputTokens: 300, outputTokens: 150 }) }) },
      }))
    })
    expect(screen.getByText('共 450 token')).toBeDefined()
  })
})
