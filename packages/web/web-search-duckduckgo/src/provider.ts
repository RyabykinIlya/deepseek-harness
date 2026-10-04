/**
 * `DuckDuckGoSearchProvider`: a keyless `WebSearchProvider` backed by DuckDuckGo's
 * HTML endpoint (`POST https://html.duckduckgo.com/html/` with the query as a
 * form field). No API key, no account, and no authenticated mode exist, so the
 * provider is available by construction and only becomes unavailable when its own
 * configuration cannot be used.
 *
 * The endpoint answers an anonymous tool agent with an HTTP 202 anomaly page that
 * contains no result anchors. That page is a 2xx response, so it parses to zero
 * results and resolves as an ordinary empty result set; a hard failure is reserved
 * for transport and non-2xx outcomes.
 * @module @deepseek-ai/dsh-web-search-duckduckgo/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import type { DuckDuckGoResultLink } from './types.ts'

/** Stable id this provider registers under. */
export const DUCKDUCKGO_PROVIDER_ID = 'duckduckgo'

/**
 * Default HTML endpoint. The query is POSTed here as
 * `application/x-www-form-urlencoded` — the submission DuckDuckGo's own search
 * form makes — rather than appended to a query string.
 */
export const DUCKDUCKGO_DEFAULT_ENDPOINT = 'https://html.duckduckgo.com/html/'

/**
 * Default `User-Agent`, and a deliberate exception to this repository's
 * "identify as the product" rule: the endpoint serves an HTTP 202 anomaly page
 * carrying no results to anything that does not look like a browser, so a keyless
 * search has no honest alternative. It names a browser only because that is what
 * makes results exist; the request is documented as scraping a public page.
 * Deployments that would rather identify themselves can set `userAgent`
 * explicitly and accept that DuckDuckGo may answer with zero results.
 */
export const DUCKDUCKGO_DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

/** Default request timeout. One HTML page answers in well under a second. */
export const DUCKDUCKGO_DEFAULT_TIMEOUT_MS = 15_000

/**
 * Default cap on the bytes read from one results page. A rendered page is around
 * 30 KB; the cap exists so a challenge page or a pathological document cannot
 * grow this process's memory without bound.
 */
export const DUCKDUCKGO_DEFAULT_MAX_RESPONSE_BYTES = 1_048_576

/** One result anchor: its target attribute and its inner HTML. */
const TITLE_ANCHOR = /<a\b[^>]*\bclass="[^"]*\bresult__a\b[^"]*"[^>]*>[\s\S]*?<\/a>/giu

/** The snippet anchor of one result block; it always follows its title anchor. */
const SNIPPET_ANCHOR = /<a\b[^>]*\bclass="[^"]*\bresult__snippet\b[^"]*"[^>]*>[\s\S]*?<\/a>/iu

/** The `href` attribute of a matched anchor tag. */
const HREF_ATTRIBUTE = /\bhref="([^"]*)"/iu

/** Any HTML tag, stripped before the remaining text is treated as prose. */
const HTML_TAG = /<[^>]*>/gu

/** Any run of whitespace, collapsed so a snippet reads as one line. */
const WHITESPACE_RUN = /\s+/gu

/** The named entities DuckDuckGo's titles and snippets use, plus the common set. */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  apos: '\'',
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
  copy: '©',
  deg: '°',
  euro: '€',
  frac12: '½',
  hellip: '…',
  ldquo: '“',
  lsquo: '‘',
  mdash: '—',
  middot: '·',
  ndash: '–',
  pound: '£',
  raquo: '»',
  rdquo: '”',
  reg: '®',
  rsquo: '’',
  sect: '§',
  times: '×',
  trade: '™',
  yen: '¥',
}

/** A numeric character reference, decimal or hexadecimal. */
const ENTITY = /&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/gu

/** The largest code point `String.fromCodePoint` accepts. */
const MAX_CODE_POINT = 0x10_ff_ff

/** Resolved provider options (the plugin's `apply` supplies the constant defaults). */
export interface DuckDuckGoSearchProviderOptions {
  /** HTML endpoint the query is POSTed to. */
  endpoint: string
  /** `User-Agent` sent on every request. */
  userAgent: string
  /** Default result count when a request carries no `maxResults`. */
  numResults?: number
  /** Request timeout in milliseconds, bounded by the provider's own deadline. */
  timeoutMs: number
  /** Byte cap on the response body this provider will read. */
  maxResponseBytes: number
}

/**
 * Read the target of one matched anchor tag.
 *
 * @param anchor - a full `<a …>…</a>` match.
 * @returns the `href` attribute value, or `undefined` when the tag carries none.
 */
