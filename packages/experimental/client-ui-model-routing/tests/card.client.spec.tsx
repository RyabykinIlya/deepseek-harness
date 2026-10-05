// @vitest-environment jsdom
/** The model-routing settings page as the Plugins page renders it: a real DOM round trip. */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { ModelRoutingCard, type ModelRoutingCardProps } from '../src/client/ModelRoutingCard.tsx'
import type { ModelRoutingCardFace, ModelRoutingCardState, TierRow } from '../src/client/model-routing-card-controller.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t = (key: keyof typeof en, params?: Record<string, unknown>) =>
  en[key].replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = params?.[name]
    return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
  })

/** One tier row, as the controller's projection would hand it to the card. */
function tierRow(over: Partial<TierRow> = {}): TierRow {
  return {
    index: 0,
    name: 'flash',
    label: 'Flash',
    models: ['deepseek/deepseek-v4-flash'],
    contextWindow: 1_000_000,
    maxTokens: 32_768,
    input: ['text'],
    minQuantization: 'fp8',
    unknownQuantization: 'trusted',
    free: 'prefer',
    filter: '',
    dirty: false,
    contextWindowText: '1000000',
    maxTokensText: '32768',
    ...over,
  }
}

/** The whole card state, as the controller's projection would hand it to the renderer. */
function cardState(over: Partial<ModelRoutingCardState> = {}): ModelRoutingCardState {
  return {
    available: true,
    writable: true,
    dirty: false,
    invalid: false,
    saving: false,
    failed: false,
    view: 'full',
    tiers: [tierRow()],
    candidates: [],
    quotes: {},
    selectedTier: 0,
    conflicted: false,
    catalogStatus: 'ready',
    freeUsage: undefined,
    freeUsageKnown: false,
    judgeEnabled: true,
    defaultTier: 'flash',
    cacheIdleMinutes: 10,
    cacheIdleMinutesText: '10',
    freeForSubagents: false,
    trustedProvidersText: 'stealth',
    ...over,
  }
}

/**
 * Render the card over a staged state, with every face action wired to update
 * the store the way the real controller would — a spy alone would leave the
 * controlled inputs showing their original value after every `fireEvent`,
 * which would hide exactly the staging bugs these tests exist to catch.
 */
function renderCard(state: Partial<ModelRoutingCardState> = {}): ModelRoutingCardFace {
  const store = createSnapshotStore(cardState(state))
  const face: ModelRoutingCardFace = {
    hooks: { modelRoutingCard: store },
    setView: vi.fn(),
    selectTier: vi.fn((index: number) => { store.set({ ...store.getSnapshot(), selectedTier: index }) }),
    setFilter: vi.fn(),
    toggleModel: vi.fn(),
    setTierField: vi.fn((index: number, field: string, value: string) => {
      const snapshot = store.getSnapshot()
      if (field !== 'contextWindow' && field !== 'maxTokens') return
      const textField = field === 'contextWindow' ? 'contextWindowText' : 'maxTokensText'
      store.set({
        ...snapshot,
        tiers: snapshot.tiers.map((row, i) => i === index ? { ...row, [textField]: value } : row),
      })
    }),
    setTrustedProviders: vi.fn((value: string) => {
      store.set({ ...store.getSnapshot(), trustedProvidersText: value })
    }),
    setJudgeEnabled: vi.fn(),
    setDefaultTier: vi.fn(),
    setCacheIdleMinutes: vi.fn((value: string) => {
      store.set({ ...store.getSnapshot(), cacheIdleMinutesText: value })
    }),
    setFreeForSubagents: vi.fn(),
    retryCatalog: vi.fn(),
    save: vi.fn(),
    discard: vi.fn(),
  }
  const props = {
    ...face,
    view: 'full' as const,
    t,
    useModelRoutingCard: bindSnapshotSelector(store),
  } as unknown as ModelRoutingCardProps
  render(<ModelRoutingCard {...props} />)
  return face
}

