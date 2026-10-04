/**
 * The Threads preset suite.
 *
 * Every case mounts the real presets through the real roster and reads the
 * composition the way a running Project or Thread reads it: from one agent's
 * scope, on a real Session whose header records the preset it was composed from.
 * Only the subagent providers are stand-ins, because the worktree backend
 * belongs to the profile bundle.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Group from '@deepseek-ai/cordis-plugin-group'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import { ThreadsService } from '@deepseek-ai/dsh-experimental-threads'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { ContinuableCreateSpec, SubagentProvider, SubagentRun } from '@deepseek-ai/dsh-subagent'
import { TestSessionQuery } from '../../../subagent/subagent/tests/test-session-query.ts'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import ThreadsPreset, {
  COORDINATOR_REPLACED_ROW_IDS,
  PROJECT_PRESET_ID,
  PROJECT_PRESET_ROW_NAMES,
  PROJECT_THREAD_PRESET_ID,
  THREADS_CONTEXT_NAME,
  THREAD_PROVIDER,
  THREAD_WORKER_CONTEXT_NAME,
  coordinatorContract,
  coordinatorPreset,
  readBaseRows,
  threadAgentOptions,
  workerContract,
  workerPreset,
} from '../src/index.ts'
import type { ThreadsPresetInput } from '../src/index.ts'
import * as contract from '../src/threads-contract.ts'

/** Identity of the base preset the Web profile extends. */
const BASE_ID = 'standard'

/** Display fields every preset declaration in this suite carries. */
const DISPLAY = { id: 'w', name: 'W', description: 'd', order: 1 }

const SIGNAL = new AbortController().signal

const contexts: Context[] = []

const roots: string[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

/** A module of a sibling package, as a URL the Loader can import from a source tree. */
function source(path: string): string {
  return new URL(`../../../${path}`, import.meta.url).href
}

/** The rows of a Web-like base preset: a plain tool plus the ordinary delegation set. */
const BASE_ROWS = [
  { id: 'tool-todo', name: source('todo/tool-todo/src/index.ts'), config: { allowParallelInProgress: true } },
  { id: 'tool-subagent-control', name: source('subagent/tool-subagent-control/src/index.ts') },
  { id: 'tool-subagent-list-agents', name: source('subagent/tool-subagent-control/src/list-agents.ts') },
  {
    id: 'tool-subagent',
    name: source('subagent/tool-subagent/src/index.ts'),
    config: { provider: 'spawn', toolName: 'subagent', backgroundMode: 'continuable' },
  },
]

/** A continuable provider that records its preparations and answers with a fixed spec. */
class RecordingProvider implements SubagentProvider {
  readonly capabilities = { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true }
  readonly inheritsParentContext = false
  prepared = 0

  constructor(readonly name: string, private readonly spec: ContinuableCreateSpec = {}) {}

  start(): Promise<SubagentRun> {
    return Promise.reject(new Error(`${this.name} drives only the continuable path`))
  }

  prepareContinuable(): Promise<ContinuableCreateSpec> {
    this.prepared++
    return Promise.resolve(this.spec)
  }
}

interface Harness {
  readonly ctx: Context
  readonly spawn: RecordingProvider
  readonly thread: RecordingProvider
}

/**
 * A host carrying the Subagent registry, the `threads` projection, the roster,
 * a base preset, and both Threads presets.
 * @param config - row configuration; `basePreset` defaults to the base preset.
 * @param threadSpec - what the `thread` provider returns from `prepareContinuable`.
 */
async function harness(
  config: Partial<ThreadsPresetInput> = { basePreset: BASE_ID },
  threadSpec: ContinuableCreateSpec = {},
): Promise<Harness> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Loader)
  ctx.loader.builtins.group = Group
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: 'Deployment identity.' } })
  // Continuable children are durable sessions, so delegation needs a persistence backend and a session query.
  const root = mkdtempSync(join(tmpdir(), 'dsh-threads-preset-'))
  roots.push(root)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(ThreadsService)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TestSessionQuery)
  ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('done'), textResponse('done'), textResponse('done')]))
  await ctx.plugin(AgentPresets, { default: BASE_ID })
  await ctx.agentPresets.register({ id: BASE_ID, plugins: BASE_ROWS })
  const spawn = new RecordingProvider('spawn')
  const thread = new RecordingProvider(THREAD_PROVIDER, threadSpec)
  ctx.subagents.registerProvider(spawn)
  ctx.subagents.registerProvider(thread)
  await ctx.plugin(ThreadsPreset, config)
  return { ctx, spawn, thread }
}

