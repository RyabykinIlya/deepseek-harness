/**
 * The Threads settings page, browser half: the coordinator's progress and
 * approval cadence, plus the provider, model, reasoning effort, and output
 * ceiling every Thread runs on, over the `threads-preset` namespace the
 * Threads presets plugin registers. The page registers into the Plugins page's
 * `plugins.item` slot while the Host serves that namespace, so a deployment
 * with no Threads presets shows no trace of it.
 */

// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the ctx.configForms Context merge. Cross-plugin collaboration
// goes through the service, never a value import (client bundle purity gate).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the Plugins page's SlotMap merge (the 'plugins.item' entry).
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { ThreadsCard } from './ThreadsCard.tsx'
import { THREADS_PRESET_NS, ThreadsCardController } from './threads-card-controller.ts'
import { en, zh, type ThreadsSettingsLocaleKey } from './locales.ts'

export type { ThreadsCardProps } from './ThreadsCard.tsx'
export type {
  APPROVAL_POLICIES, ApprovalPolicy, CHECK_IN_POLICIES, CheckInPolicy, THREAD_MODEL_FIELDS, THREADS_PRESET_NS,
  ThreadModelField, ThreadsCardFace, ThreadsCardState, ThreadsSettings,
} from './threads-card-controller.ts'
export type { ThreadsSettingsLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Threads settings page copy. */
    'settings.threads': ThreadsSettingsLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.threads'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'configForms']

/**
 * Mount the Threads settings page while the Host serves the presets namespace.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-threads: dictionaries')
  const card = new ThreadsCardController(ctx.configForms.get(THREADS_PRESET_NS))
  ctx.effect(() => () => { card.dispose() }, 'ui-settings-threads: form subscription')
  ctx.effect(() => ctx.configForms.whileServed([THREADS_PRESET_NS], () => ctx.slots.inject('plugins.item', () => ctx.slots.register({
    name: 'plugins.item', id: 'threads-preset', order: 50, label: () => t('title'), locale: NS, inject: () => card.inject(),
  }, ThreadsCard))), 'ui-settings-threads: page')
}
