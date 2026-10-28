/**
 * Behavior of the cross-provider fallback switch and its negative controls.
 *
 * @module @deepseek-ai/dsh-llm-fallback/tests
 */

import { afterEach, describe, expect, expectTypeOf, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, {
  createUserMessage,
  LlmAdapter,
  LlmError,
  resolveRetryPolicy,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  NormalRetryPolicyConfig,
  ResolvedRetryPolicy,
  RetryPolicyConfig,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionEventMap } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { agentPresetProjectionDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import type { LlmFallbackEventData } from '../src/types.ts'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as Retry from '@deepseek-ai/dsh-llm-retry'
import * as Fallback from '../src/index.ts'

type ScriptEntry = Error | Iterable<StreamChunk> | AsyncIterable<StreamChunk>

type FallbackConfig = Parameters<typeof Fallback.apply>[1]

it('keeps the fallback event payload identical to the session event', () => {
  expectTypeOf<LlmFallbackEventData>().toEqualTypeOf<SessionEventMap['llm/fallback']>()
})

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  private retryPolicies: Readonly<Record<string, ResolvedRetryPolicy | undefined>> = {}

  constructor(private readonly entries: ScriptEntry[]) {
    super()
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.entries.shift()
    if (entry === undefined) throw new Error('fallback test script exhausted')
    if (entry instanceof Error) throw entry
    yield* entry
  }

  configureRetryPolicies(
    policies: Readonly<Record<string, RetryPolicyConfig | undefined>>,
  ): void {
    this.retryPolicies = Object.fromEntries(Object.entries(policies).map(([provider, policy]) => [
      provider,
      policy === undefined
        ? undefined
        : resolveRetryPolicy(policy, `fallback test provider "${provider}" retryPolicy`),
    ]))
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined {
    return this.retryPolicies[provider]
  }
}

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function normalConfig(overrides: Partial<Omit<NormalRetryPolicyConfig, 'mode'>> = {}): NormalRetryPolicyConfig {
  const { backoff, ...policy } = overrides
  return {
    mode: 'normal',
    maxRetries: 2,
    ...policy,
    backoff: {
      initialDelayMs: 1,
      maxDelayMs: 1,
      jitterRatio: 0,
      ...backoff,
    },
  }
}

/**
 * Mount the loop, llm-retry, and llm-fallback in their shipped order.
 *
 * llm-fallback registers its `agent/request-error` listener FIRST so that
 * llm-retry — registered after it — runs as the downstream delegate that owns
 * same-provider retry budgets, exactly as in a composed deployment.
 */
async function harness(
  adapter: ScriptedAdapter,
  chains: FallbackConfig,
  policies: Readonly<Record<string, RetryPolicyConfig | undefined>>,
): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  // The real agentPreset unit: llm-fallback resolves the chain through it.
  await ctx.sessionProjections.register(agentPresetProjectionDefinition)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  adapter.configureRetryPolicies(policies)
  await ctx.plugin(Fallback, chains)
  await ctx.plugin(Retry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['a', 'b', 'c'], adapter)
  return ctx
}

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

/** Create an agent whose session carries the chain intent. */
async function agentOn(
  ctx: Context,
  id: string,
  options: { provider: string; model: string },
  intent: string,
): Promise<Agent> {
  const agent = await ctx.agentLoop.create(SessionId(id), options)
  agent.session.append('agent-preset/selected', { agentPreset: intent })
  return agent
}

function send(agent: Agent): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
  return agent.whenIdle()
}

function events<T extends SessionEvent['type']>(
  agent: Agent,
  type: T,
): Extract<SessionEvent, { type: T }>[] {
  return agent.session.snapshotEvents().filter(
    (event): event is Extract<SessionEvent, { type: T }> => event.type === type,
  )
}

const twoStepChain = {
  chains: {
    test: {
      name: 'Test Chain',
      steps: [
        { provider: 'a', model: 'model-a' },
        { provider: 'b', model: 'model-b' },
      ],
    },
  },
} satisfies FallbackConfig

