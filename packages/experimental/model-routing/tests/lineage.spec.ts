import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { liveAncestors } from '../src/lineage.ts'

/** The live Session registry the walk reads. */
type Registry = Map<string, Session>

/** Create one bare live Session with the parentage these cases drive. */
function sessionOf(registry: Registry, id: string, parent?: string): Session {
  const session = {
    id: SessionId(id),
    header: {
      ...parent === undefined ? {} : { parentSession: SessionId(parent) },
    },
  } as Session
  registry.set(id, session)
  return session
}

describe('liveAncestors', () => {
  it('walks a subagent chain nearest first', () => {
    const registry: Registry = new Map()
    sessionOf(registry, 'project')
    const thread = sessionOf(registry, 'thread', 'project')
    const worker = sessionOf(registry, 'worker', 'thread')
    expect(liveAncestors(worker, id => registry.get(id)).map(session => session.id))
      .toEqual([SessionId('thread'), SessionId('project')])
    expect(liveAncestors(thread, id => registry.get(id)).map(session => session.id))
      .toEqual([SessionId('project')])
    expect(liveAncestors(registry.get('project'), id => registry.get(id))).toEqual([])
  })

  it('stops at the first ancestor the Host no longer holds', () => {
    // A resumed Thread may outlive its Project: the absence reads as the end of
    // the lineage, not as a gap to step over.
    const registry: Registry = new Map()
    sessionOf(registry, 'project')
    const thread = sessionOf(registry, 'thread', 'project')
    sessionOf(registry, 'worker', 'thread')
    registry.delete('project')
    expect(liveAncestors(registry.get('worker'), id => registry.get(id)).map(session => session.id))
      .toEqual([SessionId('thread')])
    expect(liveAncestors(thread, id => registry.get(id))).toEqual([])
  })

  it('refuses to revisit a Session a damaged header cycle names', () => {
    const registry: Registry = new Map()
    const loopA = sessionOf(registry, 'loop-a', 'loop-b')
    sessionOf(registry, 'loop-b', 'loop-a')
    expect(liveAncestors(loopA, id => registry.get(id)).map(session => session.id))
      .toEqual([SessionId('loop-b')])
  })

  it('answers nothing for an absent Session', () => {
    expect(liveAncestors(undefined, () => undefined)).toEqual([])
  })
})
