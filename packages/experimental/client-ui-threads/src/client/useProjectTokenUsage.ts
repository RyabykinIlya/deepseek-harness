/**
 * The live read of one Project's token ledger: the same projection seam the
 * sidebar's Thread rows already react to.
 *
 * Every published projection value lands in the Session Controller's list
 * snapshot, which the `useSessions` seat exposes; selecting the projection map
 * (rather than reading it once) is what makes the header move while a turn is
 * running, instead of freezing at whatever the first render found.
 */
import { useMemo } from 'react'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { aggregateTokenSpend, type TokenSpend } from './token-usage.ts'
import type { UseSessions } from './useThreadRoster.ts'

/** The per-Session projection block map of one list snapshot. */
type ProjectionBlocks = SessionListState['projectionsBySession']

/** The projection key this ledger reads; the Session Controller stores every key untyped. */
const TOKEN_USAGE_KEY = 'tokenUsage'

/**
 * Read one Session's published `tokenUsage` value out of the projection map.
 * @param blocks - the per-Session projection blocks of the current snapshot.
 * @param sessionId - the Session whose reading is needed.
 * @returns the published value, or undefined while no block names it.
 */
function publishedUsage(blocks: ProjectionBlocks, sessionId: SessionId): unknown {
  return Reflect.get(blocks[sessionId]?.values ?? {}, TOKEN_USAGE_KEY)
}

/**
 * Sum the `tokenUsage` readings of a Project Session and its Threads, live.
 * @param useSessions - the Session-list selector hook.
 * @param projectSessionId - the Project Session itself.
 * @param threadIds - the Project's own Threads, in roster order; membership and
 * order are the caller's, so the header and the roster always count the same
 * children.
 * @returns the aggregated buckets, total, and contributing Session count.
 */
export function useProjectTokenUsage(
  useSessions: UseSessions,
  projectSessionId: SessionId,
  threadIds: readonly SessionId[],
): TokenSpend {
  const blocks = useSessions(state => state.projectionsBySession)
  return useMemo(
    () => aggregateTokenSpend(
      sessionId => publishedUsage(blocks, sessionId),
      [projectSessionId, ...threadIds],
    ),
    [blocks, projectSessionId, threadIds],
  )
}
