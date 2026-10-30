/**
 * Cordis plugin entry for cross-provider LLM fallback.
 *
 * @module @deepseek-ai/dsh-llm-fallback
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision, RequestErrorAction } from '@deepseek-ai/dsh-agent'

import type { Session } from '@deepseek-ai/dsh-session'
import type { FallbackConfig, LlmFallbackEventData } from './types.ts'
import { resolveFallbackConfig } from './config.ts'

// Type-only import to merge the canonical agentPreset declaration (string | null).
// The canonical agentPreset declaration lives in agent-preset-registry; this import merges it for typing.
import type {} from '@deepseek-ai/dsh-agent-preset-registry'

export const name = 'llm-fallback'
export const inject = ['agents', 'sessionProjections']

/** Plugin configuration: fallback chains keyed by intent. */
export type Config = FallbackConfig

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({
  chains: z.dict(
    z.object({
      id: z.string().required(false),
      name: z.string().required(false),
      steps: z.array(
        z.object({
          provider: z.string().required(),
          model: z.string().required(),
          label: z.string().required(false),
        }),
      ).min(1),
    }),
  ),
})

/**
 * Per-agent slot for fallback progress tracking.
 *
 * We use a WeakMap keyed by Agent so slots are collected with the agent.
 * No step/start or turn/end listeners are needed:
 * - (turn, step) never repeats within a session
 * - lastProposed is overwritten at every step's preparation
 * - advanced only blocks re-advance for the same (turn, step) — the loop guard
 */
interface Slot {
  /** The (provider, model) pair the step's captured selection runs on. */
  lastProposed?: { turn: number; step: number; provider: string; model: string }
  /** The (turn, step) whose failure already advanced the chain one step. */
  advanced?: { turn: number; step: number }
}

/** Resolve the effective agent preset for a session, mirroring model-routing's presetOf. */
function presetOf(ctx: Context, session: Session): string | undefined {
  // A composition without the preset package leaves the service unregistered;
  // that is capability absence, not a fault to propagate into every request.
  // agentPreset is string | null; normalize null to undefined.
  return ctx.get('agentPresets')?.presetForSession(session) ?? undefined
}

export function apply(ctx: Context, config: Config = { chains: {} }): void {
  // Resolve and validate chains once at mount time.
  const chains = resolveFallbackConfig(config)

  // If no chains configured, log once and still register listeners (they no-op).
  if (chains.size === 0) {
    ctx.logger.warn('llm-fallback: no fallback chains configured; the plugin is inactive')
  }

  const slots = new WeakMap<Agent, Slot>()

  // --- pre-step bookkeeping listener ---
  // The step's route is fixed at step preparation (session-model-selection), so
  // a fallback no longer rewrites the in-flight request: selecting the chain's
  // next route applies from the following step. This listener only records the
  // route each step actually runs on, which the error listener matches against.
  const disposeRequestListener = ctx.on('agent/pre-step', async ({ agent, turn, step }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    const route = agent.model.current()
    if (route === undefined) return decision
    let slot = slots.get(agent)
    if (!slot) {
      slot = {}
      slots.set(agent, slot)
    }
    slot.lastProposed = { turn, step, provider: route.provider, model: route.model }
    return decision
  })

  // --- agent/request-error listener ---
  const disposeErrorListener = ctx.on('agent/request-error', async (
    { agent, turn, step, provider, failure, signal },
    next: () => Promise<RequestErrorAction>,
  ): Promise<RequestErrorAction> => {
    // 1. Let downstream (llm-retry, etc.) decide first.
    const downstream = await next()

    // If the turn was aborted after downstream settled, don't mutate state.
    if (signal.aborted) {
      return downstream
    }

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

    // 4. Loop guard: already advanced this (turn, step) — the retried attempt runs
    // on the captured route, so a second failure of the same step is the new route
    // failing; the chain resumes from the next step (its own request-error).
    if (slot.advanced?.turn === turn && slot.advanced.step === step) {
      return downstream
    }

    // 5. Resolve chain for this agent's session.
    const intent = presetOf(ctx, agent.session)
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
    const nextStep = chain.steps[currentIndex + 1]
    if (!nextStep) return downstream // Should never happen due to guard above
    const attempt = currentIndex + 2 // 1-based: primary=1, first fallback=2, etc.

    slot.advanced = { turn, step }
    // The recorded selection applies from the following step's preparation: a
    // retry of this step would rerun the captured route, so the step ends with
    // its failure and the next step enters the chain's next route.
    agent.model.select({ provider: nextStep.provider, model: nextStep.model })

    // Append durable session event for the fallback transition.
    // We do this HERE (not in agent/request) so the real failure from the
    // payload is recorded, matching llm-retry's precedent of appending before
    // the cancellable gap. The event is informational (no state reconstruction),
    // so it carries ignorable: true — readers may skip it without data loss.
    agent.session.append('llm/fallback', {
      turn,
      step,
      provider: nextStep.provider,
      model: nextStep.model,
      chainId: chain.id,
      chainIntent: intent,
      attempt,
      from: { provider: last.provider, model: last.model },
      failure,
    } satisfies LlmFallbackEventData, { ignorable: true })

    // The step's route is captured at preparation, so a retry action would rerun
    // the failed route; returning the downstream action ends this step with its
    // failure, and the recorded selection serves the next step.
    return downstream
  })

  // Dispose both listeners on plugin unload.
  ctx.effect(() => () => {
    disposeRequestListener()
    disposeErrorListener()
  }, 'llm-fallback: dispose waterfall listeners')
}

