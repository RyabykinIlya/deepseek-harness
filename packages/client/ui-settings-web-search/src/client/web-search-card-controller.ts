/**
 * The web-search page's staged form over one search provider's settings
 * namespace.
 *
 * Each provider's section declares its OWN fields, so what this form stages is
 * declared per provider rather than assumed: the three namespaces agree on
 * `baseURL` and on little else. DeepSeek bounds the searches one request may
 * run, Brave the results it asks for and the timeout, Tavily the result count,
 * the timeout and the snippet length — and a control bound to a field the Host
 * does not serve is one whose every save is refused.
 *
 * The key is the one control that does not live in the section: its literal
 * never rides a response, so the page learns only whether one is configured
 * and writes it through the credentials domain, addressed by the reference the
 * section names. It is still staged with the rest of the form, so one save
 * covers everything the page shows.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the ctx.remote merge into this program.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  SettingsFormModel, settingsNumberField, settingsTextField,
  type SettingsFieldSpec, type SettingsFieldState, type SettingsFormActions, type SettingsFormShell, type SettingsFormScope,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { WebSearchSettingsLocaleKey } from './locales.ts'

/** Which named provider a block configures, and where its section comes from. */
export type WebSearchProviderId = 'deepseek-official' | 'brave' | 'tavily'

/**
 * One field of a provider's settings section, as its card edits it.
 *
 * A section field, never the credential: the key is written through
 * `remote.credentials` and is deliberately absent from every provider's list.
 */
export interface WebSearchSectionField {
  /** Field name inside this provider's namespace section. */
  readonly field: string
  /** Whether the section stores a number, which its control renders as one. */
  readonly numeric: boolean
  /** Locale key naming this control. */
  readonly label: WebSearchSettingsLocaleKey
  /** Locale key explaining what this control changes. */
  readonly hint: WebSearchSettingsLocaleKey
}

/** One search provider this page can configure. */
export interface WebSearchProviderSpec {
  /** Provider id written to `web.searchProvider` when this one is selected. */
  readonly id: WebSearchProviderId
  /** Settings namespace the Host serves for this provider. */
  readonly namespace: string
  /** Credential reference used when the section names none. */
  readonly defaultApiKeyRef: string
  /**
   * The section fields this provider's card edits, in render order.
   *
   * Every name here is a key of that provider's own `z.object({ ... })`, the
   * Host's schema being the only authority on what its namespace carries. A
   * name the schema lacks is not merely hidden: the Host rejects a write to it,
   * so a card built over another provider's field set fails its own save.
   */
  readonly sectionFields: readonly WebSearchSectionField[]
}

/**
 * The DeepSeek provider, named once because it is both the first entry of the
 * list and the default a caller inherits when it names no provider.
 *
 * Naming it separately is what lets the callers below read a namespace and a
 * default without indexing the list, whose element type is optional.
 */
const DEEPSEEK_PROVIDER: WebSearchProviderSpec = {
  id: 'deepseek-official',
  namespace: 'web-search-deepseek',
  defaultApiKeyRef: 'DEEPSEEK_API_KEY',
  sectionFields: [
    { field: 'baseURL', numeric: false, label: 'baseUrl', hint: 'baseUrlHint' },
    { field: 'maxUses', numeric: true, label: 'maxUses', hint: 'maxUsesHint' },
  ],
}

/**
 * Every search provider the page knows how to configure.
 *
 * Namespaces and section fields are spelled here rather than imported: a client
 * package must not depend on a Host package, so the schemas these names mirror
 * cannot be read here. A provider is rendered only while the Host serves its
 * namespace, so listing one that is not mounted costs nothing.
 *
 * DuckDuckGo is absent on purpose. It holds no key, and its namespace declares
 * no section field at all, so there is no credential block and nothing to edit.
 */
export const WEB_SEARCH_PROVIDERS: readonly WebSearchProviderSpec[] = [
  DEEPSEEK_PROVIDER,
  {
    id: 'brave',
    namespace: 'web-search-brave',
    defaultApiKeyRef: 'BRAVE_API_KEY',
    sectionFields: [
      { field: 'baseURL', numeric: false, label: 'baseUrl', hint: 'baseUrlHint' },
      { field: 'maxResults', numeric: true, label: 'maxResults', hint: 'maxResultsHint' },
      { field: 'timeoutMs', numeric: true, label: 'timeoutMs', hint: 'timeoutMsHint' },
    ],
  },
  {
    id: 'tavily',
    namespace: 'web-search-tavily',
    defaultApiKeyRef: 'TAVILY_API_KEY',
    sectionFields: [
      { field: 'baseURL', numeric: false, label: 'baseUrl', hint: 'baseUrlHint' },
      { field: 'numResults', numeric: true, label: 'numResults', hint: 'numResultsHint' },
      { field: 'timeoutMs', numeric: true, label: 'timeoutMs', hint: 'timeoutMsHint' },
      { field: 'maxContentChars', numeric: true, label: 'maxContentChars', hint: 'maxContentCharsHint' },
    ],
  },
]

