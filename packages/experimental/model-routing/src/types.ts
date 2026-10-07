/**
 * Shared type vocabulary for the `tiers` route: session events, the model-routing
 * projection, the Host-side control surface, and the judge's rule tags.
 *
 * Types only — nothing here reads or writes. Every `declare module` below widens
 * a registry other packages already own, which is why the events are declared here
 * and registered by the projection in `projection.ts`: a Session log must be able
 * to record `model-routing/decision` from any plugin that folds projections.
 *
 * @module dsh-experimental-model-routing/types
 */

import type { Session } from '@deepseek-ai/dsh-session'
// The two events the fold reads but does not own: a Session log carrying them
// must be typable without this package, so their shapes come from the packages
// that write them. Nothing is imported but the declaration.
import type {} from '@deepseek-ai/dsh-api-session-controller/types'
import type {} from '@deepseek-ai/dsh-compaction'
import type { FreeMode, Quantization } from './config.ts'
import type { EndpointRejection, MeasuredMix, RequiredInput } from './select.ts'

/** The moments at which the route may take a fresh decision. */
export type RoutingBoundary = 'start' | 'selection-change' | 'compaction' | 'idle' | 'failure'

/**
 * The source of one pinned or ranked candidate: an OpenRouter endpoint, or a
 * model served by its own pi-ai route. A decision records this so a log can say
 * *which kind* of upstream answered, and `restorePin` can rebuild a pin that
 * dispatches through the right route after a Host restart.
 */
export interface RoutingSource {
  /**
   * `openrouter` for an OpenRouter endpoint, or the pi-ai route key that
   * dispatches a direct source.
   */
  kind: string
  /** The model id the dispatch carries: an endpoint tag, or the route's own model id. */
  tag: string
}

/**
 * One upstream endpoint as the decision pinned it; prices are USD per token.
 *
 * A direct source states its own prices, and only those it actually declared:
 * silence there means "not priced here" rather than the zero an OpenRouter
 * endpoint's unstated price is recorded as.
 */
export interface RoutingEndpoint {
  tag: string
  providerName?: string
  quantization?: string
  promptUsd?: number
  completionUsd?: number
  cacheReadUsd?: number
  /** Fraction OpenRouter marks off this provider's list price, when published. Already applied in the prices. */
  discount?: number
  contextLength?: number
  maxCompletionTokens?: number
}

/** Which rule of C8 translated the judge's verdict into a tier. */
export type JudgeRule =
  | 'judge-error'
  | 'precision'
  | 'low-confidence'
  | 'start-pro'
  | 'start-flash'
  | 'to-pro'
  | 'to-flash'
  | 'keep'
  | 'judge-off'

/** The judge verdict a decision was made on. */
export interface JudgeVerdict {
  /** Requested judge model. */
  model: string
  /** `model` from the response, for example `typesafe/jev-1.13-20260917`. */
  answeredBy?: string
  pPro?: number
  confidence?: number
  difficulty?: number
  precision?: number
  costUsd?: number
  latencyMs: number
  rule: JudgeRule
  error?: string
}

/** One candidate of a candidate model, as a diagnostics record lists it. */
export interface RoutingCandidate {
  model: string
  tag: string
  /** Which kind of source produced it: `openrouter`, or the direct source's route key. */
  source?: string
  providerName?: string
  quantization?: string
  promptUsd?: number
  completionUsd?: number
  cacheReadUsd?: number
  /** Fraction OpenRouter marks off this provider's list price; already applied in the prices. */
  discount?: number
  contextLength?: number
  maxCompletionTokens?: number
  /** OpenRouter's provider status code; `0` is the healthy state. */
  status?: number
  /** Measured uptime over the last 30 minutes, as a percentage. */
  uptimeLast30m?: number
  /** The blended price this candidate would charge, when it states prices. */
  blendedUsdPerToken?: number
  /** 1-based position in the ranking; present ⇔ the filters admitted it. */
  rank?: number
  /** Present ⇔ the filters dropped it; then there is no `rank`. */
  rejection?: EndpointRejection
}

/** The filters one ranking applied, as the decision records them. */
export interface RoutingFilters {
  contextWindow: number
  minQuantization: Quantization
  unknownQuantization: 'reject' | 'trusted' | 'accept'
  free: FreeMode
  /** Whether this caller may use free endpoints at all. */
  allowFree: boolean
  minUptime: number
  requireNormalStatus: boolean
  /** Base slugs whose `unknown` quantization the tier trusts. */
  trustedUnknownProviders: readonly string[]
  /** The input modality this request required beyond text, when one. */
  requiredInput?: RequiredInput
}

/** One runner-up behind the pinned endpoint. */
export interface RoutingRunnerUp {
  model: string
  tag: string
  blendedUsdPerToken: number
  quantization?: string
  /** Fraction OpenRouter marks off this provider's list price; already applied in the prices. */
  discount?: number
}

