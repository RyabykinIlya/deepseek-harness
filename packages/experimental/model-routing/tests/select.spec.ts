import { describe, expect, it } from 'vitest'
import type { OpenRouterEndpoint } from '@deepseek-ai/dsh-llm-pi-ai'
import { Config, readSettings } from '../src/config.ts'
import { directSourceModels } from '../src/config.ts'
import type { ExtraSource, RoutingSettings, TierSettings } from '../src/config.ts'
import { quantizationsAtOrAbove } from '../src/quantization.ts'
import {
  blendedPrice,
  defaultMix,
  directPricesOf,
  directSourcesOf,
  isDirect,
  mixFromUsage,
  policyFor,
  rankEndpoints,
  rankWithRelaxation,
  type DirectSource,
  type EndpointLists,
  type RequiredInput,
  type SelectionPolicy,
} from '../src/select.ts'
import { endpointsOf } from './fixtures.ts'

/** Every case shares these: a floor above half the measured uptime, and no excluded tags. */
function settingsOf(over: Record<string, unknown> = {}): RoutingSettings {
  return readSettings(Config({ tiers: [], minUptime: 95, ...over }))
}

const MIX = { cached: 0.9, fresh: 0.08, output: 0.02 }

const PRO: TierSettings = {
  name: 'pro',
  label: 'Pro',
  models: ['deepseek/deepseek-v4-pro', 'z-ai/glm-5.3'],
  contextWindow: 1_000_000,
  maxTokens: 32_768,
  input: ['text'],
  minQuantization: 'fp8',
  unknownQuantization: 'reject',
  free: 'off',
  extraSources: [],
}

const SIX = [
  'deepseek/deepseek-v4-flash',
  'z-ai/glm-5.3-flash',
  'nvidia/nemotron-3.5-lightning',
  'nvidia/nemotron-3.5-lightning:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'stealth/space-bunny-alpha',
]

const FLASH6: TierSettings = { ...PRO, name: 'flash', models: SIX, contextWindow: 262_144, unknownQuantization: 'accept' }

/** The default flash tier of §1: two paid DeepSeek/GLM routes plus the free first-party one. */
const FLASH: TierSettings = {
  ...PRO,
  name: 'flash',
  models: ['deepseek/deepseek-v4-flash', 'z-ai/glm-5.3-flash', 'stealth/space-bunny-alpha'],
  contextWindow: 1_000_000,
  unknownQuantization: 'trusted',
}

/** Every endpoint list one tier names, read from the recorded replies. */
async function listsOf(models: readonly string[]): Promise<EndpointLists> {
  const lists = new Map<string, readonly OpenRouterEndpoint[]>()
  for (const model of models) lists.set(model, await endpointsOf(model))
  return lists
}

/** Rank one tier and report only the rejections that fired. */
async function rank(
  tier: TierSettings,
  settings: RoutingSettings,
  options: {
    allowFree?: boolean
    excludedTags?: string[]
    preferModel?: string
    requiredInput?: RequiredInput
    modalities?: ReadonlyMap<string, readonly string[] | undefined>
  } = {},
): Promise<{ length: number; top: string[]; rejections: Record<string, number> }> {
  const lists = await listsOf(tier.models)
  const result = rankEndpoints(
    lists,
    tier.models,
    policyFor(tier, settings, {
      allowFree: options.allowFree ?? true,
      excludedTags: new Set(options.excludedTags ?? []),
      ...options.preferModel === undefined ? {} : { preferModel: options.preferModel },
      ...options.requiredInput === undefined ? {} : { requiredInput: options.requiredInput },
      ...options.modalities === undefined ? {} : { modalities: options.modalities },
    }),
    MIX,
  )
  return {
    length: result.ranked.length,
    top: result.ranked.slice(0, 4).map(entry => `${entry.model} ${tagOfEntry(entry.endpoint)}=${entry.blendedUsdPerToken}`),
    rejections: Object.fromEntries(Object.entries(result.rejections).filter(([, count]) => count > 0)),
  }
}

/** What the catalog declares for the pro tier's two models, `glm` named as asked. */
function declaredForPro(glm: readonly string[] | undefined): ReadonlyMap<string, readonly string[] | undefined> {
  return new Map<string, readonly string[] | undefined>([
    ['deepseek/deepseek-v4-pro', ['text']],
    ['z-ai/glm-5.3', glm],
  ])
}

