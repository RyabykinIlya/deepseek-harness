// @vitest-environment jsdom
/** The web-search page as the Plugins page renders it: its key control, the section fields it declares, and their resets. */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsFieldState, SettingsFormShell } from '@deepseek-ai/dsh-client-ui-primitives'
import { WebSearchCard, type WebSearchCardProps } from '../src/client/WebSearchCard.tsx'
import { WEB_SEARCH_PROVIDERS, type WebSearchCardState, type WebSearchProviderId } from '../src/client/web-search-card-controller.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t = (key: keyof typeof en) => en[key]

const settled: SettingsFormShell = { available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false }

/** The DeepSeek provider, whose declaration is what this card renders over. */
const deepseek = WEB_SEARCH_PROVIDERS[0]!

function field(text: string, rest: Partial<SettingsFieldState> = {}): SettingsFieldState {
  return { text, overridden: false, invalid: false, ...rest }
}

/**
 * The declared fields as the card renders them: every declaration, with the
 * named ones carrying the draft the test stages.
 * @param drafts - per-field drafts, keyed by field name.
 * @returns one renderable entry per declared section field.
 */
function sectionFields(drafts: Record<string, SettingsFieldState> = {}): WebSearchCardState['sectionFields'] {
  return deepseek.sectionFields.map(declared => ({
    ...declared,
    text: declared.numeric ? '5' : '',
    overridden: false,
    invalid: false,
    ...drafts[declared.field],
  }))
}

function cardActions() {
  return { edit: vi.fn(), resetField: vi.fn(), save: vi.fn(), discard: vi.fn() }
}

describe('WebSearchCard', () => {
  function renderWebSearch(state: Partial<WebSearchCardState> = {}) {
    const store = createSnapshotStore<WebSearchCardState>({
      ...settled,
      sectionFields: sectionFields(),
      providerId: 'deepseek-official',
      apiKey: field(''),
      apiKeyConfigured: false,
      apiKeyWritable: true,
      ...state,
    })
    const actions = cardActions()
    const props = { ...actions, view: 'page', t, useWebSearchCard: bindSnapshotSelector(store) } as WebSearchCardProps
    render(<WebSearchCard {...props} />)
    return actions
  }

  it('renders its one-liner alone in the summary view', () => {
    const store = createSnapshotStore<WebSearchCardState>({
      ...settled, sectionFields: sectionFields(), providerId: 'deepseek-official', apiKey: field(''), apiKeyConfigured: false, apiKeyWritable: true,
    })
    const props = { ...cardActions(), view: 'summary', t, useWebSearchCard: bindSnapshotSelector(store) } as WebSearchCardProps
    render(<WebSearchCard {...props} />)

    expect(document.body.textContent).toBe(en.description)
    expect(screen.queryByLabelText(en.apiKey)).toBeNull()
  })

  it('reports whether a key is configured without ever showing one', () => {
    renderWebSearch({ apiKeyConfigured: true })

    expect(screen.getByText(en.apiKeySet)).toBeTruthy()
    expect(screen.getByLabelText(en.apiKey)).toHaveProperty('type', 'password')
  })

  it('keeps the key control usable while the settings document is read-only', () => {
    const actions = renderWebSearch({ writable: false })

    const key = screen.getByLabelText(en.apiKey)
    expect(key).toHaveProperty('disabled', false)
    expect(screen.getByLabelText(en.baseUrl)).toHaveProperty('disabled', true)

    fireEvent.change(key, { target: { value: 'ds-secret' } })

    expect(actions.edit).toHaveBeenCalledWith('apiKey', 'ds-secret')
  })

  it('disables the key control when the reference itself is not writable', () => {
    // A key coming from the process environment: the settings document is
    // writable, the credential is not.
    renderWebSearch({ apiKeyConfigured: true, apiKeyWritable: false })

    expect(screen.getByLabelText(en.apiKey)).toHaveProperty('disabled', true)
    expect(screen.getByLabelText(en.baseUrl)).toHaveProperty('disabled', false)
  })

  it('stages every declared section field, and only those, with their resets', () => {
    const actions = renderWebSearch({
      sectionFields: sectionFields({
        baseURL: field('https://search.test/v1', { overridden: true }),
        maxUses: field('3', { overridden: true }),
      }),
    })

    fireEvent.change(screen.getByLabelText(en.baseUrl), { target: { value: 'https://other.test' } })
    fireEvent.change(screen.getByLabelText(en.maxUses), { target: { value: '4' } })
    const resets = screen.getAllByRole('button', { name: en.reset })
    expect(resets).toHaveLength(deepseek.sectionFields.length)
    for (const reset of resets) fireEvent.click(reset)

    expect(actions.edit.mock.calls).toEqual([
      ['baseURL', 'https://other.test'],
      ['maxUses', '4'],
    ])
    expect(actions.resetField.mock.calls).toEqual([['baseURL'], ['maxUses']])
  })

  it('gives every control an id no other provider\'s card can collide with', () => {
    // The Plugins page renders one card per served provider at once, and
    // `baseURL` is declared by all three. A shared id makes `htmlFor` resolve
    // to the first card in the document, so clicking Tavily's endpoint label
    // would move focus into whichever provider happens to be rendered above.
    const renderFor = (providerId: WebSearchProviderId) => {
      const provider = WEB_SEARCH_PROVIDERS.find(one => one.id === providerId)!
      const store = createSnapshotStore<WebSearchCardState>({
        ...settled,
        providerId,
        sectionFields: provider.sectionFields.map(declared => ({ ...declared, ...field('') })),
        apiKey: field(''),
        apiKeyConfigured: false,
        apiKeyWritable: true,
      })
      const props = {
        ...cardActions(), view: 'page', t, useWebSearchCard: bindSnapshotSelector(store),
      } as WebSearchCardProps
      return render(<WebSearchCard {...props} />)
    }

    for (const provider of WEB_SEARCH_PROVIDERS) {
      const { unmount } = renderFor(provider.id)
      // Every label resolves to exactly one control, and it is this card's own.
      for (const label of screen.getAllByRole('textbox')) {
        expect(document.querySelectorAll(`label[for="${label.id}"]`)).toHaveLength(1)
      }
      expect(screen.getAllByRole('textbox').map(box => box.id).every(id => id.includes(provider.id))).toBe(true)
      unmount()
    }
  })
})
