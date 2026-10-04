/**
 * The one request path every read-only OpenRouter listing in this package takes:
 * `GET` with attribution, a deadline, a byte ceiling, and a classified failure.
 *
 * The three listings this package reads — per-model endpoints, the model catalog,
 * and the account's key info — differ in what they parse and in the machine code
 * each failure carries, and agree on everything else. Sharing that agreement here
 * is what keeps a timeout, a transport failure, and an over-large body reported
 * identically whichever listing hit it, instead of once per call site.
 *
 * @module dsh-llm-pi-ai/openrouter-http
 */

import { LlmError, attributionHeaders } from '@deepseek-ai/dsh-llm'

/** Transport, credential, and caller-cancellation choices for one listing read. */
export interface OpenRouterReadOptions {
  /** Caller cancellation; reported as `ABORTED` rather than a timeout. */
  signal?: AbortSignal
  /**
   * Credential for the listing. Optional and empty by default: OpenRouter serves
   * these listings without one, and a routing decision must not require a
   * credential the deployment may not hold.
   */
  apiKey?: string
  /** Deployment-owned request headers, such as a proxy's. Attribution names win collisions. */
  headers?: Readonly<Record<string, string>>
}

/** What one listing read bounds for itself. */
export interface OpenRouterReadLimits {
  /** Request timeout in milliseconds. */
  timeoutMs: number
  /** Ceiling on the reply body, in bytes. */
  maxBytes: number
}

/** The stable machine code one listing reports each failure under. */
export interface OpenRouterReadCodes {
  /** A non-2xx answer. */
  http: string
  /** A body this package cannot read as the documented envelope. */
  malformed: string
  /** An endpoint this process could not reach. */
  unreachable: string
}

/**
 * Read one listing body, refusing one that outgrows the ceiling.
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
 * @param limits - the byte ceiling to enforce.
 * @param codes - the code an over-large body is reported under.
 * @returns the decoded body text.
 * @throws LlmError when the body exceeds `limits.maxBytes`.
 */
async function readBounded(
  response: Response,
  url: string,
  limits: OpenRouterReadLimits,
  codes: OpenRouterReadCodes,
): Promise<string> {
  const oversized = (): LlmError => new LlmError(
    `llm-pi-ai: ${url} answered with more than ${String(limits.maxBytes)} bytes`,
    codes.malformed,
  )
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > limits.maxBytes) {
    await response.body?.cancel()
    throw oversized()
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > limits.maxBytes) throw oversized()
  return new TextDecoder().decode(bytes)
}

/**
 * Classify one failed request. The caller's own cancellation wins over the
 * deadline, so a read the session stopped is `ABORTED` even if a transport
 * timeout surfaced; a deadline that fired is this package's timeout; anything
 * else is an endpoint this process could not reach.
 * @param error - the caught failure.
 * @param signal - the caller's cancellation signal, when one was supplied.
 * @param deadline - the combined caller-and-timeout signal.
 * @param limits - the timeout that was in force, named in the diagnostic.
 * @param url - the URL read, named in the diagnostic.
 * @param codes - the codes to report the failure under.
 * @returns the classified failure.
 */
function transportError(
  error: unknown,
  signal: AbortSignal | undefined,
  deadline: AbortSignal,
  limits: OpenRouterReadLimits,
  url: string,
  codes: OpenRouterReadCodes,
): LlmError {
  if (signal?.aborted === true) {
    return new LlmError('OpenRouter listing aborted by caller', 'ABORTED', { cause: error })
  }
  if (deadline.aborted) {
    return new LlmError(
      `OpenRouter listing timed out after ${String(limits.timeoutMs)}ms`,
      'TIMEOUT',
      { cause: error },
    )
  }
  return new LlmError(`could not reach ${url}`, codes.unreachable, { cause: error })
}

/**
 * Fetch and decode one OpenRouter listing.
 *
 * The caller is expected to have already decided that a routing decision needs
 * it: this function always reaches the network when it is called, which is why
 * nothing in this package calls it on its own.
 * @param url - the absolute listing URL.
 * @param options - caller cancellation, credential, and deployment headers.
 * @param limits - the timeout and byte ceiling for this listing.
 * @param codes - the stable codes this listing reports failures under.
 * @returns the parsed JSON body, for the caller's own parser to read.
 * @throws LlmError with a stable code for an unreachable endpoint, a non-2xx
 *   answer, an over-large body, or a body that is not JSON.
 */
export async function readOpenRouterJson(
  url: string,
  options: OpenRouterReadOptions,
  limits: OpenRouterReadLimits,
  codes: OpenRouterReadCodes,
): Promise<unknown> {
  const timeout = AbortSignal.timeout(limits.timeoutMs)
  const deadline = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
  let response: Response
  try {
    const headers = new Headers(options.headers === undefined ? undefined : Object.entries(options.headers))
    headers.set('accept', 'application/json')
    if (options.apiKey !== undefined && options.apiKey.length > 0) {
      headers.set('authorization', `Bearer ${options.apiKey}`)
    }
    for (const [name, value] of Object.entries(attributionHeaders())) headers.set(name, value)
    response = await fetch(url, { method: 'GET', redirect: 'error', headers, signal: deadline })
  } catch (error: unknown) {
    throw transportError(error, options.signal, deadline, limits, url, codes)
  }
  if (!response.ok) {
    await response.body?.cancel()
    throw new LlmError(
      `${url} answered ${String(response.status)}${response.status === 401 || response.status === 403
        ? '; OpenRouter refused the credential this listing used'
        : ''}`,
      codes.http,
    )
  }
  let text_: string
  try {
    text_ = await readBounded(response, url, limits, codes)
  } catch (error: unknown) {
    if (options.signal?.aborted) {
      throw new LlmError('OpenRouter listing aborted by caller', 'ABORTED', { cause: error })
    }
    throw error
  }
  try {
    return JSON.parse(text_) as unknown
  } catch (error: unknown) {
    throw new LlmError(`${url} did not answer with JSON`, codes.malformed, { cause: error })
  }
}
