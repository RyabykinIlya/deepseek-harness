/**
 * The web-search settings page, browser half: which provider the web seam
 * selects, plus one block per served provider carrying its key, endpoint, and
 * per-request search budget. The selector and the blocks register into the
 * Plugins page's `plugins.item` slot while the Host serves the `web` namespace
 * and each provider's own, so a deployment without the seam shows no trace of
 * any of them.
 */

// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the ctx.configForms Context merge. Cross-plugin collaboration
// goes through the service, never a value import (client bundle purity gate).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the Plugins page's SlotMap merge (the 'plugins.item' entry).
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the ctx.remote Context merge and the forwarded-event key face.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { WebSearchCard } from './WebSearchCard.tsx'
import { WebSearchSelectionCard } from './WebSearchSelectionCard.tsx'
import {
  WEB_SEARCH_PROVIDERS, WebSearchCardController, type WebSearchProviderId,
} from './web-search-card-controller.ts'
import { WEB_SEAM_NS, WebSearchSelectionController } from './web-search-selection-controller.ts'
import { en, zh, type WebSearchSettingsLocaleKey } from './locales.ts'

export type { WebSearchCardProps } from './WebSearchCard.tsx'
export type { WebSearchSelectionCardProps } from './WebSearchSelectionCard.tsx'
export type { WebSearchCardFace, WebSearchCardState, WebSearchSettings } from './web-search-card-controller.ts'
export type {
  WebSearchSelectionFace, WebSearchSelectionState, WebSearchSelectableId, WebSeamSettings,
} from './web-search-selection-controller.ts'
export type { WebSearchSettingsLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Web-search settings page copy. */
    'settings.webSearch': WebSearchSettingsLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.webSearch'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'remote', 'remote.credentials', 'configForms']

/**
 * Which dictionary key names each provider in the page's own list.
 *
 * The provider id is what the Host records in `web.searchProvider`; the label
 * is only how a person tells the rows apart.
 */
const PROVIDER_LABEL: Readonly<Record<WebSearchProviderId, 'providerDeepseek' | 'providerBrave' | 'providerTavily'>> = {
  'deepseek-official': 'providerDeepseek',
  brave: 'providerBrave',
  tavily: 'providerTavily',
}

/**
 * Mount the provider selector, then one web-search settings block per provider
 * the Host serves.
 *
 * The selector comes first and stands alone because `web.searchProvider` is one
 * global value on one namespace, not a per-provider one: it decides which
 * provider wins, so rendering it inside each block would show the same single
 * choice N times. The blocks that follow each own a namespace of their own, so a
 * key is configured against the provider that will actually use it rather than
 * against whichever one happened to be mounted first. A provider that is not
 * loaded never reaches `whileServed` and contributes nothing to the page.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-web-search: dictionaries')
  const selection = new WebSearchSelectionController(ctx.configForms.get(WEB_SEAM_NS))
  ctx.effect(() => () => { selection.dispose() }, 'ui-settings-web-search: provider selection form subscription')
  ctx.effect(() => ctx.configForms.whileServed([WEB_SEAM_NS], () => ctx.slots.inject('plugins.item', () => ctx.slots.register({
    name: 'plugins.item',
    id: 'web-search-provider',
    order: 10,
    label: () => t('searchProvider'),
    locale: NS,
    inject: () => selection.inject(),
  }, WebSearchSelectionCard))), 'ui-settings-web-search: provider selection page')
  for (const provider of WEB_SEARCH_PROVIDERS) {
    const card = new WebSearchCardController(ctx.configForms.get(provider.namespace), ctx, provider)
    ctx.effect(() => () => { card.dispose() }, `ui-settings-web-search: ${provider.id} form subscription`)
    // The credential the page reports is not part of any settings section, so
    // its scope publishes nothing when one is written. This is the only signal
    // that a key written on another surface reached the Host.
    ctx.effect(
      () => ctx.remote.$on('credentials/reference-updated', (ref) => { card.refreshCredential(ref) }),
      `ui-settings-web-search: ${provider.id} credential invalidations`,
    )
    ctx.effect(() => ctx.configForms.whileServed([provider.namespace], () => ctx.slots.inject('plugins.item', () => ctx.slots.register({
      name: 'plugins.item',
      id: `web-search-${provider.id}`,
      order: 40,
      label: () => t(PROVIDER_LABEL[provider.id]),
      locale: NS,
      inject: () => card.inject(),
    }, WebSearchCard))), `ui-settings-web-search: ${provider.id} page`)
  }
}
