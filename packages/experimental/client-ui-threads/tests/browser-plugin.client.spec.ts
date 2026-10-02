/** ui-threads browser half: the Thread roster seat, the New Project row, and the actions they bind. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { Context } from '@deepseek-ai/cordis'
import { stubConfigForm, TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { describe, expect, it, vi } from 'vitest'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ThreadId } from '@deepseek-ai/dsh-experimental-threads/types'
import { ThreadId as toThreadId } from '@deepseek-ai/dsh-experimental-threads/types'
import { apply as applyLocale, inject as localeInject } from '@deepseek-ai/dsh-client-locale/client'
import { ThreadsHeaderAction, type ThreadsRosterInjected } from '../src/client/ThreadsHeaderAction.tsx'
import { NewProjectFooterAction, type NewProjectInjected } from '../src/client/project/NewProjectFooterAction.tsx'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { ThreadHeaderAction } from '../src/client/ThreadChatHeader.tsx'
import { Config } from '../src/client/config.ts'
type IResources = { register: () => () => void }
import { fake, newProjectInjected, rosterInjectedFor, threadActionsInjected } from './support.client.ts'
import { inject, mountThreads } from '../src/client/mount.ts'

const sid = (id: string) => id as SessionId
const tid = (id: string) => toThreadId(id)

function summary(partial: Partial<SessionSummary> & { id: SessionId }): SessionSummary {
  return {
    displayTitle: partial.id,
    running: false,
    retainedBy: {},
    updatedAt: 0,
    ...partial,
  } as SessionSummary
}

/** Fake sessions face recording every navigation call the roster makes. */
function sessionsWith(sessions: SessionSummary[]) {
  const byId: Record<string, SessionSummary> = {}
  for (const s of sessions) byId[s.id] = s
  const snapshot: SessionListState = { ids: sessions.map(s => s.id), byId, phase: 'ready', projectionsBySession: {} }
  const actionCalls: { method: string; args: unknown[] }[] = []
  return {
    list: {
      getSnapshot: () => snapshot,
      subscribe: () => () => {},
    },
    actionCalls,
    create: (opts: unknown): Promise<SessionId> => {
      actionCalls.push({ method: 'create', args: [opts] })
      return Promise.resolve(sid('new-project'))
    },
    refreshProjections: (parentSessionId: SessionId) => {
      actionCalls.push({ method: 'refreshProjections', args: [parentSessionId] })
      return Promise.resolve()
    },
  }
}

async function provideSlotFaces(ctx: Context): Promise<void> {
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({
    name: 'root',
    children: {
      'conversation.session.header.actions': { kind: 'list', scope: 'session' },
      'sidebar.footer.action': { kind: 'list', scope: 'root' },
    },
  } as never, () => null)
}

/** Stand-in for the generated `threads` contribution; only its package name is observed. */
const FAKE_THREADS_REMOTE = fake<TypertRemoteContribution>({ package: '@deepseek-ai/dsh-experimental-threads' })
/** Stand-in for the generated `projectMemory` contribution. */
const FAKE_MEMORY_REMOTE = fake<TypertRemoteContribution>({ package: '@deepseek-ai/dsh-experimental-project-memory' })

type RemoteResultOf = { ok: true; value?: unknown } | { ok: false; error: { code: string; message: string } }

/** Scripted Remote namespaces; each call is also recorded in the bench's call log. */
interface BenchRemotes {
  select?: () => Promise<RemoteResultOf>
  archive?: () => Promise<RemoteResultOf>
  interrupt?: () => Promise<RemoteResultOf>
  memory?: () => Promise<RemoteResultOf>
}

