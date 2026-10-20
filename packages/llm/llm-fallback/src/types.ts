/**
 * Core types for cross-provider LLM fallback.
 *
 * @module @deepseek-ai/dsh-llm-fallback
 */

import type { GenerateOptions, LlmFailure, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { FallbackChainId, FallbackAttemptId } from './brand.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * A fallback attempt was made after the previous provider failed.
     * This is a non-surface event (like llm/retry) for durable logging.
     * @mode emit
     * @param payload - fallback attempt details
     */
    'llm/fallback'(
      this: never,
      payload: {
        /** Fallback chain identifier. */
        chainId: FallbackChainId
        /** Fallback attempt number (1 = first fallback after primary). */
        attempt: number
        /** The provider that was tried. */
        provider: string
        /** The model that was tried. */
        model: string
        /** The intent this chain was resolved for. */
        intent: string
        /** The failure that triggered this fallback. */
        previousFailure: LlmFailure
        /** Whether this attempt succeeded. */
        success: boolean
        /** Failure from this attempt, if it also failed. */
        failure?: LlmFailure
      }
    ): void
  }
}

// Extend SessionEventMap for the fallback event
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** A fallback attempt was made after the previous provider failed. */
    'llm/fallback': {
      /** Fallback chain identifier. */
      chainId: FallbackChainId
      /** Fallback attempt number (1 = first fallback after primary). */
      attempt: number
      /** The provider that was tried. */
      provider: string
      /** The model that was tried. */
      model: string
      /** The intent this chain was resolved for. */
      intent: string
      /** The failure that triggered this fallback. */
      previousFailure: LlmFailure
      /** Whether this attempt succeeded. */
      success: boolean
      /** Failure from this attempt, if it also failed. */
      failure?: LlmFailure
    }
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
  /** Chain identifier; generated at resolution when omitted. */
  id?: string
  /** Human-readable name for selectors. */
  name: string
  /** Ordered steps to try. First step is the primary. */
  steps: FallbackStep[]
}

/**
 * Configuration for fallback chains, keyed by intent.
 */
export interface FallbackConfig {
  /** Fallback chains per intent. */
  chains: Record<string, FallbackChain>
  [key: string]: unknown
}

/**
 * Resolved fallback chain with validated steps.
 */
export interface ResolvedFallbackChain extends Omit<FallbackChain, 'id' | 'steps'> {
  /** Chain identifier, always assigned once resolved. */
  id: FallbackChainId
  /** Frozen steps, in attempt order, with resolved model info for request derivation. */
  steps: readonly (FallbackStep & { resolvedModel?: LlmResolvedModelInfo })[]
}

/**
 * Result of resolving a fallback chain for a request.
 */
export interface ResolvedFallbackResult {
  /** The chain that was resolved. */
  chain: ResolvedFallbackChain
  /** Index of the step to start with (0 = primary). */
  startIndex: number
  /** Original request intent. */
  intent: string
}

/**
 * State of a fallback chain execution for the current step.
 */
export interface FallbackExecutionState {
  /** The chain being executed. */
  chain: ResolvedFallbackChain
  /** Current step index (0 = primary, 1 = first fallback, etc.). */
  currentStepIndex: number
  /** Attempt ID for this fallback execution. */
  attemptId: FallbackAttemptId
  /** Original request options (without provider/model). */
  baseOptions: Omit<GenerateOptions, 'provider' | 'model'>
  /** The failure that triggered the current fallback, if any. */
  triggeringFailure?: LlmFailure
}

/**
 * Service for resolving and executing fallback chains.
 */
export interface LlmFallbackRouter {
  /**
   * Resolve the fallback chain for a given intent and starting request.
   * Returns the chain and the index to start from (0 for primary, >0 if
   * the request already specifies a provider/model in the chain).
   */
  resolveChain(intent: string, options: GenerateOptions): Promise<ResolvedFallbackResult>

  /**
   * Execute a request with fallback. Tries each step in the chain until
   * one succeeds or all are exhausted. Per-step retries are handled by
   * the llm-retry plugin; this only advances on policy exhaustion.
   */
  streamWithFallback(
    chain: ResolvedFallbackChain,
    baseOptions: Omit<GenerateOptions, 'provider' | 'model'>,
    startIndex: number,
    signal?: AbortSignal
  ): AsyncIterable<StreamChunk>

  /**
   * Get the fallback chain configuration.
   */
  getConfig(): FallbackConfig

  /**
   * Update the fallback chain configuration at runtime.
   */
  setConfig(config: FallbackConfig): void
}
