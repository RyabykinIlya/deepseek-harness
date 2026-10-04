/**
 * When the `tiers` route is allowed to take a fresh decision.
 *
 * The route deliberately does **not** re-decide per turn. An agent turn is
 * overwhelmingly cached input, and a different model or a different upstream
 * provider invalidates that cache — so changing either mid-dialog costs roughly
 * six times the price of the turn it was meant to save on (§B.1). The boundaries
 * below are therefore the only places a pin may change, and each one is a place
 * where the cache is already gone or was never warm.
 *
 * @module dsh-experimental-model-routing/boundary
 */

import type { RoutingBoundary } from './types.ts'

/** Everything the boundary test reads. */
export interface BoundaryInput {
  /** What the route currently has pinned for this session, if anything. */
  pinned: { requested: string } | undefined
  /** What this request asks for. */
  requested: string
  /** A previous attempt on this session failed and has not been re-decided since. */
  failurePending: boolean
  /** A successful compaction happened after the current decision. */
  compactedSinceDecision: boolean
  /** When the session last produced a response or ran a request. */
  lastActivityAt: number | undefined
  /** Current time. */
  now: number
  /** How long a pinned provider's prompt cache survives without a request. */
  cacheIdleMs: number
}

/**
 * Classify one request against the pin the session currently holds.
 *
 * Order matters and is the whole point: an unpinned session decides regardless of
 * anything else, and a pending failure outranks every reason to stay put, because
 * re-requesting the endpoint that just failed is the one outcome guaranteed to
 * fail again.
 * @param input - the pin, the request, and the session's activity facts.
 * @returns the boundary this request sits on, or `undefined` to keep the pin.
 */
export function boundaryOf(input: BoundaryInput): RoutingBoundary | undefined {
  if (input.pinned === undefined) return 'start'
  if (input.failurePending) return 'failure'
  if (input.pinned.requested !== input.requested) return 'selection-change'
  if (input.compactedSinceDecision) return 'compaction'
  if (input.lastActivityAt !== undefined && input.now - input.lastActivityAt > input.cacheIdleMs) return 'idle'
  return undefined
}