describe('fallback switch', () => {
  it('records the next chain step for the following turn once the primary exhausts its retry budget', async () => {
    const adapter = new ScriptedAdapter([
      new LlmError('a failed', 'SERVER'),
      new LlmError('a failed again', 'SERVER'),
      textResponse('b succeeded'),
    ])
    context = await harness(adapter, twoStepChain, {
      a: normalConfig({ maxRetries: 1, retryableCodes: ['SERVER'] }),
    })
    const agent = await agentOn(context, 'fallback-switch', { provider: 'a', model: 'model-a' }, 'test')

    await send(agent)

    // The step's route is captured at preparation, so the failed turn spends only
    // the primary's own budget; the transition applies from the next turn.
    expect(adapter.requests.map(request => request.provider)).toEqual(['a', 'a'])
    expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'error', error: { code: 'SERVER' } } },
    })

    const [event] = events(agent, 'llm/fallback')
    expect(event?.data).toMatchObject({
      turn: 1,
      step: 1,
      provider: 'b',
      model: 'model-b',
      chainIntent: 'test',
      attempt: 2,
      from: { provider: 'a', model: 'model-a' },
      failure: { message: 'a failed again', code: 'SERVER' },
    })
    expect(event?.ignorable).toBe(true)

    // The recorded selection serves the next step on the new provider.
    await send(agent)
    expect(adapter.requests.map(request => request.provider)).toEqual(['a', 'a', 'b'])
    expect(agent.session.deriveMessages().at(-1)).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'b succeeded' }],
      source: { kind: 'model', provider: 'b', model: 'model-b' },
    })
    expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'completed' } },
    })
  })

  it('starts the fallback provider with a fresh retry budget on the following turn', async () => {
    const adapter = new ScriptedAdapter([
      new LlmError('a failed', 'SERVER'),
      new LlmError('a failed again', 'SERVER'),
      new LlmError('b busy', 'SERVER'),
      textResponse('b succeeded'),
    ])
    context = await harness(adapter, twoStepChain, {
      a: normalConfig({ maxRetries: 1, retryableCodes: ['SERVER'] }),
      b: normalConfig({ maxRetries: 1, retryableCodes: ['SERVER'] }),
    })
    const agent = await agentOn(context, 'fallback-fresh-budget', { provider: 'a', model: 'model-a' }, 'test')

    await send(agent)
    // Turn 1 spends the primary's budget and records the transition.
    expect(adapter.requests.map(request => request.provider)).toEqual(['a', 'a'])

    await send(agent)
    // Turn 2 runs on b with its own fresh budget: initial request + 1 retry.
    expect(adapter.requests.map(request => request.provider)).toEqual(['a', 'a', 'b', 'b'])
    // Retry numbering restarts at 1 for b: a's budget does not carry over.
    expect(events(agent, 'llm/retry').map(item => ({
      provider: item.data.provider,
      retry: item.data.retry,
    }))).toEqual([
      { provider: 'a', retry: 1 },
      { provider: 'b', retry: 1 },
    ])
    expect(agent.session.deriveMessages().at(-1)).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'b succeeded' }],
    })
  })
})

