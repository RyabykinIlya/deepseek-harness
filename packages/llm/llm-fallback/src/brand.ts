/**
 * Branded types for the LLM fallback package.
 *
 * @module @deepseek-ai/dsh-llm-fallback
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Unique identifier for a fallback chain. */
export type FallbackChainId = Branded<'FallbackChainId'>

/** Unique identifier for a fallback attempt. */
export type FallbackAttemptId = Branded<'FallbackAttemptId'>

/**
 * Brand an implementation-minted fallback chain identity.
 * @param id - opaque fallback chain identity.
 * @returns the same string, branded; no validation is performed.
 */
export function FallbackChainId(id: string): FallbackChainId {
  return id as FallbackChainId
}

/**
 * Brand an implementation-minted fallback attempt identity.
 * @param id - opaque fallback attempt identity.
 * @returns the same string, branded; no validation is performed.
 */
export function FallbackAttemptId(id: string): FallbackAttemptId {
  return id as FallbackAttemptId
}