/** Boot the plugin over fake sessions, scripted Remotes, and slot faces. */
async function fullBench(
  sessions: SessionSummary[],
  projectAgentPresets?: string[],
  remotes: BenchRemotes = {},
  face = sessionsWith(sessions),
) {
  const ctx = new Context()
  ctx.provide('sessions', face)
  ctx.provide('uiWorkspace', {
    openSession: (target: SessionId) => {
      face.actionCalls.push({ method: 'openSession', args: [target] })
    },
  } as never)
  ctx.provide('sidebarRight', {
    openResource: (address: string, options: unknown) => {
      face.actionCalls.push({ method: 'openResource', args: [address, options] })
    },
  } as never)
  const tabDefinitions: SidebarRightTabDefinition[] = []
  ctx.provide('resources', fake<IResources>({ register: () => () => {} }) as never)
  ctx.provide('sidebarRightTabs', fake<{ register: (definition: SidebarRightTabDefinition) => () => void }>({
    register: (definition) => {
      tabDefinitions.push(definition)
      return () => {}
    },
  }) as never)
  const mounts: string[] = []
  const remote = new TestRemote(ctx, {
    agentPresets: {
      select: (...args: unknown[]) => {
        face.actionCalls.push({ method: 'select', args })
        return (remotes.select ?? (() => Promise.resolve({ ok: true, value: 'project' })))()
      },
    },
    threads: {
      archive: (...args: unknown[]) => {
        face.actionCalls.push({ method: 'archive', args })
        return (remotes.archive ?? (() => Promise.resolve({ ok: true })))()
      },
    },
    projectMemory: {
      list: (...args: unknown[]) => {
        face.actionCalls.push({ method: 'memory.list', args })
        return (remotes.memory ?? (() => Promise.resolve({ ok: true, value: [] })))()
      },
      add: (...args: unknown[]) => {
        face.actionCalls.push({ method: 'memory.add', args })
        return (remotes.memory ?? (() => Promise.resolve({ ok: true, value: {} })))()
      },
      update: (...args: unknown[]) => {
        face.actionCalls.push({ method: 'memory.update', args })
        return (remotes.memory ?? (() => Promise.resolve({ ok: true, value: {} })))()
      },
      delete: (...args: unknown[]) => {
        face.actionCalls.push({ method: 'memory.delete', args })
        return (remotes.memory ?? (() => Promise.resolve({ ok: true, value: undefined })))()
      },
    },
    subagents: {
      interruptByParent: (...args: unknown[]) => {
        face.actionCalls.push({ method: 'interruptByParent', args })
        return (remotes.interrupt ?? (() => Promise.resolve({ ok: true })))()
      },
    },
  })
  // The scripted `threads` namespace stands in for the mounted generated one.
  remote.$mount = (contribution: TypertRemoteContribution) => {
    mounts.push(contribution.package)
    return Promise.resolve(() => Promise.resolve())
  }
  ctx.provide('configForms', { developerTools: { enabled: createSnapshotStore(true) }, get: () => stubConfigForm().scope } as never)
  await provideSlotFaces(ctx)
  await ctx.plugin({ inject: localeInject, apply: applyLocale }).await()
  await ctx.plugin({
    inject: [...inject],
    apply: (benchCtx: Context) => mountThreads(
      benchCtx,
      FAKE_THREADS_REMOTE,
      FAKE_MEMORY_REMOTE,
      projectAgentPresets === undefined ? Config({}) : Config({ projectAgentPresets }),
    ),
  }).await()
  return { face, ctx, mounts, tabDefinitions }
}

const PROJECT: SessionSummary[] = [summary({ id: sid('project'), displayTitle: 'Project' })]

/** The roster entry's injected actions for the Project Session. */
function actionsOf(ctx: Context): ThreadsRosterInjected {
  const entry = ctx.slots.entries('conversation.session.header.actions')
    .find(candidate => candidate.component === ThreadsHeaderAction)!
  return rosterInjectedFor(entry.inject, sid('project'))
}

