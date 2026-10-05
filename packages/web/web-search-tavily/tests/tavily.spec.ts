import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef, ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import WebRuntime, { WebError } from '@deepseek-ai/dsh-web'
import {
  boundContent,
  mapTavilyResponse,
  mapTavilyResult,
  TAVILY_DEFAULT_ENDPOINT,
  TAVILY_DEFAULT_MAX_CONTENT_CHARS,
  TAVILY_DEFAULT_MAX_RESULTS,
  TAVILY_DEFAULT_TIMEOUT_MS,
  TAVILY_PROVIDER_ID,
  TavilySearchProvider,
  tavilyErrorDetail,
} from '../src/provider.ts'
import type { TavilySearchProviderOptions } from '../src/provider.ts'
import type { TavilySearchResponse } from '../src/types.ts'
import * as tavilyPlugin from '../src/index.ts'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'

/** Options for one provider under test; `searchProvider` overrides them per case. */
const options: TavilySearchProviderOptions = {
  apiKey: 'tvly-key',
  credentialName: 'TAVILY_API_KEY',
  endpoint: 'https://api.tavily.test/search',
  maxResults: 5,
  timeoutMs: 1_000,
  maxContentChars: 2_000,
  ambientKeyPresent: false,
  credentialPresent: true,
  credentialAnswerName: 'TAVILY_API_KEY',
}

/** Construct a provider over fixed options; the plugin supplies a live thunk. */
const searchProvider = (overrides: Partial<TavilySearchProviderOptions> = {}): TavilySearchProvider =>
  new TavilySearchProvider(() => ({ ...options, ...overrides }))

/** A Tavily answer in the documented shape, trimmed only where a case needs it. */
function searchResponse(overrides: Partial<TavilySearchResponse> = {}): TavilySearchResponse {
  return {
    query: 'deepseek harness',
    response_time: 1.2,
    answer: null,
    results: [
      { title: 'Harness', url: 'https://deepseek.com/en/harness/', content: 'Use DeepSeek Harness.', score: 0.91 },
      { title: 'Docs', url: 'https://docs.deepseek.com/', content: 'Reference documentation.', score: 0.4 },
    ],
    ...overrides,
  }
}

/** A JSON response the provider can parse. */
function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

/** The `RequestInit` of one call the stubbed `fetch` received. */
function requestOf(mock: ReturnType<typeof vi.fn<typeof fetch>>, index = 0): RequestInit {
  return mock.mock.calls[index]?.[1] ?? {}
}

/** The parsed request body of one stubbed `fetch` call. */
function bodyOf(mock: ReturnType<typeof vi.fn<typeof fetch>>, index = 0): Record<string, unknown> {
  return JSON.parse(mock.mock.calls[index]?.[1]?.body as string) as Record<string, unknown>
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

/** Stub `fetch` with one successful Tavily answer and return the spy. */
function servingSearch(response: TavilySearchResponse = searchResponse()): ReturnType<typeof vi.fn<typeof fetch>> {
  const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(response))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/**
 * A response whose body read fails, optionally firing a caller abort on the way
 * so a cancellation raised mid-body can be observed end to end.
 *
 * @param error - what the body stream fails with.
 * @param status - the status the response carries.
 * @param onRead - runs as the read starts, before the failure.
 * @returns the response, real in every respect except its body.
 */
function failingBodyResponse(error: unknown, status: number, onRead?: () => void): Response {
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      onRead?.()
      controller.error(error)
    },
  }), { status })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Set by a case whose credential resolver releases the search from inside its await. */
let commitSettings = (): void => {}

describe('boundContent', () => {
  it('passes text that fits the cap through, trimmed', () => {
    expect(boundContent('  short enough  ', 100)).toBe('short enough')
    expect(boundContent('exactly ten', 11)).toBe('exactly ten')
  })

  it('reports no text for absent, null, and blank content', () => {
    expect(boundContent(undefined, 100)).toBeUndefined()
    expect(boundContent(null, 100)).toBeUndefined()
    expect(boundContent('   \n ', 100)).toBeUndefined()
  })

  it('cuts a long extract on a word boundary and marks it as cut', () => {
    const text = 'alpha bravo charlie delta echo foxtrot'
    const bounded = boundContent(text, 14)
    expect(bounded).toBe('alpha bravo…')
    expect(bounded?.length).toBeLessThanOrEqual(14)
  })

  it('cuts at the cap when the extract has no space to cut on', () => {
    expect(boundContent('abcdefghij', 4)).toBe('abc…')
  })

  it('never exceeds the cap, even at one character', () => {
    expect(boundContent('abcdef', 1)).toBe('…')
    expect(boundContent(' abcdef', 1)).toBe('…')
  })
})

