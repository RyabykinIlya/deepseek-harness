/**
 * A Thread's routing decision, as the roster reads it.
 *
 * The Session Controller publishes every projection key it holds into one
 * untyped map, so this reads defensively: a block from a Host without the
 * routing plugin is simply absent, and a block whose fields changed shape is
 * rejected rather than rendered as a half-truth. A roster row that names a tier
 * with no model beside it would be worse than no routing information at all.
 */

import type { ModelRoutingView } from '@deepseek-ai/dsh-experimental-model-routing/client'

/** The per-Session projection block map one list snapshot carries. */
type ProjectionBlocks = Readonly<Record<string, { values?: Record<string, unknown> }>>

/** The projection key this reader addresses. */
const MODEL_ROUTING_KEY = 'modelRouting'

/** Whether one candidate really is a routing view, field by field. */
function isRoutingView(value: unknown): value is ModelRoutingView {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const view = value as Record<string, unknown>
  return typeof view.requested === 'string'
    && typeof view.tier === 'string'
    && typeof view.model === 'string'
    && typeof view.boundary === 'string'
    && typeof view.decidedAt === 'number'
    && typeof view.unpinned === 'boolean'
    && (view.providerName === undefined || typeof view.providerName === 'string')
}

/**
 * Read one Thread's routing decision out of the projection map.
 * @param blocks - the per-Session projection blocks of the current snapshot.
 * @param threadId - the Thread whose decision the row renders.
 * @returns the published view, or `undefined` when no block carries a valid one.
 */
export function readThreadModel(blocks: ProjectionBlocks, threadId: string): ModelRoutingView | undefined {
  const value = Reflect.get(blocks[threadId]?.values ?? {}, MODEL_ROUTING_KEY)
  return isRoutingView(value) ? value : undefined
}

/**
 * Format one routing view for the roster's metadata line.
 *
 * The provider matters most while several Threads run on different tiers at
 * once: the tier and model can match on two Threads that a different upstream
 * provider is actually serving, and that difference is what a failure is
 * attributed to. It is appended only when the route pinned one — before the
 * first decision, and for an endpoint the catalog does not name, there is
 * nothing honest to show.
 * @param view - the Thread's published routing decision.
 * @returns `<tier> <model>` with the `author/` prefix stripped, plus ` · <provider>` when pinned.
 */
export function threadModelLabel(view: ModelRoutingView): string {
  const slash = view.model.indexOf('/')
  const model = slash === -1 ? view.model : view.model.slice(slash + 1)
  const base = `${view.tier} ${model}`
  return view.providerName === undefined ? base : `${base} · ${view.providerName}`
}
