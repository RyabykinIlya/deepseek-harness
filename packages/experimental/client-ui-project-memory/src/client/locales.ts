/** Locale bundles for the Project memory settings page. */

import type { SettingsFormLabels } from '@deepseek-ai/dsh-client-ui-primitives'

/** Locale keys the page renders. */
export type ProjectMemorySettingsLocaleKey =
  | 'title' | 'description'
  | 'maxEntries' | 'maxEntriesHint'
  | 'maxEntryChars' | 'maxEntryCharsHint'
  | 'overridden' | 'reset' | 'readOnly' | 'unavailable'
  | 'save' | 'saving' | 'saveFailed' | 'invalidNumber'

/** English copy. */
export const en: Record<ProjectMemorySettingsLocaleKey, string> = {
  title: 'Project memory',
  description: 'Control how much shared memory a Project keeps.',
  maxEntries: 'Entries per Project',
  maxEntriesHint: 'How many entries one Project keeps before a new one is refused. Remove or merge outdated entries to make room.',
  maxEntryChars: 'Characters per entry',
  maxEntryCharsHint: 'Longest entry text, counted in characters. A longer limit lets one entry hold a whole decision; a shorter one keeps entries scannable.',
  overridden: 'Overridden',
  reset: 'Reset to default',
  readOnly: 'This deployment stores settings read-only.',
  unavailable: 'Project memory is not loaded, so it cannot be configured right now.',
  save: 'Save',
  saving: 'Saving…',
  saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
  invalidNumber: 'Enter a whole number, or leave blank to use the default.',
}

/** Simplified Chinese copy. */
export const zh: Record<ProjectMemorySettingsLocaleKey, string> = {
  title: 'Project 记忆',
  description: '控制每个 Project 保存多少共享记忆。',
  maxEntries: '每个 Project 的条目数',
  maxEntriesHint: '单个 Project 最多保留多少条记忆，超过后新的写入会被拒绝。删除或合并过期条目即可腾出空间。',
  maxEntryChars: '每条记忆的字符数',
  maxEntryCharsHint: '条目文本的最大长度，按字符计。更长的上限允许一条记忆写下完整决定；更短的上限让条目更易扫读。',
  overridden: '已覆盖',
  reset: '恢复默认',
  readOnly: '本部署的设置为只读。',
  unavailable: 'Project 记忆当前未加载，暂时无法配置。',
  save: '保存',
  saving: '保存中…',
  saveFailed: '本部署没有接受这些值，已保留供你修改。',
  invalidNumber: '请填整数；留空表示使用默认值。',
}

/**
 * The form frame's copy, read from this page's dictionary.
 * @param t - the page's locale reader.
 * @returns the labels the shared settings form renders.
 */
export function formLabels(t: (key: ProjectMemorySettingsLocaleKey) => string): SettingsFormLabels {
  return { unavailable: t('unavailable'), readOnly: t('readOnly'), saveFailed: t('saveFailed'), save: t('save'), saving: t('saving') }
}
