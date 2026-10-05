import { describe, expect, it } from 'vitest'
import { routingEndpointOf } from '../src/endpoint.ts'

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
