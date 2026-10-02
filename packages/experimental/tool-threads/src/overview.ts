/** The `thread_diff` overview mode: overlaps, merge predictions, and a merge order across a Project's Threads. @module */

import type { Context } from '@deepseek-ai/cordis'
import type { ThreadStatusRow } from '@deepseek-ai/dsh-experimental-threads'
import { byteLength, count, oneLine, truncateUtf8 } from './text.ts'

/** Byte cap on a rendered label. */
const LABEL_BYTES = 120

/** Byte cap on a rendered failure message. */
const ERROR_BYTES = 160

/** Conflicting paths requested from, and listed for, one merge check. */
const CONFLICT_PATHS = 5

/** Worktree service as the overview reads it. */
type Worktrees = NonNullable<Context['worktrees']>

/** Predicted outcome of one merge check. */
export interface MergeOutcome {
  /** `clean`, `conflict`, or `failed` when git could not answer. */
  readonly status: 'clean' | 'conflict' | 'failed'
  /** Conflicting paths, at most five. */
  readonly conflicts: string[]
  /** Conflicting paths in total. */
  readonly conflictsTotal: number
  /** Bounded failure message when `status` is `failed`. */
  readonly error?: string
}

/** One Thread with a live worktree. */
export interface OverviewThread {
  /** Thread id. */
  readonly threadId: string
  /** Bounded task label. */
  readonly label: string
  /** Branch holding the commits, absent for a detached worktree. */
  readonly branch?: string
  /** Commits ahead of the base. */
  readonly commitsTotal: number
  /** Committed files changed. */
  readonly filesTotal: number
  /** Uncommitted entries in the worktree. */
  readonly uncommitted: number
  /** Prediction of merging this Thread into the Project checkout's HEAD; absent when git cannot predict. */
  readonly merge?: MergeOutcome
}

/** The `thread_diff` overview result. */
export interface ThreadOverviewResult {
  /** Discriminates the overview from the single-Thread result. */
  readonly mode: 'overview'
  /** Threads with a live worktree in creation order, cut to the byte bound. */
  readonly threads: OverviewThread[]
  /** Threads with a live worktree in total. */
  readonly threadsTotal: number
  /** Threads whose worktree could not be read, with the reason, cut to the byte bound. */
  readonly skipped: { readonly threadId: string; readonly reason: string }[]
  /** Threads whose worktree could not be read in total. */
  readonly skippedTotal: number
  /** Threads beyond the examined limit, not read at all. */
  readonly unexamined: number
  /** Committed paths touched by two or more Threads, cut to the byte bound. */
  readonly overlaps: { readonly path: string; readonly threadIds: string[] }[]
  /** Overlapping paths in total. */
  readonly overlapsTotal: number
  /** Whether some Thread lists fewer committed files than it changed, so overlaps may be incomplete. */
  readonly filesCapped: boolean
  /** Whether git can predict merges (git 2.38+). */
  readonly predictionSupported: boolean
  /** Merge checks between overlapping Threads, cut to the byte bound. */
  readonly pairs: ({ readonly first: string; readonly second: string } & MergeOutcome)[]
  /** Pair checks run in total. */
  readonly pairsTotal: number
  /** Overlapping pairs not checked: a detached Thread or the pair-check limit. */
  readonly pairsUnchecked: number
  /** Thread ids to merge, first to last. */
  readonly order: string[]
}

/** Limits one overview call may spend. */
export interface OverviewLimits {
  /** Threads read before the rest are reported as unexamined. */
  readonly maxThreads: number
  /** Committed files read per Thread. */
  readonly maxFiles: number
  /** Overlapping pairs checked. */
  readonly maxPairChecks: number
}

/** A Thread with its worktree record and listed paths. */
interface Examined {
  readonly entry: OverviewThread
  readonly record: Parameters<Worktrees['mergeCheck']>[0]
  readonly paths: ReadonlySet<string>
}

/** Run `step`, returning its value or the bounded failure message. */
async function attempt<T>(step: () => Promise<T>): Promise<{ value: T } | { error: string }> {
  try {
    return { value: await step() }
  } catch (error) {
    return { error: oneLine(error instanceof Error ? error.message : String(error), ERROR_BYTES) }
  }
}

/** Why a worktree record cannot be read. */
function skipReason(state: string | undefined): string {
  if (state === undefined) return 'no worktree is recorded (never created or cleaned up)'
  if (state === 'removed' || state === 'rolled-back') return `worktree archived (${state})`
  return `worktree not readable (state ${state})`
}

/**
 * Read the live Threads of one Project and predict how they merge.
 * @param rows - the caller's Thread rows in creation order.
 * @param worktrees - the worktree service.
 * @param limits - what this call may spend.
 * @returns the complete result, before any byte cut.
 */
