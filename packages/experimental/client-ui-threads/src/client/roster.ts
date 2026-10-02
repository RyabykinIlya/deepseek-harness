/**
 * Roster sources and the merge between them.
 *
 * Two projections describe the same children at different richness, and today
 * only one of them is ever written in a running deployment:
 *
 * - `subagentCatalog` is written by the delegation service itself, so it is
 *   always present, and it carries a continuable child's id and creation label.
 * - `threads` carries the durable facts (terminal outcome, worktree, branch,
 *   commits ahead, uncommitted count, note), but only for children whose
 *   `thread/*` event was recorded.
 *
 * Liveness is in neither: it is read from the Session store at render time and
 * attached last by {@link withLiveness}.
 *
 * The catalog is therefore the base and the Thread rows win wherever both name
 * the same child, so a richer row replaces a bare one instead of doubling it.
 */
import type { SessionProjectionMap } from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only: the `agentPreset` Session projection's key, read for Project identity.
import type {} from '@deepseek-ai/dsh-agent-preset-registry/types'
// Type-only on purpose: `ThreadId` is a compile-time brand, so importing the
// branding FUNCTION would be a cross-plugin value import, which the client
// bundle purity gate rejects. The brand carries no runtime behaviour.
import type { ThreadStatusRow } from '@deepseek-ai/dsh-experimental-threads/client'

/** Brand a raw child id as a Thread id without importing the branding function. */
function threadId(id: string): ThreadStatusRow['threadId'] {
  return id as ThreadStatusRow['threadId']
}

/** A durable Thread row plus its client-computed liveness. */
export type ThreadRosterRow = ThreadStatusRow & {
  /** Whether the Thread's own Session is executing a turn right now. */
  readonly running: boolean
}

/** The delegation catalog row shape this roster reads. */
type CatalogRow = SessionProjectionMap['subagentCatalog'][number]

/** Whether one catalog row names a continuable child, which is what a Thread is. */
function isContinuable(row: CatalogRow): boolean {
  return row.mode === 'continuable'
}

/**
 * Project the delegation catalog into Thread rows.
 *
 * A continuable child with no creation label still gets a row keyed by its id,
 * because an unlabeled Thread is a real Thread whose label has not been read
 * back yet, not an absent one.
 * @param catalog - the parent session's `subagentCatalog` projection value.
 * @returns one row per continuable child, in catalog order.
 */
export function catalogRows(catalog: readonly CatalogRow[] | undefined): ThreadStatusRow[] {
  if (catalog === undefined) return []
  return catalog.filter(isContinuable).map(row => ({
    threadId: threadId(row.id),
    label: row.label ?? row.id,
  }))
}

/**
 * Attach liveness to durable rows.
 * @param rows - merged durable rows.
 * @param isRunning - reads whether a Thread's Session is currently executing,
 * which is `sessions.byId[threadId].running`.
 * @returns the same rows in order, each with `running` resolved.
 */
export function withLiveness(
  rows: readonly ThreadStatusRow[],
  isRunning: (threadId: ThreadStatusRow['threadId']) => boolean,
): ThreadRosterRow[] {
  return rows.map(row => ({ ...row, running: isRunning(row.threadId) }))
}

/**
 * Merge catalog-derived rows with the richer Thread rows.
 *
 * A Thread row replaces the catalog row of the same id, so a child recorded by
 * both appears once, carrying the richer fields. Rows only one source knows
 * survive: a Thread row with no catalog counterpart (the catalog is projection
 * of a different lifecycle) is still a Thread and must not be dropped.
 * @param base - catalog-derived rows, in creation order.
 * @param richer - `threads` projection rows.
 * @returns base order first, then any richer row the base did not name.
 */
export function mergeRosterRows(
  base: readonly ThreadStatusRow[],
  richer: readonly ThreadStatusRow[],
): ThreadStatusRow[] {
  if (richer.length === 0) return [...base]
  const byId = new Map(richer.map(row => [row.threadId, row]))
  const merged = base.map(row => byId.get(row.threadId) ?? row)
  const described = new Set(base.map(row => row.threadId))
  return [...merged, ...richer.filter(row => !described.has(row.threadId))]
}
