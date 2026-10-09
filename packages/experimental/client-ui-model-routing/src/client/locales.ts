/**
 * Copy for the model-routing surfaces: the composer chip, the settings page, and
 * the Thread roster entry.
 *
 * Tier labels are addressed by name rather than enumerated, because tiers are
 * configured: `pro` and `flash` are the two the plan ships, and a deployment
 * that adds a third gets its raw name rendered rather than a missing key.
 */

import type { LocaleDictOf } from '@deepseek-ai/dsh-client-ui-slots'

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.modelRouting'

/** Every key of this namespace's dictionaries. */
export type ModelRoutingLocaleKey =
  | 'title'
  | 'summary'
  | 'chip.unpinned'
  | 'chip.pending'
  | 'boundary.start'
  | 'boundary.selection-change'
  | 'boundary.compaction'
  | 'boundary.idle'
  | 'boundary.failure'
  | 'tier.pro'
  | 'tier.flash'
  | 'routeSettings'
  | 'tierTabsLabel'
  | 'tierName'
  | 'tierLabel'
  | 'tierModels'
  | 'tierFilter'
  | 'tierContextWindow'
  | 'tierMaxTokens'
  | 'tierMinQuantization'
  | 'tierUnknownQuantization'
  | 'tierFree'
  | 'free.off'
  | 'free.prefer'
  | 'free.only'
  | 'unknown.reject'
  | 'unknown.trusted'
  | 'unknown.accept'
  | 'trustedUnknownProviders'
  | 'judgeEnabled'
  | 'defaultTier'
  | 'cacheIdleMinutes'
  | 'freeForSubagents'
  | 'freeUsage'
  | 'free.unknown'
  | 'quote.perMillion'
  | 'quote.unavailable'
  | 'save'
  | 'discard'
  | 'unsaved'
  | 'conflict'
  | 'failed'
  | 'saving'
  | 'empty'
  | 'threadModel'
  | 'switch.title'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Model routing chip and settings page copy. */
    'settings.modelRouting': ModelRoutingLocaleKey
  }
}

/** English copy. */
export const en: LocaleDictOf<typeof NS> = {
  title: 'Model routing',
  summary: '{tiers} tiers, {models} models',
  'chip.unpinned': 'no provider pinned',
  'chip.pending': 'next request: {model}',
  'boundary.start': 'session start',
  'boundary.selection-change': 'model changed',
  'boundary.compaction': 'after compaction',
  'boundary.idle': 'after idle',
  'boundary.failure': 'after a provider failure',
  'tier.pro': 'pro',
  'tier.flash': 'flash',
  routeSettings: 'Route',
  tierTabsLabel: 'Tier',
  tierName: 'Tier name',
  tierLabel: 'Tier label',
  tierModels: 'Models',
  tierFilter: 'Filter models',
  tierContextWindow: 'Context window',
  tierMaxTokens: 'Output tokens',
  tierMinQuantization: 'Minimum quantization',
  tierUnknownQuantization: 'Unknown quantization',
  tierFree: 'Free endpoints',
  'free.off': 'do not use',
  'free.prefer': 'prefer',
  'free.only': 'only',
  'unknown.reject': 'reject',
  'unknown.trusted': 'trust listed providers',
  'unknown.accept': 'accept',
  trustedUnknownProviders: 'Trusted unknown-quantization providers',
  judgeEnabled: 'Choose the tier automatically',
  defaultTier: 'Default tier',
  cacheIdleMinutes: 'Re-decide after idle (minutes)',
  freeForSubagents: 'Allow free endpoints in subagents',
  freeUsage: 'Free requests today: {used} of {limit}',
  'free.unknown': 'Free requests today: unknown',
  'quote.perMillion': '{tag} · {quantization} · ${price}/M',
  'quote.unavailable': 'price unavailable',
  save: 'Save',
  discard: 'Discard',
  unsaved: 'Unsaved changes',
  conflict: 'These settings changed elsewhere. Discard and re-enter them.',
  failed: 'The settings could not be saved.',
  saving: 'Saving…',
  empty: 'No tier is configured, so this page has nothing to edit.',
  threadModel: 'model',
  'switch.title': 'Model switched',
}

/** Chinese copy. */
export const zh: LocaleDictOf<typeof NS> = {
  title: '模型路由',
  summary: '{tiers} 个层级，{models} 个模型',
  'chip.unpinned': '未固定服务商',
  'chip.pending': '下一个请求：{model}',
  'boundary.start': '会话开始',
  'boundary.selection-change': '模型已更改',
  'boundary.compaction': '压缩之后',
  'boundary.idle': '空闲之后',
  'boundary.failure': '服务商失败之后',
  'tier.pro': 'pro',
  'tier.flash': 'flash',
  routeSettings: '路由',
  tierTabsLabel: '层级',
  tierName: '层级名称',
  tierLabel: '层级标签',
  tierModels: '模型',
  tierFilter: '筛选模型',
  tierContextWindow: '上下文窗口',
  tierMaxTokens: '输出令牌',
  tierMinQuantization: '最低量化精度',
  tierUnknownQuantization: '未知量化精度',
  tierFree: '免费端点',
  'free.off': '不使用',
  'free.prefer': '优先',
  'free.only': '仅使用',
  'unknown.reject': '拒绝',
  'unknown.trusted': '信任列出的服务商',
  'unknown.accept': '接受',
  trustedUnknownProviders: '信任的未知量化服务商',
  judgeEnabled: '自动选择层级',
  defaultTier: '默认层级',
  cacheIdleMinutes: '空闲后重新决策（分钟）',
  freeForSubagents: '允许子代理使用免费端点',
  freeUsage: '今日免费请求：{used} / {limit}',
  'free.unknown': '今日免费请求：未知',
  'quote.perMillion': '{tag} · {quantization} · ${price}/M',
  'quote.unavailable': '价格不可用',
  save: '保存',
  discard: '放弃',
  unsaved: '未保存的更改',
  conflict: '这些设置已被其他更改修改。请放弃后重新填写。',
  failed: '设置未能保存。',
  saving: '保存中…',
  empty: '未配置层级，此页面没有可编辑的内容。',
  threadModel: '模型',
  'switch.title': '模型已切换',
}
