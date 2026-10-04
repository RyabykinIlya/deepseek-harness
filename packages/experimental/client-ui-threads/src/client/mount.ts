/**
 * Lifecycle of the Threads browser half: mounts the `threads` Remote namespace
 * and registers the roster, the Thread chat resources, and the New Project
 * action. The generated Remote contribution is passed in so this module needs
 * no built artifact, and so the shipped Remote assembly (`dsh-api-remotes`)
 * never depends on this experimental package.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ThreadsHeaderAction, type ThreadsRosterInjected } from './ThreadsHeaderAction.tsx'
import { ProjectTokenUsage, type ProjectTokensInjected } from './ProjectTokenUsage.tsx'
import {
  NewProjectFooterAction, type NewProjectInjected, type NewProjectResult,
} from './project/NewProjectFooterAction.tsx'
import { toActionResult, toLibraryResult, toMemoryResult } from './actions.ts'
import { projectAgentPreset } from './project.ts'
import type { Config as ThreadsConfig } from './config.ts'
import { ThreadHeaderAction } from './ThreadChatHeader.tsx'
import type { ThreadActionsInjected } from './ThreadActions.tsx'
import { registerThreadChat, threadChatAddress, threadSessionId } from './thread-chat/index.tsx'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
// Type-only: pulls the `ctx.remote` merge and the Host namespace declarations
// (`subagents`, `agentPresets`) into this program.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: the generated `threads` Remote namespace declaration (`archive`).
import type {} from '@deepseek-ai/dsh-experimental-threads/remote'
// Type-only: the generated `projectMemory` Remote namespace declaration.
import type {} from '@deepseek-ai/dsh-experimental-project-memory/remote'
import type { ProjectId } from './memory-types.ts'
import { en, NS, zh } from './locales.ts'

/** Services the mount needs before it can run; `remote.threads` is provided by the mount itself. */
export const inject = [
  'sessions', 'uiWorkspace', 'slots', 'locale', 'sidebarRight',
  'remote', 'remote.agentPresets', 'remote.subagents',
]

/** Brand a Project Session id as the Project identity the memory service keys on (the same string). */
function projectIdOf(sessionId: SessionId): ProjectId {
  return String(sessionId) as ProjectId
}

/**
 * Mount the `threads` and `projectMemory` Remote namespaces, then register the
 * plugin's contributions.
 * @param ctx - client root context.
 * @param contribution - generated `threads` Remote contribution.
 * @param memoryContribution - generated `projectMemory` Remote contribution.
 * @param config - resolved plugin config; schema defaults apply.
 * @returns disposer withdrawing both Remote namespaces; the registrations are
 * effects of `ctx` and unwind with it.
 */
export async function mountThreads(
  ctx: ClientContext,
  contribution: TypertRemoteContribution,
  memoryContribution: TypertRemoteContribution,
  config: ThreadsConfig,
): Promise<() => Promise<void>> {
  const disposeThreads = await ctx.remote.$mount(contribution)
  let disposeMemory: () => Promise<void>
  try {
    disposeMemory = await ctx.remote.$mount(memoryContribution)
  } catch (error: unknown) {
    await disposeThreads()
    throw error
  }
  const dispose = async (): Promise<void> => {
    try {
      await disposeMemory()
    } finally {
      await disposeThreads()
    }
  }
  try {
    registerThreads(ctx, config)
  } catch (error: unknown) {
    await dispose()
    throw error
  }
  return dispose
}

/**
 * Register the dictionaries, the Thread chat resources, the header roster, and
 * the New Project footer action.
 * @param ctx - client root context.
 * @param config - resolved plugin config; schema defaults apply.
 */
