/** Thread state projected incrementally from a Project Session's committed log, with a durable-only client view. */

import { z } from 'zod'
import type { SessionEvent, SessionEventMap, SessionHeader, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { ThreadId, ThreadStatusRow, ThreadStopReason } from './types.ts'
import { ThreadId as toThreadId } from './types.ts'

const nonNegativeSafeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const threadIdSchema = z.string().min(1).transform(value => toThreadId(value))
const threadStopReasonSchema = z.enum(['completed', 'aborted', 'error', 'max-tokens', 'refusal'])

/**
 * One Thread's durable fold row.
 *
 * Plain JSON throughout — the persisted-cache precondition — so every optional
 * field is omitted rather than set to `undefined` when absent. Carries no
 * liveness: whether a turn is active is a runtime fact, not a logged one.
 */
export interface ThreadState {
  /** Durable Thread identity. */
  readonly threadId: ThreadId
  /** Task label recorded at creation; not Thread identity. */
  readonly label: string
  /** Outcome of the last finished turn; absent before the first one finishes. */
  readonly stopReason?: ThreadStopReason
  /** `dsh/<thread-short>` branch, absent for a detached worktree. */
  readonly branch?: string
  /** Absolute path of the Thread's working directory. */
  readonly worktree?: string
  /** Commit the worktree was created at. */
  readonly baseSha?: string
  /** Commits ahead of {@link baseSha}, as last reported. */
  readonly commitsAhead?: number
  /** Uncommitted entries, as last reported. */
  readonly uncommitted?: number
  /** Bounded start of the Thread's closing message. */
  readonly note?: string
}

/** Checkpoint-safe state for the Threads owned by the projected Project Session. */
export interface ThreadsProjectionState {
  /** Threads in durable creation order; removed Threads are dropped. */
  readonly threads: readonly ThreadState[]
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    threads: ThreadsProjectionState
  }
}

const threadFieldSchemas = {
  threadId: threadIdSchema,
  label: z.string(),
  stopReason: threadStopReasonSchema.optional(),
  branch: z.string().optional(),
  worktree: z.string().optional(),
  baseSha: z.string().optional(),
  commitsAhead: nonNegativeSafeInteger.optional(),
  uncommitted: nonNegativeSafeInteger.optional(),
  note: z.string().optional(),
}

const threadStateSchema = z.object(threadFieldSchemas).strict() as z.ZodType<ThreadState>

const threadsProjectionStateSchema = z.object({
  threads: z.array(threadStateSchema),
}).strict() as z.ZodType<ThreadsProjectionState>

const threadStatusRowSchema = z.object(threadFieldSchemas).strict() as z.ZodType<ThreadStatusRow>

/**
 * State for a Project Session that has created no Threads.
 * @returns the empty Threads state.
 */
export function emptyThreadsState(): ThreadsProjectionState {
  return { threads: [] }
}

/** Whether one event belongs to the Threads domain. */
export type ThreadEventType = 'thread/created' | 'thread/status' | 'thread/removed'

/** One event owned by the Threads domain. */
type ThreadSessionEvent = SessionEvent<ThreadEventType>

/**
 * Test whether a Session event belongs to the Threads domain.
 * @param event - candidate Session event.
 * @returns whether the event has a Thread-owned type.
 */
export function isThreadEvent(event: SessionEvent): event is ThreadSessionEvent {
  return event.type === 'thread/created'
    || event.type === 'thread/status'
    || event.type === 'thread/removed'
}

/**
 * Omit an absent optional field rather than storing `undefined`.
 * @param value - candidate optional value.
 * @param key - property name to set when the value is present.
 * @returns an object carrying the property, or an empty object.
 */
function optional<T extends object, K extends keyof T>(value: T[K] | undefined, key: K): Pick<T, K> | Record<never, never> {
  return value === undefined ? {} : { [key]: value }
}

