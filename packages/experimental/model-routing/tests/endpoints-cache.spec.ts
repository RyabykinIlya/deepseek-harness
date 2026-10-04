import { describe, expect, it, vi } from 'vitest'
import { EndpointsCache } from '../src/endpoints-cache.ts'
import type { OpenRouterEndpoint } from '@deepseek-ai/dsh-llm-pi-ai'

const SIGNAL = new AbortController().signal

/** One endpoint, identified only by its slug. */
function endpoint(slug: string): OpenRouterEndpoint {
  return { slug }
}

describe('EndpointsCache', () => {
  it('serves a fresh list without asking again', async () => {
    let clock = 0
    const reader = vi.fn(async (model: string) => [endpoint(`${model}/fp8`)])
    const cache = new EndpointsCache(reader, () => clock)
    const first = await cache.read(['m'], 1000, SIGNAL)
    clock = 999
    const second = await cache.read(['m'], 1000, SIGNAL)
    expect(reader).toHaveBeenCalledTimes(1)
    expect(second.get('m')).toBe(first.get('m'))
  })

  it('reads again once the entry is stale', async () => {
    let clock = 0
    const reader = vi.fn(async (model: string) => [endpoint(`${model}/fp8`)])
    const cache = new EndpointsCache(reader, () => clock)
    await cache.read(['m'], 1000, SIGNAL)
    clock = 1000
    await cache.read(['m'], 1000, SIGNAL)
    expect(reader).toHaveBeenCalledTimes(2)
  })

  it('falls back to the last list of any age when a fresh read fails', async () => {
    let clock = 0
    let failing = false
    const reader = vi.fn(async (model: string) => {
      if (failing) throw new Error('HTTP 503')
      return [endpoint(`${model}/fp8`)]
    })
    const cache = new EndpointsCache(reader, () => clock)
    await cache.read(['m'], 1000, SIGNAL)
    failing = true
    clock = 10 ** 6
    const lists = await cache.read(['m'], 1000, SIGNAL)
    expect(lists.get('m')).toEqual([endpoint('m/fp8')])
  })

  it('reports the failure itself when there is nothing to fall back on', async () => {
    const reader = vi.fn(async () => { throw new Error('HTTP 503') })
    const cache = new EndpointsCache(reader, () => 0)
    const lists = await cache.read(['m'], 1000, SIGNAL)
    expect(lists.get('m')).toBeInstanceOf(Error)
    expect((lists.get('m') as Error).message).toBe('HTTP 503')
  })

  it('shares one read between two callers asking at once', async () => {
    const clock = 0
    let resolveRead: ((list: readonly OpenRouterEndpoint[]) => void) | undefined
    const reader = vi.fn(() => new Promise<readonly OpenRouterEndpoint[]>((resolve) => { resolveRead = resolve }))
    const cache = new EndpointsCache(reader, () => clock)
    const first = cache.read(['m'], 1000, SIGNAL)
    const second = cache.read(['m'], 1000, SIGNAL)
    resolveRead!([endpoint('m/fp8')])
    const [a, b] = await Promise.all([first, second])
    expect(reader).toHaveBeenCalledTimes(1)
    expect(a.get('m')).toEqual(b.get('m'))
  })

  it('answers each model independently', async () => {
    const cache = new EndpointsCache(async model => [endpoint(`${model}/fp8`)], () => 0)
    const lists = await cache.read(['a', 'b'], 1000, SIGNAL)
    expect(lists.get('a')).toEqual([endpoint('a/fp8')])
    expect(lists.get('b')).toEqual([endpoint('b/fp8')])
  })
})
