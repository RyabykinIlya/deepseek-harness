import { describe, expect, it } from 'vitest'
import { boundaryOf } from '../src/boundary.ts'

const BASE = {
  pinned: { requested: 'flash' },
  requested: 'flash',
  failurePending: false,
  compactedSinceDecision: false,
  lastActivityAt: 1000,
  now: 2000,
  cacheIdleMs: 600_000,
}

describe('boundaryOf', () => {
  it('starts a session with no pin, whatever else is true', () => {
    expect(boundaryOf({ ...BASE, pinned: undefined, failurePending: true, compactedSinceDecision: true }))
      .toBe('start')
  })

  it('keeps the pin inside a conversation', () => {
    expect(boundaryOf(BASE)).toBeUndefined()
  })

  it('decides again after a failure, ahead of every other reason', () => {
    expect(boundaryOf({ ...BASE, failurePending: true, compactedSinceDecision: true })).toBe('failure')
  })

  it('decides again when the requested model changed', () => {
    expect(boundaryOf({ ...BASE, requested: 'pro' })).toBe('selection-change')
  })

  it('decides again after a compaction', () => {
    expect(boundaryOf({ ...BASE, compactedSinceDecision: true })).toBe('compaction')
  })

  it('decides again once the pin went idle for longer than the cache window', () => {
    expect(boundaryOf({ ...BASE, now: BASE.lastActivityAt + BASE.cacheIdleMs })).toBeUndefined()
    expect(boundaryOf({ ...BASE, now: BASE.lastActivityAt + BASE.cacheIdleMs + 1 })).toBe('idle')
  })

  it('cannot go idle without a recorded activity time', () => {
    expect(boundaryOf({ ...BASE, lastActivityAt: undefined, now: 10 ** 12 })).toBeUndefined()
  })
})