export function anchorHref(anchor: string): string | undefined {
  return HREF_ATTRIBUTE.exec(anchor)?.[1]
}

/**
 * Read the inner HTML of one matched anchor, from its tag's `>` to its `</a>`.
 * An unterminated anchor — a document cut short by the byte cap, or a challenge
 * page — yields an empty string rather than a slice of unrelated markup.
 *
 * @param anchor - a full `<a …>…</a>` match.
 * @returns the anchor's inner HTML, empty when the anchor has no closing tag.
 */
export function anchorInnerHtml(anchor: string): string {
  const open = anchor.indexOf('>')
  const close = anchor.lastIndexOf('</a>')
  return close > open ? anchor.slice(open + 1, close) : ''
}

/**
 * Extract every result block from one results page, in document order. A block's
 * snippet belongs to the region between its title anchor and the next one, so a
 * page that renders no snippet yields a link without one rather than borrowing the
 * following result's text.
 *
 * @param html - the response body.
 * @returns one link per result anchor that also carries an `href`.
 */
export function extractResultLinks(html: string): DuckDuckGoResultLink[] {
  const titles = [...html.matchAll(TITLE_ANCHOR)]
  const links: DuckDuckGoResultLink[] = []
  for (const [index, title] of titles.entries()) {
    const href = anchorHref(title[0])
    if (href === undefined) continue
    const end = titles[index + 1]?.index ?? html.length
    const block = html.slice(title.index + title[0].length, end)
    const snippet = SNIPPET_ANCHOR.exec(block)?.[0]
    links.push({
      href,
      titleHtml: anchorInnerHtml(title[0]),
      ...snippet !== undefined ? { snippetHtml: anchorInnerHtml(snippet) } : {},
    })
  }
  return links
}

/**
 * Map one extracted result block to a normalized source, or `undefined` when its
 * target is not a citeable http(s) URL. Titles and snippets are optional on this
 * seam by design, so a page that renders neither text field still yields a source.
 *
 * @param link - one extracted result block.
 * @returns the normalized source, or `undefined` for an unusable target.
 */
export function mapResultLink(link: DuckDuckGoResultLink): WebSearchSource | undefined {
  const url = absoluteHttpUrl(decodeEntities(link.href))
  if (url === undefined) return undefined
  const title = plainText(link.titleHtml)
  const snippet = link.snippetHtml === undefined ? '' : plainText(link.snippetHtml)
  return {
    url,
    ...title.length > 0 ? { title } : {},
    ...snippet.length > 0 ? { snippet } : {},
  }
}

/**
 * Map one results page to a normalized search result: blocks are mapped in
 * document order, repeated targets are dropped, and the request's result bound is
 * applied here because this endpoint has no server-side count control. DuckDuckGo
 * generates no answer, so `content` is omitted. A challenge page, a document whose
 * markup changed, and a genuinely empty result set all resolve to `sources: []`.
 *
 * @param html - the response body.
 * @param limit - the result bound to enforce, if any.
 * @returns the normalized result, flagged `truncated` when the bound cut sources.
 */
export function mapResultsPage(html: string, limit: number | undefined): WebSearchResult {
  const sources: WebSearchSource[] = []
  const seen = new Set<string>()
  for (const link of extractResultLinks(html)) {
    const source = mapResultLink(link)
    if (source === undefined || seen.has(source.url)) continue
    seen.add(source.url)
    sources.push(source)
  }
  if (limit === undefined || sources.length <= limit) return { sources, truncated: false }
  return { sources: sources.slice(0, limit), truncated: true }
}

/**
 * Decode the HTML entities in one fragment. A named reference DuckDuckGo does not
 * use, and a numeric one outside the Unicode range, are both left verbatim rather
 * than guessed at.
 *
 * @param text - text that may contain character references.
 * @returns the decoded text.
 */
function decodeEntities(text: string): string {
  return text.replace(ENTITY, (whole, body: string) => {
    if (!body.startsWith('#')) return NAMED_ENTITIES[body.toLowerCase()] ?? whole
    const hexadecimal = body.startsWith('#x') || body.startsWith('#X')
    const code = hexadecimal ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10)
    return code >= 0 && code <= MAX_CODE_POINT ? String.fromCodePoint(code) : whole
  })
}

/**
 * Reduce one fragment of DuckDuckGo's HTML to the plain text a model should see:
 * tags become spaces, entities are decoded, and whitespace is collapsed.
 *
 * @param html - an anchor's inner HTML.
 * @returns the fragment's plain text.
 */
function plainText(html: string): string {
  return decodeEntities(html.replace(HTML_TAG, ' ')).replace(WHITESPACE_RUN, ' ').trim()
}

