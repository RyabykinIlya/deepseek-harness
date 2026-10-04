/**
 * Model routing, browser half: the `modelRouting` Remote namespace, the composer
 * chip that names the tier and the model that answered, and the settings page
 * that says which models belong to which tier.
 *
 * All three are conditional on the Host serving the `model-routing` namespace.
 * A deployment without the routing plugin has no tiers, no decisions, and no
 * prices to show, so the surfaces withdraw rather than render empty frames.
 */

// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the ctx.configForms Context merge. Cross-plugin collaboration goes
// through the service, never a value import (client bundle purity gate).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the Plugins page's SlotMap merge (the 'plugins.item' entry).
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the composer's input-bar slot map (`conversation.input.right`).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: the `ctx.remote` merge and session projection props.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
// Type-only: the generated `modelRouting` Remote namespace.
import type {} from '@deepseek-ai/dsh-experimental-model-routing/remote'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import modelRoutingRemote from '@deepseek-ai/dsh-experimental-model-routing/remote'
import { ModelRoutingCard } from './ModelRoutingCard.tsx'
import { ModelRoutingChip } from './ModelRoutingChip.tsx'
import { MODEL_ROUTING_NS, ModelRoutingCardController } from './model-routing-card-controller.ts'
import { en, NS, zh } from './locales.ts'

export type { ModelRoutingCardProps } from './ModelRoutingCard.tsx'
export type { ModelRoutingChipProps } from './ModelRoutingChip.tsx'
export type {
  ModelRoutingCardFace,
  ModelRoutingCardState,
  ModelRoutingSettings,
  TierRow,
} from './model-routing-card-controller.ts'
export { MODEL_ROUTING_NS, pricePerMillion, quoteRow, quoteRowKey, splitList } from './model-routing-card-controller.ts'
export { ModelRoutingCard, cardShell, formLabels } from './ModelRoutingCard.tsx'
export { ModelRoutingChip, shortModel } from './ModelRoutingChip.tsx'
export { en, zh } from './locales.ts'
export type { ModelRoutingLocaleKey } from './locales.ts'

/** Services required before the surfaces register. */
export const inject = ['slots', 'locale', 'remote', 'remote.session', 'configForms']

/**
 * Mount the `modelRouting` Remote namespace and register both surfaces.
 *
 * The Remote namespace is mounted here rather than in a shipped Remote assembly,
 * so the experimental package never becomes a dependency of the product's
 * `dsh-api-remotes` bundle.
 * @param ctx - the browser plugin context.
 */
export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(modelRoutingRemote)
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-model-routing: dictionaries')

  // The chip reads one projection and needs no settings, so it mounts whenever the
  // conversation surface offers its seat.
  ctx.inject(['slots'], (scope: ClientContext) => {
    scope.slots.inject('conversation.input.right', () => scope.slots.register({
      name: 'conversation.input.right',
      id: 'model-routing',
      order: 50,
      locale: NS,
    }, ModelRoutingChip))
  })

  // The page edits the Host's own `model-routing` namespace, so it appears only
  // while that namespace is served.
  const controller = new ModelRoutingCardController(ctx.configForms.get(MODEL_ROUTING_NS), ctx)
  ctx.effect(() => () => { controller.dispose() }, 'ui-model-routing: card subscription')
  const face = controller.inject()
  ctx.effect(() => ctx.configForms.whileServed([MODEL_ROUTING_NS], () => ctx.slots.inject('plugins.item', () => ctx.slots.register({
    name: 'plugins.item',
    id: 'model-routing',
    order: 35,
    label: () => t('title'),
    locale: NS,
    inject: () => face,
  }, ModelRoutingCard))), 'ui-model-routing: settings page')
  ctx.effect(
    () => ctx.remote.$on('llm/adapters-updated', () => { controller.refreshCatalog() }),
    'ui-model-routing: adapter invalidations',
  )
  return disposeRemote
}
