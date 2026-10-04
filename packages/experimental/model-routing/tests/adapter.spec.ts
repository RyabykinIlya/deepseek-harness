import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, RequestMessage, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { OpenRouterEndpoint, OpenRouterRoutingBlock, PiAiDispatch } from '@deepseek-ai/dsh-llm-pi-ai'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEventMap } from '@deepseek-ai/dsh-session'
import { TiersAdapter } from '../src/adapter.ts'
import type { TiersAdapterDeps } from '../src/adapter.ts'
import { Config, readSettings, validateSettings } from '../src/config.ts'
import type { RoutingSettings } from '../src/config.ts'
import { EndpointsCache } from '../src/endpoints-cache.ts'
import { KeyInfo } from '../src/key-info.ts'
import type { JudgeVerdict, ModelRoutingState } from '../src/types.ts'
import { endpointsOf } from './fixtures.ts'

const PRO = {
  name: 'pro',
  label: 'Pro',
  models: ['deepseek/deepseek-v4-pro', 'z-ai/glm-5.3'],
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
  models: ['deepseek/deepseek-v4-flash', 'z-ai/glm-5.3-flash', 'stealth/space-bunny-alpha'],
  contextWindow: 1_000_000,
  maxTokens: 32_768,
  input: ['text'],
  minQuantization: 'fp8',
  unknownQuantization: 'trusted',
  free: 'off',
}

/** One dispatch the fake pi-ai route observed. */
interface Dispatched {
  options: GenerateOptions
  routing: OpenRouterRoutingBlock | undefined
}

/** Everything the adapter tests drive, plus the record of what it did. */
interface Harness {
  adapter: TiersAdapter
  sent: Dispatched[]
  events: SessionEventMap['model-routing/decision'][]
  clock: { now: number }
  endpoints: Record<string, readonly OpenRouterEndpoint[] | Error>
  judge: { reply: Omit<JudgeVerdict, 'rule'> | undefined }
  freeRemaining: number
  origin: string | undefined
}

/** Build an adapter over stub dependencies and recorded endpoint lists. */
async function harness(over: {
  tiers?: Record<string, unknown>[]
  settings?: Record<string, unknown>
  responses?: StreamChunk[][]
  endpoints?: Record<string, readonly OpenRouterEndpoint[] | Error>
  state?: ModelRoutingState
} = {}): Promise<Harness> {
  const clock = 1000
  const tiers = over.tiers ?? [PRO, FLASH] as Record<string, unknown>[]
  const names = tiers.map(tier => (tier as { name: string }).name)
  const settings = (): RoutingSettings => readSettings(Config({
    tiers,
    minUptime: 95,
    trustedUnknownProviders: ['stealth'],
    judgeUserMessages: 3,
    // The judge defaults name `pro`/`flash`; a tier list that has neither would
    // otherwise fail validation before the case under test ever runs.
    defaultTier: names.includes('flash') ? 'flash' : names[0],
    judgeProTier: names.includes('pro') ? 'pro' : names[0],
    judgeFlashTier: names.includes('flash') ? 'flash' : names[0],
    ...over.settings,
  } as never))
  validateSettings(settings())
  const endpoints: Record<string, readonly OpenRouterEndpoint[] | Error> =
    over.endpoints ?? await loadFixtures(tiers as { models: string[] }[])
  const sent: Dispatched[] = []
  const events: SessionEventMap['model-routing/decision'][] = []
  const record: Harness = {
    adapter: undefined as unknown as TiersAdapter,
    sent,
    events,
    clock: { now: clock },
    endpoints: {},
    judge: { reply: undefined },
    freeRemaining: 1000,
    origin: undefined,
  }
  for (const model of Object.keys(endpoints)) record.endpoints[model] = endpoints[model]!

  const cache = new EndpointsCache(async (model) => {
    const list = record.endpoints[model]
    if (list === undefined) throw new Error(`no fixture for ${model}`)
    if (list instanceof Error) throw list
    return list
  }, () => clock)
  const scripted = [...(over.responses ?? [])]
  const dispatch: PiAiDispatch = {
    stream: (options, dispatchOptions) => {
      sent.push({ options, routing: dispatchOptions?.openRouterRouting })
      const chunks = scripted.shift() ?? normalChunks()
      return {
        async *[Symbol.asyncIterator]() {
          for (const chunk of chunks) yield chunk
        },
      } as AsyncIterable<StreamChunk>
    },
  }
  // A real Session header is deep-frozen at creation and its origin is decided
  // there, so the adapter tests drive a stand-in carrying exactly the two members
  // the adapter reads. The durable `Session` contract is exercised in plugin.spec.
  const session = {
    id: SessionId('s1'),
    header: { get origin() { return record.origin ?? 'user' } },
    append(type: string, data: unknown): void {
      if (type === 'model-routing/decision') events.push(data as SessionEventMap['model-routing/decision'])
    },
  } as unknown as Session
  const deps: TiersAdapterDeps = {
    settings,
    dispatch: () => dispatch,
    session: () => session,
    routingState: () => over.state,
    usage: () => undefined,
    innerEfforts: async () => ['off', 'high', 'xhigh'],
    endpoints: cache,
    keyInfo: new KeyInfo({
      fetch: async () => new Response(JSON.stringify({
        data: { free_model_daily_requests: { used: 0, limit: 1000, remaining: record.freeRemaining } },
      })),
      now: () => clock,
      baseUrl: () => 'https://openrouter.ai/api/v1',
      apiKey: () => Promise.resolve('key'),
      headers: () => ({}),
    }),
    judge: async () => (record.judge.reply
      ?? { model: 'typesafe/jev-1.13', pPro: 0, confidence: 1, precision: 0.07, latencyMs: 1 }),
    apiKey: () => Promise.resolve('key'),
    headers: () => ({}),
    now: () => clock,
    warn: (message) => { record.judge.reply ??= { model: 'typesafe/jev-1.13', latencyMs: 0, error: message } },
  }
  record.adapter = new TiersAdapter(deps, {
    routeName: 'tiers',
    routeLabel: 'Tiers',
    innerRoute: 'openrouter',
    decisionsUrl: 'https://openrouter.ai/api/alpha/decisions',
  })
  record.clock.now = clock
  return record
}

