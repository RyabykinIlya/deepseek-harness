import { describe, expect, it } from 'vitest'
import { routingDirectOf, routingEndpointOf, routingSourceOf } from '../src/endpoint.ts'

describe('routingEndpointOf', () => {
  it('carries every fact the endpoint published, discount included', () => {
    expect(routingEndpointOf({
      slug: 'gmicloud/fp8',
      providerName: 'GMICloud',
      quantization: 'fp8',
      promptPrice: 9e-8,
      completionPrice: 3e-7,
      inputCacheReadPrice: 1.8e-8,
      discount: 0.4,
      contextLength: 1_048_576,
      maxCompletionTokens: 943_718,
    })).toEqual({
      tag: 'gmicloud/fp8',
      providerName: 'GMICloud',
      quantization: 'fp8',
      promptUsd: 9e-8,
      completionUsd: 3e-7,
      cacheReadUsd: 1.8e-8,
      discount: 0.4,
      contextLength: 1_048_576,
      maxCompletionTokens: 943_718,
    })
  })

  it('names an unstated price zero and omits every other absent field', () => {
    expect(routingEndpointOf({ slug: 'bare' }))
      .toEqual({ tag: 'bare', promptUsd: 0, completionUsd: 0 })
  })
})

describe('routingSourceOf', () => {
  it('names the OpenRouter kind for an endpoint and the route key for a direct source', () => {
    expect(routingSourceOf({ slug: 'gmicloud/fp8' })).toEqual({ kind: 'openrouter', tag: 'gmicloud/fp8' })
    expect(routingSourceOf({
      kind: 'direct', route: 'claude-proxy', model: 'xiaomi/mimo-v2.6-pro', id: 'mimo-v2.6-pro',
    })).toEqual({ kind: 'claude-proxy', tag: 'mimo-v2.6-pro' })
  })
})

describe('routingDirectOf', () => {
  it('carries the route and exactly the prices the source declared', () => {
    expect(routingDirectOf({
      kind: 'direct',
      route: 'xiaomi-plan',
      model: 'xiaomi/mimo-v2.6-pro',
      id: 'mimo-v2.6-pro',
      prices: { prompt: 1.455e-9, completion: 2e-9 },
    })).toEqual({
      tag: 'mimo-v2.6-pro',
      providerName: 'xiaomi-plan',
      promptUsd: 1.455e-9,
      completionUsd: 2e-9,
    })
  })

  it('leaves an unpriced source unpriced rather than free', () => {
    // A zero here would read as "costs nothing"; silence is what a source that
    // states no price actually is.
    expect(routingDirectOf({
      kind: 'direct', route: 'claude-proxy', model: 'm', id: 'm',
    })).toEqual({ tag: 'm', providerName: 'claude-proxy' })
  })
})
