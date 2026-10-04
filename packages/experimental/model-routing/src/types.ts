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

/** The moments at which the route may take a fresh decision. */
export type RoutingBoundary = 'start' | 'selection-change' | 'compaction' | 'idle' | 'failure'

/** One upstream endpoint as the decision pinned it; prices are USD per token. */
export interface RoutingEndpoint {
  tag: string
  providerName?: string
  quantization?: string
  promptUsd: number
  completionUsd: number
  cacheReadUsd?: number
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

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Model and upstream endpoint chosen at a routing boundary. Appended with `ignorable: true`. */
    'model-routing/decision': {
      boundary: RoutingBoundary
      /** Model id on the `tiers` route: `auto` | tier | favorite. */
      requested: string
      tier: string
      judge?: JudgeVerdict
      /** Concrete OpenRouter model id. */
      model: string
      /** Absent ⇔ the request went out unpinned. */
      endpoint?: RoutingEndpoint
      /** Present ⇔ `endpoint` is absent. */
      unpinnedReason?: string
      blendedUsdPerToken?: number
      /** Present ⇔ the uptime filter had to be dropped for anything to pass. */
      relaxedUptime?: true
      /** Endpoints considered across all candidate models. */
      considered: number
      /** Up to three runners-up behind the pinned endpoint. */
      runnersUp: { model: string; tag: string; blendedUsdPerToken: number }[]
      /** Endpoints excluded after failures. */
      excludedTags: string[]
    }
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
