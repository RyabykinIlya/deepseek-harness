/** The Project memory settings page: how many entries a Project keeps, and how long each may be. */

import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { SettingsForm, SettingsValueField } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { formLabels } from './locales.ts'
import type { ProjectMemoryCardFace } from './project-memory-card-controller.ts'

/** Props the renderer binds for the Project memory page. */
export type ProjectMemoryCardProps = PropsRuntime<'plugins.item'>
  & PropsLocale<'settings.projectMemory'>
  & InjectFace<ProjectMemoryCardFace>

/**
 * Render the Project memory one-liner or its settings form, as the Plugins page asks.
 *
 * The entry count sits above the entry length because it is the cap a Project
 * reaches first and the one whose remedy — merging or removing entries — the
 * person has to plan around.
 * @param props - the view asked for, locale copy, the form snapshot, and its actions.
 * @returns the one-liner, or the form.
 */
export function ProjectMemoryCard(props: ProjectMemoryCardProps) {
  const { t } = props
  const state = props.useProjectMemoryCard(snapshot => snapshot)
  if (props.view === 'summary') return t('description')
  const disabled = !state.writable
  return (
    <SettingsForm labels={formLabels(t)} state={state} onSave={props.save} onDiscard={props.discard}>
      <SettingsValueField
        id="plugin-config-project-memory-entries"
        label={t('maxEntries')}
        hint={t('maxEntriesHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidNumber')}
        numeric
        disabled={disabled}
        {...state.maxEntries}
        onEdit={(text) => { props.edit('maxEntries', text) }}
        onReset={() => { props.resetField('maxEntries') }}
      />
      <SettingsValueField
        id="plugin-config-project-memory-entry-chars"
        label={t('maxEntryChars')}
        hint={t('maxEntryCharsHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidNumber')}
        numeric
        disabled={disabled}
        {...state.maxEntryChars}
        onEdit={(text) => { props.edit('maxEntryChars', text) }}
        onReset={() => { props.resetField('maxEntryChars') }}
      />
    </SettingsForm>
  )
}
