import { describe, expect, it } from 'vitest'
import { assertServiceable, Config, resolveProfiles, type Options } from '../src/config.ts'

/** Validate one hand-declared route, with the caller's fields layered onto it. */
const routeWith = (profile: Record<string, unknown>): (() => unknown) =>
  () => ({ providers: Config({
    providers: {
      'acme-gateway': {
        api: 'openai-completions',
        baseURL: 'https://acme.test',
        models: [{ id: 'm' }],
        ...profile,
      },
    },
  }).providers.get() })

/** Validate that route with the caller's fields on its single model entry. */
const configWith = (model: Record<string, unknown>): (() => unknown) =>
  routeWith({ models: [{ id: 'm', ...model }] })

describe('reasoning schema boundary', () => {
  it('accepts an empty provider section and propagates unexpected catalog failures', () => {
    expect(() => { assertServiceable({}) }).not.toThrow()
    const failure = new TypeError('model metadata lookup failed')
    expect(() => resolveProfiles({ openrouter: { models: [{
      id: '111',
      get name(): string { throw failure },
    }], api: 'openai-completions' } }, 'deferred')).toThrow(failure)
  })

  it('rejects a level pi-ai does not know at the write that produced it', () => {
    expect(configWith({ reasoningEfforts: { ultra: 'x' } })).toThrow(/"off"/)
    expect(configWith({ reasoningEfforts: { high: 42 } })).toThrow()
  })

  it('keeps false distinguishable from an absent declaration', () => {
    type Materialized = { providers: Record<string, { models?: { reasoningEfforts?: unknown }[] }> }
    const withFalse = configWith({ reasoningEfforts: false })() as Materialized
    expect(withFalse.providers['acme-gateway']?.models?.[0]?.reasoningEfforts).toBe(false)
    const absent = configWith({})() as Materialized
    expect(absent.providers['acme-gateway']?.models?.[0]?.reasoningEfforts).toBeUndefined()
  })

  it('rejects a thinking format outside the offered set', () => {
    expect(configWith({ compat: { thinkingFormat: 'quantum' } })).toThrow(/expected/)
  })

  it('accepts Baseten template arguments and completion controls', () => {
    expect(configWith({
      compat: {
        supportsFinishReason: false,
        thinkingFormat: 'baseten',
        chatTemplateArgs: { enable_thinking: { $var: 'thinking.enabled' } },
        supportsThinkingTokenBudget: true,
      },
    })).not.toThrow()
  })
})

describe('modality schema boundary', () => {
  it('rejects a modality pi-ai does not know, at either level', () => {
    expect(configWith({ input: ['audio'] })).toThrow(/expected/)
    expect(routeWith({ defaultInput: ['text', 'audio'] })).toThrow(/expected/)
  })

  it('refuses a route whose models could accept nothing', () => {
    // The pair the settings seam runs: the schema accepts the empty list as
    // well-typed, and the namespace validator is what refuses it. Asserting
    // only the schema would report this route as writable.
    expect(routeWith({ defaultInput: [] })).not.toThrow()
    expect(() => { assertServiceable(routeWith({ defaultInput: [] })() as Options) })
      .toThrow(/defaultInput must name at least one modality/)
  })

  type Materialized = {
    providers: Record<string, { defaultInput?: unknown; models?: { input?: unknown }[] }>
  }

  it('materializes an absent entry list as empty and an absent route list as text', () => {
    // The empty-list inheritance rule exists because of exactly this: an entry
    // that declares nothing reaches resolution as `[]`, not as `undefined`.
    const absent = configWith({})() as Materialized
    expect(absent.providers['acme-gateway']?.models?.[0]?.input).toEqual([])
    expect(absent.providers['acme-gateway']?.defaultInput).toEqual(['text'])
  })
})

