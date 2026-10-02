/** The `thread_status` tool: a byte-bounded listing of the caller's Threads. @module */

import type { ThreadStatusRow, ThreadStopReason } from '@deepseek-ai/dsh-experimental-threads'
import { byteLength, oneLine, truncateUtf8 } from './text.ts'

/** The state vocabulary `thread_status` filters and renders on. */
export const THREAD_STATES = ['running', 'idle', 'completed', 'aborted', 'error', 'max-tokens', 'refusal'] as const

/** One member of {@link THREAD_STATES}. */
export type ThreadState = typeof THREAD_STATES[number]

/** Byte cap on a rendered label. */
const LABEL_BYTES = 160

/** Byte cap on a rendered note. */
const NOTE_BYTES = 320

/** One Thread as `thread_status` reports it. */
export interface ThreadStatusEntry {
  /** Durable Thread identity. */
  readonly threadId: string
  /** Running, or the outcome of the last turn; `idle` means not running and no outcome yet. */
  readonly state: ThreadState
  /** The task the Thread was given, as one bounded line. */
  readonly label: string
  /** Branch holding the Thread's commits. */
  readonly branch?: string
  /** Commits on the branch beyond the base, when known. */
  readonly commitsAhead?: number
  /** Uncommitted entries in the Thread's worktree, when known. */
  readonly uncommitted?: number
  /** Bounded start of the Thread's closing message. */
  readonly note?: string
}

/** The `thread_status` result. */
export interface ThreadStatusResult {
  /** Rendered rows in creation order. */
  readonly threads: ThreadStatusEntry[]
  /** Rows matching the filter. */
  readonly total: number
  /** Whether a row limit or the byte bound dropped a matching row. */
  readonly truncated: boolean
  /** Matching rows dropped. */
  readonly omitted: number
}

/**
 * Resolve the one state a row reports.
 * @param running - live runtime liveness.
 * @param stopReason - outcome of the last finished turn.
 * @returns `running`, the outcome, or `idle`.
 */
export function stateOf(running: boolean, stopReason: ThreadStopReason | undefined): ThreadState {
  if (running) return 'running'
  return stopReason ?? 'idle'
}

/**
 * Project a durable row into the tool entry.
 * @param row - projection row.
 * @param running - live liveness of the row's Thread.
 * @returns the bounded entry.
 */
export function toEntry(row: ThreadStatusRow, running: boolean): ThreadStatusEntry {
  return {
    threadId: row.threadId,
    state: stateOf(running, row.stopReason),
    label: oneLine(row.label, LABEL_BYTES),
    ...row.branch === undefined ? {} : { branch: row.branch },
    ...row.commitsAhead === undefined ? {} : { commitsAhead: row.commitsAhead },
    ...row.uncommitted === undefined ? {} : { uncommitted: row.uncommitted },
    ...row.note === undefined || row.note.trim() === '' ? {} : { note: oneLine(row.note, NOTE_BYTES) },
  }
}

/** Format one entry as a single line. */
function renderEntry(entry: ThreadStatusEntry): string {
  const counts = [
    ...entry.commitsAhead === undefined ? [] : [`${entry.commitsAhead} commits ahead`],
    ...entry.uncommitted === undefined ? [] : [`${entry.uncommitted} uncommitted`],
  ]
  return [
    `${entry.threadId} [${entry.state}] ${entry.label}`,
    ...entry.branch === undefined ? [] : [`branch ${entry.branch}`],
    ...counts.length === 0 ? [] : [counts.join(', ')],
    ...entry.note === undefined ? [] : [`note: ${entry.note}`],
  ].join(' | ')
}

/**
 * Render a result as the model's text, clamped to `maxBytes`.
 * @param value - the result to render.
 * @param maxBytes - byte bound over the whole text including the footer.
 * @returns the text.
 */
export function renderStatus(value: ThreadStatusResult, maxBytes: number): string {
  const text = [
    ...value.threads.length === 0 && value.omitted === 0 ? ['(no threads)'] : value.threads.map(renderEntry),
    ...value.omitted > 0
      ? [`(${value.omitted} of ${value.total} threads omitted; filter by state or raise limit)`]
      : [],
  ].join('\n')
  return truncateUtf8(text, maxBytes)
}

/**
 * Keep the longest prefix of `entries` whose complete rendering fits the bound.
 * @param entries - matching entries already cut to the row limit.
 * @param total - rows matching the filter before any cut.
 * @param maxBytes - byte bound over the rendered text including the footer.
 * @returns the result carrying only entries that render within the bound.
 */
export function fitStatus(entries: ThreadStatusEntry[], total: number, maxBytes: number): ThreadStatusResult {
  let kept = entries.length
  while (kept > 0
    && byteLength(renderStatus(statusResult(entries.slice(0, kept), total), Infinity)) > maxBytes) kept -= 1
  return statusResult(entries.slice(0, kept), total)
}

/** Build the result record for a kept prefix. */
function statusResult(threads: ThreadStatusEntry[], total: number): ThreadStatusResult {
  return { threads, total, truncated: threads.length < total, omitted: total - threads.length }
}
