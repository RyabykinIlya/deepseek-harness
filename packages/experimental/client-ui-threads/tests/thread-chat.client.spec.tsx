// @vitest-environment jsdom
import type { ComponentType, ReactNode } from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type {
  ISessions, SessionListState, SessionReference, SessionSnapshot, SessionSummary,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { ResourceProvider } from '@deepseek-ai/dsh-client-resources/client'
import { sessionSnapshot } from '@deepseek-ai/dsh-client-test-runtime'
import { fake, okResult } from './support.client.ts'
import type { ThreadActionsInjected } from '../src/client/ThreadActions.tsx'
import type { ConversationViewsProps, UseConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ThreadId } from '@deepseek-ai/dsh-experimental-threads/types'
import { ThreadId as toThreadId } from '@deepseek-ai/dsh-experimental-threads/types'
import {
  FixedChatConversationView, parseThreadChatAddress, registerThreadChat, threadChatAddress,
  threadSessionId, ThreadChatTab, ThreadConversationSlotPanel, THREAD_CHAT_ID, type ThreadChatTabProps,
  type ThreadConversationSlotPanelProps,
} from '../src/client/thread-chat/index.tsx'

const PARENT = 'parent/a' as SessionId
const THREAD = 'thread#1' as ThreadId
const ADDRESS = { parentSessionId: PARENT, threadId: THREAD }

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const conversationHook: UseConversation = select =>
  select(fake<Parameters<Parameters<UseConversation>[0]>[0]>({ activeTargets: new Set() }))

/** Slot registrations and effect installs recorded by a stand-in Client root. */
function recordingContext(sessions: ISessions, overrides: Partial<Record<'resources' | 'sidebarRightTabs', object>> = {}) {
  const registrations: { options: Record<string, unknown>; component: unknown }[] = []
  const ctx = fake<Context>({
    sessions,
    resources: fake<Context['resources']>({ register: () => () => {}, ...overrides.resources }),
    sidebarRightTabs: fake<Context['sidebarRightTabs']>({ register: () => () => {}, ...overrides.sidebarRightTabs }),
    slots: fake<Context['slots']>({
      inject: (_name: string, install: () => () => void) => install(),
      register: (options: Record<string, unknown>, component: unknown) => {
        registrations.push({ options, component })
        return () => {}
      },
    }),
    effect: ((install: () => unknown) => { install(); return () => {} }) as Context['effect'],
  })
  return { ctx, registrations }
}

describe('Thread chat address', () => {
  it('round-trips the Thread identity and the owning Project Session', () => {
    const resource = threadChatAddress(ADDRESS)
    expect(resource).toBe('dsh-resource://threadchat/session/thread%231?parent=parent%2Fa')
    expect(parseThreadChatAddress(resource)).toEqual(ADDRESS)
  })

  it.each([
    'not an address',
    'https://chat/session/thread?parent=parent',
    'dsh-resource://other/session/thread?parent=parent',
    'dsh-resource://threadchat/other/thread?parent=parent',
    'dsh-resource://threadchat/session/thread',
    'dsh-resource://threadchat/session/thread?parent=',
    'dsh-resource://threadchat/session/?parent=parent',
    'dsh-resource://threadchat/session/%?parent=parent',
  ])('rejects %s', (address) => {
    expect(parseThreadChatAddress(address)).toBeUndefined()
  })

  it('opens a Thread through the Session that runs it', () => {
    expect(threadSessionId(THREAD)).toBe('thread#1')
  })
})

describe('Thread chat registration', () => {
  it('registers the resource, tab, and child slot and retains the Thread for the resource lifetime', async () => {
    const release = vi.fn()
    const reference = fake<SessionReference>({
      sessionId: threadSessionId(THREAD),
      release,
      [Symbol.dispose]: release,
    })
    const retain = vi.fn(() => reference)
    const refreshProjections = vi.fn(() => Promise.resolve())
    const list = {
      getSnapshot: () => fake<SessionListState>({
        ids: [],
        byId: {},
        phase: 'ready',
        projectionsBySession: {
          [PARENT]: {
            state: 'ready',
            error: null,
            values: { threads: [{ threadId: THREAD, label: 'Indexer' }] },
          },
        },
      }),
      subscribe: () => () => {},
    }
    let provider: ResourceProvider<'threadchat'> | undefined
    let definition: SidebarRightTabDefinition | undefined
    const { ctx, registrations } = recordingContext(fake<ISessions>({ retain, refreshProjections, list }), {
      resources: { register: (value: ResourceProvider<'threadchat'>) => { provider = value; return () => {} } },
      sidebarRightTabs: { register: (value: SidebarRightTabDefinition) => { definition = value; return () => {} } },
    })

    const actions: ThreadActionsInjected = {
      refreshProjection: vi.fn(),
      stopThread: vi.fn(okResult),
      archiveThread: vi.fn(okResult),
    }
    registerThreadChat(ctx, (key: string) => key === 'sidebar.chat' ? 'Chat' : key, actions, [])

    expect(definition?.id).toBe(THREAD_CHAT_ID)
    expect(definition?.kind).toBe('threadchat')
    // Each Thread is its own conversation, so one page per kind would collapse
    // every Thread onto the first one opened.
    expect(definition?.multiple).toBe(true)
    expect(definition?.patterns).toEqual(['dsh-resource://threadchat/session/**'])
    expect(definition?.canOpen?.(threadChatAddress(ADDRESS))).toBe(true)
    expect(definition?.canOpen?.('dsh-resource://threadchat/invalid')).toBe(false)
    // The chip names the Thread by its projected label, not by its identity.
    expect(definition?.title(threadChatAddress(ADDRESS))).toBe('Indexer')
    expect(definition?.title(threadChatAddress({
      parentSessionId: PARENT,
      threadId: toThreadId('unknown'),
    }))).toBe('unknown')
    expect(definition?.title('invalid')).toBe('Chat')
    expect(registrations.map(entry => entry.options.name)).toEqual([
      'sidebar.right.pane.tab',
      'sidebar.thread.chat.conversation',
    ])

    const controller = new AbortController()
    const stream = provider!.open(threadChatAddress(ADDRESS), { signal: controller.signal })[Symbol.asyncIterator]()
    expect(await stream.next()).toEqual({ done: false, value: { ok: true, value: { address: ADDRESS, reference } } })
    expect(refreshProjections).not.toHaveBeenCalled()
    expect(retain).toHaveBeenCalledWith('thread#1', { source: 'threadChat', signal: controller.signal })
    const completion = stream.next()
    await Promise.resolve()
    controller.abort()
    expect(await completion).toEqual({ done: true, value: undefined })
    expect(release).toHaveBeenCalledOnce()

    const abortedAfterYield = new AbortController()
    const yielded = provider!.open(threadChatAddress(ADDRESS), { signal: abortedAfterYield.signal })[Symbol.asyncIterator]()
    expect((await yielded.next()).done).toBe(false)
    abortedAfterYield.abort()
    expect(await yielded.next()).toEqual({ done: true, value: undefined })
    expect(release).toHaveBeenCalledTimes(2)

    const alreadyAborted = new AbortController()
    alreadyAborted.abort()
    const stopped = provider!.open(threadChatAddress(ADDRESS), { signal: alreadyAborted.signal })[Symbol.asyncIterator]()
    expect(await stopped.next()).toEqual({ done: true, value: undefined })
    expect(retain).toHaveBeenCalledTimes(2)
    expect(release).toHaveBeenCalledTimes(2)

    const invalid = provider!.open('invalid', { signal: new AbortController().signal })[Symbol.asyncIterator]()
    await expect(invalid.next()).rejects.toThrow('invalid chat resource address')
  })
})

describe('Thread chat components', () => {
  it('binds a live resource reference around the Thread Session slot', () => {
    const reference = fake<SessionReference>({ sessionId: threadSessionId(THREAD) })
    let snapshot: { status: string; value: unknown; failure: undefined } = { status: 'loading', value: undefined, failure: undefined }
    const SessionProvider = vi.fn(({ children }: { children: ReactNode }) => <>{children}</>)
    const renderSlot = vi.fn(() => <span>thread conversation</span>)
    const renderHeader = vi.fn(() => <span>thread header</span>)
    const props = fake<ThreadChatTabProps>({
      useTabInfo: () => fake<ReturnType<ThreadChatTabProps['useTabInfo']>>({ tab: fake<ReturnType<ThreadChatTabProps['useTabInfo']>['tab']>({ contentId: threadChatAddress(ADDRESS) }) }),
      useResource: (() => snapshot) as never,
      SessionProvider,
      renderSlot,
      renderHeader,
    })
    const view = render(<ThreadChatTab {...props} />)
    expect(view.container.textContent).toBe('')
    expect(renderHeader).not.toHaveBeenCalled()

    snapshot = { status: 'live', value: { address: ADDRESS, reference }, failure: undefined }
    view.rerender(<ThreadChatTab {...props} />)
    expect(view.getByText('thread conversation')).toBeTruthy()
    expect(view.getByText('thread header')).toBeTruthy()
    expect(renderHeader).toHaveBeenCalledWith(ADDRESS)
    expect(SessionProvider).toHaveBeenCalledWith(expect.objectContaining({ session: reference }), {})
    expect(renderSlot).toHaveBeenCalledWith('sidebar.thread.chat.conversation', {})
  })

  it.each<{ name: string; session: Partial<SessionSnapshot>; summaryBlank: boolean; expected: { phase: string; hero: boolean } }>([
    {
      name: 'active',
      session: { blank: false, awaitingFirstTurn: false, running: false },
      summaryBlank: false,
      expected: { phase: 'active', hero: false },
    },
    {
      name: 'hero',
      session: { blank: true, awaitingFirstTurn: true, running: false, openState: 'open' },
      summaryBlank: true,
      expected: { phase: 'hero', hero: true },
    },
    {
      name: 'prompt attempted',
      session: { blank: true, awaitingFirstTurn: true, running: false, openState: 'open', promptAttempted: true },
      summaryBlank: false,
      expected: { phase: 'active', hero: false },
    },
    {
      name: 'replaying history',
      session: { blank: true, awaitingFirstTurn: true, running: false, openState: 'loading' },
      summaryBlank: false,
      expected: { phase: 'settling', hero: false },
    },
    {
      name: 'a live Thread',
      session: { blank: true, awaitingFirstTurn: true, running: true, openState: 'open' },
      summaryBlank: true,
      expected: { phase: 'active', hero: false },
    },
  ])('derives the $name embedded phase and fixes the local view to Chat', ({ session: patch, summaryBlank, expected }) => {
    const snapshot: SessionSnapshot = { ...sessionSnapshot(threadSessionId(THREAD)), ...patch }
    const renderFactorySlot = vi.fn(() => null)
    render(<ThreadConversationSlotPanel {...fake<ThreadConversationSlotPanelProps>({
      sessionId: threadSessionId(THREAD),
      useSession: <R,>(select: (value: SessionSnapshot) => R): R => select(snapshot),
      useConversation: conversationHook,
      useSessions: <R,>(select: (value: SessionListState) => R): R => select(fake<SessionListState>({
        ids: [],
        byId: { [threadSessionId(THREAD)]: fake<SessionSummary>({ blank: summaryBlank }) },
        phase: 'ready',
        projectionsBySession: {},
      })),
      renderFactorySlot,
    })} />)
    expect(renderFactorySlot).toHaveBeenCalledWith(
      'conversation.content',
      { variant: 'embedded', ...expected },
      { slots: { views: FixedChatConversationView } },
    )
  })

  it('renders the header above the chat in the registered Sidebar tab body', () => {
    const { ctx, registrations } = recordingContext(fake<ISessions>({
      list: fake<ISessions['list']>({ getSnapshot: () => fake<SessionListState>({}), subscribe: () => () => {} }),
    }))
    registerThreadChat(ctx, key => key, {
      refreshProjection: vi.fn(),
      stopThread: vi.fn(okResult),
      archiveThread: vi.fn(okResult),
    }, [])
    const Tab = registrations[0]!.component as ComponentType<ThreadChatTabProps & { t: (key: string) => string }>
    const state = fake<SessionListState>({
      ids: [],
      byId: {},
      phase: 'ready',
      projectionsBySession: {
        [PARENT]: { state: 'ready', error: null, values: { threads: [{ threadId: THREAD, label: 'Indexer' }] } },
      },
    })
    const props = fake<ThreadChatTabProps & { t: (key: string) => string }>({
      useTabInfo: () => fake<ReturnType<ThreadChatTabProps['useTabInfo']>>({ tab: fake<ReturnType<ThreadChatTabProps['useTabInfo']>['tab']>({ contentId: threadChatAddress(ADDRESS) }) }),
      useResource: (() => ({ status: 'live', value: { address: ADDRESS, reference: fake<SessionReference>({}) }, failure: undefined })) as never,
      useSessions: <R,>(select: (value: SessionListState) => R): R => select(state),
      SessionProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
      renderSlot: () => <span>thread conversation</span>,
      t: key => key,
    })
    const view = render(<Tab {...props} />)
    expect(view.getByRole('group').getAttribute('data-thread-header')).toBe('tab')
    expect(view.getByText('thread conversation')).toBeTruthy()
    expect(registrations[0]!.options.locale).toBe('threads')
  })

  it('renders the Thread through the shared Conversation Session slot, not a Thread-specific chat', () => {
    const renderSlot = vi.fn(() => null)
    render(<FixedChatConversationView {...fake<ConversationViewsProps>({ renderSlot })} />)
    expect(renderSlot).toHaveBeenCalledWith('conversation.session', { view: 'chat' })
  })
})
