/** The staged model-routing card: what it drafts, what it writes, and what it refuses. */

import { describe, expect, it, vi } from 'vitest'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import { RemoteError, stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import {
  ModelRoutingCardController,
  pricePerMillion,
  quoteRow,
  quoteRowKey,
  splitList,
  type ModelRoutingSettings,
} from '../src/client/model-routing-card-controller.ts'

const TIERS: ModelRoutingSettings['tiers'] = [
  {
    name: 'flash',
    label: 'Flash',
    models: ['deepseek/deepseek-v4-flash'],
    contextWindow: 1_000_000,
    maxTokens: 32_768,
    input: ['text'],
    minQuantization: 'fp8',
    unknownQuantization: 'trusted',
    free: 'prefer',
  },
]

/** A form stub that already holds a writable value, as a served namespace does. */
function ready(value: Partial<ModelRoutingSettings> & { tiers: ModelRoutingSettings['tiers'] }) {
  const host = stubConfigForm<ModelRoutingSettings>()
  host.publish({ status: 'ready', value: value as ModelRoutingSettings, writable: true, revision: 0 })
  return host
}

/** Make the stub behave like a Host that accepts every write. */
function acceptWrites<T>(host: ReturnType<typeof stubConfigForm<T>>): void {
  const section = (): Record<string, unknown> => ({ ...host.scope.getSnapshot().value as object })
  host.mutate.mockImplementation((ops: readonly SettingsPathOpView[]) => {
    const value = section()
    for (const op of ops) {
      if (op.op === 'set') value[op.path[0]!] = op.value
    }
    host.publish({ value: value as T, user: value })
    return Promise.resolve(true)
  })
}

/** A controller over a stub form, with the Remote scripted. */
function controller(over: {
  quote?: ReturnType<typeof vi.fn>
  catalog?: readonly { id: string; name: string; models: readonly { id: string; name: string }[] }[]
  value?: ModelRoutingSettings
} = {}) {
  const host = ready({
    tiers: TIERS,
    judgeEnabled: true,
    defaultTier: 'flash',
    cacheIdleMs: 600_000,
    freeForSubagents: false,
    trustedUnknownProviders: ['stealth'],
    ...over.value,
  })
  acceptWrites(host)
  const quote = over.quote ?? vi.fn(() => Promise.resolve({ ok: true, value: [] }))
  const ctx = {
    remote: {
      session: { modelCatalog: () => Promise.resolve({ ok: true, value: { groups: over.catalog ?? [], failures: [] } }) },
      modelRouting: { quote, freeUsage: () => Promise.resolve({ ok: true, value: null }) },
    },
  } as never
  return { card: new ModelRoutingCardController(host.scope, ctx), host, quote }
}

describe('staging a tier', () => {
  it('prices the models the draft selects and writes them as one mutation', async () => {
    const quote = vi.fn(() => Promise.resolve({
      ok: true,
      value: [{
        model: 'deepseek/deepseek-v4-flash',
        endpoint: { tag: 'streamlake/fp8', quantization: 'fp8', promptUsd: 1e-8, completionUsd: 2e-8 },
        blendedUsdPerToken: 8.4e-9,
        eligible: 10,
        total: 16,
      }],
    }))
    const { card, host } = controller({ quote })
    await vi.waitFor(() => { expect(card.inject().hooks.modelRoutingCard.getSnapshot().catalogStatus).toBe('ready') })

    const face = card.inject()
    face.toggleModel(0, 'z-ai/glm-5.3-flash')
    expect(host.mutate).not.toHaveBeenCalled()

    face.save()
    await Promise.resolve()
    await vi.waitFor(() => { expect(host.mutate).toHaveBeenCalledTimes(1) })
    const ops = host.mutate.mock.calls[0]![0]
    expect(ops.map(op => op.path.join('.'))).toEqual([
      'tiers', 'judgeEnabled', 'defaultTier', 'cacheIdleMs', 'freeForSubagents', 'trustedUnknownProviders',
    ])
    const tiers = (ops[0] as { value: unknown }).value as ModelRoutingSettings['tiers']
    expect(tiers[0]?.models).toEqual(['deepseek/deepseek-v4-flash', 'z-ai/glm-5.3-flash'])
    expect(host.mutate.mock.calls[0]![1]).toBe(0)
    // Every tier with models is priced, so the page shows a price per selection.
    expect(quote).toHaveBeenCalledWith({ tier: 'flash', models: ['deepseek/deepseek-v4-flash', 'z-ai/glm-5.3-flash'] })
  })

  it('refuses to write a draft the Host changed underneath', async () => {
    const { card, host } = controller()
    const face = card.inject()
    face.setJudgeEnabled(false)
    host.publish({
      value: { ...(host.scope.getSnapshot().value as ModelRoutingSettings) },
      revision: 7,
    })
    face.save()
    await Promise.resolve()
    await vi.waitFor(() => {
      expect(card.inject().hooks.modelRoutingCard.getSnapshot().conflicted).toBe(true)
    })
    expect(host.mutate).not.toHaveBeenCalled()
  })

  it('discards back to the stored value', async () => {
    const { card, host } = controller()
    const face = card.inject()
    face.setJudgeEnabled(false)
    expect(card.inject().hooks.modelRoutingCard.getSnapshot().dirty).toBe(true)
    face.discard()
    expect(card.inject().hooks.modelRoutingCard.getSnapshot().dirty).toBe(false)
    expect(host.mutate).not.toHaveBeenCalled()
  })

  it('stops observing after disposal', async () => {
    const { card, host } = controller()
    card.dispose()
    card.inject().setJudgeEnabled(false)
    expect(host.mutate).not.toHaveBeenCalled()
  })
})

describe('the catalog', () => {
  it('offers only the inner route\'s models and filters them by substring', async () => {
    const { card } = controller({
      catalog: [
        { id: 'openrouter', name: 'OpenRouter', models: [{ id: 'deepseek/deepseek-v4-flash', name: 'DS Flash' }, { id: 'z-ai/glm-5.3', name: 'GLM 5.3' }] },
        { id: 'other', name: 'Other', models: [{ id: 'anthropic/claude-x', name: 'Claude' }] },
      ],
    })
    await vi.waitFor(() => { expect(card.inject().hooks.modelRoutingCard.getSnapshot().catalogStatus).toBe('ready') })
    const face = card.inject()
    expect(face.hooks.modelRoutingCard.getSnapshot().candidates.map(row => row.model))
      .toEqual(['deepseek/deepseek-v4-flash', 'z-ai/glm-5.3'])
    face.setFilter(0, 'glm')
    expect(face.hooks.modelRoutingCard.getSnapshot().candidates.map(row => row.model)).toEqual(['z-ai/glm-5.3'])
  })

  it('marks the models the tier already selects', async () => {
    const { card } = controller({
      catalog: [{ id: 'openrouter', name: 'OpenRouter', models: [{ id: 'deepseek/deepseek-v4-flash', name: 'DS Flash' }] }],
    })
    await vi.waitFor(() => { expect(card.inject().hooks.modelRoutingCard.getSnapshot().catalogStatus).toBe('ready') })
    expect(card.inject().hooks.modelRoutingCard.getSnapshot().candidates[0]?.selected).toBe(true)
  })
})

describe('the formatting helpers', () => {
  it('renders a per-million price with three significant figures', () => {
    // USD per token times a million tokens: StreamLake's flash endpoint is
    // $0.0084 per million of the mix, GLM 5.3's is $0.13.
    expect(pricePerMillion(8.4e-9)).toBe('0.00840')
    expect(pricePerMillion(0)).toBe('0')
    expect(pricePerMillion(1.302e-7)).toBe('0.130')
  })

  it('projects a quote into a row, and marks a failed one unavailable', () => {
    expect(quoteRow({
      model: 'm',
      endpoint: { tag: 'streamlake/fp8', quantization: 'fp8', promptUsd: 0, completionUsd: 0 },
      blendedUsdPerToken: 8.4e-9,
      eligible: 1,
      total: 1,
    })).toEqual({ model: 'm', text: 'streamlake/fp8 · fp8 · 0.00840', unavailable: false })
    expect(quoteRow({ model: 'm', eligible: 0, total: 0, error: 'HTTP 503' }))
      .toEqual({ model: 'm', text: 'HTTP 503', unavailable: true })
    expect(quoteRowKey('flash', { model: 'm', eligible: 0, total: 0 })).toBe('flash m')
  })

  it('splits a provider list on commas and whitespace', () => {
    expect(splitList('a, b  c,,')).toEqual(['a', 'b', 'c'])
    expect(splitList('   ')).toEqual([])
  })

  it('reports a failed catalog rather than an empty one', async () => {
    const host = ready({
      tiers: TIERS, judgeEnabled: true, defaultTier: 'flash', cacheIdleMs: 600_000,
      freeForSubagents: false, trustedUnknownProviders: [],
    })
    const ctx = {
      remote: {
        session: { modelCatalog: () => Promise.resolve({ ok: false, error: new RemoteError('gateway/internal', 'down', {}) }) },
        modelRouting: { quote: vi.fn(), freeUsage: () => Promise.resolve({ ok: true, value: null }) },
      },
    } as never
    const card = new ModelRoutingCardController(host.scope, ctx)
    await vi.waitFor(() => { expect(card.inject().hooks.modelRoutingCard.getSnapshot().catalogStatus).toBe('error') })
  })
})