describe('rotating credentials', () => {
  const keysOf = (profile: Record<string, unknown>): readonly string[] | undefined => {
    const entries = { api: 'openai-completions', baseURL: 'https://acme.test', models: [{ id: 'm' }], ...profile }
    // A route naming several credentials must state its cooldown; the cases
    // below are about ordering, so they supply one they do not assert on.
    const credentialCount = new Set([...(profile.apiKeys as string[] ?? []), profile.apiKeyEnv].filter(
      (name): name is string => typeof name === 'string',
    )).size
    return resolveProfiles({ 'acme-gateway': credentialCount > 1 ? { keyCooldownMs: 60_000, ...entries } : entries })
      .get('acme-gateway')?.apiKeys
  }

  it('keeps apiKeyEnv working unchanged, as the whole list it already meant', () => {
    expect(keysOf({ apiKeyEnv: 'ACME_KEY' })).toEqual(['ACME_KEY'])
  })

  it('tries apiKeys in declared order, then appends apiKeyEnv last', () => {
    expect(keysOf({ apiKeys: ['B_KEY', 'A_KEY'] })).toEqual(['B_KEY', 'A_KEY'])
    expect(keysOf({ apiKeys: ['B_KEY', 'A_KEY'], apiKeyEnv: 'Z_KEY' })).toEqual(['B_KEY', 'A_KEY', 'Z_KEY'])
    // Already present, so the append is a no-op rather than a second attempt
    // at a key the list already carries.
    expect(keysOf({ apiKeys: ['B_KEY', 'A_KEY'], apiKeyEnv: 'B_KEY' })).toEqual(['B_KEY', 'A_KEY'])
  })

  it('refuses a repeated reference inside apiKeys, and a malformed one at either field', () => {
    expect(() => keysOf({ apiKeys: ['A_KEY', 'A_KEY'], keyCooldownMs: 1000 })).toThrow(/more than once/)
    expect(() => keysOf({ apiKeys: ['not-a-ref!'], keyCooldownMs: 1000 })).toThrow(/must match/)
    expect(() => keysOf({ apiKeyEnv: 'not-a-ref!' })).toThrow(/must match/)
  })

  it('keeps a profile naming no credential legal and keyless', () => {
    // An omitted apiKeys arrives as `[]`, so "no list" and "empty list" are one
    // value — and both mean the route defers to pi-ai's own ambient discovery.
    expect(keysOf({})).toEqual([])
    expect(keysOf({ apiKeys: [] })).toEqual([])
    const materialized = routeWith({})() as { providers: Record<string, { apiKeys?: unknown }> }
    expect(materialized.providers['acme-gateway']?.apiKeys).toEqual([])
  })

  it('carries the credential-ref role on the array element, not the array', () => {
    // Read from the schema node, because the role is presentation metadata a
    // configuration surface renders by: it never appears in a resolved value.
    const apiKeys = Config.dict?.providers?.inner?.dict?.apiKeys
    expect(apiKeys?.type).toBe('array')
    expect(apiKeys?.meta?.role).toBeUndefined()
    expect(apiKeys?.inner?.type).toBe('string')
    expect(apiKeys?.inner?.meta?.role).toBe('credential-ref')
  })

  it('requires keyCooldownMs exactly when rotation can happen', () => {
    // Rotation has nowhere to go without a second credential, so the interval
    // is refused rather than accepted as configuration that cannot act.
    expect(() => resolveProfiles({ 'acme-gateway': {
      api: 'openai-completions', baseURL: 'https://acme.test', models: [{ id: 'm' }], apiKeys: ['A_KEY'],
      keyCooldownMs: 1000,
    } })).toThrow(/names 1 credentials/)
    expect(() => resolveProfiles({ 'acme-gateway': {
      api: 'openai-completions', baseURL: 'https://acme.test', models: [{ id: 'm' }], apiKeyEnv: 'A_KEY',
      keyCooldownMs: 1000,
    } })).toThrow(/names 1 credentials/)
    // Two credentials and no interval cannot be defaulted: a built-in value
    // would be a hardcoded tunable deciding a deployment's key budget.
    expect(() => resolveProfiles({ 'acme-gateway': {
      api: 'openai-completions', baseURL: 'https://acme.test', models: [{ id: 'm' }],
      apiKeys: ['A_KEY', 'B_KEY'],
    } })).toThrow(/keyCooldownMs must/)
    expect(keysOf({ apiKeys: ['A_KEY', 'B_KEY'], keyCooldownMs: 60_000 })).toEqual(['A_KEY', 'B_KEY'])
  })

  it('resolves keyCooldownMs onto the profile and leaves it off a single-credential route', () => {
    const resolved = resolveProfiles({ 'acme-gateway': {
      api: 'openai-completions', baseURL: 'https://acme.test', models: [{ id: 'm' }],
      apiKeys: ['A_KEY', 'B_KEY'], keyCooldownMs: 5000,
    } }).get('acme-gateway')
    expect(resolved?.keyCooldownMs).toBe(5000)
    expect(resolved?.apiKeys).toEqual(['A_KEY', 'B_KEY'])
    const single = resolveProfiles({ 'acme-gateway': {
      api: 'openai-completions', baseURL: 'https://acme.test', models: [{ id: 'm' }], apiKeyEnv: 'A_KEY',
    } }).get('acme-gateway')
    expect(single?.keyCooldownMs).toBeUndefined()
    expect(single?.apiKeyEnv).toBe('A_KEY')
  })
})

describe('request image policy bounds', () => {
  it.each([
    ['requestImagePixelBudget', 0, /requestImagePixelBudget must be a positive safe integer/],
    ['requestImagePixelBudget', Number.MAX_SAFE_INTEGER + 1, /requestImagePixelBudget must be a positive safe integer/],
    ['requestImageMaxBytes', 0, /requestImageMaxBytes must be a positive safe integer/],
    ['requestImageMaxBytes', 1.5, /requestImageMaxBytes must be a positive safe integer/],
  ] as const)('rejects %s=%s at service resolution', (field, value, message) => {
    const programmatic = {
      providers: {
        'acme-gateway': {
          api: 'openai-completions',
          baseURL: 'https://acme.test',
          models: [{ id: 'm' }],
          [field]: value,
        },
      },
    } as Options
    expect(() => {
      assertServiceable(programmatic)
    }).toThrow(message)
  })
})
