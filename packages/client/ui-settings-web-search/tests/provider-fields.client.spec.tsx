// @vitest-environment jsdom
/**
 * Every provider's card over that provider's OWN section.
 *
 * The defect this guards: one card built over DeepSeek's field set was rendered
 * for Tavily and Brave too, so a "Max searches per request" control was staged
 * against `maxUses` — a key neither schema declares — and the Host refused the
 * save. A card whose fields are declared per provider can only be checked by
 * building it over a section shaped like each real one, which is what the
 * fixtures below are.
 *
 * They are literals on purpose. A client test may not depend on a Host package —
 * the same purity rule the client bundle obeys — so the schema cannot be
 * imported here, and a field the Host adds or renames has to be noticed in this
 * file rather than inherited from the schema.
 */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector, stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { WebSearchCard, type WebSearchCardProps } from '../src/client/WebSearchCard.tsx'
import {
  WEB_SEARCH_PROVIDERS, WebSearchCardController,
  type WebSearchCardFace, type WebSearchProviderSpec, type WebSearchSettings,
} from '../src/client/web-search-card-controller.ts'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)

/**
 * Every volatile key each served schema declares, as the host packages write
 * them: the fixture below is checked against this list so a schema that gains
 * or drops a field has to be copied here rather than quietly diverge.
 */
const VOLATILE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  'web-search-deepseek': ['apiKey', 'apiKeyEnv', 'baseURL', 'model', 'apiVersion', 'maxTokens', 'maxUses'],
  'web-search-brave': ['apiKey', 'apiKeyEnv', 'baseURL', 'maxResults', 'timeoutMs'],
  'web-search-tavily': ['apiKey', 'apiKeyEnv', 'baseURL', 'numResults', 'timeoutMs', 'maxContentChars'],
}

/**
 * One served section, mirroring the volatile keys of its provider's
 * `z.object({ ... })` as the Host resolves it: every declared default filled
 * in, and no `apiKey`, because a credential literal never rides a response.
 */
const SECTIONS: Readonly<Record<string, WebSearchSettings>> = {
  'web-search-deepseek': {
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    baseURL: 'https://api.deepseek.com/anthropic/v1',
    model: 'deepseek-v4-flash',
    apiVersion: '2023-06-01',
    maxTokens: 4096,
    maxUses: 5,
  },
  'web-search-brave': {
    apiKeyEnv: 'BRAVE_API_KEY',
    baseURL: 'https://api.search.brave.com',
    maxResults: 8,
    timeoutMs: 15_000,
  },
  'web-search-tavily': {
    apiKeyEnv: 'TAVILY_API_KEY',
    baseURL: 'https://api.tavily.com/search',
    numResults: 5,
    timeoutMs: 15_000,
    maxContentChars: 2_000,
  },
}

/**
 * The card plugin's context, scripted down to the credentials namespace it reaches.
 * @param ref - the reference this provider's section would name.
 * @returns a context answering for that reference only.
 */
function ctxWith(ref: string) {
  const describe = vi.fn(() => Promise.resolve({
    ok: true as const,
    value: { [ref]: { configured: false, writable: true } },
  }))
  const set = vi.fn(() => Promise.resolve({ ok: true as const, value: undefined }))
  return { remote: { credentials: { describe, set } } } as never
}

/**
 * The card over one provider's served section, as the Plugins page mounts it.
 * @param provider - the provider whose namespace is served.
 * @returns the face its slot entry injects, and the stub behind its scope.
 */
function mount(provider: WebSearchProviderSpec) {
  const section = SECTIONS[provider.namespace]!
  const host = stubConfigForm<WebSearchSettings>()
  const controller = new WebSearchCardController(host.scope, ctxWith(provider.defaultApiKeyRef), provider)
  host.publish({ status: 'ready', writable: true, value: section, base: {}, user: {} })
  return { host, section, face: controller.inject() }
}