/** Model and upstream endpoint chosen at a routing boundary. Appended with `ignorable: true`. */
export interface RoutingDecision {
  boundary: RoutingBoundary
  /** Model id on the `tiers` route: `auto` | tier | favorite. */
  requested: string
  tier: string
  judge?: JudgeVerdict
  /** Concrete model id: an OpenRouter id, or a direct source's canonical id. */
  model: string
  /** Which kind of source the pin came from; absent on decisions recorded before this field existed. */
  source?: RoutingSource
  /** Absent ⇔ the request went out unpinned or pinned to a direct source. */
  endpoint?: RoutingEndpoint
  /** Present ⇔ the request went out with no pin at all. */
  unpinnedReason?: string
  blendedUsdPerToken?: number
  /** Present ⇔ the uptime filter had to be dropped for anything to pass. */
  relaxedUptime?: true
  /** Endpoints considered across all candidate models. */
  considered: number
  /** Up to three runners-up behind the pinned endpoint. */
  runnersUp: RoutingRunnerUp[]
  /** Endpoints excluded after failures. */
  excludedTags: string[]
  /** The token buckets the blended price was computed under, and where they came from. */
  mix?: MeasuredMix
  /** How many endpoints each rejection reason dropped; every reason named, zero by default. */
  rejections?: Readonly<Record<EndpointRejection, number>>
  /** The cheapest endpoint each rejection reason dropped — why a cheaper rival is absent. */
  cheapestRejected?: readonly RoutingCandidate[]
  /** The tier filters the ranking applied. */
  filters?: RoutingFilters
}

/** What one diagnostics line holds: the decision plus the candidate table it could not carry. */
export interface RoutingDiagnosticsRecord extends RoutingDecision {
  /** When the decision was taken, epoch milliseconds. */
  at: number
  /** The Session that owned the request, when there was one. */
  sessionId?: string
  /** Models whose endpoint list could not be read at all. */
  unreadable: readonly { model: string; reason: string }[]
  /** Every endpoint the ranking walked, in ranking order first and rejection order after. */
  candidates: readonly RoutingCandidate[]
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Model and upstream endpoint chosen at a routing boundary. Appended with `ignorable: true`. */
    'model-routing/decision': RoutingDecision
    /** Coordinator changed a Thread's tier. Written to the Project log. Appended with `ignorable: true`. */
    'model-routing/tier-override': { threadId: string; tier: string }
  }
}

import type { SessionEventMap } from '@deepseek-ai/dsh-session/types'

/** Folded state of the `modelRouting` projection. */
export interface ModelRoutingState {
  decision: SessionEventMap['model-routing/decision'] | null
  /** `event.time` of the decision. */
  decidedAt: number | null
  /** `event.time` of the latest assistant response. */
  lastResponseAt: number | null
  compactedSinceDecision: boolean
  /** A `model/selection` event exists in the log. */
  explicitSelection: boolean
  /** Thread id → tier; read from a Project log only. */
  overrides: Readonly<Record<string, string>>
}

/** Wire view of the current decision, what the composer chip renders. */
export interface ModelRoutingView {
  requested: string
  tier: string
  model: string
  providerName?: string
  quantization?: string
  boundary: RoutingBoundary
  decidedAt: number
  unpinned: boolean
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap { modelRouting: ModelRoutingView | null }
  interface SessionProjectionStateMap { modelRouting: ModelRoutingState }
}

/** Host-side surface other plugins use; the plugin class implements it. */
export interface ModelRoutingControl {
  /**
   * The tier names this deployment configured, in configuration order.
   * @returns every tier name, empty while the route is dormant.
   */
  tierNames(): readonly string[]
  /**
   * Switch a Thread to a tier from its next model request.
   * @param project - the Project Session (the caller), whose log receives `model-routing/tier-override`.
   * @param threadId - the Thread's child SessionId string.
   * @param tier - a configured tier name.
   * @throws Error `model-routing: unknown tier "<tier>"; configured tiers: <a, b>`.
   */
  setThreadTier(project: Session, threadId: string, tier: string): void
}

declare module '@deepseek-ai/cordis' {
  interface Context { modelRouting: ModelRoutingControl }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** No configured tier carries the name a `quote` asked to price under. */
    'model-routing/unknown-tier': { readonly tier: string; readonly configured: readonly string[] }
    /** A `quote` asked for more models than one call may price. */
    'model-routing/too-many-models': { readonly limit: number }
    /** The settings document `quote` read cannot be served; message names the field. */
    'model-routing/invalid-settings': Record<string, never>
  }
}

/** What one model would cost this turn under a tier's filters. */
export interface ModelQuote {
  model: string
  /** Best endpoint under the tier's filters. */
  endpoint?: RoutingEndpoint
  blendedUsdPerToken?: number
  /** Endpoints that passed the filters. */
  eligible: number
  /** Endpoints in the list. */
  total: number
  /** Present ⇔ the list could not be read. */
  error?: string
}

/** The account's free-model daily budget. */
export interface FreeUsage { used: number; limit: number; remaining: number }
