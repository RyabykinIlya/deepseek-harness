/**
 * A one-hour cache over OpenRouter's per-model endpoint lists.
 *
 * Two properties matter and both are about not making the route fragile. A stale
 * list is far better than no list: when a fresh read fails, the last list of any
 * age is served, because a provider that was serving an hour ago is a better
 * answer than refusing the turn. And two concurrent decisions over the same model
 * must share one request, because a Project coordinator and each of its Threads
 * decide at nearly the same moment and OpenRouter does not need to be asked the
 * same question twice.
 *
 * @module dsh-experimental-model-routing/endpoints-cache
 */

import type { OpenRouterEndpoint } from '@deepseek-ai/dsh-llm-pi-ai'

/** Reads one model's endpoint list; may reject, and the caller sees the rejection as a value. */
export type EndpointsReader = (model: string, signal: AbortSignal) => Promise<readonly OpenRouterEndpoint[]>

/** Per-model endpoint cache with a shared in-flight read. */
export class EndpointsCache {
  private readonly fresh = new Map<string, { at: number; list: readonly OpenRouterEndpoint[] }>()
  private readonly stale = new Map<string, readonly OpenRouterEndpoint[]>()
  private readonly inFlight = new Map<string, Promise<readonly OpenRouterEndpoint[]>>()

  constructor(
    private readonly reader: EndpointsReader,
    private readonly now: () => number,
  ) {}

  /**
   * One endpoint list per model, fresh where possible.
   *
   * A read failure is reported as the `Error` itself rather than thrown: a tier
   * whose every model failed to list is a routing decision with no candidates,
   * which the caller answers differently from a tier whose lists are merely
   * stale — and the stale answer is always preferred when one exists.
   * @param models - candidate model ids, in tier order.
   * @param ttlMs - how long a list is considered fresh.
   * @param signal - the request's cancellation.
   * @returns one list or one `Error` per model, keyed by model id.
   */
  async read(
    models: readonly string[],
    ttlMs: number,
    signal: AbortSignal,
  ): Promise<Map<string, readonly OpenRouterEndpoint[] | Error>> {
    const result = new Map<string, readonly OpenRouterEndpoint[] | Error>()
    const pending: Promise<void>[] = []
    for (const model of models) {
      const cached = this.fresh.get(model)
      if (cached !== undefined && this.now() - cached.at < ttlMs) {
        result.set(model, cached.list)
        continue
      }
      const shared = this.inFlight.get(model)
      if (shared !== undefined) {
        pending.push(shared.then((list) => { result.set(model, list) }, (error: unknown) => {
          result.set(model, this.stale.get(model) ?? asError(error))
        }))
        continue
      }
      const reading = this.reader(model, signal).then((list) => {
        this.fresh.set(model, { at: this.now(), list })
        this.stale.set(model, list)
        return list
      }).finally(() => { this.inFlight.delete(model) })
      this.inFlight.set(model, reading)
      pending.push(reading.then((list) => { result.set(model, list) }, (error: unknown) => {
        result.set(model, this.stale.get(model) ?? asError(error))
      }))
    }
    await Promise.all(pending)
    return result
  }
}

/** Wrap an arbitrary rejection as the `Error` value this cache reports. */
function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason))
}
