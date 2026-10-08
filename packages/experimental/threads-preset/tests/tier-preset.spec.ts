/**
 * The tier half of the Threads preset: the delegation row's fixed routes, and the
 * two contract sentences that tell the coordinator and the worker what to do
 * with them.
 *
 * Every case mounts the real preset through the real roster and reads the
 * composition back, because the two halves fail in opposite directions — a
 * delegation row without routes rejects a tier the contract told the coordinator
 * to name, and a contract that names tiers a row cannot offer describes a choice
 * that does not exist.
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
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { ThreadsService } from '@deepseek-ai/dsh-experimental-threads'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { ContinuableCreateSpec, SubagentCapabilities, SubagentProvider, SubagentRun } from '@deepseek-ai/dsh-subagent'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { TestSessionQuery } from '../../../subagent/subagent/tests/test-session-query.ts'
import ThreadsPreset, {
  PROJECT_PRESET_ID,
  PROJECT_THREAD_PRESET_ID,
  THREAD_DELEGATION_ROW_ID,
  coordinatorContract,
  coordinatorPreset,
  workerContract,
} from '../src/index.ts'
import type { ThreadsPresetInput } from '../src/index.ts'
import { TIER_SENTENCES, WORKER_TIER_PARAGRAPH } from '../src/threads-contract.ts'

const BASE_ID = 'standard'
const DISPLAY = { id: 'w', name: 'W', description: 'd', order: 1 }
const THREAD_MODELS = [
  { provider: 'tiers', model: 'flash' },
  { provider: 'tiers', model: 'pro' },
]

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

/** The base rows the preset rewrites: one delegation row, as the shipped base declares it. */
const BASE_ROWS = [
  {
    id: THREAD_DELEGATION_ROW_ID,
    name: source('subagent/tool-subagent/src/index.ts'),
    config: { provider: 'spawn', toolName: 'subagent', backgroundMode: 'continuable' },
  },
]

/** A continuable provider that answers with a fixed creation spec. */
class RecordingProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities
  readonly inheritsParentContext = false

  constructor(readonly name: string, private readonly spec: ContinuableCreateSpec = {}, repository = false) {
    this.capabilities = { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true, repository }
  }

  start(): Promise<SubagentRun> {
    return Promise.reject(new Error(`${this.name} drives only the continuable path`))
  }

  prepareContinuable(): Promise<ContinuableCreateSpec> {
    return Promise.resolve(this.spec)
  }
}

/** Mount the real preset over the real roster. */
async function harness(config: Partial<ThreadsPresetInput> = {}): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Loader)
  ctx.loader.builtins.group = Group
  await mountAgentLoopTestDependencies(ctx)
  const root = mkdtempSync(join(tmpdir(), 'dsh-threads-tier-preset-'))
  roots.push(root)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(ThreadsService)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TestSessionQuery)
  ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('done')]))
  ctx.llm.registerAdapter(['tiers'], new MockAdapter([textResponse('done')]))
  await ctx.plugin(AgentPresets, { default: BASE_ID })
  await ctx.agentPresets.register({ id: BASE_ID, plugins: BASE_ROWS })
  ctx.subagents.registerProvider(new RecordingProvider('spawn'))
  ctx.subagents.registerProvider(new RecordingProvider(THREAD_PROVIDER_NAME, {}, true))
  await ctx.plugin(ThreadsPreset, { basePreset: BASE_ID, ...config })
  return ctx
}

const THREAD_PROVIDER_NAME = 'thread'

/** One Agent composed from `presetId`, mounted the way a running session is. */
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

/** The tool schemas this agent's model is offered. */
async function schemasFor(ctx: Context, agent: Agent): Promise<{ name: string; parameters?: unknown }[]> {
  const assembly = await ctx.systemPrompt.assemble(assembleContext(agent))
  return assembly.tools
}

/** The delegation row's `config`, wherever the preset placed it. */
function delegationConfig(rows: { id?: string; group?: boolean; config?: unknown }[]): Record<string, unknown> | undefined {
  for (const entry of rows) {
    if (Array.isArray(entry.config)) {
      const nested = delegationConfig(entry.config as { id?: string; group?: boolean; config?: unknown }[])
      if (nested !== undefined) return nested
    }
    if (entry.id === THREAD_DELEGATION_ROW_ID) return entry.config as Record<string, unknown>
  }
  return undefined
}

