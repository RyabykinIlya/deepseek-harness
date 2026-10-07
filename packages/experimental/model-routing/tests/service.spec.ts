import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ModelRoutingService from '../src/index.ts'
import type { RoutingDiagnosticsRecord } from '../src/types.ts'
import type { ModelRoutingService as ModelRoutingServiceClass } from '../src/service.ts'

const FLASH = {
  name: 'flash',
  label: 'Flash',
  models: ['deepseek/deepseek-v4-flash', 'z-ai/glm-5.3-flash'],
  contextWindow: 1_000_000,
  maxTokens: 32_768,
  input: ['text'],
  minQuantization: 'fp8',
  unknownQuantization: 'trusted',
  free: 'off',
}

const PRO = {
  ...FLASH,
  name: 'pro',
  label: 'Pro',
  models: ['deepseek/deepseek-v4-pro'],
  unknownQuantization: 'reject',
}

/** The inner route is registered so the plugin mounts; no request ever reaches it here. */
class EmptyAdapter extends LlmAdapter {
  override async * stream(): AsyncIterable<StreamChunk> { /* no request is dispatched in these tests */ }
}

/**
 * The `/models` reply these cases are resolved against, reduced to the two
 * identity fields the family reader takes, as OpenRouter publishes them.
 */
const CATALOG = {
  data: [
    { id: 'deepseek/deepseek-v4-pro', canonical_slug: 'deepseek/deepseek-v4-pro-20260423' },
    { id: 'deepseek/deepseek-v4-pro-0813', canonical_slug: 'deepseek/deepseek-v4-pro-20260813' },
    { id: 'deepseek/deepseek-v4-flash', canonical_slug: 'deepseek/deepseek-v4-flash-20260423' },
    { id: 'deepseek/deepseek-v4-flash-0731', canonical_slug: 'deepseek/deepseek-v4-flash-20260731' },
  ],
}

/** Serve the recorded `/models`, `/endpoints`, and `/key` replies to whatever the service asks for. */
function stubNetwork(keyBody: unknown = { data: { free_model_daily_requests: { used: 0, limit: 1000, remaining: 1000 } } }) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : input.toString()
    if (url.endsWith('/key')) return new Response(JSON.stringify(keyBody), { status: 200 })
    if (url.endsWith('/models')) return new Response(JSON.stringify(CATALOG), { status: 200 })
    const model = url.slice(url.lastIndexOf('/models/') + '/models/'.length, url.lastIndexOf('/endpoints'))
    // The August releases are priced by the April listings these tests carry: the
    // endpoint list is what the quote reads, and its prices are not what these
    // cases are about.
    const dated = model.replace('-0813', '').replace('-0731', '')
    const name = `${dated.replace('/', '__').replace(':', '--')}.json`
    const body: unknown = JSON.parse(await readFile(
      fileURLToPath(new URL(`./fixtures/endpoints/${name}`, import.meta.url)),
      'utf8',
    ))
    return new Response(JSON.stringify(body), { status: 200 })
  })
}

/** Mount the real service with the two tiers the quotes are priced under. */
async function service(keyBody?: unknown, config: Record<string, unknown> = {}) {
  const fetchStub = stubNetwork(keyBody)
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  ctx.llm.registerAdapter(['openrouter'], new EmptyAdapter())
  await ctx.plugin(ModelRoutingService, { tiers: [PRO, FLASH], ...config } as never)
  return { ctx, service: ctx.get('modelRouting') as unknown as ModelRoutingServiceClass, fetch: fetchStub }
}