/**
 * Render one mounted card, as the Plugins page does.
 * @param face - the injected face whose snapshot and actions the view binds.
 * @returns the action spies the view would call.
 */
function renderCard(face: WebSearchCardFace) {
  const actions = { edit: vi.fn(), resetField: vi.fn(), save: vi.fn(), discard: vi.fn() }
  const props = {
    ...actions,
    view: 'page',
    t: (key: keyof typeof en) => en[key],
    useWebSearchCard: bindSnapshotSelector(face.hooks.webSearchCard),
  } as WebSearchCardProps
  render(<WebSearchCard {...props} />)
  return actions
}

describe('web-search card over each provider\'s own section', () => {
  for (const provider of WEB_SEARCH_PROVIDERS) {
    const schemaFields = Object.keys(SECTIONS[provider.namespace]!)

    it(`${provider.namespace}: declares only fields its schema carries`, () => {
      const { face } = mount(provider)
      const declared = face.hooks.webSearchCard.getSnapshot().sectionFields.map(entry => entry.field)

      expect(declared.length).toBeGreaterThan(0)
      // The regression: every declared name is a key of this provider's own
      // schema, so no save of this card can be refused for naming a field the
      // section does not have.
      expect(declared.filter(name => !schemaFields.includes(name))).toEqual([])
      // The key is written through `remote.credentials`, so it is never one of
      // the section fields a card stages.
      expect(declared).not.toContain('apiKey')
      expect(new Set(declared).size).toBe(declared.length)
    })

    it(`${provider.namespace}: reads every declared field out of the served section`, () => {
      const { face, section } = mount(provider)

      for (const entry of face.hooks.webSearchCard.getSnapshot().sectionFields) {
        expect(entry.text, entry.field).toBe(String(section[entry.field as keyof WebSearchSettings]))
      }
    })

    it(`${provider.namespace}: renders one control per declared field and no other`, () => {
      const { face } = mount(provider)
      const declared = face.hooks.webSearchCard.getSnapshot().sectionFields

      renderCard(face)

      for (const entry of declared) {
        const control = screen.getByLabelText(en[entry.label])
        expect(control).toHaveProperty('value', entry.text)
        // A numeric control hints the keypad; the acceptance rules live in the
        // field's spec, so the hint is the only difference between the two.
        expect(control.getAttribute('inputMode')).toBe(entry.numeric ? 'numeric' : null)
      }
      // The password control carries no textbox role, so this counts exactly
      // the value fields: a card showing more than it declared is caught here.
      expect(screen.getAllByRole('textbox')).toHaveLength(declared.length)
    })

    it(`${provider.namespace}: stages ops only for fields its section carries`, async () => {
      const { face, host } = mount(provider)
      const declared = face.hooks.webSearchCard.getSnapshot().sectionFields
      // A draft that differs from the stored value, or the form writes nothing.
      const staged = new Map(declared.map(entry => [
        entry.field,
        entry.numeric ? String(Number(entry.text) + 1) : `${entry.text}/edited`,
      ]))
      for (const [field, draft] of staged) face.edit(field, draft)

      face.save()
      await vi.waitFor(() => { expect(host.mutate).toHaveBeenCalled() })

      // One write per declared field, in staging order, each carrying the value
      // that field's kind parses its draft into: a number for a numeric control,
      // the trimmed text for a text one.
      const ops = host.mutate.mock.calls.flatMap(([edits]) => edits)
      expect(ops).toEqual(declared.map(entry => ({
        op: 'set',
        path: [entry.field],
        value: entry.numeric ? Number(staged.get(entry.field)) : staged.get(entry.field),
      })))
      expect(ops.filter(op => !schemaFields.includes(String(op.path[0])))).toEqual([])
    })

    it(`${provider.namespace}: disables every declared field on a read-only document`, () => {
      const { face, host, section } = mount(provider)
      host.publish({ status: 'ready', writable: false, value: section, base: {}, user: {} })
      const declared = face.hooks.webSearchCard.getSnapshot().sectionFields

      renderCard(face)

      for (const entry of declared) {
        expect(screen.getByLabelText(en[entry.label])).toHaveProperty('disabled', true)
      }
      // The credentials domain has its own writability, which a read-only
      // settings document says nothing about.
      expect(screen.getByLabelText(en.apiKey)).toHaveProperty('disabled', false)
    })
  }
})

