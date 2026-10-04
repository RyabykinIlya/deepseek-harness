/**
 * The Threads bundle end to end: the real rows of `cordis.patch.yml` (worktree manager,
 * Thread provider, Threads projection, Thread tools, presets, Project memory) run on a real
 * git repository. Only the LLM is scripted, plus one test-only tool that commits in the
 * calling agent's cwd, because the shipped shell needs sandbox and approval services that a
 * unit composition does not mount.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
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
import * as ClientUiThreads from '@deepseek-ai/dsh-experimental-client-ui-threads'
import * as ProjectMemory from '@deepseek-ai/dsh-experimental-project-memory'
import * as Threads from '@deepseek-ai/dsh-experimental-threads'
import { ThreadId } from '@deepseek-ai/dsh-experimental-threads'
import * as ThreadsPreset from '@deepseek-ai/dsh-experimental-threads-preset'
import * as ThreadsTool from '@deepseek-ai/dsh-experimental-threads-tool'
import { createUserMessage, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as SubagentThreadWorktree from '@deepseek-ai/dsh-subagent-thread-worktree'
import * as WorktreeManager from '@deepseek-ai/dsh-worktree-manager'
import { toolCallResponse, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import * as CommitTool from './commit-tool.fixture.ts'
import { observed } from './commit-tool.fixture.ts'
import { TestSessionQuery } from '../../../subagent/subagent/tests/test-session-query.ts'

const COMMIT_TOOL_URL = new URL('./commit-tool.fixture.ts', import.meta.url).href
const THREAD_TASK = 'Add greeting.txt and commit it.'
const MEMORY_TEXT = 'Greetings live in greeting.txt'

interface Row {
  id?: string
  name?: string
  config?: Record<string, unknown>
  insert?: Row[]
}

const root = fileURLToPath(new URL('..', import.meta.url))
const patches = yaml.load(readFileSync(join(root, 'cordis.patch.yml'), 'utf8'), { schema: entryListSchema }) as Row[]
const inserted = patches.flatMap(patch => patch.insert ?? [])

const contexts: Context[] = []
const temporaries: string[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of temporaries.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

/** A temp directory removed after the test. */
function temporary(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  temporaries.push(dir)
  return dir
}

/** Run git with an argv array and return trimmed stdout. */
function git(args: readonly string[], cwd: string): string {
  return execFileSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim()
}

/** A git repository with one commit. */
function repository(): string {
  const dir = temporary('dsh-threads-repo-')
  git(['init', '--quiet', '--initial-branch=main'], dir)
  git(['config', 'user.email', 'threads@example.test'], dir)
  git(['config', 'user.name', 'Threads Test'], dir)
  writeFileSync(join(dir, 'README.md'), 'seed\n', 'utf8')
  git(['add', '.'], dir)
  git(['commit', '--quiet', '-m', 'seed'], dir)
  return dir
}

/** One scripted model step: chunks, or an async computation of them. */
type Step = (options: GenerateOptions) => StreamChunk[] | Promise<StreamChunk[]>

/** Fake LLM: one step function per role, chosen by whether the request carries `thread_status`. */
class RoleAdapter extends LlmAdapter {
  coordinator: Step = () => textResponse('idle')
  worker: Step = () => textResponse('idle')

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const isCoordinator = options.tools?.some(tool => tool.name === 'thread_status') === true
    const chunks = await (isCoordinator ? this.coordinator : this.worker)(options)
    for (const chunk of chunks) {
      if (options.signal?.aborted === true) throw new Error('aborted')
      yield chunk
    }
  }
}

/** Everything one composition exposes to a test. */
interface Composition {
  readonly ctx: Context
  readonly adapter: RoleAdapter
  readonly worktreeRoot: string
  readonly repo: string
}