/** Load the recorded endpoint lists every tier in the fixture names. */
async function loadFixtures(tiers: { models: string[] }[]): Promise<Record<string, readonly OpenRouterEndpoint[]>> {
  const lists: Record<string, readonly OpenRouterEndpoint[]> = {}
  for (const tier of tiers) {
    for (const model of tier.models) lists[model] = await endpointsOf(model)
  }
  return lists
}

/** The finish chunk a successful turn ends with. */
function normalChunks(): StreamChunk[] {
  return [
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 1 } },
    { type: 'finish', reason: { kind: 'stop' }, replayState: { response: { kind: 'pi-ai', version: 2 } } },
  ]
}

/** A terminal provider failure the adapter is expected to route around. */
function failureChunks(code: string): StreamChunk[] {
  return [{ type: 'finish', reason: { kind: 'error', failure: { code, message: code } } }]
}

/** A folded state as it looks after one turn on `flash`. */
function priorDecision(over: Partial<ModelRoutingState> = {}): ModelRoutingState {
  return {
    decision: {
      boundary: 'start', requested: 'flash', tier: 'flash', model: 'deepseek/deepseek-v4-flash',
      considered: 1, runnersUp: [], excludedTags: [],
    },
    decidedAt: 1,
    lastResponseAt: 1000,
    compactedSinceDecision: false,
    explicitSelection: false,
    overrides: {},
    ...over,
  }
}

/** Drain one request and collect the chunks that reached the caller. */
async function run(adapter: TiersAdapter, over: Partial<GenerateOptions> = {}): Promise<StreamChunk[]> {
  const options = {
    provider: 'tiers',
    model: 'flash',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'do it' }] }],
    sessionId: SessionId('s1'),
    ...over,
  } as GenerateOptions
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream(options)) chunks.push(chunk)
  return chunks
}

beforeEach(() => {
  vi.useRealTimers()
})

