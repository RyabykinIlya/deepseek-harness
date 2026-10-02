/**
 * Pure-fold suite for the `threads` projection unit.
 *
 * SBFT coverage: E1 (determinism), E2 (foreign events return the SAME
 * reference), E8 (the durable `thread/status` log event is the only truthful
 * status path), plus the D-row shape rules — `running` and `stopReason` stay
 * two orthogonal fields, a removed Thread leaves the view, and multiple
 * Threads keep stable creation order.
 */

import { describe, expect, it } from 'vitest'
import { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionEventMap, SessionEventType, SessionHeader } from '@deepseek-ai/dsh-session'
import { ThreadId } from '../src/types.ts'
import {
  applyThreadsEvent,
  emptyThreadsState,
  threadsProjectionDefinition,
  threadsProjectionView,
} from '../src/projection.ts'
import type { ThreadsProjectionState } from '../src/projection.ts'

const HEADER: SessionHeader = {
  version: SESSION_FORMAT_VERSION,
  id: SessionId('threads-root'),
  createdAt: 0,
  isSeeded: false,
}

const ALPHA = ThreadId('thread-a')
const BETA = ThreadId('thread-b')
const GHOST = ThreadId('thread-ghost')

function event(type: 'thread/created', data: SessionEventMap['thread/created'], seq: number): SessionEvent<'thread/created'>
function event(type: 'thread/status', data: SessionEventMap['thread/status'], seq: number): SessionEvent<'thread/status'>
function event(type: 'thread/removed', data: SessionEventMap['thread/removed'], seq: number): SessionEvent<'thread/removed'>
function event(
  type: Extract<SessionEventType, `thread/${string}`>,
  data: SessionEventMap['thread/created'] | SessionEventMap['thread/status'] | SessionEventMap['thread/removed'],
  seq: number,
): SessionEvent {
  const base = { seq: SessionSeq(seq), time: seq }
  switch (type) {
    case 'thread/created':
      return { ...base, type, data: data as SessionEventMap['thread/created'] }
    case 'thread/status':
      return { ...base, type, data }
    case 'thread/removed':
      return { ...base, type, data }
  }
}

function turnStart(seq: number): SessionEvent {
  return { type: 'turn/start', data: { turn: 1 }, seq: SessionSeq(seq), time: seq }
}

/** Fold a whole log from init, exactly as the registry would on a cold read. */
function fold(events: readonly SessionEvent[]): ThreadsProjectionState {
  let state = threadsProjectionDefinition.init(HEADER, SessionLogOffset(0))
  for (const next of events) state = applyThreadsEvent(state, next)
  return state
}

const LOG = [
  event('thread/created', { threadId: ALPHA, label: 'port auth', worktree: '/wt/a', branch: 'dsh/thread-a', baseSha: 'abc123' }, 0),
  event('thread/created', { threadId: BETA, label: 'fix flaky test' }, 1),
  event('thread/status', { threadId: ALPHA, stopReason: 'completed', note: 'merged by hand' }, 2),
  event('thread/status', { threadId: BETA, stopReason: 'error', note: 'build broke' }, 3),
] as const satisfies readonly SessionEvent[]

