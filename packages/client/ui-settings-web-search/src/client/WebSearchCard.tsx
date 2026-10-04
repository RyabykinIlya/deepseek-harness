/**
 * The web-search provider's settings page: the key — written through the
 * credentials domain, never into the settings section, so the literal never
 * rides a response — and the section fields THIS provider declares.
 *
 * The fields are not fixed here. The three providers share only `baseURL`: the
 * search budget is `maxUses` for DeepSeek, `maxResults` for Brave, `numResults`
 * for Tavily, and each of them caps its request differently besides. A control
 * hard-coded to one provider's names renders inert ones on the other two, so
 * every value field below comes from the controller's declaration for the
 * provider being served.
 *
 * Every control id therefore carries the provider id. All three cards render at
 * once on the Plugins page and `baseURL` is common to all of them, so a shared
 * id would make `htmlFor` resolve to the first card on the page and send focus
 * into another provider's field.
 */

import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { SettingsForm, SettingsSecretField, SettingsValueField } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { formLabels } from './locales.ts'
import type { WebSearchCardFace } from './web-search-card-controller.ts'

/** Props the renderer binds for the web-search page. */
export type WebSearchCardProps =
  PropsRuntime<'plugins.item'>
  & PropsLocale<'settings.webSearch'>
  & InjectFace<WebSearchCardFace>

/**
 * Render the web-search provider's one-liner or its settings form, as the Plugins page asks.
 * @param props - the view asked for, locale copy, the form snapshot, and its actions.
 * @returns the one-liner, or the form.
 */
export function WebSearchCard(props: WebSearchCardProps) {
  const { t } = props
  const state = props.useWebSearchCard(snapshot => snapshot)
  if (props.view === 'summary') return t('description')
  const disabled = !state.writable
  return (
    <SettingsForm labels={formLabels(t)} state={state} onSave={props.save} onDiscard={props.discard}>
      <SettingsSecretField
        id={`plugin-config-web-search-${state.providerId}-key`}
        label={t('apiKey')}
        hint={t('apiKeyHint')}
        // The credentials domain accepts a key even when the settings document
        // itself is read-only; they are separate stores with separate refusals.
        // Its own writability is what disables this control — a key sourced
        // from the process environment cannot be written from here.
        disabled={!state.apiKeyWritable}
        text={state.apiKey.text}
        configured={state.apiKeyConfigured}
        stateLabel={state.apiKeyConfigured ? t('apiKeySet') : t('apiKeyUnset')}
        onEdit={(text) => { props.edit('apiKey', text) }}
      />
      {state.sectionFields.map(({ field, numeric, label, hint, ...draft }) => (
        <SettingsValueField
          key={field}
          id={`plugin-config-web-search-${state.providerId}-${field}`}
          label={t(label)}
          hint={t(hint)}
          overriddenLabel={t('overridden')}
          resetLabel={t('reset')}
          invalidLabel={t('invalidNumber')}
          numeric={numeric}
          disabled={disabled}
          {...draft}
          onEdit={(text) => { props.edit(field, text) }}
          onReset={() => { props.resetField(field) }}
        />
      ))}
    </SettingsForm>
  )
}
