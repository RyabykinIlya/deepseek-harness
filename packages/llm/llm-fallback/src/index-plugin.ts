/**
 * Cordis plugin entry for cross-provider LLM fallback.
 *
 * @module @deepseek-ai/dsh-llm-fallback
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { RequestErrorAction } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { ResolvedFallbackChain, FallbackConfig } from './types.ts'
import { resolveFallbackConfig, DEFAULT_FALLBACK_CONFIG } from './config.ts'

export const name = 'llm-fallback'
export const inject = ['agents', 'sessionProjections', 'llm']

/** This plugin has no config of its own; fallback chains are in user settings. */
export type Config = Readonly<Record<string, never>>

/** Runtime schema for {@link Config}. */
export const Config = z.object({}) as unknown as z<Config>

function validateConfig(config: Config): void {
  const [key] = Object.keys(config)
  if (key === undefined) return
  throw new Error(`llm-fallback: unknown key "${key}"`)
}

/** Session projection key for fallback execution state. */
const FALLBACK_STATE_KEY = 'llmFallback'

// The state schema for the fallback execution state
const fallbackStateSchema = zod.object({
  chain: zod.unknown(),
  currentStepIndex: zod.number().int().nonnegative(),
  attemptId: zod.string(),
  baseOptions: zod.unknown(),
  triggeringFailure: zod.unknown().optional(),
}).nullable()

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Fallback execution state for the current step. */
    [FALLBACK_STATE_KEY]: zod.infer<typeof fallbackStateSchema>
  }
}

export function apply(ctx: Context, _config: Config = {}): void {
  validateConfig(_config)

  // Volatile config that can be updated at runtime
  const config: FallbackConfig = { ...DEFAULT_FALLBACK_CONFIG }

  // Register session projection for fallback state
  ctx.sessionProjections.register({
    key: FALLBACK_STATE_KEY,
    stateVersion: 1,
    stateSchema: fallbackStateSchema,
    init: () => null,
    apply: (state, event) => {
      if (event.type === 'step/start' || event.type === 'turn/end') return null
      if (event.type !== 'llm/fallback') return state
      return state
    },
  })

  // Integration with agent loop: listen for request errors after retry is exhausted
  const disposeListener = ctx.on('agent/request-error', async (
    { provider },
    next: () => Promise<RequestErrorAction>,
  ) => {
    // First, let downstream recovery (llm-retry) run
    const downstreamResult = await next()

    // If downstream decided to retry, don't interfere
    if (downstreamResult?.kind === 'retry') {
      return downstreamResult
    }

    // Check if this provider has a fallback chain
    let matchedChain: ResolvedFallbackChain | undefined
    let currentStepIndex = -1

    for (const [, chain] of Object.entries(resolveFallbackConfig(config))) {
      const stepIndex = chain.steps.findIndex((s: { provider: string }) => s.provider === provider)
      if (stepIndex >= 0) {
        matchedChain = chain
        currentStepIndex = stepIndex
        break
      }
    }

    // No fallback chain for this provider, or already at last step
    if (!matchedChain || currentStepIndex >= matchedChain.steps.length - 1) {
      return downstreamResult
    }

    // Start fallback from the next step
    const nextStepIndex = currentStepIndex + 1
    const nextStep = matchedChain.steps[nextStepIndex]
    if (!nextStep) {
      return downstreamResult
    }

    // Return a special action that the agent loop will handle
    return { kind: 'fallback', provider: nextStep.provider, model: nextStep.model, chainId: matchedChain.id, stepIndex: nextStepIndex }
  })

  ctx.effect(() => disposeListener, 'llm-fallback: dispose listener')
}
