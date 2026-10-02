import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId, SESSION_FORMAT_VERSION, adoptSessionEvent } from '../src/index.ts'
import { SessionFormatUnsupportedError, validateStoredEvents } from '@deepseek-ai/dsh-session-persistence'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { SessionEvent, SessionHeader } from '../src/index.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'test/informational': { note: string }
  }
}

describe('Session.append ignorable option', () => {
  it('stamps the ignorable marker on the appended frozen event', () => {
    const session = Session.create(SessionId('ignorable-append'))
    const event = session.append('test/informational', { note: 'a' }, { ignorable: true })
    expect(event.ignorable).toBe(true)
    expect(Object.isFrozen(event)).toBe(true)
    expect(session.snapshotEvents()[0]?.ignorable).toBe(true)
  })

  it('leaves the marker absent without the option', () => {
    const session = Session.create(SessionId('plain-append'))
    expect(session.append('test/informational', { note: 'a' })).not.toHaveProperty('ignorable')
    expect(session.append('test/informational', { note: 'b' }, {})).not.toHaveProperty('ignorable')
  })

  it('keeps the marker through JSON serialization, adoption, and seeding', () => {
    const session = Session.create(SessionId('ignorable-roundtrip'))
    session.append('test/informational', { note: 'a' }, { ignorable: true })
    const stored = JSON.parse(JSON.stringify(session.snapshotEvents())) as SessionEvent[]
    expect(adoptSessionEvent(stored[0]!).ignorable).toBe(true)
    const reloaded = Session.create(SessionId('ignorable-reloaded'), stored)
    expect(reloaded.snapshotEvents()[0]?.ignorable).toBe(true)
  })

  it('rejects the options bag on surface types at compile time', () => {
    const session = Session.create(SessionId('surface-type'))
    // @ts-expect-error surface events require SurfaceIntent, not AppendOptions
    expect(() => session.append('user/message', {} as never, { ignorable: true })).toThrow()
  })
})

describe('stored-log validation of an unknown ignorable type', () => {
  /** Stored header for the reload cases. */
  const header: SessionHeader = {
    version: SESSION_FORMAT_VERSION,
    id: SessionId('stored'),
    createdAt: 0,
    isSeeded: false,
  }

  it('refuses an unknown type without the marker and accepts the marked one', () => {
    // A type this build does not declare can only arrive as parsed stored JSON.
    const unmarked = JSON.parse('[{"type":"plugin/unknown","seq":0,"time":1,"data":{}}]') as SessionEvent[]
    expect(() => validateStoredEvents(header, unmarked)).toThrow(SessionFormatUnsupportedError)
    const marked = JSON.parse('[{"type":"plugin/unknown","seq":0,"time":1,"data":{},"ignorable":true}]') as SessionEvent[]
    expect(validateStoredEvents(header, marked)).toBe(marked)
  })
})

describe('JSONL round trip', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })

  it('stores the marker and reloads the event with it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-session-ignorable-'))
    roots.push(root)
    const ctx = new Context()
    await ctx.plugin(JsonlSessionPersistence, { root })
    try {
      const session = Session.create(SessionId('jsonl-ignorable'))
      session.append('test/informational', { note: 'kept' }, { ignorable: true })
      const handle = await ctx.sessionPersistence.create(session.header)
      await handle.append(session.snapshotEvents())
      await handle.flush()
      await handle.close()

      const reloaded = await ctx.sessionPersistence.open(SessionId('jsonl-ignorable'), 'read')
      const stored = await reloaded.read()
      await reloaded.close()
      expect(stored.events[0]?.ignorable).toBe(true)
      expect(stored.events[0]?.data).toEqual({ note: 'kept' })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
