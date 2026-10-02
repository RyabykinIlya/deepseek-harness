/**
 * Presentation model for the two orthogonal Thread status axes.
 *
 * A roster row carries `running` (computed client-side from the Session store)
 * and `stopReason` (from the durable row) side by side, and the domain
 * explicitly forbids collapsing them into one status enum. This module
 * is the single place that reads them, and it keeps them apart all the way to
 * the DOM: a {@link ThreadLiveness} (runtime liveness) and an optional
 * {@link ThreadOutcome} (terminal outcome of the last turn) travel as two
 * separate values, and the row renders two separate elements — one spinner/dot
 * for liveness, one glyph-plus-label chip for the outcome. Nothing here
 * produces a single combined `status` string, so no component can accidentally
 * invent a state the runtime does not produce.
 */
import type { ReactElement } from 'react'
import type { ThreadStopReason } from '@deepseek-ai/dsh-experimental-threads/client'
import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ThreadKey } from './locales.ts'
import type { ThreadRosterRow } from './roster.ts'
import css from './ThreadStatus.module.css'

/** The liveness axis on its own: is a turn active right now. */
export interface ThreadLiveness {
  /** The wire value, unmodified — a spinner reads `live`, a dim dot reads `settled`. */
  readonly live: boolean
  /** Presenter key for the liveness axis. */
  readonly labelKey: 'liveness.running' | 'liveness.idle'
  /** Liveness marker; `ongoing` is the shipped spinner. */
  readonly dot: StateDotState
}

/** Presenter keys of the terminal outcomes, one per `stopReason`. */
export type ThreadOutcomeKey = Extract<ThreadKey,
  'outcome.completed' | 'outcome.aborted' | 'outcome.error' | 'outcome.maxTokens' | 'outcome.refusal'>

/**
 * The terminal-outcome axis on its own, or absent. Absent is meaningful: while
 * a turn is in flight there is no outcome yet, and a settled Thread whose last
 * report carried no outcome is idle/settled rather than failed.
 */
export interface ThreadOutcome {
  /** The wire value, unmodified. */
  readonly reason: ThreadStopReason
  /** Presenter key for this specific outcome; a distinct glyph pairs with it. */
  readonly labelKey: ThreadOutcomeKey
  /** Tonal marker for the outcome glyph. */
  readonly dot: StateDotState
}

/** Both axes of one Thread row, kept in their own fields. */
export interface ThreadStatus {
  readonly liveness: ThreadLiveness
  /** Absent while a turn is in flight, and for a settled Thread with no recorded outcome. */
  readonly outcome: ThreadOutcome | undefined
}

/** Closed-union backstop for the wire outcome set. */
/* v8 ignore next 3 -- closed-union backstop; only reached if a status is forged */
function assertNeverOutcome(value: never): never {
  throw new Error(`unhandled thread stop reason: ${JSON.stringify(value)}`)
}

/**
 * Per-outcome presentation. `aborted` and `max-tokens` share the attention tone
 * because both mean the turn ended on someone else's terms, but they keep
 * separate labels and separate glyphs — sharing a tone is not sharing a status.
 * @param reason - the wire terminal outcome.
 * @returns its presenter value, carrying the reason through unmodified.
 */
function outcomeOf(reason: ThreadStopReason): ThreadOutcome {
  switch (reason) {
    case 'completed': return { reason, labelKey: 'outcome.completed', dot: 'done' }
    case 'aborted': return { reason, labelKey: 'outcome.aborted', dot: 'warning' }
    case 'error': return { reason, labelKey: 'outcome.error', dot: 'error' }
    case 'max-tokens': return { reason, labelKey: 'outcome.maxTokens', dot: 'warning' }
    case 'refusal': return { reason, labelKey: 'outcome.refusal', dot: 'error' }
    /* v8 ignore next -- closed wire stop-reason union */
    default: return assertNeverOutcome(reason)
  }
}

/**
 * Read one status row as two independent axes.
 * @param row - the roster row: durable outcome plus client-computed liveness.
 * @returns the liveness axis and, separately, the terminal-outcome axis.
 */
export function threadStatus(row: Pick<ThreadRosterRow, 'running' | 'stopReason'>): ThreadStatus {
  return {
    liveness: row.running
      ? { live: true, labelKey: 'liveness.running', dot: 'ongoing' }
      : { live: false, labelKey: 'liveness.idle', dot: 'idle' },
    // Reported verbatim. The fold clears `stopReason` when a new turn starts,
    // so a live row normally has none; when one is present anyway the panel
    // shows both facts side by side rather than hiding one behind the other.
    outcome: row.stopReason === undefined ? undefined : outcomeOf(row.stopReason),
  }
}

/**
 * Distinct outcome glyph, one per `stopReason`. Drawn here rather than taken
 * from a primitive because the outcome vocabulary is this domain's and a
 * shared icon set has no member for "the turn ran out of tokens".
 * @param outcome - the terminal-outcome axis value.
 * @returns the glyph element (aria-hidden; the row pairs it with the outcome label).
 */
export function OutcomeGlyph({ outcome }: { outcome: ThreadOutcome }): ReactElement {
  return (
    <svg
      className={css.glyph}
      data-stop-reason={outcome.reason}
      width="11"
      height="11"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
    >
      {outcome.reason === 'completed' && (
        <path
          d="M2.5 6.4L4.8 8.7L9.5 3.6"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
      {outcome.reason === 'aborted' && (
        <path
          d="M4 2.6V9.4"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
      )}
      {outcome.reason === 'error' && (
        <>
          <path
            d="M6 2.6V6.9"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
          <circle cx="6" cy="9.1" r="0.8" fill="currentColor" />
        </>
      )}
      {outcome.reason === 'max-tokens' && (
        <>
          <path
            d="M2.4 6H9.6"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
          <path
            d="M6 2.6V3.9"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
          <path
            d="M6 8.1V9.4"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </>
      )}
      {outcome.reason === 'refusal' && (
        <>
          <circle cx="6" cy="6" r="3.6" stroke="currentColor" strokeWidth="1.3" />
          <path
            d="M3.5 8.5L8.5 3.5"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
          />
        </>
      )}
    </svg>
  )
}
