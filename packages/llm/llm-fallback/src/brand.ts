/**
 * Branded types for the LLM fallback package.
 *
 * @module @deepseek-ai/dsh-llm-fallback
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Unique identifier for a fallback chain. */
export type FallbackChainId = Branded<'FallbackChainId'>

/**
 * Brand an implementation-minted fallback chain identity.
 * @param id - opaque fallback chain identity.
 * @returns the same string, branded; no validation is performed.
 */
export function FallbackChainId(id: string): FallbackChainId {
  return id as FallbackChainId
}