beforeEach(() => {
  vi.stubEnv('OPENROUTER_API_KEY', 'test-key')
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('Remote quote', () => {
  it('prices each model under the tier\'s filters', async () => {
    const { service: routing } = await service()
    const quotes = await routing.quote({
      tier: 'flash',
      models: ['deepseek/deepseek-v4-flash', 'z-ai/glm-5.3-flash'],
    })
    expect(quotes).toHaveLength(2)
    expect(quotes[0]).toMatchObject({
      model: 'deepseek/deepseek-v4-flash',
      endpoint: { tag: 'streamlake/fp8', quantization: 'fp8' },
    })
    expect(quotes[1]?.endpoint?.tag).toBe('streamlake/fp8')
    expect(quotes[0]?.blendedUsdPerToken).toBeGreaterThan(0)
    expect(quotes[0]?.eligible).toBeGreaterThan(0)
    expect(quotes[0]?.total).toBeGreaterThan(quotes[0]?.eligible ?? 0)
  })

  it('prices a model the tier does not list, under that tier\'s filters', async () => {
    const { service: routing } = await service()
    const [quote] = await routing.quote({ tier: 'pro', models: ['deepseek/deepseek-v4-flash'] })
    // The pro tier rejects `unknown`, so the flash tier's free endpoint is out.
    expect(quote?.endpoint?.quantization).not.toBe('unknown')
  })

  it('prices the release a tier resolves to, not the one it names', async () => {
    const { service: routing } = await service(undefined, { snapshotPolicy: 'latest' })
    const [quote] = await routing.quote({ tier: 'pro', models: ['deepseek/deepseek-v4-pro'] })
    expect(quote?.model).toBe('deepseek/deepseek-v4-pro-0813')
    expect(quote?.endpoint?.tag).toBe('streamlake/fp8')
  })

  it('prices a direct source beside the model\'s OpenRouter endpoints', async () => {
    // The quote has to say what the model costs this turn whichever source
    // serves it, and `total` counts both kinds of candidate.
    const { service: routing } = await service(undefined, {
      defaultTier: 'pro', judgeProTier: 'pro', judgeFlashTier: 'pro',
      tiers: [{
        ...PRO,
        extraSources: [{
          route: 'xiaomi-plan',
          models: [],
          modelMap: { 'deepseek/deepseek-v4-pro': 'mimo-v2.6-pro@{"usdPerToken":1e-8}' },
          price: {},
          tools: true,
        }],
      }],
    })
    const [quote] = await routing.quote({ tier: 'pro', models: ['deepseek/deepseek-v4-pro'] })
    expect(quote?.endpoint).toEqual({
      tag: 'mimo-v2.6-pro',
      providerName: 'xiaomi-plan',
      promptUsd: 1e-8,
      completionUsd: 1e-8,
    })
    expect(quote?.blendedUsdPerToken).toBeCloseTo(1e-8)
    // Eight OpenRouter endpoints of the model pass the pro filters, and the
    // direct source is the ninth candidate — counted like any other.
    expect(quote?.eligible).toBe(9)
    // The listing carries sixteen endpoints; the direct source is counted on
    // top of them, so a quote cannot hide a source inside another count.
    expect(quote?.total).toBe(17)
  })

  it('reports a tier no configuration names', async () => {
    const { service: routing } = await service()
    await expect(routing.quote({ tier: 'max', models: ['deepseek/deepseek-v4-flash'] }))
      .rejects.toMatchObject({ code: 'model-routing/unknown-tier' })
  })

  it('refuses more models than one call may price', async () => {
    const { service: routing } = await service()
    const models = Array.from({ length: 51 }, (_, index) => `author/model-${index}`)
    await expect(routing.quote({ tier: 'flash', models }))
      .rejects.toMatchObject({ code: 'model-routing/too-many-models' })
  })

  it('refuses to quote once a settings write leaves a tier unservable, instead of pricing it anyway', async () => {
    // A settings write lands after mount without restarting the plugin — the
    // same way the real Host settings document commits a card's save. Writing
    // `trustedUnknownProviders` empty while `flash` still trusts unknown
    // quantization (`unknownQuantization: 'trusted'`) is exactly the config
    // the settings card could save without itself validating anything: every
    // real request would now throw, and `quote` must throw too, or the card
    // keeps showing prices for a tier that cannot actually be dispatched.
    const { updateVolatile, createVolatile } = await import('../../../../vendor/cosmokit/src/volatile.ts')
    const { service: routing } = await service()
    const config = (routing as unknown as { config: { trustedUnknownProviders: Parameters<typeof updateVolatile>[0] } }).config
    updateVolatile(config.trustedUnknownProviders, createVolatile([]))
    await expect(routing.quote({ tier: 'flash', models: ['deepseek/deepseek-v4-flash'] }))
      .rejects.toMatchObject({ code: 'model-routing/invalid-settings' })
  })
})

describe('Remote freeUsage', () => {
  it('answers the account budget', async () => {
    const { service: routing } = await service()
    expect(await routing.freeUsage()).toEqual({ used: 0, limit: 1000, remaining: 1000 })
  })

  it('answers nothing while the account carries no free quota', async () => {
    const { service: routing } = await service({ data: {} })
    expect(await routing.freeUsage()).toBeNull()
  })
})

describe('the diagnostics history', () => {
  it('appends one line per decision to the configured file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'model-routing-history-'))
    try {
      const path = join(root, 'nested', 'history.jsonl')
      const { ctx } = await service(undefined, { diagnosticsPath: path })
      // A stub dispatch stands in for pi-ai, so the whole request path runs and
      // only the transport is external.
      const dispatched: GenerateOptions[] = []
      ctx.provide('piAiDispatch', {
        stream: (options: GenerateOptions) => {
          dispatched.push(options)
          return (async function* (): AsyncIterable<StreamChunk> {
            yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 1 } }
            yield { type: 'finish', reason: { kind: 'stop' }, replayState: { response: { kind: 'pi-ai', version: 2 } } }
          })()
        },
      })
      const session = ctx.sessions.create(SessionId('s1'))
      const prepared = await ctx.llm.prepareCall({ provider: 'tiers', model: 'flash' })
      for await (const _chunk of prepared.stream({
        ...prepared.config, messages: [], sessionId: session.id,
      })) { /* draining */ }
      await vi.waitFor(async () => {
        expect((await readFile(path, 'utf8')).trimEnd().split('\n')).toHaveLength(1)
      })
      const record = JSON.parse((await readFile(path, 'utf8')).trimEnd()) as RoutingDiagnosticsRecord
      expect(record).toMatchObject({
        sessionId: 's1',
        boundary: 'start',
        requested: 'flash',
        tier: 'flash',
        model: 'deepseek/deepseek-v4-flash',
        endpoint: { tag: 'streamlake/fp8' },
        mix: { cached: 0.9, fresh: 0.08, output: 0.02, source: 'default' },
      })
      expect(record.candidates).toHaveLength(record.considered)
      expect(record.candidates[0]).toMatchObject({ tag: 'streamlake/fp8', rank: 1 })
      expect(dispatched).toHaveLength(1)
      // The same decision is in the Session log, in its miniature form.
      expect(session.ownEvents().some(event => event.type === 'model-routing/decision')).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('writes no file at all while no path is configured', async () => {
    const { ctx } = await service()
    let dispatched = 0
    ctx.provide('piAiDispatch', {
      stream: () => {
        dispatched += 1
        return (async function* (): AsyncIterable<StreamChunk> {
          yield { type: 'finish', reason: { kind: 'stop' }, replayState: { response: { kind: 'pi-ai', version: 2 } } }
        })()
      },
    })
    const prepared = await ctx.llm.prepareCall({ provider: 'tiers', model: 'flash' })
    for await (const _chunk of prepared.stream({ ...prepared.config, messages: [] })) { /* draining */ }
    // The turn runs; a disabled history queues no write at all.
    expect(dispatched).toBe(1)
  })
})
