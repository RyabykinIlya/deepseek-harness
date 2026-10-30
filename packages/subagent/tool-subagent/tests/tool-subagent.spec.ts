import { ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline'
import { executeModelToolFixture, executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { mountWorkingDirectoryFixture } from '../../subagent/tests/working-directory-fixture.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { ToolCallId, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { TOOL_ABORTED_BEFORE_DISPATCH } from '@deepseek-ai/dsh-tools'
import { assembleContextFor } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { loadStoredSession } from '../../subagent/tests/persistence-helpers.ts'
import * as mock from './scripted-provider.ts'
import type { Config as toolConfig } from '../src/index.ts'
import * as tool from '../src/index.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  callSubagent,
  disposeSetupProvider,
  ownContext,
  modelSelectionSetupAgent,
  setup,
  testToolSignal,
  text,
} from './harness.ts'

/** Create a package-test context with the tool's required projection seam. */
async function projectedContext(): Promise<Context> {
  const ctx = ownContext(new Context())
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  return ctx
}

/** Read the model-visible delegation paragraphs, excluding empty sections. */
async function delegationGuidance(ctx: Context, agent?: Agent): Promise<string[]> {
  const assembly = await ctx.systemPrompt.assemble(agent === undefined ? undefined : assembleContextFor(agent))
  return assembly.sections.map(section => section.text).filter(text => text.startsWith('Start independent delegations'))
}

/**
 * Drives the REAL plugin body: mounts `dsh-tool-subagent` on a real
 * `ToolRuntime` + `SubagentRuntime`, with a package-local scripted child
 * boundary, and invokes the registered `subagent` tool through
 * `ctx.tools.execute`. Everything downstream of the child boundary is the
 * shipping code path.
 */

describe('dsh-tool-subagent', () => {

  it('rejects configured child agent options at mount when the provider cannot apply them', async () => {
    await expect(setup(
      { provider: 'mock', maxDepth: 'provider-managed', agentOptions: { model: 'configured-model' } },
      { capabilities: { agentOptions: false } },
    )).rejects.toThrow('does not support child agentOptions')
  })

  it('runs in the foreground by default and returns the collected child output', async () => {
    const ctx = await setup({ provider: 'mock' }, { reply: 'child says hi' })
    const result = await callSubagent(ctx, {
      description: 'do a thing',
      prompt: 'go research X',
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected subagent success')
    const value = result.value as {
      kind: 'foreground'
      runId: string
      output: { type: 'text'; text: string }[]
    }
    expect(value.kind).toBe('foreground')
    expect(typeof value.runId).toBe('string')
    expect(value.output).toEqual([{ type: 'text', text: 'child says hi' }])
    expect(text(result)).toBe('child says hi')
  })

  it('omits run_in_background entirely when the instance disables it', async () => {
    const ctx = await setup({ provider: 'mock', enableRunInBackground: false })
    const schema = ctx.tools.schemas().find(s => s.name === 'subagent')!
    const props = (schema.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    expect(Object.keys(props).sort()).toEqual(['cwd', 'description', 'prompt'])
    // The schema promises no collection because no job is ever created.
    expect(schema.description).not.toContain('job_output')
  })

  it('refuses a forced run_in_background at execution time when the instance disables it', async () => {
    // Schema omission is advertising, not enforcement: the arg validator
    // permits undeclared keys, so the opt-out must also hold in execute().
    const started: SubagentStartRequest[] = []
    const ctx = await setup({ provider: 'mock', enableRunInBackground: false }, {
      onStart: (request) => { started.push(request) },
    })

    const forced = await callSubagent(ctx, { description: 'd', prompt: 'p', run_in_background: true })
    expect(forced.isError).toBe(true)
    expect(text(forced)).toContain('run_in_background is disabled for this tool instance')
    // The refusal precedes any child: the provider was never asked to start one.
    expect(started).toEqual([])

    const foreground = await callSubagent(ctx, { description: 'd', prompt: 'p' })
    expect(foreground.isError).toBe(false)
    expect(started).toHaveLength(1)
  })

  it('resolves an explicit child directory without changing the parent directory', async () => {
    let childCwd: string | undefined
    const ctx = await setup({ provider: 'mock' }, {
      onStart: (request) => { childCwd = request.cwd },
    })
    const parent = modelSelectionSetupAgent(ctx)
    const parentCwd = ctx.workingDirectory.get(parent.session)
    try {
      const result = await callSubagent(ctx, {
        description: 'inspect packages',
        prompt: 'list the packages',
        cwd: 'packages',
      }, { agent: parent })
      expect(result.isError).toBe(false)
      expect(childCwd).toBe(path.resolve(parentCwd, 'packages'))
      expect(ctx.workingDirectory.get(parent.session)).toBe(parentCwd)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  describe('repository selection', () => {
    it('publishes a repository parameter only when the provider names a repository per subagent', async () => {
      const capable = await setup({ provider: 'mock' }, { capabilities: { repository: true } })
      const capableProps = (capable.tools.schemas().find(s => s.name === 'subagent')!.parameters as {
        properties: Record<string, { description?: string }>
      }).properties
      expect(Object.keys(capableProps)).toContain('repository')
      expect(capableProps.repository?.description).toContain('path inside your working directory')

      // The scripted provider's default capabilities exclude it, so a
      // composition over a provider that selects no repository keeps the schema
      // it already had.
      const plain = await setup({ provider: 'mock' })
      const plainProps = (plain.tools.schemas().find(s => s.name === 'subagent')!.parameters as {
        properties: Record<string, unknown>
      }).properties
      expect(Object.keys(plainProps)).not.toContain('repository')
    })

    it('forwards a named repository to the provider request', async () => {
      const requests: SubagentStartRequest[] = []
      const ctx = await setup({ provider: 'mock' }, {
        capabilities: { repository: true },
        onStart: (request) => { requests.push(request) },
      })
      const result = await callSubagent(ctx, {
        description: 'work in one repository',
        prompt: 'go',
        repository: 'bro_bot_browser',
      })
      expect(result.isError).toBe(false)
      expect(requests[0]?.repository).toBe('bro_bot_browser')
    })

    it('leaves the request free of a repository when the model names none', async () => {
      const requests: SubagentStartRequest[] = []
      const ctx = await setup({ provider: 'mock' }, {
        capabilities: { repository: true },
        onStart: (request) => { requests.push(request) },
      })
      const result = await callSubagent(ctx, { description: 'd', prompt: 'p' })
      expect(result.isError).toBe(false)
      expect(requests).toHaveLength(1)
      expect('repository' in requests[0]!).toBe(false)
    })

    it('refuses a named repository at execution time when the provider selects none', async () => {
      // Schema omission is advertising, not enforcement: the arg validator
      // permits undeclared keys, so the refusal must also hold in execute().
      const requests: SubagentStartRequest[] = []
      const ctx = await setup({ provider: 'mock' }, {
        onStart: (request) => { requests.push(request) },
      })
      const result = await callSubagent(ctx, { description: 'd', prompt: 'p', repository: 'repo' })
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('repository is not available for provider "mock"')
      // The refusal happens before any child is started.
      expect(requests).toEqual([])
    })

    it('refuses an empty repository instead of passing it to the provider', async () => {
      const requests: SubagentStartRequest[] = []
      const ctx = await setup({ provider: 'mock' }, {
        capabilities: { repository: true },
        onStart: (request) => { requests.push(request) },
      })
      const result = await callSubagent(ctx, { description: 'd', prompt: 'p', repository: '  ' })
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('repository was empty')
      expect(requests).toEqual([])
    })
  })

  it('classifies delegations as concurrency-safe', async () => {
    const ctx = await setup({ provider: 'mock' })
    expect(new ToolExecutionPipeline(ctx).executionMode({
      signal: testToolSignal,
      callId: ToolCallId('subagent-first'),
      name: 'subagent',
      arguments: { description: 'do work', prompt: 'Reply OK' },
    })).toEqual({ kind: 'parallel' })
    expect(new ToolExecutionPipeline(ctx).executionMode({
      signal: testToolSignal,
      callId: ToolCallId('subagent-second'),
      name: 'subagent',
      arguments: { description: 'do work', prompt: 'Reply OK' },
    })).toEqual({ kind: 'parallel' })
  })

  it('overlaps sibling delegations dispatched concurrently', async () => {
    // Two children each block until both have started: hidden serialization
    // in the tool body, registry pipeline, or provider start path would
    // deadlock here instead of passing silently.
    const started: string[] = []
    let releaseBoth!: () => void
    const bothStarted = new Promise<void>((resolve) => { releaseBoth = resolve })
    const ctx = await setup({ provider: 'mock' }, {
      onStart: (request: SubagentStartRequest) => {
        started.push(request.label ?? '(unlabeled)')
        if (started.length === 2) releaseBoth()
        return bothStarted
      },
    })
    const results = await Promise.all([
      callSubagent(ctx, { description: 'first', prompt: 'p1' }),
      callSubagent(ctx, { description: 'second', prompt: 'p2' }),
    ])
    expect(started.sort()).toEqual(['first', 'second'])
    for (const result of results) expect(result.isError).toBe(false)
  })

  it('registers under a configurable toolName so multiple providers can coexist', async () => {
    // The defining multi-provider use case: two loads, two distinct tool names,
    // each bound to a different provider — the tool registry rejects duplicate
    // names, so a configurable name is what makes this work.
    const ctx = await projectedContext()
    await mountWorkingDirectoryFixture(ctx)
    await ctx.plugin(SubagentRuntime)
    await mock.mountScriptedProvider(ctx, { name: 'spawn', reply: 'from spawn' })
    await mock.mountScriptedProvider(ctx, { name: 'acp', reply: 'from acp' })
    await ctx.plugin(tool, { provider: 'spawn', toolName: 'subagent' })
    await ctx.plugin(tool, { provider: 'acp', toolName: 'subagent_acp' })

    const names = ctx.tools.schemas().map(s => s.name).filter(n => n.startsWith('subagent')).sort()
    expect(names).toEqual(['subagent', 'subagent_acp'])

    const parent = (await ctx.agents.create({ sessionId: SessionId('multi-provider-parent') })).agent
    const viaSpawn = await executeToolFixture(ctx, { signal: testToolSignal, callId: ToolCallId('c-spawn'), name: 'subagent', arguments: { description: 'd', prompt: 'p' }, agent: parent })
    const viaAcp = await executeToolFixture(ctx, { signal: testToolSignal, callId: ToolCallId('c-acp'), name: 'subagent_acp', arguments: { description: 'd', prompt: 'p' }, agent: parent })
    // Each tool instance proves its own binding: one-shot policy stays on the
    // foreground route, so the rendered result is the child's own answer.
    expect(text(viaSpawn)).toBe('from spawn')
    expect(text(viaAcp)).toBe('from acp')
  })

  it('skips startup when cancellation wins asynchronous route preflight', async () => {
    const started = vi.fn()
    const ctx = await setup({
      provider: 'mock',
      agentOptions: { provider: 'alpha', model: 'selected-model' },
    }, { onStart: started })
    const parent = modelSelectionSetupAgent(ctx)
    const adapter = new MockAdapter([])
    let releasePreflight!: () => void
    const preflightGate = new Promise<void>((resolve) => { releasePreflight = resolve })
    const resolveModel = vi.spyOn(adapter, 'resolveModel').mockImplementation(async (provider, model) => {
      await preflightGate
      return { provider, id: model, name: model }
    })
    ctx.llm.registerAdapter(['alpha'], adapter)
    const controller = new AbortController()

    const resultPromise = callSubagent(ctx, {
      description: 'cancelled selection',
      prompt: 'do it',
    }, { agent: parent, signal: controller.signal })
    await vi.waitFor(() => { expect(resolveModel).toHaveBeenCalledOnce() })
    controller.abort()
    releasePreflight()
    const result = await resultPromise

    expect(result.isError).toBe(true)
    expect(started).not.toHaveBeenCalled()
  })

  it('rejects startup when the provider changes during asynchronous route preflight', async () => {
    const oldStart = vi.fn()
    const replacementStart = vi.fn(async (): Promise<never> => { throw new Error('replacement provider must not start') })
    const ctx = await setup({
      provider: 'mock',
      withModelSelection: true,
      maxDepth: 'provider-managed',
    }, {
      agentRouteDefaults: { provider: 'alpha', model: 'selected-model' },
      onStart: oldStart,
    })
    const adapter = new MockAdapter([])
    let releasePreflight!: () => void
    const preflightGate = new Promise<void>((resolve) => { releasePreflight = resolve })
    const resolveModel = vi.spyOn(adapter, 'resolveModel').mockImplementation(async (provider, model) => {
      await preflightGate
      return { provider, id: model, name: model }
    })
    ctx.llm.registerAdapter(['alpha'], adapter)

    const pending = callSubagent(ctx, {
      description: 'swapped provider',
      prompt: 'do it',
      provider: 'alpha',
      model: 'selected-model',
    })
    await vi.waitFor(() => { expect(resolveModel).toHaveBeenCalledOnce() })
    await disposeSetupProvider(ctx)
    ctx.subagents.registerProvider({
      name: 'mock',
      capabilities: { agentOptions: true, agentPreset: false, outputSchema: false, depthLimit: false, repository: false },
      inheritsParentContext: false,
      agentRouteDefaults: { provider: 'beta', model: 'replacement-model' },
      start: replacementStart,
    })
    releasePreflight()

    const result = await pending
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('changed while resolving the child LLM route')
    expect(oldStart).not.toHaveBeenCalled()
    expect(replacementStart).not.toHaveBeenCalled()
  })

  it('merges model overrides over provider-owned route defaults before preflight', async () => {
    let seen: SubagentStartRequest | undefined
    const ctx = await setup({
      provider: 'mock',
      withModelSelection: true,
      agentOptions: { reasoningEffort: ReasoningEffortId('high'), maxTokens: 321 },
      maxDepth: 'provider-managed',
    }, {
      agentRouteDefaults: { provider: 'alpha', model: 'child-model' },
      onStart: (request) => { seen = request },
    })
    ctx.llm.registerAdapter(['alpha'], new MockAdapter([], {
      efforts: [{ id: ReasoningEffortId('high'), name: 'High' }],
    }))

    await callSubagent(ctx, {
      description: 'd',
      prompt: 'p',
      provider: 'alpha',
      model: 'child-model',
    })
    expect(ctx.tools.schemas(modelSelectionSetupAgent(ctx)).find(schema => schema.name === 'subagent')?.description)
      .toContain('this backend\'s route defaults')
    expect(seen?.agentOptions).toEqual({
      provider: 'alpha',
      model: 'child-model',
      reasoningEffort: 'high',
      maxTokens: 321,
    })
  })

  it('does not inherit parent effort for a provider-owned route default', async () => {
    let seen: SubagentStartRequest | undefined
    const ctx = await setup({
      provider: 'mock',
      withModelSelection: true,
      parentAgentOptions: {
        provider: 'alpha',
        model: 'child-model',
        reasoningEffort: ReasoningEffortId('high'),
      },
      maxDepth: 'provider-managed',
    }, {
      agentRouteDefaults: { provider: 'alpha', model: 'child-model' },
      onStart: (request) => { seen = request },
    })
    ctx.llm.registerAdapter(['alpha'], new MockAdapter([]))
    const parent = modelSelectionSetupAgent(ctx)

    const result = await callSubagent(ctx, {
      description: 'd',
      prompt: 'p',
      provider: 'alpha',
      model: 'child-model',
    }, { agent: parent })

    if (result.isError) throw new Error(text(result))
    expect(result.isError).toBe(false)
    expect(seen?.agentOptions).toEqual({ provider: 'alpha', model: 'child-model' })
  })

  it('defaults toolName and omits agentOptions when apply() is called directly (schema bypass)', async () => {
    // `ctx.plugin` validates+defaults config first (toolName→'subagent', the
    // agentOptions object→{}), so the runtime `?? 'subagent'` fallback and the
    // no-agentOptions branch are only reachable via a direct apply() that
    // bypasses schemastery — the same pattern acp-agent uses for its defaults.
    let seen: { agentOptions?: unknown } | undefined
    const ctx = await projectedContext()
    await mountWorkingDirectoryFixture(ctx)
    await ctx.plugin(SubagentRuntime)
    ctx.subagents.registerProvider({
      name: 'bare',
      capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false, repository: false },
      inheritsParentContext: false,
      start: async (request) => {
        seen = request
        return {
          id: SessionId('bare-child'),
          result: Promise.resolve({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' as const }),
          dispose: async () => {},
        }
      },
    })
    // Direct apply with only `provider` — no toolName, no agentOptions.
    await tool.apply(ctx, { maxDepth: 'provider-managed', provider: 'bare' })
    await new Promise(r => setTimeout(r, 10))

    expect(ctx.tools.schemas().some(s => s.name === 'subagent')).toBe(true)
    await callSubagent(ctx, { description: 'd', prompt: 'p' })
    expect(seen?.agentOptions).toBeUndefined()
  })

  it('fails loud when invoked without a calling agent', async () => {
    const ctx = await setup({ provider: 'mock' })
    const result = await callSubagent(ctx, { description: 'd', prompt: 'p' }, { agent: undefined })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('requires a calling agent')
  })

  it('registers when the provider appears LATER — no load-order requirement (Loader starts siblings concurrently)', async () => {
    const ctx = await projectedContext()
    await mountWorkingDirectoryFixture(ctx)
    await ctx.plugin(SubagentRuntime)
    // Tool first: no provider yet — the tool must be absent, not broken.
    // Direct apply (schema bypass): also covers the waiting-note's default
    // toolName fallback, which validated config pre-fills.
    await tool.apply(ctx, { provider: 'mock' })
    expect(ctx.tools.schemas().some(s => s.name === 'subagent')).toBe(false)
    // Backend arrives (as a delayed sibling fiber would): the tool appears.
    await mock.mountScriptedProvider(ctx, { name: 'mock', reply: 'late but fine' })
    expect(ctx.tools.schemas().some(s => s.name === 'subagent')).toBe(true)
    const result = await callSubagent(ctx, { description: 'd', prompt: 'p' })
    expect(text(result)).toBe('late but fine')
  })

  it('keeps continuable guidance empty while its provider is absent', async () => {
    const ctx = await projectedContext()
    await mountWorkingDirectoryFixture(ctx)
    await ctx.plugin(SubagentRuntime)
    await tool.apply(ctx, {
      provider: 'later-continuable',
      maxDepth: 'provider-managed',
    })

    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.sections.find(section => section.name === 'tool:subagent')?.text).toBe('')
    expect(ctx.tools.schemas().some(schema => schema.name === 'subagent')).toBe(false)
  })

  it('shares delegation guidance across visible tools as providers and plugin fibers change', async () => {
    const ctx = await projectedContext()
    await mountWorkingDirectoryFixture(ctx)
    await ctx.plugin(SubagentRuntime)
    const forkTool = await ctx.plugin(tool, { provider: 'fork', toolName: 'subagent_fork' })
    const spawnTool = await ctx.plugin(tool, { provider: 'spawn' })
    expect(await delegationGuidance(ctx)).toEqual([])

    const forkProvider = await mock.mountScriptedProvider(ctx, { name: 'fork', inheritsParentContext: true })
    expect(await delegationGuidance(ctx)).toEqual([
      'Start independent delegations with `subagent_fork` together in one assistant message and continue useful work while they run. When only waiting for their results remains, end your turn instead of sleeping or polling; the next result starts a new turn.',
    ])
    await mock.mountScriptedProvider(ctx, { name: 'spawn' })
    expect(await delegationGuidance(ctx)).toEqual([
      'Start independent delegations with `subagent` or `subagent_fork` together in one assistant message and continue useful work while they run. When only waiting for their results remains, end your turn instead of sleeping or polling; the next result starts a new turn.',
    ])

    await forkProvider.dispose()
    expect(await delegationGuidance(ctx)).toEqual([
      'Start independent delegations with `subagent` together in one assistant message and continue useful work while they run. When only waiting for their results remains, end your turn instead of sleeping or polling; the next result starts a new turn.',
    ])
    await mock.mountScriptedProvider(ctx, { name: 'fork', inheritsParentContext: true })
    await spawnTool.dispose()
    expect(await delegationGuidance(ctx)).toEqual([
      'Start independent delegations with `subagent_fork` together in one assistant message and continue useful work while they run. When only waiting for their results remains, end your turn instead of sleeping or polling; the next result starts a new turn.',
    ])
    await forkTool.dispose()
    expect(await delegationGuidance(ctx)).toEqual([])
  })

  it('shares guidance only among the viewing agent\'s visible delegation definitions', async () => {
    const ctx = await setup({ provider: 'mock' })
    await ctx.plugin(tool, { provider: 'mock', toolName: 'subagent_fork' })
    const unrelated = await setup({ provider: 'mock', toolName: 'other_delegate' })
    const parent = (await ctx.agents.create({ sessionId: SessionId('guidance-parent') })).agent
    const peer = (await ctx.agents.create({ sessionId: SessionId('guidance-peer') })).agent
    const showSpawn = parent.ctx.tools.restrict({ deny: ['subagent'] })
    expect(await delegationGuidance(ctx, parent)).toEqual([
      'Start independent delegations with `subagent_fork` together in one assistant message and continue useful work while they run. When only waiting for their results remains, end your turn instead of sleeping or polling; the next result starts a new turn.',
    ])
    expect(await delegationGuidance(ctx, peer)).toEqual([
      'Start independent delegations with `subagent` or `subagent_fork` together in one assistant message and continue useful work while they run. When only waiting for their results remains, end your turn instead of sleeping or polling; the next result starts a new turn.',
    ])
    expect(await delegationGuidance(unrelated)).toEqual([
      'Start independent delegations with `other_delegate` together in one assistant message and continue useful work while they run. When only waiting for their results remains, end your turn instead of sleeping or polling; the next result starts a new turn.',
    ])
    showSpawn()

    const scoped = await parent.ctx.plugin(tool, { provider: 'mock', toolName: 'subagent' })
    expect(await delegationGuidance(ctx, parent)).toEqual([
      'Start independent delegations with `subagent` or `subagent_fork` together in one assistant message and continue useful work while they run. When only waiting for their results remains, end your turn instead of sleeping or polling; the next result starts a new turn.',
    ])
    await scoped.dispose()
    parent.ctx.tools.restrict({ deny: ['subagent', 'subagent_fork'] })
    expect(await delegationGuidance(ctx, parent)).toEqual([])
  })

  it('mirrors the provider lifecycle: gone on backend dispose, re-derived wording on re-registration', async () => {
    const ctx = await projectedContext()
    await mountWorkingDirectoryFixture(ctx)
    await ctx.plugin(SubagentRuntime)
    const backend = await mock.mountScriptedProvider(ctx, { name: 'mock' }) // fresh conversation (descriptor: false)
    await ctx.plugin(tool, { provider: 'mock' })
    expect(ctx.tools.schemas().find(s => s.name === 'subagent')!.description).toContain('works in its own context')

    // Backend unloads (HMR shape): the tool must not outlive its provider.
    await backend.dispose()
    expect(ctx.tools.schemas().some(s => s.name === 'subagent')).toBe(false)

    // Backend reloads with a DIFFERENT conversation-history descriptor: the wording is re-derived
    // from the fresh provider, not served stale from the first mount.
    await mock.mountScriptedProvider(ctx, { name: 'mock', inheritsParentContext: true })
    expect(ctx.tools.schemas().find(s => s.name === 'subagent')!.description).toContain('inherits this conversation')
  })

  it('the tool PLUGIN fiber owns its lifecycle listeners: disposal unmounts, and a disposed fiber never zombie-mounts', async () => {
    const ctx = await projectedContext()
    await mountWorkingDirectoryFixture(ctx)
    await ctx.plugin(SubagentRuntime)

    // Arm 1: a mounted tool and its prompt section die with the plugin fiber;
    // the provider survives.
    ctx.subagents.registerProvider({
      name: 'continuable',
      capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false, repository: false },
      inheritsParentContext: false,
      start: async () => { throw new Error('lifecycle test does not start a child') },
      prepareContinuable: async () => ({}),
    })
    const mounted = await ctx.plugin(tool, {
      provider: 'continuable',
      maxDepth: 'provider-managed',
    })
    expect(ctx.tools.schemas().some(s => s.name === 'subagent')).toBe(true)
    expect((await ctx.systemPrompt.assemble()).sections.some(s => s.name === 'tool:subagent')).toBe(true)
    await mounted.dispose()
    expect(ctx.tools.schemas().some(s => s.name === 'subagent')).toBe(false)
    expect((await ctx.systemPrompt.assemble()).sections.some(s => s.name === 'tool:subagent')).toBe(false)
    expect(ctx.subagents.getProvider('continuable')).toBeDefined()

    // Arm 2: a fiber disposed while WAITING must not react to the provider
    // arriving later — a surviving listener would re-register a tool that no
    // live plugin owns (the zombie mount).
    const waiting = await ctx.plugin(tool, { provider: 'later', toolName: 'subagent_later' })
    await waiting.dispose()
    await mock.mountScriptedProvider(ctx, { name: 'later' })
    expect(ctx.tools.schemas().some(s => s.name === 'subagent_later')).toBe(false)
  })

  it('ignores lifecycle events for OTHER providers', async () => {
    const ctx = await projectedContext()
    await mountWorkingDirectoryFixture(ctx)
    await ctx.plugin(SubagentRuntime)
    await mock.mountScriptedProvider(ctx, { name: 'mock' })
    await ctx.plugin(tool, { provider: 'mock' })
    // An unrelated provider registering (added-event with another name) and
    // unregistering (removed-event with another name) must not touch the tool.
    const other = await mock.mountScriptedProvider(ctx, { name: 'other', inheritsParentContext: true })
    expect(ctx.tools.schemas().filter(s => s.name === 'subagent')).toHaveLength(1)
    expect(ctx.tools.schemas().find(s => s.name === 'subagent')!.description).toContain('works in its own context')
    await other.dispose()
    expect(ctx.tools.schemas().some(s => s.name === 'subagent')).toBe(true)
  })

  it('derives spawn-shaped wording from a fresh-conversation provider (default mock)', async () => {
    const ctx = await setup({ provider: 'mock' })
    const schema = ctx.tools.schemas().find(s => s.name === 'subagent')!
    expect(schema.description).toContain('works in its own context')
    const props = (schema.parameters as { properties: Record<string, { description: string }> }).properties
    expect(props['prompt']!.description).toContain('include everything it needs')
  })

  it('derives inherited-context wording from a seeded-conversation provider', async () => {
    const ctx = await setup({
      provider: 'mock',
      toolName: 'subagent',
    }, { inheritsParentContext: true })
    const schema = ctx.tools.schemas().find(s => s.name === 'subagent')!
    expect(schema.description).toContain('inherits this conversation')
    expect(schema.description).not.toContain('does not see this conversation')
    expect(schema.description).not.toContain('Inspect options with `list_subagent_models`')
    const props = (schema.parameters as { properties: Record<string, { description: string }> }).properties
    expect(props['prompt']!.description).toContain('completed turns')
  })

  it('skips provider startup for an already-aborted signal', async () => {
    const sawAborted = vi.fn()
    const ctx = await projectedContext()
    await mountWorkingDirectoryFixture(ctx)
    await ctx.plugin(SubagentRuntime)
    ctx.subagents.registerProvider({
      name: 'spy',
      capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false, repository: false },
      inheritsParentContext: false,
      start: async (request) => {
        if (request.signal.aborted) sawAborted()
        throw new Error('start aborted')
      },
    })
    await ctx.plugin(tool, { provider: 'spy', maxDepth: 'provider-managed' })

    const controller = new AbortController()
    controller.abort() // already aborted BEFORE the tool runs
    const result = await callSubagent(ctx, { description: 'd', prompt: 'p' }, { signal: controller.signal })
    expect(sawAborted).not.toHaveBeenCalled()
    expect(result.isError).toBe(true)
    expect(result.error).toEqual({
      message: 'tool call aborted before dispatch',
      info: { name: 'AbortError', code: TOOL_ABORTED_BEFORE_DISPATCH },
    })
  })

  it('tools depend on the service: no `subagent` tool without ctx.subagents', async () => {
    const ctx = await projectedContext()
    // No SubagentRuntime mounted. The tool injects its required services so its
    // apply never runs; the tool is absent rather than half-registered.
    let booted = true
    try {
      await ctx.plugin(tool, { provider: 'mock' })
      await new Promise(r => setTimeout(r, 20))
    } catch {
      booted = false
    }
    // Either it never booted, or it booted but registered no tool.
    const present = ctx.get('tools')?.schemas().some(s => s.name === 'subagent') ?? false
    expect(booted && present).toBe(false)
  })

  it('has the namespace-plugin export shape (no stray default) so the Loader keeps name/inject/Config/apply', () => {
    // Postmortem 0001 guard: this plugin HAS an explicit `inject`, so
    // a stray `export default apply` would collapse the module via
    // `unwrapExports` (`exports.default ?? exports`), DROP `inject`, and crash at
    // load with "cannot get property … without inject". Guard the shape directly.
    expect('default' in tool).toBe(false)
    expect(tool.name).toBe('tool-subagent')
    expect(tool.inject).toEqual(['tools', 'subagents', 'systemPrompt', 'sessionProjections'])

    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(tool) as Record<string, unknown>
    expect(unwrapped).toBe(tool)
    expect(unwrapped.name).toBe('tool-subagent')
    expect(unwrapped.inject).toEqual(['tools', 'subagents', 'systemPrompt', 'sessionProjections'])
    expect(typeof unwrapped.apply).toBe('function')
    expect(unwrapped.Config).toBeDefined()
  })

  it('passes maxDepth config through to the start request', async () => {
    let seen: { maxDepth?: number } | undefined
    const ctx = await projectedContext()
    await mountWorkingDirectoryFixture(ctx)
    await ctx.plugin(SubagentRuntime)
    ctx.subagents.registerProvider({
      name: 'capture2',
      capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: true, repository: false },
      inheritsParentContext: false,
      start: async (request) => {
        seen = request
        return {
          id: SessionId('capture2-child'),
          result: Promise.resolve({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' as const }),
          dispose: async () => {},
        }
      },
    })
    await ctx.plugin(tool, {
      provider: 'capture2',
      maxDepth: 2,
    })

    await callSubagent(ctx, { description: 'd', prompt: 'p' })
    expect(seen?.maxDepth).toBe(2)
  })

  it.each([
    { label: 'a string', value: '1' as unknown as number },
    { label: 'NaN', value: Number.NaN },
    { label: 'positive infinity', value: Number.POSITIVE_INFINITY },
    { label: 'negative infinity', value: Number.NEGATIVE_INFINITY },
    { label: 'a negative integer', value: -1 },
    { label: 'a fractional number', value: 1.5 },
    { label: 'negative zero', value: -0 },
    { label: 'an unsafe integer', value: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects maxDepth=$label when the plugin loads', async ({ value }) => {
    await expect(setup({ provider: 'mock', maxDepth: value }))
      .rejects.toThrow()
  })

  it('validates maxDepth during initialization without Schemastery', async () => {
    const ctx = await projectedContext()
    await expect(tool.apply(ctx, {
      provider: 'unused',
      maxDepth: Number.NaN,
    })).rejects.toThrow('subagent maxDepth must be a non-negative safe integer')
  })

  it.each([
    { persona: 'Child persona' },
    { toolFilter: { deny: ['subagent'] } },
    { toolFilter: {} },
    { persona: undefined },
  ])('rejects removed composition configuration at plugin load: %j', async (removed) => {
    await expect(setup({ provider: 'mock', ...removed }))
      .rejects.toThrow(/no longer supported; configure persona and tool plugins in an Agent Preset/)
  })

  it('an omitted agentOptions does not materialize an empty object onto the request', async () => {
    // An omitted `agentOptions` materializes `{}` without the forced default,
    // which reads as present and puts a dishonest `agentOptions: {}` on every
    // start request.
    let seen: { agentOptions?: unknown } | undefined
    const ctx = await projectedContext()
    await mountWorkingDirectoryFixture(ctx)
    await ctx.plugin(SubagentRuntime)
    ctx.subagents.registerProvider({
      name: 'capture4',
      capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false, repository: false },
      inheritsParentContext: false,
      start: async (request) => {
        seen = request
        return {
          id: SessionId('capture4-child'),
          result: Promise.resolve({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' as const }),
          dispose: async () => {},
        }
      },
    })
    await ctx.plugin(tool, { provider: 'capture4', maxDepth: 'provider-managed' })
    await callSubagent(ctx, { description: 'd', prompt: 'p' })
    expect(seen).toBeDefined()
    expect(seen).not.toHaveProperty('agentOptions')
  })

})

describe('dsh-tool-subagent local activation', () => {
  const fixtures: { ctx: Context; root: string }[] = []
  afterEach(async () => {
    for (const { ctx, root } of fixtures.splice(0)) {
      await ctx.fiber.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  /** Boot the real continuable stack without any model-facing follow-up adapter. */
  async function continuableSetup() {
    const ctx = new Context()
    const root = mkdtempSync(path.join(tmpdir(), 'dsh-tool-subagent-continuable-'))
    fixtures.push({ ctx, root })
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(JsonlSessionPersistence, { root })
    await ctx.plugin(AgentLoop, { agents: [] })
    await mountWorkingDirectoryFixture(ctx)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
    await ctx.plugin(tool, { provider: 'spawn', backgroundMode: 'continuable' })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([
      textResponse('continuable answer'),
    ]))
    const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
    return { ctx, parent }
  }

  it('classifies local activations concurrency-safe', async () => {
    const { ctx } = await continuableSetup()
    expect(new ToolExecutionPipeline(ctx).executionMode({
      signal: testToolSignal,
      callId: ToolCallId('subagent-continuable'),
      name: 'subagent',
      arguments: { description: 'do work', prompt: 'Reply OK' },
    })).toEqual({ kind: 'parallel' })
  })

  it('starts a local activation and returns only its durable id', async () => {
    const { ctx, parent } = await continuableSetup()
    const schema = ctx.tools.schemas().find(s => s.name === 'subagent')!
    // Continuable delegation has no Task, so the schema promises no collection.
    expect(schema.description).not.toContain('job_output')
    expect(schema.description).not.toContain('job_kill')
    expect(schema.description).toContain('send_message')
    expect(schema.description).toContain('you are notified when the run settles')
    expect(schema.description).not.toContain('send_message` starts a later turn')
    expect(schema.description).toContain('runs in the background by default')
    expect(schema.description).not.toContain('never poll or wait on it')
    const properties = (schema.parameters as {
      properties: Record<string, { description?: string }>
    }).properties
    expect(properties.run_in_background?.description).toContain('Defaults to true')
    const assembly = await ctx.systemPrompt.assemble(assembleContextFor(parent))
    const guidance = assembly.sections.find(section => section.name === 'tool:subagent')
    expect(guidance?.text).toBe('Start independent delegations with `subagent` together in one assistant message and continue useful work while they run. When only waiting for their results remains, end your turn instead of sleeping or polling; the next result starts a new turn.')

    const started = await callSubagent(
      ctx,
      { description: 'continuable work', prompt: 'dig in' },
      { agent: parent },
    )
    expect(started.isError, text(started)).toBe(false)
    const match = /^started subagent (\S+)$/.exec(text(started))
    expect(match).not.toBeNull()
    const [, childId] = match!
    // A provider that reports no handles keeps the single-line result.
    expect(text(started)).toBe(`started subagent ${childId}`)
    // No Task was created for the continuable child.

    await vi.waitFor(() => {
      expect(ctx.agents.get(SessionId(childId!))).toBeUndefined()
    }, { timeout: 5_000 })
    // The child id names a durable session carrying its continuation descriptor.
    const loaded = await loadStoredSession(ctx.sessionPersistence, SessionId(childId!))
    expect(loaded.events.some(event => event.type === 'subagent/descriptor')).toBe(true)
    expect(loaded.events.some(event => event.type === 'assistant/message')).toBe(true)
  })

  it('hides continuable guidance when the current agent cannot see the tool', async () => {
    const { ctx, parent } = await continuableSetup()
    parent.ctx.tools.restrict({ deny: ['subagent'] })

    expect(ctx.tools.get('subagent', parent)).toBeUndefined()
    const assembly = await ctx.systemPrompt.assemble(assembleContextFor(parent))
    expect(assembly.sections.find(section => section.name === 'tool:subagent')?.text).toBe('')
  })

  it('reports one line per provider handle after the child id', async () => {
    // A worktree-isolated provider owns the child's directory and branch. The
    // parent needs both spelled out to hand the child to another agent, and a
    // provider that reports nothing must keep the single-line result.
    const { ctx, parent } = await continuableSetup()
    ctx.subagents.registerProvider({
      name: 'handling',
      capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: true, repository: false },
      inheritsParentContext: false,
      start: async () => { throw new Error('continuable policy must not start a one-shot child') },
      prepareContinuable: async () => ({ handles: { worktree: '/wt/thread-1', branch: 'dsh/thread-1' } }),
    })
    await tool.apply(ctx, { provider: 'handling', toolName: 'subagent_handles', backgroundMode: 'continuable' })

    const result = await executeModelToolFixture(ctx, {
      signal: testToolSignal,
      callId: ToolCallId('handles-start'),
      name: 'subagent_handles',
      arguments: { description: 'isolated work', prompt: 'dig in' },
      agent: parent,
    })

    expect(result.isError).toBe(false)
    expect(text(result)).toMatch(/^started subagent \S+\nworktree: \/wt\/thread-1\nbranch: dsh\/thread-1$/)
  })

  it('refuses a foreground request on a provider that isolates only its continuable children', async () => {
    // Such a provider establishes its working directory while preparing a
    // continuable creation and nowhere else, so the one-shot foreground route
    // would run the child in the parent's own checkout. The refusal is the
    // point: the isolation must not be dropped silently.
    const { ctx, parent } = await continuableSetup()
    const calls: string[] = []
    ctx.subagents.registerProvider({
      name: 'isolating',
      capabilities: { agentOptions: false, agentPreset: false, outputSchema: true, depthLimit: true, repository: false },
      inheritsParentContext: false,
      isolatesContinuableCwd: true,
      start: async () => {
        calls.push('start')
        throw new Error('an isolating provider must not take the one-shot route')
      },
      prepareContinuable: async () => {
        calls.push('prepare')
        return {}
      },
    })
    await tool.apply(ctx, {
      provider: 'isolating',
      toolName: 'subagent_isolating',
      backgroundMode: 'continuable',
    })

    const result = await executeToolFixture(ctx, {
      signal: testToolSignal,
      callId: ToolCallId('call-isolating'),
      name: 'subagent_isolating',
      arguments: { description: 'blocking work', prompt: 'dig in', run_in_background: false },
      agent: parent,
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('run_in_background: false is not available for this provider')
    // Neither route ran: the refusal happens before any child exists.
    expect(calls).toEqual([])
  })

  it('isolates a cancelled continuable preparation from a concurrent sibling', async () => {
    const { ctx, parent } = await continuableSetup()
    const bothPreparing = Promise.withResolvers<undefined>()
    const releasePreparations = Promise.withResolvers<undefined>()
    const cancelled = new AbortController()
    let preparationCount = 0
    let cancelledChildId: ReturnType<typeof SessionId> | undefined
    let survivingChildId: ReturnType<typeof SessionId> | undefined
    ctx.subagents.registerProvider({
      name: 'gated',
      capabilities: { agentOptions: false, agentPreset: false, outputSchema: true, depthLimit: true, repository: false },
      inheritsParentContext: false,
      start: async () => { throw new Error('continuable policy must not start a one-shot child') },
      prepareContinuable: async (request) => {
        preparationCount += 1
        if (request.signal === cancelled.signal) cancelledChildId = request.sessionId
        else survivingChildId = request.sessionId
        if (preparationCount === 2) bothPreparing.resolve(undefined)
        await releasePreparations.promise
        return {}
      },
    })
    await tool.apply(ctx, {
      provider: 'gated',
      toolName: 'subagent_gated',
      backgroundMode: 'continuable',
      maxDepth: 3,
    })

    const execute = (callId: string, description: string, signal: AbortSignal) => executeToolFixture(ctx, {
      signal,
      callId: ToolCallId(callId),
      name: 'subagent_gated',
      arguments: { description, prompt: 'work' },
      agent: parent,
    })
    const cancelledResult = execute('continuable-cancelled', 'cancelled sibling', cancelled.signal)
    const survivingResult = execute('continuable-surviving', 'surviving sibling', testToolSignal)
    await bothPreparing.promise
    cancelled.abort()
    releasePreparations.resolve(undefined)

    const [failed, succeeded] = await Promise.all([cancelledResult, survivingResult])
    expect(preparationCount).toBe(2)
    expect(failed.isError).toBe(true)
    expect(succeeded.isError, text(succeeded)).toBe(false)
    expect(cancelledChildId).toBeDefined()
    expect(survivingChildId).toBeDefined()
    expect(ctx.agents.get(cancelledChildId!)).toBeUndefined()
    await expect(loadStoredSession(ctx.sessionPersistence, cancelledChildId!)).rejects.toThrow(/not found/)

    expect(succeeded.isError ? undefined : succeeded.value).toEqual({
      kind: 'continuable',
      subagentId: survivingChildId,
    })
    await vi.waitFor(() => {
      expect(ctx.agents.get(survivingChildId!)).toBeUndefined()
    }, { timeout: 5_000 })
    const loaded = await loadStoredSession(ctx.sessionPersistence, survivingChildId!)
    expect(loaded.events.some(event => event.type === 'subagent/descriptor')).toBe(true)
    expect(loaded.events.some(event => event.type === 'assistant/message')).toBe(true)
  })

})

describe('dsh-tool-subagent one-shot background jobs', () => {
  /** Boot the jobs stack over the scripted provider for background calls. */
  async function backgroundSetup(config: toolConfig, mockConfig: Partial<mock.Config> = {}) {
    const ctx = await setup(config, mockConfig)
    await ctx.plugin(LocalJobRegistry)
    await ctx.plugin(ToolJobs, {})
    return ctx
  }

  it('returns a job id immediately and the answer is collected through job_output', async () => {
    const ctx = await backgroundSetup({ provider: 'mock' }, { reply: 'background answer' })
    const parent = modelSelectionSetupAgent(ctx)

    const start = await callSubagent(ctx, {
      description: 'deep research',
      prompt: 'dig in',
      run_in_background: true,
    })
    expect(start.isError).toBe(false)
    if (start.isError) throw new Error('expected background subagent success')
    const value = start.value
    if (typeof value !== 'object' || value === null || !('jobId' in value) || typeof value.jobId !== 'string') {
      throw new Error('expected a background start carrying a job id')
    }
    const jobId = value.jobId
    // Job ids are derived from the call identity, not counted per runtime.
    expect(jobId).toMatch(/^subagent-[0-9a-f]{16}$/)
    expect(text(start)).toBe(`started background subagent job ${jobId}`)

    const collected = await executeModelToolFixture(ctx, {
      signal: testToolSignal,
      callId: ToolCallId('collect-1'),
      name: 'job_output',
      arguments: { job_id: jobId, wait: true },
      agent: parent,
    })
    expect(text(collected)).toBe('background answer\n[status: completed]')
  })

  it('fails loud when the jobs runtime is not loaded', async () => {
    const ctx = await setup({ provider: 'mock' })
    const result = await callSubagent(ctx, {
      description: 'd',
      prompt: 'p',
      run_in_background: true,
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('background jobs unavailable: load @deepseek-ai/dsh-jobs')
  })

  it('refuses a one-shot background child for a provider that implements no start', async () => {
    // A continuable-only provider has no one-shot run for the job to own, so
    // the branch refuses with an actionable message instead of a starter
    // TypeError inside the job.
    const ctx = await projectedContext()
    await mountWorkingDirectoryFixture(ctx)
    await ctx.plugin(SubagentRuntime)
    ctx.subagents.registerProvider({
      name: 'continuable-only',
      capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false, repository: false },
      inheritsParentContext: false,
      prepareContinuable: async () => ({}),
    })
    await ctx.plugin(tool, { provider: 'continuable-only', maxDepth: 'provider-managed' })

    const result = await callSubagent(ctx, {
      description: 'd',
      prompt: 'p',
      run_in_background: true,
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('does not support one-shot background delegation')
    expect(text(result)).toContain('backgroundMode: continuable')
  })
})

describe('depth budget configuration', () => {
  /** Mount the tool over a request-capturing provider with full capabilities. */
  async function captureSetup(config: Omit<toolConfig, 'provider'> = {}) {
    const requests: SubagentStartRequest[] = []
    const ctx = await projectedContext()
    await mountWorkingDirectoryFixture(ctx)
    await ctx.plugin(SubagentRuntime)
    ctx.subagents.registerProvider({
      name: 'capture',
      capabilities: { agentOptions: false, agentPreset: false, outputSchema: true, depthLimit: true, repository: false },
      inheritsParentContext: false,
      start: async (request) => {
        requests.push(request)
        return {
          id: SessionId(`capture-child-${requests.length}`),
          result: Promise.resolve({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' as const }),
          dispose: async () => {},
        }
      },
    })
    await ctx.plugin(tool, { provider: 'capture', ...config })
    return { ctx, requests }
  }

  it('defaults maxDepth to 1 and forwards it in the start request', async () => {
    const { ctx, requests } = await captureSetup()
    await callSubagent(ctx, { description: 'd', prompt: 'p' })
    expect(requests[0]?.label).toBe('d')
    expect(requests[0]?.maxDepth).toBe(1)
  })

  it('rejects a numeric maxDepth on a provider without the depthLimit capability at mount', async () => {
    const ctx = await projectedContext()
    await mountWorkingDirectoryFixture(ctx)
    await ctx.plugin(SubagentRuntime)
    ctx.subagents.registerProvider({
      name: 'no-depth',
      capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false, repository: false },
      inheritsParentContext: false,
      start: async () => { throw new Error('unreachable') },
    })
    await expect(ctx.plugin(tool, { provider: 'no-depth' }))
      .rejects.toThrow(/provider-managed/)
  })

  it("'provider-managed' omits the cap so a capability-less provider mounts and starts", async () => {
    const requests: SubagentStartRequest[] = []
    const ctx = await projectedContext()
    await mountWorkingDirectoryFixture(ctx)
    await ctx.plugin(SubagentRuntime)
    ctx.subagents.registerProvider({
      name: 'external',
      capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false, repository: false },
      inheritsParentContext: false,
      start: async (request) => {
        requests.push(request)
        return {
          id: SessionId('external-child'),
          result: Promise.resolve({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' as const }),
          dispose: async () => {},
        }
      },
    })
    await ctx.plugin(tool, { provider: 'external', maxDepth: 'provider-managed' })
    await callSubagent(ctx, { description: 'd', prompt: 'p' })
    expect(requests[0]?.maxDepth).toBeUndefined()
  })
})
