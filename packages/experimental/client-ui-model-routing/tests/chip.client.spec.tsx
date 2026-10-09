// @vitest-environment jsdom
/** The composer chip as the input bar renders it: a tier, a model, and a tooltip. */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ModelSelectionProjection } from '@deepseek-ai/dsh-api-session-controller/types'
import type { ModelRoutingView } from '@deepseek-ai/dsh-experimental-model-routing/client'
import { ModelRoutingChip, pendingModel, shortModel } from '../src/client/ModelRoutingChip.tsx'
import type { ModelRoutingChipProps } from '../src/client/ModelRoutingChip.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t = ((key: string, params?: Record<string, unknown>) => {
  const template = (en as Record<string, string>)[key] ?? key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = params[name]
    return typeof value === 'string' ? value : `{${name}}`
  })
}) as ModelRoutingChipProps['t']

/** Render the chip over one published routing value and one selection value. */
function chip(view: ModelRoutingView | null | undefined, selection?: ModelSelectionProjection | null) {
  const useProjection = ((key: string) => key === 'modelRouting' ? view : selection) as unknown as ModelRoutingChipProps['useProjection']
  return render(
    <ModelRoutingChip
      {...({ useProjection } as unknown as ModelRoutingChipProps)}
      t={t}
    />,
  )
}

const DECIDED: ModelRoutingView = {
  requested: 'auto',
  tier: 'flash',
  model: 'deepseek/deepseek-v4-flash',
  providerName: 'StreamLake',
  quantization: 'fp8',
  boundary: 'start',
  decidedAt: 1,
  unpinned: false,
}

/** A selection projection whose next request would ask for a different model. */
const WAITING: ModelSelectionProjection = {
  lastUsed: { provider: 'tiers', model: 'auto' },
  next: { provider: 'tiers', model: 'deepseek/deepseek-v4.1-flash', reasoningEffort: 'high' },
}

describe('ModelRoutingChip', () => {
  it('names the tier and the model, with the provider and quantization in the tooltip', () => {
    chip(DECIDED)
    const element = screen.getByTestId('model-routing-chip')
    expect(element.textContent).toBe('flash · deepseek-v4-flash')
    const title = element.getAttribute('title')
    expect(title).toContain('deepseek/deepseek-v4-flash')
    expect(title).toContain('StreamLake')
    expect(title).toContain('fp8')
    expect(title).toContain('session start')
  })

  it('names the waiting model after an arrow and says so in the tooltip', () => {
    chip(DECIDED, WAITING)
    const element = screen.getByTestId('model-routing-chip')
    expect(element.textContent).toBe('flash · deepseek-v4-flash → deepseek-v4.1-flash')
    expect(element.getAttribute('title')).toContain('next request: deepseek/deepseek-v4.1-flash')
  })

  it('names one model when the selection asks for what the decision already requested', () => {
    chip(DECIDED, { lastUsed: { provider: 'tiers', model: 'auto' }, next: { provider: 'tiers', model: 'auto' } })
    const element = screen.getByTestId('model-routing-chip')
    expect(element.textContent).toBe('flash · deepseek-v4-flash')
    expect(element.getAttribute('title')).not.toContain('next request')
  })

  it('names one model when no selection projection is served', () => {
    chip(DECIDED, undefined)
    expect(screen.getByTestId('model-routing-chip').textContent).toBe('flash · deepseek-v4-flash')
    cleanup()
    chip(DECIDED, null)
    expect(screen.getByTestId('model-routing-chip').textContent).toBe('flash · deepseek-v4-flash')
  })

  it('says the provider is unpinned when the decision pinned none', () => {
    const { providerName: _omitted, ...withoutProvider } = DECIDED
    chip({ ...withoutProvider, unpinned: true })
    expect(screen.getByTestId('model-routing-chip').getAttribute('title'))
      .toContain('no provider pinned')
  })

  it('shows an unknown quantization as a question mark rather than a blank', () => {
    const { quantization: _omitted, ...withoutQuantization } = DECIDED
    chip(withoutQuantization)
    expect(screen.getByTestId('model-routing-chip').getAttribute('title')).toContain('?')
  })

  it('renders nothing before the first decision', () => {
    chip(null)
    expect(screen.queryByTestId('model-routing-chip')).toBeNull()
    cleanup()
    chip(undefined)
    expect(screen.queryByTestId('model-routing-chip')).toBeNull()
  })

  it('renders a tier it has no translation for under its own name', () => {
    chip({ ...DECIDED, tier: 'turbo' })
    expect(screen.getByTestId('model-routing-chip').textContent).toBe('turbo · deepseek-v4-flash')
  })
})

describe('pendingModel', () => {
  it('returns the model a waiting selection would apply', () => {
    expect(pendingModel('auto', WAITING)).toBe('deepseek/deepseek-v4.1-flash')
  })

  it('returns nothing when the selection matches the decision request', () => {
    expect(pendingModel('auto', { lastUsed: null, next: { provider: 'tiers', model: 'auto' } })).toBeUndefined()
  })

  it('returns nothing without a selection projection or without a next value', () => {
    expect(pendingModel('auto', undefined)).toBeUndefined()
    expect(pendingModel('auto', { lastUsed: null, next: null })).toBeUndefined()
  })
})

describe('shortModel', () => {
  it('drops the author prefix and leaves a bare id alone', () => {
    expect(shortModel('deepseek/deepseek-v4-flash')).toBe('deepseek-v4-flash')
    expect(shortModel('stealth')).toBe('stealth')
  })
})