/**
 * Resolve one href to a citeable absolute URL. DuckDuckGo writes protocol-relative
 * targets on some blocks and wraps others, so a relative target is dropped rather
 * than guessed at and a non-http scheme is refused.
 *
 * @param href - the decoded `href` attribute value.
 * @returns the absolute http(s) URL, or `undefined` when the target is unusable.
 */
function absoluteHttpUrl(href: string): string | undefined {
  const candidate = href.startsWith('//') ? `https:${href}` : href
  if (!URL.canParse(candidate)) return undefined
  const url = new URL(candidate)
  return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined
}

/**
 * Read at most `maxBytes` bytes of a response body and decode them. The byte cap
 * is enforced per chunk, so a challenge page or an oversized document is cut
 * rather than buffered; whatever prefix was read is returned, which already holds
 * the leading result blocks.
 *
 * @param response - the successful response whose body is read.
 * @param maxBytes - the byte cap for this read.
 * @returns the decoded prefix of the body.
 */
async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const body = response.body
  if (body === null) return ''
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let received = 0
  let text = ''
  while (received < maxBytes) {
    const { done, value } = await reader.read()
    if (done) return text + decoder.decode()
    const remaining = maxBytes - received
    if (value.byteLength > remaining) {
      text += decoder.decode(value.subarray(0, remaining), { stream: true })
      await reader.cancel()
      return text + decoder.decode()
    }
    received += value.byteLength
    text += decoder.decode(value, { stream: true })
  }
  // The cap is met exactly: the document may still have more bytes behind this
  // one, so release the connection the same way the over-cap chunk does.
  await reader.cancel()
  return text + decoder.decode()
}

/** True for a fetch/`AbortSignal` abort. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

/** True for a limit this provider can enforce (a positive whole number). */
function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0
}

/**
 * Classify one failure of the request or of its body read. The caller's own
 * cancellation is not a provider failure; every other abort came from this
 * provider's deadline, and anything else is a transport failure.
 *
 * @param error - the caught failure.
 * @param signal - the caller's cancellation signal, when one was supplied.
 * @param timeoutMs - the configured request timeout.
 * @returns the `WebError` that describes this failure.
 */
function searchFailure(error: unknown, signal: AbortSignal | undefined, timeoutMs: number): WebError {
  if (signal?.aborted === true) {
    return new WebError('DuckDuckGo search aborted', 'WEB_ABORTED', { cause: signal.reason })
  }
  if (isAbortError(error)) {
    return new WebError(
      `DuckDuckGo search timed out after ${String(timeoutMs)}ms`,
      'WEB_PROVIDER_ERROR',
      { cause: error },
    )
  }
  return new WebError(`DuckDuckGo search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
}

/**
 * The keyless DuckDuckGo-backed search provider. HTTP redirects and non-2xx
 * responses fail as `WEB_PROVIDER_ERROR`; an anti-bot challenge page is a 2xx
 * response with no results and resolves as an empty result set.
 */
export class DuckDuckGoSearchProvider implements WebSearchProvider {
  readonly id = DUCKDUCKGO_PROVIDER_ID

  constructor(private readonly options: DuckDuckGoSearchProviderOptions) {}

  available(): boolean {
    // No credential can be missing, so usability is exactly "this configuration
    // describes a request that could be made".
    return URL.canParse(this.options.endpoint)
      && this.options.userAgent.trim().length > 0
      && isPositiveInteger(this.options.timeoutMs)
      && isPositiveInteger(this.options.maxResponseBytes)
      && (this.options.numResults === undefined || isPositiveInteger(this.options.numResults))
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const deadline = AbortSignal.any(
      signal === undefined
        ? [AbortSignal.timeout(this.options.timeoutMs)]
        : [signal, AbortSignal.timeout(this.options.timeoutMs)],
    )
    let response: Response
    try {
      response = await fetch(this.options.endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'user-agent': this.options.userAgent,
          'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'en-US,en;q=0.9',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ q: request.query }).toString(),
        signal: deadline,
      })
    } catch (error: unknown) {
      throw searchFailure(error, signal, this.options.timeoutMs)
    }

    // A challenge page answers 202: `ok` is true, the body holds no result anchor,
    // and the call resolves empty rather than failing.
    if (!response.ok) {
      throw new WebError(`DuckDuckGo search failed (HTTP ${response.status})`, 'WEB_PROVIDER_ERROR')
    }

    try {
      const html = await readBoundedText(response, this.options.maxResponseBytes)
      return mapResultsPage(html, request.maxResults ?? this.options.numResults)
    } catch (error: unknown) {
      throw searchFailure(error, signal, this.options.timeoutMs)
    }
  }
}
