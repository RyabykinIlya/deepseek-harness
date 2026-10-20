import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createAssistantMessage, createUserMessage, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type {
  OpenRouterCatalogEntry,
  OpenRouterEndpoint,
  OpenRouterRoutingBlock,
  PiAiDispatch,
} from '@deepseek-ai/dsh-llm-pi-ai'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEventMap } from '@deepseek-ai/dsh-session'
import { TiersAdapter } from '../src/adapter.ts'
import { MODEL_ROUTING_SUBSCRIPTION_LIMIT_CODE } from '../src/adapter.ts'
import type { TiersAdapterDeps } from '../src/adapter.ts'
import { Config, readSettings, validateSettings } from '../src/config.ts'
import type { ExtraSource } from '../src/config.ts'
import type { RoutingSettings } from '../src/config.ts'
import { EndpointsCache } from '../src/endpoints-cache.ts'
import { FamilyCache } from '../src/family-cache.ts'
import { KeyInfo } from '../src/key-info.ts'
import type { UsageTotals } from '../src/select.ts'
import type { JudgeVerdict, ModelRoutingState, RoutingDiagnosticsRecord } from '../src/types.ts'
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
  /** The per-call pi-ai options the adapter passed, including the absent block on a direct route. */
  dispatch: { openRouterRouting?: OpenRouterRoutingBlock } | undefined
}

/** The routing block one dispatch carried, `undefined` when the adapter passed none. */
function blockOf(entry: Dispatched): OpenRouterRoutingBlock | undefined {
  return entry.dispatch?.openRouterRouting
}

/** Everything the adapter tests drive, plus the record of what it did. */
interface Harness {
  adapter: TiersAdapter
  sent: Dispatched[]
  events: SessionEventMap['model-routing/decision'][]
  /** Every diagnostics record the adapter produced, in order. */
  records: RoutingDiagnosticsRecord[]
  clock: { now: number }
  endpoints: Record<string, readonly OpenRouterEndpoint[] | Error>
  judge: { reply: Omit<JudgeVerdict, 'rule'> | undefined }
  freeRemaining: number
  origin: string | undefined
  warnings: string[]
  catalogEntries: readonly OpenRouterCatalogEntry[]
  catalogFails: boolean
  /** `route:model` pairs no pi-ai route can dispatch: a newer release, or an unconfigured route. */
  innerUnknown: Set<string>
}

