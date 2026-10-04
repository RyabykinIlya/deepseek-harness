/**
 * Read-only access to OpenRouter's per-provider endpoint list for one model:
 * `GET /api/v1/models/{author}/{slug}/endpoints`.
 *
 * This is the only price and objective-quality fact the harness has about an
 * OpenRouter upstream. `catalog.ts` deliberately zeroes pi-ai's cost metadata
 * (`NO_COST`) because pi-ai's catalog carries a price the harness never reads,
 * and OpenRouter's model-level `pricing` is not that price anyway: **verified
 * live 2026-10-03** against `deepseek/deepseek-v4-pro`, the model entry reports
 * `prompt 0.0000002088 / completion 0.0000004176`, which is exactly *StreamLake*'
 * price — while *Relace*, the cheapest on prompt alone (`0.0000002083`), charges
 * `0.0000027` for completion, 6.5× the model entry. So the model-level figure
 * names one provider's blended price rather than a floor over prompt and
 * completion separately, and any comparison taken against it inherits whichever
 * blend the upstream happened to pick. A price comparison therefore has to
 * blend prompt and completion explicitly and take its reference from the
 * endpoint list itself.
 *
 * **Nothing here is stored.** The reply is a live fact read for one routing
 * decision and dropped when that decision is made, which is the same posture
 * `discovery.ts` states for the model-listing path: the installed pi-ai catalog
 * stays the served catalog, this never refreshes it, and `cordis.patch.yml`
 * remains the only thing that decides what a route serves. The module makes no
 * network call at import time and holds no cache — a deployment that wants one
 * wraps {@link fetchOpenRouterEndpoints} in the cache it wants, and this file
 * stays the place the wire shape is read.
 *
 * Every value is parsed defensively: the reply is a third party's, so a field
 * that is absent, null, a string, or a string that is not a number narrows to
 * `undefined` instead of throwing, and an entry missing the one field a routing
 * decision cannot proceed without (its provider `tag`, which is what OpenRouter's
 * `only`/`order`/`ignore` take) is skipped rather than guessed at. A body that
 * is not the documented envelope raises a classified {@link LlmError} — never a
 * `TypeError` out of a property access on `null`.
 *
 * @module dsh-llm-pi-ai/openrouter-endpoints
 */

import { LlmError, attributionHeaders } from '@deepseek-ai/dsh-llm'

/**
 * OpenRouter REST API root. Overridable because the endpoint may be reached
 * through a deployment gateway; the path `/models/{author}/{slug}/endpoints`
 * is appended to whatever is configured.
 */
export const OPENROUTER_DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1'

/**
 * Default request timeout. A design choice rather than a measurement: this list
 * is read on the path that decides which upstream serves a request, so a slow
 * round trip must not hold that request longer than the caller's own budget,
 * while a healthy edge answers in well under a second.
 */
export const OPENROUTER_ENDPOINTS_TIMEOUT_MS = 10_000

/**
 * Ceiling on a reply body. The endpoint list is small (sixteen entries for a
 * model with sixteen upstreams), so this is a runaway guard rather than a
 * working bound, and an endpoint list that outgrows it is refused instead of
 * truncated: half a provider list cannot rank providers.
 */
export const OPENROUTER_ENDPOINTS_MAX_BYTES = 2 * 1024 * 1024

/** Stable machine code for a model id that is not `{author}/{slug}`. */
export const INVALID_MODEL_ID_CODE = 'OPENROUTER_MODEL_ID_INVALID'

/** Stable machine code for a reply that is not a parseable endpoint listing. */
export const MALFORMED_ENDPOINTS_CODE = 'OPENROUTER_ENDPOINTS_MALFORMED'

/** Stable machine code for a non-2xx answer from the endpoints URL. */
export const ENDPOINTS_HTTP_ERROR_CODE = 'OPENROUTER_ENDPOINTS_HTTP'

/** Stable machine code for an endpoint URL this process could not reach. */
export const ENDPOINTS_UNREACHABLE_CODE = 'OPENROUTER_ENDPOINTS_UNREACHABLE'

