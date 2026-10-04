/**
 * `TavilySearchProvider`: a `WebSearchProvider` backed by Tavily's search API
 * (`POST https://api.tavily.com/search`, `Authorization: Bearer <key>`). Unlike
 * the siblings whose `baseURL` is a host root, Tavily's endpoint is configured in
 * full — path included — so nothing is appended here.
 *
 * Tavily returns each result's extracted page text in `content`. That text is
 * written for a reader, not for a context window, so it is bounded per result
 * before it reaches {@link WebSearchSource.snippet}. Tavily's relevance `score`
 * has no field on the seam and is deliberately not mapped, and `results[]` is
 * taken in the order Tavily returned it.
 * @module @deepseek-ai/dsh-web-search-tavily/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import type { TavilyError, TavilyResult, TavilySearchRequest, TavilySearchResponse } from './types.ts'

/** Stable id this provider registers under. */
export const TAVILY_PROVIDER_ID = 'tavily'

/**
 * Settings namespace this provider's section is served under, named here too so
 * the missing-credential and rejected-key diagnostics cannot drift from it.
 */
export const TAVILY_SETTINGS_NAMESPACE = 'web-search-tavily'

/**
 * Default search endpoint, PATH INCLUDED: Tavily's endpoint is one absolute URL
 * rather than a host root plus an operation, and no path is appended to a
 * configured override.
 */
export const TAVILY_DEFAULT_ENDPOINT = 'https://api.tavily.com/search'

/**
 * Default result count requested from Tavily. It is this package's choice, not a
 * value read off the endpoint: a bound small enough to stay cheap and large
 * enough to be useful. The endpoint's own ceiling for `max_results` is a
 * documented constraint this package has not observed, so an over-large request
 * bound is sent as-is and answered with Tavily's own validation error rather
 * than being silently clamped (a clamp would make `truncated: false` a lie).
 */
export const TAVILY_DEFAULT_MAX_RESULTS = 5

/**
 * Default request timeout. A design choice rather than a measurement: generous
 * enough that a slow Tavily round trip is not mistaken for a failure, short
 * enough that a stuck search does not occupy the session indefinitely.
 */
export const TAVILY_DEFAULT_TIMEOUT_MS = 15_000

/**
 * Default character cap on one result's mapped snippet. Tavily's `content` is an
 * extract of a whole page, and one verbose page would otherwise dominate a model
 * context that is carrying the rest of the results too.
 */
export const TAVILY_DEFAULT_MAX_CONTENT_CHARS = 2_000

/** Attribution header sent on every request. Bump with the package version. */
const USER_AGENT = 'deepseek-harness/0.0.1'

/** Appended to a snippet the character bound cut, so a cut is never read as a complete one. */
const ELLIPSIS = '…'

/** Resolved provider options (the plugin's `apply` supplies credential and constant defaults). */
export interface TavilySearchProviderOptions {
  /** Literal Tavily API key; when present it wins over {@link resolveApiKey}. */
  apiKey?: string
  /** Resolve the current Tavily API key for one search operation. */
  resolveApiKey?: () => Promise<string | undefined>
  /**
   * Credential reference named by missing-credential diagnostics. Carried as the
   * configured NAME rather than a branded reference so a settings typo reports
   * itself instead of throwing while the plugin stays mounted.
   */
  credentialName: string
  /** Full search endpoint, path included; nothing is appended to it. */
  endpoint: string
  /** Result count sent when the request carries no `maxResults` of its own. */
  maxResults: number
  /** Request timeout, applied to credential resolution, dispatch, and body read alike. */
  timeoutMs: number
  /** Character cap on one result's mapped snippet. */
  maxContentChars: number
  /**
   * Whether the launch environment supplies a value for the configured
   * reference. Read fresh on every check, so this half of "a key can resolve" is
   * never stale.
   */
  ambientKeyPresent: boolean
  /**
   * Whether a key can ACTUALLY resolve right now through the credentials
   * service, maintained by the plugin from a resolution that actually
   * completed. It is a fact about a credential, not about the existence of a
   * resolver: a provider that reports available without a key sends searches
   * that can only fail.
   */
  credentialPresent: boolean
  /**
   * The configured reference {@link credentialPresent} answers for. An answer
   * about a reference the section has since stopped naming must not be inherited.
   */
  credentialAnswerName: string | undefined
}

/**
 * Trim one optional provider text field, or `undefined` when it carries nothing.
 *
 * @param value - a field Tavily may omit, null, or send blank.
 * @returns the trimmed text, or `undefined` when there is nothing to show.
 */