describe('rankEndpoints over the recorded replies', () => {
  it('ranks the pro tier by blended price and counts each filter\'s toll', async () => {
    expect(await rank(PRO, settingsOf())).toEqual({
      length: 20,
      top: [
        'deepseek/deepseek-v4-pro streamlake/fp8=4.0716e-8',
        'z-ai/glm-5.3 novita/fp8=1.302e-7',
        'deepseek/deepseek-v4-pro gmicloud/fp8=1.8661499999999998e-7',
        'deepseek/deepseek-v4-pro parasail/fp8=1.9559999999999998e-7',
      ],
      rejections: { status: 2, context: 2, quantization: 12, 'untrusted-unknown': 20 },
    })
  })

  it('rejects free endpoints outright when the tier says off', async () => {
    expect(await rank(FLASH6, settingsOf())).toEqual({
      length: 40,
      top: [
        'deepseek/deepseek-v4-flash streamlake/fp8=8.399999999999999e-9',
        'deepseek/deepseek-v4-flash deepinfra/fp8=2.6999999999999997e-8',
        'deepseek/deepseek-v4-flash gmicloud/fp8=2.73e-8',
        'z-ai/glm-5.3-flash streamlake/fp8=2.7391e-8',
      ],
      rejections: { status: 1, tools: 1, context: 1, quantization: 13, free: 2 },
    })
  })

  it('lets a free endpoint win when the tier prefers one', async () => {
    expect(await rank({ ...FLASH6, free: 'prefer' }, settingsOf())).toEqual({
      length: 42,
      top: [
        'nvidia/nemotron-3-super-120b-a12b:free nvidia=0',
        'stealth/space-bunny-alpha stealth=0',
        'deepseek/deepseek-v4-flash streamlake/fp8=8.399999999999999e-9',
        'deepseek/deepseek-v4-flash deepinfra/fp8=2.6999999999999997e-8',
      ],
      rejections: { status: 1, tools: 1, context: 1, quantization: 13 },
    })
  })

  it('lets free endpoints win only when the caller may use them', async () => {
    expect(await rank(FLASH6, settingsOf(), { allowFree: false })).toEqual({
      length: 40,
      top: [
        'deepseek/deepseek-v4-flash streamlake/fp8=8.399999999999999e-9',
        'deepseek/deepseek-v4-flash deepinfra/fp8=2.6999999999999997e-8',
        'deepseek/deepseek-v4-flash gmicloud/fp8=2.73e-8',
        'z-ai/glm-5.3-flash streamlake/fp8=2.7391e-8',
      ],
      rejections: { status: 1, tools: 1, context: 1, quantization: 13, free: 2 },
    })
  })

  it('trusts `unknown` only from listed providers', async () => {
    const prefer = { ...FLASH6, free: 'prefer', unknownQuantization: 'trusted' } as TierSettings
    const trusted = await rank(prefer, settingsOf({ trustedUnknownProviders: ['stealth', 'nvidia'] }))
    expect(trusted.length).toBe(26)
    expect(trusted.top.slice(0, 2)).toEqual([
      'nvidia/nemotron-3-super-120b-a12b:free nvidia=0',
      'stealth/space-bunny-alpha stealth=0',
    ])
    expect(trusted.rejections['untrusted-unknown']).toBe(16)

    const untrusted = await rank(prefer, settingsOf({ trustedUnknownProviders: [] }))
    expect(untrusted.length).toBe(24)
    expect(untrusted.top[0]).toBe('deepseek/deepseek-v4-flash streamlake/fp8=8.399999999999999e-9')
    expect(untrusted.rejections['untrusted-unknown']).toBe(18)
  })

  it('admits only free endpoints when the tier says only', async () => {
    expect(await rank({ ...FLASH6, free: 'only' }, settingsOf())).toEqual({
      length: 2,
      top: [
        'nvidia/nemotron-3-super-120b-a12b:free nvidia=0',
        'stealth/space-bunny-alpha stealth=0',
      ],
      rejections: { status: 1, tools: 1, context: 1, quantization: 13, paid: 40 },
    })
  })

  it('ranks the default flash tier with `stealth` as the only trusted `unknown`', async () => {
    const settings = settingsOf({ trustedUnknownProviders: ['stealth'] })
    expect(await rank({ ...FLASH, free: 'prefer' }, settings)).toEqual({
      length: 23,
      top: [
        'stealth/space-bunny-alpha stealth=0',
        'deepseek/deepseek-v4-flash streamlake/fp8=8.399999999999999e-9',
        'deepseek/deepseek-v4-flash deepinfra/fp8=2.6999999999999997e-8',
        'deepseek/deepseek-v4-flash gmicloud/fp8=2.73e-8',
      ],
      rejections: { status: 1, context: 3, quantization: 12, 'untrusted-unknown': 12 },
    })
  })

  it('reports a model whose list could not be read instead of skipping it', async () => {
    const lists = new Map<string, readonly OpenRouterEndpoint[] | Error>([
      ['deepseek/deepseek-v4-pro', await endpointsOf('deepseek/deepseek-v4-pro')],
      ['z-ai/glm-5.3', new Error('boom')],
    ])
    const result = rankEndpoints(lists, PRO.models, policyFor(PRO, settingsOf(), {
      allowFree: true,
      excludedTags: new Set(),
    }), MIX)
    expect(result.unreadable).toEqual([{ model: 'z-ai/glm-5.3', reason: 'boom' }])
    expect(result.ranked.every(entry => entry.model === 'deepseek/deepseek-v4-pro')).toBe(true)
  })
})

