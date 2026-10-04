/**
 * `BraveSearchProvider`: a `WebSearchProvider` backed by Brave's Web Search API
 * (`GET {baseURL}/res/v1/web/search` with the query as `q` and the result bound
 * as `count`, authenticated by the `X-Subscription-Token` header). It maps
 * `description` to `snippet` and `page_age` to `publishedAt`, drops entries
 * without a URL, and omits `content` because Brave generates no answer.
 *
 * `available()` is evidence-based: it reports `true` only when a key is
 * actually observable — a literal `apiKey`, or a credential the plugin has
 * observed for the reference the current section names. It never reports a
 * provider usable merely because a resolver exists, which is the sharp edge the
 * DeepSeek sibling carries.
 * @module @deepseek-ai/dsh-web-search-brave/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { BraveErrorResponse, BraveSearchResponse, BraveWebResult } from './types.ts'

/** Stable id this provider registers under. */
export const BRAVE_PROVIDER_ID = 'brave'

/** Default Brave API origin; `/res/v1/web/search` is appended to it. */
export const BRAVE_DEFAULT_BASE_URL = 'https://api.search.brave.com'

/**
 * Default result count, matching the `web_search` tool's own source bound so a
 * direct seam call costs the same as a tool call. Brave's documented ceiling is
 * {@link BRAVE_MAX_COUNT}.
 */
export const BRAVE_DEFAULT_MAX_RESULTS = 8

/**
 * Brave's documented upper bound for the `count` control. A request asking for
 * more sources than Brave can return is clamped here rather than sent as an
 * out-of-range control that would fail the whole search.
 */
export const BRAVE_MAX_COUNT = 20

/** Default request timeout. One Brave web search answers in well under a second. */
export const BRAVE_DEFAULT_TIMEOUT_MS = 15_000

/** Brave's web-search operation path, appended to the configured base. */
const SEARCH_PATH = '/res/v1/web/search'

/** Attribution header sent on every request. Bump with the package version. */
const USER_AGENT = 'deepseek-harness/0.0.1'

/** Resolved provider options (the plugin's `apply` supplies credential and constant defaults). */
export interface BraveSearchProviderOptions {
  /** Literal Brave subscription token; when present it wins over {@link resolveApiKey}. */
  apiKey?: string
  /** Resolve the current subscription token for one search operation. */
  resolveApiKey: () => Promise<string | undefined>
  /** Credential reference this section addresses; named by missing-credential diagnostics. */
  apiKeyEnv: CredentialRef
  /** Endpoint base; `/res/v1/web/search` is appended. */
  baseURL: string
  /** Result count sent as Brave's `count` when a request carries no `maxResults`. */
  maxResults: number
  /** Request timeout in milliseconds, bounded by the provider's own deadline. */
  timeoutMs: number
}

/**
 * Map one Brave result to a normalized source, or `undefined` when it carries
 * no citeable URL. Unlike the Exa sibling, a missing `description` does not
 * drop the entry: a URL and a title are already citeable on this seam, and the
 * snippet is a genuine absence rather than a wrong value.
 *
 * @param result - one entry of `web.results[]`.
 * @returns the normalized source, or `undefined` when the entry has no URL.
 */
export function mapBraveResult(result: BraveWebResult): WebSearchSource | undefined {
  const url = result.url
  if (url == null || url.length === 0) return undefined
  return {
    url,
    ...result.title != null && result.title.length > 0 ? { title: result.title } : {},
    ...result.description != null && result.description.length > 0 ? { snippet: result.description } : {},
    ...result.page_age != null && result.page_age.length > 0 ? { publishedAt: result.page_age } : {},
  }
}

/**
 * Map a Brave response envelope to a normalized search result. Brave answers a
 * query with no matches as `web: { results: [] }`, and omits `web` entirely when
 * only other verticals answered; both resolve to an empty source set rather than
 * a failure. Repeated URLs are dropped (first wins). The web service owns the
 * final `maxResults` truncation, so `truncated` is always `false` here.
 *
 * @param response - the parsed search response body.
 * @returns the normalized result with deduplicated sources.
 */
