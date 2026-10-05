/**
 * Await a shared read without letting one caller's cancellation end it.
 *
 * Both caches in this package serve one read to several callers at once — a
 * Project coordinator and each of its Threads decide at nearly the same moment.
 * The read belongs to the cache, not to whichever caller happened to start it,
 * so a coordinator that abandons its request must not abort the fetch a Thread
 * is still awaiting. This module is that one rule, in one place.
 *
 * @module dsh-experimental-model-routing/uncancellable
 */

/**
 * Await one shared promise, but stop waiting when this caller aborts.
 *
 * The shared promise itself is untouched: it keeps running for every other
 * caller and still fills the cache when it settles. Only this caller's `await`
 * ends early.
 * @param shared - the read every caller of the same key awaits.
 * @param signal - this caller's own cancellation.
 * @returns the shared value, or `undefined` when this caller aborted first.
 */
export function uncancellable<T>(shared: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) return Promise.resolve(undefined)
  return new Promise<T | undefined>((resolve, reject) => {
    const onAbort = (): void => { cleanup(); resolve(undefined) }
    const cleanup = (): void => { signal.removeEventListener('abort', onAbort) }
    signal.addEventListener('abort', onAbort, { once: true })
    shared.then(
      (value) => { cleanup(); resolve(value) },
      (error: unknown) => { cleanup(); reject(error instanceof Error ? error : new Error(String(error))) },
    )
  })
}
