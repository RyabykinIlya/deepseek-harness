import { describe, expect, it, vi } from 'vitest'
import type { OpenRouterCatalogEntry } from '@deepseek-ai/dsh-llm-pi-ai'
import { FamilyCache } from '../src/family-cache.ts'

const CATALOG: readonly OpenRouterCatalogEntry[] = [
  { id: 'deepseek/deepseek-v4-pro', canonicalSlug: 'deepseek/deepseek-v4-pro-20260423' },
  { id: 'deepseek/deepseek-v4-pro-0813', canonicalSlug: 'deepseek/deepseek-v4-pro-20260813' },
  { id: 'deepseek/deepseek-v4-pro-0211', canonicalSlug: 'deepseek/deepseek-v4-pro-20260211' },
  { id: 'z-ai/glm-5.3', canonicalSlug: 'z-ai/glm-5.3-20260920' },
]

/** A cache over a scripted reader and a clock the case advances by hand. */
function cacheOver(
  reads: Array<() => Promise<readonly OpenRouterCatalogEntry[]>>,
): { cache: FamilyCache; clock: { now: number }; signals: AbortSignal[] } {
  const clock = { now: 0 }
  const signals: AbortSignal[] = []
  let index = 0
  const cache = new FamilyCache((signal) => {
    signals.push(signal)
    const read = reads[Math.min(index, reads.length - 1)]
    index += 1
    return read === undefined ? Promise.reject(new Error('no scripted read')) : read()
  }, () => clock.now)
  return { cache, clock, signals }
}

describe('FamilyCache.resolve', () => {
  it('shares one read between callers that resolve at the same moment', async () => {
    const read = vi.fn(async () => CATALOG)
    const clock = { now: 0 }
    const cache = new FamilyCache(read, () => clock.now)
    const signal = new AbortController().signal
    const [first, second] = await Promise.all([
      cache.resolve(['deepseek/deepseek-v4-pro'], 1000, signal),
      cache.resolve(['z-ai/glm-5.3'], 1000, signal),
    ])
    expect(read).toHaveBeenCalledOnce()
    expect(first.resolutions[0]?.resolved).toBe('deepseek/deepseek-v4-pro-0813')
    expect(second.resolutions[0]?.resolved).toBe('z-ai/glm-5.3')
  })

  it('reads again once the catalog has aged past its TTL', async () => {
    const read = vi.fn(async () => CATALOG)
    const clock = { now: 0 }
    const cache = new FamilyCache(read, () => clock.now)
    const signal = new AbortController().signal
    await cache.resolve(['deepseek/deepseek-v4-pro'], 1000, signal)
    clock.now = 999
    await cache.resolve(['deepseek/deepseek-v4-pro'], 1000, signal)
    expect(read).toHaveBeenCalledOnce()
    clock.now = 1000
    await cache.resolve(['deepseek/deepseek-v4-pro'], 1000, signal)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('hands the caller its own cancellation signal', async () => {
    const { cache, signals } = cacheOver([async () => CATALOG])
    const controller = new AbortController()
    await cache.resolve(['deepseek/deepseek-v4-pro'], 1000, controller.signal)
    expect(signals).toEqual([controller.signal])
  })

  it('drops two configured ids that resolve to the same release', async () => {
    const { cache } = cacheOver([async () => CATALOG])
    const batch = await cache.resolve(
      ['deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4-pro-0813'],
      1000,
      new AbortController().signal,
    )
    // Both name the August release once resolved, and ranking that release twice
    // would put the same endpoints in the candidate pool twice.
    expect(batch.resolutions).toEqual([
      { configured: 'deepseek/deepseek-v4-pro', resolved: 'deepseek/deepseek-v4-pro-0813', moved: true },
    ])
    const older = await cache.resolve(
      ['deepseek/deepseek-v4-pro-0211', 'deepseek/deepseek-v4-pro'],
      0,
      new AbortController().signal,
    )
    expect(older.resolutions.map(resolution => resolution.resolved))
      .toEqual(['deepseek/deepseek-v4-pro-0813'])
  })

  it('serves the last catalog it read when a fresh read fails', async () => {
    const { cache, clock } = cacheOver([async () => CATALOG, async () => { throw new Error('503') }])
    const signal = new AbortController().signal
    await cache.resolve(['deepseek/deepseek-v4-pro'], 1000, signal)
    clock.now = 1000
    const stale = await cache.resolve(['deepseek/deepseek-v4-pro'], 1000, signal)
    expect(stale.unreadable).toBe(false)
    expect(stale.resolutions[0]?.resolved).toBe('deepseek/deepseek-v4-pro-0813')
  })

  it('answers with the configured ids when no catalog has ever been read', async () => {
    const { cache } = cacheOver([async () => { throw new Error('no route to host') }])
    const batch = await cache.resolve(['deepseek/deepseek-v4-pro'], 1000, new AbortController().signal)
    expect(batch.unreadable).toBe(true)
    expect(batch.resolutions).toEqual([
      { configured: 'deepseek/deepseek-v4-pro', resolved: 'deepseek/deepseek-v4-pro', moved: false },
    ])
  })

  it('answers a reader that throws before it returns a promise', async () => {
    const clock = { now: 0 }
    const cache = new FamilyCache(() => { throw new Error('reader is not callable') }, () => clock.now)
    const batch = await cache.resolve(['deepseek/deepseek-v4-pro'], 1000, new AbortController().signal)
    expect(batch.unreadable).toBe(true)
    expect(batch.resolutions[0]?.resolved).toBe('deepseek/deepseek-v4-pro')
  })

  it('shares a failed read the same way it shares a successful one', async () => {
    const read = vi.fn(() => Promise.reject(new Error('503')))
    const cache = new FamilyCache(read, () => 0)
    const signal = new AbortController().signal
    await Promise.all([
      cache.resolve(['deepseek/deepseek-v4-pro'], 1000, signal),
      cache.resolve(['z-ai/glm-5.3'], 1000, signal),
    ])
    expect(read).toHaveBeenCalledOnce()
  })

  it('does not let a read that failed for one caller poison the next', async () => {
    const { cache, clock } = cacheOver([
      async () => { throw new DOMException('aborted', 'AbortError') },
      async () => CATALOG,
    ])
    const first = await cache.resolve(['deepseek/deepseek-v4-pro'], 1000, new AbortController().signal)
    expect(first.unreadable).toBe(true)
    // The shared read is released whatever became of it, so the next caller
    // starts a fresh one rather than joining a failure forever.
    clock.now = 1000
    const second = await cache.resolve(['deepseek/deepseek-v4-pro'], 1000, new AbortController().signal)
    expect(second.unreadable).toBe(false)
    expect(second.resolutions[0]?.resolved).toBe('deepseek/deepseek-v4-pro-0813')
  })
})
