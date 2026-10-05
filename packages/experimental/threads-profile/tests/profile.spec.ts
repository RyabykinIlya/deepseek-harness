/**
 * The Threads profile bundle: its patch document, and the real Loader
 * composition it produces beside the shipped agent plane.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as yaml from 'js-yaml'
import { Context } from '@deepseek-ai/cordis'
import Group from '@deepseek-ai/cordis-plugin-group'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentPreset from '@deepseek-ai/dsh-agent-preset'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import * as ClientUiProjectMemory from '@deepseek-ai/dsh-experimental-client-ui-project-memory'
import * as ClientUiThreads from '@deepseek-ai/dsh-experimental-client-ui-threads'
import * as Threads from '@deepseek-ai/dsh-experimental-threads'
import * as ThreadsPreset from '@deepseek-ai/dsh-experimental-threads-preset'
import { THREADS_CONTEXT_NAME, THREAD_WORKER_CONTEXT_NAME } from '@deepseek-ai/dsh-experimental-threads-preset'
import * as ThreadsTool from '@deepseek-ai/dsh-experimental-threads-tool'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { ContinuableCreateSpec, SubagentProvider } from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { TestSessionQuery } from '../../../subagent/subagent/tests/test-session-query.ts'

interface Row {
  id?: string
  name?: string
  disabled?: boolean
  config?: Record<string, unknown>
  insert?: Row[]
}

const root = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  name?: string
  private?: boolean
  icon?: string
  publishConfig?: { access?: string }
  exports?: Record<string, unknown>
  dependencies?: Record<string, string>
  dsh?: { bundle?: { patch?: string } }
}
const patches = yaml.load(
  readFileSync(resolve(root, manifest.dsh!.bundle!.patch!), 'utf8'),
  { schema: entryListSchema },
) as Row[]
const inserted = patches.flatMap(patch => patch.insert ?? [])

describe('Threads profile bundle', () => {
  it('declares a public parseable layer whose rows resolve from the bundle', () => {
    expect(manifest.name).toBe('@deepseek-ai/dsh-experimental-threads-profile')
    expect(manifest.private).toBeUndefined()
    expect(manifest.publishConfig?.access).toBe('public')
    expect(manifest.icon).toBe('./icon.svg')
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.exports?.['./cordis.patch.yml']).toBe('./cordis.patch.yml')
    const declared = new Set(Object.keys(manifest.dependencies ?? {}))
    for (const row of inserted) {
      expect(declared.has(row.name!), `${row.id}: ${row.name} is not a bundle dependency`).toBe(true)
    }
    // The preset resolves the Thread tools by their published name from the profile's own base.
    expect(declared.has('@deepseek-ai/dsh-experimental-threads-tool')).toBe(true)
    expect(Object.values(manifest.dependencies ?? {}).every(range => range === 'workspace:*')).toBe(true)
  })

  it('only inserts rows: nothing the base layers ship is repointed or disabled', () => {
    expect(patches).toHaveLength(1)
    expect(Object.keys(patches[0]!)).toEqual(['insert'])
    expect(Array.isArray(patches[0]!.insert)).toBe(true)
    expect(patches.some(patch => patch.id !== undefined || patch.disabled !== undefined)).toBe(false)
    const ids = inserted.map(row => row.id)
    expect(ids).toEqual([
      'worktree-manager', 'threads', 'subagent-thread-worktree', 'ui-threads', 'ui-project-memory',
      'project-memory', 'threads-preset',
    ])
    expect(ids).toHaveLength(new Set(ids).size)
  })

  it('wires the worktree row, the provider, and the presets to the same names', () => {
    const byId = (id: string): Row => inserted.find(row => row.id === id)!
    expect(byId('worktree-manager')).toMatchObject({
      name: '@deepseek-ai/dsh-worktree-manager',
      config: { pruneOnStart: true },
    })
    expect(byId('threads').name).toBe('@deepseek-ai/dsh-experimental-threads')
    expect(byId('subagent-thread-worktree')).toMatchObject({
      name: '@deepseek-ai/dsh-subagent-thread-worktree',
      config: {
        providerName: 'thread',
        branchPerThread: true,
        branchTemplate: 'dsh/thread-{{id}}',
        childAgentPreset: 'project-thread',
      },
    })
    // A client row's config never reaches the browser, so the row carries none.
    expect(byId('ui-threads')).toEqual({ id: 'ui-threads', name: '@deepseek-ai/dsh-experimental-client-ui-threads' })
    expect(byId('ui-project-memory')).toEqual({ id: 'ui-project-memory', name: '@deepseek-ai/dsh-experimental-client-ui-project-memory' })
    const preset = byId('threads-preset')
    expect(preset.name).toBe('@deepseek-ai/dsh-experimental-threads-preset')
    expect(preset.config).toMatchObject({
      id: 'project',
      workerId: byId('subagent-thread-worktree').config!.childAgentPreset,
      provider: byId('subagent-thread-worktree').config!.providerName,
      basePreset: 'standard',
      workerMaxDepth: 2,
      tools: { defaultLimit: 20, maxLimit: 100 },
    })
    expect(inserted.some(row => row.id === 'tool-threads')).toBe(false)
    expect(JSON.stringify(patches)).not.toContain('projectAgentPresets')
  })
})

// Real composition: the Loader boots the shipped agent-plane shape with and without this bundle.

const SIGNAL = new AbortController().signal
const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

/** A module the Loader imports by file URL from the source tree. */
function source(path: string): string {
  return new URL(`../../../${path}`, import.meta.url).href
}