/** The `standard` preset rows: plain tools, ordinary delegation, and the test-only commit tool. */
function standardPlugins(): { id: string; name: string; config?: object }[] {
  const source = (path: string): string => new URL(`../../../${path}`, import.meta.url).href
  return [
    { id: 'tool-todo', name: source('todo/tool-todo/src/index.ts'), config: { allowParallelInProgress: true } },
    { id: 'tool-subagent-control', name: source('subagent/tool-subagent-control/src/index.ts') },
    { id: 'tool-subagent-list-agents', name: source('subagent/tool-subagent-control/src/list-agents.ts') },
    {
      id: 'tool-subagent',
      name: source('subagent/tool-subagent/src/index.ts'),
      config: { provider: 'spawn', toolName: 'subagent', backgroundMode: 'continuable' },
    },
    { id: 'test-commit-tool', name: COMMIT_TOOL_URL },
  ]
}

/**
 * Boot the real bundle rows (or none) beside the agent plane.
 * @param withBundle - whether the patch rows are mounted.
 * @returns the context, fake LLM, and the temp paths.
 */
async function compose(withBundle: boolean): Promise<Composition> {
  const ctx = new Context()
  contexts.push(ctx)
  const dir = temporary('dsh-threads-real-')
  const worktreeRoot = join(dir, 'worktrees')
  const repo = repository()
  observed.length = 0
  ctx.baseUrl = pathToFileURL(dir).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.group = Group
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root: join(dir, 'sessions') })
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(new MemoryMediaPool())
  ctx.effect(() => ctx.storage.backend.register('fixture', backend))
  ctx.effect(() => async () => { await backend.close() })
  const facility = new DomainFacility(ctx, { backend: 'fixture' })
  ctx.effect(() => {
    const unmount = ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    return async () => { await facility.closeAll(); unmount() }
  })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TestSessionQuery)
  const adapter = new RoleAdapter()
  ctx.llm.registerAdapter(['mock'], adapter)
  await ctx.plugin(AgentPresets, { default: 'standard' })

  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-agent-preset', AgentPreset],
    ['@deepseek-ai/dsh-subagent-spawn-in-process', SubagentSpawn],
    ['@deepseek-ai/dsh-worktree-manager', WorktreeManager],
    ['@deepseek-ai/dsh-experimental-project-memory', ProjectMemory],
    ['@deepseek-ai/dsh-experimental-threads', Threads],
    ['@deepseek-ai/dsh-subagent-thread-worktree', SubagentThreadWorktree],
    ['@deepseek-ai/dsh-experimental-client-ui-threads', ClientUiThreads],
    ['@deepseek-ai/dsh-experimental-threads-preset', ThreadsPreset],
    ['@deepseek-ai/dsh-experimental-threads-tool', ThreadsTool],
    [COMMIT_TOOL_URL, CommitTool],
  ])
  const original = ctx.loader.internal
  const delegated = original?.import.bind(original)
  ctx.loader.internal = {
    ...original,
    async import(specifier: string, ...rest: unknown[]): Promise<unknown> {
      return modules.has(specifier) ? modules.get(specifier) : (delegated as (...args: unknown[]) => Promise<unknown>)(specifier, ...rest)
    },
  } as typeof ctx.loader.internal

  await ctx.loader.create({ name: '@deepseek-ai/dsh-subagent-spawn-in-process' })
  await ctx.loader.create({
    name: '@deepseek-ai/dsh-agent-preset',
    config: { id: 'standard', order: 1, plugins: standardPlugins() },
  })
  if (withBundle) {
    for (const row of inserted) {
      const config = row.id === 'worktree-manager' ? { ...row.config, worktreeRoot } : row.config
      await ctx.loader.create({ name: row.name, ...config === undefined ? {} : { config } } as never)
    }
  }
  await ctx.loader.await()
  return { ctx, adapter, worktreeRoot, repo }
}

