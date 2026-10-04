import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialInfo, CredentialRef } from '@deepseek-ai/dsh-credentials'
import WebRuntime, { WebError } from '@deepseek-ai/dsh-web'
import {
  BraveSearchProvider,
  BRAVE_MAX_COUNT,
  BRAVE_PROVIDER_ID,
  apiErrorMessage,
  mapBraveResponse,
  mapBraveResult,
  searchEndpoint,
} from '../src/index.ts'
import type { BraveSearchProviderOptions } from '../src/index.ts'
import * as bravePlugin from '../src/index.ts'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'

const REF = credentialRef('BRAVE_API_KEY')

/** One recorded `fetch` call, exactly as the runtime types it. */
type FetchCall = Parameters<typeof fetch>

/** The options a bare provider is constructed over; individual tests override one field. */
const options: BraveSearchProviderOptions = {
  apiKey: 'brave-key',
  resolveApiKey: async () => undefined,
  apiKeyEnv: REF,
  baseURL: 'https://api.search.brave.test',
  maxResults: 8,
  timeoutMs: 15_000,
}

/** The same section carrying no literal key, so `resolveApiKey` decides every search. */
const keyless: BraveSearchProviderOptions = {
  resolveApiKey: async () => undefined,
  apiKeyEnv: REF,
  baseURL: 'https://api.search.brave.test',
  maxResults: 8,
  timeoutMs: 15_000,
}

/** Construct the provider over one section; production passes a live thunk. */
const provider = (overrides: Partial<BraveSearchProviderOptions> = {}): BraveSearchProvider =>
  new BraveSearchProvider(() => ({ ...options, ...overrides }))

/** Construct the provider over a section that names no literal key. */
const keylessProvider = (overrides: Partial<BraveSearchProviderOptions> = {}): BraveSearchProvider =>
  new BraveSearchProvider(() => ({ ...keyless, ...overrides }))

/** The one documented success body shape, as a fetch mock would answer it. */
const ONE_RESULT = {
  query: { original: 'q' },
  web: { results: [{ title: 'A', url: 'https://a.test', description: 'about A', page_age: '2026-02-02' }] },
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
}

/** Answer every fetch with `body`, typed as the real `fetch` so its calls stay inspectable. */
function stubFetch(body: unknown = ONE_RESULT, init: ResponseInit = {}) {
  const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(body, init))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** The headers of one recorded fetch call. */
function headersOf(call: FetchCall | undefined): Record<string, string> {
  return (call?.[1]?.headers ?? {}) as Record<string, string>
}

/** A response whose body read aborts, as a caller cancellation mid-parse does. */
function abortingBody(status: number): Response {
  const response = new Response('{}', { status })
  response.json = () => Promise.reject(new DOMException('aborted', 'AbortError'))
  return response
}

/** Return the provider's rejected WebError, or propagate an unexpected outcome. */
async function rejectedWebError(operation: Promise<unknown>): Promise<WebError> {
  try {
    await operation
  } catch (error: unknown) {
    if (error instanceof WebError) return error
    throw error
  }
  throw new Error('expected search operation to reject')
}

/** A store whose first read fails and whose later reads answer normally, as a locked backend does. */
class FlakyReadCredentials extends MemoryCredentials {
  private failed = false

  override describe(ref: CredentialRef): Promise<CredentialInfo> {
    if (this.failed) return super.describe(ref)
    this.failed = true
    return Promise.reject(new Error('credential store unavailable'))
  }
}

