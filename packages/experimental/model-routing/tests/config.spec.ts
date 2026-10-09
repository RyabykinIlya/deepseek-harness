import { describe, expect, it } from 'vitest'
import { Config, directSourceModels, readSettings, validateSettings } from '../src/config.ts'
import type { ExtraSource, RoutingSettings } from '../src/config.ts'

/** Default settings, with the case's overrides laid over them. */
function settings(over: Record<string, unknown> = {}): RoutingSettings {
  return readSettings(Config({ ...over }))
}

/** One servable tier, spelled out so each case changes exactly one field. */
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
} as const

describe('model-routing default configuration', () => {
  it('passes its own validation', () => {
    expect(() =>{  validateSettings(settings()) }).not.toThrow()
  })

  it('leaves the route dormant with no tiers', () => {
    const value = settings()
    expect(value.tiers).toEqual([])
    expect(value.judgeModel).toBe('typesafe/jev-1.13')
  })

  it('fills a tier\'s optional fields', () => {
    // A tier is written by a person in a YAML row, where an optional field is
    // simply absent; the schema, not the test, supplies the defaults.
    const { input: _omitted, minQuantization: _floor, unknownQuantization: _unknown, free: _free, ...stated } = PRO
    const value = settings({ tiers: [stated] })
    expect(value.tiers[0]).toMatchObject({
      input: ['text'],
      minQuantization: 'fp8',
      unknownQuantization: 'trusted',
      free: 'off',
    })
  })
})