/**
 * The `standard` preset as the Web layer ships it for this surface: the plain
 * tools plus the ordinary delegation group (spawn provider, fork excluded because
 * its provider needs no Thread-specific behaviour here).
 */
const STANDARD_PLUGINS = [
  { id: 'tool-todo', name: source('todo/tool-todo/src/index.ts'), config: { allowParallelInProgress: true } },
  { id: 'tool-subagent-control', name: source('subagent/tool-subagent-control/src/index.ts') },
  { id: 'tool-subagent-list-agents', name: source('subagent/tool-subagent-control/src/list-agents.ts') },
  {
    id: 'tool-subagent',
    name: source('subagent/tool-subagent/src/index.ts'),
    config: { provider: 'spawn', toolName: 'subagent', backgroundMode: 'continuable' },
  },
]

/**
 * Stand-in for the git-backed `thread` provider. The real provider is covered by
 * its own package; here it answers `prepareContinuable` the way its configuration
 * says, with the configured `childAgentPreset`.
 */
const ThreadProviderStandIn = {
  name: 'subagent-thread-worktree',
  inject: ['subagents'],
  apply(ctx: Context, config: { providerName: string; childAgentPreset?: string }): void {
    const provider: SubagentProvider = {
      name: config.providerName,
      capabilities: { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
      inheritsParentContext: false,
      start: () => Promise.reject(new Error('the Thread stand-in only prepares continuable children')),
      prepareContinuable: (): Promise<ContinuableCreateSpec> => Promise.resolve(
        config.childAgentPreset === undefined ? {} : { agentPreset: config.childAgentPreset },
      ),
    }
    ctx.effect(() => ctx.subagents.registerProvider(provider), 'thread-provider-stand-in')
  },
}

const WorktreeManagerStandIn = { name: 'worktree-manager', apply(): void {} }
const ProjectMemoryStandIn = { name: 'project-memory', apply(): void {} }

/**
 * Boot one composition through the Loader.
 * @param withBundle - whether the bundle's inserted rows follow the base rows.
 * @returns the context plus which providers prepared continuable children, by name.
 */
async function compose(withBundle: boolean): Promise<{ ctx: Context; providers: string[] }> {
  const ctx = new Context()
  contexts.push(ctx)
  const dir = mkdtempSync(join(tmpdir(), 'dsh-threads-profile-'))
  roots.push(dir)
  ctx.baseUrl = pathToFileURL(dir).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.group = Group
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root: dir })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TestSessionQuery)
  ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('done'), textResponse('done'), textResponse('done')]))
  await ctx.plugin(AgentPresets, { default: 'standard' })

  const providers: string[] = []
  const register = ctx.subagents.registerProvider.bind(ctx.subagents)
  ctx.subagents.registerProvider = (provider: SubagentProvider) => register(new Proxy(provider, {
    get(target, key) {
      if (key !== 'prepareContinuable') return target[key as keyof SubagentProvider]
      const prepare = target.prepareContinuable?.bind(target)
      return (...args: Parameters<NonNullable<SubagentProvider['prepareContinuable']>>) => {
        providers.push(target.name)
        return prepare!(...args)
      }
    },
  }))

  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-agent-preset', AgentPreset],
    ['@deepseek-ai/dsh-subagent-spawn-in-process', SubagentSpawn],
    ['@deepseek-ai/dsh-worktree-manager', WorktreeManagerStandIn],
    ['@deepseek-ai/dsh-experimental-project-memory', ProjectMemoryStandIn],
    ['@deepseek-ai/dsh-experimental-threads', Threads],
    ['@deepseek-ai/dsh-subagent-thread-worktree', ThreadProviderStandIn],
    ['@deepseek-ai/dsh-experimental-client-ui-threads', ClientUiThreads],
    ['@deepseek-ai/dsh-experimental-client-ui-project-memory', ClientUiProjectMemory],
    ['@deepseek-ai/dsh-experimental-threads-preset', ThreadsPreset],
    ['@deepseek-ai/dsh-experimental-threads-tool', ThreadsTool],
  ])
  const original = ctx.loader.internal
  const delegated = original?.import.bind(original) as ((...args: unknown[]) => Promise<unknown>) | undefined
  ctx.loader.internal = {
    ...original,
    async import(specifier: string, ...rest: unknown[]): Promise<unknown> {
      return modules.has(specifier) ? modules.get(specifier) : delegated!(specifier, ...rest)
    },
  } as typeof ctx.loader.internal

  await ctx.loader.create({ name: '@deepseek-ai/dsh-subagent-spawn-in-process' })
  await ctx.loader.create({
    name: '@deepseek-ai/dsh-agent-preset',
    config: { id: 'standard', order: 1, plugins: STANDARD_PLUGINS },
  })
  if (withBundle) {
    for (const row of inserted) {
      await ctx.loader.create({
        name: row.name,
        // `dshHomePath` exists only in the real application; the root just has to be a path.
        ...row.config === undefined ? {} : {
          config: row.id === 'worktree-manager' ? { ...row.config, worktreeRoot: join(dir, 'worktrees') } : row.config,
        },
      } as never)
    }
  }
  await ctx.loader.await()
  return { ctx, providers }
}

