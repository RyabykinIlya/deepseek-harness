import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { LlmCallConfig, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ModelRoutingControl } from '../src/types.ts'
import ModelRoutingService, { Config, ModelRoutingService as ModelRoutingServiceClass } from '../src/index.ts'

const PRO = {
  name: 'pro',
  label: 'Pro',
  models: ['deepseek/deepseek-v4-pro'],
  contextWindow: 1_000_000,
  maxTokens: 32_768,
  input: ['text'],
  minQuantization: 'fp8',
  unknownQuantization: 'reject',
  free: 'off',
}

const FLASH = {
  name: 'flash',
  label: 'Flash',
  models: ['deepseek/deepseek-v4-flash'],
  contextWindow: 1_000_000,
  maxTokens: 32_768,
  input: ['text'],
  minQuantization: 'fp8',
  unknownQuantization: 'trusted',
  free: 'off',
}

/** An adapter that advertises nothing and never dispatches; the route is under test, not the transport. */
class EmptyAdapter extends LlmAdapter {
  override async * stream(): AsyncIterable<StreamChunk> { /* the tests never reach a real request */ }
}

/** Mount the real service over a real LLM runtime, registry, and projections. */
async function setup(config: Record<string, unknown> = {}): Promise<{ ctx: Context; service: ModelRoutingService }> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  ctx.llm.registerAdapter(['openrouter'], new EmptyAdapter())
  await ctx.plugin(ModelRoutingService, { tiers: [PRO, FLASH], ...config } as never)
  // `ctx.plugin` resolves to the fiber; the service itself is what the key holds.
  return { ctx, service: ctx.get('modelRouting') as unknown as ModelRoutingService }
}

describe('ModelRoutingService as a Host plugin', () => {
  it('registers the `tiers` route with the LLM runtime', async () => {
    const { ctx } = await setup()
    const provider = ctx.llm.listProviders().find(entry => entry.id === 'tiers')
    expect(provider).toEqual({ id: 'tiers', name: 'Tiers' })
  })

  it('publishes itself as ctx.modelRouting', async () => {
    const { ctx } = await setup()
    // The Cordis key hands out a scoped proxy rather than the instance itself,
    // so presence is asserted on the behaviour the key exposes.
    expect(ctx.modelRouting.tierNames()).toEqual(['pro', 'flash'])
    expect(typeof ctx.modelRouting.setThreadTier).toBe('function')
  })

  it('refuses a configuration the route cannot serve, at mount', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await expect(ctx.plugin(ModelRoutingService, { tiers: [PRO, FLASH], defaultTier: 'nope' } as never))
      .rejects.toThrow('model-routing: defaultTier "nope" is not a configured tier')
  })
})

describe('the agent/request rewrites', () => {
  /** Fire `agent/request` through the agent-scoped dispatcher. */
  function request(ctx: Context, agent: Agent, proposed: LlmCallConfig): Promise<LlmCallConfig> {
    return agentEvents(ctx, agent).waterfall(
      'agent/request',
      { turn: 1, step: 0, signal: new AbortController().signal },
      () => Promise.resolve(proposed),
    )
  }

  /** The minimal Agent surface the `agent/request` payload carries. */
  function agentFor(session: Session): Agent {
    return { id: session.id, session, options: {} } as unknown as Agent
  }

  it('moves a Thread to the tier the coordinator recorded', async () => {
    const { ctx } = await setup()
    const project = ctx.sessions.create(SessionId('project'))
    const thread = ctx.sessions.create(SessionId('t1'), {
      meta: { parentSession: project.id, origin: 'subagent' },
    })
    project.append('model-routing/tier-override', { threadId: thread.id, tier: 'pro' }, { ignorable: true })
    const result = await request(ctx, agentFor(thread), { provider: 'tiers', model: 'flash' })
    expect(result).toMatchObject({ provider: 'tiers', model: 'pro' })
  })

  it('leaves a Thread alone once the coordinator did not ask for an override', async () => {
    const { ctx } = await setup()
    const thread = ctx.sessions.create(SessionId('t1'), { meta: { origin: 'subagent' } })
    const proposed: LlmCallConfig = { provider: 'tiers', model: 'flash' }
    expect(await request(ctx, agentFor(thread), proposed)).toEqual(proposed)
  })
})

describe('setThreadTier', () => {
  it('records an ignorable override in the Project log', async () => {
    const { ctx, service } = await setup()
    const project = ctx.sessions.create(SessionId('project'))
    service.setThreadTier(project, 't1', 'pro')
    const recorded = project.ownEvents().filter(event => event.type === 'model-routing/tier-override')
    expect(recorded).toHaveLength(1)
    expect(recorded[0]?.ignorable).toBe(true)
    expect(recorded[0]?.data).toEqual({ threadId: 't1', tier: 'pro' })
  })

  it('names the configured tiers when asked for one that is not configured', async () => {
    const { ctx, service } = await setup()
    const project = ctx.sessions.create(SessionId('project'))
    expect(() =>{  service.setThreadTier(project, 't1', 'max') })
      .toThrow('model-routing: unknown tier "max"; configured tiers: pro, flash')
  })
})

describe('the plugin without pi-ai', () => {
  it('mounts anyway and only refuses at request time', async () => {
    const { ctx } = await setup()
    expect(ctx.llm.listProviders().some(entry => entry.id === 'tiers')).toBe(true)
    const prepared = await ctx.llm.prepareCall({ provider: 'tiers', model: 'flash' })
    const chunks: StreamChunk[] = []
    for await (const chunk of prepared.stream({ ...prepared.config, messages: [] })) chunks.push(chunk)
    // The runtime reports an adapter failure as a terminal chunk rather than a throw.
    expect(chunks).toEqual([{
      type: 'finish',
      reason: {
        kind: 'error',
        failure: expect.objectContaining({ code: 'NO_ADAPTER' }) as never,
      },
    }])
    expect(JSON.stringify(chunks)).toContain('service piAiDispatch is absent')
  })
})

describe('the plugin leaving', () => {
  it('withdraws the route with its fiber', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentRegistry)
    const fiber = await ctx.plugin(ModelRoutingService, { tiers: [PRO, FLASH] } as never)
    expect(ctx.llm.listProviders().some(entry => entry.id === 'tiers')).toBe(true)
    await fiber.dispose()
    expect(ctx.llm.listProviders().some(entry => entry.id === 'tiers')).toBe(false)
  })
})

describe('plugin-level logging', () => {
  it('says nothing when the configured tiers describe a catalog', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const warnings: string[] = []
    ctx.logger.warn = ((value: unknown) => { warnings.push(String(value)) }) as typeof ctx.logger.warn
    // Mounted directly rather than through `ctx.plugin`, because the Host key is
    // already taken by an earlier mount in the same file's other cases. The
    // schema runs first, exactly as the loader does before constructing it.
    const service = new ModelRoutingServiceClass(ctx, Config({ tiers: [PRO, FLASH] } as never))
    expect(service.tierNames()).toEqual(['pro', 'flash'])
    expect(warnings).toEqual([])
  })
})

export type { ModelRoutingControl }