export async function collectOverview(
  rows: readonly ThreadStatusRow[],
  worktrees: Worktrees,
  limits: OverviewLimits,
): Promise<ThreadOverviewResult> {
  const read = rows.slice(0, limits.maxThreads)
  const examined: Examined[] = []
  const skipped: { threadId: string; reason: string }[] = []
  let filesCapped = false
  for (const row of read) {
    const found = await attempt(() => worktrees.get(row.threadId))
    if ('error' in found) {
      skipped.push({ threadId: row.threadId, reason: `worktree lookup failed: ${found.error}` })
      continue
    }
    const record = found.value
    if (record === undefined || record.state !== 'ready') {
      skipped.push({ threadId: row.threadId, reason: skipReason(record?.state) })
      continue
    }
    const changes = await attempt(() => worktrees.changes(record, { maxCommits: 0, maxFiles: limits.maxFiles }))
    if ('error' in changes) {
      skipped.push({ threadId: row.threadId, reason: `changes unreadable: ${changes.error}` })
      continue
    }
    if (changes.value.files.length < changes.value.filesTotal) filesCapped = true
    examined.push({
      record,
      paths: new Set(changes.value.files.map(file => file.path)),
      entry: {
        threadId: row.threadId,
        label: oneLine(row.label, LABEL_BYTES),
        ...record.branch === undefined ? {} : { branch: record.branch },
        commitsTotal: changes.value.commitsTotal,
        filesTotal: changes.value.filesTotal,
        uncommitted: changes.value.uncommitted,
      },
    })
  }

  const byPath = new Map<string, string[]>()
  for (const item of examined) {
    for (const path of item.paths) byPath.set(path, [...byPath.get(path) ?? [], item.entry.threadId])
  }
  const overlaps = [...byPath]
    .filter(([, ids]) => ids.length > 1)
    .map(([path, threadIds]) => ({ path, threadIds }))
    .sort((a, b) => b.threadIds.length - a.threadIds.length || (a.path < b.path ? -1 : 1))

  const prediction = { supported: true }
  const check = async (item: Examined, target: string): Promise<MergeOutcome | undefined> => {
    if (!prediction.supported) return undefined
    const result = await attempt(() => worktrees.mergeCheck(item.record, { target }, CONFLICT_PATHS))
    if ('error' in result) return { status: 'failed', conflicts: [], conflictsTotal: 0, error: result.error }
    if (!result.value.supported) {
      prediction.supported = false
      return undefined
    }
    return {
      status: result.value.clean ? 'clean' : 'conflict',
      conflicts: [...result.value.conflicts],
      conflictsTotal: result.value.conflictsTotal,
    }
  }
  const merges = new Map<string, MergeOutcome>()
  for (const item of examined) {
    const outcome = await check(item, 'HEAD')
    if (outcome !== undefined) merges.set(item.entry.threadId, outcome)
  }

  const pairs: ThreadOverviewResult['pairs'] = []
  let pairsUnchecked = 0
  const overlapCounts = new Map<string, Set<string>>()
  for (const [index, first] of examined.entries()) {
    for (const second of examined.slice(index + 1)) {
      if (![...first.paths].some(path => second.paths.has(path))) continue
      const a = first.entry.threadId
      const b = second.entry.threadId
      overlapCounts.set(a, (overlapCounts.get(a) ?? new Set()).add(b))
      overlapCounts.set(b, (overlapCounts.get(b) ?? new Set()).add(a))
      if (!prediction.supported) continue
      if (second.entry.branch === undefined || pairs.length >= limits.maxPairChecks) {
        pairsUnchecked += 1
        continue
      }
      const outcome = await check(first, second.entry.branch)
      if (outcome !== undefined) pairs.push({ first: a, second: b, ...outcome })
    }
  }

  const overlapCount = (id: string): number => overlapCounts.get(id)?.size ?? 0
  const mergeable = examined.map(item => item.entry).filter(entry => entry.commitsTotal > 0)
  const isFirstGroup = (entry: OverviewThread): boolean => overlapCount(entry.threadId) === 0
    && merges.get(entry.threadId)?.status !== 'conflict' && merges.get(entry.threadId)?.status !== 'failed'
  const order = [
    ...mergeable.filter(isFirstGroup),
    ...mergeable.filter(entry => !isFirstGroup(entry))
      .sort((a, b) => overlapCount(a.threadId) - overlapCount(b.threadId)),
  ].map(entry => entry.threadId)

  return {
    mode: 'overview',
    threads: examined.map((item) => {
      const merge = merges.get(item.entry.threadId)
      return merge === undefined ? item.entry : { ...item.entry, merge }
    }),
    threadsTotal: examined.length,
    skipped,
    skippedTotal: skipped.length,
    unexamined: rows.length - read.length,
    overlaps,
    overlapsTotal: overlaps.length,
    filesCapped,
    predictionSupported: prediction.supported,
    pairs,
    pairsTotal: pairs.length,
    pairsUnchecked,
    order,
  }
}

