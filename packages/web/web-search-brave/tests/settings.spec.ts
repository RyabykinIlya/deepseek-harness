/** The `web-search-brave` settings section layered over the composition entry. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'
import WebRuntime from '@deepseek-ai/dsh-web'
import { WEB_SEARCH_BRAVE_SETTINGS_NAMESPACE } from '../src/index.ts'
import * as bravePlugin from '../src/index.ts'

const ONE_RESULT = { web: { results: [{ url: 'https://a.test', title: 'A' }] } }

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

async function boot() {
  const ctx = new Context()
  await ctx.plugin(WebRuntime, {})
  const live = await liveConfig(ctx, bravePlugin, { apiKey: 'brave-key', baseURL: 'https://search.entry.test' })
  return { ctx, live }
}

/**
 * Run one search and answer the endpoint it reached. A fresh `Response` per call
 * because a body can only be read once, and the call history is cleared because
 * repeated `spyOn` returns the same spy.
 * @param ctx - context whose `ctx.web` serves the search.
 * @returns the URL the provider fetched.
 */
async function searchOnce(ctx: Context): Promise<string> {
  const fetchSpy = vi.spyOn(globalThis, 'fetch')
    .mockImplementation(() => Promise.resolve(jsonResponse(ONE_RESULT)))
  fetchSpy.mockClear()
  await ctx.web.search({ query: 'anything' })
  const target: unknown = fetchSpy.mock.calls.at(-1)?.[0]
  if (target instanceof URL) return target.href
  if (typeof target === 'string') return target
  return target instanceof Request ? target.url : ''
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('web-search-brave settings section', () => {
  it('publishes the namespace a settings page binds to', () => {
    expect(WEB_SEARCH_BRAVE_SETTINGS_NAMESPACE).toBe('web-search-brave')
    expect(bravePlugin.name).toBe(WEB_SEARCH_BRAVE_SETTINGS_NAMESPACE)
  })

  it('serves a stored endpoint to the next search without re-registering the provider', async () => {
    const bench = await boot()
    expect(await searchOnce(bench.ctx)).toContain('https://search.entry.test')

    await bench.live.update({
      baseURL: 'https://search.stored.test',
    })

    expect(await searchOnce(bench.ctx)).toContain('https://search.stored.test')
    await bench.ctx.fiber.dispose()
  })

  it('serves a stored result count to the next search', async () => {
    const bench = await boot()
    await bench.live.update({ maxResults: 3 })
    expect(await searchOnce(bench.ctx)).toContain('count=3')
    await bench.ctx.fiber.dispose()
  })
})