describe('the delegation row\'s fixed routes', () => {
  it('carries the configured routes and its continuable background', () => {
    const preset = coordinatorPreset({
      display: DISPLAY,
      provider: THREAD_PROVIDER_NAME,
      base: BASE_ROWS,
      contract: { checkIn: 'milestones', spawn: 'ask', mergePolicy: 'ask' },
      tools: {},
      threadModels: THREAD_MODELS,
    })
    expect(delegationConfig(preset.plugins as never)).toEqual({
      provider: THREAD_PROVIDER_NAME,
      toolName: 'subagent',
      backgroundMode: 'continuable',
      allowedModels: THREAD_MODELS,
    })
  })

  it('states nothing about routes when none is configured', () => {
    const preset = coordinatorPreset({
      display: DISPLAY,
      provider: THREAD_PROVIDER_NAME,
      base: BASE_ROWS,
      contract: { checkIn: 'milestones', spawn: 'ask', mergePolicy: 'ask' },
      tools: {},
    })
    expect(delegationConfig(preset.plugins as never)).not.toHaveProperty('allowedModels')
  })

  it('mounts with both tiers available', async () => {
    const ctx = await harness({ threadModels: THREAD_MODELS, tierContract: 'tiers' })
    const project = await agentOn(ctx, 'project-1', PROJECT_PRESET_ID)
    const schema = (await schemasFor(ctx, project)).find(entry => entry.name === 'subagent')
    const props = (schema?.parameters as { properties?: Record<string, unknown> } | undefined)?.properties ?? {}
    expect(Object.keys(props)).toContain('provider')
    expect(Object.keys(props)).toContain('model')
  })
})

describe('the tier contract sentences', () => {
  it('tells the coordinator when to pick which tier, and when not to', () => {
    const text = coordinatorContract({ tierContract: 'tiers' })
    expect(text).toContain(TIER_SENTENCES.tiers)
    // The spawn sentence is where the coordinator is choosing a Thread, so the
    // tier sentence belongs immediately after it.
    expect(text.indexOf('Before starting any Thread'))
      .toBeLessThan(text.indexOf(TIER_SENTENCES.tiers))
    expect(text.indexOf(TIER_SENTENCES.tiers))
      .toBeLessThan(text.indexOf('A Thread starts with no history'))
  })

  it('tells the worker to hand a design decision back', () => {
    expect(workerContract({ tierContract: 'tiers' })).toBe(
      `${workerContract()} \n\n${WORKER_TIER_PARAGRAPH}`.replace(' \n', '\n'),
    )
  })

  it('contributes nothing under `none`', () => {
    expect(TIER_SENTENCES.none).toBe('')
    expect(coordinatorContract()).toBe(coordinatorContract({ tierContract: 'none' }))
    expect(workerContract()).toBe(workerContract({ tierContract: 'none' }))
    expect(coordinatorContract()).not.toContain('thread_tier')
    expect(workerContract()).not.toContain('send_message` and stop')
  })

  it('reaches the worker row through the mounted preset', async () => {
    const ctx = await harness({ threadModels: THREAD_MODELS, tierContract: 'tiers' })
    const thread = await agentOn(ctx, 'thread-1', PROJECT_THREAD_PRESET_ID)
    const assembly = await ctx.systemPrompt.assemble(assembleContext(thread))
    expect(assembly.contexts.map(entry => entry.text).join('\n')).toContain(WORKER_TIER_PARAGRAPH)
  })
})

describe('the tier contract\'s requirement', () => {
  it('refuses to mount without both tiers in the delegation row', async () => {
    await expect(harness({ threadModels: [{ provider: 'tiers', model: 'flash' }], tierContract: 'tiers' }))
      .rejects.toThrow('threads-preset: tierContract "tiers" needs threadModels with models "flash" and "pro"')
    await expect(harness({ tierContract: 'tiers' }))
      .rejects.toThrow('threads-preset: tierContract "tiers" needs threadModels with models "flash" and "pro"')
  })

  it('mounts with no tiers at all under `none`', async () => {
    const ctx = await harness()
    await expect(agentOn(ctx, 'project-1', PROJECT_PRESET_ID)).resolves.toBeDefined()
  })
})
