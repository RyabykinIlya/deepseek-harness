import { afterEach, describe, expect, it, vi } from 'vitest'
import { LlmError } from '@deepseek-ai/dsh-llm'
import {
  CATALOG_HTTP_ERROR_CODE,
  CATALOG_UNREACHABLE_CODE,
  MALFORMED_CATALOG_CODE,
  OPENROUTER_CATALOG_MAX_BYTES,
  OPENROUTER_CATALOG_TIMEOUT_MS,
  fetchOpenRouterModelCatalog,
  parseOpenRouterCatalog,
} from '../src/openrouter-catalog.ts'

/**
 * The identity fields of the entries this package's callers resolve against,
 * transcribed from `GET https://openrouter.ai/api/v1/models` on 2026-10-04. The
 * rest of each entry — pricing, limits, and the rest of `architecture` — is not
 * read here and is not transcribed.
 */
const envelope = {
  data: [
    { id: 'deepseek/deepseek-v4-pro', canonical_slug: 'deepseek/deepseek-v4-pro-20260423' },
    { id: 'deepseek/deepseek-v4-pro-0813', canonical_slug: 'deepseek/deepseek-v4-pro-20260813' },
    { id: 'deepseek/deepseek-v4.1-flash', canonical_slug: 'deepseek/deepseek-v4.1-flash-20260910' },
    { id: 'deepseek/deepseek-v4.1-flash:batch', canonical_slug: 'deepseek/deepseek-v4.1-flash-20260910' },
    { id: 'deepseek/deepseek-r1-0528', canonical_slug: 'deepseek/deepseek-r1-0528' },
    { id: '~deepseek/deepseek-pro-latest', canonical_slug: '~deepseek/deepseek-pro-latest' },
    { id: 'stealth/space-bunny-alpha' },
  ],
}

/** Return the LlmError one synchronous parse raised, or propagate anything else. */
function parseFailure(body: unknown): LlmError {
  try {
    parseOpenRouterCatalog(body)
  } catch (error: unknown) {
    if (error instanceof LlmError) return error
    throw error
  }
  throw new Error('expected the parse to reject')
}

/** Return the LlmError one operation rejected with, or propagate anything else. */
async function rejection(operation: Promise<unknown>): Promise<LlmError> {
  try {
    await operation
  } catch (error: unknown) {
    if (error instanceof LlmError) return error
    throw error
  }
  throw new Error('expected the operation to reject')
}

/** A 200 JSON response the fetcher can parse. */
function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

afterEach(() => { vi.unstubAllGlobals() })