describe('web-search card field declarations', () => {
  it('serves a fixture of exactly the fields each schema declares', () => {
    // `apiKey` is the one key that never rides a response, so it is the one the
    // fixture leaves out; everything else the schema marks volatile is here.
    for (const [namespace, volatile] of Object.entries(VOLATILE_FIELDS)) {
      expect(Object.keys(SECTIONS[namespace]!).sort(), namespace)
        .toEqual(volatile.filter(field => field !== 'apiKey').sort())
    }
  })

  it('offers a block only for a namespace that carries a credential', () => {
    // DuckDuckGo holds no key and declares no section field, so it stays out of
    // the credential blocks even though the seam can select it.
    expect(WEB_SEARCH_PROVIDERS.map(provider => provider.namespace).sort())
      .toEqual(Object.keys(VOLATILE_FIELDS).sort())
  })

  it('gives each provider the budget its own schema names', () => {
    const declaredFor = (namespace: string) => WEB_SEARCH_PROVIDERS
      .find(provider => provider.namespace === namespace)!.sectionFields.map(entry => entry.field)

    expect(declaredFor('web-search-deepseek')).toEqual(['baseURL', 'maxUses'])
    expect(declaredFor('web-search-brave')).toEqual(['baseURL', 'maxResults', 'timeoutMs'])
    expect(declaredFor('web-search-tavily')).toEqual(['baseURL', 'numResults', 'timeoutMs', 'maxContentChars'])
  })

  it('declares no field a provider does not have', () => {
    const names = WEB_SEARCH_PROVIDERS.flatMap(provider => provider.sectionFields.map(entry => entry.field))

    // The endpoint is the one field all three schemas share.
    expect(names).toContain('baseURL')
    // `apiKeyEnv` is read to address the credential, never edited from here.
    expect(names).not.toContain('apiKeyEnv')
    // `maxUses` is DeepSeek's server-tool budget; no other provider declares it.
    expect(names.filter(name => name === 'maxUses')).toHaveLength(1)
  })

  it('declares each control in the kind its schema stores', () => {
    for (const provider of WEB_SEARCH_PROVIDERS) {
      const section = SECTIONS[provider.namespace]!
      for (const declared of provider.sectionFields) {
        const stored = section[declared.field as keyof WebSearchSettings]
        expect(declared.numeric, `${provider.id}.${declared.field}`).toBe(typeof stored === 'number')
      }
    }
  })

  it('gives every declared control its own locale copy in both languages', () => {
    const keys = WEB_SEARCH_PROVIDERS.flatMap(provider => provider.sectionFields.flatMap(field => [field.label, field.hint]))

    for (const key of keys) {
      expect(en[key], key).not.toBe('')
      expect(zh[key], key).not.toBe('')
    }
    // Brave's `maxResults` and Tavily's `numResults` bound the same idea, so
    // they may share a label; their hints are the copy that differs, and each
    // has to name the provider whose schema the field belongs to.
    expect(en.maxResultsHint).not.toBe(en.numResultsHint)
    expect(en.maxResultsHint).toContain('Brave')
    expect(en.numResultsHint).toContain('Tavily')
  })

  it('shows a provider no budget control named for another provider', () => {
    for (const provider of WEB_SEARCH_PROVIDERS.filter(one => one.id !== 'deepseek-official')) {
      const { face } = mount(provider)
      renderCard(face)

      expect(screen.queryByLabelText(en.maxUses), provider.id).toBeNull()
      cleanup()
    }
  })
})