/** One Agent composed from `presetId`. */
async function agentOn(ctx: Context, id: string, presetId: string): Promise<Agent> {
  const handle = await ctx.agents.create({
    sessionId: SessionId(id),
    meta: { agentPreset: presetId },
    agentOptions: { provider: 'mock', model: 'mock' },
    setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, presetId) },
  })
  return handle.agent
}

/** Let a child finish and its activation settle, so teardown never outruns its settlement watcher. */
async function settle(ctx: Context, child: Agent): Promise<void> {
  await child.whenIdle()
  await vi.waitFor(() => { expect(ctx.agents.get(SessionId(child.id))).toBeUndefined() }, { timeout: 5_000 })
}

/** The assembled tools and runtime contexts of one agent's scope. */
async function surface(ctx: Context, agent: Agent): Promise<{ tools: string[]; contexts: { name: string; text: string }[] }> {
  const scope = scopeOf(agent.ctx)
  const assembly = await ctx.systemPrompt.assemble(scope === undefined ? {} : { scope })
  return { tools: assembly.tools.map(schema => schema.name), contexts: assembly.contexts }
}

/** Start a child with the `subagent` tool as `agent`. */
async function delegate(ctx: Context, agent: Agent): Promise<Agent> {
  const result = await ctx.tools.execute({
    signal: SIGNAL,
    callId: ToolCallId(`delegate-${agent.id}`),
    name: 'subagent',
    arguments: { description: 'fix the flaky test', prompt: 'Fix the flaky test.' },
    agent,
  })
  const text = result.content.map(block => block.type === 'text' ? block.text : '').join('')
  const id = /started subagent (\S+)/.exec(text)?.[1]
  if (id === undefined) throw new Error(`delegation did not start a child: ${text}`)
  return ctx.agents.get(SessionId(id))!
}