/** Build an adapter over stub dependencies and recorded endpoint lists. */
async function harness(over: {
  tiers?: Record<string, unknown>[]
  settings?: Record<string, unknown>
  responses?: StreamChunk[][]
  endpoints?: Record<string, readonly OpenRouterEndpoint[] | Error>
  state?: ModelRoutingState
  catalog?: readonly OpenRouterCatalogEntry[]
  catalogFails?: boolean
  innerUnknown?: readonly string[]
  usage?: UsageTotals
} = {}): Promise<Harness> {
  const clock = 1000
  const tiers = over.tiers ?? [PRO, FLASH] as Record<string, unknown>[]
  const names = tiers.map(tier => (tier as { name: string }).name)
  const settings = (): RoutingSettings => readSettings(Config({
    tiers,
    minUptime: 95,
    trustedUnknownProviders: ['stealth'],
    judgeUserMessages: 3,
    // Cases in this suite describe what ONE failure does to the ranking and the
    // reroute budget, so they pin benching to the first failure. The shipped
    // default is five consecutive failures; the streak cases at the end of this
    // file cover that behavior on its own.
    excludeAfterFailures: 1,
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
  const records: RoutingDiagnosticsRecord[] = []
  // Built before the adapter so the dependency closures below can read the same
  // mutable record the case drives; `adapter` is added by the spread that
  // completes the harness once those closures exist.
  const base: Omit<Harness, 'adapter'> = {
    sent,
    events,
    records,
    clock: { now: clock },
    endpoints: {},
    judge: { reply: undefined },
    freeRemaining: 1000,
    origin: undefined,
    warnings: [],
    catalogEntries: over.catalog ?? [],
    catalogFails: over.catalogFails ?? false,
    innerUnknown: new Set(over.innerUnknown ?? []),
  }
  for (const model of Object.keys(endpoints)) base.endpoints[model] = endpoints[model]!

  const cache = new EndpointsCache(async (model) => {
    const list = record.endpoints[model]
    if (list === undefined) throw new Error(`no fixture for ${model}`)
    if (list instanceof Error) throw list
    return list
  }, () => clock)
  const scripted = [...(over.responses ?? [])]
  const dispatch: PiAiDispatch = {
    stream: (options, dispatchOptions) => {
      sent.push({ options, dispatch: dispatchOptions })
      const chunks = scripted.shift() ?? normalChunks()
      return {
        async *[Symbol.asyncIterator]() {
          for (const chunk of chunks) yield chunk
          const thrown = (chunks as StreamChunk[] & { [THROW_AFTER]?: Error })[THROW_AFTER]
          if (thrown !== undefined) throw thrown
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
  } as Session
  const deps: TiersAdapterDeps = {
    settings,
    dispatch: () => dispatch,
    session: () => session,
    routingState: () => over.state,
    usage: () => over.usage,
    innerEfforts: async () => ['off', 'high', 'xhigh'],
    innerCanDispatch: async (model, route) => !record.innerUnknown.has(`${route}:${model}`) && route !== 'no-such-route',
    endpoints: cache,
    catalog: new FamilyCache(async () => {
      if (record.catalogFails) throw new Error('OpenRouter answered 503')
      return record.catalogEntries
    }, () => clock),
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
    // The adapter reads its clock through the harness so a case can advance it:
    // benching and prompt-cache idleness are both measured against this value.
    now: () => record.clock.now,
    diagnostics: (entry) => { records.push(entry) },
    warn: (message) => {
      record.warnings.push(message)
      record.judge.reply ??= { model: 'typesafe/jev-1.13', latencyMs: 0, error: message }
    },
  }
  const record: Harness = {
    ...base,
    adapter: new TiersAdapter(deps, {
      routeName: 'tiers',
      routeLabel: 'Tiers',
      innerRoute: 'openrouter',
      decisionsUrl: 'https://openrouter.ai/api/alpha/decisions',
    }),
  }
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

/** Carries the error a scripted attempt's iterator throws once its chunks are exhausted. */
const THROW_AFTER = Symbol('throw-after-last-chunk')

/**
 * Chunks for an attempt whose iterator throws instead of yielding a finish
 * chunk once it has yielded `chunks` — the pi-ai idle watchdog's own failure
 * path, which surfaces as a rejection of `iterator.next()`, not a chunk.
 */
function chunksThenThrow(chunks: StreamChunk[], error: Error): StreamChunk[] {
  return Object.assign([...chunks], { [THROW_AFTER]: error })
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
    openRouterFallback: null,
    ...over,
  }
}

/** Drain one request and collect the chunks that reached the caller. */
async function run(
  adapter: TiersAdapter,
  over: Partial<Omit<GenerateOptions, 'sessionId'>> & { sessionId?: SessionId | undefined } = {},
): Promise<StreamChunk[]> {
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
    expect(blockOf(h.sent[0]!)).toEqual({ only: ['streamlake/fp8'], allow_fallbacks: false })
    expect(h.events).toHaveLength(1)
    expect(h.events[0]).toMatchObject({
      boundary: 'start',
      requested: 'flash',
      tier: 'flash',
      model: 'deepseek/deepseek-v4-flash',
    })
    expect(h.events[0]?.endpoint?.tag).toBe('streamlake/fp8')
  })

  it('records the mix, the filters, and the candidate table behind the price', async () => {
    const h = await harness()
    await run(h.adapter, { model: 'pro' })
    const event = h.events[0]!
    const record = h.records[0]!
    expect(record.at).toBe(1000)
    expect(record.sessionId).toBe('s1')
    // The event and the file describe one decision: the same verdict in
    // miniature, and the whole table the price was compared over.
    expect(event.mix).toEqual({ cached: 0.9, fresh: 0.08, output: 0.02, source: 'default' })
    expect(event.filters).toEqual({
      contextWindow: 1_000_000,
      minQuantization: 'fp8',
      unknownQuantization: 'reject',
      free: 'off',
      allowFree: true,
      minUptime: 95,
      requireNormalStatus: true,
      trustedUnknownProviders: ['stealth'],
    })
    expect(record.filters).toEqual(event.filters)
    expect(record.candidates).toHaveLength(record.considered)
    const admitted = record.candidates.filter(entry => entry.rejection === undefined)
    const dropped = record.candidates.filter(entry => entry.rejection !== undefined)
    expect(admitted.map(entry => entry.rank)).toEqual(admitted.map((_, index) => index + 1))
    expect(admitted[0]?.tag).toBe(record.endpoint?.tag)
    for (const entry of dropped) expect(entry.rank).toBeUndefined()
    // The per-reason counts are the same toll the table shows, and the event
    // names the cheapest endpoint each reason dropped.
    const counts: Readonly<Record<string, number>> = event.rejections ?? {}
    for (const [reason, count] of Object.entries(counts)) {
      expect(dropped.filter(entry => entry.rejection === reason).length).toBe(count)
    }
    const named = event.cheapestRejected ?? []
    for (const entry of named) expect(entry.rejection).toBeDefined()
    expect(named.map(entry => entry.rejection).sort())
      .toEqual(Object.entries(counts).filter(([, count]) => count > 0).map(([reason]) => reason).sort())
    // A provider discount is a fact the record keeps, even when it is zero.
    expect(record.candidates.some(entry => entry.discount !== undefined)).toBe(true)
    expect(record.unreadable).toEqual([])
  })

  it('records a measured mix once the session has established a shape', async () => {
    const h = await harness({
      usage: { cacheReadTokens: 8_000, uncachedInputTokens: 1_000, cacheWriteTokens: 0, outputTokens: 1_000 },
    })
    await run(h.adapter)
    expect(h.events[0]?.mix).toEqual({ cached: 0.8, fresh: 0.1, output: 0.1, source: 'usage' })
    expect(h.records[0]?.mix).toEqual(h.events[0]?.mix)
  })

  it('records a session-less decision too, naming no Session', async () => {
    const h = await harness()
    await run(h.adapter, { sessionId: undefined })
    // No Session asked to keep the event, so only the file has the decision.
    expect(h.events).toHaveLength(0)
    expect(h.records).toHaveLength(1)
    expect(h.records[0]?.sessionId).toBeUndefined()
    expect(h.records[0]?.candidates.length).toBe(h.records[0]?.considered)
  })

  it('leaves out a runner-up fact the endpoint did not publish', async () => {
    /** An endpoint that states neither a quantization nor a discount. */
    const plain = (slug: string, promptPrice: number): OpenRouterEndpoint => ({
      slug,
      promptPrice,
      completionPrice: promptPrice * 3,
      inputCacheReadPrice: promptPrice / 2,
      status: 0,
      uptimeLast30m: 99,
      supportedParameters: ['tools'],
      contextLength: 1_048_576,
    })
    const h = await harness({
      tiers: [{
        name: 'flash', label: 'Flash', models: ['author/m'], contextWindow: 1_000_000, maxTokens: 100,
        input: ['text'], minQuantization: 'fp4', unknownQuantization: 'accept', free: 'off',
      }],
      endpoints: { 'author/m': [plain('one', 1e-7), plain('two', 2e-7)] },
    })
    await run(h.adapter)
    expect(h.events[0]?.runnersUp[0]).toEqual({
      model: 'author/m', tag: 'two', blendedUsdPerToken: expect.any(Number) as number,
    })
  })

  it('keeps the pin for the next request in the same session', async () => {
    const h = await harness()
    await run(h.adapter)
    await run(h.adapter)
    expect(h.sent).toHaveLength(2)
    expect(h.events).toHaveLength(1)
    expect(blockOf(h.sent[1]!)).toEqual(blockOf(h.sent[0]!))
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
        openRouterFallback: null,
      },
    })
    await run(h.adapter)
    expect(blockOf(h.sent[0]!)).toEqual({ only: ['streamlake/fp8'], allow_fallbacks: false })
    expect(h.events).toHaveLength(0)
  })

  it('decides again instead of clinching every request when a live settings edit renamed or removed the pinned tier', async () => {
    // The log recorded a decision for tier `pro`, but a volatile settings write
    // landed since (a rename or deletion) and the current config no longer has
    // it. Nothing in the live settings can validate or dispatch against `pro`
    // anymore, so the stale pin must be discarded, not clinch this and every
    // later request behind `INVALID_CONFIG` until an unrelated boundary happens
    // to re-decide.
    const h = await harness({
      tiers: [FLASH],
      settings: { judgeEnabled: false },
      state: {
        decision: {
          boundary: 'start', requested: 'auto', tier: 'pro', model: 'deepseek/deepseek-v4-pro',
          endpoint: { tag: 'streamlake/fp8', promptUsd: 1e-8, completionUsd: 2e-8 },
          considered: 1, runnersUp: [], excludedTags: [],
        },
        decidedAt: 1, lastResponseAt: 999, compactedSinceDecision: false,
        explicitSelection: false, overrides: {},
        openRouterFallback: null,
      },
    })
    const chunks = await run(h.adapter, { model: 'auto' })
    expect(chunks.some(chunk => chunk.type === 'finish' && chunk.reason.kind === 'error')).toBe(false)
    expect(h.events).toHaveLength(1)
    expect(h.events[0]).toMatchObject({ boundary: 'start', tier: 'flash' })
  })

  it('discards a restored unpinned-block decision for a tier that is gone, instead of throwing out of restorePin', async () => {
    // Same scenario as above, but for a decision recorded without a pinned
    // endpoint (the tier-wide `unpinnedBlock` path) — `restorePin` itself used
    // to look the tier up unconditionally and throw before `run()` ever got a
    // chance to notice the pin was stale.
    const h = await harness({
      tiers: [FLASH],
      settings: { judgeEnabled: false },
      state: {
        decision: {
          boundary: 'start', requested: 'auto', tier: 'pro', model: 'deepseek/deepseek-v4-pro',
          considered: 1, runnersUp: [], excludedTags: [],
        },
        decidedAt: 1, lastResponseAt: 999, compactedSinceDecision: false,
        explicitSelection: false, overrides: {},
        openRouterFallback: null,
      },
    })
    const chunks = await run(h.adapter, { model: 'auto' })
    expect(chunks.some(chunk => chunk.type === 'finish' && chunk.reason.kind === 'error')).toBe(false)
    expect(h.events).toHaveLength(1)
    expect(h.events[0]).toMatchObject({ boundary: 'start', tier: 'flash' })
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
    expect(blockOf(h.sent[1]!)).toEqual({ only: ['deepinfra/fp8'], allow_fallbacks: false })
    expect(h.events).toHaveLength(2)
    expect(h.events[1]).toMatchObject({ boundary: 'failure', excludedTags: ['streamlake/fp8'] })
    // Only the successful attempt's chunks reached the caller.
    expect(chunks.some(chunk => chunk.type === 'finish' && chunk.reason.kind === 'error')).toBe(false)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('reroutes a provider that rejects the request before any content, keeping the turn alive', async () => {
    // The observed Morph case: an upstream provider answers 400 to a body that
    // another provider of the same model serves. The code carries no evidence
    // that the request is bad everywhere, and nothing has streamed yet, so the
    // attempt is replayable and the turn must not die on it.
    const h = await harness({ responses: [failureChunks('INVALID_REQUEST'), normalChunks()] })
    const chunks = await run(h.adapter)
    expect(h.sent).toHaveLength(2)
    expect(h.sent.map(entry => entry.options.model)).toEqual([
      'deepseek/deepseek-v4-flash',
      'deepseek/deepseek-v4-flash',
    ])
    expect(h.events[1]).toMatchObject({ boundary: 'failure', excludedTags: ['streamlake/fp8'] })
    expect(chunks.some(chunk => chunk.type === 'finish' && chunk.reason.kind === 'error')).toBe(false)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('records the dispatch failure a failure re-decision answers', async () => {
    // A `failure` decision that names only the new pin cannot tell a provider
    // outage from a filter that rejects: the next reading needs the failed tag
    // and the provider code that caused the reroute.
    const h = await harness({ responses: [failureChunks('INVALID_REQUEST'), normalChunks()] })
    await run(h.adapter)
    expect(h.events).toHaveLength(2)
    expect(h.events[0]).not.toHaveProperty('failureCode')
    expect(h.events[0]).not.toHaveProperty('failedTag')
    expect(h.events[1]).toMatchObject({
      boundary: 'failure',
      failedTag: 'streamlake/fp8',
      failureCode: 'INVALID_REQUEST',
    })
    // The diagnostics file carries the same failure tag and code as the Session event.
    expect(h.records[1]).toMatchObject({ failedTag: 'streamlake/fp8', failureCode: 'INVALID_REQUEST' })
  })

  it('surfaces a context-window overflow instead of spending the reroute budget on it', async () => {
    // Every candidate of the tier serves the same model window, so another
    // provider cannot serve this request: the remedy is compaction, and the
    // failure has to reach the loop that performs it.
    const h = await harness({ responses: [failureChunks('CONTEXT_WINDOW_EXCEEDED'), normalChunks()] })
    const chunks = await run(h.adapter)
    expect(h.sent).toHaveLength(1)
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'CONTEXT_WINDOW_EXCEEDED' } },
    })

    // Excluding the endpoint still happens, so the next turn's failure
    // boundary cannot pin straight back onto it.
    await run(h.adapter)
    expect(h.sent).toHaveLength(2)
    expect(h.events[1]).toMatchObject({ boundary: 'failure', excludedTags: ['streamlake/fp8'] })
  })

  it('reroutes a context-window overflow when the deployment empties noRerouteCodes', async () => {
    // The list is the whole policy: emptying it must change behavior, not just
    // document it.
    const h = await harness({
      responses: [failureChunks('CONTEXT_WINDOW_EXCEEDED'), normalChunks()],
      settings: { noRerouteCodes: [] },
    })
    const chunks = await run(h.adapter)
    expect(h.sent).toHaveLength(2)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('reroutes within the same turn when a provider reports its failure in-band, after a leading usage chunk', async () => {
    // pi-ai's own in-band failure reporting always yields a `usage` chunk
    // before the error `finish` (stream.ts's 'error' case). Reading only the
    // very first `.next()` result would see that `usage` chunk, never the
    // failure, and treat the attempt as "content already reached the caller"
    // — excluding the endpoint without rerouting, so every pi-ai in-band
    // failure surfaced as an error to the caller instead of recovering
    // within the turn. Looking past the leading usage chunk fixes that.
    const h = await harness({
      responses: [
        [{ type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }, ...failureChunks('PI_AI_ERROR')],
        normalChunks(),
      ],
    })
    const chunks = await run(h.adapter)
    expect(h.sent).toHaveLength(2)
    expect(blockOf(h.sent[1]!)).not.toEqual({ only: ['streamlake/fp8'], allow_fallbacks: false })
    expect(h.events).toHaveLength(2)
    expect(h.events[1]).toMatchObject({ boundary: 'failure', excludedTags: ['streamlake/fp8'] })
    // The failed attempt's chunks never reached the caller; only the
    // successful attempt's did.
    expect(chunks.some(chunk => chunk.type === 'finish' && chunk.reason.kind === 'error')).toBe(false)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('excludes an endpoint that fails on its very first chunk with no leading usage, exactly as one buffered behind usage', async () => {
    // Confirms the leading-usage buffering in the fix above does not change
    // behavior for a provider that reports the failure immediately, with no
    // usage chunk at all.
    const h = await harness({ responses: [failureChunks('PI_AI_ERROR'), normalChunks()] })
    const chunks = await run(h.adapter)
    expect(h.sent).toHaveLength(2)
    expect(h.events[1]).toMatchObject({ boundary: 'failure', excludedTags: ['streamlake/fp8'] })
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('excludes, but does not reroute, an endpoint that fails after real content has already reached the caller', async () => {
    // Once genuine content (not just a leading `usage` chunk) has streamed,
    // the attempt cannot be replayed on another endpoint — rerouting would
    // duplicate or corrupt what the caller already received. The endpoint
    // must still be excluded, so the next turn's failure boundary does not
    // pin straight back onto it.
    const h = await harness({
      responses: [
        [
          { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } },
          { type: 'block-start', index: 0, blockType: 'text' },
          { type: 'text-delta', index: 0, text: 'partial' },
          ...failureChunks('PI_AI_ERROR'),
        ],
        normalChunks(),
      ],
    })
    const chunks = await run(h.adapter)
    expect(h.sent).toHaveLength(1)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error' } })

    await run(h.adapter)
    expect(h.sent).toHaveLength(2)
    expect(blockOf(h.sent[1]!)).not.toEqual({ only: ['streamlake/fp8'], allow_fallbacks: false })
    expect(h.events[1]).toMatchObject({ boundary: 'failure', excludedTags: ['streamlake/fp8'] })
  })

  it('excludes but does not reroute an endpoint whose iterator throws after real content has streamed', async () => {
    // The pi-ai idle watchdog rejects `iterator.next()` directly rather than
    // yielding a finish chunk with a failure code — the same "content already
    // reached the caller, cannot replay, must exclude" situation, reaching
    // the adapter through the other path.
    const h = await harness({
      responses: [
        chunksThenThrow(
          [
            { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } },
            { type: 'block-start', index: 0, blockType: 'text' },
            { type: 'text-delta', index: 0, text: 'partial' },
          ],
          new LlmError('pi-ai idle watchdog fired', 'TIMEOUT'),
        ),
        normalChunks(),
      ],
    })
    await expect(run(h.adapter)).rejects.toMatchObject({ code: 'TIMEOUT' })
    expect(h.sent).toHaveLength(1)

    await run(h.adapter)
    expect(h.sent).toHaveLength(2)
    expect(blockOf(h.sent[1]!)).not.toEqual({ only: ['streamlake/fp8'], allow_fallbacks: false })
    expect(h.events[1]).toMatchObject({ boundary: 'failure', excludedTags: ['streamlake/fp8'] })
  })

  it('reroutes within the same turn when the iterator throws while only a leading usage chunk has been buffered', async () => {
    // A throw while still reading leading `usage` chunks is the same "nothing
    // has reached the caller yet" situation as an in-band failure chunk
    // arriving there — it must reroute, not merely exclude and fail the turn.
    const h = await harness({
      responses: [
        chunksThenThrow(
          [{ type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }],
          new LlmError('pi-ai idle watchdog fired', 'TIMEOUT'),
        ),
        normalChunks(),
      ],
    })
    const chunks = await run(h.adapter)
    expect(h.sent).toHaveLength(2)
    expect(blockOf(h.sent[1]!)).not.toEqual({ only: ['streamlake/fp8'], allow_fallbacks: false })
    expect(h.events[1]).toMatchObject({ boundary: 'failure', excludedTags: ['streamlake/fp8'] })
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

describe('TiersAdapter auxiliary purpose requests', () => {
  it('keeps an auxiliary purpose failure from benching the session turn', async () => {
    // Titles and compactions ride the Session's pin without owning it: their
    // dispatch failures bench only their own scope, so the next real turn
    // still meets the endpoint that failed someone else's call.
    const h = await harness({ responses: [failureChunks('PROVIDER_ERROR'), normalChunks(), normalChunks()] })
    await run(h.adapter, { purpose: 'session-title' })
    expect(h.events).toHaveLength(0)
    await run(h.adapter)
    expect(h.events[0]).toMatchObject({ boundary: 'start', excludedTags: [] })
    expect(h.events[0]?.endpoint?.tag).toBe('streamlake/fp8')
  })

  it('does not let an auxiliary failure push the next session turn onto a failure boundary', async () => {
    // The pending-failure flag is scoped the same way: a title that fails must
    // not force the Session's own next turn to re-decide.
    const h = await harness({
      responses: [normalChunks(), failureChunks('PROVIDER_ERROR'), normalChunks(), normalChunks()],
    })
    await run(h.adapter)
    expect(h.events).toHaveLength(1)
    await run(h.adapter, { purpose: 'session-title' })
    expect(h.events).toHaveLength(1)
    await run(h.adapter)
    expect(h.events).toHaveLength(1)
    expect(h.sent).toHaveLength(4)
  })

  it('forgets auxiliary scopes when the session is disposed', async () => {
    const h = await harness({
      responses: [failureChunks('PROVIDER_ERROR'), normalChunks(), failureChunks('PROVIDER_ERROR'), normalChunks()],
    })
    await run(h.adapter, { purpose: 'session-title' })
    expect(h.records[1]).toMatchObject({ boundary: 'failure', excludedTags: ['streamlake/fp8'] })
    await run(h.adapter, { sessionId: SessionId('s2'), purpose: 'session-title' })
    expect(h.records[3]).toMatchObject({ boundary: 'failure', excludedTags: ['streamlake/fp8'] })
    h.adapter.forget(SessionId('s1'))
    // The s1 scope is gone while the s2 scope survives the disposal.
    await run(h.adapter, { purpose: 'session-title' })
    expect(h.records.at(-1)).toMatchObject({ boundary: 'start', excludedTags: [] })
    await run(h.adapter, { sessionId: SessionId('s2'), purpose: 'session-title' })
    expect(h.records.at(-1)).toMatchObject({ excludedTags: ['streamlake/fp8'] })
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
    expect(blockOf(h.sent[0]!)).toEqual({ only: ['stealth'], allow_fallbacks: false })
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
    const assistant = createAssistantMessage({
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
    })
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
    expect(blockOf(h.sent[0]!)).toEqual({
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

  it('names the requested model when a fixed request has no usable endpoint', async () => {
    // A fixed request ranks one model only, so bare tier counts read as a tier
    // with no endpoints. Naming the model says which favorite failed.
    const h = await harness({ tiers: [{ ...PRO, minQuantization: 'fp32' }] })
    await run(h.adapter, { model: 'deepseek/deepseek-v4-pro' }).then(
      () => { throw new Error('expected the model to fail') },
      (error: unknown) => {
        expect((error as LlmError).code).toBe('MODEL_ROUTING_NO_ENDPOINT')
        expect((error as LlmError).message).toContain('for model "deepseek/deepseek-v4-pro"')
        expect((error as LlmError).message).not.toContain('benched')
      },
    )
  })

  it('says the requested model is benched when its only endpoint is excluded', async () => {
    // One dispatch failure benches the model's sole endpoint (the harness pins
    // benching to the first failure), and the reroute serves the tier instead.
    // A later fixed request for the model then meets the bench, not an empty
    // tier, and the message must say so.
    const h = await harness({
      tiers: [{ ...FLASH, free: 'prefer' }],
      responses: [failureChunks('PROVIDER_ERROR'), normalChunks()],
      state: { ...priorDecision(), decision: null, compactedSinceDecision: true },
    })
    await run(h.adapter, { model: 'stealth/space-bunny-alpha' })
    await run(h.adapter, { model: 'stealth/space-bunny-alpha' }).then(
      () => { throw new Error('expected the benched model to fail') },
      (error: unknown) => {
        expect((error as LlmError).code).toBe('MODEL_ROUTING_NO_ENDPOINT')
        expect((error as LlmError).message).toContain('for model "stealth/space-bunny-alpha": excluded=1')
        expect((error as LlmError).message).toContain('benched after recent failures')
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

describe('TiersAdapter snapshot policy', () => {
  /** The DeepSeek Pro family as OpenRouter's catalog states it on 2026-10-04. */
  const FAMILY: readonly OpenRouterCatalogEntry[] = [
    { id: 'deepseek/deepseek-v4-pro', canonicalSlug: 'deepseek/deepseek-v4-pro-20260423' },
    { id: 'deepseek/deepseek-v4-pro-0813', canonicalSlug: 'deepseek/deepseek-v4-pro-20260813' },
    { id: 'deepseek/deepseek-v4-flash', canonicalSlug: 'deepseek/deepseek-v4-flash-20260423' },
  ]

  /** A Pro tier whose newest release is priced by the recorded April listing. */
  async function proTier(options: {
    policy: string
    catalog?: readonly OpenRouterCatalogEntry[]
    catalogFails?: boolean
    decideEveryTime?: boolean
    innerUnknown?: readonly string[]
  }): Promise<Harness> {
    const pro = await endpointsOf('deepseek/deepseek-v4-pro')
    return harness({
      tiers: [{ ...PRO, models: ['deepseek/deepseek-v4-pro'] }],
      endpoints: { 'deepseek/deepseek-v4-pro': pro, 'deepseek/deepseek-v4-pro-0813': pro },
      catalog: options.catalog ?? FAMILY,
      catalogFails: options.catalogFails ?? false,
      innerUnknown: (options.innerUnknown ?? []).map(model => `openrouter:${model}`),
      settings: { snapshotPolicy: options.policy },
      // A Session compacted since its last decision decides again at every
      // boundary, which is what makes a second run a second decision rather than
      // a reuse of the pin the first one left.
      ...options.decideEveryTime ? { state: compacted('deepseek/deepseek-v4-pro') } : {},
    })
  }

  /** A Pro session that has to decide again at the next boundary. */
  function compacted(model: string): ModelRoutingState {
    return {
      decision: {
        boundary: 'start', requested: 'pro', tier: 'pro', model,
        considered: 1, runnersUp: [], excludedTags: [],
      },
      decidedAt: 1,
      lastResponseAt: 1000,
      compactedSinceDecision: true,
      explicitSelection: false,
      overrides: {},
      openRouterFallback: null,
    }
  }

  it('decides under the newest snapshot of the family a tier names', async () => {
    const h = await proTier({ policy: 'latest' })
    await run(h.adapter, { model: 'pro' })
    expect(h.sent[0]?.options.model).toBe('deepseek/deepseek-v4-pro-0813')
    expect(h.events[0]).toMatchObject({
      tier: 'pro',
      model: 'deepseek/deepseek-v4-pro-0813',
    })
    expect(h.warnings).toEqual([
      'model-routing: "deepseek/deepseek-v4-pro" now resolves to "deepseek/deepseek-v4-pro-0813",'
      + ' the newest snapshot of its family',
    ])
  })

  it('says once that a tier moved, however many boundaries decide afterwards', async () => {
    const h = await proTier({ policy: 'latest', decideEveryTime: true })
    await run(h.adapter, { model: 'pro' })
    await run(h.adapter, { model: 'pro' })
    expect(h.events).toHaveLength(2)
    expect(h.warnings).toHaveLength(1)
  })

  it('moves a request that named one of the tier models itself', async () => {
    const h = await proTier({ policy: 'latest' })
    await run(h.adapter, { model: 'deepseek/deepseek-v4-pro' })
    expect(h.sent[0]?.options.model).toBe('deepseek/deepseek-v4-pro-0813')
    expect(h.events[0]?.tier).toBe('pro')
  })

  it('leaves every id exactly as configured when the policy is pinned', async () => {
    const h = await proTier({ policy: 'pinned' })
    await run(h.adapter, { model: 'pro' })
    expect(h.sent[0]?.options.model).toBe('deepseek/deepseek-v4-pro')
    expect(h.warnings).toEqual([])
  })

  it('decides under the configured ids when the catalog cannot be read', async () => {
    const h = await proTier({ policy: 'latest', catalogFails: true, decideEveryTime: true })
    await run(h.adapter, { model: 'pro' })
    await run(h.adapter, { model: 'pro' })
    expect(h.sent[0]?.options.model).toBe('deepseek/deepseek-v4-pro')
    expect(h.warnings).toEqual([
      'model-routing: the OpenRouter model catalog could not be read, so tiers are deciding under'
      + ' their configured model ids',
    ])
  })

  it('leaves a tier where it was when the catalog places none of its models', async () => {
    const h = await proTier({ policy: 'latest', catalog: [] })
    await run(h.adapter, { model: 'pro' })
    expect(h.sent[0]?.options.model).toBe('deepseek/deepseek-v4-pro')
    expect(h.warnings).toEqual([])
  })

  it('keeps the configured id when `latest` resolves to a release the inner route cannot dispatch', async () => {
    // OpenRouter's catalog runs ahead of the pinned pi-ai dependency: the
    // 0813 release exists upstream, but the inner route has never learned it.
    // Dispatching it anyway fails `UNKNOWN_MODEL` on every turn — an error no
    // reroute covers, because every endpoint of the id is equally unknown. The
    // decision must fall back to the configured id, which the route knows.
    const h = await proTier({ policy: 'latest', innerUnknown: ['deepseek/deepseek-v4-pro-0813'] })
    const chunks = await run(h.adapter, { model: 'pro' })
    expect(h.sent[0]?.options.model).toBe('deepseek/deepseek-v4-pro')
    expect(h.events[0]).toMatchObject({ tier: 'pro', model: 'deepseek/deepseek-v4-pro' })
    expect(chunks.some(chunk => chunk.type === 'finish' && chunk.reason.kind === 'error')).toBe(false)
    expect(h.warnings).toEqual([
      'model-routing: "deepseek/deepseek-v4-pro" resolves to "deepseek/deepseek-v4-pro-0813",'
      + ' which the inner route "openrouter" cannot dispatch, so the tier keeps'
      + ' "deepseek/deepseek-v4-pro" — @deepseek-ai/dsh-llm-pi-ai has not learned that release yet',
    ])
  })

  it('says once that a resolved release is undispatchable, however many boundaries decide afterwards', async () => {
    const h = await proTier({
      policy: 'latest',
      innerUnknown: ['deepseek/deepseek-v4-pro-0813'],
      decideEveryTime: true,
    })
    await run(h.adapter, { model: 'pro' })
    await run(h.adapter, { model: 'pro' })
    expect(h.events).toHaveLength(2)
    expect(h.warnings).toHaveLength(1)
  })

  it('still moves to the newest release when the inner route can dispatch it', async () => {
    const h = await proTier({ policy: 'latest' })
    await run(h.adapter, { model: 'pro' })
    expect(h.sent[0]?.options.model).toBe('deepseek/deepseek-v4-pro-0813')
    expect(h.warnings).toEqual([
      'model-routing: "deepseek/deepseek-v4-pro" now resolves to "deepseek/deepseek-v4-pro-0813",'
      + ' the newest snapshot of its family',
    ])
  })

  it('ranks only the model a request named, never the rest of its tier', async () => {
    // Asking for one model of a tier means that model. Resolving the whole tier
    // here would hand the ranking every other family of the tier too, so a
    // request for the Pro model could quietly be decided onto (and priced
    // against) the cheaper sibling in the same tier.
    const h = await harness({
      tiers: [{ ...PRO, models: ['deepseek/deepseek-v4-pro', 'z-ai/glm-5.3'] }],
      settings: { snapshotPolicy: 'latest' },
      catalog: FAMILY,
      // The sibling is priced well below Pro, so it would win any ranking that
      // considered it.
      endpoints: { 'z-ai/glm-5.3': await endpointsOf('z-ai/glm-5.3') },
    })
    h.judge.reply = { model: 'typesafe/jev-1.13', pPro: 0, confidence: 1, precision: 0.07, latencyMs: 1 }
    await run(h.adapter, { model: 'deepseek/deepseek-v4-pro' })
    expect(h.sent[0]?.options.model).toBe('deepseek/deepseek-v4-pro-0813')
    expect(h.events[0]).toMatchObject({ tier: 'pro', model: 'deepseek/deepseek-v4-pro-0813' })
  })
})

/** One user message whose content carries an image the Session must send onward. */
function imageRequest(): Partial<GenerateOptions> {
  return {
    messages: [createUserMessage({
      content: [{
        type: 'image',
        attachment: {
          attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
          mediaType: 'image/png',
          bytes: 3,
          width: 1,
          height: 1,
        },
      }],
      source: { kind: 'user' },
    })],
  }
}

describe('TiersAdapter input modalities', () => {
  // Only one Flash model is shown to accept image input; the catalog names no
  // modalities for the other two, which is the same as showing none.
  const IMAGE_CATALOG: readonly OpenRouterCatalogEntry[] = [
    { id: 'deepseek/deepseek-v4-flash', canonicalSlug: 'deepseek/deepseek-v4-flash-20260423', inputModalities: ['text'] },
    { id: 'z-ai/glm-5.3-flash', canonicalSlug: 'z-ai/glm-5.3-flash-20260423', inputModalities: ['text', 'image'] },
  ]

  it('serves an image request only from a model the catalog shows accepting image', async () => {
    const h = await harness({ catalog: IMAGE_CATALOG })
    await run(h.adapter, imageRequest())
    expect(h.sent[0]?.options.model).toBe('z-ai/glm-5.3-flash')
    expect(h.events[0]).toMatchObject({ tier: 'flash', model: 'z-ai/glm-5.3-flash' })
  })

  it('leaves a text request on the same endpoint it would have used', async () => {
    const h = await harness({ catalog: IMAGE_CATALOG })
    await run(h.adapter)
    expect(h.sent[0]?.options.model).toBe('deepseek/deepseek-v4-flash')
    expect(h.warnings).toEqual([])
  })

  it('decides the Session again inside its own tier once an image arrives', async () => {
    // An image stays in the Session's history, so the model pinned before it
    // cannot serve the Session afterwards either. The tier is the deployment's
    // cost and quality contract and must not change; only the model inside it.
    const h = await harness({ catalog: IMAGE_CATALOG })
    await run(h.adapter)
    await run(h.adapter, imageRequest())
    expect(h.sent[1]?.options.model).toBe('z-ai/glm-5.3-flash')
    expect(h.events[1]).toMatchObject({ boundary: 'start', tier: 'flash', model: 'z-ai/glm-5.3-flash' })
    expect(h.warnings).toContain(
      'model-routing: "deepseek/deepseek-v4-flash" is not shown to accept image input, so this Session'
      + ' decides its flash tier again on a model that does',
    )
  })

  it('keeps a pin the catalog shows able to serve the request', async () => {
    const h = await harness({ catalog: IMAGE_CATALOG })
    await run(h.adapter, imageRequest())
    await run(h.adapter, imageRequest())
    expect(h.sent[1]?.options.model).toBe('z-ai/glm-5.3-flash')
    expect(h.events).toHaveLength(1)
  })

  it('refuses an image request rather than serve it from a model nothing vouches for', async () => {
    const h = await harness({ catalogFails: true })
    const failure = await run(h.adapter, imageRequest()).then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(LlmError)
    expect((failure as LlmError).message).toContain('modality=')
    expect((failure as LlmError).message).not.toContain('unpriced=')
    expect(h.sent).toEqual([])
    expect(h.warnings).toContain(
      'model-routing: the OpenRouter model catalog could not be read, so no model is shown to accept'
      + ' image input and an image request has no endpoint to serve it',
    )
  })
})

describe('TiersAdapter direct sources', () => {
  /** The tier the target scenario decides under: one canonical model, three sources. */
  const MIMO = {
    name: 'flash',
    label: 'Flash',
    models: ['xiaomi/mimo-v2.6-pro'],
    contextWindow: 1_000_000,
    maxTokens: 32_768,
    input: ['text'],
    minQuantization: 'fp8',
    unknownQuantization: 'accept',
    free: 'off',
  }

  /** `claude-proxy`: the first source, and the dearest one — the pin the fallback moves away from. */
  const CLAUDE: ExtraSource = {
    route: 'claude-proxy',
    models: [],
    modelMap: { 'xiaomi/mimo-v2.6-pro': 'mimo-v2.6-pro@{"usdPerToken":1e-6}' },
    price: {},
    tools: true,
  }

  /** `xiaomi-plan`: the credit-weighted subscription source, priced per bucket. */
  const PLAN: ExtraSource = {
    route: 'xiaomi-plan',
    models: [],
    modelMap: { 'xiaomi/mimo-v2.6-pro': 'mimo-v2.6-pro@{"promptUsdPerToken":4.363636e-7,"completionUsdPerToken":8.727273e-7,"cacheReadUsdPerToken":3.636364e-9}' },
    price: {},
    tools: true,
  }

  /** One endpoint fixture stand-in; the recorded lists are not what this seam ranks. */
  function endpointOf(slug: string, promptPrice: number): OpenRouterEndpoint {
    return {
      slug,
      promptPrice,
      completionPrice: promptPrice * 3,
      inputCacheReadPrice: promptPrice / 2,
      status: 0,
      uptimeLast30m: 99,
      supportedParameters: ['tools'],
      contextLength: 1_048_576,
    }
  }

  /** The scenario: the tier's two direct sources plus one OpenRouter endpoint of the same model. */
  async function scenario(over: {
    responses?: StreamChunk[][]
    sources?: ExtraSource[]
    settings?: Record<string, unknown>
    state?: ModelRoutingState
    catalogFails?: boolean
  } = {}): Promise<Harness> {
    return harness({
      tiers: [{ ...MIMO, extraSources: over.sources ?? [CLAUDE, PLAN] }],
      endpoints: { 'xiaomi/mimo-v2.6-pro': [endpointOf('streamlake/fp8', 1.2e-7)] },
      settings: {
        judgeEnabled: false,
        defaultTier: 'flash', judgeProTier: 'flash', judgeFlashTier: 'flash',
        // These stories describe rerouting among all sources, which is the
        // opted-in deployment; the default-refused behavior has its own test.
        fallbackToOpenRouter: true,
        ...over.settings,
      },
      ...over.responses === undefined ? {} : { responses: over.responses },
      ...over.state === undefined ? {} : { state: over.state },
      ...over.catalogFails === undefined ? {} : { catalogFails: over.catalogFails },
    })
  }

  it('prices all three sources of one model and dispatches the cheapest on its own route', async () => {
    const h = await scenario()
    await run(h.adapter)
    expect(h.sent[0]?.options.provider).toBe('xiaomi-plan')
    expect(h.sent[0]?.options.model).toBe('mimo-v2.6-pro')
    // pi-ai refuses an OpenRouter routing block on a model that does not speak
    // `openai-completions`, so a direct dispatch carries no block at all.
    expect(blockOf(h.sent[0]!)).toBeUndefined()
    expect(h.events[0]).toMatchObject({
      tier: 'flash',
      model: 'xiaomi/mimo-v2.6-pro',
      source: { kind: 'xiaomi-plan', tag: 'mimo-v2.6-pro' },
      blendedUsdPerToken: 5.56363616e-08,
    })
    expect(h.events[0]?.endpoint).toMatchObject({ tag: 'mimo-v2.6-pro', providerName: 'xiaomi-plan' })
  })

  it('falls back to the next source when a key pool is exhausted, taking only the failed one out', async () => {
    // The claude source is the cheapest candidate, so it is the pin; once its
    // whole key pool is exhausted (pi-ai surfaces `KEY_QUOTA` only then) the
    // re-decision must move on rather than fail the turn on a route with no key
    // left. The plan ties it and keeps its configured position, so it serves
    // the turn before the dearer endpoint.
    const claude: ExtraSource = {
      ...CLAUDE,
      modelMap: { 'xiaomi/mimo-v2.6-pro': 'mimo-v2.6-pro@{"usdPerToken":1e-8}' },
    }
    const plan: ExtraSource = {
      ...PLAN,
      modelMap: { 'xiaomi/mimo-v2.6-pro': 'mimo-v2.6-pro@{"usdPerToken":1e-8}' },
    }
    // A price-free plan ties the failed claude source and keeps its configured
    // position behind it, so "the next candidate" is the plan rather than the
    // endpoint; a strictly cheaper plan would win outright, which the ranking
    // case above already pins.
    const h = await scenario({
      sources: [claude, plan],
      responses: [failureChunks('KEY_QUOTA'), normalChunks()],
    })
    const chunks = await run(h.adapter)
    expect(h.sent).toHaveLength(2)
    expect(h.sent[0]?.options.provider).toBe('claude-proxy')
    expect(h.sent[1]?.options.provider).toBe('xiaomi-plan')
    expect(h.sent[1]?.options.model).toBe('mimo-v2.6-pro')
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    // The failed source is excluded by `route:id`, so the next turn cannot land
    // on it again before `excludeAfterFailureMs` expires. The other two serve
    // the same canonical id and are untouched: one route failing says nothing
    // about another route's copy of the model.
    expect(h.events.at(-1)).toMatchObject({ boundary: 'failure', excludedTags: ['claude-proxy:mimo-v2.6-pro'] })
    expect(h.records.at(-1)?.candidates.map(entry => [entry.tag, entry.source, entry.rejection]))
      .toEqual([
        ['mimo-v2.6-pro', 'xiaomi-plan', undefined],
        ['streamlake/fp8', 'openrouter', undefined],
        ['mimo-v2.6-pro', 'claude-proxy', 'excluded'],
      ])
  })

  it('reroutes a spent subscription onto another model\'s live subscription before any pay-per-token endpoint', async () => {
    // The failure contract this seam owns: a failure re-ranks the whole tier, so
    // the cheapest healthy candidate serves the rest of the turn even when it
    // runs a different model. A spent subscription of one model must not spend
    // on that model's OpenRouter endpoint while another model's subscription
    // sits live — the subscriptions are the resource the ranking exists to spend
    // last.
    const spent: ExtraSource = {
      route: 'claude-proxy',
      models: [],
      modelMap: { 'xiaomi/mimo-v2.6-pro': 'mimo-v2.6-pro@{"usdPerToken":1e-8}' },
      price: {},
      tools: true,
    }
    const live: ExtraSource = {
      route: 'zai',
      models: [],
      modelMap: { 'z-ai/glm-5.3': 'glm-5.3@{"usdPerToken":2e-8}' },
      price: {},
      tools: true,
    }
    const h = await harness({
      tiers: [{ ...MIMO, models: ['xiaomi/mimo-v2.6-pro', 'z-ai/glm-5.3'], extraSources: [spent, live] }],
      endpoints: {
        'xiaomi/mimo-v2.6-pro': [endpointOf('streamlake/fp8', 1.2e-7)],
        'z-ai/glm-5.3': [endpointOf('novita/fp8', 1.2e-7)],
      },
      settings: {
        judgeEnabled: false,
        defaultTier: 'flash', judgeProTier: 'flash', judgeFlashTier: 'flash',
      },
      responses: [failureChunks('QUOTA'), normalChunks()],
    })
    const chunks = await run(h.adapter)
    expect(h.sent).toHaveLength(2)
    expect(h.sent[0]?.options.provider).toBe('claude-proxy')
    expect(h.sent[0]?.options.model).toBe('mimo-v2.6-pro')
    expect(h.sent[1]?.options.provider).toBe('zai')
    expect(h.sent[1]?.options.model).toBe('glm-5.3')
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(h.events.at(-1)).toMatchObject({
      boundary: 'failure',
      model: 'z-ai/glm-5.3',
      source: { kind: 'zai', tag: 'glm-5.3' },
      excludedTags: ['claude-proxy:mimo-v2.6-pro'],
    })
  })

  it('leaves the subscription for OpenRouter when the quota is spent and the Session allows it', async () => {
    // The default setting, and the behavior every deployment had before the
    // switch existed: a spent quota benches the source at once and the same
    // turn continues on the model's OpenRouter endpoint.
    const h = await scenario({
      sources: [{ ...CLAUDE, modelMap: { 'xiaomi/mimo-v2.6-pro': 'mimo-v2.6-pro@{"usdPerToken":1e-8}' } }],
      responses: [failureChunks('QUOTA'), normalChunks()],
    })
    const chunks = await run(h.adapter)
    expect(h.sent.map(entry => entry.options.provider)).toEqual(['claude-proxy', 'openrouter'])
    expect(h.sent[1]?.options.model).toBe('xiaomi/mimo-v2.6-pro')
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(h.events.at(-1)).toMatchObject({ boundary: 'failure', openRouterFallback: true })
  })

  it('fails the turn on a spent subscription when the Session refused OpenRouter', async () => {
    // With the switch off, the tier's OpenRouter endpoint is not a candidate for
    // a model the subscription serves, so a spent quota has nothing left to
    // decide among. The turn fails with a code that names the choice and a wait
    // that names the cooldown, rather than quietly spending on OpenRouter.
    const h = await scenario({
      sources: [{ ...CLAUDE, modelMap: { 'xiaomi/mimo-v2.6-pro': 'mimo-v2.6-pro@{"usdPerToken":1e-8}' } }],
      settings: { fallbackToOpenRouter: false },
      responses: [failureChunks('QUOTA'), normalChunks()],
    })
    await expect(run(h.adapter)).rejects.toMatchObject({ code: MODEL_ROUTING_SUBSCRIPTION_LIMIT_CODE })
    expect(h.sent.map(entry => entry.options.provider)).toEqual(['claude-proxy'])
  })

  it('reports the subscription cooldown as the retry delay, so a policy may hold the turn for it', async () => {
    // The cooldown is the one fact a retry policy needs to wait out a spent
    // subscription instead of failing the turn. Without it on the failure, a
    // deployment that lists the code in `retryableCodes` still could not wait:
    // the retry would land inside the cooldown and fail identically.
    const h = await scenario({
      sources: [{ ...CLAUDE, modelMap: { 'xiaomi/mimo-v2.6-pro': 'mimo-v2.6-pro@{"usdPerToken":1e-8}' } }],
      settings: { fallbackToOpenRouter: false, quotaCooldownMs: 600000 },
      responses: [failureChunks('QUOTA'), normalChunks()],
    })
    const failure = await run(h.adapter).catch(error => error)
    expect(failure).toMatchObject({ code: MODEL_ROUTING_SUBSCRIPTION_LIMIT_CODE })
    expect(failure.failure.providerRetryAfterMs).toBe(600000)
  })

  it('answers the registry with the retry policy its configuration resolved', async () => {
    // The route dispatches its own requests, so its policy cannot come from the
    // inner pi-ai routes: the registry reads it from the adapter itself.
    const h = await scenario({
      settings: {
        retryPolicy: {
          mode: 'normal',
          maxRetries: 100,
          retryableCodes: [MODEL_ROUTING_SUBSCRIPTION_LIMIT_CODE],
          backoff: { maxDelayMs: 900000 },
        },
      },
    })
    expect(h.adapter.providerRetryPolicy()).toMatchObject({
      mode: 'normal',
      maxRetries: 100,
      retryableCodes: [MODEL_ROUTING_SUBSCRIPTION_LIMIT_CODE],
      maxDelayMs: 900000,
    })
  })

  it('runs an image turn on a text-only subscription when the tier accepts losing the picture', async () => {
    // `imageInput: 'omit'` is the deployment saying a text answer is worth more
    // than no answer: the image becomes the stable placeholder, the turn reaches
    // the cheaper model, and the decision records that it did.
    const h = await harness({
      tiers: [{
        ...MIMO,
        models: ['z-ai/glm-5.3'],
        imageInput: 'omit',
        extraSources: [{ ...PLAN, modelMap: { 'z-ai/glm-5.3': 'glm-5.3@{"usdPerToken":1e-8}' } }],
      }],
      endpoints: { 'z-ai/glm-5.3': [endpointOf('streamlake/fp8', 1.2e-7)] },
      catalog: [{ id: 'z-ai/glm-5.3', canonicalSlug: 'z-ai/glm-5.3-20260920', inputModalities: ['text'] }],
      settings: { judgeEnabled: false, defaultTier: 'flash', judgeProTier: 'flash', judgeFlashTier: 'flash' },
    })
    await run(h.adapter, imageRequest())
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]?.options.provider).toBe('xiaomi-plan')
    expect(h.sent[0]?.options.model).toBe('glm-5.3')
    // The dispatch carries no image at all: what reached the provider is the
    // placeholder the omission produces.
    const content = h.sent[0]?.options.messages.flatMap(message => message.content) ?? []
    expect(content.some(block => block.type === 'image')).toBe(false)
    expect(content.some(block => block.type === 'text' && block.text.includes('image omitted'))).toBe(true)
    expect(h.events[0]).toMatchObject({ model: 'z-ai/glm-5.3', imagesOmitted: true })
  })

  it('prefers a model that can read the image even when the tier accepts losing it', async () => {
    // Omission is the last resort, not the first: an image-capable candidate that
    // passes every filter still wins, so a tier does not silently stop reading
    // screenshots the moment one text-only subscription is cheaper.
    const h = await harness({
      tiers: [{
        ...MIMO,
        models: ['z-ai/glm-5.3', 'z-ai/glm-5.3-vision'],
        imageInput: 'omit',
        extraSources: [{ ...PLAN, modelMap: { 'z-ai/glm-5.3': 'glm-5.3@{"usdPerToken":1e-8}' } }],
      }],
      endpoints: {
        'z-ai/glm-5.3': [endpointOf('streamlake/fp8', 1.2e-7)],
        'z-ai/glm-5.3-vision': [endpointOf('novita/fp8', 5e-7)],
      },
      catalog: [
        { id: 'z-ai/glm-5.3', canonicalSlug: 'z-ai/glm-5.3-20260920', inputModalities: ['text'] },
        { id: 'z-ai/glm-5.3-vision', canonicalSlug: 'z-ai/glm-5.3-vision-20260920', inputModalities: ['text', 'image'] },
      ],
      settings: { judgeEnabled: false, defaultTier: 'flash', judgeProTier: 'flash', judgeFlashTier: 'flash' },
    })
    await run(h.adapter, imageRequest())
    expect(h.sent[0]?.options.model).toBe('z-ai/glm-5.3-vision')
    expect(h.events[0]?.imagesOmitted).toBeUndefined()
    expect(h.sent[0]?.options.messages.flatMap(message => message.content).some(block => block.type === 'image')).toBe(true)
  })

  it('never dispatches a subscription whose model the catalog shows as text-only to an image request', async () => {
    // Measured 2026-10-19: z.ai answers an image part with `400 (1210)
    // messages.content.type is invalid, allowed values: ['text']`, while the same
    // request without one succeeds. A direct source therefore inherits its
    // modality from the canonical id's catalog entry, and an image turn must
    // reach a model that accepts one rather than 400 on the subscription.
    const h = await harness({
      tiers: [{
        ...MIMO,
        models: ['z-ai/glm-5.3', 'z-ai/glm-5.3-vision'],
        extraSources: [{ ...PLAN, modelMap: { 'z-ai/glm-5.3': 'glm-5.3@{"usdPerToken":1e-8}' } }],
      }],
      endpoints: {
        'z-ai/glm-5.3': [endpointOf('streamlake/fp8', 1.2e-7)],
        'z-ai/glm-5.3-vision': [endpointOf('novita/fp8', 1.2e-7)],
      },
      catalog: [
        { id: 'z-ai/glm-5.3', canonicalSlug: 'z-ai/glm-5.3-20260920', inputModalities: ['text'] },
        { id: 'z-ai/glm-5.3-vision', canonicalSlug: 'z-ai/glm-5.3-vision-20260920', inputModalities: ['text', 'image'] },
      ],
      settings: {
        judgeEnabled: false,
        defaultTier: 'flash', judgeProTier: 'flash', judgeFlashTier: 'flash',
        fallbackToOpenRouter: false,
      },
    })
    await run(h.adapter, imageRequest())
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]?.options.provider).toBe('openrouter')
    expect(h.sent[0]?.options.model).toBe('z-ai/glm-5.3-vision')
    // The subscription is cheaper and still never ran: the modality filter, not
    // the price, decided this turn.
    expect(h.events[0]).toMatchObject({ model: 'z-ai/glm-5.3-vision', source: { kind: 'openrouter' } })
  })

  it('names the filters, not the quota, when a live subscription fails one of them', async () => {
    // "Nothing ranked" has two causes worth telling apart: every subscription is
    // benched on its quota, or a subscription is available and fails a filter.
    // Only the first is a wait; the second is a configuration the person has to
    // change, and reporting it as a quota wait would send them looking for a
    // cooldown that does not exist.
    const h = await scenario({
      // A source that takes no tool calls cannot serve this request, so it is
      // rejected while still being available.
      sources: [{ ...CLAUDE, tools: false, modelMap: { 'xiaomi/mimo-v2.6-pro': 'mimo-v2.6-pro@{"usdPerToken":1e-8}' } }],
      settings: { fallbackToOpenRouter: false },
    })
    await expect(run(h.adapter)).rejects.toMatchObject({ code: 'MODEL_ROUTING_NO_ENDPOINT' })
  })

  it('keeps a model the subscription does not serve even when the Session refused OpenRouter', async () => {
    // Dropping every OpenRouter candidate would delete the models the tier only
    // has there. The switch is about which source serves a model, not about
    // which models exist, so a model with no direct source still ranks.
    const h = await scenario({
      sources: [{ ...CLAUDE, modelMap: { 'xiaomi/mimo-v2.6-pro': 'mimo-v2.6-pro@{"usdPerToken":1e-8}' } }],
      settings: { fallbackToOpenRouter: false },
    })
    await run(h.adapter)
    h.sent.length = 0
    const other = await scenario({
      sources: [{ ...CLAUDE, modelMap: { 'xiaomi/other-pro': 'other-pro@{"usdPerToken":1e-8}' } }],
      settings: { fallbackToOpenRouter: false },
    })
    await run(other.adapter)
    expect(other.sent[0]?.options.provider).toBe('openrouter')
    expect(other.sent[0]?.options.model).toBe('xiaomi/mimo-v2.6-pro')
  })

  it('follows the Session choice over the deployment default', async () => {
    // The switch is per Session, so the state a resumed Session carries decides
    // even when the deployment setting says the opposite: a person who turned
    // fallback off in one conversation must not find it on again because the
    // Host restarted with `fallbackToOpenRouter: true`.
    const h = await scenario({
      sources: [{ ...CLAUDE, modelMap: { 'xiaomi/mimo-v2.6-pro': 'mimo-v2.6-pro@{"usdPerToken":1e-8}' } }],
      settings: { fallbackToOpenRouter: true },
      state: priorDecision({ openRouterFallback: false, decision: null, decidedAt: null }),
      responses: [failureChunks('QUOTA'), normalChunks()],
    })
    await expect(run(h.adapter)).rejects.toMatchObject({ code: MODEL_ROUTING_SUBSCRIPTION_LIMIT_CODE })
    expect(h.sent.map(entry => entry.options.provider)).toEqual(['claude-proxy'])
  })

  it('falls back to the next source when the route rejects this client, keeping the request intact', async () => {
    // A client-identity gate rejects the deployment's client, not the request:
    // the same request is servable by the next candidate, so the re-decision
    // moves on instead of failing the turn on a route that cannot serve it.
    const claude: ExtraSource = {
      ...CLAUDE,
      modelMap: { 'xiaomi/mimo-v2.6-pro': 'mimo-v2.6-pro@{"usdPerToken":1e-8}' },
    }
    const plan: ExtraSource = {
      ...PLAN,
      modelMap: { 'xiaomi/mimo-v2.6-pro': 'mimo-v2.6-pro@{"usdPerToken":1e-8}' },
    }
    const h = await scenario({
      sources: [claude, plan],
      responses: [failureChunks('CLIENT_GATE'), normalChunks()],
    })
    const chunks = await run(h.adapter)
    expect(h.sent).toHaveLength(2)
    expect(h.sent[0]?.options.provider).toBe('claude-proxy')
    expect(h.sent[1]?.options.provider).toBe('xiaomi-plan')
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(h.events.at(-1)).toMatchObject({ boundary: 'failure', excludedTags: ['claude-proxy:mimo-v2.6-pro'] })
  })

  it('restores a direct-source pin from the log and dispatches it on the same route', async () => {
    const h = await scenario({
      state: {
        decision: {
          boundary: 'start', requested: 'flash', tier: 'flash', model: 'xiaomi/mimo-v2.6-pro',
          source: { kind: 'xiaomi-plan', tag: 'mimo-v2.6-pro' },
          endpoint: { tag: 'mimo-v2.6-pro', providerName: 'xiaomi-plan', promptUsd: 4.363636e-7, completionUsd: 8.727273e-7, cacheReadUsd: 3.636364e-9 },
          considered: 1, runnersUp: [], excludedTags: [],
        },
        decidedAt: 1, lastResponseAt: 999, compactedSinceDecision: false,
        explicitSelection: false, overrides: {},
        openRouterFallback: null,
      },
    })
    await run(h.adapter)
    expect(h.sent[0]?.options.provider).toBe('xiaomi-plan')
    expect(h.sent[0]?.options.model).toBe('mimo-v2.6-pro')
    expect(blockOf(h.sent[0]!)).toBeUndefined()
    // A restart is not a boundary: the log already decided.
    expect(h.events).toHaveLength(0)
  })

  it('re-decides instead of clinching when a settings edit removed the pinned source', async () => {
    const h = await scenario({
      sources: [PLAN],
      settings: { judgeEnabled: false },
      state: {
        decision: {
          boundary: 'start', requested: 'flash', tier: 'flash', model: 'xiaomi/mimo-v2.6-pro',
          source: { kind: 'claude-proxy', tag: 'mimo-v2.6-pro' },
          considered: 1, runnersUp: [], excludedTags: [],
        },
        decidedAt: 1, lastResponseAt: 999, compactedSinceDecision: false,
        explicitSelection: false, overrides: {},
        openRouterFallback: null,
      },
    })
    const chunks = await run(h.adapter)
    expect(chunks.some(chunk => chunk.type === 'finish' && chunk.reason.kind === 'error')).toBe(false)
    expect(h.events).toHaveLength(1)
    expect(h.events[0]).toMatchObject({ boundary: 'start', source: { kind: 'xiaomi-plan' } })
  })

  it('never ranks a source whose route the runtime cannot dispatch', async () => {
    const h = await scenario({
      sources: [{ ...CLAUDE, route: 'no-such-route' }, PLAN],
      settings: { judgeEnabled: false },
    })
    await run(h.adapter)
    expect(h.sent[0]?.options.provider).toBe('xiaomi-plan')
    expect(h.warnings).toContain(
      'model-routing: extraSource "no-such-route" serves "mimo-v2.6-pro", which no'
      + ' configured pi-ai route can dispatch, so that source never ranks — @deepseek-ai/dsh-llm-pi-ai'
      + ' has no route "no-such-route"',
    )
  })

  it('gives up after the reroute budget and reports the failure on a direct source', async () => {
    // The plan is the cheapest candidate here, so the budget is spent entirely
    // on direct sources and the turn still ends in the reported failure rather
    // than in an unhandled one.
    const plan: ExtraSource = {
      ...PLAN,
      modelMap: { 'xiaomi/mimo-v2.6-pro': 'mimo-v2.6-pro@{"usdPerToken":1e-8}' },
    }
    const h = await scenario({
      sources: [CLAUDE, plan],
      responses: [failureChunks('KEY_QUOTA'), failureChunks('KEY_QUOTA'), failureChunks('KEY_QUOTA')],
    })
    const chunks = await run(h.adapter)
    expect(h.sent).toHaveLength(3)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error' } })
    expect(h.sent.map(entry => entry.options.provider)).toEqual(['xiaomi-plan', 'openrouter', 'claude-proxy'])
    // The last attempt's exclusion is not recorded — the turn ended in the
    // failure the budget gave up on, and its candidate is the one the report names.
    expect(h.events.at(-1)?.excludedTags).toEqual(['streamlake/fp8', 'xiaomi-plan:mimo-v2.6-pro'])
  })

  it('excludes a direct source whose iterator throws before any content', async () => {
    const h = await scenario({
      sources: [CLAUDE, PLAN],
      responses: [
        chunksThenThrow([], new LlmError('pi-ai stream idle timeout', 'TIMEOUT')),
        normalChunks(),
      ],
    })
    const chunks = await run(h.adapter)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(h.sent.map(entry => entry.options.provider)).toEqual(['xiaomi-plan', 'openrouter'])
    expect(h.events.at(-1)?.excludedTags).toEqual(['xiaomi-plan:mimo-v2.6-pro'])
  })

  it('re-decides a pinned direct source only on the request\'s modality, never on the catalog', async () => {
    // Only an OpenRouter pin is checked against OpenRouter's catalog for
    // modalities: a direct source's modality is not something that catalog
    // knows, so the pin stands and the dispatch goes out unchanged even when
    // the catalog cannot be read at all.
    const h = await scenario({ catalogFails: true })
    await run(h.adapter)
    await run(h.adapter)
    expect(h.sent.map(entry => entry.options.provider)).toEqual(['xiaomi-plan', 'xiaomi-plan'])
    expect(h.events).toHaveLength(1)
    expect(h.warnings).not.toContain(
      expect.stringContaining('is not shown to accept image input'),
    )
  })

  it('keeps a pin whose model is gone from a live settings edit, and restores none', async () => {
    // The log recorded a decision naming a direct source the current settings no
    // longer list; nothing remains to dispatch it on, so the pin is rebuilt as
    // nothing and the request decides again.
    const h = await scenario({
      sources: [PLAN],
      state: {
        decision: {
          boundary: 'start', requested: 'flash', tier: 'flash', model: 'xiaomi/mimo-v2.6-pro',
          source: { kind: 'xiaomi-plan', tag: 'gone-id' },
          considered: 1, runnersUp: [], excludedTags: [],
        },
        decidedAt: 1, lastResponseAt: 999, compactedSinceDecision: false,
        explicitSelection: false, overrides: {},
        openRouterFallback: null,
      },
    })
    await run(h.adapter)
    expect(h.events).toHaveLength(1)
    expect(h.events[0]).toMatchObject({ boundary: 'start', source: { kind: 'xiaomi-plan', tag: 'mimo-v2.6-pro' } })
  })

  it('holds the pinned source until it fails the configured number of times in a row', async () => {
    // The shipped default is five consecutive failures, so a source that blips
    // once keeps the pin and the retry stays on it. Only the fifth failure in a
    // row benches it, which is what lets the next attempt reach another source.
    const tied = (source: ExtraSource): ExtraSource => ({
      ...source,
      modelMap: { 'xiaomi/mimo-v2.6-pro': 'mimo-v2.6-pro@{"usdPerToken":1e-8}' },
    })
    const h = await scenario({
      sources: [tied(CLAUDE), tied(PLAN)],
      settings: { excludeAfterFailures: 5 },
      responses: [
        failureChunks('TRANSPORT'), failureChunks('TRANSPORT'), failureChunks('TRANSPORT'),
        failureChunks('TRANSPORT'), failureChunks('TRANSPORT'), normalChunks(),
      ],
    })
    await run(h.adapter)
    // One request retries the pinned source until its failure count reaches the
    // threshold, because a re-decision that lands on the same candidate is not a
    // move and does not spend `maxReroutes`. The fifth failure benches it, and
    // the attempt after that reaches the next source in the same request.
    expect(h.sent.map(entry => entry.options.provider))
      .toEqual(['claude-proxy', 'claude-proxy', 'claude-proxy', 'claude-proxy', 'claude-proxy', 'xiaomi-plan'])
    expect(h.events.at(-1)?.excludedTags).toEqual(['claude-proxy:mimo-v2.6-pro'])
    expect(h.records.at(-1)?.candidates.map(entry => [entry.tag, entry.source, entry.rejection]))
      .toEqual([
        ['mimo-v2.6-pro', 'xiaomi-plan', undefined],
        ['streamlake/fp8', 'openrouter', undefined],
        ['mimo-v2.6-pro', 'claude-proxy', 'excluded'],
      ])
  })

  it('spends the reroute budget on candidate changes, not on attempts', async () => {
    // The failure count and the reroute budget are independent: one request may
    // retry a candidate past `maxReroutes` attempts, because only the move to a
    // different candidate is what the budget pays for. Charging every attempt
    // would let a budget of one end the request after its second attempt, before
    // the third failure could bench the source and reach the other one.
    const tied = (source: ExtraSource): ExtraSource => ({
      ...source,
      modelMap: { 'xiaomi/mimo-v2.6-pro': 'mimo-v2.6-pro@{"usdPerToken":1e-8}' },
    })
    const h = await scenario({
      sources: [tied(CLAUDE), tied(PLAN)],
      settings: { excludeAfterFailures: 3, maxReroutes: 1 },
      responses: [
        failureChunks('TRANSPORT'), failureChunks('TRANSPORT'), failureChunks('TRANSPORT'), normalChunks(),
      ],
    })
    const chunks = await run(h.adapter)
    expect(h.sent.map(entry => entry.options.provider))
      .toEqual(['claude-proxy', 'claude-proxy', 'claude-proxy', 'xiaomi-plan'])
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(h.events.at(-1)?.excludedTags).toEqual(['claude-proxy:mimo-v2.6-pro'])
  })

  it('starts the failure count over once a bench has lapsed', async () => {
    // A lapsed bench means the candidate is eligible again, and the count that
    // benched it belongs to the run that just ended. Keeping it would make the
    // threshold a one-time allowance: every later failure would bench at once,
    // which is exactly the behavior the count exists to prevent.
    const tied = (source: ExtraSource): ExtraSource => ({
      ...source,
      modelMap: { 'xiaomi/mimo-v2.6-pro': 'mimo-v2.6-pro@{"usdPerToken":1e-8}' },
    })
    const h = await scenario({
      sources: [tied(CLAUDE), tied(PLAN)],
      settings: { excludeAfterFailures: 2 },
      responses: [
        failureChunks('TRANSPORT'), failureChunks('TRANSPORT'), normalChunks(),
        failureChunks('TRANSPORT'), failureChunks('TRANSPORT'), normalChunks(),
      ],
    })
    await run(h.adapter)
    // Two failures bench the source, and the move that follows serves the turn.
    expect(h.sent.map(entry => entry.options.provider))
      .toEqual(['claude-proxy', 'claude-proxy', 'xiaomi-plan'])

    // Past both the bench and the prompt-cache idle window: the next request
    // re-decides and finds the first source eligible again.
    h.clock.now += 700_000
    await run(h.adapter)
    // A fresh count, so it takes two failures again rather than the one a
    // surviving count would have benched on.
    expect(h.sent.map(entry => entry.options.provider))
      .toEqual(['claude-proxy', 'claude-proxy', 'xiaomi-plan', 'claude-proxy', 'claude-proxy', 'xiaomi-plan'])
  })

  it('retries a source that throws its key-pool exhaustion, then moves on', async () => {
    // A route with every key cooling throws `KEY_QUOTA` from the first read
    // rather than reporting it in-band. That answer is not a blip — the quota is
    // spent — so the source leaves the ranking on the first failure instead of
    // the request spending attempts to reach the streak threshold, and the next
    // candidate serves the turn.
    const tied = (source: ExtraSource): ExtraSource => ({
      ...source,
      modelMap: { 'xiaomi/mimo-v2.6-pro': 'mimo-v2.6-pro@{"usdPerToken":1e-8}' },
    })
    const exhausted = () => chunksThenThrow([], new LlmError('route exhausted every key', 'KEY_QUOTA'))
    const h = await scenario({
      sources: [tied(CLAUDE), tied(PLAN)],
      settings: { excludeAfterFailures: 2 },
      responses: [exhausted(), normalChunks()],
    })
    const chunks = await run(h.adapter)
    expect(h.sent.map(entry => entry.options.provider))
      .toEqual(['claude-proxy', 'xiaomi-plan'])
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(h.events.at(-1)?.excludedTags).toEqual(['claude-proxy:mimo-v2.6-pro'])
  })

  it('clears the consecutive-failure count when the source answers again', async () => {
    // A count that survived a success would bench a healthy source on the first
    // failure of a later turn, which is the behavior the count exists to avoid.
    const tied = (source: ExtraSource): ExtraSource => ({
      ...source,
      modelMap: { 'xiaomi/mimo-v2.6-pro': 'mimo-v2.6-pro@{"usdPerToken":1e-8}' },
    })
    const h = await scenario({
      sources: [tied(CLAUDE), tied(PLAN)],
      settings: { excludeAfterFailures: 2 },
      responses: [
        failureChunks('TRANSPORT'), normalChunks(),
        failureChunks('TRANSPORT'), normalChunks(),
      ],
    })
    await run(h.adapter)
    expect(h.sent.map(entry => entry.options.provider)).toEqual(['claude-proxy', 'claude-proxy'])
    // Two failures separated by a success never add up: each request benches
    // nothing, because the success between them reset the count to zero.
    await run(h.adapter)
    expect(h.sent.map(entry => entry.options.provider))
      .toEqual(['claude-proxy', 'claude-proxy', 'claude-proxy', 'claude-proxy'])
    for (const event of h.events) expect(event.excludedTags).toEqual([])
  })

  it('benches a source on its Nth consecutive failure, skipping the counts below it', async () => {
    // The same shape as the threshold case above, with the count set to two: the
    // second failure in a row benches, so the attempt after it moves on.
    const tied = (source: ExtraSource): ExtraSource => ({
      ...source,
      modelMap: { 'xiaomi/mimo-v2.6-pro': 'mimo-v2.6-pro@{"usdPerToken":1e-8}' },
    })
    const h = await scenario({
      sources: [tied(CLAUDE), tied(PLAN)],
      settings: { excludeAfterFailures: 2 },
      responses: [failureChunks('TRANSPORT'), failureChunks('TRANSPORT'), normalChunks()],
    })
    await run(h.adapter)
    expect(h.sent.map(entry => entry.options.provider)).toEqual(['claude-proxy', 'claude-proxy', 'xiaomi-plan'])
    expect(h.events.at(-1)?.excludedTags).toEqual(['claude-proxy:mimo-v2.6-pro'])
  })

  it('records the source kind and the blended price a direct source won on', async () => {
    const h = await scenario()
    await run(h.adapter)
    const record = h.records[0]!
    const winner = record.candidates.find(entry => entry.rejection === undefined)
    expect(winner).toMatchObject({
      model: 'xiaomi/mimo-v2.6-pro',
      tag: 'mimo-v2.6-pro',
      source: 'xiaomi-plan',
      promptUsd: 4.363636e-7,
      completionUsd: 8.727273e-7,
      cacheReadUsd: 3.636364e-9,
      rank: 1,
    })
    expect(record.candidates.filter(entry => entry.source === 'openrouter')).toHaveLength(1)
  })
})