describe('threads projection fold', () => {
  it('folds the same log from init to the same state every time', () => {
    expect(fold(LOG)).toEqual(fold(LOG))
    expect(fold(LOG)).toEqual(fold([...LOG]))
  })

  it('an empty log yields the initial state and an empty view', () => {
    const state = threadsProjectionDefinition.init(HEADER, SessionLogOffset(0))
    expect(state).toEqual(emptyThreadsState())
    expect(threadsProjectionView(state)).toEqual([])
  })

  it('declares state version 2 and round-trips through its strict schema', () => {
    expect(threadsProjectionDefinition.stateVersion).toBe(2)
    const state = fold(LOG)
    expect(threadsProjectionDefinition.stateSchema.parse(JSON.parse(JSON.stringify(state)))).toEqual(state)
    expect(() => threadsProjectionDefinition.stateSchema.parse({
      threads: [{ threadId: 'x', label: 'x', running: true }],
    })).toThrow()
  })

  it('a foreign event returns the identical state reference', () => {
    const state = fold(LOG)
    expect(applyThreadsEvent(state, turnStart(9))).toBe(state)
    const empty = emptyThreadsState()
    expect(applyThreadsEvent(empty, turnStart(0))).toBe(empty)
  })

  it('the view carries durable facts and no liveness field', () => {
    const view = threadsProjectionView(fold(LOG))
    expect(view.map(row => row.threadId)).toEqual([ALPHA, BETA])
    expect(view[0]).toEqual({
      threadId: ALPHA,
      label: 'port auth',
      stopReason: 'completed',
      worktree: '/wt/a',
      branch: 'dsh/thread-a',
      baseSha: 'abc123',
      note: 'merged by hand',
    })
    expect(view[1]).toEqual({ threadId: BETA, label: 'fix flaky test', stopReason: 'error', note: 'build broke' })
    expect(view[0]).not.toHaveProperty('running')
  })

  it('a fresh Thread has no stopReason; every outcome including refusal is accepted', () => {
    const fresh = threadsProjectionView(fold([event('thread/created', { threadId: ALPHA, label: 'a' }, 0)]))
    expect(fresh[0]).toEqual({ threadId: ALPHA, label: 'a' })
    for (const stopReason of ['completed', 'aborted', 'error', 'max-tokens', 'refusal'] as const) {
      const row = threadsProjectionView(fold([
        event('thread/created', { threadId: ALPHA, label: 'a' }, 0),
        event('thread/status', { threadId: ALPHA, stopReason }, 1),
      ]))[0]
      expect(row).toMatchObject({ stopReason })
    }
  })

  it('a status report merges worktree facts without touching the recorded outcome', () => {
    const state = fold([
      ...LOG,
      event('thread/status', { threadId: ALPHA, commitsAhead: 3, uncommitted: 0 }, 4),
    ])
    expect(threadsProjectionView(state)[0]).toMatchObject({
      stopReason: 'completed',
      note: 'merged by hand',
      commitsAhead: 3,
      uncommitted: 0,
    })
  })

  it('a report that closes a turn replaces the previous note instead of keeping it', () => {
    const state = fold([
      ...LOG,
      event('thread/status', { threadId: ALPHA, stopReason: 'aborted' }, 4),
    ])
    const row = threadsProjectionView(state)[0]
    expect(row).toMatchObject({ stopReason: 'aborted' })
    expect(row).not.toHaveProperty('note')
  })

  it('a removed Thread disappears from the view', () => {
    const state = fold([...LOG, event('thread/removed', { threadId: ALPHA }, 4)])
    expect(threadsProjectionView(state).map(row => row.threadId)).toEqual([BETA])
  })

  it('a removal of an unknown Thread is a no-op that keeps the same reference', () => {
    const state = fold(LOG)
    expect(applyThreadsEvent(state, event('thread/removed', { threadId: GHOST }, 5))).toBe(state)
  })

  it('a status for an unknown Thread is ignored and keeps the same reference', () => {
    const state = fold(LOG)
    expect(applyThreadsEvent(state, event('thread/status', { threadId: GHOST, stopReason: 'error' }, 6))).toBe(state)
  })

  it('re-announcing a Thread keeps its recorded outcome', () => {
    const state = fold([
      event('thread/created', { threadId: ALPHA, label: 'first name' }, 0),
      event('thread/status', { threadId: ALPHA, stopReason: 'completed' }, 1),
      event('thread/created', { threadId: ALPHA, label: 'renamed' }, 2),
    ])
    expect(state.threads).toHaveLength(1)
    expect(threadsProjectionView(state)[0]).toMatchObject({ label: 'renamed', stopReason: 'completed' })
  })

  it('the wire view satisfies its own schema for every reachable state', () => {
    for (const state of [emptyThreadsState(), fold(LOG), applyThreadsEvent(fold(LOG), event('thread/removed', { threadId: ALPHA }, 4))]) {
      const view = threadsProjectionView(state)
      expect(threadsProjectionDefinition.wire.viewSchema.parse(view)).toEqual(view)
    }
  })
})