function createThread(state: ThreadsProjectionState, data: SessionEventMap['thread/created']): ThreadsProjectionState {
  const index = state.threads.findIndex(candidate => candidate.threadId === data.threadId)
  const prior = state.threads[index]
  // Re-announcing an existing Thread only re-states its identity fields; a
  // duplicate creation must never reset a recorded outcome.
  const next: ThreadState = {
    ...prior,
    threadId: data.threadId,
    label: data.label,
    ...optional(data.branch, 'branch'),
    ...optional(data.worktree, 'worktree'),
    ...optional(data.baseSha, 'baseSha'),
  }
  const threads = [...state.threads]
  if (index < 0) threads.push(next)
  else threads[index] = next
  return { threads }
}

function statusThread(state: ThreadsProjectionState, data: SessionEventMap['thread/status']): ThreadsProjectionState {
  const index = state.threads.findIndex(candidate => candidate.threadId === data.threadId)
  const prior = state.threads[index]
  // A status for a Thread this log never created carries no row to update. The
  // fold stays total during replay rather than throwing mid-restore.
  if (prior === undefined) return state
  // A report carrying a `stopReason` closes a turn and replaces the whole
  // outcome pair, so the previous turn's `note` never outlives its turn.
  const { note: priorNote, ...kept } = prior
  const closes = data.stopReason !== undefined
  const next: ThreadState = {
    ...kept,
    ...optional(data.stopReason, 'stopReason'),
    ...optional(closes ? data.note : data.note ?? priorNote, 'note'),
    ...optional(data.commitsAhead, 'commitsAhead'),
    ...optional(data.uncommitted, 'uncommitted'),
  }
  const threads = [...state.threads]
  threads[index] = next
  return { threads }
}

function removeThread(state: ThreadsProjectionState, threadId: ThreadId): ThreadsProjectionState {
  const threads = state.threads.filter(candidate => candidate.threadId !== threadId)
  return threads.length === state.threads.length ? state : { threads }
}

function applyThreadEvent(state: ThreadsProjectionState, event: ThreadSessionEvent): ThreadsProjectionState {
  switch (event.type) {
    case 'thread/created':
      return createThread(state, event.data)
    case 'thread/status':
      return statusThread(state, event.data)
    case 'thread/removed':
      return removeThread(state, event.data.threadId)
    /* v8 ignore next 2 -- ThreadEventType is closed and every member is handled above. */
    default:
      return state
  }
}

/**
 * Fold one committed event into the Threads state.
 *
 * Pure and synchronous. An event outside the Threads domain returns the
 * identical state reference, which is what suppresses all downstream work.
 * @param state - state covering every prior event.
 * @param event - the next committed Session event.
 * @returns the next state, or the same reference when the event is not the unit's.
 */
export function applyThreadsEvent(state: ThreadsProjectionState, event: SessionEvent): ThreadsProjectionState {
  if (!isThreadEvent(event)) return state
  return applyThreadEvent(state, event)
}

/**
 * Project the durable Thread rows a client renders.
 *
 * The caller is the registry, which caches by state reference, so an unchanged
 * state never rebuilds this array.
 * @param state - current Threads state.
 * @returns one status row per Thread, in durable creation order.
 */
export function threadsProjectionView(state: ThreadsProjectionState): ThreadStatusRow[] {
  return state.threads.map(thread => ({ ...thread }))
}

/**
 * Threads projection selected by the projected Session identity; the wire view
 * carries durable Thread status only, never live registry lookups.
 */
export const threadsProjectionDefinition = {
  key: 'threads',
  stateVersion: 2,
  stateSchema: threadsProjectionStateSchema,
  // The framework calls init with the Session metadata and the fork-inherited prefix
  // length. Threads state starts empty regardless of both, but the unit must accept
  // the contract's full signature so a forked Project does not inherit its ancestor's
  // Thread rows through the fold.
  init: (_header: SessionHeader, _inheritedEventCount: SessionLogOffset) => emptyThreadsState(),
  apply: applyThreadsEvent,
  wire: { viewSchema: z.array(threadStatusRowSchema), view: threadsProjectionView },
} satisfies ProjectionDefinition<'threads', ThreadsProjectionState>
