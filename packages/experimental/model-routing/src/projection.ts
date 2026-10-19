/**
 * The `modelRouting` Session projection: what model, provider, and tier the last
 * routing decision picked, plus the facts the next decision reads to decide
 * whether this one is still current.
 *
 * The fold is written to return the identical state reference for every event it
 * does not own, because the registry caches views by state identity: a
 * conversation that streams tokens would otherwise rebuild the composer's chip
 * on every chunk. That is also why `compactedSinceDecision` and
 * `explicitSelection` return the same reference when they are already set —
 * repeating a fact is not a state change.
 *
 * @module dsh-experimental-model-routing/projection
 */

import { z } from 'zod'
import type { SessionEvent, SessionEventMap, SessionHeader, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { DEFAULT_OPENROUTER_FALLBACK } from './config.ts'
import type { JudgeRule, ModelRoutingState, ModelRoutingView, RoutingBoundary, RoutingDecision, RoutingEndpoint, RoutingSource } from './types.ts'

const routingBoundarySchema = z.enum(['start', 'selection-change', 'compaction', 'idle', 'failure'])

const routingSourceSchema = z.object({
  kind: z.string(),
  tag: z.string(),
}).strict()

const routingEndpointSchema = z.object({
  tag: z.string(),
  providerName: z.string().optional(),
  quantization: z.string().optional(),
  promptUsd: z.number(),
  completionUsd: z.number(),
  cacheReadUsd: z.number().optional(),
  contextLength: z.number().optional(),
  maxCompletionTokens: z.number().optional(),
}).strict()

const judgeRuleSchema = z.enum([
  'judge-error', 'precision', 'low-confidence', 'start-pro', 'start-flash',
  'to-pro', 'to-flash', 'keep', 'judge-off',
])

const judgeVerdictSchema = z.object({
  model: z.string(),
  answeredBy: z.string().optional(),
  pPro: z.number().optional(),
  confidence: z.number().optional(),
  difficulty: z.number().optional(),
  precision: z.number().optional(),
  costUsd: z.number().optional(),
  latencyMs: z.number(),
  rule: judgeRuleSchema,
  error: z.string().optional(),
}).strict()

const decisionSchema = z.object({
  boundary: routingBoundarySchema,
  requested: z.string(),
  tier: z.string(),
  judge: judgeVerdictSchema.optional(),
  model: z.string(),
  source: routingSourceSchema.optional(),
  endpoint: routingEndpointSchema.optional(),
  unpinnedReason: z.string().optional(),
  blendedUsdPerToken: z.number().optional(),
  relaxedUptime: z.literal(true).optional(),
  imagesOmitted: z.literal(true).optional(),
  considered: z.number(),
  runnersUp: z.array(z.object({
    model: z.string(),
    tag: z.string(),
    blendedUsdPerToken: z.number(),
  }).strict()),
  excludedTags: z.array(z.string()),
}).strict() as z.ZodType<SessionEventMap['model-routing/decision']>

const overridesSchema = z.record(z.string(), z.string())

const modelRoutingStateSchema = z.object({
  decision: decisionSchema.nullable(),
  decidedAt: z.number().nullable(),
  lastResponseAt: z.number().nullable(),
  compactedSinceDecision: z.boolean(),
  explicitSelection: z.boolean(),
  overrides: overridesSchema,
  openRouterFallback: z.boolean().nullable(),
}).strict() as z.ZodType<ModelRoutingState>

// Nullable because the registry validates every published value, and the value
// before the first decision is `null`: a non-nullable schema rejects it and the
// rejection fails the whole snapshot, not just this unit's slot.
const modelRoutingViewSchema = z.object({
  requested: z.string(),
  tier: z.string(),
  model: z.string(),
  providerName: z.string().optional(),
  quantization: z.string().optional(),
  boundary: routingBoundarySchema,
  decidedAt: z.number(),
  unpinned: z.boolean(),
  openRouterFallback: z.boolean(),
}).strict().nullable() as z.ZodType<ModelRoutingView | null>

/**
 * The state of a Session that has never taken a routing decision.
 * @returns the empty model-routing state.
 */
export function emptyModelRoutingState(): ModelRoutingState {
  return {
    decision: null,
    decidedAt: null,
    lastResponseAt: null,
    compactedSinceDecision: false,
    explicitSelection: false,
    overrides: {},
    openRouterFallback: null,
  }
}

/** Whether one event belongs to the model-routing domain. */
export type ModelRoutingEventType =
  | 'model-routing/decision'
  | 'model-routing/tier-override'
  | 'model-routing/openrouter-fallback'
  | 'assistant/message'
  | 'assistant/attempt'
  | 'compaction/end'
  | 'model/selection'

/**
 * Fold one committed event into the model-routing state.
 *
 * `compaction/end` only counts when it succeeded: a compaction that failed left
 * the history intact, and treating it as a boundary would make the route
 * re-decide on a conversation nothing was actually removed from.
 * @param state - state covering every prior event.
 * @param event - the next committed Session event.
 * @returns the next state, or the same reference when the event is not the unit's.
 */
export function applyModelRoutingEvent(state: ModelRoutingState, event: SessionEvent): ModelRoutingState {
  switch (event.type) {
    case 'model-routing/decision':
      return {
        ...state,
        decision: event.data,
        decidedAt: event.time,
        compactedSinceDecision: false,
      }
    case 'assistant/message':
    case 'assistant/attempt':
      return state.lastResponseAt === event.time ? state : { ...state, lastResponseAt: event.time }
    case 'compaction/end': {
      if (state.decision === null || state.compactedSinceDecision) return state
      if (event.data.error !== undefined) return state
      return { ...state, compactedSinceDecision: true }
    }
    case 'model/selection':
      return state.explicitSelection ? state : { ...state, explicitSelection: true }
    case 'model-routing/tier-override': {
      const { threadId, tier } = event.data
      return { ...state, overrides: { ...state.overrides, [threadId]: tier } }
    }
    case 'model-routing/openrouter-fallback':
      return state.openRouterFallback === event.data.enabled
        ? state
        : { ...state, openRouterFallback: event.data.enabled }
    default:
      return state
  }
}

/**
 * The model id a decision's request dispatched.
 *
 * An OpenRouter decision dispatches the model it ranked, so the decision's own
 * id is already the dispatched one. A direct source ranks under a canonical id
 * but dispatches its route's own id, which is the only id a request to that
 * route carried. A decision recorded before `source` existed names no route id,
 * and its canonical id is the only id it has.
 * @param decision - the decision whose dispatched model to read.
 * @returns the model id the request carried.
 */
function dispatchedModel(decision: RoutingDecision): string {
  const { source } = decision
  if (source === undefined || source.kind === 'openrouter') return decision.model
  return source.tag
}

/**
 * Project what the composer chip and the Threads roster render.
 * @param state - current model-routing state.
 * @returns the current decision's view, or `null` before the first decision.
 */
export function modelRoutingView(state: ModelRoutingState): ModelRoutingView | null {
  const { decision, decidedAt } = state
  if (decision === null || decidedAt === null) return null
  return {
    requested: decision.requested,
    tier: decision.tier,
    model: dispatchedModel(decision),
    ...decision.endpoint?.providerName === undefined ? {} : { providerName: decision.endpoint.providerName },
    ...decision.endpoint?.quantization === undefined ? {} : { quantization: decision.endpoint.quantization },
    boundary: decision.boundary,
    decidedAt,
    unpinned: decision.endpoint === undefined,
    // A decision recorded before the switch existed names no value, and the
    // deployment default of that day was the same one this constant states.
    openRouterFallback: state.openRouterFallback
      ?? decision.openRouterFallback
      ?? DEFAULT_OPENROUTER_FALLBACK,
  }
}

/** Model-routing projection keyed by the projected Session identity. */
export const modelRoutingProjectionDefinition = {
  key: 'modelRouting',
  stateVersion: 1,
  stateSchema: modelRoutingStateSchema,
  init: (_header: SessionHeader, _inheritedEventCount: SessionLogOffset) => emptyModelRoutingState(),
  apply: applyModelRoutingEvent,
  wire: { viewSchema: modelRoutingViewSchema, view: modelRoutingView },
} satisfies ProjectionDefinition<'modelRouting', ModelRoutingState>

export type { RoutingBoundary, RoutingEndpoint, RoutingSource, JudgeRule }
