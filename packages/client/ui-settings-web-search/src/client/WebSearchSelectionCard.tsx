/**
 * The provider selector as the Plugins page shows it: one dropdown over the web
 * seam's `searchProvider`, plus whatever the deployment has actually pinned.
 *
 * A provider id this page does not know is never rewritten: it is rendered as
 * the selected option under its own literal, so the page reports what the Host
 * holds instead of quietly substituting an id of its own.
 */

import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { SettingsForm } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { formLabels, type WebSearchSettingsLocaleKey } from './locales.ts'
import {
  WEB_SEARCH_SELECTABLE_IDS, type WebSearchSelectableId, type WebSearchSelectionFace,
} from './web-search-selection-controller.ts'
import css from './WebSearchSelectionCard.module.css'

/** Props the renderer binds for the provider selector. */
export type WebSearchSelectionCardProps =
  PropsRuntime<'plugins.item'>
  & PropsLocale<'settings.webSearch'>
  & InjectFace<WebSearchSelectionFace>

/** Control id associating the label with the dropdown. */
const SELECT_ID = 'plugin-config-web-search-provider'

/**
 * Which dictionary key names each selectable provider.
 *
 * The id is what the Host records in `web.searchProvider`; the label is only how
 * a person tells the rows apart.
 */
const OPTION_LABEL: Readonly<Record<WebSearchSelectableId, WebSearchSettingsLocaleKey>> = {
  'duckduckgo': 'providerDuckduckgo',
  'deepseek-official': 'providerDeepseek',
  'brave': 'providerBrave',
  'tavily': 'providerTavily',
  'exa': 'providerExa',
  'perplexity': 'providerPerplexity',
}

/**
 * Render the provider selector's one-liner or its dropdown, as the Plugins page asks.
 * @param props - the view asked for, locale copy, the form snapshot, and its actions.
 * @returns the one-liner, or the dropdown.
 */
export function WebSearchSelectionCard(props: WebSearchSelectionCardProps) {
  const { t } = props
  const state = props.useWebSearchSelection(snapshot => snapshot)
  if (props.view === 'summary') return t('searchProviderDescription')
  const current = state.searchProvider.text
  // A pinned id outside the list above is still what the Host holds, so it
  // joins the options rather than being dropped: the dropdown then opens on the
  // truth and only an explicit choice changes it.
  const pinned = current !== '' && !(WEB_SEARCH_SELECTABLE_IDS as readonly string[]).includes(current)
  return (
    <SettingsForm labels={formLabels(t)} state={state} onSave={props.save} onDiscard={props.discard}>
      <div className={css.field}>
        <label className={css.label} htmlFor={SELECT_ID}>{t('searchProvider')}</label>
        <select
          id={SELECT_ID}
          className={css.select}
          value={current}
          disabled={!state.writable}
          onChange={(event) => { props.edit('searchProvider', event.target.value) }}
        >
          <option value="">{t('searchProviderAuto')}</option>
          {WEB_SEARCH_SELECTABLE_IDS.map(id => <option key={id} value={id}>{t(OPTION_LABEL[id])}</option>)}
          {pinned ? <option value={current}>{t('searchProviderUnknown', { id: current })}</option> : null}
        </select>
        <p className={css.hint}>{t('searchProviderHint')}</p>
      </div>
    </SettingsForm>
  )
}