/** Run `body` with BRAVE_API_KEY absent from the process environment, then restore it. */
async function withoutAmbientKey(body: () => Promise<void>): Promise<void> {
  const previous = process.env.BRAVE_API_KEY
  delete process.env.BRAVE_API_KEY
  try {
    await body()
  } finally {
    if (previous === undefined) delete process.env.BRAVE_API_KEY
    else process.env.BRAVE_API_KEY = previous
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Brave result mapping', () => {
  it('maps a full result entry', () => {
    expect(mapBraveResult({
      title: 'A', url: 'https://a.test', description: 'about A', page_age: '2026-02-02',
    })).toEqual({ url: 'https://a.test', title: 'A', snippet: 'about A', publishedAt: '2026-02-02' })
  })

  it('keeps an entry that has only a URL', () => {
    expect(mapBraveResult({ url: 'https://a.test' })).toEqual({ url: 'https://a.test' })
  })

  it('drops an entry with no usable URL', () => {
    expect(mapBraveResult({ title: 'A' })).toBeUndefined()
    expect(mapBraveResult({ url: '' })).toBeUndefined()
    expect(mapBraveResult({ url: null, description: 'orphan' })).toBeUndefined()
  })

  it('omits null/empty optional fields rather than emitting them', () => {
    expect(mapBraveResult({ url: 'https://a.test', title: null, description: null, page_age: null }))
      .toEqual({ url: 'https://a.test' })
    expect(mapBraveResult({ url: 'https://a.test', title: '', description: '', page_age: '' }))
      .toEqual({ url: 'https://a.test' })
  })
})

describe('mapBraveResponse', () => {
  it('maps the documented envelope to sources with no content', () => {
    const result = mapBraveResponse(ONE_RESULT)
    expect(result).toEqual({
      sources: [{ url: 'https://a.test', title: 'A', snippet: 'about A', publishedAt: '2026-02-02' }],
      truncated: false,
    })
    expect(result.content).toBeUndefined()
  })

  it('resolves an absent web vertical, a null one, and an empty result set', () => {
    expect(mapBraveResponse({}).sources).toEqual([])
    expect(mapBraveResponse({ web: null }).sources).toEqual([])
    expect(mapBraveResponse({ web: { results: null } }).sources).toEqual([])
    expect(mapBraveResponse({ web: { results: [] } })).toEqual({ sources: [], truncated: false })
  })

  it('dedupes repeated urls and drops entries with no url', () => {
    expect(mapBraveResponse({
      web: {
        results: [
          { url: 'https://a.test', title: 'first' },
          { url: 'https://a.test', title: 'second' },
          { title: 'no url' },
          { url: 'https://b.test' },
        ],
      },
    }).sources).toEqual([
      { url: 'https://a.test', title: 'first' },
      { url: 'https://b.test' },
    ])
  })
})

describe('searchEndpoint', () => {
  it('appends the operation path and percent-encodes the query', () => {
    expect(searchEndpoint('https://api.search.brave.com', 'a b&c=d', 5))
      .toBe('https://api.search.brave.com/res/v1/web/search?q=a%20b%26c%3Dd&count=5')
  })

  it('keeps the bound inside Brave\'s documented range', () => {
    const ceiling = `count=${String(BRAVE_MAX_COUNT)}`
    expect(searchEndpoint('https://b.test', 'q', BRAVE_MAX_COUNT)).toContain(ceiling)
    expect(searchEndpoint('https://b.test', 'q', BRAVE_MAX_COUNT + 5)).toContain(ceiling)
    expect(searchEndpoint('https://b.test', 'q', 0)).toContain('count=1')
    expect(searchEndpoint('https://b.test', 'q', -3)).toContain('count=1')
  })
})

describe('apiErrorMessage', () => {
  it('carries the status, detail and code — including the observed 422 auth failure', () => {
    // Observed live: an invalid subscription token answers 422, not 401/403, and
    // the machine-readable code is what identifies the failure.
    expect(apiErrorMessage(422, {
      error: {
        code: 'SUBSCRIPTION_TOKEN_INVALID',
        detail: 'The provided subscription token is invalid.',
        meta: { component: 'authentication' },
        status: 422,
      },
      type: 'ErrorResponse',
    })).toBe('Brave Search API error (HTTP 422): The provided subscription token is invalid. [SUBSCRIPTION_TOKEN_INVALID]')
  })

  it('accepts a detail without a code and a code without a detail', () => {
    expect(apiErrorMessage(429, { error: { detail: 'rate limited' } }))
      .toBe('Brave Search API error (HTTP 429): rate limited')
    expect(apiErrorMessage(429, { error: { code: 'RATE_LIMITED' } }))
      .toBe('Brave Search API error (HTTP 429) [RATE_LIMITED]')
  })

  it('keeps the status line for a string-form or empty error body', () => {
    expect(apiErrorMessage(400, { error: 'bad request' }))
      .toBe('Brave Search API error (HTTP 400): bad request')
    expect(apiErrorMessage(500, { error: { code: '', detail: '' } }))
      .toBe('Brave Search API error (HTTP 500)')
    expect(apiErrorMessage(500, {})).toBe('Brave Search API error (HTTP 500)')
  })
})