function registerThreads(ctx: ClientContext, config: ThreadsConfig): void {
  // Schemastery's field default is materialized before Cordis calls apply.
  const projectAgentPresets = config.projectAgentPresets as readonly string[]
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-threads: dictionaries')
  const threadActions: ThreadActionsInjected = {
    refreshProjection: (ownerSessionId) => {
      void ctx.sessions.refreshProjections(ownerSessionId)
    },
    // The Project's durable parent-address authority interrupts the Thread
    // even when no turn of the Project itself is live.
    stopThread: async (owner, threadId) => toActionResult(
      await ctx.remote.subagents.interruptByParent(threadSessionId(threadId), owner, 'continuable'),
    ),
    archiveThread: async (owner, threadId, force) => toActionResult(
      await ctx.remote.threads.archive(owner, threadId, { force }),
    ),
  }
  ctx.inject(['resources', 'sidebarRightTabs'], (scope) => {
    registerThreadChat(scope, ctx.locale.bind(NS), threadActions)
  })
  const rosterActions = (parentSessionId: SessionId): ThreadsRosterInjected => ({
    ...threadActions,
    openThread: (threadId) => {
      ctx.uiWorkspace.openSession(threadSessionId(threadId))
    },
    openThreadAside: (threadId) => {
      // The address carries the owning Project Session, which is what the tab
      // title later reads the Thread's label from.
      ctx.sidebarRight.openResource(threadChatAddress({ parentSessionId, threadId }), {
        kind: 'threadchat',
        preferNewPane: true,
      })
    },
    listMemory: async projectId => toMemoryResult(await ctx.remote.projectMemory.list({ projectId: projectIdOf(projectId) })),
    addMemory: async (projectId, text) =>
      toMemoryResult(await ctx.remote.projectMemory.add({ projectId: projectIdOf(projectId), text })),
    updateMemory: async (projectId, id, text) =>
      toMemoryResult(await ctx.remote.projectMemory.update({ projectId: projectIdOf(projectId), id, text })),
    removeMemory: async (projectId, id) =>
      toMemoryResult(await ctx.remote.projectMemory.delete({ projectId: projectIdOf(projectId), id })),
    // `library`'s request is keyed by the Session id itself, unlike `projectMemory`'s branded `ProjectId`.
    listLibrary: async projectId => toLibraryResult(await ctx.remote.threads.library({ projectId })),
    projectAgentPresets,
  })
  ctx.slots.inject(
    'conversation.session.header.actions',
    () => ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'thread-roster',
      // Threads sit directly after the subagent catalog (-30), which leads the
      // band, and ahead of Team navigation (-20) and the preset label (-10):
      // a Thread is this Project's own background work, not a team member.
      order: -25,
      locale: NS,
      inject: rosterActions,
    }, ThreadsHeaderAction),
  )
  ctx.slots.inject(
    'conversation.session.header.actions',
    () => ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'thread-header',
      // A Thread's own header leads its band; the roster of a Project never shares a Session with it.
      order: -26,
      locale: NS,
      inject: () => threadActions,
    }, ThreadHeaderAction),
  )
  ctx.slots.inject(
    'conversation.session.header.actions',
    () => ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'project-tokens',
      // Directly after the roster (-25): the ledger counts exactly the Threads
      // the roster beside it lists, so the two read as one figure about the
      // Project's background work, ahead of Team navigation (-20).
      order: -24,
      locale: NS,
      inject: (): ProjectTokensInjected => ({ projectAgentPresets }),
    }, ProjectTokenUsage),
  )
  const newProjectActions = (): NewProjectInjected => ({
    startProject: async (workspaceId: WorkspaceId): Promise<NewProjectResult> => {
      const preset = projectAgentPreset(projectAgentPresets)
      if (preset === undefined) return { ok: false, reason: 'unconfigured' }
      let sessionId: SessionId
      try {
        sessionId = await ctx.sessions.create({ workspaceId })
      } catch (error: unknown) {
        return { ok: false, reason: 'create-failed', message: error instanceof Error ? error.message : String(error) }
      }
      // The composition is chosen while the Session is still blank, the same
      // call the agent-preset picker makes for a staged selection; the Host
      // refuses it once a turn has run. The Session opens only after it takes,
      // so the first prompt of a Project never runs under the default preset.
      const selected = await ctx.remote.agentPresets.select(sessionId, preset)
      if (!selected.ok) {
        const { code, message } = selected.error
        if (code === 'agent-preset/not-found') return { ok: false, reason: 'preset-not-found', preset }
        if (code === 'agent-preset/locked') return { ok: false, reason: 'preset-locked', preset }
        return { ok: false, reason: 'preset-failed', message }
      }
      ctx.uiWorkspace.openSession(sessionId)
      return { ok: true }
    },
  })
  ctx.slots.inject(
    'sidebar.footer.action',
    () => ctx.slots.register({
      name: 'sidebar.footer.action',
      // See NewProjectFooterAction for why this seat hosts the entry point.
      id: 'new-project',
      locale: NS,
      inject: newProjectActions,
    }, NewProjectFooterAction),
  )
}
