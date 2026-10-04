/**
 * Per-call pi-ai dispatch, for adapters that need to carry a request-specific
 * routing block to one concrete model.
 *
 * A route's `compat.openRouterRouting` is configuration: it belongs to the model
 * descriptor the catalog built, and every request on that route shares it. An
 * adapter that must pin one request to one upstream provider — and must know
 * which session that request belongs to, so it can pin per session rather than
 * per call — cannot reach it that way. `ctx.piAiDispatch` hands the block to the
 * call instead.
 *
 * The call deliberately does **not** go through `ctx.llm`: the caller is itself
 * an adapter, it has already received runtime-projected messages, and a nested
 * `llm.stream()` would project the history a second time and strip the
 * `replayState` an outer adapter owns. Everything a normal `stream()` does —
 * credential resolution, per-call snapshot capture, idle watchdog, teardown —
 * happens exactly as it does there; only the routing block differs.
 *
 * @module dsh-llm-pi-ai/dispatch
 */

import type { OpenAICompletionsCompat } from '@earendil-works/pi-ai'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, ReplayEnvelope, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { PiAiReplayResponse } from './replay.ts'
import { readReplayState } from './replay.ts'

/**
 * The wire block pi-ai copies verbatim onto the request body as `provider`
 * (`@earendil-works/pi-ai`, `dist/api/openai-completions.js`: `params.provider =
 * model.compat.openRouterRouting`). Aliased rather than restated so a pi-ai
 * upgrade that widens or narrows the block fails compilation in this package
 * instead of silently drifting from the wire.
 */
export type OpenRouterRoutingBlock = NonNullable<OpenAICompletionsCompat['openRouterRouting']>

/** Per-call options for one pi-ai dispatch. */
export interface PiAiDispatchOptions {
  /**
   * OpenRouter `provider` block for this call only. Replaces the model's configured
   * `compat.openRouterRouting`. Valid only for an `openai-completions` model.
   */
  readonly openRouterRouting?: OpenRouterRoutingBlock
}

/** `ctx.piAiDispatch`: streams one request through a configured pi-ai route with per-call options. */
export interface PiAiDispatch {
  /**
   * Same contract as `PiAiAdapter.stream`. The call does not go through `ctx.llm`:
   * the caller is itself an adapter and has already received runtime-projected messages.
   * @param options - a request whose `provider` is a pi-ai route key (for example `openrouter`).
   * @param dispatch - per-call options.
   * @returns the chunk stream of one provider attempt.
   */
  stream(options: GenerateOptions, dispatch?: PiAiDispatchOptions): AsyncIterable<StreamChunk>
}

declare module '@deepseek-ai/cordis' {
  interface Context { piAiDispatch: PiAiDispatch }
}

/** Upstream response identity from a pi-ai replay envelope. */
export interface PiAiResponseIdentity { readonly responseId?: string; readonly responseModel?: string }

/**
 * Read the response identity from a pi-ai replay envelope.
 * @param state - a finish chunk's `replayState` or an assistant source's `replayState`.
 * @returns the identity, or `undefined` for a missing, foreign, or malformed envelope.
 */
export function piAiResponseIdentity(state: ReplayEnvelope | undefined): PiAiResponseIdentity | undefined {
  if (state === undefined) return undefined
  let response: PiAiReplayResponse
  try {
    response = readReplayState(state).response
  } catch (error) {
    // A foreign or malformed envelope carries no pi-ai identity to report.
    if (error instanceof LlmError && error.code === 'INVALID_REPLAY_STATE') return undefined
    throw error
  }
  return {
    ...response.responseId === undefined ? {} : { responseId: response.responseId },
    ...response.responseModel === undefined ? {} : { responseModel: response.responseModel },
  }
}