describe('BraveSearchProvider availability', () => {
  it('is available with a literal key, without any credential observation', () => {
    expect(provider().available()).toBe(true)
  })

  it('is unavailable when no key and no observation exist — the resolver alone proves nothing', () => {
    expect(keylessProvider({ resolveApiKey: async () => 'resolvable-key' }).available()).toBe(false)
  })

  it('is unavailable when the observation says the reference holds nothing', () => {
    const bare = keylessProvider()
    bare.observeCredential(REF, false)
    expect(bare.available()).toBe(false)
  })

  it('becomes available once the section\'s reference is observed as configured', () => {
    const bare = keylessProvider()
    expect(bare.available()).toBe(false)
    bare.observeCredential(REF, true)
    expect(bare.available()).toBe(true)
  })

  it('does not inherit an observation made for a different reference', () => {
    const renamed = keylessProvider({ apiKeyEnv: credentialRef('OTHER_BRAVE_KEY') })
    renamed.observeCredential(REF, true)
    expect(renamed.available()).toBe(false)
    renamed.observeCredential(undefined, true)
    expect(renamed.available()).toBe(false)
  })

  it('ignores an empty literal key', () => {
    expect(provider({ apiKey: '' }).available()).toBe(false)
  })

  it('is misconfigured when the base URL is unparseable', () => {
    expect(provider({ baseURL: 'not a url' }).available()).toBe(false)
  })

  it('is misconfigured when a request bound or the timeout is not a positive integer', () => {
    expect(provider({ maxResults: 0 }).available()).toBe(false)
    expect(provider({ maxResults: 1.5 }).available()).toBe(false)
    expect(provider({ timeoutMs: 0 }).available()).toBe(false)
    expect(provider({ timeoutMs: 1.5 }).available()).toBe(false)
  })
})