describe('real Loader composition', { timeout: 60_000 }, () => {
  it('boots every inserted row of the bundle without an activation failure', async () => {
    const { ctx } = await compose(true)

    expect([...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])
    const roster = await ctx.agentPresets.list()
    expect(roster.map(entry => entry.id).sort()).toEqual(['project', 'project-thread', 'standard'])
    expect(roster.filter(entry => entry.broken !== undefined)).toEqual([])
  })

  it('leaves an ordinary session identical with and without the bundle', async () => {
    const without = await compose(false)
    const withBundle = await compose(true)
    const plain = await agentOn(without.ctx, 'plain-1', 'standard')
    const bundled = await agentOn(withBundle.ctx, 'plain-1', 'standard')

    const before = await surface(without.ctx, plain)
    const after = await surface(withBundle.ctx, bundled)

    expect(after.tools).toEqual(before.tools)
    expect(after.contexts).toEqual(before.contexts)
    expect(after.tools).toEqual(expect.arrayContaining(['subagent', 'list_agents', 'send_message', 'interrupt_agent']))
    expect(after.tools).not.toContain('thread_status')
    expect(after.tools).not.toContain('thread_diff')
    // The ordinary `subagent` still delegates through `spawn`, and no Thread provider is involved.
    await settle(without.ctx, await delegate(without.ctx, plain))
    await settle(withBundle.ctx, await delegate(withBundle.ctx, bundled))
    expect(without.providers).toEqual(['spawn'])
    expect(withBundle.providers).toEqual(['spawn'])
  })

  it('gives a project session the Thread tools and the thread provider', async () => {
    const { ctx, providers } = await compose(true)
    const project = await agentOn(ctx, 'project-1', 'project')

    const { tools, contexts: texts } = await surface(ctx, project)

    expect(tools).toEqual(expect.arrayContaining([
      'subagent', 'thread_status', 'thread_diff', 'send_message', 'interrupt_agent', 'todo_write',
    ]))
    expect(tools).not.toContain('list_agents')
    expect(texts.map(entry => entry.name)).toContain(THREADS_CONTEXT_NAME)
    const child = await delegate(ctx, project)
    expect(providers).toEqual(['thread'])
    expect(child.session.header.agentPreset).toBe('project-thread')
    // Settle the Thread before teardown so its inbox projection is not read after disposal.
    await settle(ctx, child)
  })

  it('composes the Thread from the worker preset, which sees no Thread tool and no thread provider', async () => {
    const { ctx, providers } = await compose(true)
    const project = await agentOn(ctx, 'project-1', 'project')
    const thread = await delegate(ctx, project)

    const { tools, contexts: texts } = await surface(ctx, thread)

    expect(ctx.tools.get('thread_status', thread)).toBeUndefined()
    expect(ctx.tools.get('thread_diff', thread)).toBeUndefined()
    expect(tools).toEqual(expect.arrayContaining(['subagent', 'send_message', 'todo_write']))
    expect(tools).not.toContain('thread_status')
    expect(tools).not.toContain('thread_diff')
    expect(texts.map(entry => entry.name)).toContain(THREAD_WORKER_CONTEXT_NAME)
    expect(texts.map(entry => entry.name)).not.toContain(THREADS_CONTEXT_NAME)
    // The Thread's own `subagent` is the ordinary tool: it prepares on `spawn`.
    const helper = await delegate(ctx, thread)
    expect(providers).toEqual(['thread', 'spawn'])
    await settle(ctx, helper)
  })
})