export function mapBraveResponse(response: BraveSearchResponse): WebSearchResult {
  const results = Array.isArray(response.web?.results) ? response.web.results : []
  const sources: WebSearchSource[] = []
  const seen = new Set<string>()
  for (const result of results) {
    const source = mapBraveResult(result)
    if (source === undefined || seen.has(source.url)) continue
    seen.add(source.url)
    sources.push(source)
  }
  // Brave generates no answer, so `content` is omitted rather than fabricated.
  return { sources, truncated: false }
}

/**
 * Build the exact endpoint one search dispatches to, query parameters included.
 * The query is percent-encoded because it is user text on a URL; `count` is
 * clamped into Brave's documented 1..20 range so an out-of-range request bound
 * narrows the search instead of failing it.
 *
 * @param baseURL - the configured endpoint base.
 * @param query - the caller's search text.
 * @param count - the requested result bound.
 * @returns the absolute endpoint for this search.
 */
export function searchEndpoint(baseURL: string, query: string, count: number): string {
  const bounded = Math.min(Math.max(count, 1), BRAVE_MAX_COUNT)
  return `${baseURL}${SEARCH_PATH}?q=${encodeURIComponent(query)}&count=${String(bounded)}`
}

/**
 * Compose the provider message for one failed HTTP response. Brave answers an
 * invalid subscription token with HTTP 422 and a machine-readable `error.code`,
 * so the code is carried alongside the detail instead of the status being read
 * as an authorization verdict.
 *
 * @param status - the HTTP status of the response.
 * @param body - the parsed error envelope.
 * @returns the status line, plus Brave's detail and code when it sent them.
 */
export function apiErrorMessage(status: number, body: BraveErrorResponse): string {
  const envelope = body.error
  const detail = typeof envelope === 'string' ? envelope : envelope?.detail
  const code = typeof envelope === 'string' ? undefined : envelope?.code
  let message = `Brave Search API error (HTTP ${status})`
  if (detail != null && detail.length > 0) message += `: ${detail}`
  if (code != null && code.length > 0) message += ` [${code}]`
  return message
}

/**
 * The Brave-backed search provider. HTTP redirects fail as `WEB_PROVIDER_ERROR`;
 * failures after dispatch name the endpoint and tell the model that only the
 * user may change it.
 */
export class BraveSearchProvider implements WebSearchProvider {
  readonly id = BRAVE_PROVIDER_ID

  /** The reference the last credential observation described; absent when that observation named none. */
  private observedRef: CredentialRef | undefined

  /** Whether that observation found a value behind {@link observedRef}. */
  private observedConfigured = false

  /**
   * @param resolveOptions - the options for the NEXT operation, snapshotted once
   * at each operation's entry so one search never mixes two settings sections. A
   * thunk rather than a value because the plugin's settings section can change
   * between searches, and re-registering the provider to carry a new endpoint
   * would make the seam's selection observable to the user as a flicker.
   */
  constructor(private readonly resolveOptions: () => BraveSearchProviderOptions) {}

  /**
   * Record what the credential plane last reported for one reference. The
   * plugin calls this at load and whenever the credentials seam reports a change,
   * because `available()` is synchronous while the credential plane is not; an
   * observation is only evidence for the reference it describes, so renaming
   * `apiKeyEnv` discards the previous answer instead of inheriting it.
   *
   * @param ref - the reference the answer describes; absent for a section naming an invalid one.
   * @param configured - whether resolving that reference would return a value.
   */
  observeCredential(ref: CredentialRef | undefined, configured: boolean): void {
    this.observedRef = ref
    this.observedConfigured = configured
  }