/** Create an Agent composed from `presetId`, optionally with a cwd. */
async function agentOn(ctx: Context, id: string, presetId: string, cwd?: string): Promise<Agent> {
  const handle = await ctx.agents.create({
    sessionId: SessionId(id),
    meta: { agentPreset: presetId, ...cwd === undefined ? {} : { cwd } },
    agentOptions: { provider: 'mock', model: 'mock' },
    setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, presetId) },
  })
  return handle.agent
}

/** Tool names and runtime context names one agent's scope assembles. */
async function surface(ctx: Context, agent: Agent): Promise<{ tools: string[]; schemas: unknown[]; contexts: string[] }> {
  const scope = scopeOf(agent.ctx)
  const assembly = await ctx.systemPrompt.assemble(scope === undefined ? {} : { scope })
  return { tools: assembly.tools.map(schema => schema.name), schemas: assembly.tools, contexts: assembly.contexts.map(entry => entry.name) }
}

describe('Threads bundle on its real rows', { timeout: 120_000 }, () => {
  it('runs a Thread from Project delegation to archive on a real repository', async () => {
    const { ctx, adapter, worktreeRoot, repo } = await compose(true)
    const results: Record<string, string> = {}
    let phase = 0
    let threadIdText = ''
    const finished = { value: false }

    adapter.coordinator = async (options) => {
      // Record every tool result the coordinator has seen, by the call that produced it.
      collectResults(options, results)
      if (phase === 0) {
        phase = 1
        return toolCallResponse('c-start', 'subagent', { description: 'greeting', prompt: THREAD_TASK })
      }
      const project = ctx.agents.get(SessionId('project-1'))!
      const row = ctx.threads.viewOf(project.session)[0]
      if (phase === 1) {
        if (row?.stopReason === undefined) return textResponse('waiting for the thread')
        await vi.waitFor(() => { expect(ctx.threads.viewOf(project.session)[0]?.commitsAhead).toBeGreaterThanOrEqual(1) })
        threadIdText = row.threadId
        phase = 2
        return toolCallResponse('c-status', 'thread_status', {})
      }
      if (phase === 2) { phase = 3; return toolCallResponse('c-diff', 'thread_diff', { thread_id: threadIdText }) }
      if (phase === 3) { phase = 4; return toolCallResponse('c-memory', 'memory_read', {}) }
      // The Library read model is served from Session logs and worktrees, not from
      // the `threads` projection, so it exercises a different service path than the
      // two tools above.
      if (phase === 4) { phase = 5; return toolCallResponse('c-library', 'library_list', { section: 'changes' }) }
      finished.value = true
      return textResponse('all done')
    }
    let workerPhase = 0
    adapter.worker = (options) => {
      collectResults(options, results)
      workerPhase += 1
      if (workerPhase === 1) return toolCallResponse('w-memory', 'memory_write', { action: 'add', text: MEMORY_TEXT })
      if (workerPhase === 2) {
        return toolCallResponse('w-commit', 'commit_file', { path: 'greeting.txt', content: 'hello\n', message: 'Add greeting' })
      }
      return textResponse('Committed greeting.txt')
    }

    const project = await agentOn(ctx, 'project-1', 'project', repo)
    project.followup(createUserMessage({ content: [{ type: 'text', text: 'Start a thread for the greeting' }], source: { kind: 'user' } }))
    await vi.waitFor(() => { expect(finished.value).toBe(true) }, { timeout: 60_000 })
    await project.whenIdle()

    // The Thread ran in a worktree under worktreeRoot, on a dsh/thread-* branch.
    expect(observed).toHaveLength(1)
    const thread = observed[0]!
    const relativeToRoot = relative(worktreeRoot, thread.cwd)
    expect(relativeToRoot.startsWith('..') || isAbsolute(relativeToRoot)).toBe(false)
    expect(thread.cwd).not.toBe(repo)
    expect(thread.branch).toMatch(/^dsh\/thread-/)

    // The Project log records the Thread with the same branch and worktree.
    const events = project.session.snapshotEvents()
    const created = events.find(event => event.type === 'thread/created')
    expect(created).toMatchObject({ data: { worktree: thread.cwd, branch: thread.branch } })
    const rows = ctx.threads.viewOf(project.session)
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row).toMatchObject({ branch: thread.branch, stopReason: 'completed' })

    // Tool results the coordinator saw.
    expect(results['c-status']).toContain(thread.branch)
    expect(results['c-status']).toMatch(/[1-9]\d* commits ahead/)
    expect(results['c-diff']).toContain('greeting.txt')
    expect(results['c-diff']).toContain('Add greeting')
    expect(results['c-memory']).toContain(MEMORY_TEXT)
    expect(results['c-memory']).toContain('[thread,')
    expect(results['w-memory']).toMatch(/^added /)
    // `library_list` reached the real Library read model over a live worktree:
    // this is the path that resolves `sessions` from inside the service, which a
    // stubbed `threads` projection can never exercise.
    expect(results['c-library']).toContain(row.threadId)
    expect(results['c-library']).toContain(`branch ${thread.branch}`)
    expect(results['c-library']).toContain('greeting.txt')

    // Archive: worktree gone, branch kept, row removed.
    await ctx.threads.archive(project, ThreadId(row.threadId))
    expect(existsSync(thread.cwd)).toBe(false)
    expect(git(['branch', '--list', thread.branch], repo)).toContain(thread.branch)
    expect(project.session.snapshotEvents().some(event => event.type === 'thread/removed')).toBe(true)
    expect(ctx.threads.viewOf(project.session)).toEqual([])
    // The Project checkout itself never received the file.
    expect(existsSync(join(repo, 'greeting.txt'))).toBe(false)
  })

  it('leaves an ordinary standard session identical with and without the bundle', async () => {
    const without = await compose(false)
    const withBundle = await compose(true)
    const plain = await agentOn(without.ctx, 'plain-1', 'standard', without.repo)
    const bundled = await agentOn(withBundle.ctx, 'plain-1', 'standard', withBundle.repo)

    const before = await surface(without.ctx, plain)
    const after = await surface(withBundle.ctx, bundled)

    expect(after.schemas).toEqual(before.schemas)
    expect(after.contexts).toEqual(before.contexts)
    expect(after.tools).toEqual(before.tools)
    expect(after.tools).toContain('subagent')
    for (const name of ['thread_status', 'thread_diff', 'memory_read', 'memory_write']) {
      expect(after.tools).not.toContain(name)
    }
    // The ordinary `subagent` still delegates to `spawn`, with or without the bundle.
    for (const comp of [{ comp: without, agent: plain }, { comp: withBundle, agent: bundled }]) {
      const started: string[] = []
      comp.comp.ctx.on('subagent/start', (info) => { started.push(info.provider) })
      const result = await comp.comp.ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId(`delegate-${comp.agent.id}`),
        name: 'subagent',
        arguments: { description: 'check', prompt: 'Say done.' },
        agent: comp.agent,
      })
      const text = result.content.map(block => block.type === 'text' ? block.text : '').join('')
      const childId = /started subagent (\S+)/.exec(text)?.[1]
      expect(childId, text).toBeDefined()
      await vi.waitFor(() => { expect(comp.comp.ctx.agents.get(SessionId(childId!))).toBeUndefined() }, { timeout: 10_000 })
      expect(started).toEqual(['spawn'])
    }
  })
})

/**
 * Copy the text of each tool result in a request into `results`, keyed by call id.
 * @param options - the model request.
 * @param results - destination map.
 */
function collectResults(options: GenerateOptions, results: Record<string, string>): void {
  for (const message of options.messages) {
    if (message.role !== 'tool') continue
    const id = String(message.toolCallId)
    results[id] = message.content.map(block => block.type === 'text' ? block.text : '').join('')
  }
}