/** One Agent composed from `presetId`, with the requested identity as durable session metadata. */
async function agentOn(ctx: Context, id: string, presetId: string): Promise<Agent> {
  const handle = await ctx.agents.create({
    sessionId: SessionId(id),
    meta: { agentPreset: presetId },
    agentOptions: { provider: 'mock', model: 'mock' },
    setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, presetId) },
  })
  return handle.agent
}

/** The assembly input for one agent's own scope. */
function assembleContext(agent: Agent): { scope?: object } {
  const scope = scopeOf(agent.ctx)
  return scope === undefined ? {} : { scope }
}

/** The names this agent's model is offered. */
async function toolNames(ctx: Context, agent: Agent): Promise<string[]> {
  const assembly = await ctx.systemPrompt.assemble(assembleContext(agent))
  return assembly.tools.map(schema => schema.name)
}

/** The runtime contexts this agent's scope contributes. */
async function contextsFor(ctx: Context, agent: Agent): Promise<{ name: string; text: string }[]> {
  const assembly = await ctx.systemPrompt.assemble(assembleContext(agent))
  return assembly.contexts
}

/** Call the `subagent` tool as `agent` and return the started child's id. */
async function delegate(ctx: Context, agent: Agent): Promise<SessionId> {
  const result = await ctx.tools.execute({
    signal: SIGNAL,
    callId: ToolCallId('delegate-1'),
    name: 'subagent',
    arguments: { description: 'fix the flaky test', prompt: 'Fix the flaky test.' },
    agent,
  })
  const text = result.content.map(block => block.type === 'text' ? block.text : '').join('')
  const id = /started subagent (\S+)/.exec(text)?.[1]
  if (id === undefined) throw new Error(`delegation did not start a child: ${text}`)
  return SessionId(id)
}

