/** Locale bundles for the web-search provider's settings page. */

import type { SettingsFormLabels } from '@deepseek-ai/dsh-client-ui-primitives'

/** Locale keys the page renders. */
export type WebSearchSettingsLocaleKey =
  | 'title' | 'description'
  | 'searchProvider' | 'searchProviderDescription' | 'searchProviderHint'
  | 'searchProviderAuto' | 'searchProviderUnknown'
  | 'apiKey' | 'apiKeyHint' | 'apiKeySet' | 'apiKeyUnset'
  | 'baseUrl' | 'baseUrlHint' | 'maxUses' | 'maxUsesHint'
  | 'maxResults' | 'maxResultsHint' | 'numResults' | 'numResultsHint'
  | 'timeoutMs' | 'timeoutMsHint' | 'maxContentChars' | 'maxContentCharsHint'
  | 'overridden' | 'reset' | 'readOnly' | 'unavailable'
  | 'save' | 'saving' | 'saveFailed' | 'invalidNumber'
  | 'providerDeepseek' | 'providerBrave' | 'providerTavily'
  | 'providerDuckduckgo' | 'providerExa' | 'providerPerplexity'

/** English copy. */
export const en: Record<WebSearchSettingsLocaleKey, string> = {
  title: 'Web search',
  description: 'Set up a search provider and its key.',
  searchProvider: 'Search provider',
  searchProviderDescription: 'Choose which provider the search tool uses.',
  searchProviderHint: 'Automatic uses the only usable provider. A provider this deployment does not load cannot search.',
  searchProviderAuto: 'Automatic',
  searchProviderUnknown: '{id} (not a provider this page offers)',
  apiKey: 'API key',
  apiKeyHint: 'Stored outside the settings file. Leave blank to keep the current key.',
  apiKeySet: 'A key is configured.',
  apiKeyUnset: 'No key is configured. Search uses this provider only while a key is set.',
  baseUrl: 'Endpoint',
  baseUrlHint: 'Leave blank to use the provider default.',
  maxUses: 'Max searches per request',
  maxUsesHint: 'How many times one request may search before it must answer.',
  // Brave's own cap is 20; the request is clamped rather than refused.
  maxResults: 'Max results per search',
  maxResultsHint: 'How many sources to ask Brave for when a search sets no bound of its own. Brave returns at most 20.',
  numResults: 'Max results per search',
  numResultsHint: 'How many results to ask Tavily for when a search sets no bound of its own.',
  timeoutMs: 'Request timeout (ms)',
  timeoutMsHint: 'How long the provider has to answer one search before it is treated as failed.',
  // Tavily answers with extracted page text rather than a result snippet.
  maxContentChars: 'Snippet length (characters)',
  maxContentCharsHint: 'Character cap on one result\'s snippet. Tavily answers with extracted page text, which runs longer than a result usually needs.',
  overridden: 'Overridden',
  reset: 'Reset to default',
  readOnly: 'This deployment stores settings read-only.',
  unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
  save: 'Save',
  saving: 'Saving…',
  saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
  invalidNumber: 'Enter a number, or leave blank to use the default.',
  providerDeepseek: 'DeepSeek',
  providerBrave: 'Brave Search',
  providerTavily: 'Tavily',
  providerDuckduckgo: 'DuckDuckGo',
  providerExa: 'Exa',
  providerPerplexity: 'Perplexity',
}

/** Simplified Chinese copy. */
export const zh: Record<WebSearchSettingsLocaleKey, string> = {
  title: '网页搜索',
  description: '设置搜索提供方及其密钥。',
  searchProvider: '搜索提供方',
  searchProviderDescription: '选择搜索工具使用哪个提供方。',
  searchProviderHint: '自动表示使用唯一可用的提供方。本部署未加载的提供方无法搜索。',
  searchProviderAuto: '自动',
  searchProviderUnknown: '{id}（非本页提供的提供方）',
  apiKey: 'API Key',
  apiKeyHint: '不写入设置文件。留空表示保持当前密钥。',
  apiKeySet: '已配置密钥。',
  apiKeyUnset: '未配置密钥。仅在设置密钥后才会使用该提供方搜索。',
  baseUrl: '接口地址',
  baseUrlHint: '留空则使用提供方默认地址。',
  maxUses: '单次请求最多搜索次数',
  maxUsesHint: '一次请求在必须作答前最多可以搜索多少次。',
  // Brave 自身上限为 20，超出时会被截断而非拒绝。
  maxResults: '每次搜索最多结果数',
  maxResultsHint: '当一次搜索没有自带数量上限时，向 Brave 请求多少条结果。Brave 最多返回 20 条。',
  numResults: '每次搜索最多结果数',
  numResultsHint: '当一次搜索没有自带数量上限时，向 Tavily 请求多少条结果。',
  timeoutMs: '请求超时（毫秒）',
  timeoutMsHint: '一次搜索在判定为失败前，允许提供方作答的时长。',
  // Tavily 返回的是抽取出的网页正文，而非结果摘要。
  maxContentChars: '摘要长度（字符）',
  maxContentCharsHint: '单条结果摘要的字符上限。Tavily 返回的是抽取出的网页正文，通常长于搜索结果本身。',
  overridden: '已覆盖',
  reset: '恢复默认',
  readOnly: '本部署的设置为只读。',
  unavailable: '该插件当前未加载，暂时无法配置。',
  save: '保存',
  saving: '保存中…',
  saveFailed: '本部署没有接受这些值，已保留供你修改。',
  invalidNumber: '请填数字；留空表示使用默认值。',
  providerDeepseek: 'DeepSeek',
  providerBrave: 'Brave Search',
  providerTavily: 'Tavily',
  providerDuckduckgo: 'DuckDuckGo',
  providerExa: 'Exa',
  providerPerplexity: 'Perplexity',
}

/**
 * The form frame's copy, read from this page's dictionary.
 * @param t - the page's locale reader.
 * @returns the labels the shared settings form renders.
 */
export function formLabels(t: (key: WebSearchSettingsLocaleKey) => string): SettingsFormLabels {
  return { unavailable: t('unavailable'), readOnly: t('readOnly'), saveFailed: t('saveFailed'), save: t('save'), saving: t('saving') }
}