describe('model-routing settings validation', () => {
  it('refuses a tier name that is not a route model id', () => {
    expect(() =>{  validateSettings(settings({ tiers: [{ ...PRO, name: 'Pro' }] })) })
      .toThrow('model-routing: tier name "Pro" must match ^[a-z][a-z0-9-]*$ and must not be "auto"')
    expect(() =>{  validateSettings(settings({ tiers: [{ ...PRO, name: 'auto' }] })) })
      .toThrow('model-routing: tier name "auto" must match ^[a-z][a-z0-9-]*$ and must not be "auto"')
  })

  it('refuses a repeated tier name', () => {
    expect(() =>{  validateSettings(settings({ tiers: [{ ...PRO }, { ...PRO }] })) })
      .toThrow('model-routing: tier name "pro" is used twice')
  })

  it('refuses a tier with no models', () => {
    expect(() =>{  validateSettings(settings({ tiers: [{ ...PRO, models: [] }] })) })
      .toThrow('model-routing: tier "pro" lists no models')
  })

  it('refuses a model id that is not `author/slug` or that repeats', () => {
    expect(() =>{  validateSettings(settings({ tiers: [{ ...PRO, models: ['deepseek-v4-pro'] }] })) })
      .toThrow('model-routing: tier "pro" model "deepseek-v4-pro" must be an OpenRouter id author/slug and appear once')
    expect(() =>{  validateSettings(settings({
      tiers: [{ ...PRO, models: ['deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4-pro'] }],
    })) }).toThrow('model-routing: tier "pro" model "deepseek/deepseek-v4-pro" must be an OpenRouter id author/slug and appear once')
  })

  it('refuses a non-positive or fractional capacity', () => {
    expect(() =>{  validateSettings(settings({ tiers: [{ ...PRO, contextWindow: 0 }] })) })
      .toThrow('model-routing: tier "pro" contextWindow must be a positive integer')
    expect(() =>{  validateSettings(settings({ tiers: [{ ...PRO, maxTokens: 1.5 }] })) })
      .toThrow('model-routing: tier "pro" maxTokens must be a positive integer')
  })

  it('refuses a trusted `unknown` with an empty trust list', () => {
    expect(() =>{  validateSettings(settings({
      tiers: [{ ...PRO, unknownQuantization: 'trusted' }],
      trustedUnknownProviders: [],
    })) }).toThrow('model-routing: tier "pro" trusts unknown quantization but trustedUnknownProviders is empty')
  })

  it('refuses an empty or duplicated effort list', () => {
    expect(() =>{  validateSettings(settings({ efforts: [] })) })
      .toThrow('model-routing: efforts must be a non-empty list of unique ids')
    expect(() =>{  validateSettings(settings({ efforts: ['low', 'low'], defaultEffort: 'low' })) })
      .toThrow('model-routing: efforts must be a non-empty list of unique ids')
  })

  it('refuses a default effort outside the list', () => {
    expect(() =>{  validateSettings(settings({ defaultEffort: 'xhigh' })) })
      .toThrow('model-routing: defaultEffort "xhigh" is not in efforts')
  })

  it('refuses a tier reference that names no configured tier', () => {
    // The defaults point at `flash`, which only `pro` exists to invalidate.
    const configured = { tiers: [{ ...PRO }], defaultTier: 'pro', judgeProTier: 'pro', judgeFlashTier: 'pro' }
    expect(() =>{  validateSettings(settings({ ...configured, defaultTier: 'nope' })) })
      .toThrow('model-routing: defaultTier "nope" is not a configured tier')
    expect(() =>{  validateSettings(settings({ ...configured, judgeProTier: 'nope' })) })
      .toThrow('model-routing: judgeProTier "nope" is not a configured tier')
    expect(() =>{  validateSettings(settings({ ...configured, judgeFlashTier: 'nope' })) })
      .toThrow('model-routing: judgeFlashTier "nope" is not a configured tier')
    expect(() =>{  validateSettings(settings({ ...configured, presetRoutes: [{ preset: 'project', model: 'nope' }] })) })
      .toThrow('model-routing: presetRoutes[].model "nope" is not a configured tier')
  })

  it('accepts `auto` as a preset route and a real tier for the rest', () => {
    const configured = {
      tiers: [{ ...PRO }],
      defaultTier: 'pro',
      judgeProTier: 'pro',
      judgeFlashTier: 'pro',
    }
    expect(() =>{  validateSettings(settings({ ...configured, presetRoutes: [{ preset: 'project', model: 'auto' }] })) })
      .not.toThrow()
    expect(() =>{  validateSettings(settings(configured)) }).not.toThrow()
  })

  it('skips tier references while no tier is configured', () => {
    expect(() =>{  validateSettings(settings({ defaultTier: 'nope', judgeProTier: 'nope' })) }).not.toThrow()
  })

  it('refuses judge thresholds outside [0, 1] or an inverted pair', () => {
    expect(() =>{  validateSettings(settings({ judgeStartProAt: 1.5 })) })
      .toThrow('model-routing: judge thresholds must lie in [0, 1] with judgeToFlashAt < judgeToProAt')
    expect(() =>{  validateSettings(settings({ judgeToFlashAt: 0.9 })) })
      .toThrow('model-routing: judge thresholds must lie in [0, 1] with judgeToFlashAt < judgeToProAt')
  })

  it('refuses a mix that is negative or sums to zero', () => {
    expect(() =>{  validateSettings(settings({ mixCached: -0.1 })) })
      .toThrow('model-routing: mixCached, mixFresh and mixOutput must be non-negative with a positive sum')
    expect(() =>{  validateSettings(settings({ mixCached: 0, mixFresh: 0, mixOutput: 0 })) })
      .toThrow('model-routing: mixCached, mixFresh and mixOutput must be non-negative with a positive sum')
  })

  it('refuses a negative or fractional reroute budget', () => {
    expect(() =>{  validateSettings(settings({ maxReroutes: -1 })) })
      .toThrow('model-routing: maxReroutes must be a non-negative integer')
    expect(() =>{  validateSettings(settings({ maxReroutes: 1.5 })) })
      .toThrow('model-routing: maxReroutes must be a non-negative integer')
  })

  it('refuses a diagnostics budget that is zero or fractional', () => {
    expect(() =>{  validateSettings(settings({ diagnosticsMaxBytes: 0 })) })
      .toThrow('model-routing: diagnosticsMaxBytes must be a positive integer')
    expect(() =>{  validateSettings(settings({ diagnosticsMaxBytes: 1.5 })) })
      .toThrow('model-routing: diagnosticsMaxBytes must be a positive integer')
  })
})

