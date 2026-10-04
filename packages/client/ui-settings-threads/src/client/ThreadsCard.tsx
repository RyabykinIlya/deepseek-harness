/** The Threads settings page: the coordinator's knobs and the model every Thread runs on. */

import { useId } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { SettingsForm, SettingsValueField } from '@deepseek-ai/dsh-client-ui-primitives'
import { formLabels } from './locales.ts'
import type { ThreadsCardFace } from './threads-card-controller.ts'
import css from './ThreadsCard.module.css'

/** Props the renderer binds for the Threads page. */
export type ThreadsCardProps = PropsRuntime<'plugins.item'>
  & PropsLocale<'settings.threads'>
  & InjectFace<ThreadsCardFace>

/**
 * Render the Threads one-liner or its settings form, as the Plugins page asks.
 *
 * The three coordinator knobs sit above the Thread model group because they
 * configure the Project and every Thread inherits its consequence, while the
 * group below is read and written as one: the notice under its heading says so,
 * and a half-written group turns into the same warning that blocks the save.
 * @param props - the view asked for, locale copy, the form snapshot, and its actions.
 * @returns the one-liner, or the form.
 */
export function ThreadsCard(props: ThreadsCardProps) {
  const { t } = props
  const state = props.useThreadsCard(snapshot => snapshot)
  const modelHeadingId = useId()
  if (props.view === 'summary') return t('description')
  const disabled = !state.writable
  return (
    <SettingsForm labels={formLabels(t)} state={state} onSave={props.save} onDiscard={props.discard}>
      <SettingsValueField
        id="plugin-config-threads-check-in"
        label={t('checkIn')}
        hint={t('checkInHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('checkInInvalid')}
        placeholder={t('checkInValues')}
        disabled={disabled}
        {...state.checkIn}
        onEdit={(text) => { props.edit('checkIn', text) }}
        onReset={() => { props.resetField('checkIn') }}
      />
      <SettingsValueField
        id="plugin-config-threads-spawn"
        label={t('spawn')}
        hint={t('spawnHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('spawnInvalid')}
        placeholder={t('approvalValues')}
        disabled={disabled}
        {...state.spawn}
        onEdit={(text) => { props.edit('spawn', text) }}
        onReset={() => { props.resetField('spawn') }}
      />
      <SettingsValueField
        id="plugin-config-threads-merge"
        label={t('mergePolicy')}
        hint={t('mergePolicyHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('mergePolicyInvalid')}
        placeholder={t('approvalValues')}
        disabled={disabled}
        {...state.mergePolicy}
        onEdit={(text) => { props.edit('mergePolicy', text) }}
        onReset={() => { props.resetField('mergePolicy') }}
      />
      <section className={css.section} aria-labelledby={`${modelHeadingId}-model`}>
        <h3 className={css.heading} id={`${modelHeadingId}-model`}>{t('threadModelTitle')}</h3>
        <p className={css.note}>{t('threadModelApplies')}</p>
        {state.partialThreadModel
          ? <p className={css.warning} role="status">{t('threadModelPartial')}</p>
          : null}
        <SettingsValueField
          id="plugin-config-threads-provider"
          label={t('threadProvider')}
          hint={t('threadProviderHint')}
          overriddenLabel={t('overridden')}
          resetLabel={t('reset')}
          invalidLabel={t('textRejected')}
          disabled={disabled}
          {...state.threadProvider}
          onEdit={(text) => { props.edit('threadProvider', text) }}
          onReset={() => { props.resetField('threadProvider') }}
        />
        <SettingsValueField
          id="plugin-config-threads-model"
          label={t('threadModel')}
          hint={t('threadModelHint')}
          overriddenLabel={t('overridden')}
          resetLabel={t('reset')}
          invalidLabel={t('textRejected')}
          disabled={disabled}
          {...state.threadModel}
          onEdit={(text) => { props.edit('threadModel', text) }}
          onReset={() => { props.resetField('threadModel') }}
        />
        <SettingsValueField
          id="plugin-config-threads-effort"
          label={t('threadReasoningEffort')}
          hint={t('threadReasoningEffortHint')}
          overriddenLabel={t('overridden')}
          resetLabel={t('reset')}
          invalidLabel={t('textRejected')}
          disabled={disabled}
          {...state.threadReasoningEffort}
          onEdit={(text) => { props.edit('threadReasoningEffort', text) }}
          onReset={() => { props.resetField('threadReasoningEffort') }}
        />
        <SettingsValueField
          id="plugin-config-threads-max-tokens"
          label={t('threadMaxTokens')}
          hint={t('threadMaxTokensHint')}
          overriddenLabel={t('overridden')}
          resetLabel={t('reset')}
          invalidLabel={t('threadMaxTokensInvalid')}
          numeric
          disabled={disabled}
          {...state.threadMaxTokens}
          onEdit={(text) => { props.edit('threadMaxTokens', text) }}
          onReset={() => { props.resetField('threadMaxTokens') }}
        />
      </section>
    </SettingsForm>
  )
}