describe('fallback negative controls', () => {
  it('keeps a single-step chain terminal instead of advancing forever (a regression loops)', { timeout: 10_000 }, async () => {
    const adapter = new ScriptedAdapter([
      new LlmError('a failed', 'SERVER'),
      new LlmError('a failed again', 'SERVER'),
    ])
    context = await harness(adapter, {
      chains: {
        test: { steps: [{ provider: 'a', model: 'model-a' }] },
      },
    }, {
      a: normalConfig({ maxRetries: 1, retryableCodes: ['SERVER'] }),
    })
    const agent = await agentOn(context, 'fallback-terminal-single', { provider: 'a', model: 'model-a' }, 'test')

    await send(agent)

    expect(adapter.requests.map(request => request.provider)).toEqual(['a', 'a'])
    expect(events(agent, 'llm/fallback')).toHaveLength(0)
    expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'error', error: { message: 'a failed again', code: 'SERVER' } } },
    })
  })

  it('advances a two-step chain once and then leaves the last step terminal', { timeout: 10_000 }, async () => {
    const adapter = new ScriptedAdapter([
      new LlmError('a failed', 'SERVER'),
      new LlmError('a failed again', 'SERVER'),
      new LlmError('b failed', 'SERVER'),
      new LlmError('b failed again', 'SERVER'),
    ])
    context = await harness(adapter, twoStepChain, {
      a: normalConfig({ maxRetries: 1, retryableCodes: ['SERVER'] }),
      b: normalConfig({ maxRetries: 1, retryableCodes: ['SERVER'] }),
    })
    const agent = await agentOn(context, 'fallback-terminal-last', { provider: 'a', model: 'model-a' }, 'test')

    await send(agent)
    // Turn 1 runs the primary's budget and records the single transition.
    expect(adapter.requests.map(request => request.provider)).toEqual(['a', 'a'])
    expect(events(agent, 'llm/fallback').map(item => item.data.provider)).toEqual(['b'])

    await send(agent)
    // Turn 2 runs the chain's last step; it has no successor, so its failure is
    // terminal without a second transition.
    expect(adapter.requests.map(request => request.provider)).toEqual(['a', 'a', 'b', 'b'])
    expect(events(agent, 'llm/fallback').map(item => item.data.provider)).toEqual(['b'])
    expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'error', error: { code: 'SERVER' } } },
    })
  })

  it('leaves a provider outside every chain on the pre-feature terminal path', async () => {
    const adapter = new ScriptedAdapter([new LlmError('c failed', 'AUTH')])
    context = await harness(adapter, twoStepChain, {
      c: normalConfig({ maxRetries: 0, retryableCodes: ['AUTH'] }),
    })
    const agent = await agentOn(context, 'fallback-outside-chain', { provider: 'c', model: 'model-c' }, 'test')

    await send(agent)

    expect(adapter.requests).toHaveLength(1)
    expect(events(agent, 'llm/fallback')).toHaveLength(0)
    expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'error', error: { code: 'AUTH' } } },
    })
  })

  it('leaves a session without a matching chain intent on the pre-feature terminal path', async () => {
    const adapter = new ScriptedAdapter([
      new LlmError('a failed', 'SERVER'),
      new LlmError('a failed again', 'SERVER'),
    ])
    context = await harness(adapter, twoStepChain, {
      a: normalConfig({ maxRetries: 1, retryableCodes: ['SERVER'] }),
    })
    const agent = await agentOn(context, 'fallback-unmatched-intent', { provider: 'a', model: 'model-a' }, 'absent')

    await send(agent)

    expect(adapter.requests).toHaveLength(2)
    expect(events(agent, 'llm/fallback')).toHaveLength(0)
    expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'error', error: { code: 'SERVER' } } },
    })
  })

  it('rejects an empty chain at mount, naming the chain key', () => {
    const ctx = new Context()
    new SessionProjectionRegistry(ctx)
    expect(() => {
      Fallback.apply(ctx, { chains: { empty: { steps: [] } } })
    }).toThrow(/chain "empty" has no steps/)
  })

  it('rejects a duplicate (provider, model) pair at mount, naming the chain key', () => {
    const ctx = new Context()
    new SessionProjectionRegistry(ctx)
    expect(() => {
      Fallback.apply(ctx, {
        chains: {
          dup: {
            steps: [
              { provider: 'a', model: 'm' },
              { provider: 'a', model: 'm' },
            ],
          },
        },
      })
    }).toThrow(/chain "dup" has duplicate \(provider, model\) pair: a\|m/)
  })
})