describe('mapTavilyResult', () => {
  it('maps title and bounded content onto a citeable source', () => {
    expect(mapTavilyResult({ url: 'https://a.test', title: ' A ', content: 'body' }, 100)).toEqual({
      url: 'https://a.test',
      title: 'A',
      snippet: 'body',
    })
  })

  it('omits absent and blank optional fields', () => {
    expect(mapTavilyResult({ url: 'https://a.test', title: '  ', content: null }, 100))
      .toEqual({ url: 'https://a.test' })
    expect(mapTavilyResult({ url: 'https://a.test' }, 100)).toEqual({ url: 'https://a.test' })
  })

  it('drops an entry with no usable url', () => {
    expect(mapTavilyResult({ url: '' }, 100)).toBeUndefined()
    expect(mapTavilyResult({ url: '   ' }, 100)).toBeUndefined()
  })

  it('bounds a verbose page before it becomes a snippet', () => {
    const content = `${'word '.repeat(600)}end`
    const source = mapTavilyResult({ url: 'https://a.test', content }, TAVILY_DEFAULT_MAX_CONTENT_CHARS)
    expect(source?.snippet?.length).toBeLessThanOrEqual(TAVILY_DEFAULT_MAX_CONTENT_CHARS)
    expect(source?.snippet?.endsWith('…')).toBe(true)
  })
})

describe('mapTavilyResponse', () => {
  it('maps results in Tavily order and keeps every optional field it carries', () => {
    expect(mapTavilyResponse(searchResponse(), 2_000)).toEqual({
      sources: [
        { url: 'https://deepseek.com/en/harness/', title: 'Harness', snippet: 'Use DeepSeek Harness.' },
        { url: 'https://docs.deepseek.com/', title: 'Docs', snippet: 'Reference documentation.' },
      ],
      truncated: false,
    })
  })

  it('carries a generated answer as result content when Tavily sends one', () => {
    const result = mapTavilyResponse(searchResponse({ answer: 'Harness is a plugin host.' }), 2_000)
    expect(result.content).toBe('Harness is a plugin host.')
  })

  it('generates no content from a null, blank, or absent answer', () => {
    expect(mapTavilyResponse(searchResponse({ answer: null }), 2_000).content).toBeUndefined()
    expect(mapTavilyResponse(searchResponse({ answer: '   ' }), 2_000).content).toBeUndefined()
    // No `answer` key at all is the shape Tavily sends unless one is asked for.
    expect(mapTavilyResponse({ query: 'q', results: [] }, 2_000).content).toBeUndefined()
  })

  it('reads an absent or empty results field as an empty result set', () => {
    expect(mapTavilyResponse({}, 2_000)).toEqual({ sources: [], truncated: false })
    expect(mapTavilyResponse({ results: [] }, 2_000)).toEqual({ sources: [], truncated: false })
  })

  it('reads a results field that is not a list as an empty result set, never a TypeError', async () => {
    // A shape this provider has never seen, served as a real body rather than
    // forced through the mapper's parameter type.
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => jsonResponse({ results: { a: 1 } })))
    await expect(searchProvider().search({ query: 'q' }))
      .resolves.toEqual({ sources: [], truncated: false })
  })

  it('drops repeated urls and entries with no usable target', () => {
    const result = mapTavilyResponse({
      results: [
        { url: 'https://a.test', title: 'first' },
        { url: '', title: 'unusable' },
        { url: 'https://a.test', title: 'repeat' },
        { url: 'https://b.test', title: 'second' },
      ],
    }, 2_000)
    expect(result.sources).toEqual([
      { url: 'https://a.test', title: 'first' },
      { url: 'https://b.test', title: 'second' },
    ])
  })

  it('reports no truncation; the seam owns the maxResults bound', () => {
    expect(mapTavilyResponse(searchResponse(), 2_000).truncated).toBe(false)
  })
})