function optionalText(value: string | null | undefined): string | undefined {
  if (value === undefined || value === null) return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * Bound one result's extracted page text to the configured character cap.
 *
 * The cut lands on a word boundary and ends with an ellipsis, so a bounded
 * snippet reads as a fragment rather than as text that simply stops. One
 * character is reserved for that ellipsis, which is why the result is never
 * longer than `maxChars`.
 *
 * @param text - Tavily's `content` field, which may be absent, null, or long.
 * @param maxChars - the character cap for this snippet.
 * @returns the bounded snippet, or `undefined` when there is no text to bound.
 */
export function boundContent(text: string | null | undefined, maxChars: number): string | undefined {
  const trimmed = optionalText(text)
  if (trimmed === undefined || trimmed.length <= maxChars) return trimmed
  const head = trimmed.slice(0, Math.max(0, maxChars - 1))
  const boundary = head.lastIndexOf(' ')
  const cut = boundary > 0 ? head.slice(0, boundary) : head
  return `${cut.trimEnd()}${ELLIPSIS}`
}

/**
 * Map one Tavily result to a normalized source, or `undefined` when it carries
 * no citeable URL. Titles and snippets are optional on this seam by design, so a
 * result with neither still yields a source.
 *
 * @param result - one entry of Tavily's `results[]`.
 * @param maxChars - the character cap for the mapped snippet.
 * @returns the normalized source, or `undefined` for an unusable target.
 */
export function mapTavilyResult(result: TavilyResult, maxChars: number): WebSearchSource | undefined {
  const url = optionalText(result.url)
  if (url === undefined) return undefined
  const title = optionalText(result.title)
  const snippet = boundContent(result.content, maxChars)
  return {
    url,
    ...title !== undefined ? { title } : {},
    ...snippet !== undefined ? { snippet } : {},
  }
}

/**
 * Map a Tavily response envelope to a normalized search result. Results are
 * taken in Tavily's own order, repeated URLs are dropped, and Tavily's optional
 * `answer` becomes the result's `content` when it carries text. An absent or
 * empty `results` is a legitimate empty result set, not a failure.
 *
 * @param response - the parsed `POST /search` response body.
 * @param maxChars - the character cap for each mapped snippet.
 * @returns the normalized result; the service applies the final `maxResults` bound.
 */
export function mapTavilyResponse(response: TavilySearchResponse, maxChars: number): WebSearchResult {
  const sources: WebSearchSource[] = []
  const seen = new Set<string>()
  // A non-array `results` is a shape this provider has never seen; an empty
  // result set is the honest reading of it, and the seam's errors are reserved
  // for transport and non-2xx outcomes.
  for (const result of Array.isArray(response.results) ? response.results : []) {
    const source = mapTavilyResult(result, maxChars)
    if (source === undefined || seen.has(source.url)) continue
    seen.add(source.url)
    sources.push(source)
  }
  const answer = optionalText(response.answer)
  return {
    ...answer !== undefined ? { content: answer } : {},
    sources,
    truncated: false,
  }
}

/**
 * Read Tavily's own error message out of a parsed error body.
 *
 * The observed HTTP 401 carries it at `detail.error`; a validation failure may
 * carry `detail` as a bare string, and other deployments use a top-level `error`
 * or `message`. All four are read, in that order, and the first non-blank one
 * wins — reading only a top-level `error`, the way a sibling shaped for a
 * different vendor does, would print `undefined` on this endpoint.
 *
 * @param error - the parsed error body.
 * @returns the message to show, or `undefined` when the body carries none.
 */
export function tavilyErrorDetail(error: TavilyError): string | undefined {
  const { detail } = error
  const fromDetail = typeof detail === 'string' ? optionalText(detail) : optionalText(detail?.error)
  return fromDetail ?? optionalText(error.error) ?? optionalText(error.message)
}

/**
 * The Tavily-backed search provider. HTTP redirects fail as `WEB_PROVIDER_ERROR`;
 * a rejected key names the credential the user must fix rather than the endpoint.
 */
export class TavilySearchProvider implements WebSearchProvider {
  readonly id = TAVILY_PROVIDER_ID

  /**
   * @param resolveOptions - the options for the NEXT operation, snapshotted once
   * at each operation's entry so one search never mixes two sections. A thunk
   * rather than a value because the plugin's settings section can change between
   * searches, and re-registering the provider to carry a new endpoint would make
   * the seam's selection observable to the user as a flicker.
   */
  constructor(private readonly resolveOptions: () => TavilySearchProviderOptions) {}

  available(): boolean {
    const options = this.resolveOptions()
    // A literal key needs no resolution and is read fresh from the current
    // section; the resolved answer counts only for the reference it described,
    // so switching `apiKeyEnv` in settings cannot inherit the previous answer.
    const credentialReady = (options.apiKey?.length ?? 0) > 0
      || options.ambientKeyPresent
      || (options.credentialPresent && options.credentialAnswerName === options.credentialName)
    return credentialReady
      && URL.canParse(options.endpoint)
      && isPositiveInteger(options.maxResults)
      && isPositiveInteger(options.timeoutMs)
      && isPositiveInteger(options.maxContentChars)
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    // One snapshot for the whole operation: credential resolution awaits, and a
    // settings write landing inside that await must not send the key resolved
    // from the old section to the endpoint named by the new one.
    const options = this.resolveOptions()
    const timeout = AbortSignal.timeout(options.timeoutMs)
    const deadline = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    let apiKey: string
    try {
      apiKey = await this.apiKey(options, deadline)
    } catch (error: unknown) {
      throw cancellationOf(error, deadline, signal, options.timeoutMs) ?? error
    }

    // A per-request bound wins over the configured default and is sent to Tavily
    // as a cost and latency optimization; the seam enforces the final bound.
    const maxResults = request.maxResults ?? options.maxResults
    const body: TavilySearchRequest = { query: request.query, max_results: maxResults }
    let response: Response
    try {
      response = await fetch(options.endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'authorization': `Bearer ${apiKey}`,
          'content-type': 'application/json',
          'accept': 'application/json',
          'user-agent': USER_AGENT,
        },
        body: JSON.stringify(body),
        signal: deadline,
      })
    } catch (error: unknown) {
      throw cancellationOf(error, deadline, signal, options.timeoutMs)
        ?? new WebError(`Tavily search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    if (!response.ok) {
      const status = response.status
      let message = `Tavily API error (HTTP ${status})`
      try {
        const detail = tavilyErrorDetail(await response.json() as TavilyError)
        if (detail !== undefined) message += `: ${detail}`
      } catch (error: unknown) {
        const aborted = cancellationOf(error, deadline, signal, options.timeoutMs)
        if (aborted !== undefined) throw aborted
        // Otherwise: the HTTP status is already captured in `message` above; a
        // malformed/non-JSON error body (normal for gateway 5xx/429s) can only
        // cost a richer provider message, never the real error.
      }
      // A rejected key is a credential problem, and telling the model to change
      // the endpoint would send the user somewhere the fix is not. Observed
      // 2026-10-03 from this network: a request with NO Authorization header is
      // answered by the application with 401 and its JSON envelope, while any
      // bearer token the API does not recognize — including one of the correct
      // shape — is refused by the `awselb` edge with 403 and an HTML page,
      // before the application sees it. So a rejected key arrives as 403 just as
      // often as 401, and the credential guidance has to cover both.
      if (status === 401 || status === 403) throw rejectedKeyError(message, options.credentialName, status === 403)
      throw new WebError(message, 'WEB_PROVIDER_ERROR')
    }

    try {
      return mapTavilyResponse(await response.json() as TavilySearchResponse, options.maxContentChars)
    } catch (error: unknown) {
      throw cancellationOf(error, deadline, signal, options.timeoutMs)
        ?? new WebError(`Tavily returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }

  /**
   * Resolve one operation's API key without retaining it on the provider. Every
   * failure it raises is already classified: a `WebError` for the credential
   * problems, the deadline's own abort reason for a cancellation.
   *
   * @param options - the caller's snapshot, so the key and the endpoint it is sent to come from one section.
   * @param deadline - the search's own deadline, so a hung credential backend cannot hang the search.
   * @returns the resolved key.
   * @throws {@link WebError} `WEB_PROVIDER_CREDENTIAL_MISSING` when nothing resolves one.
   */
  private async apiKey(options: TavilySearchProviderOptions, deadline: AbortSignal): Promise<string> {
    if (options.apiKey !== undefined && options.apiKey.length > 0) return options.apiKey
    const { resolveApiKey } = options
    if (resolveApiKey !== undefined) {
      const resolved = await this.resolveKey(resolveApiKey, deadline)
      if (resolved !== undefined && resolved.length > 0) return resolved
    }
    throw new WebError(
      `Tavily search has no API key for "${options.credentialName}"; store it through the credentials service`
      + ' (the web Models page writes it), export it in the launching environment, or set a literal'
      + ` "apiKey" in the ${TAVILY_SETTINGS_NAMESPACE} config`,
      'WEB_PROVIDER_CREDENTIAL_MISSING',
    )
  }

  /**
   * Run one credential resolver under the search's own deadline, so a hung
   * credential backend cannot hang the search. An already-cancelled search never
   * starts the resolver at all.
   *
   * @param resolveApiKey - the resolver for one search's key.
   * @param deadline - the search's combined caller-and-timeout signal.
   * @returns the resolved key, or `undefined` when the resolver supplied none.
   * @throws the deadline's own abort reason on cancellation; {@link WebError}
   *   `WEB_PROVIDER_ERROR` when the resolver itself fails.
   */
  private async resolveKey(
    resolveApiKey: () => Promise<string | undefined>, deadline: AbortSignal,
  ): Promise<string | undefined> {
    if (aborted(deadline)) throw deadline.reason
    try {
      return await abortable(resolveApiKey(), deadline)
    } catch (error: unknown) {
      // Re-read rather than reuse the check above: the deadline can fire inside
      // the await. A cancellation keeps its own identity so the caller reports it
      // as one; only a genuine resolver failure is this provider's error.
      if (aborted(deadline)) throw error
      throw new WebError(
        `Tavily search credential resolution failed: ${String(error)}`,
        'WEB_PROVIDER_ERROR',
        { cause: error },
      )
    }
  }
}

/**
 * Replace status guidance with credential guidance when Tavily rejects the key.
 *
 * @param message - the status line plus whatever message the error body carried.
 * @param credentialName - the reference the user must fix.
 * @param edge - whether the edge answered instead of Tavily's API, which is how
 *   an unrecognized key arrives when the token reaches the load balancer.
 * @returns the `WEB_PROVIDER_ERROR` describing the rejected credential.
 */
function rejectedKeyError(message: string, credentialName: string, edge = false): WebError {
  return new WebError(
    `${message}\n\nTavily rejected the API key this web search used. Guide the user to store a working key`
    + ` for "${credentialName}" through the credentials service (Settings > Web search writes it), or to`
    + ` set a literal "apiKey" in the ${TAVILY_SETTINGS_NAMESPACE} config. The endpoint does not need changing.`
    + (edge
      ? ' This was the load balancer rather than the API: it refuses a key it does not recognize'
      + ' before Tavily answers, so check that the stored value really is the API key and not a'
      + ' one-time setup token, and that the request was not blocked on the way in.'
      : ''),
    'WEB_PROVIDER_ERROR',
  )
}

/**
 * Classify one failure as a cancellation, or return `undefined` when it is not
 * one. The caller's own signal wins over the deadline: a search the caller
 * stopped is `WEB_ABORTED` even if what surfaced was an unrelated throw. A
 * deadline that fired — or a transport timeout, which is how `fetch` reports
 * the same thing — is this provider's own timeout. An abort nobody asked for is
 * left to the phase's own failure, because claiming a timeout that did not
 * happen would be the worse lie.
 *
 * @param error - the caught failure.
 * @param deadline - the search's combined caller-and-timeout signal.
 * @param signal - the caller's cancellation signal, when one was supplied.
 * @param timeoutMs - the configured request timeout.
 * @returns the cancellation `WebError`, or `undefined` for an ordinary failure.
 */
function cancellationOf(
  error: unknown, deadline: AbortSignal, signal: AbortSignal | undefined, timeoutMs: number,
): WebError | undefined {
  if (signal?.aborted === true) {
    return new WebError('Tavily search aborted', 'WEB_ABORTED', { cause: signal.reason })
  }
  if (deadline.aborted || isTimeoutError(error)) {
    return new WebError(`Tavily search timed out after ${String(timeoutMs)}ms`, 'WEB_PROVIDER_ERROR', { cause: error })
  }
  return undefined
}

/**
 * Race one asynchronous step against the search's deadline. The attached
 * settlement handlers keep observing an uncooperative operation after abort so a
 * later rejection cannot become unhandled.
 *
 * @param operation - the promise to observe.
 * @param deadline - the search's combined caller-and-timeout signal.
 * @returns the operation's value.
 * @throws the deadline's own abort reason when it fires first.
 */
async function abortable<T>(operation: Promise<T>, deadline: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    // The reason rides as the cause: what the caller acts on is which signal
    // fired, not the shape of whatever the caller aborted with.
    const onAbort = (): void => { reject(new Error('Tavily search deadline fired', { cause: deadline.reason })) }
    deadline.addEventListener('abort', onAbort, { once: true })
    void operation.then(
      (value) => {
        deadline.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        deadline.removeEventListener('abort', onAbort)
        reject(new Error(String(error).replace(/^Error: /u, ''), { cause: error }))
      },
    )
  })
}

/** True for the timeout abort `AbortSignal.timeout` and `fetch` report. */
function isTimeoutError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'TimeoutError'
}

/**
 * Whether a signal has already fired. Read through a call rather than as a
 * property so a check never stands in for the decision made later in the flow.
 *
 * @param signal - the signal to read.
 * @returns whether it is aborted.
 */
function aborted(signal: AbortSignal): boolean {
  return signal.aborted
}

/** True for a limit this provider can enforce (a positive whole number). */
function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0
}
