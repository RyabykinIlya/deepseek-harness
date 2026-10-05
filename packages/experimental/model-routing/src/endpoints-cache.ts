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
 * The shared read runs under its own cancellation, never a caller's: a read
 * started for one decision outlives that decision. Otherwise a coordinator that
 * abandons its request — a cancelled turn, a superseded boundary — would abort
 * the fetch a parallel Thread is still awaiting, and the Thread would decide from
 * a stale list or an `AbortError` it never caused.
 *
 * @module dsh-experimental-model-routing/endpoints-cache
 */

import type { OpenRouterEndpoint } from '@deepseek-ai/dsh-llm-pi-ai'
import { uncancellable } from './uncancellable.ts'

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
      const shared = this.inFlight.get(model) ?? this.start(model)
      // This caller's own cancellation ends only its wait. The shared read keeps
      // running, so a Thread that joined after the coordinator started it still
      // gets the list rather than the coordinator's abort.
      pending.push(uncancellable(shared, signal).then((list) => {
        result.set(model, list ?? this.stale.get(model) ?? asError(signal.reason))
      }, (error: unknown) => {
        result.set(model, this.stale.get(model) ?? asError(error))
      }))
    }
    await Promise.all(pending)
    return result
  }

  /**
   * Start the one read every caller of `model` shares.
   *
   * The read gets a private controller rather than the caller's signal: see the
   * module note. A rejection here is not yet an error value — each joiner
   * resolves it against the stale list itself.
   */
  private start(model: string): Promise<readonly OpenRouterEndpoint[]> {
    const reading = this.reader(model, new AbortController().signal).then((list) => {
      this.fresh.set(model, { at: this.now(), list })
      this.stale.set(model, list)
      return list
    }).finally(() => { this.inFlight.delete(model) })
    // A caller that aborts before awaiting this read never attaches a rejection
    // handler, and a read whose every joiner did that would reject unhandled.
    reading.catch(() => {})
    this.inFlight.set(model, reading)
    return reading
  }
}

/** Wrap an arbitrary rejection as the `Error` value this cache reports. */
function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason))
}
