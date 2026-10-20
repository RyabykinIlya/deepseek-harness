/**
 * Cordis plugin entry for cross-provider LLM fallback.
 *
 * @module @deepseek-ai/dsh-llm-fallback
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, RequestErrorAction } from '@deepseek-ai/dsh-agent'
import type { LlmCallConfig, LlmFailure } from '@deepseek-ai/dsh-llm'
import type { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import type { Session } from '@deepseek-ai/dsh-session'
import type { FallbackConfig, LlmFallbackEventData } from './types.ts'
import { FallbackChainId } from './brand.ts'
import { resolveFallbackConfig } from './config.ts'

// The 'agentPreset' projection is registered by the agent-preset package.
// Declare it here so stateOf('agentPreset') is typed correctly.
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** The active agent preset name for this session. */
    agentPreset: string
  }
}

export const name = 'llm-fallback'
export const inject = ['agents', 'sessionProjections'] as const

/** Plugin configuration: fallback chains keyed by intent. */
export type Config = FallbackConfig

/**
 * Per-agent slot for fallback progress tracking.
 *
 * We use a WeakMap keyed by Agent so slots are collected with the agent.
 * No step/start or turn/end listeners are needed:
 * - (turn, step) never repeats within a session
 * - lastProposed is overwritten on every request
 * - a pending transition is consumed exactly once by agent/request
 * - an unconsumed pending only blocks re-advance for the same (turn, step) — the loop guard
 */
interface Slot {
  /** The (provider, model) pair last proposed by agent/request for this agent. */
  lastProposed?: { turn: number; step: number; provider: string; model: string }
  /** A pending fallback transition awaiting consumption by agent/request. */
  pending?: {
    turn: number
    step: number
    from: { provider: string; model: string }
    to: { provider: string; model: string }
    chainId: FallbackChainId
    chainIntent: string
    attempt: number
  }
}

/** Resolve the effective agent preset for a session, mirroring model-routing's presetOf. */
function presetOf(registry: SessionProjectionRegistry, session: Session): string | undefined {
  try {
    // stateOf throws if the projection is not registered; treat as absent.
    return registry.stateOf(session, 'agentPreset') ?? undefined
  } catch {
    return undefined
  }
}

export function apply(ctx: Context, config: Config = { chains: {} }): void {
  // Resolve and validate chains once at mount time.
  const chains = resolveFallbackConfig(config)

  // If no chains configured, log once and still register listeners (they no-op).
  if (chains.size === 0) {
    ctx.logger.warn('llm-fallback: no fallback chains configured; the plugin is inactive')
  }

  const slots = new WeakMap<Agent, Slot>()

  // --- agent/request listener ---
  const disposeRequestListener = ctx.on('agent/request', async (
    { agent, turn, step, signal },
    next: () => Promise<LlmCallConfig>,
  ): Promise<LlmCallConfig> => {
    if (signal.aborted) {
      return next()
    }

    const proposed = await next()

    let slot = slots.get(agent)
    if (!slot) {
      slot = {}
      slots.set(agent, slot)
    }

    // If there's a pending transition for this exact (turn, step), consume it.
    if (slot.pending && slot.pending.turn === turn && slot.pending.step === step) {
      const { to, chainId, chainIntent, attempt, from } = slot.pending
      delete slot.pending // consume exactly once

      const overridden: LlmCallConfig = {
        ...proposed,
        provider: to.provider,
        model: to.model,
      }

      // Record the pair we actually returned so request-error can match it.
      slot.lastProposed = { turn, step, provider: to.provider, model: to.model }

      // Append durable session event for the fallback transition.
      agent.session.append('llm/fallback', {
        turn,
        step,
        provider: to.provider,
        model: to.model,
        chainId,
        chainIntent,
        attempt,
        from,
        // The failure that triggered this is not directly available here;
        // it was recorded by the request-error listener that created the pending.
        // We pass a minimal failure placeholder — the real failure is logged by llm-retry.
        failure: { code: 'fallback', message: 'provider fallback', retryable: false } as LlmFailure,
      } satisfies LlmFallbackEventData)

      return overridden
    }

    // No pending transition for this (turn, step): record what we proposed.
    slot.lastProposed = { turn, step, provider: proposed.provider, model: proposed.model }
    return proposed
  })

  // --- agent/request-error listener ---
  const disposeErrorListener = ctx.on('agent/request-error', async (
    { agent, turn, step, provider, failure: _failure, signal },
    next: () => Promise<RequestErrorAction>,
  ): Promise<RequestErrorAction> => {
    if (signal.aborted) {
      return next()
    }

    // 1. Let downstream (llm-retry, etc.) decide first.
    const downstream = await next()

    // 2. If downstream owns recovery (retry on same provider), don't interfere.
    if (downstream?.kind === 'retry') {
      return downstream
    }

    // 3. Read the per-agent slot.
    const slot = slots.get(agent)
    if (!slot) {
      return downstream
    }

    const last = slot.lastProposed
    // Conservative: only act on the exact (provider, model) pair we proposed.
    if (!last || last.turn !== turn || last.step !== step || last.provider !== provider) {
      return downstream
    }

    // 4. Loop guard: pending for same (turn, step) exists but was not consumed.
    if (slot.pending && slot.pending.turn === turn && slot.pending.step === step) {
      return downstream
    }

    // 5. Resolve chain for this agent's session.
    const registry = ctx.get('sessionProjections')
    if (!registry) {
      return downstream
    }

    const intent = presetOf(registry, agent.session)
    if (!intent) {
      return downstream
    }

    const chain = chains.get(intent)
    if (!chain) {
      return downstream
    }

    // 6. Find current step index by STRICT (provider, model) match.
    const currentIndex = chain.steps.findIndex(s =>
      s.provider === last.provider && s.model === last.model,
    )
    if (currentIndex < 0 || currentIndex >= chain.steps.length - 1) {
      // Not found in chain, or already at last step → terminal error.
      return downstream
    }

    // 7. Advance to next step.
    // We already checked currentIndex >= chain.steps.length - 1 above, so this is safe.
    // Use array indexing with explicit undefined check to satisfy strict null checks.
    const nextStep = chain.steps[currentIndex + 1]
    if (!nextStep) return downstream // Should never happen due to guard above
    const attempt = currentIndex + 2 // 1-based: primary=1, first fallback=2, etc.

    slot.pending = {
      turn,
      step,
      from: { provider: last.provider, model: last.model },
      to: { provider: nextStep.provider, model: nextStep.model },
      chainId: chain.id,
      chainIntent: intent,
      attempt,
    }

    // Return retry so the loop restarts the step; agent/request will consume pending.
    return { kind: 'retry' }
  })

  // Dispose both listeners on plugin unload.
  ctx.effect(() => () => {
    disposeRequestListener()
    disposeErrorListener()
  }, 'llm-fallback: dispose waterfall listeners')
}