describe('parseOpenRouterCatalog', () => {
  it('reads each entry as its id and the dated identity of that id', () => {
    expect(parseOpenRouterCatalog(envelope)).toEqual([
      { id: 'deepseek/deepseek-v4-pro', canonicalSlug: 'deepseek/deepseek-v4-pro-20260423' },
      { id: 'deepseek/deepseek-v4-pro-0813', canonicalSlug: 'deepseek/deepseek-v4-pro-20260813' },
      { id: 'deepseek/deepseek-v4.1-flash', canonicalSlug: 'deepseek/deepseek-v4.1-flash-20260910' },
      { id: 'deepseek/deepseek-v4.1-flash:batch', canonicalSlug: 'deepseek/deepseek-v4.1-flash-20260910' },
      { id: 'deepseek/deepseek-r1-0528', canonicalSlug: 'deepseek/deepseek-r1-0528' },
      { id: '~deepseek/deepseek-pro-latest', canonicalSlug: '~deepseek/deepseek-pro-latest' },
      // An entry that states no canonical slug names no dated release, which is
      // how a model outside any dated family is recognized.
      { id: 'stealth/space-bunny-alpha', canonicalSlug: 'stealth/space-bunny-alpha' },
    ])
  })

  it('skips what carries no usable id, and trims what does', () => {
    const entries = parseOpenRouterCatalog({
      data: [
        null,
        'text',
        [],
        { canonical_slug: 'orphan/model-20260101' },
        { id: '   ' },
        { id: 7 },
        { id: ' spaced/model ', canonical_slug: '  spaced/model-20260101  ' },
        { id: 'blank/canonical', canonical_slug: '   ' },
      ],
    })
    expect(entries).toEqual([
      { id: 'spaced/model', canonicalSlug: 'spaced/model-20260101' },
      { id: 'blank/canonical', canonicalSlug: 'blank/canonical' },
    ])
  })

  it('carries the modalities an entry declares, and states none for a list it cannot read', () => {
    const entries = parseOpenRouterCatalog({
      data: [
        {
          id: 'vision/model',
          canonical_slug: 'vision/model-20260101',
          architecture: { input_modalities: ['text', 'image', 'file'] },
        },
        { id: 'text-only/model', canonical_slug: 'text-only/model-20260101', architecture: { input_modalities: ['text'] } },
        { id: 'absent/model', architecture: { output_modalities: ['text'] } },
        { id: 'empty-list/model', architecture: { input_modalities: [] } },
        { id: 'not-a-list/model', architecture: { input_modalities: 'text' } },
        { id: 'blank-member/model', architecture: { input_modalities: ['text', '  '] } },
        { id: 'non-string-member/model', architecture: { input_modalities: ['text', 7] } },
        { id: 'list-architecture/model', architecture: ['text'] },
        { id: 'null-architecture/model', architecture: null },
      ],
    })
    expect(entries).toEqual([
      {
        id: 'vision/model',
        canonicalSlug: 'vision/model-20260101',
        inputModalities: ['text', 'image', 'file'],
      },
      { id: 'text-only/model', canonicalSlug: 'text-only/model-20260101', inputModalities: ['text'] },
      { id: 'absent/model', canonicalSlug: 'absent/model' },
      { id: 'empty-list/model', canonicalSlug: 'empty-list/model' },
      { id: 'not-a-list/model', canonicalSlug: 'not-a-list/model' },
      { id: 'blank-member/model', canonicalSlug: 'blank-member/model' },
      { id: 'non-string-member/model', canonicalSlug: 'non-string-member/model' },
      { id: 'list-architecture/model', canonicalSlug: 'list-architecture/model' },
      { id: 'null-architecture/model', canonicalSlug: 'null-architecture/model' },
    ])
    // A reply that names no modalities states no capability; only an entry that
    // declares a readable list says which ones it accepts.
    expect(entries[0]?.inputModalities).toEqual(['text', 'image', 'file'])
    expect(entries[6]?.inputModalities).toBeUndefined()
  })

  it('refuses an envelope it cannot read, rather than reporting an empty catalog', () => {
    for (const body of [null, 'text', 42, [], { error: { message: 'Not found' } }, { data: null }, { data: {} }]) {
      expect(parseFailure(body).code).toBe(MALFORMED_CATALOG_CODE)
    }
    // An empty catalog is a real answer here, unlike a missing one.
    expect(parseOpenRouterCatalog({ data: [] })).toEqual([])
  })
})