describe('apply', () => {
  it('declares the services it binds', () => {
    expect(inject).toEqual([
      'sessions', 'uiWorkspace', 'slots', 'locale', 'sidebarRight',
      'remote', 'remote.agentPresets', 'remote.subagents',
    ])
  })

  it('mounts the threads and projectMemory Remote namespaces itself, before any registration can call them', async () => {
    const { mounts } = await fullBench(PROJECT)
    expect(mounts).toEqual([
      '@deepseek-ai/dsh-experimental-threads',
      '@deepseek-ai/dsh-experimental-project-memory',
    ])
  })

  it('withdraws both namespaces and rethrows when registration fails', async () => {
    const ctx = new Context()
    const withdrawn: string[] = []
    ctx.provide('remote', fake<{ $mount: (contribution: TypertRemoteContribution) => Promise<() => Promise<void>> }>({
      $mount: contribution => Promise.resolve(() => {
        withdrawn.push(contribution.package)
        return Promise.resolve()
      }),
    }) as never)
    // No `locale` service: registration throws after both mounts succeeded.
    await expect(mountThreads(ctx, FAKE_THREADS_REMOTE, FAKE_MEMORY_REMOTE, Config({}))).rejects.toThrow()
    expect(withdrawn).toEqual([
      '@deepseek-ai/dsh-experimental-project-memory',
      '@deepseek-ai/dsh-experimental-threads',
    ])
  })

  it('withdraws the threads namespace when the projectMemory mount fails', async () => {
    const ctx = new Context()
    const withdrawn = vi.fn(() => Promise.resolve())
    ctx.provide('remote', fake<{ $mount: (contribution: TypertRemoteContribution) => Promise<() => Promise<void>> }>({
      $mount: contribution => contribution === FAKE_MEMORY_REMOTE
        ? Promise.reject(new Error('mount refused'))
        : Promise.resolve(withdrawn),
    }) as never)
    await expect(mountThreads(ctx, FAKE_THREADS_REMOTE, FAKE_MEMORY_REMOTE, Config({}))).rejects.toThrow('mount refused')
    expect(withdrawn).toHaveBeenCalledOnce()
  })

  it('still withdraws the threads namespace when withdrawing projectMemory fails', async () => {
    const ctx = new Context()
    const withdrawnThreads = vi.fn(() => Promise.resolve())
    ctx.provide('remote', fake<{ $mount: (contribution: TypertRemoteContribution) => Promise<() => Promise<void>> }>({
      $mount: contribution => Promise.resolve(contribution === FAKE_MEMORY_REMOTE
        ? () => Promise.reject(new Error('unmount failed'))
        : withdrawnThreads),
    }) as never)
    // Registration fails (no locale), which unwinds through the failing disposer.
    await expect(mountThreads(ctx, FAKE_THREADS_REMOTE, FAKE_MEMORY_REMOTE, Config({}))).rejects.toThrow('unmount failed')
    expect(withdrawnThreads).toHaveBeenCalledOnce()
  })

  it('registers one header roster that routes a Thread into the workspace or the Sidebar', async () => {
    const { ctx, face } = await fullBench(PROJECT)
    const entry = ctx.slots.entries('conversation.session.header.actions')
      .find(candidate => candidate.component === ThreadsHeaderAction)!
    expect(entry.options.id).toBe('thread-roster')
    // Directly after the subagent catalog (-30) and ahead of Team navigation
    // (-20): a Thread is this Project's own background work.
    expect(entry.options.order).toBe(-25)

    const actions = rosterInjectedFor(entry.inject, sid('project'))
    actions.openThread(tid('thread-1'))
    actions.openThreadAside(tid('thread/1'))
    actions.refreshProjection(sid('project'))
    expect(face.actionCalls).toEqual([
      // The Thread opens as the Session that runs it.
      { method: 'openSession', args: ['thread-1'] },
      {
        method: 'openResource',
        args: [
          'dsh-resource://threadchat/session/thread%2F1?parent=project',
          { kind: 'threadchat', preferNewPane: true },
        ],
      },
      { method: 'refreshProjections', args: [sid('project')] },
    ])
  })

  it('names the owning Project Session in the address it hands the Sidebar', async () => {
    const { ctx, face } = await fullBench([...PROJECT, summary({ id: sid('other') })])
    const entry = ctx.slots.entries('conversation.session.header.actions')
      .find(candidate => candidate.component === ThreadsHeaderAction)!
    const actions = rosterInjectedFor(entry.inject, sid('other'))
    actions.openThreadAside(tid('t-9'))
    expect(face.actionCalls[0]).toEqual({
      method: 'openResource',
      args: ['dsh-resource://threadchat/session/t-9?parent=other', { kind: 'threadchat', preferNewPane: true }],
    })
  })

  it('types the roster action as the Thread identity, not a bare string', async () => {
    const { ctx } = await fullBench(PROJECT)
    const entry = ctx.slots.entries('conversation.session.header.actions')
      .find(candidate => candidate.component === ThreadsHeaderAction)!
    const actions = rosterInjectedFor(entry.inject, sid('project'))
    const identity: ThreadId = tid('t-1')
    expect(actions.openThread.length).toBe(1)
    expect(identity).toBe('t-1')
  })

  it('recognizes the shipped Project preset without deployment configuration', async () => {
    // The default is what actually reaches the browser, because a client row's
    // config is never delivered — so the shipped preset must be named here.
    const { ctx } = await fullBench(PROJECT)
    const entry = ctx.slots.entries('conversation.session.header.actions')
      .find(candidate => candidate.component === ThreadsHeaderAction)!
    const actions = rosterInjectedFor(entry.inject, sid('project'))
    expect(actions.projectAgentPresets).toEqual(['project'])
  })

  it('hands the roster the configured Project presets', async () => {
    const { ctx } = await fullBench(PROJECT, ['project'])
    const entry = ctx.slots.entries('conversation.session.header.actions')
      .find(candidate => candidate.component === ThreadsHeaderAction)!
    const actions = rosterInjectedFor(entry.inject, sid('project'))
    expect(actions.projectAgentPresets).toEqual(['project'])
  })
})

