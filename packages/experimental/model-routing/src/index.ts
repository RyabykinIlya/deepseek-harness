/**
 * The `tiers` model route: one Host plugin that registers the LLM route, the
 * `modelRouting` projection, and `ctx.modelRouting`.
 *
 * Mount it with at least one tier configured; with none, the route advertises an
 * empty model list and stays dormant, which is the posture the profile bundle
 * ships in before a user has said which models they use.
 *
 * @module @deepseek-ai/dsh-experimental-model-routing
 */

import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { ModelRoutingService } from './service.ts'

export * from './types.ts'
export {
  Config,
  DEFAULT_TRUSTED_UNKNOWN_PROVIDERS,
  QUANTIZATIONS,
  readSettings,
  validateSettings,
} from './config.ts'
export type {
  Config as RoutingConfig,
  FreeMode,
  ModelInput,
  PresetRoute,
  PresetRouteSnapshot,
  Quantization,
  RoutingSettings,
  SnapshotPolicy,
  TierSettings,
  TierSettingsSnapshot,
} from './config.ts'
export { resolveModelFamily } from './family.ts'
export type { FamilyResolution } from './family.ts'
export { FamilyCache } from './family-cache.ts'
export type { CatalogReader, FamilyResolutionBatch } from './family-cache.ts'
export { QUANTIZATION_RANK, quantizationRank, quantizationsAtOrAbove } from './quantization.ts'
export {
  baseSlugOf,
  blendedPrice,
  defaultMix,
  mixFromUsage,
  policyFor,
  rankEndpoints,
  rankWithRelaxation,
  rejectionOf,
} from './select.ts'
export type {
  EndpointLists,
  EndpointRejection,
  RankedEndpoint,
  SelectionPolicy,
  SelectionResult,
  TurnMix,
  UsageTotals,
} from './select.ts'
export {
  applyModelRoutingEvent,
  emptyModelRoutingState,
  modelRoutingProjectionDefinition,
  modelRoutingView,
} from './projection.ts'
export type { ModelRoutingEventType } from './projection.ts'
export { EFFORT_ORDER, mapEffort } from './effort.ts'
export { boundaryOf } from './boundary.ts'
export type { BoundaryInput } from './boundary.ts'
export { readRoutedReplay, unwrapHistory, wrapReplay } from './replay.ts'
export type { RoutedReplayResponse } from './replay.ts'
export { DecisionResponseSchema, askJudge, judgeQuestions, judgeState, tierFromVerdict } from './judge.ts'
export type { DecisionResponse, JudgeRequest, JudgeState } from './judge.ts'
export { MODEL_ROUTING_NO_ENDPOINT_CODE, MODEL_ROUTING_UNAVAILABLE_CODE, TiersAdapter } from './adapter.ts'
export type { TiersAdapterDeps, TiersRoute } from './adapter.ts'
export { EndpointsCache } from './endpoints-cache.ts'
export type { EndpointsReader } from './endpoints-cache.ts'
export { KeyInfo } from './key-info.ts'
export type { KeyInfoDeps } from './key-info.ts'
export { resolveApiKeyRef, resolveKey } from './credentials.ts'
export { routingEndpointOf } from './endpoint.ts'
export { ModelRoutingService } from './service.ts'

// The profile row id (`model-routing`) names the settings namespace these
// `.volatile()` fields form; the Cordis service key is `modelRouting`.
export default ModelRoutingService