/**
 * The conversion one declared section field stages through.
 * @param declared - the field this provider's card edits.
 * @returns its `SettingsFormModel` spec.
 */
function sectionSpec(declared: WebSearchSectionField): SettingsFieldSpec {
  return declared.numeric ? settingsNumberField(declared.field) : settingsTextField(declared.field)
}

/** Namespace of the DeepSeek search provider, kept for callers that name one. */
export const WEB_SEARCH_NS = DEEPSEEK_PROVIDER.namespace

/** Form field the credential control stages under. */
const API_KEY_FIELD = 'apiKey'

/**
 * The section fields the served namespaces carry between them.
 *
 * One type for three schemas: a scope is bound per provider and the Host serves
 * whatever that provider declares, so every field is optional here and a card
 * reads only the ones its own provider lists. The last three are DeepSeek's and
 * no card edits them: they are listed so this describes what the namespaces
 * hold, not only what this page happens to touch.
 */
export interface WebSearchSettings {
  /** Credential reference naming the environment key. */
  apiKeyEnv?: string
  /** Provider endpoint; blank inherits the provider default. */
  baseURL?: string
  /** Brave's result count for a search that carries no bound of its own. */
  maxResults?: number
  /** Tavily's result count for a search that carries no bound of its own. */
  numResults?: number
  /** Tavily's character cap on one result's snippet. */
  maxContentChars?: number
  /** Request timeout in milliseconds. */
  timeoutMs?: number
  /** DeepSeek's maximum searches served within one request. */
  maxUses?: number
  /** DeepSeek's Anthropic-format model name. */
  model?: string
  /** DeepSeek's `anthropic-version` header value. */
  apiVersion?: string
  /** DeepSeek's upper bound on tokens generated for one search. */
  maxTokens?: number
}

/** What the credentials domain last reported, and for which reference. */
interface CredentialState {
  /** Reference this answer describes; a stale response for another one is dropped. */
  ref: string
  /** Whether any layer supplies a value for it. */
  configured: boolean
  /** Whether `credentials/set` can affect it; false disables the control. */
  writable: boolean
}

/**
 * One declared section field, as its control renders it.
 *
 * The locale keys ride the field rather than the card, because the label is a
 * property of the provider's schema: two providers can name the same control
 * `maxResults` and `numResults` for the same idea, and no card-side switch can
 * tell which of them it is rendering.
 */
export interface WebSearchSectionFieldState extends SettingsFieldState {
  /** Field name inside the section; the form's edit and reset address it. */
  readonly field: string
  /** Whether this control renders as a numeric one. */
  readonly numeric: boolean
  /** Locale key naming this control. */
  readonly label: WebSearchSettingsLocaleKey
  /** Locale key explaining what this control changes. */
  readonly hint: WebSearchSettingsLocaleKey
}

/** What the web-search page renders. */
export interface WebSearchCardState extends SettingsFormShell {
  /**
   * The section fields THIS provider declares, in render order.
   *
   * A list rather than one property per field: the fields differ per provider,
   * so a card written against DeepSeek's two would show Brave a search budget
   * that its namespace has no field for.
   */
  sectionFields: readonly WebSearchSectionFieldState[]
  /**
   * Which provider this card configures, and so the prefix every control id on
   * this card carries.
   *
   * The Plugins page renders one card per served provider at once, and `baseURL`
   * is declared by all three. Without the provider in the id, every card would
   * publish the same DOM id, `htmlFor` would resolve to whichever came first,
   * and a label could move focus into another provider's control.
   */
  providerId: WebSearchProviderId
  /** The staged credential, which starts blank on every load. */
  apiKey: SettingsFieldState
  /** Whether the Host reports a credential configured for the referenced key. */
  apiKeyConfigured: boolean
  /** Whether the credentials domain accepts a write for it; false disables the control. */
  apiKeyWritable: boolean
}

