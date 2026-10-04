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
import type { JudgeRule, ModelRoutingState, ModelRoutingView, RoutingBoundary, RoutingEndpoint } from './types.ts'

const routingBoundarySchema = z.enum(['start', 'selection-change', 'compaction', 'idle', 'failure'])

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
  endpoint: routingEndpointSchema.optional(),
  unpinnedReason: z.string().optional(),
  blendedUsdPerToken: z.number().optional(),
  relaxedUptime: z.literal(true).optional(),
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
  }
}

/** Whether one event belongs to the model-routing domain. */
export type ModelRoutingEventType =
  | 'model-routing/decision'
  | 'model-routing/tier-override'
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
    default:
      return state
  }
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
    model: decision.model,
    ...decision.endpoint?.providerName === undefined ? {} : { providerName: decision.endpoint.providerName },
    ...decision.endpoint?.quantization === undefined ? {} : { quantization: decision.endpoint.quantization },
    boundary: decision.boundary,
    decidedAt,
    unpinned: decision.endpoint === undefined,
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

export type { RoutingBoundary, RoutingEndpoint, JudgeRule }