describe('tavilyErrorDetail', () => {
  it('reads the observed 401 message from detail.error', () => {
    expect(tavilyErrorDetail({ detail: { error: 'Unauthorized: missing or invalid API key.' } }))
      .toBe('Unauthorized: missing or invalid API key.')
  })

  it('reads a bare-string detail', () => {
    expect(tavilyErrorDetail({ detail: 'max_results must be <= 20' })).toBe('max_results must be <= 20')
  })

  it('falls through a blank or absent detail to a top-level error and message', () => {
    expect(tavilyErrorDetail({ detail: '   ', error: 'rate limited' })).toBe('rate limited')
    expect(tavilyErrorDetail({ detail: { error: '' }, message: 'quota exceeded' })).toBe('quota exceeded')
    expect(tavilyErrorDetail({ detail: null, error: 'forbidden' })).toBe('forbidden')
    expect(tavilyErrorDetail({ error: 'forbidden' })).toBe('forbidden')
  })

  it('reports nothing when the body carries no message', () => {
    expect(tavilyErrorDetail({})).toBeUndefined()
    expect(tavilyErrorDetail({ error: null, message: null })).toBeUndefined()
  })
})

describe('TavilySearchProvider availability', () => {
  it('is available when a resolution reported a key for the named reference', () => {
    expect(searchProvider().available()).toBe(true)
  })

  it('is available on a literal key alone, with no resolution behind it', () => {
    expect(searchProvider({ credentialPresent: false, credentialAnswerName: undefined }).available()).toBe(true)
  })

  it('is available on a launch-environment key the check reads fresh', () => {
    expect(searchProvider({ apiKey: '', credentialPresent: false, ambientKeyPresent: true }).available()).toBe(true)
  })

  it('is unavailable when no key resolved at all', () => {
    expect(searchProvider({ apiKey: '', credentialPresent: false }).available()).toBe(false)
  })

  it('does not inherit a resolution made for a reference the section stopped naming', () => {
    expect(searchProvider({ apiKey: '', credentialAnswerName: 'OTHER_API_KEY' }).available()).toBe(false)
  })

  it('is misconfigured when the endpoint does not parse', () => {
    expect(searchProvider({ endpoint: 'not a url' }).available()).toBe(false)
  })

  it('is misconfigured when a bound is not a positive integer', () => {
    expect(searchProvider({ maxResults: 0 }).available()).toBe(false)
    expect(searchProvider({ maxResults: 1.5 }).available()).toBe(false)
    expect(searchProvider({ timeoutMs: 0 }).available()).toBe(false)
    expect(searchProvider({ maxContentChars: -1 }).available()).toBe(false)
  })

  it('is available with the shipped defaults and a resolved key', () => {
    expect(searchProvider({
      endpoint: TAVILY_DEFAULT_ENDPOINT,
      maxResults: TAVILY_DEFAULT_MAX_RESULTS,
      timeoutMs: TAVILY_DEFAULT_TIMEOUT_MS,
      maxContentChars: TAVILY_DEFAULT_MAX_CONTENT_CHARS,
    }).available()).toBe(true)
  })
})

