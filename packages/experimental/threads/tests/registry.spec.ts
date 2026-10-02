/**
 * Registry integration suite: the `threads` unit driven through the real
 * `ctx.sessionProjections` seam.
 *
 * SBFT coverage: E2 (a foreign event produces no downstream work at all), E3
 * (checkpoint plus tail restore equals the in-memory fold and the checkpoint
 * advances), E4 (a `stateVersion` mismatch discards the persisted row and
 * refolds from init), E7 (registering the key twice at a different
 * `stateVersion` throws loudly).
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { ProjectionCheckpoint } from '@deepseek-ai/dsh-session-projection'
import type { ThreadStatusRow } from '../src/types.ts'
import { ThreadId } from '../src/types.ts'
import { applyThreadsEvent, emptyThreadsState, threadsProjectionDefinition } from '../src/projection.ts'
import type { ThreadsProjectionState } from '../src/projection.ts'

const ALPHA = ThreadId('thread-a')
const BETA = ThreadId('thread-b')
const LIVE_VERSION = threadsProjectionDefinition.stateVersion

interface LogEntry {
  readonly event: SessionEvent
  readonly threads: ThreadStatusRow[]
}

/** The exact durable log a Project Session records, with its Thread view per seq. */
function buildLog(session: Session): readonly LogEntry[] {
  const entries: LogEntry[] = []
  const record = (event: SessionEvent, threads: ThreadStatusRow[]): void => {
    entries.push({ event, threads })
  }
  record(session.append('thread/created', {
    threadId: ALPHA,
    label: 'port auth',
    worktree: '/wt/a',
    branch: 'dsh/thread-a',
  }), [
    { threadId: ALPHA, label: 'port auth', worktree: '/wt/a', branch: 'dsh/thread-a' },
  ])
  record(session.append('thread/status', {
    threadId: ALPHA,
    stopReason: 'completed',
    note: 'shipped',
  }), [
    {
      threadId: ALPHA,
      label: 'port auth',
      stopReason: 'completed',
      note: 'shipped',
      worktree: '/wt/a',
      branch: 'dsh/thread-a',
    },
  ])
  record(session.append('thread/created', { threadId: BETA, label: 'fix flaky test' }), [
    {
      threadId: ALPHA,
      label: 'port auth',
      stopReason: 'completed',
      note: 'shipped',
      worktree: '/wt/a',
      branch: 'dsh/thread-a',
    },
    { threadId: BETA, label: 'fix flaky test' },
  ])
  record(session.append('thread/status', {
    threadId: BETA,
    stopReason: 'error',
    note: 'build broke',
  }), [
    {
      threadId: ALPHA,
      label: 'port auth',
      stopReason: 'completed',
      note: 'shipped',
      worktree: '/wt/a',
      branch: 'dsh/thread-a',
    },
    { threadId: BETA, label: 'fix flaky test', stopReason: 'error', note: 'build broke' },
  ])
  return entries
}

/** Fold the pure unit over the log prefix, exactly as a cold read would. */
function foldTo(entries: readonly LogEntry[], end: number, header: SessionHeader): ThreadsProjectionState {
  let state = threadsProjectionDefinition.init(header, SessionLogOffset(0))
  for (const entry of entries.slice(0, end)) state = applyThreadsEvent(state, entry.event)
  return state
}

async function harness(): Promise<{ ctx: Context; session: Session; entries: readonly LogEntry[] }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  ctx.sessionProjections.register(threadsProjectionDefinition)
  const session = ctx.sessions.create()
  return { ctx, session, entries: buildLog(session) }
}

function eventsFrom(entries: readonly LogEntry[], start: number): SessionEvent[] {
  return entries.slice(start).map(entry => entry.event)
}

