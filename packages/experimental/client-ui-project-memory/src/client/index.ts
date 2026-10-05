/**
 * The Project memory settings page, browser half: the entry count and entry
 * length a Project's shared memory is bounded by, over the `project-memory`
 * namespace the Project memory service registers. The page registers into the
 * Plugins page's `plugins.item` slot while the Host serves that namespace, so a
 * deployment with no Project memory shows no trace of it.
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
import { ProjectMemoryCard } from './ProjectMemoryCard.tsx'
import { PROJECT_MEMORY_NS, ProjectMemoryCardController } from './project-memory-card-controller.ts'
import { en, zh, type ProjectMemorySettingsLocaleKey } from './locales.ts'

export type { ProjectMemoryCardProps } from './ProjectMemoryCard.tsx'
export type {
  PROJECT_MEMORY_NS, ProjectMemoryCardFace, ProjectMemoryCardState, ProjectMemorySettings,
} from './project-memory-card-controller.ts'
export type { ProjectMemorySettingsLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Project memory settings page copy. */
    'settings.projectMemory': ProjectMemorySettingsLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.projectMemory'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'configForms']

/**
 * Mount the Project memory settings page while the Host serves its namespace.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-project-memory: dictionaries')
  const card = new ProjectMemoryCardController(ctx.configForms.get(PROJECT_MEMORY_NS))
  ctx.effect(() => () => { card.dispose() }, 'ui-project-memory: form subscription')
  ctx.effect(() => ctx.configForms.whileServed([PROJECT_MEMORY_NS], () => ctx.slots.inject('plugins.item', () => ctx.slots.register({
    name: 'plugins.item', id: PROJECT_MEMORY_NS, order: 60, label: () => t('title'), locale: NS, inject: () => card.inject(),
  }, ProjectMemoryCard))), 'ui-project-memory: page')
}