describe('TavilySearchProvider request', () => {
  it('POSTs the query to the full endpoint with a bearer key and no redirect following', async () => {
    const fetchMock = servingSearch()
    await searchProvider({ apiKey: 'tvly-key', resolveApiKey: vi.fn(async () => 'unused') })
      .search({ query: 'deepseek harness' })

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.tavily.test/search')
    const init = requestOf(fetchMock)
    expect(init.method).toBe('POST')
    expect(init.redirect).toBe('error')
    const headers = new Headers(init.headers)
    expect(headers.get('authorization')).toBe('Bearer tvly-key')
    expect(headers.get('content-type')).toBe('application/json')
    expect(headers.get('accept')).toBe('application/json')
    expect(headers.get('user-agent')).toBe('deepseek-harness/0.0.1')
    expect(bodyOf(fetchMock)).toEqual({ query: 'deepseek harness', max_results: 5 })
  })

  it('sends the request bound ahead of the configured default', async () => {
    const fetchMock = servingSearch()
    await searchProvider().search({ query: 'q', maxResults: 3 })
    expect(bodyOf(fetchMock)).toEqual({ query: 'q', max_results: 3 })
  })
  it('carries a deadline that the caller signal also fires', async () => {
    const fetchMock = servingSearch()
    const controller = new AbortController()
    await searchProvider().search({ query: 'q' }, controller.signal)
    const signal = requestOf(fetchMock).signal
    expect(signal?.aborted).toBe(false)
    controller.abort(new Error('caller stopped'))
    expect(signal?.aborted).toBe(true)
  })

  it('serves a stored key resolved per search, so a rotated key needs no restart', async () => {
    const fetchMock = servingSearch()
    const resolveApiKey = vi.fn()
      .mockResolvedValueOnce('stored-key')
      .mockResolvedValueOnce('rotated-key')
    const provider = searchProvider({ apiKey: '', resolveApiKey })
    await provider.search({ query: 'q' })
    await provider.search({ query: 'q' })
    expect(fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers).get('authorization')))
      .toEqual(['Bearer stored-key', 'Bearer rotated-key'])
  })

  it('serves one search from one section when settings land during credential resolution', async () => {
    const fetchMock = servingSearch()
    // The section the search starts on, and the one a user commits while the
    // credential is still resolving. The thunk snapshots a fresh object at each
    // operation's entry, exactly as the plugin's `readSection` does.
    let live: TavilySearchProviderOptions = {
      credentialName: 'TAVILY_API_KEY',
      endpoint: 'https://before.test/search',
      maxResults: 5,
      timeoutMs: 1_000,
      maxContentChars: 2_000,
      ambientKeyPresent: false,
      credentialPresent: false,
      credentialAnswerName: undefined,
      resolveApiKey: () => new Promise<string>((resolve) => {
        commitSettings = () => { live = { ...live, endpoint: 'https://after.test/search' }; resolve('key-from-before') }
      }),
    }
    const provider = new TavilySearchProvider(() => ({ ...live }))
    const search = provider.search({ query: 'q' })
    await vi.waitFor(() => { expect(typeof commitSettings).toBe('function') })
    commitSettings()
    await search
    // The key resolved from `before` must never reach `after`'s origin.
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://before.test/search')
    expect(new Headers(requestOf(fetchMock).headers).get('authorization')).toBe('Bearer key-from-before')
  })

  it('returns sources and no generated answer for a plain Tavily answer', async () => {
    servingSearch()
    const result = await searchProvider().search({ query: 'q' })
    expect(result).toEqual({
      sources: [
        { url: 'https://deepseek.com/en/harness/', title: 'Harness', snippet: 'Use DeepSeek Harness.' },
        { url: 'https://docs.deepseek.com/', title: 'Docs', snippet: 'Reference documentation.' },
      ],
      truncated: false,
    })
  })

  it('resolves an empty result set rather than failing', async () => {
    servingSearch({ results: [] })
    await expect(searchProvider().search({ query: 'q' }))
      .resolves.toEqual({ sources: [], truncated: false })
  })
})

