import { describe, expect, it } from 'vitest'
import type { OpenRouterEndpoint } from '@deepseek-ai/dsh-llm-pi-ai'
import { Config, readSettings } from '../src/config.ts'
import type { RoutingSettings, TierSettings } from '../src/config.ts'
import { quantizationsAtOrAbove } from '../src/quantization.ts'
import {
  blendedPrice,
  defaultMix,
  mixFromUsage,
  policyFor,
  rankEndpoints,
  rankWithRelaxation,
  type EndpointLists,
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
  options: { allowFree?: boolean; excludedTags?: string[]; preferModel?: string } = {},
): Promise<{ length: number; top: string[]; rejections: Record<string, number> }> {
  const lists = await listsOf(tier.models)
  const result = rankEndpoints(
    lists,
    tier.models,
    policyFor(tier, settings, {
      allowFree: options.allowFree ?? true,
      excludedTags: new Set(options.excludedTags ?? []),
      ...options.preferModel === undefined ? {} : { preferModel: options.preferModel },
    }),
    MIX,
  )
  return {
    length: result.ranked.length,
    top: result.ranked.slice(0, 4).map(entry => `${entry.model} ${entry.endpoint.slug}=${entry.blendedUsdPerToken}`),
    rejections: Object.fromEntries(Object.entries(result.rejections).filter(([, count]) => count > 0)),
  }
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

describe('the turn mix', () => {
  it('normalizes the configured weights', () => {
    expect(defaultMix(settingsOf())).toEqual(MIX)
    expect(defaultMix(settingsOf({ mixCached: 4, mixFresh: 4, mixOutput: 2 })))
      .toEqual({ cached: 0.4, fresh: 0.4, output: 0.2 })
  })

  it('believes measured usage above the floor and the default below it', () => {
    const measured = { uncachedInputTokens: 100, outputTokens: 100, cacheReadTokens: 800, cacheWriteTokens: 0 }
    expect(mixFromUsage(measured, MIX, 1000)).toEqual({ cached: 0.8, fresh: 0.1, output: 0.1 })
    expect(mixFromUsage({ ...measured, cacheReadTokens: 799 }, MIX, 1000)).toEqual(MIX)
    expect(mixFromUsage(undefined, MIX, 1000)).toEqual(MIX)
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
