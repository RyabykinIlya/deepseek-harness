import { describe, expect, it } from 'vitest'
import { EFFORT_ORDER, mapEffort } from '../src/effort.ts'

describe('mapEffort', () => {
  it('passes a supported effort through', () => {
    expect(mapEffort('low', ['low', 'high', 'max'])).toBe('low')
  })

  it('rounds up to the nearest supported effort', () => {
    expect(mapEffort('medium', ['off', 'high', 'xhigh'])).toBe('high')
    expect(mapEffort('medium', ['low', 'high', 'max'])).toBe('high')
  })

  it('rounds down only when nothing above is supported, and never to "no reasoning"', () => {
    expect(mapEffort('high', ['off', 'low', 'medium'])).toBe('medium')
    expect(mapEffort('high', ['off', 'none', 'low'])).toBe('low')
    expect(mapEffort('low', ['off'])).toBeUndefined()
  })

  it('has no answer without a request, without a model vocabulary, or for an unknown name', () => {
    expect(mapEffort('high', undefined)).toBeUndefined()
    expect(mapEffort(undefined, ['high'])).toBeUndefined()
    expect(mapEffort('ultra', ['high'])).toBeUndefined()
    expect(mapEffort('high', [])).toBeUndefined()
    expect(mapEffort('high', ['ultra'])).toBeUndefined()
  })

  it('ignores names outside its own ordering', () => {
    expect(mapEffort('medium', ['off', 'ultra', 'xhigh'])).toBe('xhigh')
  })
})

describe('EFFORT_ORDER', () => {
  it('ranks the cheapest reasoning first', () => {
    expect(EFFORT_ORDER[0]).toBe('off')
    expect(EFFORT_ORDER.at(-1)).toBe('max')
  })
})