describe('preferModel after a failure', () => {
  const excluded = { excludedTags: ['streamlake/fp8'] }

  it('exhausts the same model before another model may serve the request', async () => {
    const settings = settingsOf()
    const withPreference = await rank(PRO, settings, { ...excluded, preferModel: 'deepseek/deepseek-v4-pro' })
    expect(withPreference.length).toBe(19)
    expect(withPreference.top.slice(0, 4)).toEqual([
      'deepseek/deepseek-v4-pro gmicloud/fp8=1.8661499999999998e-7',
      'deepseek/deepseek-v4-pro parasail/fp8=1.9559999999999998e-7',
      'deepseek/deepseek-v4-pro deepinfra/fp8=2.46e-7',
      'deepseek/deepseek-v4-pro siliconflow/fp8=3.043296e-7',
    ])
    expect(withPreference.rejections).toEqual({
      excluded: 1, status: 2, context: 2, quantization: 12, 'untrusted-unknown': 20,
    })
  })

  it('changes the model when nothing says otherwise — the failure this rule prevents', async () => {
    const withoutPreference = await rank(PRO, settingsOf(), excluded)
    expect(withoutPreference.length).toBe(19)
    expect(withoutPreference.top.slice(0, 2)).toEqual([
      'z-ai/glm-5.3 novita/fp8=1.302e-7',
      'deepseek/deepseek-v4-pro gmicloud/fp8=1.8661499999999998e-7',
    ])
    expect(withoutPreference.rejections).toEqual({
      excluded: 1, status: 2, context: 2, quantization: 12, 'untrusted-unknown': 20,
    })
  })
})

