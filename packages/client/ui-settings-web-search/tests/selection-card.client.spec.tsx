// @vitest-environment jsdom
/** The provider selector as the Plugins page renders it: what it offers, what it opens on, and what it stages. */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsFieldState, SettingsFormShell } from '@deepseek-ai/dsh-client-ui-primitives'
import { WebSearchSelectionCard, type WebSearchSelectionCardProps } from '../src/client/WebSearchSelectionCard.tsx'
import type { WebSearchSelectionState } from '../src/client/web-search-selection-controller.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

/** The dictionary reader the renderer is handed, interpolating `{id}` the way the locale plugin does. */
const t = (key: keyof typeof en, params?: Record<string, unknown>) =>
  en[key].replace(/\{(\w+)\}/g, (_match, name: string) => String(params?.[name] ?? ''))

const settled: SettingsFormShell = { available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false }

function field(text: string): SettingsFieldState {
  return { text, overridden: false, invalid: false }
}

function selectionActions() {
  return { edit: vi.fn(), resetField: vi.fn(), save: vi.fn(), discard: vi.fn() }
}

describe('WebSearchSelectionCard', () => {
  function renderSelector(state: Partial<WebSearchSelectionState> = {}, view: 'page' | 'summary' = 'page') {
    const store = createSnapshotStore<WebSearchSelectionState>({
      ...settled, searchProvider: field(''), ...state,
    })
    const actions = selectionActions()
    const props = { ...actions, view, t, useWebSearchSelection: bindSnapshotSelector(store) } as WebSearchSelectionCardProps
    render(<WebSearchSelectionCard {...props} />)
    return actions
  }

  /** The dropdown's options, as the browser exposes them. */
  function options(): HTMLOptionElement[] {
    return screen.getAllByRole('option') as HTMLOptionElement[]
  }

  it('renders its one-liner alone in the summary view', () => {
    renderSelector({}, 'summary')

    expect(document.body.textContent).toBe(en.searchProviderDescription)
    expect(screen.queryByLabelText(en.searchProvider)).toBeNull()
  })

  it('offers the automatic entry and every provider id this page knows', () => {
    renderSelector()

    // Keyless DuckDuckGo has no credential block but is the default selection,
    // so the dropdown must still be able to name it.
    expect(options().map(option => option.value)).toEqual([
      '', 'duckduckgo', 'deepseek-official', 'brave', 'tavily', 'exa', 'perplexity',
    ])
    expect(options().map(option => option.textContent)).toEqual([
      en.searchProviderAuto, en.providerDuckduckgo, en.providerDeepseek,
      en.providerBrave, en.providerTavily, en.providerExa, en.providerPerplexity,
    ])
  })

  it('opens on the automatic entry while nothing is pinned', () => {
    renderSelector()

    // Unset is a real state, not an empty control: the seam auto-selects.
    expect((screen.getByLabelText(en.searchProvider) as HTMLSelectElement).value).toBe('')
    expect(screen.getByText(en.searchProviderHint)).toBeTruthy()
  })

  it('opens on the pinned provider', () => {
    renderSelector({ searchProvider: field('brave') })

    expect((screen.getByLabelText(en.searchProvider) as HTMLSelectElement).value).toBe('brave')
  })

  it('shows a pinned id this page does not know under its own literal, without rewriting it', () => {
    const actions = renderSelector({ searchProvider: field('someone-elses-provider') })

    const select = screen.getByLabelText(en.searchProvider) as HTMLSelectElement
    expect(select.value).toBe('someone-elses-provider')
    // Surfaced as an extra option, not substituted with an id of this page's own.
    expect(options().map(option => option.value)).toContain('someone-elses-provider')
    expect(screen.getByRole('option', { name: t('searchProviderUnknown', { id: 'someone-elses-provider' }) })).toBeTruthy()
    expect(actions.edit).not.toHaveBeenCalled()
  })

  it('stages the chosen id and the automatic entry', () => {
    const actions = renderSelector({ searchProvider: field('brave') })
    const select = screen.getByLabelText(en.searchProvider) as HTMLSelectElement

    fireEvent.change(select, { target: { value: 'tavily' } })
    expect(actions.edit).toHaveBeenCalledWith('searchProvider', 'tavily')

    fireEvent.change(select, { target: { value: '' } })
    expect(actions.edit).toHaveBeenCalledWith('searchProvider', '')
  })

  it('disables the dropdown while the deployment stores settings read-only', () => {
    renderSelector({ writable: false })

    expect(screen.getByLabelText(en.searchProvider)).toHaveProperty('disabled', true)
  })

  it('says the namespace is unavailable rather than showing an inert dropdown', () => {
    renderSelector({ available: false })

    expect(document.body.textContent).toBe(en.unavailable)
    expect(screen.queryByLabelText(en.searchProvider)).toBeNull()
  })
})