describe('BraveSearchProvider request mapping', () => {
  it('sends a GET with the query, count, and subscription-token header', async () => {
    const fetchMock = stubFetch()
    await provider().search({ query: 'harness', maxResults: 5 })

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, request] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe('https://api.search.brave.test/res/v1/web/search?q=harness&count=5')
    expect(request).toMatchObject({ method: 'GET', redirect: 'error' })
    expect(headersOf(fetchMock.mock.calls[0])['x-subscription-token']).toBe('brave-key')
    expect(headersOf(fetchMock.mock.calls[0])['accept']).toBe('application/json')
    expect(headersOf(fetchMock.mock.calls[0])['user-agent']).toBe('deepseek-harness/0.0.1')
    expect(headersOf(fetchMock.mock.calls[0])).not.toHaveProperty('authorization')
    expect(request?.body).toBeUndefined()
  })

  it('falls back to the configured count when a request omits maxResults', async () => {
    const fetchMock = stubFetch()
    await provider({ maxResults: 3 }).search({ query: 'q' })
    expect(fetchMock.mock.calls[0]?.[0]).toContain('count=3')
  })

  it('clamps a request bound above Brave\'s documented ceiling', async () => {
    const fetchMock = stubFetch()
    await provider().search({ query: 'q', maxResults: 100 })
    expect(fetchMock.mock.calls[0]?.[0]).toContain(`count=${String(BRAVE_MAX_COUNT)}`)
  })

  it('maps the documented envelope to sources', async () => {
    stubFetch()
    await expect(provider().search({ query: 'q' })).resolves.toEqual({
      sources: [{ url: 'https://a.test', title: 'A', snippet: 'about A', publishedAt: '2026-02-02' }],
      truncated: false,
    })
  })

  it('resolves a body with no web vertical instead of failing', async () => {
    stubFetch({ query: { original: 'q' } })
    await expect(provider().search({ query: 'q' })).resolves.toEqual({ sources: [], truncated: false })
  })

  it('resolves a body whose results field is not an array', async () => {
    stubFetch({ web: { results: { length: 2 } } })
    await expect(provider().search({ query: 'q' })).resolves.toEqual({ sources: [], truncated: false })
  })

  it('dispatches under a composed deadline that answers to the caller\'s cancellation', async () => {
    const controller = new AbortController()
    let dispatched: AbortSignal | undefined
    const fetchMock = vi.fn<typeof fetch>((_input, init) => {
      dispatched = init?.signal ?? undefined
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { reject(new DOMException('aborted', 'AbortError')) }, { once: true })
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const search = provider().search({ query: 'q' }, controller.signal)
    await vi.waitFor(() => { expect(fetchMock).toHaveBeenCalledOnce() })
    expect(dispatched?.aborted).toBe(false)
    controller.abort(new Error('caller stopped'))
    await expect(search).rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('dispatches under its own deadline when the caller supplies no signal', async () => {
    const fetchMock = stubFetch()
    await provider().search({ query: 'q' })
    const request = fetchMock.mock.calls[0]?.[1]
    expect(request?.signal).toBeInstanceOf(AbortSignal)
    expect(request?.signal?.aborted).toBe(false)
  })
})

describe('BraveSearchProvider credential resolution', () => {
  it('prefers a literal key over the resolver and never calls the resolver', async () => {
    const resolveApiKey = vi.fn(async () => 'resolved-key')
    const fetchMock = stubFetch()
    await provider({ resolveApiKey }).search({ query: 'q' })
    expect(resolveApiKey).not.toHaveBeenCalled()
    expect(headersOf(fetchMock.mock.calls[0])['x-subscription-token']).toBe('brave-key')
  })

  it('sends a resolved key and records it as evidence for the next availability check', async () => {
    const fetchMock = stubFetch()
    const resolved = keylessProvider({ resolveApiKey: async () => 'resolved-key' })
    expect(resolved.available()).toBe(false)
    await resolved.search({ query: 'q' })
    expect(headersOf(fetchMock.mock.calls[0])['x-subscription-token']).toBe('resolved-key')
    expect(resolved.available()).toBe(true)
  })

  it.each([undefined, ''])('maps a resolver that yields %j to WEB_PROVIDER_CREDENTIAL_MISSING', async (value) => {
    const fetchMock = stubFetch()
    const error = await rejectedWebError(
      keylessProvider({ resolveApiKey: async () => value }).search({ query: 'q' }),
    )
    expect(error.code).toBe('WEB_PROVIDER_CREDENTIAL_MISSING')
    expect(error.message).toContain('Brave search has no API key for "BRAVE_API_KEY"')
    expect(error.message).toMatch(/store it through the credentials service.*web-search-brave config/s)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('names the section\'s own reference when it renamed the default', async () => {
    const error = await rejectedWebError(keylessProvider({
      apiKeyEnv: credentialRef('MY_BRAVE_TOKEN'),
    }).search({ query: 'q' }))
    expect(error.message).toContain('Brave search has no API key for "MY_BRAVE_TOKEN"')
  })

  it('maps a resolver rejection to WEB_PROVIDER_ERROR without dispatching', async () => {
    const fetchMock = stubFetch()
    await expect(keylessProvider({
      resolveApiKey: () => Promise.reject(new Error('credential backend failed')),
    }).search({ query: 'q' })).rejects.toThrow(expect.objectContaining({
      code: 'WEB_PROVIDER_ERROR',
      message: 'Brave search credential resolution failed: Error: credential backend failed',
    }))
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('BraveSearchProvider error handling', () => {
  it('maps an auth failure to WEB_PROVIDER_ERROR with the status, detail, and code', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => jsonResponse({
      error: {
        code: 'SUBSCRIPTION_TOKEN_INVALID',
        detail: 'The provided subscription token is invalid.',
        meta: { component: 'authentication' },
        status: 422,
      },
      type: 'ErrorResponse',
    }, { status: 422 })))
    const error = await rejectedWebError(provider().search({ query: 'q' }))
    expect(error.code).toBe('WEB_PROVIDER_ERROR')
    expect(error.message).toContain(
      'Brave Search API error (HTTP 422): The provided subscription token is invalid. [SUBSCRIPTION_TOKEN_INVALID]',
    )
    expect(error.message).toContain('The web search request used endpoint "https://api.search.brave.test/res/v1/web/search?q=q&count=8".')
    expect(error.message).toContain('only the user should choose or change it')
  })

  it('keeps a status-line message when the error body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response('gateway down', { status: 502 })))
    const error = await rejectedWebError(provider().search({ query: 'q' }))
    expect(error).toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    expect(error.message).toContain('Brave Search API error (HTTP 502)')
  })

  it('keeps the status-line message when the JSON error body carries no detail', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => jsonResponse({}, { status: 500 })))
    const error = await rejectedWebError(provider().search({ query: 'q' }))
    expect(error.message).toContain('Brave Search API error (HTTP 500)')
  })

  it('maps a network failure to WEB_PROVIDER_ERROR naming the endpoint', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(() => Promise.reject(new TypeError('connection refused'))))
    const error = await rejectedWebError(provider().search({ query: 'q' }))
    expect(error.code).toBe('WEB_PROVIDER_ERROR')
    expect(error.message).toContain('Brave search request failed: TypeError: connection refused')
    expect(error.message).toContain('The web search request used endpoint')
  })

  it('does not dispatch a call the caller had already cancelled', async () => {
    const fetchMock = stubFetch()
    const resolveApiKey = vi.fn(async () => 'unused')
    const controller = new AbortController()
    controller.abort(new Error('caller stopped'))
    await expect(keylessProvider({ resolveApiKey })
      .search({ query: 'q' }, controller.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('maps a caller abort carrying a custom reason to WEB_ABORTED', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn<typeof fetch>((_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { reject(new Error('custom abort reason')) }, { once: true })
      }))
    vi.stubGlobal('fetch', fetchMock)

    const search = provider().search({ query: 'q' }, controller.signal)
    await vi.waitFor(() => { expect(fetchMock).toHaveBeenCalledOnce() })
    controller.abort(new Error('timeout reason'))
    await expect(search).rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('maps its own deadline to a timeout message when no caller cancellation explains the abort', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(() => Promise.reject(new DOMException('deadline', 'TimeoutError'))))
    const error = await rejectedWebError(provider({ timeoutMs: 25 }).search({ query: 'q' }))
    expect(error.code).toBe('WEB_PROVIDER_ERROR')
    expect(error.message).toBe('Brave search timed out after 25ms')
  })

  it('maps an unexplained AbortError to WEB_ABORTED rather than blaming the deadline', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(() => Promise.reject(new DOMException('aborted', 'AbortError'))))
    await expect(provider({ timeoutMs: 25 }).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED', message: 'Brave search aborted' }))
  })

  it('maps an unparseable success body to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response('not json', { status: 200 })))
    await expect(provider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({
        code: 'WEB_PROVIDER_ERROR',
        message: expect.stringContaining('Brave Search returned an unprocessable response body'),
      }))
  })

  it('maps a success body that is not an object at all to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => jsonResponse(null)))
    await expect(provider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('surfaces an abort during success-body parse as WEB_ABORTED', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => abortingBody(200)))
    await expect(provider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('surfaces an abort during error-body parse as WEB_ABORTED', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => abortingBody(500)))
    await expect(provider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })
})