  available(): boolean {
    const options = this.resolveOptions()
    return this.hasCredential(options)
      && URL.canParse(options.baseURL)
      && isPositiveInteger(options.maxResults)
      && isPositiveInteger(options.timeoutMs)
  }

  /**
   * Whether this configuration can authenticate a search right now. A literal
   * key is its own evidence; anything else needs an observation for the very
   * reference the current section names.
   *
   * @param options - the current section's options.
   * @returns true when a key is known to be resolvable.
   */
  private hasCredential(options: BraveSearchProviderOptions): boolean {
    if ((options.apiKey?.length ?? 0) > 0) return true
    return this.observedConfigured && this.observedRef === options.apiKeyEnv
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    // One snapshot for the whole operation: credential resolution awaits, and a
    // settings write landing inside that await must not send the key resolved
    // from the old section to the endpoint named by the new one.
    const options = this.resolveOptions()
    const apiKey = await this.resolveCredential(options)
    throwIfSearchAborted(signal)
    const endpoint = searchEndpoint(options.baseURL, request.query, request.maxResults ?? options.maxResults)
    let response: Response
    try {
      response = await fetch(endpoint, {
        method: 'GET',
        redirect: 'error',
        headers: {
          // Brave documents `X-Subscription-Token`; HTTP header names are
          // case-insensitive, so this spelling is what reaches the wire.
          'x-subscription-token': apiKey,
          'accept': 'application/json',
          'user-agent': USER_AGENT,
        },
        signal: deadlineSignal(signal, options.timeoutMs),
      })
    } catch (error: unknown) {
      throwIfCancelled(error, signal, options.timeoutMs)
      throw new WebError(
        endpointFailure(endpoint, `Brave search request failed: ${String(error)}`),
        'WEB_PROVIDER_ERROR',
        { cause: error },
      )
    }

    if (!response.ok) {
      throw await httpFailure(response, signal, endpoint, options.timeoutMs)
    }

    try {
      return mapBraveResponse(await response.json() as BraveSearchResponse)
    } catch (error: unknown) {
      throwIfCancelled(error, signal, options.timeoutMs)
      throw new WebError(
        `Brave Search returned an unprocessable response body: ${String(error)}`,
        'WEB_PROVIDER_ERROR',
        { cause: error },
      )
    }
  }

  /**
   * Resolve one operation's subscription token without retaining it on the
   * provider. A resolution that succeeds is itself credential evidence, so a
   * directly-driven search can make the provider available for the next one.
   *
   * @param options - the caller's snapshot, so the key and the endpoint it is sent to come from one section.
   * @returns the resolved token.
   * @throws {@link WebError} `WEB_PROVIDER_CREDENTIAL_MISSING` when no key resolves, `WEB_PROVIDER_ERROR` when resolution fails.
   */
  private async resolveCredential(options: BraveSearchProviderOptions): Promise<string> {
    const literal = options.apiKey
    if (literal !== undefined && literal.length > 0) {
      this.observeCredential(options.apiKeyEnv, true)
      return literal
    }
    let resolved: string | undefined
    try {
      resolved = await options.resolveApiKey()
    } catch (error: unknown) {
      throw new WebError(
        `Brave search credential resolution failed: ${String(error)}`,
        'WEB_PROVIDER_ERROR',
        { cause: error },
      )
    }
    if (resolved != null && resolved.length > 0) {
      this.observeCredential(options.apiKeyEnv, true)
      return resolved
    }
    throw new WebError(missingCredential(options.apiKeyEnv), 'WEB_PROVIDER_CREDENTIAL_MISSING')
  }
}

/**
 * Turn a non-2xx response into the provider error that describes it. A body
 * that is not JSON — normal for gateway 5xx and 429s — costs only the richer
 * detail, never the status.
 *
 * @param response - the failed response whose body may carry Brave's envelope.
 * @param signal - abort signal for the surrounding search.
 * @param endpoint - the endpoint this operation dispatched to.
 * @param timeoutMs - the configured request timeout.
 * @returns the provider error for this response.
 */
