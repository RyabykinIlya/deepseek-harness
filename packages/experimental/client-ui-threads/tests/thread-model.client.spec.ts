/** A Thread's routing decision as the roster reads it out of the projection map. */

import { describe, expect, it } from 'vitest'
import type { ModelRoutingView } from '@deepseek-ai/dsh-experimental-model-routing/client'
import { readThreadModel, threadModelLabel } from '../src/client/thread-model.ts'

const VIEW: ModelRoutingView = {
  requested: 'flash',
  tier: 'flash',
  model: 'deepseek/deepseek-v4-flash',
  providerName: 'StreamLake',
  quantization: 'fp8',
  boundary: 'start',
  decidedAt: 1,
  unpinned: false,
}

describe('readThreadModel', () => {
  it('reads a published block', () => {
    expect(readThreadModel({ t1: { values: { modelRouting: VIEW } } }, 't1')).toEqual(VIEW)
  })

  it('has nothing for a Thread whose block is absent', () => {
    expect(readThreadModel({}, 't1')).toBeUndefined()
    expect(readThreadModel({ t1: {} }, 't1')).toBeUndefined()
    expect(readThreadModel({ t1: { values: {} } }, 't1')).toBeUndefined()
  })

  it('rejects a block whose fields are not the view\'s', () => {
    expect(readThreadModel({ t1: { values: { modelRouting: { tier: 'flash' } } } }, 't1')).toBeUndefined()
    expect(readThreadModel({ t1: { values: { modelRouting: { ...VIEW, decidedAt: 'soon' } } } }, 't1')).toBeUndefined()
    expect(readThreadModel({ t1: { values: { modelRouting: [VIEW] } } }, 't1')).toBeUndefined()
    expect(readThreadModel({ t1: { values: { modelRouting: null } } }, 't1')).toBeUndefined()
  })
})

describe('threadModelLabel', () => {
  it('names the tier and the model without its author prefix', () => {
    expect(threadModelLabel(VIEW)).toBe('flash deepseek-v4-flash')
    expect(threadModelLabel({ ...VIEW, model: 'stealth' })).toBe('flash stealth')
  })
})
