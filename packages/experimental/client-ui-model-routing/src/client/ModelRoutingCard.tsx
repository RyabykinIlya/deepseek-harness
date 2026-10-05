/** One settings card for the `tiers` model route. */

import { useId } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { SegmentedTabs, SettingsForm } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SegmentedTab, SettingsFormLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import { QUANTIZATION_NAMES, quoteRowKey } from './model-routing-card-controller.ts'
import type { ModelRoutingCardFace, ModelRoutingCardState, TierRow } from './model-routing-card-controller.ts'
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
 * The tier the tab strip highlights: the selected one, or the first when the
 * selection has fallen out of range. Only called once the tier list is known
 * non-empty, so the fallback never actually reaches an empty name in practice.
 * @param tiers - the draft's tiers, in display order.
 * @param selected - the currently selected tier, when its index is in range.
 * @returns the name the tab strip should highlight.
 */
function activeTierName(tiers: readonly TierRow[], selected: TierRow | undefined): string {
  return selected?.name ?? tiers[0]?.name ?? ''
}

/**
 * Render the configured tiers and their filters, plus the route-wide knobs the
 * Host stores alongside them.
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
  const editable = state.writable && !state.saving
  return (
    <SettingsForm labels={formLabels(t)}
      state={cardShell(state)} onSave={props.save} onDiscard={props.discard}>
      <section className={css.section} aria-labelledby={`${headingId}-route`}>
        <h3 className={css.heading} id={`${headingId}-route`}>{t('routeSettings')}</h3>
        <label className={css.field}>
          <span>{t('judgeEnabled')}</span>
          <input
            type="checkbox"
            checked={state.judgeEnabled}
            disabled={!editable}
            onChange={(event) => { props.setJudgeEnabled(event.target.checked) }}
          />
        </label>
        <label className={css.field}>
          <span>{t('defaultTier')}</span>
          <select
            value={state.defaultTier}
            disabled={!editable}
            onChange={(event) => { props.setDefaultTier(event.target.value) }}
          >
            {state.tiers.map(row => <option key={row.name} value={row.name}>{row.label}</option>)}
          </select>
        </label>
        <label className={css.field}>
          <span>{t('cacheIdleMinutes')}</span>
          <input
            type="number"
            min={0}
            value={state.cacheIdleMinutesText}
            disabled={!editable}
            onChange={(event) => { props.setCacheIdleMinutes(event.target.value) }}
          />
        </label>
        <label className={css.field}>
          <span>{t('freeForSubagents')}</span>
          <input
            type="checkbox"
            checked={state.freeForSubagents}
            disabled={!editable}
            onChange={(event) => { props.setFreeForSubagents(event.target.checked) }}
          />
        </label>
        <label className={css.field}>
          <span>{t('trustedUnknownProviders')}</span>
          <input
            value={state.trustedProvidersText}
            disabled={!editable}
            onChange={(event) => { props.setTrustedProviders(event.target.value) }}
          />
        </label>
      </section>
      <section className={css.section} aria-labelledby={`${headingId}-tiers`}>
        <h3 className={css.heading} id={`${headingId}-tiers`}>{t('tierModels')}</h3>
        {state.tiers.length === 0 ? <p className={css.empty}>{t('empty')}</p> : (
          <>
            <SegmentedTabs
              items={state.tiers.map(row => ({
                value: row.name,
                label: row.label,
                id: `${headingId}-tab-${row.name}`,
                panelId: `${headingId}-panel-${row.name}`,
              })) as [SegmentedTab, ...SegmentedTab[]]}
              value={activeTierName(state.tiers, tier)}
              onChange={(name) => {
                const row = state.tiers.find(entry => entry.name === name)
                if (row !== undefined) props.selectTier(row.index)
              }}
              label={t('tierTabsLabel')}
            />
            {tier === undefined ? null : (
              <TierEditor
                t={t}
                tier={tier}
                state={state}
                props={props}
                panelId={`${headingId}-panel-${tier.name}`}
                tabId={`${headingId}-tab-${tier.name}`}
              />
            )}
          </>
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

/** The fields and model list of the one selected tier. */
function TierEditor(props: {
  t: (key: ModelRoutingLocaleKey) => string
  tier: TierRow
  state: ModelRoutingCardState
  props: ModelRoutingCardProps
  panelId: string
  tabId: string
}) {
  const { t, tier, state, panelId, tabId } = props
  const editable = state.writable && !state.saving
  return (
    <div className={css.tier} role="tabpanel" id={panelId} aria-labelledby={tabId}>
      <label className={css.field}>
        <span>{t('tierLabel')}</span>
        <input
          value={tier.label}
          disabled={!editable}
          onChange={(event) => { props.props.setTierField(tier.index, 'label', event.target.value) }}
        />
      </label>
      <label className={css.field}>
        <span>{t('tierFilter')}</span>
        <input
          value={tier.filter}
          disabled={!editable}
          onChange={(event) => { props.props.setFilter(tier.index, event.target.value) }}
        />
      </label>
      <label className={css.field}>
        <span>{t('tierContextWindow')}</span>
        <input
          type="number"
          min={1}
          value={tier.contextWindowText}
          disabled={!editable}
          onChange={(event) => { props.props.setTierField(tier.index, 'contextWindow', event.target.value) }}
        />
      </label>
      <label className={css.field}>
        <span>{t('tierMaxTokens')}</span>
        <input
          type="number"
          min={1}
          value={tier.maxTokensText}
          disabled={!editable}
          onChange={(event) => { props.props.setTierField(tier.index, 'maxTokens', event.target.value) }}
        />
      </label>
      <label className={css.field}>
        <span>{t('tierMinQuantization')}</span>
        <select
          value={tier.minQuantization}
          disabled={!editable}
          onChange={(event) => { props.props.setTierField(tier.index, 'minQuantization', event.target.value) }}
        >
          {QUANTIZATION_NAMES.map(name => <option key={name} value={name}>{name}</option>)}
        </select>
      </label>
      <label className={css.field}>
        <span>{t('tierUnknownQuantization')}</span>
        <select
          value={tier.unknownQuantization}
          disabled={!editable}
          onChange={(event) => { props.props.setTierField(tier.index, 'unknownQuantization', event.target.value) }}
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
          disabled={!editable}
          onChange={(event) => { props.props.setTierField(tier.index, 'free', event.target.value) }}
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
                disabled={!editable}
                onChange={() => { props.props.toggleModel(tier.index, candidate.model) }}
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
  )
}