describe('the two declarations', () => {
  it('registers a coordinator and a worker with distinct ids, ordered after the base', async () => {
    const { ctx } = await harness()

    const roster = await ctx.agentPresets.list()

    expect(roster.map(entry => entry.id)).toEqual([PROJECT_PRESET_ID, BASE_ID, PROJECT_THREAD_PRESET_ID].sort((a, b) => {
      const order = (id: string): number => roster.find(entry => entry.id === id)?.order ?? Infinity
      return order(a) - order(b) || a.localeCompare(b)
    }))
    expect(roster.find(entry => entry.id === PROJECT_PRESET_ID)).toMatchObject({ name: 'Project', order: 20 })
    expect(roster.find(entry => entry.id === PROJECT_THREAD_PRESET_ID)).toMatchObject({
      name: 'Project Thread (internal)',
      order: 1000,
    })
    expect(roster.filter(entry => entry.broken !== undefined).map(entry => entry.broken)).toEqual([])
  })

  it('lets a deployment restate identities and display fields', async () => {
    const { ctx } = await harness({
      basePreset: BASE_ID,
      id: 'workspace',
      name: 'Workspace',
      description: 'd',
      order: 3,
      workerId: 'workspace-thread',
      workerName: 'W',
      workerDescription: 'wd',
      workerOrder: 9,
    })

    const roster = await ctx.agentPresets.list()

    expect(roster.find(entry => entry.id === 'workspace')).toMatchObject({ name: 'Workspace', description: 'd', order: 3 })
    expect(roster.find(entry => entry.id === 'workspace-thread')).toMatchObject({ name: 'W', description: 'wd', order: 9 })
    expect(roster.some(entry => entry.id === PROJECT_PRESET_ID)).toBe(false)
  })

  it('builds the coordinator rows from the base without the rows it replaces', () => {
    const declared = coordinatorPreset({
      display: { id: 'p', name: 'P', description: 'd', order: 1 },
      provider: THREAD_PROVIDER,
      base: BASE_ROWS,
      contract: { checkIn: 'quiet', spawn: 'auto', mergePolicy: 'auto' },
      tools: { defaultLimit: 5, maxLimit: 10 },
      agentOptions: { provider: 'deepseek', model: 'm', reasoningEffort: 'high', maxTokens: 1000 },
    })

    expect(declared.plugins.map(entry => entry.id)).toEqual([
      'tool-todo',
      'tool-subagent-control',
      'tool-subagent',
      'thread-contract',
      'tool-threads',
      'project-memory-tools',
    ])
    expect(declared.plugins.find(entry => entry.id === 'thread-contract')?.config).toEqual({
      role: 'coordinator', checkIn: 'quiet', spawn: 'auto', mergePolicy: 'auto',
    })
    expect(declared.plugins.find(entry => entry.id === 'tool-subagent')?.config).toEqual({
      provider: THREAD_PROVIDER,
      toolName: 'subagent',
      backgroundMode: 'continuable',
      agentOptions: { provider: 'deepseek', model: 'm', reasoningEffort: 'high', maxTokens: 1000 },
    })
    expect(declared.plugins.find(entry => entry.id === 'tool-threads')?.config).toEqual({ defaultLimit: 5, maxLimit: 10 })
    expect(COORDINATOR_REPLACED_ROW_IDS).toEqual(['tool-subagent', 'tool-subagent-fork', 'tool-subagent-list-agents'])
  })

  it('mounts the steering tools itself only when the base does not', () => {
    const bare = coordinatorPreset({
      display: { id: 'p', name: 'P', description: 'd', order: 1 },
      provider: THREAD_PROVIDER,
      base: [],
      contract: { checkIn: 'milestones', spawn: 'ask', mergePolicy: 'ask' },
      tools: {},
    })

    expect(bare.plugins.map(entry => entry.id)).toEqual([
      'thread-contract', 'tool-subagent', 'tool-threads', 'project-memory-tools', 'tool-subagent-control',
    ])
    expect(bare.plugins.map(entry => entry.name)).toEqual([
      expect.stringContaining('threads-contract'),
      expect.stringContaining('subagent/tool-subagent/src/index.ts'),
      expect.stringContaining('tool-threads/src/index.ts'),
      expect.stringContaining('project-memory/src/tools.ts'),
      expect.stringContaining('subagent/tool-subagent-control/src/index.ts'),
    ])
    expect(PROJECT_PRESET_ROW_NAMES).toEqual({
      'thread-contract': '@deepseek-ai/dsh-experimental-threads-preset/threads-contract',
      'tool-subagent': '@deepseek-ai/dsh-tool-subagent',
      'tool-threads': '@deepseek-ai/dsh-experimental-threads-tool',
      'tool-subagent-control': '@deepseek-ai/dsh-tool-subagent-control',
      'project-memory-tools': '@deepseek-ai/dsh-experimental-project-memory/tools',
    })
    expect(bare.plugins.find(entry => entry.id === 'tool-subagent')?.config).not.toHaveProperty('agentOptions')
  })

  it('builds the worker from the base rows plus its contract only', () => {
    const worker = workerPreset({ display: { id: 'w', name: 'W', description: 'd', order: 1 }, base: [] })

    expect(worker).toMatchObject({
      id: 'w',
      name: 'W',
      description: 'd',
      order: 1,
      plugins: [{ id: 'thread-contract', config: { role: 'worker' } }, { id: 'project-memory-tools' }],
    })
    expect(worker.plugins[0]!.name).toContain('threads-contract')
    expect(workerPreset({ display: DISPLAY, base: BASE_ROWS }).plugins.map(entry => entry.id)).toEqual([
      'tool-todo', 'tool-subagent-control', 'tool-subagent-list-agents', 'tool-subagent', 'thread-contract', 'project-memory-tools',
    ])
  })
})