describe('ModelRoutingCard', () => {
  it('shows exactly what was typed into the trusted-providers field, not a re-joined list', () => {
    renderCard()
    const input = screen.getByLabelText<HTMLInputElement>(en.trustedUnknownProviders)
    expect(input.value).toBe('stealth')

    fireEvent.change(input, { target: { value: 'stealth ' } })
    // The bug this guards against: a controller that re-derives the control's
    // value from `splitList(...).join(' ')` strips the trailing space the
    // instant it lands, so a re-render with the SAME staged text would snap
    // the field back to "stealth" and the next keystroke would be lost.
    expect(screen.getByLabelText<HTMLInputElement>(en.trustedUnknownProviders).value).toBe('stealth ')
  })

  it('shows exactly what was typed into a tier numeric field, including an empty or non-positive value', () => {
    const face = renderCard()
    const input = screen.getByLabelText<HTMLInputElement>(en.tierContextWindow)
    expect(input.value).toBe('1000000')

    fireEvent.change(input, { target: { value: '' } })
    expect(face.setTierField).toHaveBeenCalledWith(0, 'contextWindow', '')
    // The bug this guards against: a controller that resets a field it could
    // not parse leaves the control's value prop unchanged, and a controlled
    // input then snaps the DOM straight back to "1000000" — the person can
    // never see the field go blank to retype it.
    expect(screen.getByLabelText<HTMLInputElement>(en.tierContextWindow).value).toBe('')
  })

  it('shows exactly what was typed into the cache-idle-minutes field', () => {
    const face = renderCard()
    const input = screen.getByLabelText<HTMLInputElement>(en.cacheIdleMinutes)
    expect(input.value).toBe('10')

    fireEvent.change(input, { target: { value: '-5' } })
    expect(face.setCacheIdleMinutes).toHaveBeenCalledWith('-5')
    expect(screen.getByLabelText<HTMLInputElement>(en.cacheIdleMinutes).value).toBe('-5')
  })

  it('renders one tab per tier and switches the panel on click', () => {
    const face = renderCard({
      tiers: [tierRow({ index: 0, name: 'flash', label: 'Flash' }), tierRow({ index: 1, name: 'pro', label: 'Pro' })],
    })
    expect(screen.getByRole('tab', { name: 'Flash' })).toBeDefined()
    const proTab = screen.getByRole('tab', { name: 'Pro' })
    fireEvent.click(proTab)
    expect(face.selectTier).toHaveBeenCalledWith(1)
  })

  it('renders the full quantization choice list, not an empty select', () => {
    renderCard()
    const select = screen.getByLabelText<HTMLSelectElement>(en.tierMinQuantization)
    expect(Array.from(select.options).map(option => option.value)).toEqual([
      'int4', 'int8', 'fp4', 'mxfp4', 'nvfp4', 'fp6', 'fp8', 'mxfp8', 'fp16', 'bf16', 'fp32',
    ])
  })

  it('disables every control while the document is read-only, but keeps the tabs usable', () => {
    const face = renderCard({ writable: false })
    expect(screen.getByLabelText<HTMLInputElement>(en.trustedUnknownProviders).disabled).toBe(true)
    expect(screen.getByLabelText<HTMLInputElement>(en.tierContextWindow).disabled).toBe(true)
    const tab = screen.getByRole('tab', { name: 'Flash' })
    fireEvent.click(tab)
    expect(face.selectTier).toHaveBeenCalled()
  })

  it('renders only the one-liner in the summary view', () => {
    const store = createSnapshotStore(cardState())
    const props = {
      hooks: { modelRoutingCard: store },
      view: 'summary' as const,
      t,
      useModelRoutingCard: bindSnapshotSelector(store),
    } as unknown as ModelRoutingCardProps
    render(<ModelRoutingCard {...props} />)
    expect(document.body.textContent).toBe('1 tiers, 1 models')
    expect(screen.queryByLabelText(en.trustedUnknownProviders)).toBeNull()
  })
})