describe('tier extraSources', () => {
  /** One source that serves the pro model under its own route id. */
  const CLAUDE: ExtraSource = {
    route: 'claude-proxy',
    models: [],
    modelMap: { 'deepseek/deepseek-v4-pro': 'mimo-v2.6-pro' },
    price: {},
    tools: true,
  }

  it('accepts a source and reads its candidates back', () => {
    // The judge's defaults name `flash`; a single-tier case points every tier
    // reference at `pro` so validation reaches the source at all.
    const value = settings({
      tiers: [{ ...PRO, extraSources: [CLAUDE] }],
      defaultTier: 'pro', judgeProTier: 'pro', judgeFlashTier: 'pro',
    })
    expect(() => { validateSettings(value) }).not.toThrow()
    expect(directSourceModels(value.tiers[0]!.extraSources[0]!)).toEqual([
      { model: 'deepseek/deepseek-v4-pro', id: 'mimo-v2.6-pro' },
    ])
  })

  it('carries a source-wide price and a per-model one, in that precedence', () => {
    const priced: ExtraSource = { ...CLAUDE, price: { usdPerToken: 1e-7 } }
    expect(directSourceModels(priced)).toEqual([
      { model: 'deepseek/deepseek-v4-pro', id: 'mimo-v2.6-pro', price: { usdPerToken: 1e-7 } },
    ])
    const own: ExtraSource = {
      ...priced,
      modelMap: { 'deepseek/deepseek-v4-pro': 'mimo-v2.6-pro@{"usdPerToken":1.455e-9}' },
    }
    expect(directSourceModels(own)).toEqual([
      { model: 'deepseek/deepseek-v4-pro', id: 'mimo-v2.6-pro', price: { usdPerToken: 1.455e-9 } },
    ])
  })

  it('lists `models` entries under their own id', () => {
    const value = settings({ tiers: [{ ...PRO, extraSources: [{ ...CLAUDE, models: ['claude/opus-4.6'] }] }] })
    expect(directSourceModels(value.tiers[0]!.extraSources[0]!)).toEqual([
      { model: 'claude/opus-4.6', id: 'claude/opus-4.6' },
      { model: 'deepseek/deepseek-v4-pro', id: 'mimo-v2.6-pro' },
    ])
  })

  it('refuses a source with an empty route key or no models', () => {
    expect(() => { validateSettings(settings({ tiers: [{ ...PRO, extraSources: [{ ...CLAUDE, route: ' ' }] }] })) })
      .toThrow('model-routing: tier "pro" extraSource route must be a non-empty route key')
    expect(() => {
      validateSettings(settings({
        tiers: [{ ...PRO, extraSources: [{ route: 'claude-proxy', models: [], modelMap: {}, price: {} }] }],
      }))
    }).toThrow('model-routing: tier "pro" extraSource "claude-proxy" names no models')
  })

  it('refuses an empty id, a repeated one, and an empty map key', () => {
    expect(() => {
      validateSettings(settings({ tiers: [{ ...PRO, extraSources: [{ ...CLAUDE, models: [''] }] }] }))
    }).toThrow('model-routing: tier "pro" extraSource "claude-proxy" model must be a non-empty id')
    expect(() => {
      validateSettings(settings({
        tiers: [{ ...PRO, extraSources: [{ ...CLAUDE, models: ['z-ai/glm-5.3', 'z-ai/glm-5.3'] }] }],
      }))
    }).toThrow(
      'model-routing: tier "pro" extraSource "claude-proxy" model "z-ai/glm-5.3"'
      + ' appears twice in the tier\'s sources',
    )
    expect(() => {
      validateSettings(settings({ tiers: [{ ...PRO, extraSources: [{ ...CLAUDE, modelMap: { '': 'x' } }] }] }))
    }).toThrow('model-routing: tier "pro" extraSource "claude-proxy" modelMap key must be a non-empty canonical id')
    expect(() => {
      validateSettings(settings({ tiers: [{ ...PRO, extraSources: [{ ...CLAUDE, modelMap: { 'deepseek/deepseek-v4-pro': '' } }] }] }))
    }).toThrow('model-routing: tier "pro" extraSource "claude-proxy" modelMap["deepseek/deepseek-v4-pro"] must be a non-empty route id')
  })

  it('accepts two sources serving one canonical id, and refuses one source naming it twice', () => {
    // Two sources of one model rank against each other; the ambiguity worth
    // refusing is a single source naming the same canonical id twice.
    const two = settings({
      tiers: [{ ...PRO, extraSources: [CLAUDE, { ...CLAUDE, route: 'xiaomi-plan' }] }],
      defaultTier: 'pro', judgeProTier: 'pro', judgeFlashTier: 'pro',
    })
    expect(() => { validateSettings(two) }).not.toThrow()
    expect(() => {
      validateSettings(settings({
        tiers: [{
          ...PRO,
          extraSources: [{ ...CLAUDE, modelMap: { 'deepseek/deepseek-v4-pro': 'a', 'z-ai/glm-5.3': 'b' } }],
        }],
        defaultTier: 'pro', judgeProTier: 'pro', judgeFlashTier: 'pro',
      }))
    }).not.toThrow()
    expect(() => {
      validateSettings(settings({
        tiers: [{
          ...PRO,
          extraSources: [{ ...CLAUDE, models: ['deepseek/deepseek-v4-pro'], modelMap: { 'deepseek/deepseek-v4-pro': 'm' } }],
        }],
      }))
    }).toThrow(
      'model-routing: tier "pro" extraSource "claude-proxy" modelMap["deepseek/deepseek-v4-pro"]'
      + ' names a model this source already serves',
    )
  })

  it('refuses a price object that is not one, and a negative price', () => {
    expect(() => {
      validateSettings(settings({
        tiers: [{ ...PRO, extraSources: [{ ...CLAUDE, modelMap: { 'deepseek/deepseek-v4-pro': 'm@nope' } }] }],
      }))
    }).toThrow(
      'model-routing: tier "pro" extraSource "claude-proxy" modelMap["deepseek/deepseek-v4-pro"]'
      + ' price must be a JSON object',
    )
    expect(() => {
      validateSettings(settings({
        tiers: [{ ...PRO, extraSources: [{ ...CLAUDE, modelMap: { 'deepseek/deepseek-v4-pro': 'm@{"usdPerToken":-1}' } }] }],
      }))
    }).toThrow(
      'model-routing: tier "pro" extraSource "claude-proxy" modelMap["deepseek/deepseek-v4-pro"]'
      + ' price must be a JSON object of the price fields with non-negative numbers',
    )
    expect(() => {
      validateSettings(settings({ tiers: [{ ...PRO, extraSources: [{ ...CLAUDE, price: { usdPerToken: -1 } }] }] }))
    }).toThrow('model-routing: tier "pro" extraSource "claude-proxy" price usdPerToken must be a non-negative number')
  })

  it('refuses a price object with an unknown field, and one whose number is missing', () => {
    expect(() => {
      validateSettings(settings({
        tiers: [{ ...PRO, extraSources: [{ ...CLAUDE, modelMap: { 'deepseek/deepseek-v4-pro': 'm@{"tokens":1}' } }] }],
        defaultTier: 'pro', judgeProTier: 'pro', judgeFlashTier: 'pro',
      }))
    }).toThrow(
      'model-routing: tier "pro" extraSource "claude-proxy" modelMap["deepseek/deepseek-v4-pro"]'
      + ' price must be a JSON object of the price fields with non-negative numbers',
    )
    expect(() => {
      validateSettings(settings({
        tiers: [{ ...PRO, extraSources: [{ ...CLAUDE, modelMap: { 'deepseek/deepseek-v4-pro': 'm@{"usdPerToken":null}' } }] }],
        defaultTier: 'pro', judgeProTier: 'pro', judgeFlashTier: 'pro',
      }))
    }).toThrow(
      'model-routing: tier "pro" extraSource "claude-proxy" modelMap["deepseek/deepseek-v4-pro"]'
      + ' price must be a JSON object of the price fields with non-negative numbers',
    )
    // An array is a JSON value but not a price object.
    expect(() => {
      validateSettings(settings({
        tiers: [{ ...PRO, extraSources: [{ ...CLAUDE, modelMap: { 'deepseek/deepseek-v4-pro': 'm@[1]' } }] }],
        defaultTier: 'pro', judgeProTier: 'pro', judgeFlashTier: 'pro',
      }))
    }).toThrow(
      'model-routing: tier "pro" extraSource "claude-proxy" modelMap["deepseek/deepseek-v4-pro"]'
      + ' price must be a JSON object',
    )
  })

  it('carries a source-wide KEY_QUOTA reroute code in the defaults', () => {
    expect(settings().rerouteCodes).toEqual(['RATE_LIMIT', 'SERVER', 'TRANSPORT', 'TIMEOUT', 'PI_AI_ERROR', 'KEY_QUOTA', 'CLIENT_GATE'])
  })
})
