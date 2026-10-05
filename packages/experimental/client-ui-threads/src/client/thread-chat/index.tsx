/**
 * Right-Sidebar presentation of one background Thread's Conversation.
 *
 * This is the same proven path `dsh-client-ui-subagent` uses for a child
 * subagent Session: a resource provider retains the Session for the address's
 * lifetime, a `sidebar.right.pane.tab` type presents the retained reference,
 * and the shared `conversation.content` factory renders it with
 * `variant: 'embedded'` under a `SessionProvider`. No chat renderer is written
 * here — the Conversation the Thread already owns is the chat.
 */
import type { ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { ThreadId } from '@deepseek-ai/dsh-experimental-threads/client'
import type {
  ISessions, SessionReference,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { ResourceProvider } from '@deepseek-ai/dsh-client-resources/client'
import type { ConversationViewsProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {
  PropsLocale, PropsRenderFactories, PropsRenderSlots, PropsRuntime, TranslateNS,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { NS } from '../locales.ts'
import type { ThreadActionsInjected } from '../ThreadActions.tsx'
import { ThreadChatHeader } from '../ThreadChatHeader.tsx'
import css from './ThreadChat.module.css'

/** Stable implementation identity for the Sidebar tab body. */
export const THREAD_CHAT_ID = '@deepseek-ai/dsh-experimental-client-ui-threads'

/** Resource-address prefix for an embedded Thread Session chat. */
export const THREAD_CHAT_ADDRESS = 'dsh-resource://threadchat/session/'

/**
 * The Session identity a Thread is opened through.
 *
 * A Thread's durable identity IS the identity of the Session that runs it: the
 * worktree provider records `threadId: request.sessionId` when it prepares a
 * Thread's isolated checkout, so `ThreadId` and `SessionId` are the same string
 * in the wire vocabulary. This function is the one place that fact is asserted,
 * so a future provider that separates the two changes one line here instead of
 * every call site.
 * @param threadId - durable Thread identity.
 * @returns the Session that hosts that Thread.
 */
export function threadSessionId(threadId: ThreadId): SessionId {
  return sessionIdOfString(threadId)
}

/**
 * Re-brand a plain string as a Session identity. Both brands wrap `string`, so
 * widening to `string` first needs no `unknown` assertion.
 * @param id - the identity string.
 * @returns the same string typed as a Session identity.
 */
function sessionIdOfString(id: string): SessionId {
  return id as SessionId
}

/** One Thread chat address: the Thread, plus the Project Session that owns it. */
export interface ThreadChatAddress {
  /** The Project Session whose `threads` projection carried the row. */
  readonly parentSessionId: SessionId
  /** Durable identity of the Thread to open. */
  readonly threadId: ThreadId
}

/** Value retained by one live chat resource occurrence. */
export interface ThreadChatResource {
  readonly address: ThreadChatAddress
  readonly reference: SessionReference
}

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    threadChat: unknown
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface ResourceProtocolMap {
    threadchat: ThreadChatResource
  }

  interface SlotMap {
    /**
     * Session-scoped Conversation occurrence hosted by one Sidebar Thread chat
     * tab. Named apart from `sidebar.chat.conversation` so the two Thread-like
     * chat seats stay independent: this plugin loads and works without the
     * subagent catalog, and sharing a seat would make one package's absence
     * break the other's registration.
     */
    'sidebar.thread.chat.conversation': { kind: 'single'; scope: 'session' }
  }
}

/**
 * Address one Thread together with the Project Session that owns it.
 * @param address - the owning Project Session and the Thread to open.
 * @returns canonical Sidebar resource address.
 */
export function threadChatAddress(address: ThreadChatAddress): string {
  const query = new URLSearchParams({ parent: address.parentSessionId })
  return `${THREAD_CHAT_ADDRESS}${encodeURIComponent(address.threadId)}?${query}`
}

/**
 * Parse one canonical Sidebar chat resource address.
 * @param value - possible chat resource address.
 * @returns the encoded Thread address, or undefined for another or malformed resource.
 */
export function parseThreadChatAddress(value: string): ThreadChatAddress | undefined {
  let url: URL
  try {
    url = new URL(value)
  } catch (_invalidUrl) {
    return undefined
  }
  if (url.protocol !== 'dsh-resource:' || url.hostname.toLowerCase() !== 'threadchat') return undefined
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts.length !== 2 || parts[0] !== 'session') return undefined
  const parentSessionId = url.searchParams.get('parent')
  if (parentSessionId === null || parentSessionId === '') return undefined
  try {
    const threadId = decodeURIComponent(parts[1] as string)
    return { parentSessionId: parentSessionId as SessionId, threadId: threadId as ThreadId }
  } catch (_invalidEncoding) {
    return undefined
  }
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => { resolve() }, { once: true })
  })
}

function isAbortRequested(signal: AbortSignal): boolean {
  return signal.aborted
}

function threadChatResourceProvider(sessions: ISessions): ResourceProvider<'threadchat'> {
  return {
    protocol: 'threadchat',
    async *open(resourceAddress, { signal }) {
      const address = parseThreadChatAddress(resourceAddress)
      if (address === undefined) throw new Error(`ui-threads: invalid chat resource address "${resourceAddress}"`)
      if (isAbortRequested(signal)) return
      const reference = sessions.retain(threadSessionId(address.threadId), { source: 'threadChat', signal })
      try {
        yield { ok: true, value: { address, reference } }
        await waitForAbort(signal)
      } finally {
        reference.release()
      }
    },
  }
}

