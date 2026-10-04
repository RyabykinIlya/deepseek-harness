/**
 * The provider selector's staged form over the web seam's own namespace.
 *
 * Every other namespace this page edits is a PROVIDER's: its block writes the
 * key and endpoint of one search provider, and the Host decides nothing from
 * those. This one is different — `web` is the seam that chooses between
 * providers, and `searchProvider` is the only field of it this page touches.
 * That asymmetry is why one selector is enough rather than one per provider
 * block: there is exactly one seam, so a control repeated inside each of the
 * three blocks would be three controls editing the same single global value.
 */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  SettingsFormModel, settingsTextField,
  type SettingsFieldState, type SettingsFormActions, type SettingsFormScope, type SettingsFormShell,
} from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * Settings namespace the web seam registers, and the one this selector edits.
 *
 * Spelled here rather than imported from `@deepseek-ai/dsh-web`: a client
 * package must not depend on a Host package, which is why the provider
 * namespaces are spelled the same way.
 */
export const WEB_SEAM_NS = 'web'

/** A provider id `web.searchProvider` accepts and this page can name. */
export type WebSearchSelectableId =
  | 'brave'
  | 'deepseek-official'
  | 'duckduckgo'
  | 'exa'
  | 'perplexity'
  | 'tavily'

/**
 * Every provider id a person may select, in the order the dropdown lists them.
 *
 * Deliberately NOT the same set as `WEB_SEARCH_PROVIDERS`: that list is the
 * CREDENTIAL blocks, and it omits providers whose keys need no block —
 * DuckDuckGo runs keyless, so the default composition selects a provider this
 * page never renders a card for. A selector listing only the blocks would
 * therefore be unable to name the selection the deployment actually starts
 * with. Every id here is spelled locally rather than imported from the
 * provider packages' `*_PROVIDER_ID` constants, because those are Host
 * packages; a Host that mounts a provider this page does not know still has its
 * configured value surfaced below rather than rewritten.
 */
export const WEB_SEARCH_SELECTABLE_IDS: readonly WebSearchSelectableId[] = [
  'duckduckgo',
  'deepseek-official',
  'brave',
  'tavily',
  'exa',
  'perplexity',
]

/** The select's stored field name inside the `web` section. */
const SEARCH_PROVIDER_FIELD = 'searchProvider'

/** The part of the `web` section this selector edits. */
export interface WebSeamSettings {
  /** Provider id the seam pins; omitted = the seam auto-selects. */
  searchProvider?: string
}

/** What the provider selector renders. */
export interface WebSearchSelectionState extends SettingsFormShell {
  /** The staged selection, which is the stored id, or '' while unset. */
  searchProvider: SettingsFieldState
}

/** The registration-side face the provider selector's slot entry injects. */
export interface WebSearchSelectionFace extends SettingsFormActions {
  hooks: {
    /** Page snapshot bound by the renderer as useWebSearchSelection. */
    webSearchSelection: SnapshotStore<WebSearchSelectionState>
  }
}

/**
 * Bridges the web seam's scope onto one selector.
 *
 * The field is staged as text and written only on save, exactly like
 * `baseURL` and `maxUses` on the provider blocks: a namespace write is a
 * durable, revision-fenced document mutation, so committing as the selection
 * settled would write without a preview. An empty draft is a clear rather than
 * an empty id, so choosing the automatic entry unsets `searchProvider` and
 * hands the choice back to the seam.
 */
export class WebSearchSelectionController {
  private readonly form: SettingsFormModel<WebSeamSettings>
  private readonly store: SnapshotStore<WebSearchSelectionState>

  /**
   * @param scope - the bound settings scope for the `web` namespace.
   */
  constructor(scope: SettingsFormScope<WebSeamSettings>) {
    this.form = new SettingsFormModel(scope, [settingsTextField(SEARCH_PROVIDER_FIELD)])
    this.store = this.form.bind(() => this.projection())
  }

  private projection(): WebSearchSelectionState {
    return {
      ...this.form.shell(),
      searchProvider: this.form.field(SEARCH_PROVIDER_FIELD),
    }
  }

  /**
   * Build the face the selector's slot registration injects.
   * @returns the page's snapshot and its form actions.
   */
  inject(): WebSearchSelectionFace {
    return { hooks: { webSearchSelection: this.store }, ...this.form.actions() }
  }

  /** Release configuration subscriptions. */
  dispose(): void { this.form.dispose() }
}