/**
 * One upstream provider's terms for serving a model. Prices are USD per token;
 * uptime is a percentage; latency is seconds; throughput is tokens per second.
 */
export interface OpenRouterEndpoint {
  /**
   * OpenRouter's own slug for this route — `tag`, such as `deepinfra/fp8` or
   * `digitalocean`. This is the spelling the `only`, `order`, and `ignore`
   * routing keys take, and the only one this package can assert: a display name
   * (`provider_name`, such as `GMICloud`) lowercases to `gmicloud`, while the
   * same provider's tag is `gmicloud/fp8`, so deriving a slug from a name would
   * emit routing keys OpenRouter does not recognize.
   */
  slug: string
  /** Human-readable provider name as OpenRouter spells it; absent on some entries. */
  providerName?: string
  /** Quantization label (`fp8`, `fp4`, `unknown`) when the provider declares one. */
  quantization?: string
  /** Context this endpoint accepts, in tokens. */
  contextLength?: number
  /** Output cap this endpoint accepts, in tokens. */
  maxCompletionTokens?: number
  /** OpenRouter's provider status code; `0` is the healthy state. */
  status?: number
  /** USD charged per input token. */
  promptPrice?: number
  /** USD charged per output token. */
  completionPrice?: number
  /** USD charged per cached input token, when the provider publishes one. */
  inputCacheReadPrice?: number
  /** Fraction OpenRouter itself marks off this provider's list price, when published. */
  discount?: number
  /** Measured uptime over the last 30 minutes, as a percentage. */
  uptimeLast30m?: number
  /** Measured uptime over the last 5 minutes, as a percentage. */
  uptimeLast5m?: number
  /** Measured uptime over the last day, as a percentage. */
  uptimeLast1d?: number
  /** Measured latency over the last 30 minutes, in seconds. */
  latencyLast30m?: number
  /** Measured throughput over the last 30 minutes, in tokens per second. */
  throughputLast30m?: number
  /** Request parameters this endpoint accepts, such as `tools` or `reasoning_effort`. */
  supportedParameters?: readonly string[]
}

/** Everything one endpoints request may configure. */
export interface OpenRouterEndpointRequest {
  /** API root the endpoint path is appended to; defaults to {@link OPENROUTER_DEFAULT_BASE_URL}. */
  baseURL?: string
  /** Request timeout in milliseconds; defaults to {@link OPENROUTER_ENDPOINTS_TIMEOUT_MS}. */
  timeoutMs?: number
  /** Caller cancellation; reported as `ABORTED` rather than a timeout. */
  signal?: AbortSignal
  /**
   * Credential for the listing. Optional and empty by default: OpenRouter
   * serves `GET /models` and this per-model list without one, and a routing
   * decision must not require a credential the deployment may not hold.
   */
  apiKey?: string
  /** Deployment-owned request headers, such as a proxy's. Attribution names win collisions. */
  headers?: Readonly<Record<string, string>>
}

/** The shape of the documented `{ author, slug }` model identity. */
interface OpenRouterModelId {
  author: string
  slug: string
}

/**
 * Split a model id into the two path segments OpenRouter publishes endpoints
 * under. Refused before any request goes out, because a request built from a
 * model id that is not `author/slug` would answer 404 for a reason that has
 * nothing to do with the endpoint, and every model id a profile may configure is
 * a plain string.
 * @param model - the configured model id, such as `deepseek/deepseek-v4-pro`.
 * @returns the two path segments.
 * @throws LlmError `OPENROUTER_MODEL_ID_INVALID` for anything else.
 */
function splitModelId(model: string): OpenRouterModelId {
  const parts = model.split('/')
  const [author, slug, ...rest] = parts
  if (rest.length > 0 || author === undefined || slug === undefined || author.length === 0 || slug.length === 0) {
    throw new LlmError(
      'llm-pi-ai: OpenRouter publishes endpoints per an author/slug model id, but this one is'
      + ` ${JSON.stringify(model)}`,
      INVALID_MODEL_ID_CODE,
    )
  }
  return { author, slug }
}

