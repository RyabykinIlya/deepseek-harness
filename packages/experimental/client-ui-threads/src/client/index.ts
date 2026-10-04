/**
 * Threads plugin, browser half: contributes the Project Session's background
 * Thread roster to the conversation header, the aggregated `tokenUsage` of that
 * Project and its Threads beside it, the addressed Thread chat that opens
 * either as the main conversation or as a right-Sidebar tab, row actions (Stop,
 * Archive, Copy branch), and the New Project sidebar-footer action that starts
 * a Session composed from the Project preset.
 *
 * The plugin reads the `threads` and `agentPreset` Session projections the Host
 * already publishes, reads Thread liveness from the Session store, and renders
 * Threads through the shared Conversation factory rather than a Thread-specific
 * chat. Mutations go through `ctx.remote.threads` (mounted here, from the
 * generated contribution of the Threads domain package), `ctx.remote.subagents`,
 * and `ctx.remote.agentPresets`.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import threadsRemote from '@deepseek-ai/dsh-experimental-threads/remote'
import projectMemoryRemote from '@deepseek-ai/dsh-experimental-project-memory/remote'
import { Config, type Config as ThreadsConfig } from './config.ts'
import { mountThreads } from './mount.ts'

export { inject } from './mount.ts'

export { Config } from './config.ts'
export type { Config as ThreadsConfig } from './config.ts'
export { isProjectSession, projectAgentPreset } from './project.ts'
export type {
  NewProjectFailure, NewProjectFooterActionProps, NewProjectInjected, NewProjectResult,
} from './project/NewProjectFooterAction.tsx'
export type { LibraryResult, MemoryResult, ThreadActionResult } from './actions.ts'
export type { MemoryInjected, MemoryPanelProps } from './MemoryPanel.tsx'
export type { LibraryInjected, LibraryPanelProps } from './LibraryPanel.tsx'
export type { ThreadsHeaderActionProps, ThreadsRosterInjected } from './ThreadsHeaderAction.tsx'
export type { ProjectTokenUsageProps, ProjectTokensInjected } from './ProjectTokenUsage.tsx'
export { ProjectTokenUsage } from './ProjectTokenUsage.tsx'
export {
  aggregateTokenSpend, formatTokenCount, hasTokenSpend, isTokenBuckets,
} from './token-usage.ts'
export type { TokenBuckets, TokenSpend } from './token-usage.ts'
export { useProjectTokenUsage } from './useProjectTokenUsage.ts'
export type { ThreadRosterRow } from './roster.ts'
export type { ThreadLiveness, ThreadOutcome, ThreadOutcomeKey, ThreadStatus } from './ThreadStatus.tsx'
export { OutcomeGlyph, threadStatus } from './ThreadStatus.tsx'
export {
  parseThreadChatAddress, registerThreadChat, threadChatAddress, threadSessionId,
  THREAD_CHAT_ADDRESS, THREAD_CHAT_ID,
} from './thread-chat/index.tsx'
export type {
  ThreadChatAddress, ThreadChatResource, ThreadChatTabProps, ThreadConversationSlotPanelProps,
} from './thread-chat/index.tsx'

/**
 * Client plugin body: mount the `threads` and `projectMemory` Remote namespaces and register the
 * roster, the Thread chat resources, and the New Project action.
 * @param ctx - client root context.
 * @param config - resolved plugin config; schema defaults apply.
 * @returns disposer withdrawing both Remote namespaces.
 */
export async function apply(
  ctx: ClientContext,
  config: ThreadsConfig = Config({}),
): Promise<() => Promise<void>> {
  return await mountThreads(ctx, threadsRemote, projectMemoryRemote, config)
}