describe('web-search-brave plugin registration', () => {
  it('registers the provider into ctx.web (HMR-safe)', async () => {
    stubFetch()
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: BRAVE_PROVIDER_ID })
    const fiber = await ctx.plugin(bravePlugin, { apiKey: 'brave-key' })
    await expect(ctx.web.search({ query: 'q' })).resolves.toMatchObject({ truncated: false })
    await fiber.dispose()
    await expect(ctx.web.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' }))
  })

  it('has no default export (namespace plugin export shape)', () => {
    expect('default' in bravePlugin).toBe(false)
  })

  it('survives the real Loader unwrapExports path keeping name/inject/namespace', () => {
    // A default export would make `unwrapExports` collapse the namespace and drop `inject: ['web']`.
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(bravePlugin) as Record<string, unknown>
    expect(unwrapped).toBe(bravePlugin)
    expect(unwrapped.name).toBe('web-search-brave')
    expect(unwrapped.inject).toEqual(['web'])
    expect(unwrapped.WEB_SEARCH_BRAVE_SETTINGS_NAMESPACE).toBe('web-search-brave')
    expect(typeof unwrapped.apply).toBe('function')
  })

  it('boots over ctx.web through the unwrapped module without an inject error', async () => {
    stubFetch()
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: BRAVE_PROVIDER_ID })
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(bravePlugin) as Parameters<Context['plugin']>[0]
    const fiber = await ctx.plugin(unwrapped, { apiKey: 'brave-key' })
    await expect(ctx.web.search({ query: 'q' })).resolves.toMatchObject({ truncated: false })
    await fiber.dispose()
  })

  it('threads every config field into the dispatched request', async () => {
    const fetchMock = stubFetch()
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: BRAVE_PROVIDER_ID })
    const fiber = await ctx.plugin(bravePlugin, {
      apiKey: 'configured-key',
      baseURL: 'https://brave.internal/gateway',
      maxResults: 2,
      timeoutMs: 4_000,
    })
    await ctx.web.search({ query: 'q' })
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://brave.internal/gateway/res/v1/web/search?q=q&count=2')
    expect(headersOf(fetchMock.mock.calls[0])['x-subscription-token']).toBe('configured-key')
    await fiber.dispose()
  })

  it('falls back to the default base URL and count when config omits them', async () => {
    const fetchMock = stubFetch()
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: BRAVE_PROVIDER_ID })
    const fiber = await ctx.plugin(bravePlugin, { apiKey: 'configured-key' })
    await ctx.web.search({ query: 'q' })
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.search.brave.com/res/v1/web/search?q=q&count=8')
    await fiber.dispose()
  })

  it('rejects a non-positive or fractional bound at plugin construction', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: BRAVE_PROVIDER_ID })
    await expect(ctx.plugin(bravePlugin, { apiKey: 'k', maxResults: 0 }))
      .rejects.toThrow(/maxResults expected number >= 1/)
    await expect(ctx.plugin(bravePlugin, { apiKey: 'k', maxResults: 1.5 }))
      .rejects.toThrow(/maxResults expected number multiple of 1/)
    await expect(ctx.plugin(bravePlugin, { apiKey: 'k', timeoutMs: 0 }))
      .rejects.toThrow(/timeoutMs expected number >= 1/)
  })
})