/**
 * Read a finite number the upstream may send as a number or as a decimal
 * string. OpenRouter sends every price as a string, and sends `null` for a
 * measurement it does not have; both narrow here rather than throwing.
 *
 * Sign is left to the field: `pricing.discount` is a fraction and legitimately
 * negative on a provider charging above its own list price, so a blanket
 * non-negative rule would discard a real measurement.
 * @param value - one raw field.
 * @returns the number, or `undefined` when absent, null, non-numeric, or infinite.
 */
function finite(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string') return undefined
  // Trimmed and rejected when empty so `''` never reads as zero.
  const text = value.trim()
  if (text.length === 0) return undefined
  const parsed = Number(text)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Read a trimmed non-empty string field.
 * @param value - one raw field.
 * @returns the text, or `undefined` when absent or blank.
 */
function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/**
 * Read a list of strings, dropping entries the upstream sent as something else.
 * @param value - one raw field.
 * @returns the entries, or `undefined` when the field is not an array.
 */
function stringList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.flatMap((entry) => {
    const named = text(entry)
    return named === undefined ? [] : [named]
  })
}

/** One raw entry's nested `pricing` object, as the reply may leave it. */
interface RawPricing {
  prompt?: unknown
  completion?: unknown
  input_cache_read?: unknown
  discount?: unknown
}

/** One raw entry of the reply's `endpoints` array. */
interface RawEndpoint {
  tag?: unknown
  provider_name?: unknown
  quantization?: unknown
  context_length?: unknown
  max_completion_tokens?: unknown
  status?: unknown
  pricing?: unknown
  uptime_last_30m?: unknown
  uptime_last_5m?: unknown
  uptime_last_1d?: unknown
  latency_last_30m?: unknown
  throughput_last_30m?: unknown
  supported_parameters?: unknown
}

/**
 * Map one raw endpoint entry, or `undefined` when it cannot be routed to.
 *
 * Only the `tag` is mandatory, and only because it is the routing key: an
 * entry without one cannot appear in an `only` or `order` list, so keeping it
 * would produce a candidate set that cannot be sent. Every other field narrows
 * to `undefined`, which downstream treats as "this provider did not measure
 * it" — not as a zero. Each field is read once and dropped when absent, so a
 * mapped endpoint carries a key only where the upstream published a value.
 * @param raw - one entry of the reply's `endpoints` array.
 * @returns the mapped endpoint, or `undefined` when it names no routable provider.
 */
function readEndpoint(raw: unknown): OpenRouterEndpoint | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const entry = raw as RawEndpoint
  const slug = text(entry.tag)
  if (slug === undefined) return undefined
  const pricing: RawPricing = entry.pricing !== null
    && typeof entry.pricing === 'object'
    && !Array.isArray(entry.pricing)
    ? entry.pricing
    : {}
  const providerName = text(entry.provider_name)
  const quantization = text(entry.quantization)
  const contextLength = finite(entry.context_length)
  const maxCompletionTokens = finite(entry.max_completion_tokens)
  const status = finite(entry.status)
  const promptPrice = finite(pricing.prompt)
  const completionPrice = finite(pricing.completion)
  const inputCacheReadPrice = finite(pricing.input_cache_read)
  const discount = finite(pricing.discount)
  const uptimeLast30m = finite(entry.uptime_last_30m)
  const uptimeLast5m = finite(entry.uptime_last_5m)
  const uptimeLast1d = finite(entry.uptime_last_1d)
  const latencyLast30m = finite(entry.latency_last_30m)
  const throughputLast30m = finite(entry.throughput_last_30m)
  const supportedParameters = stringList(entry.supported_parameters)
  return {
    slug,
    ...providerName === undefined ? {} : { providerName },
    ...quantization === undefined ? {} : { quantization },
    ...contextLength === undefined ? {} : { contextLength },
    ...maxCompletionTokens === undefined ? {} : { maxCompletionTokens },
    ...status === undefined ? {} : { status },
    ...promptPrice === undefined ? {} : { promptPrice },
    ...completionPrice === undefined ? {} : { completionPrice },
    ...inputCacheReadPrice === undefined ? {} : { inputCacheReadPrice },
    ...discount === undefined ? {} : { discount },
    ...uptimeLast30m === undefined ? {} : { uptimeLast30m },
    ...uptimeLast5m === undefined ? {} : { uptimeLast5m },
    ...uptimeLast1d === undefined ? {} : { uptimeLast1d },
    ...latencyLast30m === undefined ? {} : { latencyLast30m },
    ...throughputLast30m === undefined ? {} : { throughputLast30m },
    ...supportedParameters === undefined ? {} : { supportedParameters },
  }
}

