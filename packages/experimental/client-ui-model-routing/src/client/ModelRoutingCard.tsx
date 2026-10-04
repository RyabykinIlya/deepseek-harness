/** One settings card for the `tiers` model route. */

import { useId } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { SettingsForm } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsFormLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import { quoteRowKey } from './model-routing-card-controller.ts'
import type { ModelRoutingCardFace, ModelRoutingCardState } from './model-routing-card-controller.ts'
import type { ModelRoutingLocaleKey } from './locales.ts'
import css from './ModelRoutingCard.module.css'

/** Framework-derived props for the model-routing settings card. */
export type ModelRoutingCardProps = PropsRuntime<'plugins.item'>
  & PropsLocale<'settings.modelRouting'> & InjectFace<ModelRoutingCardFace>

/** The shell the shared form renders its save footer from. */
export function cardShell(state: ModelRoutingCardState): {
  available: boolean
  writable: boolean
  dirty: boolean
  invalid: boolean
  saving: boolean
  failed: boolean
} {
  return {
    available: state.available,
    writable: state.writable,
    dirty: state.dirty,
    // A draft that outlived its revision cannot be written as one mutation, so
    // the form refuses rather than overwriting somebody else's change.
    invalid: state.dirty && state.conflicted,
    saving: state.saving,
    failed: state.failed,
  }
}

/** The shared form's own labels, in this card's vocabulary. */
export function formLabels(t: (key: ModelRoutingLocaleKey) => string): SettingsFormLabels {
  return {
    unavailable: t('empty'),
    readOnly: t('empty'),
    saveFailed: t('failed'),
    save: t('save'),
    saving: t('saving'),
  }
}

/**
 * Render the configured tiers, their models, and the shared filters.
 * @param props - locale, the card snapshot, and its staged actions.
 * @returns the summary line or the full settings form.
 */
export function ModelRoutingCard(props: ModelRoutingCardProps) {
  const { t } = props
  const state = props.useModelRoutingCard(snapshot => snapshot)
  const headingId = useId()
  if (props.view === 'summary') {
    return t('summary', {
      tiers: state.tiers.length,
      models: state.tiers.reduce((total, tier) => total + tier.models.length, 0),
    })
  }
  const tier = state.tiers[state.selectedTier]
  const providers = state.tiers.flatMap(entry => entry.index === state.selectedTier
    ? entry.models
    : [])
  void providers
  return (
    <SettingsForm labels={formLabels(t)}
      state={cardShell(state)} onSave={props.save} onDiscard={props.discard}>
      <section className={css.section} aria-labelledby={`${headingId}-tiers`}>
        <h3 className={css.heading} id={`${headingId}-tiers`}>{t('tierModels')}</h3>
        {tier === undefined ? <p className={css.empty}>{t('empty')}</p> : (
          <div className={css.tier}>
            <label className={css.field}>
              <span>{t('tierLabel')}</span>
              <input
                value={tier.label}
                disabled={!state.writable}
                onChange={(event) =>{  props.setTierField(tier.index, 'label', event.target.value) }}
              />
            </label>
            <label className={css.field}>
              <span>{t('tierFilter')}</span>
              <input
                value={tier.filter}
                onChange={(event) =>{  props.setFilter(tier.index, event.target.value) }}
              />
            </label>
            <label className={css.field}>
              <span>{t('tierContextWindow')}</span>
              <input type="number" value={tier.contextWindow} readOnly />
            </label>
            <label className={css.field}>
              <span>{t('tierMaxTokens')}</span>
              <input type="number" value={tier.maxTokens} readOnly />
            </label>
            <label className={css.field}>
              <span>{t('tierMinQuantization')}</span>
              <select
                value={tier.minQuantization}
                disabled={!state.writable}
                onChange={(event) =>{  props.setTierField(tier.index, 'minQuantization', event.target.value) }}
              />
            </label>
            <label className={css.field}>
              <span>{t('tierUnknownQuantization')}</span>
              <select
                value={tier.unknownQuantization}
                disabled={!state.writable}
                onChange={(event) =>{  props.setTierField(tier.index, 'unknownQuantization', event.target.value) }}
              >
                <option value="reject">{t('unknown.reject')}</option>
                <option value="trusted">{t('unknown.trusted')}</option>
                <option value="accept">{t('unknown.accept')}</option>
              </select>
            </label>
            <label className={css.field}>
              <span>{t('tierFree')}</span>
              <select
                value={tier.free}
                disabled={!state.writable}
                onChange={(event) =>{  props.setTierField(tier.index, 'free', event.target.value) }}
              >
                <option value="off">{t('free.off')}</option>
                <option value="prefer">{t('free.prefer')}</option>
                <option value="only">{t('free.only')}</option>
              </select>
            </label>
            <ul className={css.models}>
              {state.candidates.map(candidate => (
                <li key={candidate.model}>
                  <label>
                    <input
                      type="checkbox"
                      checked={candidate.selected}
                      disabled={!state.writable}
                      onChange={() =>{  props.toggleModel(tier.index, candidate.model) }}
                    />
                    <span>{candidate.modelName}</span>
                    {candidate.selected ? (
                      <span className={css.quote}>
                        {state.quotes[quoteRowKey(tier.name, { model: candidate.model } as never)]?.text ?? ''}
                      </span>
                    ) : null}
                  </label>
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className={css.hint}>
          {state.freeUsageKnown && state.freeUsage !== undefined
            ? t('freeUsage', state.freeUsage)
            : t('free.unknown')}
        </p>
      </section>
    </SettingsForm>
  )
}
