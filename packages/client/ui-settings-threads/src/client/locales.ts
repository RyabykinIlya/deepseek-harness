/** Locale bundles for the Threads settings page. */

import type { SettingsFormLabels } from '@deepseek-ai/dsh-client-ui-primitives'

/** Locale keys the page renders. */
export type ThreadsSettingsLocaleKey =
  | 'title' | 'description'
  | 'overridden' | 'reset' | 'readOnly' | 'unavailable'
  | 'save' | 'saving' | 'saveFailed'
  | 'checkIn' | 'checkInHint' | 'checkInInvalid' | 'checkInValues'
  | 'spawn' | 'spawnHint' | 'spawnInvalid' | 'approvalValues'
  | 'mergePolicy' | 'mergePolicyHint' | 'mergePolicyInvalid'
  | 'threadModelTitle'
  | 'threadProvider' | 'threadProviderHint'
  | 'threadModel' | 'threadModelHint'
  | 'threadReasoningEffort' | 'threadReasoningEffortHint'
  | 'threadMaxTokens' | 'threadMaxTokensHint' | 'threadMaxTokensInvalid'
  | 'textRejected'
  | 'threadModelPartial' | 'threadModelApplies'

/** English copy. */
export const en: Record<ThreadsSettingsLocaleKey, string> = {
  title: 'Threads',
  description: 'Control how a Project starts, follows, and merges its Threads.',
  overridden: 'Overridden',
  reset: 'Reset to default',
  readOnly: 'This deployment stores settings read-only.',
  unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
  save: 'Save',
  saving: 'Saving…',
  saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
  checkIn: 'Progress reporting',
  checkInHint: 'How often the Project narrates what its Threads are doing.',
  checkInInvalid: 'Type one of: milestones, each-thread, quiet.',
  checkInValues: 'milestones | each-thread | quiet',
  spawn: 'Approval before starting a Thread',
  spawnHint: 'Whether the Project waits for you before it starts the split it proposed.',
  spawnInvalid: 'Type one of: ask, auto.',
  approvalValues: 'ask | auto',
  mergePolicy: 'Approval before merging',
  mergePolicyHint: 'Whether the Project asks before it merges a finished Thread branch.',
  mergePolicyInvalid: 'Type one of: ask, auto.',
  threadModelTitle: 'Thread model options',
  threadProvider: 'Thread model provider',
  threadProviderHint: 'The LLM provider every Thread runs on.',
  threadModel: 'Thread model',
  threadModelHint: 'The model every Thread runs on.',
  threadReasoningEffort: 'Thread reasoning effort',
  threadReasoningEffortHint: 'The reasoning effort every Thread runs at.',
  threadMaxTokens: 'Thread output tokens',
  threadMaxTokensHint: 'Upper bound on the tokens one Thread response may produce.',
  threadMaxTokensInvalid: 'Enter a whole number of 1 or more.',
  textRejected: 'The deployment did not accept this value.',
  threadModelPartial: 'Set all four Thread model fields, or clear all four: the deployment accepts them only as a set.',
  threadModelApplies: 'A Thread inherits the configured model when these are all empty, and uses this one when they are all set. A saved change applies the next time the harness starts.',
}

/** Simplified Chinese copy. */
export const zh: Record<ThreadsSettingsLocaleKey, string> = {
  title: '线程',
  description: '控制 Project 如何启动、跟进并合并它的 Thread。',
  overridden: '已覆盖',
  reset: '恢复默认',
  readOnly: '本部署的设置为只读。',
  unavailable: '该插件当前未加载，暂时无法配置。',
  save: '保存',
  saving: '保存中…',
  saveFailed: '本部署没有接受这些值，已保留供你修改。',
  checkIn: '进度汇报',
  checkInHint: 'Project 汇报 Thread 进展的频率。',
  checkInInvalid: '请填写以下之一：milestones、each-thread、quiet。',
  checkInValues: 'milestones | each-thread | quiet',
  spawn: '启动 Thread 前需确认',
  spawnHint: 'Project 在启动它提出的拆分之前是否等待你确认。',
  spawnInvalid: '请填写以下之一：ask、auto。',
  approvalValues: 'ask | auto',
  mergePolicy: '合并前需确认',
  mergePolicyHint: 'Project 合并已完成的 Thread 分支之前是否询问你。',
  mergePolicyInvalid: '请填写以下之一：ask、auto。',
  threadModelTitle: 'Thread 模型选项',
  threadProvider: 'Thread 模型提供方',
  threadProviderHint: '每个 Thread 使用的 LLM 提供方。',
  threadModel: 'Thread 模型',
  threadModelHint: '每个 Thread 使用的模型。',
  threadReasoningEffort: 'Thread 推理强度',
  threadReasoningEffortHint: '每个 Thread 使用的推理强度。',
  threadMaxTokens: 'Thread 输出 token 数',
  threadMaxTokensHint: '单次 Thread 响应可生成的 token 上限。',
  threadMaxTokensInvalid: '请输入不小于 1 的整数。',
  textRejected: '部署没有接受这个值。',
  threadModelPartial: '四个 Thread 模型字段要么全部填写，要么全部清空：部署只接受成组的设置。',
  threadModelApplies: '这四项都为空时，Thread 继承配置的模型；都填写时则使用这里指定的模型。保存的改动会在下次启动 harness 时生效。',
}

/**
 * The form frame's copy, read from this page's dictionary.
 * @param t - the page's locale reader.
 * @returns the labels the shared settings form renders.
 */
export function formLabels(t: (key: ThreadsSettingsLocaleKey) => string): SettingsFormLabels {
  return { unavailable: t('unavailable'), readOnly: t('readOnly'), saveFailed: t('saveFailed'), save: t('save'), saving: t('saving') }
}