async function httpFailure(
  response: Response, signal: AbortSignal | undefined, endpoint: string, timeoutMs: number,
): Promise<WebError> {
  let message = `Brave Search API error (HTTP ${response.status})`
  try {
    message = apiErrorMessage(response.status, await response.json() as BraveErrorResponse)
  } catch (error: unknown) {
    // An abort fired mid-body must surface as WEB_ABORTED, not be swallowed into
    // a generic HTTP-error message — cancellation is not a provider error.
    throwIfCancelled(error, signal, timeoutMs)
    // Otherwise the status is already captured in `message` above.
  }
  return new WebError(endpointFailure(endpoint, message), 'WEB_PROVIDER_ERROR')
}

/**
 * Compose the signal one dispatch runs under: the caller's cancellation merged
 * with this provider's own deadline, so a hung request cannot outlive
 * `timeoutMs` even when the caller supplies none.
 *
 * @param signal - the caller's cancellation signal, when one was supplied.
 * @param timeoutMs - the configured request timeout.
 * @returns the composed signal for this dispatch.
 */
function deadlineSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const deadline = AbortSignal.timeout(timeoutMs)
  return signal === undefined ? deadline : AbortSignal.any([signal, deadline])
}

/** Throw the provider's stable cancellation error when the caller already aborted. */
function throwIfSearchAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw searchAborted(signal.reason)
}

/**
 * Rethrow a failure that is not a provider error. The caller's cancellation is
 * never one, whatever reason it carries. With no caller cancellation, a
 * `TimeoutError` can only be this provider's own deadline — the only one it
 * owns — while a plain `AbortError` came from a signal composed elsewhere, which
 * is cancellation too. Every other failure returns so the caller can report it
 * as the transport or body failure it is.
 *
 * @param error - the caught failure.
 * @param signal - the caller's cancellation signal, when one was supplied.
 * @param timeoutMs - the configured request timeout.
 * @throws {@link WebError} `WEB_ABORTED` for cancellation, `WEB_PROVIDER_ERROR` for this provider's deadline.
 */
function throwIfCancelled(error: unknown, signal: AbortSignal | undefined, timeoutMs: number): void {
  if (signal?.aborted === true) throw searchAborted(signal.reason)
  if (isTimeoutError(error)) {
    throw new WebError(`Brave search timed out after ${String(timeoutMs)}ms`, 'WEB_PROVIDER_ERROR', { cause: error })
  }
  if (isAbortError(error)) throw searchAborted(error)
}

/** Build the provider's stable cancellation error while retaining the caller's reason. */
function searchAborted(reason: unknown): WebError {
  return new WebError('Brave search aborted', 'WEB_ABORTED', { cause: reason })
}

/** Add endpoint recovery instructions to a failure that occurred after dispatch began. */
function endpointFailure(endpoint: string, message: string): string {
  return `${message}\n\nThe web search request used endpoint ${JSON.stringify(endpoint)}. `
    + 'Search endpoint configuration is separate from chat; only the user should choose or '
    + 'change it, through the web-search-brave settings section (baseURL) or by configuring '
    + 'web-search-brave.baseURL to a trusted Brave Search base.'
}

/** Explain a search that reached no key, naming where one can be stored. */
function missingCredential(ref: CredentialRef): string {
  return `Brave search has no API key for "${ref}"; store it through the credentials service `
    + '(the web Models page writes it), export it in the launching environment, or set a '
    + 'literal "apiKey" in the web-search-brave config'
}

/** True for the `TimeoutError` a deadline-driven abort produces. */
function isTimeoutError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'TimeoutError'
}

/** True for a fetch/`AbortSignal` abort that no caller signal explains. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

/** True for a request bound or timeout this provider can send to Brave. */
function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0
}