describe('TiersAdapter pinning', () => {
  it('pins the cheapest endpoint and records the decision once', async () => {
    const h = await harness()
    await run(h.adapter)
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]?.options.provider).toBe('openrouter')
    expect(h.sent[0]?.options.model).toBe('deepseek/deepseek-v4-flash')
    expect(h.sent[0]?.routing).toEqual({ only: ['streamlake/fp8'], allow_fallbacks: false })
    expect(h.events).toHaveLength(1)
    expect(h.events[0]).toMatchObject({
      boundary: 'start',
      requested: 'flash',
      tier: 'flash',
      model: 'deepseek/deepseek-v4-flash',
    })
    expect(h.events[0]?.endpoint?.tag).toBe('streamlake/fp8')
  })

  it('keeps the pin for the next request in the same session', async () => {
    const h = await harness()
    await run(h.adapter)
    await run(h.adapter)
    expect(h.sent).toHaveLength(2)
    expect(h.events).toHaveLength(1)
    expect(h.sent[1]?.routing).toEqual(h.sent[0]?.routing)
  })

  it('decides again after a compaction, and again after the cache went idle', async () => {
    const compacted = await harness({ state: priorDecision({ compactedSinceDecision: true }) })
    await run(compacted.adapter)
    expect(compacted.events.at(-1)?.boundary).toBe('compaction')

    const idle = await harness({ state: priorDecision({ lastResponseAt: 1000 - 600_001 }) })
    await run(idle.adapter)
    expect(idle.events.at(-1)?.boundary).toBe('idle')
  })

  it('decides again when the requested model changed', async () => {
    const h = await harness()
    await run(h.adapter)
    await run(h.adapter, { model: 'pro' })
    expect(h.events).toHaveLength(2)
    expect(h.events[1]).toMatchObject({ boundary: 'selection-change', tier: 'pro', model: 'deepseek/deepseek-v4-pro' })
    expect(h.events[1]?.endpoint?.tag).toBe('streamlake/fp8')
  })

  it('serves a non-agent request without deciding or recording', async () => {
    const h = await harness()
    await run(h.adapter, { purpose: 'session-title' })
    expect(h.sent).toHaveLength(1)
    expect(h.events).toHaveLength(0)
    // And the next real turn still has to decide for itself.
    await run(h.adapter)
    expect(h.events).toHaveLength(1)
  })

  it('restores a previous instance\'s pin from the log instead of re-deciding', async () => {
    const h = await harness({
      state: {
        decision: {
          boundary: 'start', requested: 'flash', tier: 'flash', model: 'deepseek/deepseek-v4-flash',
          endpoint: {
            tag: 'streamlake/fp8', promptUsd: 1e-8, completionUsd: 2e-8,
          },
          considered: 1, runnersUp: [], excludedTags: [],
        },
        decidedAt: 1, lastResponseAt: 999, compactedSinceDecision: false,
        explicitSelection: false, overrides: {},
      },
    })
    await run(h.adapter)
    expect(h.sent[0]?.routing).toEqual({ only: ['streamlake/fp8'], allow_fallbacks: false })
    expect(h.events).toHaveLength(0)
  })
})

describe('TiersAdapter and the judge', () => {
  it('routes `auto` to the tier the judge names', async () => {
    const h = await harness()
    h.judge.reply = { model: 'typesafe/jev-1.13', answeredBy: 'typesafe/jev-1.13-20260917', pPro: 1, confidence: 1, precision: 0.71, latencyMs: 5 }
    await run(h.adapter, { model: 'auto' })
    expect(h.events[0]).toMatchObject({ tier: 'pro', model: 'deepseek/deepseek-v4-pro' })
    expect(h.events[0]?.judge?.rule).toBe('start-pro')
    expect(h.events[0]?.judge?.answeredBy).toBe('typesafe/jev-1.13-20260917')
  })

  it('falls back to the default tier when the judge fails', async () => {
    const h = await harness()
    h.judge.reply = { model: 'typesafe/jev-1.13', latencyMs: 5, error: 'HTTP 500' }
    await run(h.adapter, { model: 'auto' })
    expect(h.events[0]).toMatchObject({ tier: 'flash', judge: { rule: 'judge-error' } })
  })

  it('uses the default tier without asking when the judge is off', async () => {
    const h = await harness({ settings: { judgeEnabled: false } })
    await run(h.adapter, { model: 'auto' })
    expect(h.events[0]).toMatchObject({ tier: 'flash', judge: { rule: 'judge-off' } })
  })
})