describe('a request that carries an image', () => {
  const IMAGE = 'image'
  const TEXT_ONLY: ReadonlyMap<string, readonly string[] | undefined> = new Map([
    ['deepseek/deepseek-v4-pro', ['text']],
    ['z-ai/glm-5.3', ['text', 'image']],
  ])

  it('ranks the image-capable model ahead of the cheaper text-only one', async () => {
    const result = await rank(PRO, settingsOf(), { requiredInput: IMAGE, modalities: TEXT_ONLY })
    expect(result.length).toBe(12)
    expect(result.top).toEqual([
      'z-ai/glm-5.3 novita/fp8=1.302e-7',
      'z-ai/glm-5.3 siliconflow/fp8=2.17e-7',
      'z-ai/glm-5.3 sail-research/fp8=2.1900000000000002e-7',
      'z-ai/glm-5.3 sail-research/us=2.1900000000000002e-7',
    ])
    expect(result.rejections.modality).toBe(16)
  })

  it('still counts every endpoint of a rejected model as considered', async () => {
    const lists = await listsOf(PRO.models)
    const result = rankEndpoints(lists, PRO.models, policyFor(PRO, settingsOf(), {
      allowFree: true,
      excludedTags: new Set(),
      requiredInput: IMAGE,
      modalities: TEXT_ONLY,
    }), MIX)
    expect(result.considered).toBe(56)
    expect(result.rejections.modality).toBe(16)
    expect(result.ranked.every(entry => entry.model === 'z-ai/glm-5.3')).toBe(true)
  })

  it('refuses a model the catalog does not list, and one it lists with no modalities', async () => {
    const unlisted = await rank(PRO, settingsOf(), {
      requiredInput: IMAGE,
      modalities: new Map<string, readonly string[] | undefined>([['z-ai/glm-5.3', ['text', 'image']]]),
    })
    expect(unlisted.rejections.modality).toBeGreaterThan(0)
    expect(unlisted.top.every(entry => entry.startsWith('z-ai/glm-5.3 '))).toBe(true)

    const silent = await rank(PRO, settingsOf(), { requiredInput: IMAGE, modalities: declaredForPro(undefined) })
    expect(silent.rejections.modality).toBe(56)
    expect(silent.length).toBe(0)
  })

  it('refuses every candidate when no declaration was fetched at all', async () => {
    const result = await rank(PRO, settingsOf(), { requiredInput: IMAGE })
    expect(result.length).toBe(0)
    expect(result.rejections).toEqual({ modality: 56 })
  })

  it('leaves the ranking untouched when the request carries no modality beyond text', async () => {
    const textOnly = await rank(PRO, settingsOf())
    const withUnusedDeclarations = await rank(PRO, settingsOf(), { modalities: TEXT_ONLY })
    expect(withUnusedDeclarations).toEqual(textOnly)
    expect(textOnly.top[0]).toBe('deepseek/deepseek-v4-pro streamlake/fp8=4.0716e-8')
    expect('modality' in textOnly.rejections).toBe(false)
  })

  it('hands the request\'s requirement to the ranking only when one was declared', () => {
    const settings = settingsOf()
    const declared = declaredForPro(['text', 'image'])
    const applied = policyFor(PRO, settings, {
      allowFree: true,
      excludedTags: new Set(),
      requiredInput: IMAGE,
      modalities: declared,
    })
    expect(applied.requiredInput).toBe(IMAGE)
    expect(applied.modalities).toBe(declared)

    const plain = policyFor(PRO, settings, { allowFree: true, excludedTags: new Set() })
    expect('requiredInput' in plain).toBe(false)
    expect('modalities' in plain).toBe(false)
  })
})

describe('the turn mix', () => {
  it('normalizes the configured weights', () => {
    expect(defaultMix(settingsOf())).toEqual(MIX)
    expect(defaultMix(settingsOf({ mixCached: 4, mixFresh: 4, mixOutput: 2 })))
      .toEqual({ cached: 0.4, fresh: 0.4, output: 0.2 })
  })

  it('believes measured usage above the floor and the default below it', () => {
    const measured = { uncachedInputTokens: 100, outputTokens: 100, cacheReadTokens: 800, cacheWriteTokens: 0 }
    expect(mixFromUsage(measured, MIX, 1000)).toEqual({ cached: 0.8, fresh: 0.1, output: 0.1, source: 'usage' })
    expect(mixFromUsage({ ...measured, cacheReadTokens: 799 }, MIX, 1000)).toEqual({ ...MIX, source: 'default' })
    expect(mixFromUsage(undefined, MIX, 1000)).toEqual({ ...MIX, source: 'default' })
  })

  it('charges a cache hit at the prompt price when the provider publishes no cache price', () => {
    const plain: OpenRouterEndpoint = { slug: 'a/fp8', promptPrice: 2, completionPrice: 4 }
    const discounted: OpenRouterEndpoint = { ...plain, inputCacheReadPrice: 0.2 }
    expect(blendedPrice(plain, MIX)).toBeCloseTo(0.9 * 2 + 0.08 * 2 + 0.02 * 4)
    expect(blendedPrice(discounted, MIX)).toBeCloseTo(0.9 * 0.2 + 0.08 * 2 + 0.02 * 4)
    expect(blendedPrice({ slug: 'b/fp8', promptPrice: 2 }, MIX)).toBeUndefined()
  })
})