describe('threads projection through the registry', () => {
  it('folds appended log-only events into the served Thread view', async () => {
    const { ctx, session, entries } = await harness()
    const snapshot = ctx.sessionProjections.snapshot(session, ['threads'])
    expect(snapshot.values.threads).toEqual(entries[entries.length - 1]?.threads)
    expect(snapshot.asOfSeq).toBe(entries.length - 1)
  })

  it('E2: a foreign event publishes nothing to the change feed', async () => {
    const { ctx, session } = await harness()
    const seen: string[] = []
    ctx.sessionProjections.onChanged((_changed, key) => { seen.push(key) })
    const before = ctx.sessionProjections.snapshot(session, ['threads']).values.threads
    session.append('turn/start', { turn: 2 })
    // The change feed is the identity gate that matters: `snapshot` re-parses
    // every served value through its viewSchema, so it never preserves an
    // array reference. Silence here proves the unit returned the same state.
    expect(ctx.sessionProjections.snapshot(session, ['threads']).values.threads).toEqual(before)
    expect(seen).toEqual([])
  })

  it('E8: the durable thread/status append updates the served row', async () => {
    const { ctx, session } = await harness()
    session.append('thread/status', { threadId: ALPHA, uncommitted: 2 })
    const rows = ctx.sessionProjections.snapshot(session, ['threads']).values.threads ?? []
    expect(rows[0]).toEqual({
      threadId: ALPHA,
      label: 'port auth',
      stopReason: 'completed',
      note: 'shipped',
      uncommitted: 2,
      worktree: '/wt/a',
      branch: 'dsh/thread-a',
    })
  })

  it('D-row: a removed Thread leaves the served view', async () => {
    const { ctx, session } = await harness()
    session.append('thread/removed', { threadId: ALPHA })
    expect(ctx.sessionProjections.snapshot(session, ['threads']).values.threads?.map(row => row.threadId))
      .toEqual([BETA])
  })

  it('E3: checkpoint plus tail restore equals the in-memory fold and advances the checkpoint', async () => {
    const { ctx, session, entries } = await harness()
    const header = session.header
    const cut = 3 // the durable checkpoint stops just before the last Thread report
    const stored: ProjectionCheckpoint = {
      threads: { ver: LIVE_VERSION, seq: SessionSeq(cut - 1), val: foldTo(entries, cut, header) },
    }
    const tail = eventsFrom(entries, cut)
    expect(ctx.sessionProjections.restoreFloor(stored)).toBe(cut - 1)

    const { snapshot, checkpoint } = ctx.sessionProjections.restore(
      stored,
      tail,
      SessionLogOffset(cut),
      header,
      SessionLogOffset(0),
    )
    expect(snapshot.values.threads).toEqual(ctx.sessionProjections.snapshot(session, ['threads']).values.threads)
    expect(snapshot.values.threads).toEqual(entries[entries.length - 1]?.threads)
    expect(snapshot.asOfSeq).toBe(entries.length - 1)
    expect(checkpoint.threads).toEqual({
      ver: LIVE_VERSION,
      seq: SessionSeq(entries.length - 1),
      val: foldTo(entries, entries.length, header),
    })
  })

  it('E4: a stateVersion mismatch discards the row and refolds from init', async () => {
    const { ctx, session, entries } = await harness()
    const header = session.header
    const stale: ProjectionCheckpoint = {
      // A row written by a newer unit: never forward-applied into this state.
      threads: { ver: LIVE_VERSION + 1, seq: SessionSeq(1), val: { threads: [{ threadId: ALPHA, label: 'garbage', running: true }] } },
    }
    // A mismatch pulls the floor to 0 so the key refolds the whole log.
    expect(ctx.sessionProjections.restoreFloor(stale)).toBe(0)

    const { snapshot, checkpoint } = ctx.sessionProjections.restore(
      stale,
      eventsFrom(entries, 0),
      SessionLogOffset(0),
      header,
      SessionLogOffset(0),
    )
    expect(snapshot.values.threads).toEqual(entries[entries.length - 1]?.threads)
    expect(checkpoint.threads?.ver).toBe(LIVE_VERSION)
    expect(checkpoint.threads?.val).toEqual(foldTo(entries, entries.length, header))
  })

  it('E4: a mismatched row above a nonzero floor is refused for a full re-read', async () => {
    const { ctx, session, entries } = await harness()
    expect(() => ctx.sessionProjections.restore(
      { threads: { ver: LIVE_VERSION + 1, seq: SessionSeq(1), val: emptyThreadsState() } },
      eventsFrom(entries, 2),
      SessionLogOffset(2),
      session.header,
      SessionLogOffset(0),
    )).toThrow(/re-read from seq 0/)
  })

  it('E7: registering the key twice at a different stateVersion throws loudly', async () => {
    const { ctx } = await harness()
    expect(() => ctx.sessionProjections.register({
      ...threadsProjectionDefinition,
      stateVersion: LIVE_VERSION + 1,
    })).toThrow(
      new RegExp(`already registered at stateVersion ${String(LIVE_VERSION)}`),
    )
  })

  it('E7: re-registering the same key at the same stateVersion is a counted share', async () => {
    const { ctx } = await harness()
    const dispose = ctx.sessionProjections.register(threadsProjectionDefinition)
    expect(() => { dispose() }).not.toThrow()
    // The first registration is still live, so the key survives.
    expect(ctx.sessionProjections.restoreFloor({})).toBe(0)
  })
})