describe('TavilySearchProvider credentials', () => {
  it('prefers a literal key and starts no resolution behind it', async () => {
    const resolveApiKey = vi.fn(async () => 'resolved-key')
    servingSearch()
    await searchProvider({ apiKey: 'literal-key', resolveApiKey }).search({ query: 'q' })
    expect(resolveApiKey).not.toHaveBeenCalled()
  })

  it('falls through a blank resolved value to the missing-credential error', async () => {
    servingSearch()
    await expect(searchProvider({ apiKey: '', resolveApiKey: async () => '' }).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' }))
  })

  it('names the configured reference and the namespace when nothing resolves a key', async () => {
    servingSearch()
    // A provider configured with no resolver at all, which is what a section that
    // has neither a literal key nor a reachable credential plane looks like.
    const provider = new TavilySearchProvider(() => ({
      credentialName: 'MY_TAVILY_KEY',
      endpoint: 'https://api.tavily.test/search',
      maxResults: 5,
      timeoutMs: 1_000,
      maxContentChars: 2_000,
      ambientKeyPresent: false,
      credentialPresent: false,
      credentialAnswerName: undefined,
    }))
    const error = await rejectedWebError(provider.search({ query: 'q' }))
    expect(error.code).toBe('WEB_PROVIDER_CREDENTIAL_MISSING')
    expect(error.message).toContain('Tavily search has no API key for "MY_TAVILY_KEY"')
    expect(error.message).toContain('web-search-tavily')
  })

  it('maps a credential resolver rejection to WEB_PROVIDER_ERROR without dispatching', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    await expect(searchProvider({
      apiKey: '', resolveApiKey: () => Promise.reject(new Error('credential backend failed')),
    }).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({
        code: 'WEB_PROVIDER_ERROR',
        message: 'Tavily search credential resolution failed: Error: credential backend failed',
      }))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('maps a synchronous credential resolver throw to WEB_PROVIDER_ERROR', async () => {
    servingSearch()
    await expect(searchProvider({
      apiKey: '',
      resolveApiKey: () => { throw new Error('credentials service threw') },
    }).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({
        code: 'WEB_PROVIDER_ERROR',
        message: 'Tavily search credential resolution failed: Error: credentials service threw',
      }))
  })

  it('does not start credential resolution for a pre-aborted call', async () => {
    const resolveApiKey = vi.fn(async () => 'late-key')
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    controller.abort(new Error('caller stopped'))
    await expect(searchProvider({ apiKey: '', resolveApiKey }).search({ query: 'q' }, controller.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED', message: 'Tavily search aborted' }))
    expect(resolveApiKey).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('aborts while an uncooperative credential resolver remains pending', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    const search = searchProvider({ apiKey: '', resolveApiKey: () => new Promise<string>(() => {}) })
      .search({ query: 'q' }, controller.signal)
    controller.abort(new Error('caller stopped'))
    await expect(search).rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('maps its own deadline during credential resolution to a timeout, not a cancellation', async () => {
    servingSearch()
    await expect(searchProvider({ apiKey: '', timeoutMs: 5, resolveApiKey: () => new Promise<string>(() => {}) })
      .search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({
        code: 'WEB_PROVIDER_ERROR',
        message: 'Tavily search timed out after 5ms',
      }))
  })
})

describe('TavilySearchProvider error handling', () => {
  it('carries the observed detail.error of a rejected key, and names the credential', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => jsonResponse(
      { detail: { error: 'Unauthorized: missing or invalid API key.' } },
      { status: 401 },
    )))
    const error = await rejectedWebError(searchProvider({ apiKey: 'bad' }).search({ query: 'q' }))
    expect(error.code).toBe('WEB_PROVIDER_ERROR')
    expect(error.message).toContain('Tavily API error (HTTP 401): Unauthorized: missing or invalid API key.')
    expect(error.message).toContain('Tavily rejected the API key this web search used.')
    expect(error.message).toContain('"TAVILY_API_KEY"')
    expect(error.message).toContain('web-search-tavily')
    expect(error.message).toContain('The endpoint does not need changing.')
  })

  it('treats the edge 403 as a rejected key, since the balancer refuses unrecognized tokens', async () => {
    // Observed live 2026-10-03: no Authorization header -> the application
    // answers 401 with JSON, but any token the API does not recognize -> the
    // awselb edge answers 403 with an HTML page and the API is never reached.
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(
      '<html><head><title>403 Forbidden</title></head></html>',
      { status: 403, headers: { 'server': 'awselb/2.0', 'content-type': 'text/html' } },
    )))
    const error = await rejectedWebError(searchProvider({ apiKey: 'tvily-whatever' }).search({ query: 'q' }))
    expect(error.code).toBe('WEB_PROVIDER_ERROR')
    expect(error.message).toContain('Tavily API error (HTTP 403)')
    expect(error.message).toContain('Tavily rejected the API key this web search used.')
    expect(error.message).toContain('"TAVILY_API_KEY"')
    expect(error.message).toContain('This was the load balancer rather than the API')
    // The HTML body must not leak into the message or break the error shape.
    expect(error.message).not.toContain('<html>')
  })

  it('keeps 401 guidance free of the edge note, which does not apply to it', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => jsonResponse(
      { detail: { error: 'Unauthorized: missing or invalid API key.' } },
      { status: 401 },
    )))
    const error = await rejectedWebError(searchProvider({ apiKey: 'bad' }).search({ query: 'q' }))
    expect(error.message).not.toContain('load balancer')
  })

  it('maps another non-2xx status to WEB_PROVIDER_ERROR with the provider message', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => jsonResponse({ detail: 'rate limited' }, { status: 429 })))
    const error = await rejectedWebError(searchProvider().search({ query: 'q' }))
    expect(error).toMatchObject({ code: 'WEB_PROVIDER_ERROR', message: 'Tavily API error (HTTP 429): rate limited' })
  })

  it('keeps the status line when the error body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response('gateway error', { status: 503 })))
    const error = await rejectedWebError(searchProvider().search({ query: 'q' }))
    expect(error.message).toBe('Tavily API error (HTTP 503)')
  })

  it('keeps the status line when the JSON error body carries no detail', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => jsonResponse({}, { status: 500 })))
    const error = await rejectedWebError(searchProvider().search({ query: 'q' }))
    expect(error.message).toBe('Tavily API error (HTTP 500)')
  })

  it('keeps the status line when the error body read fails rather than aborting', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => failingBodyResponse(
      new TypeError('stream reset'), 500,
    )))
    const error = await rejectedWebError(searchProvider().search({ query: 'q' }))
    expect(error.message).toBe('Tavily API error (HTTP 500)')
  })

  it('surfaces an abort fired during error-body parse as WEB_ABORTED', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => failingBodyResponse(
      new DOMException('aborted', 'AbortError'), 500, () => { controller.abort(new Error('caller stopped')) },
    )))
    await expect(searchProvider().search({ query: 'q' }, controller.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('maps a network failure to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(() => Promise.reject(new TypeError('connection refused'))))
    const error = await rejectedWebError(searchProvider().search({ query: 'q' }))
    expect(error).toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    expect(error.message).toContain('Tavily search request failed: TypeError: connection refused')
  })

  it('maps an abort nobody asked for to the transport failure it really is', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(() => Promise.reject(new DOMException('aborted', 'AbortError'))))
    const error = await rejectedWebError(searchProvider().search({ query: 'q' }))
    expect(error).toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    expect(error.message).toContain('Tavily search request failed:')
    expect(error.message).not.toContain('timed out')
  })

  it('maps a transport timeout to its own deadline', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(() => Promise.reject(
      new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
    )))
    await expect(searchProvider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({
        code: 'WEB_PROVIDER_ERROR',
        message: 'Tavily search timed out after 1000ms',
      }))
  })

  it('maps the caller aborting mid-request to WEB_ABORTED', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal ?? new AbortController().signal
      const fail = (): void => { reject(new DOMException('aborted', 'AbortError')) }
      if (signal.aborted) fail()
      else signal.addEventListener('abort', fail, { once: true })
    })))
    const controller = new AbortController()
    const pending = searchProvider().search({ query: 'q' }, controller.signal)
    controller.abort(new Error('caller cancelled'))
    await expect(pending).rejects.toThrow(expect.objectContaining({
      code: 'WEB_ABORTED',
      message: 'Tavily search aborted',
    }))
  })

  it('keeps the provider error when the success-body parse fails', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response('not json', { status: 200 })))
    const error = await rejectedWebError(searchProvider().search({ query: 'q' }))
    expect(error.code).toBe('WEB_PROVIDER_ERROR')
    expect(error.message).toContain('Tavily returned an unprocessable response body')
  })

  it('surfaces an abort fired during success-body parse as WEB_ABORTED', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => failingBodyResponse(
      new DOMException('aborted', 'AbortError'), 200, () => { controller.abort(new Error('caller stopped')) },
    )))
    await expect(searchProvider().search({ query: 'q' }, controller.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })
})