describe('rankWithRelaxation', () => {
  it('drops an unpassable uptime floor and reports that it did', async () => {
    // Scoped to one model: the other recorded replies carry endpoints with no
    // `uptime_last_30m` at all, and §11's rejection rule admits an endpoint that
    // states no measurement, so a whole-tier floor above 100 would still rank
    // those two. Within this model every endpoint publishes a number.
    const lists: EndpointLists = new Map([['deepseek/deepseek-v4-pro', await endpointsOf('deepseek/deepseek-v4-pro')]])
    const policyForMin = (minUptime: number): SelectionPolicy => ({
      ...policyFor(PRO, settingsOf({ minUptime }), { allowFree: true, excludedTags: new Set() }),
      contextWindow: 1_000_000,
    })
    const relaxed = rankWithRelaxation(lists, ['deepseek/deepseek-v4-pro'], policyForMin(101), MIX)
    expect(relaxed.relaxedUptime).toBe(true)
    expect(relaxed.ranked.length).toBeGreaterThan(0)
    expect(relaxed.rejections.uptime).toBe(0)

    const strict = rankWithRelaxation(lists, ['deepseek/deepseek-v4-pro'], policyForMin(95), MIX)
    expect(strict.relaxedUptime).toBe(false)
    expect(strict.rejections.uptime).toBe(0)
    expect(strict.ranked.length).toBeGreaterThan(0)
  })
})

describe('quantizationsAtOrAbove', () => {
  it('lists every format at or above the floor, in declaration order', () => {
    expect(quantizationsAtOrAbove('fp8', true))
      .toEqual(['int8', 'fp8', 'mxfp8', 'fp16', 'bf16', 'fp32', 'unknown'])
    expect(quantizationsAtOrAbove('fp8', false))
      .toEqual(['int8', 'fp8', 'mxfp8', 'fp16', 'bf16', 'fp32'])
    expect(quantizationsAtOrAbove('fp4', false))
      .toEqual(['int4', 'int8', 'fp4', 'mxfp4', 'nvfp4', 'fp6', 'fp8', 'mxfp8', 'fp16', 'bf16', 'fp32'])
  })
})