/**
 * Read a reply body into its endpoint list.
 *
 * The documented envelope is `{ data: { endpoints: [...] } }`. A body that is
 * not shaped that way is refused with one coded failure rather than read as an
 * empty list: an empty list would look like "this model has no upstreams" and
 * quietly drop every provider constraint, which is the exact failure mode a
 * routing decision must not have.
 * @param body - the parsed reply body.
 * @param model - the model the reply answers for, named in the diagnostic.
 * @returns the endpoints the reply names, in the order it listed them.
 * @throws LlmError `OPENROUTER_ENDPOINTS_MALFORMED` for any other shape.
 */
export function parseOpenRouterEndpoints(body: unknown, model: string): readonly OpenRouterEndpoint[] {
  const malformed = (detail: string): LlmError =>
    new LlmError(`llm-pi-ai: ${detail} in the endpoint listing for "${model}"`, MALFORMED_ENDPOINTS_CODE)
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw malformed('expected a JSON object')
  }
  const data: unknown = (body as { data?: unknown }).data
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw malformed('expected a "data" object')
  }
  const endpoints: unknown = (data as { endpoints?: unknown }).endpoints
  if (!Array.isArray(endpoints)) {
    throw malformed('expected a "data.endpoints" array')
  }
  return endpoints.flatMap((raw) => {
    const endpoint = readEndpoint(raw)
    return endpoint === undefined ? [] : [endpoint]
  })
}

/**
 * Build the endpoint URL for one model, percent-encoding both path segments so
 * a segment containing a separator cannot reshape the path.
 * @param baseURL - configured API root, trailing slashes ignored.
 * @param id - the split model identity.
 * @returns the absolute listing URL.
 */
function endpointsUrl(baseURL: string, id: OpenRouterModelId): string {
  const base = baseURL.replace(/\/+$/, '')
  return `${base}/models/${encodeURIComponent(id.author)}/${encodeURIComponent(id.slug)}/endpoints`
}

/**
 * Read one reply body, refusing one that outgrows the ceiling.
 *
 * A declared length is checked first, so an honest server is turned away before
 * anything is transferred. What is actually enforced afterwards is the byte
 * count of what arrived: a server that under-declares or streams tells us
 * nothing up front, and the only reading available then is the one taken after
 * the transfer. Unlike `discovery.ts` — which interrogates whatever URL a user
 * typed and must therefore cap the bytes it will pull — this reads OpenRouter's
 * own API path, so the residual gap is a misbehaving upstream rather than a
 * caller-supplied one, and it is documented rather than papered over with an
 * untestable mid-stream cancel.
 * @param response - the 2xx response.
 * @param url - the URL read, named in the diagnostic.
 * @returns the decoded body text.
 * @throws LlmError when the body exceeds {@link OPENROUTER_ENDPOINTS_MAX_BYTES}.
 */
async function readBounded(response: Response, url: string): Promise<string> {
  const oversized = (): LlmError => new LlmError(
    `llm-pi-ai: ${url} answered with more than ${OPENROUTER_ENDPOINTS_MAX_BYTES} bytes`,
    MALFORMED_ENDPOINTS_CODE,
  )
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > OPENROUTER_ENDPOINTS_MAX_BYTES) {
    await response.body?.cancel()
    throw oversized()
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > OPENROUTER_ENDPOINTS_MAX_BYTES) throw oversized()
  return new TextDecoder().decode(bytes)
}