describe('configuration', () => {
  it('drops a base row with no id, which cannot be replaced by id', () => {
    const declared = coordinatorPreset({
      display: { id: 'p', name: 'P', description: 'd', order: 1 },
      provider: THREAD_PROVIDER,
      base: [{ name: 'anonymous' }, ...BASE_ROWS],
      contract: { checkIn: 'milestones', spawn: 'ask', mergePolicy: 'ask' },
      tools: {},
    })

    expect(declared.plugins[0]).toEqual({ name: 'anonymous' })
    expect(declared.plugins.map(entry => entry.id)).toContain('tool-subagent')
  })

  it('caps the worker\'s own delegation depth only when configured', () => {
    const capped = workerPreset({ display: DISPLAY, base: BASE_ROWS, maxDepth: 2 })
    const plain = workerPreset({ display: DISPLAY, base: BASE_ROWS })

    expect(capped.plugins.find(entry => entry.id === 'tool-subagent')?.config).toEqual({
      provider: 'spawn', toolName: 'subagent', backgroundMode: 'continuable', maxDepth: 2,
    })
    expect(plain.plugins.find(entry => entry.id === 'tool-subagent')?.config).not.toHaveProperty('maxDepth')
    expect(capped.plugins.find(entry => entry.id === 'tool-todo')).toEqual(BASE_ROWS[0])
  })

  it('accepts the Thread agent options as a whole or not at all', () => {
    expect(threadAgentOptions({})).toBeUndefined()
    expect(threadAgentOptions({
      threadProvider: 'deepseek', threadModel: 'm', threadReasoningEffort: 'high', threadMaxTokens: 100,
    })).toEqual({ provider: 'deepseek', model: 'm', reasoningEffort: 'high', maxTokens: 100 })
    expect(() => threadAgentOptions({ threadModel: 'm' })).toThrow('must be set together')
  })

  it('fails the load when the configured base preset does not exist', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Loader)
    ctx.loader.builtins.group = Group
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(AgentPresets, { default: BASE_ID })

    await expect(readBaseRows(ctx.agentPresets, 'missing')).rejects.toMatchObject({ code: 'agent-preset/not-found' })
  })

  it('rejects a base preset whose document is not an entry list', async () => {
    const { ctx } = await harness()
    // A registered definition may still fail to mount; reading it must fail loud rather than compose a bad tree.
    await ctx.agentPresets.register({ id: 'broken-base', plugins: [null as never] }).catch(() => undefined)

    await expect(readBaseRows(ctx.agentPresets, 'broken-base')).rejects.toThrow('is unreadable')
  })

  it('reads the base rows back with their ids and module names', async () => {
    const { ctx } = await harness()

    const rows = await readBaseRows(ctx.agentPresets, BASE_ID)

    expect(rows.map(entry => entry.id)).toEqual(BASE_ROWS.map(entry => entry.id))
  })

  it('caps the depth a Thread inherits from the base delegation row', async () => {
    const { ctx } = await harness({ basePreset: BASE_ID, workerMaxDepth: 3 })

    const document = await ctx.agentPresets.readDocument(PROJECT_THREAD_PRESET_ID)

    expect(document.content).toContain('maxDepth: 3')
  })

  it('passes the tool limits and the Thread agent options to the coordinator rows', async () => {
    const { ctx } = await harness({
      basePreset: BASE_ID,
      tools: { defaultLimit: 7, maxLimit: 50 },
      threadProvider: 'mock',
      threadModel: 'mock',
      threadReasoningEffort: 'high',
      threadMaxTokens: 2048,
    })

    const document = await ctx.agentPresets.readDocument(PROJECT_PRESET_ID)

    expect(document.content).toContain('defaultLimit: 7')
    expect(document.content).toContain('maxTokens: 2048')
  })
})