/** Text for one merge prediction. */
function describeMerge(merge: MergeOutcome): string {
  if (merge.status === 'clean') return 'merges cleanly'
  if (merge.status === 'failed') return `check failed: ${merge.error ?? 'unknown error'}`
  const more = merge.conflictsTotal - merge.conflicts.length
  return `conflicts in ${count(merge.conflictsTotal, 'path', 'paths')}: `
    + `${merge.conflicts.join(', ')}${more > 0 ? ` (+${more} more)` : ''}`
}

/** Render one Thread line. */
function threadLine(thread: OverviewThread): string {
  return [
    `${thread.threadId} [${thread.branch ?? 'detached'}] ${thread.label}`,
    `${count(thread.commitsTotal, 'commit', 'commits')}, ${count(thread.filesTotal, 'file', 'files')}, ${thread.uncommitted} uncommitted`,
    ...thread.merge === undefined ? [] : [`into HEAD: ${describeMerge(thread.merge)}`],
  ].join(' | ')
}

/**
 * Render the overview as the model's text, clamped to `maxBytes`.
 * @param value - the result to render.
 * @param maxBytes - byte bound over the whole text.
 * @returns the text.
 */
export function renderOverview(value: ThreadOverviewResult, maxBytes: number): string {
  const omitted = (shown: number, total: number, what: string): string[] =>
    shown < total ? [`  (${total - shown} more ${what} omitted)`] : []
  if (value.threadsTotal === 0 && value.skippedTotal === 0) return '(no threads)'
  const lines = [
    `Overview of ${count(value.threadsTotal, 'Thread', 'Threads')} with a live worktree`
    + ' (read-only; committed work only, uncommitted edits are not part of overlaps or predictions)',
    ...value.threads.map(threadLine),
    ...omitted(value.threads.length, value.threadsTotal, 'Threads'),
    ...value.skipped.map(item => `skipped ${item.threadId}: ${item.reason}`),
    ...omitted(value.skipped.length, value.skippedTotal, 'skipped Threads'),
    ...value.unexamined > 0
      ? [`(${count(value.unexamined, 'later Thread', 'later Threads')} not examined; call thread_diff with their thread_id)`]
      : [],
    value.overlapsTotal === 0
      ? 'overlaps: none (no committed path is touched by two Threads)'
      : `overlaps (${count(value.overlapsTotal, 'committed path', 'committed paths')} touched by 2+ Threads):`,
    ...value.overlaps.map(overlap => `  ${overlap.path}: ${overlap.threadIds.join(', ')}`),
    ...omitted(value.overlaps.length, value.overlapsTotal, 'overlapping paths'),
    ...value.filesCapped
      ? ['(overlaps use only the first committed files of Threads that changed more; larger Threads may overlap more)']
      : [],
    ...value.predictionSupported
      ? [
        ...value.pairs.length === 0 && value.pairsTotal === 0 ? [] : ['pair checks (one Thread\'s branch merged into the other):'],
        ...value.pairs.map(pair => `  ${pair.first} + ${pair.second}: ${describeMerge(pair)}`),
        ...omitted(value.pairs.length, value.pairsTotal, 'pair checks'),
        ...value.pairsUnchecked > 0
          ? [`(${count(value.pairsUnchecked, 'overlapping pair', 'overlapping pairs')} not checked: detached worktree or pair-check limit)`]
          : [],
      ]
      : ['conflict prediction needs git 2.38+ (git merge-tree --write-tree); overlaps above are listed without it'],
    'merge order rule: Threads with commits, no overlapping Thread, and no predicted conflict with HEAD first; '
    + 'then the rest by fewest overlapping Threads, ties by creation order. Merge one, then call thread_diff again.',
    value.order.length === 0 ? 'merge order: nothing to merge' : `merge order: ${value.order.join(', ')}`,
  ]
  return truncateUtf8(lines.join('\n'), maxBytes)
}

/**
 * Cut lists of a complete result, overlaps first, then pair checks, skipped Threads, and Threads, until the text fits.
 * @param full - the complete result from {@link collectOverview}.
 * @param maxBytes - byte bound over the rendered text.
 * @returns the largest result that renders within the bound.
 */
export function fitOverview(full: ThreadOverviewResult, maxBytes: number): ThreadOverviewResult {
  const cut = { overlaps: full.overlaps.length, pairs: full.pairs.length, skipped: full.skipped.length, threads: full.threads.length }
  const build = (): ThreadOverviewResult => ({
    ...full,
    overlaps: full.overlaps.slice(0, cut.overlaps),
    pairs: full.pairs.slice(0, cut.pairs),
    skipped: full.skipped.slice(0, cut.skipped),
    threads: full.threads.slice(0, cut.threads),
  })
  const size = (): number => byteLength(renderOverview(build(), Infinity))
  for (const key of ['overlaps', 'pairs', 'skipped', 'threads'] as const) {
    while (cut[key] > 0 && size() > maxBytes) cut[key] -= 1
  }
  return build()
}