describe('Thread row Remote actions', () => {
  it('stops a Thread through the Project\'s parent-address interrupt', async () => {
    const { ctx, face } = await fullBench(PROJECT)
    await expect(actionsOf(ctx).stopThread(sid('project'), tid('thread-1'))).resolves.toEqual({ ok: true })
    expect(face.actionCalls).toEqual([
      { method: 'interruptByParent', args: ['thread-1', 'project', 'continuable'] },
    ])
  })

  it('archives through threads.archive with the force flag in an options bag', async () => {
    const { ctx, face } = await fullBench(PROJECT)
    await actionsOf(ctx).archiveThread(sid('project'), tid('thread-1'), false)
    await actionsOf(ctx).archiveThread(sid('project'), tid('thread-1'), true)
    expect(face.actionCalls).toEqual([
      { method: 'archive', args: ['project', 'thread-1', { force: false }] },
      { method: 'archive', args: ['project', 'thread-1', { force: true }] },
    ])
  })

  it('folds a Remote failure into its code and message', async () => {
    const { ctx } = await fullBench(PROJECT, undefined, {
      archive: () => Promise.resolve({ ok: false, error: { code: 'threads/worktree-dirty', message: 'dirty' } }),
      interrupt: () => Promise.resolve({ ok: false, error: { code: 'gateway/internal', message: 'down' } }),
    })
    await expect(actionsOf(ctx).archiveThread(sid('project'), tid('t'), false))
      .resolves.toEqual({ ok: false, code: 'threads/worktree-dirty', message: 'dirty' })
    await expect(actionsOf(ctx).stopThread(sid('project'), tid('t')))
      .resolves.toEqual({ ok: false, code: 'gateway/internal', message: 'down' })
  })
})

describe('Project memory Remote actions', () => {
  it('keys every request by the Project Session id', async () => {
    const { ctx, face } = await fullBench(PROJECT)
    const actions = actionsOf(ctx)
    await expect(actions.listMemory(sid('project'))).resolves.toEqual({ ok: true, value: [] })
    await actions.addMemory(sid('project'), 'use pnpm')
    await actions.updateMemory(sid('project'), 'm1' as never, 'use npm')
    await actions.removeMemory(sid('project'), 'm1' as never)
    expect(face.actionCalls).toEqual([
      { method: 'memory.list', args: [{ projectId: 'project' }] },
      { method: 'memory.add', args: [{ projectId: 'project', text: 'use pnpm' }] },
      { method: 'memory.update', args: [{ projectId: 'project', id: 'm1', text: 'use npm' }] },
      { method: 'memory.delete', args: [{ projectId: 'project', id: 'm1' }] },
    ])
  })

  it('folds a refusal into its code and message', async () => {
    const { ctx } = await fullBench(PROJECT, undefined, {
      memory: () => Promise.resolve({ ok: false, error: { code: 'project-memory/refused', message: 'The memory text is empty.' } }),
    })
    await expect(actionsOf(ctx).addMemory(sid('project'), ' '))
      .resolves.toEqual({ ok: false, code: 'project-memory/refused', message: 'The memory text is empty.' })
  })
})

describe('Thread chat tab', () => {
  it('registers the Thread chat type once the resource and Sidebar services exist', async () => {
    const { tabDefinitions } = await fullBench(PROJECT)
    expect(tabDefinitions.map(definition => definition.kind)).toEqual(['threadchat'])
  })
})