describe('which preset a Thread is composed from (T4.0)', () => {
  it('inherits the Project preset when the provider does not name one', async () => {
    const { ctx } = await harness({ basePreset: BASE_ID }, {})
    const project = await agentOn(ctx, 'project-1', PROJECT_PRESET_ID)

    const childId = await delegate(ctx, project)

    expect(ctx.agents.get(childId)?.session.header.agentPreset).toBe(PROJECT_PRESET_ID)
    // The coordinator tools therefore reach the child: the defect the worker preset removes.
    expect(await toolNames(ctx, ctx.agents.get(childId)!)).toContain('thread_status')
  })

  it('composes the Thread from the worker preset the provider names', async () => {
    const { ctx, thread } = await harness({ basePreset: BASE_ID }, { agentPreset: PROJECT_THREAD_PRESET_ID })
    const project = await agentOn(ctx, 'project-1', PROJECT_PRESET_ID)

    const childId = await delegate(ctx, project)
    const child = ctx.agents.get(childId)!

    expect(thread.prepared).toBe(1)
    expect(child.session.header.agentPreset).toBe(PROJECT_THREAD_PRESET_ID)
    expect(ctx.agentPresets.composedPreset(child.ctx)).toBe(PROJECT_THREAD_PRESET_ID)
  })
})

describe('what each role is offered', () => {
  it('gives the coordinator the Thread tools and the thread provider, and the base tools', async () => {
    const { ctx, spawn, thread } = await harness()
    const project = await agentOn(ctx, 'project-1', PROJECT_PRESET_ID)

    const names = await toolNames(ctx, project)

    expect(names).toEqual(expect.arrayContaining(['subagent', 'thread_status', 'thread_diff', 'library_list', 'send_message', 'interrupt_agent', 'todo_write']))
    expect(names).not.toContain('list_agents')
    await delegate(ctx, project)
    expect(thread.prepared).toBe(1)
    expect(spawn.prepared).toBe(0)
  })

  it('gives a Thread neither Thread tool nor the thread delegation', async () => {
    const { ctx, spawn, thread } = await harness({ basePreset: BASE_ID }, { agentPreset: PROJECT_THREAD_PRESET_ID })
    const project = await agentOn(ctx, 'project-1', PROJECT_PRESET_ID)
    const worker = await agentOn(ctx, 'worker-1', PROJECT_THREAD_PRESET_ID)

    expect(ctx.tools.get('thread_status', worker)).toBeUndefined()
    expect(ctx.tools.get('thread_diff', worker)).toBeUndefined()
    // `library_list` resolves the calling Session as the Project, so a Thread
    // session could only ever be refused; the coordinator alone owns it.
    expect(ctx.tools.get('library_list', worker)).toBeUndefined()
    expect(ctx.tools.get('library_list', project)).toBeDefined()
    expect(ctx.tools.get('thread_status', project)).toBeDefined()
    const names = await toolNames(ctx, worker)
    expect(names).toEqual(expect.arrayContaining(['subagent', 'send_message', 'todo_write']))
    expect(names).not.toContain('thread_status')
    expect(names).not.toContain('thread_diff')
    expect(names).not.toContain('library_list')
    const unknown = await ctx.tools.execute({
      signal: SIGNAL, callId: ToolCallId('status-1'), name: 'thread_status', arguments: {}, agent: worker,
    })
    expect(unknown.isError).toBe(true)

    // The worker's `subagent` is the base tool: it prepares on `spawn`, never `thread`.
    await delegate(ctx, worker)
    expect(spawn.prepared).toBe(1)
    expect(thread.prepared).toBe(0)
  })

  it('leaves a session on the base preset untouched', async () => {
    const { ctx } = await harness()
    const ordinary = await agentOn(ctx, 'plain-1', BASE_ID)

    const names = await toolNames(ctx, ordinary)

    expect(names).toEqual(expect.arrayContaining(['subagent', 'list_agents', 'send_message']))
    expect(names).not.toContain('thread_status')
    expect(names).not.toContain('thread_diff')
    expect((await contextsFor(ctx, ordinary)).some(entry => entry.name.startsWith('threads:'))).toBe(false)
  })

  it('works without a base preset when the deployment tools are global', async () => {
    const { ctx } = await harness({})
    const project = await agentOn(ctx, 'project-1', PROJECT_PRESET_ID)
    const worker = await agentOn(ctx, 'worker-1', PROJECT_THREAD_PRESET_ID)

    expect(await toolNames(ctx, project)).toEqual(
      expect.arrayContaining(['subagent', 'thread_status', 'thread_diff', 'send_message', 'interrupt_agent']),
    )
    expect((await contextsFor(ctx, worker)).map(entry => entry.name)).toEqual([THREAD_WORKER_CONTEXT_NAME])
    expect(await toolNames(ctx, worker)).not.toContain('thread_status')
  })

  it('records the preset id in the durable session header', async () => {
    const { ctx } = await harness()

    const project = await agentOn(ctx, 'project-1', PROJECT_PRESET_ID)

    expect(project.session.header.agentPreset).toBe(PROJECT_PRESET_ID)
    expect(ctx.sessionProjections.stateOf(project.session, 'agentPreset')).toBe(PROJECT_PRESET_ID)
  })
})

