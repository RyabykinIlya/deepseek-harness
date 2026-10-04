import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import ModelRoutingService from '../src/index.ts'
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
