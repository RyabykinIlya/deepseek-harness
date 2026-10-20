/**
 * Core types for cross-provider LLM fallback.
 *
 * @module @deepseek-ai/dsh-llm-fallback
 */

import type { LlmFailure } from '@deepseek-ai/dsh-llm'
import type { FallbackChainId } from './brand.ts'

/** Event data appended to the session log on each fallback transition. */
export interface LlmFallbackEventData {
  /** Turn number of the request that triggered fallback. */
  turn: number
  /** Step number within the turn. */
  step: number
  /** Provider being switched to (the target step's provider). */
  provider: string
  /** Model being switched to (the target step's model). */
  model: string
  /** Fallback chain identifier. */
  chainId: FallbackChainId
  /** Config dictionary key the chain was resolved from. */
  chainIntent: string
  /** 1-based chain position of the target step: primary = 1, first fallback = 2. */
  attempt: number
  /** The failed (provider, model) pair we are leaving. */
  from: { provider: string; model: string }
  /** The failure that triggered the transition. */
  failure: LlmFailure
}

/** Declare the session event for durable logging via SessionEventMap. */
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** A fallback transition to the next chain step after a provider failure. */
    'llm/fallback': LlmFallbackEventData
  }
}

/**
 * One step in a fallback chain.
 */
export interface FallbackStep {
  /** Provider route key (e.g., "deepseek", "claude-proxy", "openrouter"). */
  provider: string
  /** Model id for that provider. */
  model: string
  /** Optional label for UI/diagnostics. */
  label?: string
}

/**
 * A complete fallback chain for one intent.
 */
export interface FallbackChain {
  /** Unique chain identifier. */
  id: FallbackChainId
  /** Human-readable name for selectors. */
  name: string
  /** Ordered steps to try. First step is the primary. */
  steps: FallbackStep[]
}

/**
 * Input shape for a fallback chain in configuration (before resolution).
 */
export interface FallbackChainInput {
  /** Optional explicit chain identifier. */
  id?: string
  /** Optional human-readable name. */
  name?: string
  /** Ordered steps to try. First step is the primary. */
  steps: FallbackStepInput[]
}

/**
 * Input shape for a fallback step in configuration.
 */
export interface FallbackStepInput {
  /** Provider route key. */
  provider: string
  /** Model id for that provider. */
  model: string
  /** Optional label for UI/diagnostics. */
  label?: string
}

/**
 * Plugin configuration: fallback chains keyed by intent.
 */
export interface FallbackConfig {
  /** Fallback chains per intent. */
  chains: Record<string, FallbackChainInput>
}