/**
 * Fetch one model's upstream provider list.
 *
 * The caller is expected to have already decided that a routing decision needs
 * it: this function always reaches the network when it is called, which is why
 * nothing in this package calls it on its own.
 * @param model - the `{author}/{slug}` model id.
 * @param request - transport, timeout, credential, and deployment headers.
 * @returns the endpoints the reply names.
 * @throws LlmError with a stable code for an unusable model id, an unreachable
 *   endpoint, a non-2xx answer, an over-large body, a non-JSON body, or an
 *   envelope this package cannot read.
 */
export async function fetchOpenRouterEndpoints(
  model: string,
  request: OpenRouterEndpointRequest = {},
): Promise<readonly OpenRouterEndpoint[]> {
  const id = splitModelId(model)
  const timeoutMs = request.timeoutMs ?? OPENROUTER_ENDPOINTS_TIMEOUT_MS
  const url = endpointsUrl(request.baseURL ?? OPENROUTER_DEFAULT_BASE_URL, id)
  const timeout = AbortSignal.timeout(timeoutMs)
  const deadline = request.signal === undefined ? timeout : AbortSignal.any([request.signal, timeout])
  let response: Response
  try {
    const headers = new Headers(request.headers === undefined ? undefined : Object.entries(request.headers))
    headers.set('accept', 'application/json')
    if (request.apiKey !== undefined && request.apiKey.length > 0) {
      headers.set('authorization', `Bearer ${request.apiKey}`)
    }
    for (const [name, value] of Object.entries(attributionHeaders())) headers.set(name, value)
    response = await fetch(url, { method: 'GET', redirect: 'error', headers, signal: deadline })
  } catch (error: unknown) {
    throw transportError(error, request.signal, deadline, timeoutMs, url)
  }
  if (!response.ok) {
    await response.body?.cancel()
    throw new LlmError(
      `${url} answered ${String(response.status)}${response.status === 401 || response.status === 403
        ? '; OpenRouter refused the credential this listing used'
        : ''}`,
      ENDPOINTS_HTTP_ERROR_CODE,
    )
  }
  let text_: string
  try {
    text_ = await readBounded(response, url)
  } catch (error: unknown) {
    if (request.signal?.aborted) {
      throw new LlmError('OpenRouter endpoint listing aborted by caller', 'ABORTED', { cause: error })
    }
    throw error
  }
  let body: unknown
  try {
    body = JSON.parse(text_)
  } catch (error: unknown) {
    throw new LlmError(`${url} did not answer with JSON`, MALFORMED_ENDPOINTS_CODE, { cause: error })
  }
  return parseOpenRouterEndpoints(body, model)
}

/**
 * Classify one failed request. The caller's own cancellation wins over the
 * deadline, so a read the session stopped is `ABORTED` even if a transport
 * timeout surfaced; a deadline that fired is this package's timeout; anything
 * else is an endpoint this process could not reach.
 * @param error - the caught failure.
 * @param signal - the caller's cancellation signal, when one was supplied.
 * @param deadline - the combined caller-and-timeout signal.
 * @param timeoutMs - the configured request timeout.
 * @param url - the URL read, named in the diagnostic.
 * @returns the classified failure.
 */
function transportError(
  error: unknown,
  signal: AbortSignal | undefined,
  deadline: AbortSignal,
  timeoutMs: number,
  url: string,
): LlmError {
  if (signal?.aborted === true) {
    return new LlmError('OpenRouter endpoint listing aborted by caller', 'ABORTED', { cause: error })
  }
  if (deadline.aborted) {
    return new LlmError(`OpenRouter endpoint listing timed out after ${String(timeoutMs)}ms`, 'TIMEOUT', { cause: error })
  }
  return new LlmError(`could not reach ${url}`, ENDPOINTS_UNREACHABLE_CODE, { cause: error })
}
