/**
 * The model-switch conversation node: one durable row per decision that moved
 * the session onto a different model or a different route.
 *
 * The composer chip already names the model that is answering, but it only ever
 * shows the LATEST decision: a turn that began on one route and finished on
 * another leaves no trace of the change in the transcript. That silence is the
 * problem this node solves — a retry that stays on the same route is already
 * visible as a `model-retry` row, so the missing half is the moment the route
 * itself changed, and it has to read as a deliberate, named event rather than
 * as an unexplained shift in writing style.
 *
 * Each decision owns one Context keyed by its event seq, and `start` reads the
 * preceding decision through the Context reader. That comparison is why this
 * node needs no new session event: `model-routing/decision` already records
 * every boundary, and the previous decision is reachable from the current one.
 *
 * @module @deepseek-ai/dsh-experimental-client-ui-model-routing/model-switch
 */

import type { Context } from '@deepseek-ai/cordis'
import type {
  ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the `ChatNodeDataMap` registry this module augments and the
// `ChatConversationViewNode` this Definition publishes.
import type { ChatConversationViewNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { RoutingBoundary, RoutingDecision } from '@deepseek-ai/dsh-experimental-model-routing/types'

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    /** One decision that moved the session to a different model or route. */
    'model-switch': ModelSwitchData
  }
}

/** Where one decision sent its requests: what the transcript names it by. */
export interface ModelSwitchServing {
  /** Concrete model id that served the request. */
  readonly model: string
  /** Route the model was dispatched on, for example `claude-proxy`. */
  readonly route: string
}

/** Payload of one model-switch row. */
export interface ModelSwitchData {
  readonly seq: number
  readonly time: number
  /** What was pinned before this decision. */
  readonly from: ModelSwitchServing
  /** What this decision pinned. */
  readonly to: ModelSwitchServing
  /** Why the route was allowed to re-decide. */
  readonly boundary: RoutingBoundary
}

/** Folded state of one decision Context: what it chose, and whether it moved. */
export interface ModelSwitchState {
  readonly seq: number
  readonly time: number
  readonly serving: ModelSwitchServing | undefined
  /** Present ⇔ this decision moved the session onto a different serving. */
  readonly moved?: {
    readonly from: ModelSwitchServing
    readonly to: ModelSwitchServing
    readonly boundary: RoutingBoundary
  }
}

/**
 * What one decision sent its requests on.
 *
 * A direct source dispatches the id it was configured under, so `source.tag` is
 * the model and `source.kind` the route. An OpenRouter decision carries the same
 * fact in two places depending on whether a concrete endpoint was pinned: a
 * pinned endpoint is named by its slug, an unpinned one only by the model.
 * @param decision - the recorded routing decision.
 * @returns the serving, or undefined when the decision names neither.
 */
export function servingOf(decision: RoutingDecision): ModelSwitchServing | undefined {
  if (decision.source !== undefined && decision.source.kind !== 'openrouter') {
    return { model: decision.source.tag, route: decision.source.kind }
  }
  const route = decision.endpoint?.tag ?? decision.source?.tag
  if (route === undefined) return undefined
  return { model: decision.model, route }
}

/** Whether two servings name the same model on the same route. */
function sameServing(left: ModelSwitchServing | undefined, right: ModelSwitchServing | undefined): boolean {
  return left?.model === right?.model && left?.route === right?.route
}

/**
 * Model-switch Definition.
 *
 * One Context per decision, keyed by `seq`: decisions are independent facts, and
 * sharing one Context across them would keep only the last change of a multi-step
 * turn. A decision that names nothing dispatchable is skipped rather than
 * reported, because the row's whole claim is that a named model took over.
 */
export const modelSwitchDefinition: ConversationNodeDefinition<ModelSwitchState> = {
  kind: 'model-switch',
  target: 'chat',
  match: (event) => {
    if (event.type !== 'model-routing/decision') return null
    const seq: unknown = event.seq
    return typeof seq === 'number' ? { id: String(seq), role: 'start' } : null
  },
  start: (_context, match, reader) => {
    const event = match.event
    if (event.type !== 'model-routing/decision') throw new Error('model-switch start requires a routing decision')
    const decision = event.data as RoutingDecision
    const serving = servingOf(decision)
    const before = reader.previous<ModelSwitchState>('model-switch')?.state.serving
    const moved = serving === undefined || before === undefined || sameServing(before, serving)
      ? undefined
      : { from: before, to: serving, boundary: decision.boundary }
    return {
      seq: event.seq as number,
      time: event.time,
      serving,
      ...moved === undefined ? {} : { moved },
    }
  },
  update: context => context.state,
  buildViewNode: (context) => {
    const state = context.state
    if (state?.moved === undefined) return null
    return {
      key: context.key,
      kind: 'model-switch',
      id: context.id,
      target: 'chat',
      anchorSeq: state.seq,
      location: context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' as const },
      visibility: 'visible',
      data: {
        seq: state.seq,
        time: state.time,
        from: state.moved.from,
        to: state.moved.to,
        boundary: state.moved.boundary,
      } satisfies ModelSwitchData,
    } as ChatConversationViewNode
  },
}

/**
 * Register the model-switch business contribution.
 * @param ctx - owning UI Conversation context.
 */
export function registerModelSwitchConversationNode(ctx: Context): void {
  ctx.uiConversation.events.register(modelSwitchDefinition)
}