/** Fixed Chat selection used by an embedded Conversation occurrence. */
export function FixedChatConversationView(props: ConversationViewsProps) {
  return <>{props.renderSlot('conversation.session', { view: 'chat' })}</>
}

/** Props supplied to the Thread-Session Conversation host. */
export type ThreadConversationSlotPanelProps = PropsRuntime<'sidebar.thread.chat.conversation'> & PropsRenderFactories

/** Render the shared Conversation content for one explicitly provided Thread Session. */
export function ThreadConversationSlotPanel({
  sessionId, useSession, useConversation, useSessions, renderFactorySlot,
}: ThreadConversationSlotPanelProps) {
  const session = useSession(value => value)
  const conversation = useConversation(value => value)
  const active = conversation.activeTargets.size > 0
    || (!session.blank && !session.awaitingFirstTurn)
    || session.running
  const shellPhase = active ? 'active' : session.promptAttempted ? 'engaging' : 'blank'
  const summaryBlank = useSessions(state => state.byId[sessionId]?.blank)
  // A Thread chat is never waiting on a subagent parent the way a child
  // subagent chat is, so the only unknown is the history round-trip: while the
  // Thread is still replaying, hide the composer rather than flashing the
  // centered hero and snapping to the docked bar.
  const settling = shellPhase === 'blank' && session.openState === 'loading' && summaryBlank !== true
  const hero = shellPhase === 'blank' && (session.openState === 'open' || summaryBlank === true)
  const phase = settling ? 'settling' : hero ? 'hero' : 'active'
  return renderFactorySlot('conversation.content', { variant: 'embedded', phase, hero }, {
    slots: { views: FixedChatConversationView },
  })
}

/** Props supplied to the Project-Session Sidebar tab body. */
export type ThreadChatTabProps =
  PropsRuntime<'sidebar.right.pane.tab'> & PropsRenderSlots<'sidebar.thread.chat.conversation'> & {
    /** Header rendered above the Conversation for the addressed Thread. */
    renderHeader?: ((address: ThreadChatAddress) => ReactNode) | undefined
  }

/** Bind a chat resource's Thread reference around its Conversation slot. */
export function ThreadChatTab({ useResource, useTabInfo, SessionProvider, renderSlot, renderHeader }: ThreadChatTabProps) {
  const { tab } = useTabInfo()
  const resource = useResource<'threadchat'>(tab.contentId)
  return (
    <div className={css.root} data-thread-chat="">
      {resource.value === undefined
        ? null
        : (
          <>
            {renderHeader?.(resource.value.address)}
            <SessionProvider session={resource.value.reference}>
              {renderSlot('sidebar.thread.chat.conversation', {})}
            </SessionProvider>
          </>
        )}
    </div>
  )
}

/**
 * Sidebar tab body that adds the Thread header above the chat.
 * @param actions - Stop, Archive and projection refresh behind the header buttons.
 * @param projectAgentPresets - agent preset ids this deployment treats as Project identities.
 * @returns the tab component to register.
 */
function threadChatTabWithHeader(actions: ThreadActionsInjected, projectAgentPresets: readonly string[]) {
  return function ThreadChatTabWithHeader(props: ThreadChatTabProps & PropsLocale<typeof NS>) {
    return (
      <ThreadChatTab
        {...props}
        renderHeader={address => (
          <ThreadChatHeader
            {...actions}
            parentSessionId={address.parentSessionId}
            threadId={address.threadId}
            useSessions={props.useSessions}
            projectAgentPresets={projectAgentPresets}
            placement="tab"
            t={props.t}
          />
        )}
      />
    )
  }
}

/**
 * Register the Thread chat resource owner and its right-Sidebar presentation.
 * @param ctx - Client root carrying Sessions, resources, Slots, and Sidebar registries.
 * @param t - Chat namespace translator used for fallback tab titles.
 * @param actions - Thread actions behind the header above the chat.
 * @param projectAgentPresets - agent preset ids this deployment treats as Project identities.
 */
export function registerThreadChat(
  ctx: Context,
  t: TranslateNS<typeof NS>,
  actions: ThreadActionsInjected,
  projectAgentPresets: readonly string[],
): void {
  ctx.effect(
    () => ctx.resources.register(threadChatResourceProvider(ctx.sessions)),
    'ui-threads: Sidebar chat resources',
  )
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: THREAD_CHAT_ID,
    kind: 'threadchat',
    // Each Thread is its own conversation, so one page per kind would collapse
    // every Thread onto the first one opened.
    multiple: true,
    patterns: [`${THREAD_CHAT_ADDRESS}**`],
    priority: 'builtin',
    canOpen: address => parseThreadChatAddress(address) !== undefined,
    title: (address) => {
      const parsed = parseThreadChatAddress(address)
      if (parsed === undefined) return t('sidebar.chat')
      const row = ctx.sessions.list.getSnapshot().projectionsBySession[parsed.parentSessionId]
        ?.values.threads?.find(candidate => candidate.threadId === parsed.threadId)
      return row?.label ?? parsed.threadId
    },
  } satisfies SidebarRightTabDefinition), 'ui-threads: Sidebar chat type')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: THREAD_CHAT_ID,
    locale: NS,
    children: { 'sidebar.thread.chat.conversation': { kind: 'single', scope: 'session' } },
  }, threadChatTabWithHeader(actions, projectAgentPresets))), 'ui-threads: Sidebar chat body')
  ctx.effect(() => ctx.slots.inject('sidebar.thread.chat.conversation', () => ctx.slots.register({
    name: 'sidebar.thread.chat.conversation',
  }, ThreadConversationSlotPanel)), 'ui-threads: Sidebar Conversation')
}