describe('web-search-brave credential plane', () => {
  it('is unavailable with nothing stored, then serves the next search once a key is stored', async () => {
    await withoutAmbientKey(async () => {
      const fetchMock = stubFetch()
      const ctx = new Context()
      try {
        await ctx.plugin(WebRuntime, { searchProvider: BRAVE_PROVIDER_ID })
        await ctx.plugin(MemoryCredentials)
        await ctx.plugin(bravePlugin)

        // Honest availability: no key is observable, so the provider is not selected.
        await expect(ctx.web.search({ query: 'q' }))
          .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE' }))

        await ctx.credentials.set(REF, 'stored-key')
        await vi.waitFor(async () => {
          await expect(ctx.web.search({ query: 'stored' })).resolves.toMatchObject({ truncated: false })
        })
        await ctx.credentials.set(REF, 'rotated-key')
        await vi.waitFor(async () => { await ctx.web.search({ query: 'rotated' }) })

        const sent = fetchMock.mock.calls.map(call => headersOf(call)['x-subscription-token'])
        expect(sent).toEqual(['stored-key', 'rotated-key'])
      } finally {
        await ctx.fiber.dispose()
      }
    })
  })

  it('reports nothing configured until a readable probe answers, then refreshes on the next change', async () => {
    await withoutAmbientKey(async () => {
      const fetchMock = stubFetch()
      const ctx = new Context()
      try {
        await ctx.plugin(WebRuntime, { searchProvider: BRAVE_PROVIDER_ID })
        // The first read fails, so the load-time probe has no evidence to report.
        await ctx.plugin(FlakyReadCredentials, { BRAVE_API_KEY: 'stored-key' })
        await ctx.plugin(bravePlugin)
        await expect(ctx.web.search({ query: 'q' }))
          .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE' }))

        // The change fans out and the next probe reads the store successfully.
        await ctx.credentials.set(REF, 'stored-key')
        await vi.waitFor(async () => {
          await expect(ctx.web.search({ query: 'stored' })).resolves.toMatchObject({ truncated: false })
        })
        expect(headersOf(fetchMock.mock.calls[0])['x-subscription-token']).toBe('stored-key')
      } finally {
        await ctx.fiber.dispose()
      }
    })
  })

  it('ignores a credential change that names another reference', async () => {
    await withoutAmbientKey(async () => {
      stubFetch()
      const ctx = new Context()
      try {
        await ctx.plugin(WebRuntime, { searchProvider: BRAVE_PROVIDER_ID })
        await ctx.plugin(MemoryCredentials)
        await ctx.plugin(bravePlugin)
        await ctx.credentials.set(credentialRef('SOME_OTHER_KEY'), 'unrelated')
        await expect(ctx.web.search({ query: 'q' }))
          .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE' }))
      } finally {
        await ctx.fiber.dispose()
      }
    })
  })

  it('reports an ambient BRAVE_API_KEY as available when no credentials service is mounted', async () => {
    await withoutAmbientKey(async () => {
      process.env.BRAVE_API_KEY = 'ambient-key'
      const fetchMock = stubFetch()
      const ctx = new Context()
      try {
        await ctx.plugin(WebRuntime, { searchProvider: BRAVE_PROVIDER_ID })
        await ctx.plugin(bravePlugin)
        await vi.waitFor(async () => {
          await expect(ctx.web.search({ query: 'q' })).resolves.toMatchObject({ truncated: false })
        })
        expect(headersOf(fetchMock.mock.calls[0])['x-subscription-token']).toBe('ambient-key')
      } finally {
        await ctx.fiber.dispose()
      }
    })
  })

  it('treats an empty ambient value as no key at all', async () => {
    await withoutAmbientKey(async () => {
      process.env.BRAVE_API_KEY = ''
      stubFetch()
      const ctx = new Context()
      try {
        await ctx.plugin(WebRuntime, { searchProvider: BRAVE_PROVIDER_ID })
        await ctx.plugin(bravePlugin)
        await expect(ctx.web.search({ query: 'q' }))
          .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE' }))
      } finally {
        await ctx.fiber.dispose()
      }
    })
  })

  it('does not resolve a stored key when the section supplies a literal one', async () => {
    await withoutAmbientKey(async () => {
      const fetchMock = stubFetch()
      const ctx = new Context()
      try {
        await ctx.plugin(WebRuntime, { searchProvider: BRAVE_PROVIDER_ID })
        await ctx.plugin(MemoryCredentials, { BRAVE_API_KEY: 'stored-key' })
        await ctx.plugin(bravePlugin, { apiKey: 'literal-key' })
        await ctx.web.search({ query: 'q' })
        expect(headersOf(fetchMock.mock.calls[0])['x-subscription-token']).toBe('literal-key')
      } finally {
        await ctx.fiber.dispose()
      }
    })
  })

  it('refuses a section that names a reference outside the credential grammar', async () => {
    await withoutAmbientKey(async () => {
      stubFetch()
      const ctx = new Context()
      try {
        await ctx.plugin(WebRuntime, { searchProvider: BRAVE_PROVIDER_ID })
        await ctx.plugin(bravePlugin, { apiKeyEnv: 'brave-key' })
        await expect(ctx.web.search({ query: 'q' }))
          .rejects.toThrow(/credential ref "brave-key" must match/)
      } finally {
        await ctx.fiber.dispose()
      }
    })
  })
})
