/**
 * The `tiers` route's own replay envelope, and the history rewrite the inner
 * route needs to see.
 *
 * A request leaves this route headed for `openrouter/deepseek-v4-flash`, but the
 * durable assistant message records `tiers/flash`. pi-ai rejects replay whose
 * provider and model disagree with the message it is restoring, so the inner
 * envelope is wrapped with the identity the outer route borrowed and unwrapped
 * again before the history goes out. Without the wrapper the history would
 * degrade to "foreign" on every later turn and lose its prompt cache with it.
 *
 * @module dsh-experimental-model-routing/replay
 */

import type { ReplayEnvelope, RequestMessage } from '@deepseek-ai/dsh-llm'

/** What the `tiers` route adds around the inner route's own envelope. */
export interface RoutedReplayResponse {
  kind: 'model-routing'
  version: 1
  /** The inner pi-ai route, `openrouter` by default. */
  route: string
  /** The concrete model the route resolved to for this request. */
  model: string
  /** The inner route's own response-level envelope, verbatim. */
  inner?: unknown
}

/**
 * Wrap the inner finish envelope.
 *
 * `blocks` rides over unchanged: the wrapper only says *which* route and model
 * answered, and the per-block signatures stay exactly as the inner adapter wrote
 * them.
 * @param inner - the finish chunk's `replayState`, when it carried one.
 * @param route - the inner pi-ai route key.
 * @param model - the concrete model that answered.
 * @returns the wrapper, or the original envelope when there was nothing to wrap.
 */
export function wrapReplay(
  inner: ReplayEnvelope | undefined,
  route: string,
  model: string,
): ReplayEnvelope {
  if (inner === undefined) return { response: { kind: 'model-routing', version: 1, route, model } }
  return {
    response: { kind: 'model-routing', version: 1, route, model, inner: inner.response },
    ...inner.blocks === undefined ? {} : { blocks: inner.blocks },
  }
}

/**
 * Read a `tiers` wrapper back.
 * @param state - any candidate `replayState`.
 * @returns the parsed wrapper and its carried blocks, or `undefined` for any other value.
 */
export function readRoutedReplay(
  state: unknown,
): { response: RoutedReplayResponse; blocks?: readonly unknown[] } | undefined {
  if (typeof state !== 'object' || state === null || Array.isArray(state)) return undefined
  const envelope = state as { response?: unknown; blocks?: unknown }
  const response = envelope.response
  if (typeof response !== 'object' || response === null || Array.isArray(response)) return undefined
  const candidate = response as Partial<RoutedReplayResponse>
  if (candidate.kind !== 'model-routing' || candidate.version !== 1) return undefined
  if (typeof candidate.route !== 'string' || typeof candidate.model !== 'string') return undefined
  return {
    response: candidate as RoutedReplayResponse,
    ...Array.isArray(envelope.blocks) ? { blocks: envelope.blocks } : {},
  }
}

/**
 * Whether the history carries replay state this route produced.
 *
 * Used to tell a history that can still disagree with the current pin from one
 * that lost its signatures to compaction: only the former can fail on another
 * provider's encrypted payload, so only it is worth scrubbing or remembering.
 * @param messages - the request history as the outer route sees it.
 * @param routeName - the outer route key, `tiers`.
 */
export function historyHasReplay(messages: readonly RequestMessage[], routeName: string): boolean {
  return messages.some(message =>
    message.role === 'assistant'
    && message.source.provider === routeName
    && message.source.replayState !== undefined,
  )
}

/**
 * Rewrite history so the inner route can validate its own replay state.
 *
 * A message the outer route recorded as `tiers/flash` becomes `openrouter/<concrete>`:
 * without that rewrite pi-ai sees a model identity that disagrees with the envelope
 * and degrades every assistant turn to provider-neutral content. A message with no
 * valid wrapper keeps its provider and model but loses `replayState` — that is the
 * honest outcome for an envelope this build cannot read, and it costs the cache
 * exactly once rather than silently keeping metadata that no longer describes
 * anything. Messages the route did not produce are returned unchanged.
 *
 * When the serving identity changed since the history was produced — the same
 * model pinned to another endpoint after a provider failure, for example — the
 * inner envelope's signatures must go even when they still validate: an
 * encrypted `reasoning_details` payload only the producing provider can process
 * makes OpenRouter reject the whole request once the `only` pin excludes that
 * provider. Dropping the envelope keeps the text and tool calls while the
 * provider-neutral conversion drops the signatures, so the turn runs without
 * thinking continuity instead of failing outright.
 * @param messages - the request history as the outer route sees it.
 * @param routeName - the outer route key, `tiers`.
 * @param dropReplay - drop the inner replay state of every message even when it
 *   validates, because the current pin names another physical provider.
 * @returns a new history; the input array and its objects are not mutated.
 */
export function unwrapHistory(messages: readonly RequestMessage[], routeName: string, dropReplay = false): RequestMessage[] {
  return messages.map((message) => {
    if (message.role !== 'assistant') return message
    const source = message.source
    if (source.provider !== routeName) return message
    const routed = readRoutedReplay(source.replayState)
    if (routed === undefined) {
      const { replayState: _dropped, ...withoutReplay } = source
      return { ...message, source: withoutReplay }
    }
    const { inner, ...identity } = routed.response
    // The identity rewrite is unconditional: it is what lets the inner route
    // match its own model at all. The replay state is not — an envelope with no
    // inner half carries nothing the inner route could validate, and a serving
    // identity change since the history was produced invalidates even a
    // well-formed one (see above).
    const { replayState: _dropped, ...withoutReplay } = source
    return {
      ...message,
      source: {
        ...withoutReplay,
        provider: identity.route,
        model: identity.model,
        ...inner === undefined || dropReplay
          ? {}
          : { replayState: { response: inner, ...routed.blocks === undefined ? {} : { blocks: routed.blocks } } },
      },
    }
  })
}
