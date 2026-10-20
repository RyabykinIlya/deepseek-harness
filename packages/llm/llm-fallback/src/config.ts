/**
 * Configuration schema for cross-provider LLM fallback.
 *
 * @module @deepseek-ai/dsh-llm-fallback/config
 */

import z from '@deepseek-ai/schemastery'
import type { ResolvedFallbackChain, FallbackChain, FallbackStep } from './types.ts'
import { FallbackChainId } from './brand.ts'
import { randomUUID } from 'node:crypto'

const stepSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  label: z.string(),
})

const chainSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  steps: z.array(stepSchema).min(1),
})

/** Cordis schema for fallback configuration. */
export const FallbackConfigSchema = z.object({
  chains: z.dict(chainSchema),
})

/** Fallback configuration type. */
export interface FallbackConfig {
  chains: Record<string, FallbackChain>
}

/** Volatile options for runtime config updates. */
export type FallbackOptions = FallbackConfig

/**
 * Validate and resolve a fallback configuration.
 */
export function resolveFallbackConfig(config: FallbackOptions): Map<string, ResolvedFallbackChain> {
  const resolved = new Map<string, ResolvedFallbackChain>()

  for (const [intent, chain] of Object.entries(config.chains ?? {})) {
    // Generate ID if not provided
    const chainId = chain.id ?? FallbackChainId(randomUUID())

    // Validate steps reference existing providers (will be checked at execution time)
    const steps = chain.steps.map((step: FallbackStep) => ({ ...step }))

    resolved.set(intent, {
      ...chain,
      id: chainId,
      steps: Object.freeze(steps),
    } as ResolvedFallbackChain)
  }

  return resolved
}

/**
 * Default fallback configuration.
 * Users should override this in their settings/cordis.yml.
 */
export const DEFAULT_FALLBACK_CONFIG: FallbackConfig = {
  chains: {
    default: {
      id: 'default',
      name: 'Default',
      steps: [
        { provider: 'deepseek', model: 'deepseek-chat', label: 'DeepSeek Chat' },
        { provider: 'claude-proxy', model: 'claude-opus-5', label: 'Claude Opus 5' },
      ],
    },
    coding: {
      id: 'coding',
      name: 'Coding',
      steps: [
        { provider: 'claude-proxy', model: 'claude-opus-5', label: 'Claude Opus 5' },
        { provider: 'deepseek', model: 'deepseek-coder', label: 'DeepSeek Coder' },
      ],
    },
    'session-title': {
      id: 'session-title',
      name: 'Session Title',
      steps: [
        { provider: 'deepseek', model: 'deepseek-chat', label: 'DeepSeek Chat' },
        { provider: 'claude-proxy', model: 'claude-opus-5', label: 'Claude Opus 5' },
      ],
    },
  },
}