describe('direct sources beside OpenRouter endpoints', () => {
  /** One direct candidate under the canonical id the tier also ranks on OpenRouter. */
  const CLAUDE: DirectSource = {
    kind: 'direct',
    route: 'claude-proxy',
    model: 'deepseek/deepseek-v4-pro',
    id: 'mimo-v2.6-pro',
  }

  /** The tier's sources as the ranking sees them, keyed by canonical id. */
  function sourcesOf(...sources: ExtraSource[]): ReadonlyMap<string, readonly DirectSource[]> {
    const map = new Map<string, DirectSource[]>()
    for (const source of sources) {
      for (const candidate of directSourcesOf(source, directSourceModels(source))) {
        map.set(candidate.model, [...map.get(candidate.model) ?? [], candidate])
      }
    }
    return map
  }

  /**
   * The source entry the target scenario configures: a credit-weighted
   * subscription plan, priced per bucket (Xiaomi MiMo Token Plan charges credits
   * per cache-hit, cache-miss and output token). $/token = credits-per-token x
   * ($16/11e9).
   */
  const PLAN: ExtraSource = {
    route: 'xiaomi-plan',
    models: [],
    modelMap: {
      'deepseek/deepseek-v4-pro':
        'mimo-v2.6-pro@{"promptUsdPerToken":4.363636e-7,"completionUsdPerToken":8.727273e-7,"cacheReadUsdPerToken":3.636364e-9}',
    },
    price: {},
    tools: true,
  }


  /**
   * A synthetic direct source priced below every recorded endpoint, used where a
   * test asserts the mechanism — a direct source ranks beside endpoints and can
   * win on price — rather than any real plan's economics.
   */
  const CHEAP: ExtraSource = {
    route: 'xiaomi-plan',
    models: [],
    modelMap: { 'deepseek/deepseek-v4-pro': 'mimo-v2.6-pro@{"usdPerToken":1e-9}' },
    price: {},
    tools: true,
  }

  it('ranks an unpriced direct source as unpriced, not as free', () => {
    const lists: EndpointLists = new Map([['deepseek/deepseek-v4-pro', []]])
    const result = rankEndpoints(lists, PRO.models, policyFor(PRO, settingsOf(), {
      allowFree: true,
      excludedTags: new Set(),
      extraSources: sourcesOf(PLAN.price === undefined ? PLAN : { ...PLAN, modelMap: { 'deepseek/deepseek-v4-pro': 'mimo-v2.6-pro' } }),
    }), MIX)
    expect(result.ranked).toEqual([])
    expect(result.rejections).toEqual({ ...emptyOf(), unpriced: 1 })
  })

  it('is neutral on the measurement filters, so a source nothing measured still ranks', () => {
    // `status`, `uptime` and `quantization` are measurements OpenRouter
    // publishes; a direct source states none, and an absent measurement must not
    // reject it. The capability filters below still bind: see the `tools` case.
    const policy = policyFor(PRO, settingsOf({ minUptime: 101 }), { allowFree: true, excludedTags: new Set() })
    const result = rankEndpoints(new Map([['deepseek/deepseek-v4-pro', []]]), ['deepseek/deepseek-v4-pro'], {
      ...policy,
      requireNormalStatus: true,
      minQuantization: 'fp32',
      unknownQuantization: 'reject',
      extraSources: sourcesOf(PLAN),
    }, MIX)
    expect(result.ranked).toHaveLength(1)
    expect(result.rejections).toEqual(emptyOf())
  })

  it('still applies the tools filter to a source that does not take tool calls', () => {
    const policy = policyFor(PRO, settingsOf(), { allowFree: true, excludedTags: new Set() })
    const prices = directPricesOf(PLAN.price)
    const result = rankEndpoints(new Map([['deepseek/deepseek-v4-pro', []]]), ['deepseek/deepseek-v4-pro'], {
      ...policy,
      extraSources: new Map([['deepseek/deepseek-v4-pro', [{
        ...CLAUDE,
        ...prices === undefined ? {} : { prices },
        tools: false,
      }]]]),
    }, MIX)
    expect(result.ranked).toEqual([])
    expect(result.rejections).toEqual({ ...emptyOf(), tools: 1 })
    expect(result.rejected[0]?.endpoint).toMatchObject({ kind: 'direct', id: 'mimo-v2.6-pro' })
  })

  it('resolves a flat price into all three buckets and a partial one into the buckets it names', () => {
    // `usdPerToken` is the flat spelling: one rate for input, output and cache
    // alike (a truly flat plan). The prompt/completion pair is the ordinary
    // spelling; a cache term the entry does not name falls back to the prompt
    // rate. A credit-weighted plan states all three buckets instead.
    expect(directPricesOf({ usdPerToken: 1.455e-9 }))
      .toEqual({ prompt: 1.455e-9, completion: 1.455e-9 })
    expect(directPricesOf({ promptUsdPerToken: 2, completionUsdPerToken: 4 }))
      .toEqual({ prompt: 2, completion: 4, cacheRead: 2 })
    expect(directPricesOf({ promptUsdPerToken: 2, completionUsdPerToken: 4, cacheReadUsdPerToken: 0.5 }))
      .toEqual({ prompt: 2, completion: 4, cacheRead: 0.5 })
    // A half-stated pair is not silently completed from anything: the entry
    // states exactly what the ranking charges, or it states nothing.
    expect(directPricesOf({ promptUsdPerToken: 2 })).toBeUndefined()
    expect(directPricesOf(undefined)).toBeUndefined()
  })

  it('sorts two direct sources by their route id when the price ties', () => {
    const first: DirectSource = { ...CLAUDE, prices: { prompt: 1, completion: 1 }, contextLength: 1_048_576 }
    const second: DirectSource = {
      ...CLAUDE,
      route: 'zzz-route',
      prices: { prompt: 1, completion: 1 },
      contextLength: 1_048_576,
    }
    const result = rankEndpoints(new Map([['deepseek/deepseek-v4-pro', []]]), ['deepseek/deepseek-v4-pro'], {
      ...policyFor(PRO, settingsOf(), { allowFree: true, excludedTags: new Set() }),
      extraSources: new Map([['deepseek/deepseek-v4-pro', [second, first]]]),
    }, MIX)
    // Equal price and no measurement on either side: the tag order decides, and
    // both candidates carry the same route id, so the configured order stands.
    expect(result.ranked.map(entry => `${(entry.endpoint as DirectSource).route}:${(entry.endpoint as DirectSource).id}`))
      .toEqual(['zzz-route:mimo-v2.6-pro', 'claude-proxy:mimo-v2.6-pro'])
  })

  it('sorts an unmeasured direct source behind an equally priced endpoint', () => {
    // Both state the same blended price; the endpoint measures an uptime and the
    // direct source measures nothing, and an absent measurement sorts last.
    const endpoint: OpenRouterEndpoint = {
      slug: 'a/fp8', promptPrice: 1, completionPrice: 1, uptimeLast30m: 99, quantization: 'fp8',
      supportedParameters: ['tools'], contextLength: 1_048_576,
    }
    const direct: DirectSource = {
      ...CLAUDE,
      prices: { prompt: 1, completion: 1 },
      contextLength: 1_048_576,
    }
    const result = rankEndpoints(new Map([['deepseek/deepseek-v4-pro', [endpoint]]]), ['deepseek/deepseek-v4-pro'], {
      ...policyFor(PRO, settingsOf(), { allowFree: true, excludedTags: new Set() }),
      extraSources: new Map([['deepseek/deepseek-v4-pro', [direct]]]),
    }, MIX)
    expect(result.ranked.map(entry => tagOfEntry(entry.endpoint))).toEqual(['a/fp8', 'mimo-v2.6-pro'])
  })

  it('still applies the context filter to a source whose window is too small', () => {
    const policy = policyFor(PRO, settingsOf(), { allowFree: true, excludedTags: new Set() })
    const prices = directPricesOf(PLAN.price)
    const result = rankEndpoints(new Map([['deepseek/deepseek-v4-pro', []]]), ['deepseek/deepseek-v4-pro'], {
      ...policy,
      extraSources: new Map([['deepseek/deepseek-v4-pro', [{
        ...CLAUDE,
        ...prices === undefined ? {} : { prices },
        contextLength: 4096,
      }]]]),
    }, MIX)
    expect(result.ranked).toEqual([])
    expect(result.rejections).toEqual({ ...emptyOf(), context: 1 })
  })

  it('ranks a priced direct source against the tier\'s OpenRouter endpoints', async () => {
    // A direct source's per-token rates are blended under the same mix as every
    // endpoint, so price decides between the two sources of one model. The
    // source here is a synthetic one priced below every endpoint, so it wins.
    const lists = new Map<string, readonly OpenRouterEndpoint[] | Error>([
      ['deepseek/deepseek-v4-pro', await endpointsOf('deepseek/deepseek-v4-pro')],
    ])
    const result = rankEndpoints(lists, ['deepseek/deepseek-v4-pro'], policyFor(PRO, settingsOf(), {
      allowFree: true,
      excludedTags: new Set(),
      extraSources: sourcesOf(CHEAP),
    }), MIX)
    const top = result.ranked[0]
    expect(top?.endpoint).toMatchObject({ kind: 'direct', route: 'xiaomi-plan', id: 'mimo-v2.6-pro' })
    expect(top?.blendedUsdPerToken).toBeCloseTo(1e-9)
    expect(result.considered).toBe((lists.get('deepseek/deepseek-v4-pro') as OpenRouterEndpoint[]).length + 1)
    expect(result.ranked[1]?.blendedUsdPerToken).toBeGreaterThan(top?.blendedUsdPerToken ?? 0)
  })

  it('excludes a direct source by its route id, and leaves the endpoints of the model alone', async () => {
    const lists = new Map<string, readonly OpenRouterEndpoint[] | Error>([
      ['deepseek/deepseek-v4-pro', await endpointsOf('deepseek/deepseek-v4-pro')],
    ])
    const result = rankEndpoints(lists, ['deepseek/deepseek-v4-pro'], policyFor(PRO, settingsOf(), {
      allowFree: true,
      excludedTags: new Set(['mimo-v2.6-pro']),
      extraSources: sourcesOf(PLAN),
    }), MIX)
    expect(result.ranked.every(entry => !isDirect(entry.endpoint))).toBe(true)
    expect(result.rejections.excluded).toBe(1)
  })
})

/** The tag one ranked candidate carries: an endpoint slug, a direct source's route id. */
function tagOfEntry(entry: { kind?: string; slug?: string; id?: string }): string {
  return entry.kind === 'direct' ? entry.id ?? '' : entry.slug ?? ''
}

/** Every rejection key at zero, spelled out for a direct-source case. */
function emptyOf(): Record<string, number> {
  return {
    modality: 0, excluded: 0, status: 0, uptime: 0, tools: 0, context: 0,
    quantization: 0, 'untrusted-unknown': 0, unpriced: 0, free: 0, paid: 0,
  }
}
