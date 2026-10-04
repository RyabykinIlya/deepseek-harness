import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LlmError } from '@deepseek-ai/dsh-llm'
import {
  ENDPOINTS_HTTP_ERROR_CODE,
  ENDPOINTS_UNREACHABLE_CODE,
  INVALID_MODEL_ID_CODE,
  MALFORMED_ENDPOINTS_CODE,
  OPENROUTER_ENDPOINTS_MAX_BYTES,
  OPENROUTER_ENDPOINTS_TIMEOUT_MS,
  fetchOpenRouterEndpoints,
  parseOpenRouterEndpoints,
} from '../src/openrouter-endpoints.ts'

const MODEL = 'deepseek/deepseek-v4-pro'

/**
 * The reply recorded live from
 * `GET https://openrouter.ai/api/v1/models/deepseek/deepseek-v4-pro/endpoints`
 * on 2026-10-03, byte for byte. Every number this package's computation is
 * checked against is read out of this file rather than invented.
 */
const recorded: unknown = JSON.parse(
  await readFile(
    fileURLToPath(new URL('./fixtures/openrouter-endpoints/deepseek-v4-pro-2026-10-03.json', import.meta.url)),
    'utf8',
  ),
)

/** The LlmError one synchronous parse raised, or propagate anything else. */
function parseFailure(body: unknown): LlmError {
  try {
    parseOpenRouterEndpoints(body, MODEL)
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

/** Stub `fetch` with one successful answer and return the spy. */
function serving(body: unknown): ReturnType<typeof vi.fn<typeof fetch>> {
  const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(body))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** One raw entry with every field this parser reads, so a case overrides one at a time. */
function rawEndpoint(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'StreamLake | deepseek/deepseek-v4-pro',
    provider_name: 'StreamLake',
    tag: 'streamlake/fp8',
    quantization: 'fp8',
    context_length: 1_024_000,
    max_completion_tokens: 384_000,
    status: 0,
    pricing: { prompt: '0.0000002088', completion: '0.0000004176', input_cache_read: '0.0000000174', discount: 0.88 },
    uptime_last_30m: 99.61,
    uptime_last_5m: 99.39,
    uptime_last_1d: 98.67,
    latency_last_30m: null,
    throughput_last_30m: null,
    supported_parameters: ['reasoning', 'tools'],
    ...overrides,
  }
}

/** The recorded reply's endpoints, wrapped in the documented envelope. */
function envelope(endpoints: readonly unknown[]): unknown {
  return { data: { id: MODEL, name: 'DeepSeek: DeepSeek V4 Pro', endpoints } }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('parseOpenRouterEndpoints', () => {
  it('reads the recorded reply field for field', () => {
    const endpoints = parseOpenRouterEndpoints(recorded, MODEL)
    expect(endpoints).toHaveLength(16)
    const streamlake = endpoints.find(endpoint => endpoint.slug === 'streamlake/fp8')
    expect(streamlake).toEqual({
      slug: 'streamlake/fp8',
      providerName: 'StreamLake',
      quantization: 'fp8',
      contextLength: 1_024_000,
      maxCompletionTokens: 384_000,
      status: 0,
      promptPrice: 0.0000002088,
      completionPrice: 0.0000004176,
      inputCacheReadPrice: 0.0000000174,
      discount: 0.88,
      uptimeLast30m: 99.61131120065613,
      uptimeLast5m: 99.39145389601799,
      uptimeLast1d: 98.67256657559044,
      supportedParameters: expect.arrayContaining(['reasoning', 'tools']) as readonly string[],
    })
  })

  it('narrows an absent measurement to undefined rather than to zero', () => {
    // Measured on the recorded reply: latency and throughput are `null` for all
    // sixteen upstreams, and `Reka` publishes no uptime at all. Scoring either as
    // zero would rank a provider as the worst in the world on a field nobody
    // measured.
    const endpoints = parseOpenRouterEndpoints(recorded, MODEL)
    expect(endpoints.every(endpoint => endpoint.latencyLast30m === undefined)).toBe(true)
    expect(endpoints.every(endpoint => endpoint.throughputLast30m === undefined)).toBe(true)
    expect(endpoints.find(endpoint => endpoint.slug === 'reka')?.uptimeLast30m).toBeUndefined()
    expect(endpoints.find(endpoint => endpoint.slug === 'gmicloud/fp8')?.status).toBe(-2)
  })

  it('drops an entry with no routable provider slug and keeps every field of one that has it', () => {
    const endpoints = parseOpenRouterEndpoints(envelope([
      rawEndpoint({ tag: '   ' }),
      rawEndpoint(),
      { tag: 'nameless' },
      'not an object',
      null,
      [rawEndpoint()],
      rawEndpoint({ quantization: null, provider_name: 7, status: 'n/a', uptime_last_30m: 'not-a-number' }),
    ]), MODEL)
    expect(endpoints.map(endpoint => endpoint.slug)).toEqual(['streamlake/fp8', 'nameless', 'streamlake/fp8'])
    // Keys are dropped rather than set to undefined, so a mapped endpoint says
    // only what the upstream published: a null quantization, a numeric provider
    // name, an unparseable status, and an unparseable uptime all vanish.
    expect(Object.keys(endpoints[2] ?? {}).sort()).toEqual([
      'completionPrice', 'contextLength', 'discount', 'inputCacheReadPrice', 'maxCompletionTokens',
      'promptPrice', 'slug', 'supportedParameters', 'uptimeLast1d', 'uptimeLast5m',
    ])
  })

  it('reads a latency and throughput measurement when OpenRouter publishes one', () => {
    // Every v4-pro endpoint reports null for both; this is the shape a model
    // whose endpoints DO publish them arrives in, and the ranking depends on
    // both directions of these two fields.
    const endpoints = parseOpenRouterEndpoints(envelope([
      rawEndpoint({ latency_last_30m: 0.42, throughput_last_30m: 137.5 }),
      rawEndpoint({ latency_last_30m: Number.NaN, throughput_last_30m: Number.POSITIVE_INFINITY }),
    ]), MODEL)
    expect(endpoints[0]).toMatchObject({ latencyLast30m: 0.42, throughputLast30m: 137.5 })
    expect(Object.keys(endpoints[1] ?? {})).not.toContain('latencyLast30m')
    expect(Object.keys(endpoints[1] ?? {})).not.toContain('throughputLast30m')
  })

  it('accepts a numeric field sent as a number and drops an unusable one', () => {
    const endpoints = parseOpenRouterEndpoints(envelope([
      rawEndpoint({ pricing: { prompt: 1, completion: 2 } }),
      rawEndpoint({ pricing: { prompt: '0.5', completion: '' } }),
      rawEndpoint({ pricing: { prompt: 'Infinity', completion: 2 } }),
      rawEndpoint({ pricing: 'flat-rate' }),
      rawEndpoint({ pricing: { completion: 2, discount: -0.25 } }),
    ]), MODEL)
    expect(endpoints[0]).toMatchObject({ promptPrice: 1, completionPrice: 2 })
    expect(endpoints[1]).toMatchObject({ promptPrice: 0.5 })
    expect(Object.keys(endpoints[1] ?? {})).not.toContain('completionPrice')
    expect(Object.keys(endpoints[2] ?? {})).not.toContain('promptPrice')
    expect(Object.keys(endpoints[3] ?? {})).not.toContain('promptPrice')
    expect(Object.keys(endpoints[4] ?? {})).not.toContain('promptPrice')
    // A negative discount is a real measurement, not an unusable one: it is how
    // a provider charging above its own list price is published.
    expect(endpoints[4]).toMatchObject({ discount: -0.25 })
  })

  it('reads a parameters list, dropping entries that are not names', () => {
    const endpoints = parseOpenRouterEndpoints(envelope([
      rawEndpoint({ supported_parameters: ['tools', 7, null, '  ', 'reasoning_effort'] }),
      rawEndpoint({ supported_parameters: 'tools' }),
    ]), MODEL)
    expect(endpoints[0]?.supportedParameters).toEqual(['tools', 'reasoning_effort'])
    expect(Object.keys(endpoints[1] ?? {})).not.toContain('supportedParameters')
  })

  it('names the model when the reply is not an endpoint listing', () => {
    for (const body of [null, 'text', [], { error: { message: 'Not found' } }, { data: null }, { data: [] }, { data: { endpoints: {} } }]) {
      const failure = parseFailure(body)
      expect(failure.code).toBe(MALFORMED_ENDPOINTS_CODE)
      expect(failure.message).toContain(MODEL)
    }
  })

  it('accepts an empty listing rather than mistaking it for a broken one', () => {
    expect(parseOpenRouterEndpoints(envelope([]), MODEL)).toEqual([])
  })
})

describe('fetchOpenRouterEndpoints', () => {
  it('refuses a model id OpenRouter does not publish endpoints under, before any request', async () => {
    const fetchMock = serving(envelope([]))
    for (const model of ['deepseek-v4-pro', '/deepseek', 'deepseek/', 'a/b/c', '']) {
      const error = await rejection(fetchOpenRouterEndpoints(model))
      expect(error.code).toBe(INVALID_MODEL_ID_CODE)
      expect(error.message).toContain(JSON.stringify(model))
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('requests the documented path and sends no credential unless one was given', async () => {
    const fetchMock = serving(recorded)
    const endpoints = await fetchOpenRouterEndpoints(MODEL)
    expect(endpoints).toHaveLength(16)
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`https://openrouter.ai/api/v1/models/${MODEL}/endpoints`)
    const init = fetchMock.mock.calls[0]?.[1] ?? {}
    expect(init.method).toBe('GET')
    expect(init.redirect).toBe('error')
    const headers = new Headers(init.headers)
    expect(headers.get('accept')).toBe('application/json')
    expect(headers.get('authorization')).toBeNull()
    expect(headers.get('user-agent')).toMatch(/^deepseek-harness\//u)
  })

  it('sends a credential and the deployment headers it was given, with attribution winning', async () => {
    const fetchMock = serving(envelope([]))
    await fetchOpenRouterEndpoints(MODEL, {
      apiKey: 'sk-or-test',
      headers: { 'x-deployment': 'yes', 'user-agent': 'override-me' },
      baseURL: 'https://gateway.test/api/v1/',
    })
    const init = fetchMock.mock.calls[0]?.[1] ?? {}
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`https://gateway.test/api/v1/models/${MODEL}/endpoints`)
    const headers = new Headers(init.headers)
    expect(headers.get('authorization')).toBe('Bearer sk-or-test')
    expect(headers.get('x-deployment')).toBe('yes')
    expect(headers.get('user-agent')).not.toBe('override-me')
  })

  it('omits the authorization header for an empty credential', async () => {
    const fetchMock = serving(envelope([]))
    await fetchOpenRouterEndpoints(MODEL, { apiKey: '' })
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('authorization')).toBeNull()
  })

  it('refuses a model id carrying a second separator rather than reshaping the path', async () => {
    const fetchMock = serving(envelope([]))
    const error = await rejection(fetchOpenRouterEndpoints('vendor/model/extra'))
    expect(error.code).toBe(INVALID_MODEL_ID_CODE)
    expect(fetchMock).not.toHaveBeenCalled()
    // A space is a legal character in a segment, so both are percent-encoded on
    // the way out rather than refused on the way in.
    await fetchOpenRouterEndpoints('a b/c d')
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://openrouter.ai/api/v1/models/a%20b/c%20d/endpoints',
    )
  })

  it('classifies a refused credential by status and names the URL', async () => {
    for (const status of [401, 403, 429, 500]) {
      vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response('nope', { status })))
      const error = await rejection(fetchOpenRouterEndpoints(MODEL))
      expect(error.code).toBe(ENDPOINTS_HTTP_ERROR_CODE)
      expect(error.message).toContain(String(status))
      expect(error.message).toContain(MODEL)
      expect(error.message.includes('credential')).toBe(status === 401 || status === 403)
    }
  })

  it('classifies an unreachable endpoint separately from a refused one', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => { throw new TypeError('connection refused') }))
    const error = await rejection(fetchOpenRouterEndpoints(MODEL))
    expect(error.code).toBe(ENDPOINTS_UNREACHABLE_CODE)
    expect(error.message).toContain('could not reach')
    expect(error.cause).toBeInstanceOf(TypeError)
  })

  it('reports a caller cancellation as ABORTED rather than as a timeout', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => { throw new DOMException('aborted', 'AbortError') }))
    const controller = new AbortController()
    controller.abort(new Error('caller stopped'))
    const error = await rejection(fetchOpenRouterEndpoints(MODEL, { signal: controller.signal }))
    expect(error.code).toBe('ABORTED')
  })

  it('reports the configured timeout as TIMEOUT', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('timeout', 'TimeoutError'))
      }, { once: true })
    })))
    const error = await rejection(fetchOpenRouterEndpoints(MODEL, { timeoutMs: 5 }))
    expect(error.code).toBe('TIMEOUT')
    expect(error.message).toContain('5ms')
    expect(OPENROUTER_ENDPOINTS_TIMEOUT_MS).toBe(10_000)
  })

  it('reports a body that is not JSON and one that is JSON but not a listing', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response('<html>502</html>', { status: 200 })))
    expect((await rejection(fetchOpenRouterEndpoints(MODEL))).code).toBe(MALFORMED_ENDPOINTS_CODE)
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response('{"error":{"message":"Not found"}}', { status: 200 })))
    expect((await rejection(fetchOpenRouterEndpoints(MODEL))).code).toBe(MALFORMED_ENDPOINTS_CODE)
  })

  it('turns away an oversized reply on its declared length, before reading it', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, {
      status: 200,
      headers: { 'content-length': String(OPENROUTER_ENDPOINTS_MAX_BYTES + 1) },
    }))
    vi.stubGlobal('fetch', fetchMock)
    const error = await rejection(fetchOpenRouterEndpoints(MODEL))
    expect(error.code).toBe(MALFORMED_ENDPOINTS_CODE)
    expect(error.message).toContain(String(OPENROUTER_ENDPOINTS_MAX_BYTES))
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('refuses an oversized reply whose declared length understated it', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify(envelope([rawEndpoint({ padding: 'x'.repeat(OPENROUTER_ENDPOINTS_MAX_BYTES) })])),
      { status: 200, headers: { 'content-length': '512' } },
    )))
    const error = await rejection(fetchOpenRouterEndpoints(MODEL))
    expect(error.code).toBe(MALFORMED_ENDPOINTS_CODE)
    expect(error.message).toContain(String(OPENROUTER_ENDPOINTS_MAX_BYTES))
  })

  it('reports a cancellation that lands while the body is being read', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => {
      controller.abort(new Error('caller stopped'))
      return new Response(new ReadableStream<Uint8Array>({
        pull(streamController) { streamController.error(new Error('connection reset')) },
      }), { status: 200 })
    }))
    const error = await rejection(fetchOpenRouterEndpoints(MODEL, { signal: controller.signal }))
    expect(error.code).toBe('ABORTED')
  })

  it('accepts an empty 200 body as an empty listing decision rather than a crash', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(null, { status: 200 })))
    await expect(rejection(fetchOpenRouterEndpoints(MODEL))).resolves.toMatchObject({ code: MALFORMED_ENDPOINTS_CODE })
  })
})