describe('TiersAdapter rerouting', () => {
  it('moves to another provider of the same model after a rate limit', async () => {
    const h = await harness({ responses: [failureChunks('RATE_LIMIT'), normalChunks()] })
    const chunks = await run(h.adapter)
    expect(h.sent).toHaveLength(2)
    expect(h.sent[0]?.options.model).toBe('deepseek/deepseek-v4-flash')
    expect(h.sent[1]?.options.model).toBe('deepseek/deepseek-v4-flash')
    expect(h.sent[1]?.routing).toEqual({ only: ['deepinfra/fp8'], allow_fallbacks: false })
    expect(h.events).toHaveLength(2)
    expect(h.events[1]).toMatchObject({ boundary: 'failure', excludedTags: ['streamlake/fp8'] })
    // Only the successful attempt's chunks reached the caller.
    expect(chunks.some(chunk => chunk.type === 'finish' && chunk.reason.kind === 'error')).toBe(false)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('gives up after the configured reroute budget and reports the last failure', async () => {
    const h = await harness({
      responses: [failureChunks('RATE_LIMIT'), failureChunks('RATE_LIMIT'), failureChunks('RATE_LIMIT')],
    })
    const chunks = await run(h.adapter)
    expect(h.sent).toHaveLength(3)
    expect(new Set(h.sent.map(entry => entry.options.model))).toEqual(new Set(['deepseek/deepseek-v4-flash']))
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error' } })
  })

  it('changes model only once the failing model has no endpoint left', async () => {
    const lists = await loadFixtures([PRO])
    // One admissible endpoint for deepseek-v4-pro, so its failure leaves the
    // route no provider to try and the tier's other model is the only way on.
    const only = lists['deepseek/deepseek-v4-pro']!.find(endpoint => endpoint.slug === 'streamlake/fp8')!
    const h = await harness({
      tiers: [PRO],
      endpoints: { ...lists, 'deepseek/deepseek-v4-pro': [only] },
      responses: [failureChunks('RATE_LIMIT'), normalChunks()],
    })
    await run(h.adapter, { model: 'pro' })
    expect(h.sent).toHaveLength(2)
    expect(h.sent[0]?.options.model).toBe('deepseek/deepseek-v4-pro')
    expect(h.sent[1]?.options.model).toBe('z-ai/glm-5.3')
  })

  it('drops the uptime floor when nothing else passes', async () => {
    const lists = await loadFixtures([PRO])
    // Scoped to one model, and with the endpoints that publish no uptime dropped:
    // §11's rejection rule admits an endpoint that states no measurement, so a
    // floor above 100 would still rank those two instead of relaxing.
    const measured = Object.fromEntries(Object.entries(lists).map(([model, list]) => [
      model,
      (list as OpenRouterEndpoint[]).filter(entry => entry.uptimeLast30m !== undefined),
    ]))
    const h = await harness({
      tiers: [{ ...PRO, models: ['deepseek/deepseek-v4-pro'] }],
      endpoints: measured,
      settings: { minUptime: 101 },
    })
    await run(h.adapter, { model: 'pro' })
    expect(h.sent).toHaveLength(1)
    expect(h.events[0]?.relaxedUptime).toBe(true)
  })
})

describe('TiersAdapter free endpoints', () => {
  it('prefers a free endpoint for a top-level session', async () => {
    const h = await harness({
      tiers: [{ ...FLASH, free: 'prefer' }],
      responses: [normalChunks()],
    })
    await run(h.adapter)
    expect(h.sent[0]?.options.model).toBe('stealth/space-bunny-alpha')
    expect(h.sent[0]?.routing).toEqual({ only: ['stealth'], allow_fallbacks: false })
  })

  it('never spends a subagent on a free endpoint', async () => {
    const h = await harness({ tiers: [{ ...FLASH, free: 'prefer' }], settings: { freeForSubagents: false } })
    h.origin = 'subagent'
    await run(h.adapter)
    expect(h.sent[0]?.options.model).toBe('deepseek/deepseek-v4-flash')
  })

  it('keeps to a paid endpoint when the daily budget is nearly spent', async () => {
    const h = await harness({ tiers: [{ ...FLASH, free: 'prefer' }] })
    h.freeRemaining = 5
    await run(h.adapter)
    expect(h.sent[0]?.options.model).toBe('deepseek/deepseek-v4-flash')
  })
})

describe('TiersAdapter request shaping', () => {
  it('maps the tier effort onto what the chosen model supports', async () => {
    const h = await harness()
    await run(h.adapter, { reasoningEffort: ReasoningEffortId('medium') })
    expect(h.sent[0]?.options.reasoningEffort).toBe('high')
  })

  it('caps the output at what the endpoint accepts', async () => {
    const h = await harness()
    await run(h.adapter, { maxTokens: 500_000 })
    expect(h.sent[0]?.options.maxTokens).toBe(384_000)
  })

  it('wraps the finish envelope with the inner route and concrete model', async () => {
    const h = await harness()
    const chunks = await run(h.adapter)
    const finish = chunks.at(-1)
    expect(finish).toMatchObject({ type: 'finish', replayState: { response: { kind: 'model-routing' } } })
    const state = (finish as { replayState?: { response?: Record<string, unknown> } }).replayState
    expect(state?.response).toMatchObject({ route: 'openrouter', model: 'deepseek/deepseek-v4-flash', inner: { kind: 'pi-ai' } })
  })

  it('rewrites its own assistant messages for the inner route', async () => {
    const h = await harness()
    const assistant: RequestMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'done' }],
      source: {
        provider: 'tiers',
        model: 'flash',
        replayState: {
          response: {
            kind: 'model-routing',
            version: 1,
            route: 'openrouter',
            model: 'deepseek/deepseek-v4-flash',
            inner: { kind: 'pi-ai', version: 2 },
          },
          blocks: [],
        },
      },
    } as unknown as RequestMessage
    await run(h.adapter, { messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }, assistant] })
    const inner = h.sent[0]?.options.messages[1] as { source: { provider: string; model: string } }
    expect(inner.source.provider).toBe('openrouter')
    expect(inner.source.model).toBe('deepseek/deepseek-v4-flash')
  })
})

