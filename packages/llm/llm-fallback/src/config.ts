/**
 * Configuration schema for cross-provider LLM fallback.
 *
 * @module @deepseek-ai/dsh-llm-fallback/config
 */

import z from '@deepseek-ai/schemastery'
import { FallbackChainId } from './brand.ts'
import type {
  FallbackChain,
  FallbackConfig,
  FallbackStep,
} from './types.ts'
import { randomUUID } from 'node:crypto'

/**
 * Schema for a single fallback step in configuration.
 */
const stepInputSchema = z.object({
  provider: z.string().required(),
  model: z.string().required(),
  label: z.string().required(false),
})

/**
 * Schema for a fallback chain in configuration.
 */
const chainInputSchema = z.object({
  id: z.string().required(false),
  name: z.string().required(false),
  steps: z.array(stepInputSchema).min(1),
})

/**
 * Plugin configuration schema: chains keyed by intent.
 */
export const Config = z.object({
  chains: z.dict(chainInputSchema),
}) as unknown as z<FallbackConfig>

/**
 * Validate and resolve a fallback configuration into a Map of validated chains.
 * Validation is performed ONCE at mount time; errors name the chain key.
 * The schemastery schema alone cannot name the chain, so this function
 * provides chain-keyed error messages for direct callers.
 *
 * @param config - raw plugin configuration
 * @returns Map from intent to resolved, frozen FallbackChain
 * @throws Error naming the chain key if validation fails
 */
export function resolveFallbackConfig(config: FallbackConfig): Map<string, FallbackChain> {
  const resolved = new Map<string, FallbackChain>()

  for (const [intent, chainInput] of Object.entries(config.chains)) {
    const steps = chainInput.steps

    // Validate: empty steps array (schema min(1) catches this, but we re-check
    // to name the chain in the error message)
    if (steps.length === 0) {
      throw new Error(`llm-fallback: chain "${intent}" has no steps`)
    }

    // Validate: duplicate (provider, model) pairs within this chain
    const seenPairs = new Set<string>()
    for (const step of steps) {
      if (!step.provider) {
        throw new Error(`llm-fallback: chain "${intent}" has a step with empty provider`)
      }
      if (!step.model) {
        throw new Error(`llm-fallback: chain "${intent}" has a step with empty model`)
      }
      const pairKey = `${step.provider}|${step.model}`
      if (seenPairs.has(pairKey)) {
        throw new Error(
          `llm-fallback: chain "${intent}" has duplicate (provider, model) pair: ${pairKey}`,
        )
      }
      seenPairs.add(pairKey)
    }

    // Generate chain ID if not provided
    const chainId = chainInput.id ? FallbackChainId(chainInput.id) : FallbackChainId(randomUUID())

    // Build resolved chain with frozen steps
    // FallbackStepInput and FallbackStep are structurally identical; spread creates mutable copy
    const mutableSteps: FallbackStep[] = [...steps]
    const chain: FallbackChain = {
      id: chainId,
      name: chainInput.name ?? intent,
      steps: Object.freeze(mutableSteps) as FallbackStep[],
    }

    resolved.set(intent, Object.freeze(chain))
  }

  return resolved
}