describe('web-search-tavily plugin registration', () => {
  it('registers the provider into ctx.web (HMR-safe)', async () => {
    servingSearch()
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: TAVILY_PROVIDER_ID })
    const fiber = await ctx.plugin(tavilyPlugin, { apiKey: 'tvly-key' })
    await expect(ctx.web.search({ query: 'q' })).resolves.toMatchObject({ truncated: false })
    await fiber.dispose()
    await expect(ctx.web.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' }))
  })

  it('has no default export (namespace plugin export shape)', () => {
    expect('default' in tavilyPlugin).toBe(false)
  })

  it('never lets a credential store rejection reach the Host as an unhandled rejection', async () => {
    // `refresh()` runs unawaited from load, from a later credentials mount, and
    // from a `credentials/reference-updated` event — any of those propagating a
    // rejection would reach app-boot's fail-loud handler and exit the process
    // over a credential read a real search would simply have retried.
    class FailingResolveCredentials extends MemoryCredentials {
      override resolve(_ref: CredentialRef): Promise<ResolvedCredential | undefined> {
        return Promise.reject(new Error('credential store unavailable'))
      }
    }
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const ctx = new Context()
      await ctx.plugin(WebRuntime, {})
      await ctx.plugin(FailingResolveCredentials)
      await ctx.plugin(tavilyPlugin, { apiKeyEnv: 'TAVILY_API_KEY' })
      // Let every unawaited `refresh()` microtask settle.
      await new Promise((resolve) => { setTimeout(resolve, 0) })
      await ctx.fiber.dispose()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
    expect(unhandled).not.toHaveBeenCalled()
  })

  it('survives the real Loader unwrapExports path keeping name/inject/Config', () => {
    // A default export would make `unwrapExports` collapse the namespace and drop `inject: ['web']`.
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(tavilyPlugin) as Record<string, unknown>
    expect(unwrapped).toBe(tavilyPlugin)
    expect(unwrapped.name).toBe('web-search-tavily')
    expect(unwrapped.inject).toEqual(['web'])
    expect(typeof unwrapped.apply).toBe('function')
  })

  it('serves the settings namespace the Web search card binds to', () => {
    expect(tavilyPlugin.WEB_SEARCH_TAVILY_SETTINGS_NAMESPACE).toBe('web-search-tavily')
    expect(TAVILY_PROVIDER_ID).toBe('tavily')
  })

  it('is unavailable — not merely failing — when no key can resolve', async () => {
    const previous = process.env.TAVILY_API_KEY
    delete process.env.TAVILY_API_KEY
    try {
      const ctx = new Context()
      await ctx.plugin(WebRuntime, {})
      await ctx.plugin(tavilyPlugin, {})
      await expect(ctx.web.search({ query: 'q' }))
        .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_UNAVAILABLE' }))
      await ctx.fiber.dispose()
    } finally {
      if (previous !== undefined) process.env.TAVILY_API_KEY = previous
    }
  })

  it('reports the configured provider as unavailable rather than dispatching without a key', async () => {
    const previous = process.env.TAVILY_API_KEY
    delete process.env.TAVILY_API_KEY
    try {
      const ctx = new Context()
      await ctx.plugin(WebRuntime, { searchProvider: TAVILY_PROVIDER_ID })
      await ctx.plugin(tavilyPlugin, {})
      await expect(ctx.web.search({ query: 'q' }))
        .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE' }))
      await ctx.fiber.dispose()
    } finally {
      if (previous !== undefined) process.env.TAVILY_API_KEY = previous
    }
  })

  it('is auto-selected once a key resolves, without any configured provider id', async () => {
    const previous = process.env.TAVILY_API_KEY
    process.env.TAVILY_API_KEY = 'env-key'
    try {
      servingSearch()
      const ctx = new Context()
      await ctx.plugin(WebRuntime, {})
      await ctx.plugin(tavilyPlugin, {})
      await expect(ctx.web.search({ query: 'q' })).resolves.toMatchObject({ truncated: false })
      await ctx.fiber.dispose()
    } finally {
      if (previous === undefined) delete process.env.TAVILY_API_KEY
      else process.env.TAVILY_API_KEY = previous
    }
  })

  it('threads endpoint, bounds, and the credential reference through', async () => {
    const fetchMock = servingSearch()
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: TAVILY_PROVIDER_ID })
    const fiber = await ctx.plugin(tavilyPlugin, {
      apiKey: 'threaded-key',
      apiKeyEnv: 'MY_TAVILY_KEY',
      baseURL: 'https://tavily.entry.test/search',
      numResults: 3,
      timeoutMs: 2_000,
      maxContentChars: 64,
    })
    await ctx.web.search({ query: 'q' })
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://tavily.entry.test/search')
    expect(bodyOf(fetchMock)).toMatchObject({ max_results: 3 })
    await fiber.dispose()
  })

  it('bounds a verbose Tavily page to the configured snippet length', async () => {
    const content = `${'word '.repeat(500)}end`
    servingSearch(searchResponse({ results: [{ url: 'https://verbose.test', title: 'Verbose', content }] }))
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: TAVILY_PROVIDER_ID })
    await ctx.plugin(tavilyPlugin, { apiKey: 'k', maxContentChars: 64 })
    const result = await ctx.web.search({ query: 'q' })
    expect(result.sources[0]?.snippet?.length).toBeLessThanOrEqual(64)
    expect(result.sources[0]?.snippet?.endsWith('…')).toBe(true)
  })

  it('sends the shipped defaults when the section names none', async () => {
    const fetchMock = servingSearch()
    const previous = process.env.TAVILY_API_KEY
    process.env.TAVILY_API_KEY = 'env-key'
    try {
      const ctx = new Context()
      await ctx.plugin(WebRuntime, { searchProvider: TAVILY_PROVIDER_ID })
      tavilyPlugin.apply(ctx, tavilyPlugin.Config({}))
      await ctx.web.search({ query: 'q' })
      expect(fetchMock.mock.calls[0]?.[0]).toBe(TAVILY_DEFAULT_ENDPOINT)
      expect(bodyOf(fetchMock)).toEqual({ query: 'q', max_results: TAVILY_DEFAULT_MAX_RESULTS })
      expect(new Headers(requestOf(fetchMock).headers).get('authorization')).toBe('Bearer env-key')
      await ctx.fiber.dispose()
    } finally {
      if (previous === undefined) delete process.env.TAVILY_API_KEY
      else process.env.TAVILY_API_KEY = previous
    }
  })

  it('rejects a fractional bound at plugin construction', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: TAVILY_PROVIDER_ID })
    await expect(ctx.plugin(tavilyPlugin, { apiKey: 'k', numResults: 1.5 }))
      .rejects.toThrow(/numResults expected number multiple of 1/)
    await expect(ctx.plugin(tavilyPlugin, { apiKey: 'k', maxContentChars: 0 }))
      .rejects.toThrow(/maxContentChars expected number >= 1/)
  })

  it('reports a typo in the credential reference as absent rather than crashing', async () => {
    servingSearch()
    const previous = process.env.TAVILY_API_KEY
    delete process.env.TAVILY_API_KEY
    try {
      const ctx = new Context()
      await ctx.plugin(WebRuntime, { searchProvider: TAVILY_PROVIDER_ID })
      await ctx.plugin(tavilyPlugin, { apiKeyEnv: 'not a ref' })
      await expect(ctx.web.search({ query: 'q' }))
        .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE' }))
      await ctx.fiber.dispose()
    } finally {
      if (previous !== undefined) process.env.TAVILY_API_KEY = previous
    }
  })

  it('resolves a stored key for each search so a key written in the UI reaches the next one', async () => {
    const previous = process.env.TAVILY_API_KEY
    delete process.env.TAVILY_API_KEY
    const dir = await mkdtemp(join(tmpdir(), 'dsh-web-search-tavily-'))
    const fetchMock = servingSearch()
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    try {
      await ctx.plugin(WebRuntime, { searchProvider: TAVILY_PROVIDER_ID })
      await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
      await ctx.plugin(tavilyPlugin, { baseURL: 'https://api.tavily.test/search' })

      // The key is stored after mount, exactly as the settings page writes it.
      // The answer is re-read from the event that write committed, so the
      // provider becomes usable without a restart; `waitFor` is that settling.
      const ref = credentialRef('TAVILY_API_KEY')
      await ctx.credentials.set(ref, 'stored-key')
      await vi.waitFor(async () => { await ctx.web.search({ query: 'stored' }) })
      await ctx.credentials.set(ref, 'rotated-key')
      await vi.waitFor(async () => { await ctx.web.search({ query: 'rotated' }) })

      const sent = fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers).get('authorization'))
      expect([...new Set(sent)]).toEqual(['Bearer stored-key', 'Bearer rotated-key'])
    } finally {
      await ctx.fiber.dispose()
      await rm(dir, { recursive: true, force: true })
      if (previous !== undefined) process.env.TAVILY_API_KEY = previous
    }
  })

  it('becomes available when the credentials seam mounts after the provider', async () => {
    const previous = process.env.TAVILY_API_KEY
    delete process.env.TAVILY_API_KEY
    const dir = await mkdtemp(join(tmpdir(), 'dsh-web-search-tavily-late-'))
    const fetchMock = servingSearch()
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    try {
      await ctx.plugin(WebRuntime, { searchProvider: TAVILY_PROVIDER_ID })
      await ctx.plugin(tavilyPlugin, { baseURL: 'https://api.tavily.test/search' })
      await expect(ctx.web.search({ query: 'q' }))
        .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE' }))

      await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
      await ctx.credentials.set(credentialRef('TAVILY_API_KEY'), 'late-seam-key')

      await vi.waitFor(async () => { await ctx.web.search({ query: 'q' }) })
      expect(new Headers(requestOf(fetchMock, fetchMock.mock.calls.length - 1).headers).get('authorization'))
        .toBe('Bearer late-seam-key')

      // A change addressed to another reference must not re-read this provider's
      // answer against that other name and report the key as gone.
      ctx.emit('credentials/reference-updated', credentialRef('SOME_OTHER_KEY'))
      await expect(ctx.web.search({ query: 'q' })).resolves.toMatchObject({ truncated: false })
    } finally {
      await ctx.fiber.dispose()
      await rm(dir, { recursive: true, force: true })
      if (previous !== undefined) process.env.TAVILY_API_KEY = previous
    }
  })
})