describe('TiersAdapter when nothing works', () => {
  it('goes out unpinned when every endpoint list failed', async () => {
    const h = await harness({
      responses: [normalChunks()],
      endpoints: {
        'deepseek/deepseek-v4-flash': new Error('HTTP 503'),
        'z-ai/glm-5.3-flash': new Error('HTTP 503'),
        'stealth/space-bunny-alpha': new Error('HTTP 503'),
      },
    })
    await run(h.adapter)
    expect(h.sent[0]?.routing).toEqual({
      sort: 'price',
      quantizations: ['int8', 'fp8', 'mxfp8', 'fp16', 'bf16', 'fp32', 'unknown'],
      allow_fallbacks: true,
    })
    expect(h.events[0]?.endpoint).toBeUndefined()
    expect(h.events[0]?.unpinnedReason).toContain('HTTP 503')
  })

  it('fails loudly when the operator asked it to', async () => {
    const h = await harness({
      settings: { onEndpointsUnavailable: 'fail' },
      endpoints: {
        'deepseek/deepseek-v4-flash': new Error('HTTP 503'),
        'z-ai/glm-5.3-flash': new Error('HTTP 503'),
        'stealth/space-bunny-alpha': new Error('HTTP 503'),
      },
    })
    await expect(run(h.adapter)).rejects.toThrow(LlmError)
    await run(h.adapter).catch((error: unknown) => {
      expect((error as LlmError).code).toBe('MODEL_ROUTING_UNAVAILABLE')
    })
  })

  it('fails when no endpoint of the tier passes the filters', async () => {
    const h = await harness({ tiers: [{ ...PRO, minQuantization: 'fp32' }] })
    await run(h.adapter, { model: 'pro' }).then(
      () => { throw new Error('expected the tier to fail') },
      (error: unknown) => {
        expect((error as LlmError).code).toBe('MODEL_ROUTING_NO_ENDPOINT')
        expect((error as LlmError).message).toContain('quantization=')
      },
    )
  })

  it('refuses a model the route does not offer', async () => {
    const h = await harness()
    await run(h.adapter, { model: 'nope' }).then(
      () => { throw new Error('expected the model to be refused') },
      (error: unknown) => {
        expect((error as LlmError).code).toBe('UNKNOWN_MODEL')
        expect((error as LlmError).message).toContain('route "tiers" has no model "nope"')
      },
    )
  })
})

describe('TiersAdapter catalog', () => {
  it('lists auto, the tiers, then every favorite once', async () => {
    const h = await harness()
    const models = h.adapter.catalog('tiers')
    expect(models.map(model => model.id)).toEqual([
      'auto',
      'pro',
      'flash',
      'deepseek/deepseek-v4-pro',
      'z-ai/glm-5.3',
      'deepseek/deepseek-v4-flash',
      'z-ai/glm-5.3-flash',
      'stealth/space-bunny-alpha',
    ])
    expect(models[0]?.inputModalities).toEqual(['text'])
  })

  it('describes auto by the weakest tier and resolves a favorite by its first tier', async () => {
    const h = await harness()
    const auto = h.adapter.catalog('tiers').find(model => model.id === 'auto')
    expect(auto).toBeDefined()
    const resolved = await h.adapter.resolveModel('tiers', 'auto')
    expect(resolved.context?.contextWindow).toBe(1_000_000)
    expect(resolved.reasoning?.efforts.map(effort => String(effort.id))).toEqual(['low', 'medium', 'high'])
    const favorite = await h.adapter.resolveModel('tiers', 'deepseek/deepseek-v4-pro')
    expect(favorite.context?.contextWindow).toBe(1_000_000)
    await expect(h.adapter.resolveModel('tiers', 'nope')).rejects.toThrow(LlmError)
  })

  it('advertises nothing while no tier is configured', async () => {
    const h = await harness({ tiers: [] })
    expect(h.adapter.catalog('tiers')).toEqual([])
  })
})
