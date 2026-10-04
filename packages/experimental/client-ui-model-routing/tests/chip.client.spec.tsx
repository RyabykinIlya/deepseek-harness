// @vitest-environment jsdom
/** The composer chip as the input bar renders it: a tier, a model, and a tooltip. */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ModelRoutingView } from '@deepseek-ai/dsh-experimental-model-routing/client'
import { ModelRoutingChip, shortModel } from '../src/client/ModelRoutingChip.tsx'
import type { ModelRoutingChipProps } from '../src/client/ModelRoutingChip.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t = ((key: string) => (en as Record<string, string>)[key] ?? key) as ModelRoutingChipProps['t']

/** Render the chip over one published projection value. */
function chip(view: ModelRoutingView | null | undefined) {
  return render(
    <ModelRoutingChip
      {...({ useProjection: () => view } as unknown as ModelRoutingChipProps)}
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

describe('shortModel', () => {
  it('drops the author prefix and leaves a bare id alone', () => {
    expect(shortModel('deepseek/deepseek-v4-flash')).toBe('deepseek-v4-flash')
    expect(shortModel('stealth')).toBe('stealth')
  })
})