describe('fetchOpenRouterModelCatalog', () => {
  it('reads the catalog from the configured root, trailing slashes and all', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(envelope))
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchOpenRouterModelCatalog()).resolves.toHaveLength(envelope.data.length)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://openrouter.ai/api/v1/models')
    await fetchOpenRouterModelCatalog({ baseURL: 'https://gateway.example/api/v1///' })
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://gateway.example/api/v1/models')
  })

  it('asks for JSON, attributes itself, and carries a credential only when given one', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(envelope))
    vi.stubGlobal('fetch', fetchMock)
    await fetchOpenRouterModelCatalog({ headers: { 'x-proxy': 'yes' } })
    let headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers)
    expect(headers.get('accept')).toBe('application/json')
    expect(headers.get('x-proxy')).toBe('yes')
    expect(headers.get('user-agent')).toMatch(/^deepseek-harness\//u)
    expect(headers.get('authorization')).toBeNull()
    await fetchOpenRouterModelCatalog({ apiKey: '', headers: { 'user-agent': 'proxy/1' } })
    headers = new Headers(fetchMock.mock.calls[1]?.[1]?.headers)
    expect(headers.get('authorization')).toBeNull()
    await fetchOpenRouterModelCatalog({ apiKey: 'sk-test', headers: { 'user-agent': 'proxy/1' } })
    headers = new Headers(fetchMock.mock.calls[2]?.[1]?.headers)
    expect(headers.get('authorization')).toBe('Bearer sk-test')
    // Attribution names win a collision, so a proxy cannot hide the client.
    expect(headers.get('user-agent')).toMatch(/^deepseek-harness\//u)
  })

  it('classifies a refused credential by status and names the URL', async () => {
    for (const status of [401, 403, 429, 500]) {
      vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response('nope', { status })))
      const error = await rejection(fetchOpenRouterModelCatalog())
      expect(error.code).toBe(CATALOG_HTTP_ERROR_CODE)
      expect(error.message).toContain(String(status))
      expect(error.message.includes('credential')).toBe(status === 401 || status === 403)
    }
  })

  it('classifies an unreachable endpoint separately from a refused one', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => { throw new TypeError('connection refused') }))
    const error = await rejection(fetchOpenRouterModelCatalog())
    expect(error.code).toBe(CATALOG_UNREACHABLE_CODE)
    expect(error.message).toContain('could not reach')
    expect(error.cause).toBeInstanceOf(TypeError)
  })

  it('reports a caller cancellation as ABORTED rather than as a timeout', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => { throw new DOMException('aborted', 'AbortError') }))
    const controller = new AbortController()
    controller.abort(new Error('caller stopped'))
    const error = await rejection(fetchOpenRouterModelCatalog({ signal: controller.signal }))
    expect(error.code).toBe('ABORTED')
  })

  it('reports the configured timeout as TIMEOUT', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('timeout', 'TimeoutError'))
      }, { once: true })
    })))
    const error = await rejection(fetchOpenRouterModelCatalog({ timeoutMs: 5 }))
    expect(error.code).toBe('TIMEOUT')
    expect(error.message).toContain('5ms')
    expect(OPENROUTER_CATALOG_TIMEOUT_MS).toBe(10_000)
  })

  it('reports a body that is not JSON and one that is JSON but not a catalog', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response('<html>502</html>', { status: 200 })))
    expect((await rejection(fetchOpenRouterModelCatalog())).code).toBe(MALFORMED_CATALOG_CODE)
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => jsonResponse({ error: { message: 'Not found' } })))
    expect((await rejection(fetchOpenRouterModelCatalog())).code).toBe(MALFORMED_CATALOG_CODE)
  })

  it('turns away an oversized reply on its declared length, before reading it', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, {
      status: 200,
      headers: { 'content-length': String(OPENROUTER_CATALOG_MAX_BYTES + 1) },
    }))
    vi.stubGlobal('fetch', fetchMock)
    const error = await rejection(fetchOpenRouterModelCatalog())
    expect(error.code).toBe(MALFORMED_CATALOG_CODE)
    expect(error.message).toContain(String(OPENROUTER_CATALOG_MAX_BYTES))
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('refuses an oversized reply whose declared length understated it', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ data: [{ id: 'a/b', description: 'x'.repeat(OPENROUTER_CATALOG_MAX_BYTES) }] }),
      { status: 200, headers: { 'content-length': '512' } },
    )))
    const error = await rejection(fetchOpenRouterModelCatalog())
    expect(error.code).toBe(MALFORMED_CATALOG_CODE)
    expect(error.message).toContain(String(OPENROUTER_CATALOG_MAX_BYTES))
  })

  it('reports a cancellation that lands while the body is being read', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => {
      controller.abort(new Error('caller stopped'))
      return new Response(new ReadableStream<Uint8Array>({
        pull(streamController) { streamController.error(new Error('connection reset')) },
      }), { status: 200 })
    }))
    const error = await rejection(fetchOpenRouterModelCatalog({ signal: controller.signal }))
    expect(error.code).toBe('ABORTED')
  })
})