/** The registration-side face the web-search page's slot entry injects. */
export interface WebSearchCardFace extends SettingsFormActions {
  hooks: {
    /** Page snapshot bound by the renderer as useWebSearchCard. */
    webSearchCard: SnapshotStore<WebSearchCardState>
  }
}

/** Bridges one provider's scope and the credentials domain onto the page. */
export class WebSearchCardController {
  private readonly form: SettingsFormModel<WebSearchSettings>
  private readonly store: SnapshotStore<WebSearchCardState>
  private readonly unsubscribe: () => void
  private credential: CredentialState = { ref: '', configured: false, writable: true }

  /**
   * @param scope - the bound settings scope for this provider's namespace.
   * @param ctx - the page plugin's context, whose `remote.credentials` namespace
   * answers for the credential the section references.
   */
  constructor(
    private readonly scope: SettingsFormScope<WebSearchSettings>,
    private readonly ctx: ClientContext,
    /** Which provider's namespace this form edits. */
    private readonly provider: WebSearchProviderSpec = DEEPSEEK_PROVIDER,
  ) {
    this.form = new SettingsFormModel(
      scope,
      this.provider.sectionFields.map(sectionSpec),
      [{ field: API_KEY_FIELD, write: text => this.writeKey(text) }],
    )
    this.store = this.form.bind(() => this.projection())
    this.unsubscribe = scope.subscribe(() => { void this.readCredential() })
    void this.readCredential()
  }

  private projection(): WebSearchCardState {
    return {
      ...this.form.shell(),
      sectionFields: this.provider.sectionFields.map(declared => ({
        field: declared.field,
        numeric: declared.numeric,
        label: declared.label,
        hint: declared.hint,
        ...this.form.field(declared.field),
      })),
      providerId: this.provider.id,
      apiKey: this.form.field(API_KEY_FIELD),
      apiKeyConfigured: this.credential.configured,
      apiKeyWritable: this.credential.writable,
    }
  }

  /**
   * Ask the credentials domain about the reference the section currently names.
   *
   * The answer is stored with the reference it describes: `apiKeyEnv` can
   * change between the request and its response, and two reads can settle out
   * of order, so a response is published only while it still answers for the
   * reference in force.
   */
  private async readCredential(): Promise<void> {
    const ref = this.refOf()
    if (ref !== this.credential.ref) {
      // A new reference knows nothing yet; keeping the old answer would claim
      // the key is configured under a name nobody has checked.
      this.credential = { ref, configured: false, writable: true }
      this.store.set(this.projection())
    }
    const response = await this.ctx.remote.credentials.describe([ref])
    if (!response.ok || ref !== this.refOf()) return
    const view = response.value[ref]
    const next: CredentialState = {
      ref,
      configured: view?.configured ?? false,
      // An unknown reference is treated as writable: the control stays usable
      // and the Host is what refuses, rather than the page guessing a refusal.
      writable: view?.writable ?? true,
    }
    if (next.configured === this.credential.configured && next.writable === this.credential.writable) return
    this.credential = next
    this.store.set(this.projection())
  }

  /**
   * Re-read after the Host reports a change to the reference this page watches.
   *
   * A key can be written from somewhere else — the Models page addresses the
   * same reference — and the settings section does not change when it is, so
   * without this the badge keeps reporting a state the Host already replaced.
   * @param ref - the reference the Host reports as changed.
   */
  refreshCredential(ref: string): void {
    if (ref !== this.credential.ref) return
    void this.readCredential()
  }

  /**
   * Build the face the page's slot registration injects.
   * @returns the page's snapshot and its form actions.
   */
  inject(): WebSearchCardFace {
    return { hooks: { webSearchCard: this.store }, ...this.form.actions() }
  }

  /**
   * Write the staged key, then re-read whether the Host now holds one.
   * @param value - the staged credential literal.
   * @returns whether the Host reports a configured credential afterwards.
   */
  private async writeKey(value: string): Promise<boolean> {
    // Refusals surface through the re-read below: the Host is the only
    // authority on whether the key now exists.
    await this.ctx.remote.credentials.set(this.refOf(), value)
    await this.readCredential()
    return this.credential.configured
  }
  /** Release configuration subscriptions. */
  dispose(): void { this.unsubscribe(); this.form.dispose() }

  /**
   * The credential reference in force: what the section names, else this
   * provider's default.
   * @returns the reference to address.
   */
  private refOf(): string {
    const declared = this.scope.getSnapshot().value?.apiKeyEnv
    return declared !== undefined && declared.length > 0 ? declared : this.provider.defaultApiKeyRef
  }

}