describe('Thread header', () => {
  it('registers a session-header entry that shares the roster\'s Thread actions', async () => {
    const { ctx, face } = await fullBench(PROJECT)
    const entry = ctx.slots.entries('conversation.session.header.actions')
      .find(candidate => candidate.component === ThreadHeaderAction)!
    expect(entry.options.id).toBe('thread-header')
    const actions = threadActionsInjected(entry.inject)
    await actions.stopThread(sid('project'), tid('thread-1'))
    expect(face.actionCalls).toEqual([
      { method: 'interruptByParent', args: ['thread-1', 'project', 'continuable'] },
    ])
  })
})

describe('New Project footer action', () => {
  function newProjectEntry(ctx: Context) {
    return ctx.slots.entries('sidebar.footer.action')
      .find(candidate => candidate.component === NewProjectFooterAction)!
  }
  function startProjectOf(ctx: Context): NewProjectInjected['startProject'] {
    return newProjectInjected(newProjectEntry(ctx).inject).startProject
  }

  it('registers in the sidebar footer, not in a Workspace row or a Session menu', async () => {
    const { ctx } = await fullBench(PROJECT, ['project'])
    const entry = newProjectEntry(ctx)
    expect(entry.options.id).toBe('new-project')
    expect(entry.locale).toBe('threads')
    for (const key of ['sidebar.workspaces.session.menu.item'] as const) {
      expect(ctx.slots.entries(key).some(candidate => candidate.component === NewProjectFooterAction)).toBe(false)
    }
  })

  it('creates the Session, selects the preset before the first turn, then opens it', async () => {
    const { ctx, face } = await fullBench(PROJECT, ['project'])
    await expect(startProjectOf(ctx)('ws/1' as WorkspaceId)).resolves.toEqual({ ok: true })
    expect(face.actionCalls).toEqual([
      { method: 'create', args: [{ workspaceId: 'ws/1' }] },
      { method: 'select', args: ['new-project', 'project'] },
      { method: 'openSession', args: [sid('new-project')] },
    ])
  })

  it('reports a creation that failed with a non-Error reason', async () => {
    const face = sessionsWith(PROJECT)
    // A Host rejection is not guaranteed to be an Error; the outcome must carry whatever it was.
    // oxlint-disable-next-line prefer-promise-reject-errors
    face.create = () => Promise.reject('pipe closed')
    const { ctx } = await fullBench(PROJECT, ['project'], {}, face)
    await expect(startProjectOf(ctx)('ws/1' as WorkspaceId))
      .resolves.toEqual({ ok: false, reason: 'create-failed', message: 'pipe closed' })
  })

  it('reports a missing Project preset without creating anything', async () => {
    const { ctx, face } = await fullBench(PROJECT, [])
    await expect(startProjectOf(ctx)('ws/1' as WorkspaceId)).resolves.toEqual({ ok: false, reason: 'unconfigured' })
    expect(face.actionCalls).toEqual([])
  })

  it('reports a refused creation without selecting or opening', async () => {
    const face = sessionsWith(PROJECT)
    face.create = () => Promise.reject(new Error('session create failed'))
    const { ctx } = await fullBench(PROJECT, ['project'], {}, face)
    await expect(startProjectOf(ctx)('ws/1' as WorkspaceId))
      .resolves.toEqual({ ok: false, reason: 'create-failed', message: 'session create failed' })
    expect(face.actionCalls).toEqual([])
  })

  it.each([
    ['agent-preset/not-found', { ok: false, reason: 'preset-not-found', preset: 'project' }],
    ['agent-preset/locked', { ok: false, reason: 'preset-locked', preset: 'project' }],
    ['agent-preset/invalid', { ok: false, reason: 'preset-failed', message: 'refused' }],
  ])('does not open the Session when preset selection fails with %s', async (code, expected) => {
    const { ctx, face } = await fullBench(PROJECT, ['project'], {
      select: () => Promise.resolve({ ok: false, error: { code, message: 'refused' } }),
    })
    await expect(startProjectOf(ctx)('ws/1' as WorkspaceId)).resolves.toEqual(expected)
    expect(face.actionCalls.map(call => call.method)).toEqual(['create', 'select'])
  })
})