describe('the contracts', () => {
  it('gives each role only its own contract', async () => {
    const { ctx } = await harness()
    const project = await agentOn(ctx, 'project-1', PROJECT_PRESET_ID)
    const worker = await agentOn(ctx, 'worker-1', PROJECT_THREAD_PRESET_ID)
    const ordinary = await agentOn(ctx, 'plain-1', BASE_ID)

    expect(await contextsFor(ctx, project)).toContainEqual({ name: THREADS_CONTEXT_NAME, text: coordinatorContract() })
    expect(await contextsFor(ctx, worker)).toContainEqual({ name: THREAD_WORKER_CONTEXT_NAME, text: workerContract() })
    const contexts = (agent: Agent) => contextsFor(ctx, agent).then(list => list.map(entry => entry.name))
    expect(await contexts(project)).not.toContain(THREAD_WORKER_CONTEXT_NAME)
    expect(await contexts(worker)).not.toContain(THREADS_CONTEXT_NAME)
    expect(await contexts(ordinary)).not.toContain(THREADS_CONTEXT_NAME)
    expect((await ctx.systemPrompt.assemble()).contexts.some(entry => entry.name.startsWith('threads:'))).toBe(false)
  })

  it('pins the default coordinator contract verbatim', () => {
    expect(coordinatorContract()).toBe([
      '## Threads',
      '',
      'You coordinate this Project. A Thread is a background agent that works in its own git worktree on its own branch, so its edits do not appear in the Project checkout until you merge its branch.',
      '',
      'Restate the goal in your own words, propose a split into independent Threads (tasks that do not need each other\'s results and, where possible, touch different files), and start each Thread with the `subagent` tool. Before starting any Thread, show the user the proposed split and wait for their approval.',
      '',
      'A Thread starts with no history of this conversation. Write each task to be self-contained: the goal, the relevant paths, the constraints, and how to verify the result.',
      '',
      'The `subagent` call is asynchronous: it returns a Thread id as soon as the Thread starts, not its work. A Thread reports back on its own when it finishes, with a closing message. Do not poll or wait in a loop; continue with other work, or end your turn. Tell the user at milestones: when the Threads have started, when each one finishes, and when everything is integrated.',
      '',
      '`thread_status` shows your Threads with their state, branch, commits ahead of the base, and uncommitted files. It is bounded and may omit Threads, so never read it as the full list; narrow it with the state filter instead.',
      '',
      'Read the Project memory with memory_read when you start a goal, and record decisions, agreements, and facts every Thread needs with memory_write.',
      '',
      'Review a finished Thread with `thread_diff`, which lists its commits and changed files. Use `send_message` to give a running Thread more instructions and `interrupt_agent` to stop it.',
      '',
      'Integrate a reviewed Thread by merging its branch into the Project checkout with `git merge --no-ff <branch>`, resolving conflicts, and running the tests. When several Threads changed the same files, propose a merge order before you merge any of them. Ask the user before you merge each Thread.',
      '',
      'After a Thread\'s branch is merged, suggest that the user archive that Thread. Archiving is done by the user from the interface; you cannot do it.',
    ].join('\n'))
    expect(contract.THREADS_CONTRACT_CONTEXT).toBe(coordinatorContract())
    expect(coordinatorContract()).not.toContain('You see only its status')
    expect(coordinatorContract()).not.toContain('{{')
  })

  it('pins the worker contract verbatim', () => {
    expect(workerContract()).toBe([
      '## Thread',
      '',
      'You are a Thread of a Project: a background agent working on one task given by the coordinator that started you. Your checkout and your git branch are your own. Your edits reach the Project checkout only when the coordinator merges your branch.',
      '',
      'Commit each finished step with a meaningful message. Do not push, and do not change other branches, unless you are asked to.',
      '',
      'Read the Project memory with memory_read before you start, and record a decision other Threads need with memory_write; do not store file contents or logs there.',
      '',
      'When you are done, send your parent a self-contained summary with `send_message`: what changed, how you verified it, the remaining risks, and your branch name from `git branch --show-current`. Your parent cannot read your transcript or your files; the summary and your branch are all it gets.',
    ].join('\n'))
    expect(contract.THREAD_WORKER_CONTRACT_CONTEXT).toBe(workerContract())
  })

  it.each([
    ['spawn', 'ask', 'Before starting any Thread, show the user the proposed split and wait for their approval.'],
    ['spawn', 'auto', 'Once the split is clear, start the Threads without waiting for approval, and tell the user what you started.'],
    ['checkIn', 'milestones', 'Tell the user at milestones: when the Threads have started, when each one finishes, and when everything is integrated.'],
    ['checkIn', 'each-thread', 'Each time a Thread finishes, tell the user its outcome and its branch before you continue.'],
    ['checkIn', 'quiet', 'Do not narrate progress between Threads; report once when every Thread has finished, or earlier only when you need a decision from the user.'],
    ['mergePolicy', 'ask', 'Ask the user before you merge each Thread.'],
    ['mergePolicy', 'auto', 'Merge a Thread without asking when its checks passed and the merge is conflict-free; ask the user when a conflict needs a design decision or the tests fail.'],
  ] as const)('pins the %s=%s sentence verbatim and swaps only that sentence', (key, value, sentence) => {
    const variant = coordinatorContract({ [key]: value })
    const defaults = coordinatorContract()

    expect(variant).toContain(sentence)
    const sentences = [
      ...Object.values(contract.SPAWN_SENTENCES),
      ...Object.values(contract.CHECK_IN_SENTENCES),
      ...Object.values(contract.MERGE_SENTENCES),
    ]
    const present = sentences.filter(candidate => variant.includes(candidate))
    expect(present).toHaveLength(3)
    // Exactly one variant sentence differs from the default contract (or none, for the default itself).
    const differing = sentences.filter(candidate => variant.includes(candidate) !== defaults.includes(candidate))
    expect(differing.length).toBe(defaults.includes(sentence) ? 0 : 2)
  })

  it('applies the configured sentences through the mounted row', async () => {
    const { ctx } = await harness({ basePreset: BASE_ID, checkIn: 'quiet', spawn: 'auto', mergePolicy: 'auto' })
    const project = await agentOn(ctx, 'project-1', PROJECT_PRESET_ID)

    expect(await contextsFor(ctx, project)).toContainEqual({
      name: THREADS_CONTEXT_NAME,
      text: coordinatorContract({ checkIn: 'quiet', spawn: 'auto', mergePolicy: 'auto' }),
    })
  })
})

describe('the contract row on its own', () => {
  it('registers the coordinator contract into its mounting scope and leaves nothing behind on unload', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)

    const fiber = await ctx.plugin(contract)

    expect((await ctx.systemPrompt.assemble()).contexts)
      .toEqual([{ name: THREADS_CONTEXT_NAME, text: coordinatorContract() }])
    await fiber.dispose()
    expect((await ctx.systemPrompt.assemble()).contexts).toEqual([])
  })

  it('registers the worker contract under its own context name for the worker role', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)

    await ctx.plugin(contract, { role: 'worker' })

    expect((await ctx.systemPrompt.assemble()).contexts)
      .toEqual([{ name: THREAD_WORKER_CONTEXT_NAME, text: workerContract() }])
  })

  it('is declared with an explicit finite order, after the delegation-scope context', () => {
    expect(Number.isInteger(contract.THREADS_CONTEXT_ORDER)).toBe(true)
    expect(contract.THREADS_CONTEXT_ORDER).toBeGreaterThan(120)
    expect(contract.name).toBe('thread-contract')
    expect(contract.inject).toEqual(['systemPrompt'])
  })
})
