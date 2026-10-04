/**
 * Project token ledger: the `tokenUsage` projection summed over a Project
 * Session and every Thread it owns.
 *
 * ## What is summed
 *
 * `llm/token-meter`'s `tokenUsage` is durable cumulative provider usage for a
 * *complete session log*, in four disjoint buckets: uncached input, cache read,
 * cache write, and output (reasoning tokens are already inside output). This
 * module adds the buckets Session by Session and never re-derives them: the
 * fold is a plain sum, so the total a Project shows is exactly what its Sessions
 * have already reported and nothing else.
 *
 * ## Which Sessions count, and why
 *
 * The Session set is the Project itself plus the Project's own Threads, and
 * "the Project's Threads" is the merged roster this header already renders
 * (`subagentCatalog` continuable children merged over the `threads` projection
 * rows — see `useThreadRoster`). Reusing that identity is the whole point:
 * the roster, the sidebar's nested Thread rows, and this figure then count the
 * same children, so they can never disagree about how many Threads a Project
 * has.
 *
 * The consequences, stated explicitly because each one is a real question a
 * reader of the number will ask:
 *
 * - A **running** Thread contributes what it has reported so far; the figure
 *   grows as its settlements land, which is the honest reading of "so far".
 * - A **settled or exited** Thread contributes its final durable total. Exit
 *   changes nothing: usage is folded from the log, not from runtime state.
 * - An **archived** Thread still contributes. Archiving records
 *   `thread/removed`, which drops the durable *row* and the worktree, but the
 *   Project's append-only `subagentCatalog` keeps naming that child as a
 *   continuable Thread and archive keeps the Thread's Session — so the spend
 *   stays in the Project's ledger. That is deliberate: spend that happened does
 *   not stop counting because its work was filed away, and the figure therefore
 *   never shrinks on an archive the way a row-count would.
 * - A Thread whose projection block has **not been published yet** contributes
 *   nothing. Nothing is estimated or extrapolated; the figure rises as blocks
 *   land, and {@link isTokenBuckets} rejects a value it cannot trust rather
 *   than folding garbage into the total.
 * - **Nested** Threads — a Thread's own children — are not counted. This is the
 *   Project's own spend plus its direct Threads', not a recursive roll-up.
 *
 * ## Nothing recorded yet
 *
 * `totalTokens === 0` means no bucket of any contributing Session carries a
 * token yet: the projections have not landed, or no provider has reported
 * usage. That is an absence of reading, not a measurement of zero, so the
 * caller shows a placeholder rather than a `0` that would claim the Project
 * has spent nothing.
 */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { NS } from './locales.ts'

/**
 * The four disjoint `tokenUsage` buckets as this package reads them.
 *
 * The token-meter domain owns this vocabulary, and this plugin deliberately
 * carries no dependency on that package, so the four buckets are restated here
 * and re-narrowed from the published value by {@link isTokenBuckets} rather
 * than asserted — the Session Controller stores every projection key untyped.
 */
export interface TokenBuckets {
  /** Prompt tokens the provider did not serve from cache. */
  readonly uncachedInputTokens: number
  /** Response tokens, reasoning included. */
  readonly outputTokens: number
  /** Prompt tokens served from cache. */
  readonly cacheReadTokens: number
  /** Prompt tokens written into cache. */
  readonly cacheWriteTokens: number
}

/** One Session's aggregated spend, summed over the Project and its Threads. */
export interface TokenSpend {
  /** Sum of every contributing Session's uncached input. */
  readonly inputTokens: number
  /** Sum of every contributing Session's cache reads. */
  readonly cacheReadTokens: number
  /** Sum of every contributing Session's cache writes. */
  readonly cacheWriteTokens: number
  /** Sum of every contributing Session's output. */
  readonly outputTokens: number
  /** The four buckets added up; what the header leads with. */
  readonly totalTokens: number
  /** Sessions whose published usage was read, the Project included. */
  readonly sessions: number
}

/** Whether one number is a usable token count. */
function isCount(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Whether one published value is a usable `tokenUsage` reading.
 *
 * A deployment without the token meter has no `tokenUsage` key at all, and a
 * value the Host could not fold is still only data: both read as absent here,
 * never as a crash and never as a partial sum.
 * @param value - one candidate published value.
 * @returns whether it carries all four buckets as finite numbers.
 */
export function isTokenBuckets(value: unknown): value is TokenBuckets {
  if (typeof value !== 'object' || value === null) return false
  return isCount(Reflect.get(value, 'uncachedInputTokens'))
    && isCount(Reflect.get(value, 'outputTokens'))
    && isCount(Reflect.get(value, 'cacheReadTokens'))
    && isCount(Reflect.get(value, 'cacheWriteTokens'))
}

/**
 * Sum the `tokenUsage` readings of one Project Session and its Threads.
 * @param readUsage - reads one Session's published `tokenUsage` value, or
 * undefined while that Session's projection block has not been published.
 * @param sessionIds - the Project Session first, then its Threads; a repeat id
 * is counted once per occurrence in the caller's list.
 * @returns the four summed buckets, their total, and how many Sessions read.
 */
export function aggregateTokenSpend(
  readUsage: (sessionId: SessionId) => unknown,
  sessionIds: readonly SessionId[],
): TokenSpend {
  let inputTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  let outputTokens = 0
  let sessions = 0
  for (const sessionId of sessionIds) {
    const value = readUsage(sessionId)
    if (!isTokenBuckets(value)) continue
    inputTokens += value.uncachedInputTokens
    cacheReadTokens += value.cacheReadTokens
    cacheWriteTokens += value.cacheWriteTokens
    outputTokens += value.outputTokens
    sessions += 1
  }
  return {
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    totalTokens: inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens,
    sessions,
  }
}

/**
 * Whether anything has been recorded at all.
 *
 * `tokenUsage` only exists once a provider has reported usage for a settled
 * Assistant step, so a zero total is an absence of readings rather than a
 * measured zero — the caller renders a placeholder for it instead of `0`.
 * @param spend - the aggregated Project reading.
 * @returns whether at least one token has been reported.
 */
export function hasTokenSpend(spend: TokenSpend): boolean {
  return spend.totalTokens > 0
}

/** Compact token figures, largest unit first. */
const TOKEN_UNITS = [
  { limit: 1_000_000_000, scale: 1_000_000_000, key: 'tokens.billion' },
  { limit: 1_000_000, scale: 1_000_000, key: 'tokens.million' },
  { limit: 1_000, scale: 1_000, key: 'tokens.thousand' },
] as const

/**
 * Compact token count for a header: 517 / 12.2K / 517K / 1.2M / 1.5B.
 * @param value - a non-negative token count.
 * @param t - `threads` namespace translator.
 * @returns locale-owned compact display string.
 */
export function formatTokenCount(value: number, t: TranslateNS<typeof NS>): string {
  const [unit] = TOKEN_UNITS.filter(candidate => value >= candidate.limit)
  if (unit === undefined) return String(Math.trunc(value))
  const scaled = value / unit.scale
  // Three or more significant digits are noise in a header chip: 517K reads
  // better than 517.3K, while 12.25K needs its tenth to stay truthful.
  return t(unit.key, { value: scaled >= 100 ? String(Math.round(scaled)) : String(Math.round(scaled * 10) / 10) })
}
