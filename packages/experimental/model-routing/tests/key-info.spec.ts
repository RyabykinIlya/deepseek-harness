import { describe, expect, it, vi } from 'vitest'
import { KeyInfo } from '../src/key-info.ts'

const SIGNAL = new AbortController().signal

/** Build a `KeyInfo` over one scripted `/key` reply. */
function keyInfo(body: unknown, options: { status?: number; apiKey?: string } = {}) {
  let clock = 0
  const fetch = vi.fn(async () => new Response(
    typeof body === 'string' ? body : JSON.stringify(body),
    { status: options.status ?? 200, headers: { 'content-type': 'application/json' } },
  ))
  const info = new KeyInfo({
    fetch: fetch,
    now: () => clock,
    baseUrl: () => 'https://openrouter.ai/api/v1',
    apiKey: () => Promise.resolve(options.apiKey === undefined ? 'key' : options.apiKey),
    headers: () => ({ 'http-title': 'DSH' }),
  })
  return { info, fetch, advance: (ms: number) => { clock += ms } }
}

describe('KeyInfo', () => {
  it('reads the free-model budget', async () => {
    const { info } = keyInfo({ data: { free_model_daily_requests: { used: 0, limit: 1000, remaining: 1000 } } })
    expect(await info.freeUsage(1000, SIGNAL)).toEqual({ used: 0, limit: 1000, remaining: 1000 })
  })

  it('answers nothing on an HTTP error', async () => {
    const { info } = keyInfo({ error: 'nope' }, { status: 401 })
    expect(await info.freeUsage(1000, SIGNAL)).toBeUndefined()
  })

  it('answers nothing without a stored credential', async () => {
    const { info, fetch } = keyInfo({}, { apiKey: '' })
    expect(await info.freeUsage(1000, SIGNAL)).toBeUndefined()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('answers nothing on a transport failure or a body that is not the envelope', async () => {
    const failing = new KeyInfo({
      fetch: async () => { throw new Error('offline') },
      now: () => 0,
      baseUrl: () => 'https://openrouter.ai/api/v1',
      apiKey: () => Promise.resolve('key'),
      headers: () => ({}),
    })
    expect(await failing.freeUsage(1000, SIGNAL)).toBeUndefined()

    const { info } = keyInfo('not json')
    expect(await info.freeUsage(1000, SIGNAL)).toBeUndefined()

    const partial = keyInfo({ data: { free_model_daily_requests: { used: 1 } } })
    expect(await partial.info.freeUsage(1000, SIGNAL)).toBeUndefined()
  })

  it('reuses a reading inside the ttl and asks again past it', async () => {
    const { info, fetch, advance } = keyInfo({ data: { free_model_daily_requests: { used: 1, limit: 10, remaining: 9 } } })
    await info.freeUsage(1000, SIGNAL)
    advance(999)
    await info.freeUsage(1000, SIGNAL)
    expect(fetch).toHaveBeenCalledTimes(1)
    advance(1)
    await info.freeUsage(1000, SIGNAL)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('sends the credential and the attribution headers', async () => {
    let sent: Headers | undefined
    const info = new KeyInfo({
      fetch: (async (_url: string, init?: RequestInit) => {
        sent = new Headers(init?.headers)
        return new Response(JSON.stringify({ data: { free_model_daily_requests: { used: 0, limit: 1, remaining: 1 } } }))
      }) as unknown as typeof fetch,
      now: () => 0,
      baseUrl: () => 'https://openrouter.ai/api/v1',
      apiKey: () => Promise.resolve('secret'),
      headers: () => ({ 'http-title': 'DSH' }),
    })
    await info.freeUsage(1000, SIGNAL)
    expect(sent?.get('authorization')).toBe('Bearer secret')
    expect(sent?.get('http-title')).toBe('DSH')
  })
})
