/**
 * Wire types for Brave's Web Search endpoint
 * (`GET https://api.search.brave.com/res/v1/web/search`, authenticated by an
 * `X-Subscription-Token` header). Types only — no runtime code.
 *
 * Every optional field is declared optional because the provider parses
 * defensively: a field Brave documents may still be absent from a response, and
 * a missing field must never fail a search. `BraveErrorResponse` is the envelope
 * that was observed from the live endpoint (an invalid subscription token
 * answers HTTP 422); `BraveSearchResponse` is from Brave's published
 * documentation and was not observed live.
 * @module @deepseek-ai/dsh-web-search-brave/types
 */

/**
 * One web result. Only `url` is required to cite it; `title`, `description`,
 * and `page_age` are dropped when absent rather than defaulted.
 */
export interface BraveWebResult {
  /** The result's target; the only field this provider requires. */
  url?: string | null
  /** Brave's result title. */
  title?: string | null
  /** Brave's result snippet; mapped to `WebSearchSource.snippet`. */
  description?: string | null
  /** Provider-supplied page age/recency string (mapped to `publishedAt`). */
  page_age?: string | null
}

/**
 * The `web` vertical's envelope. Absent when Brave answered with another
 * vertical, and present with an empty `results` array when nothing matched.
 */
export interface BraveWebVertical {
  /**
   * The web results. Declared as an array because Brave documents one; the
   * provider still checks at runtime, so a malformed body cannot fail a search.
   */
  results?: BraveWebResult[] | null
}

/**
 * Brave's search response envelope. Verticals this provider did not request
 * (`news`, `images`, …) are absent rather than empty.
 */
export interface BraveSearchResponse {
  /** The web vertical; absent when the response carried none. */
  web?: BraveWebVertical | null
}

/**
 * Brave's error envelope (`type: 'ErrorResponse'`). Observed live on an invalid
 * subscription token: HTTP 422 with `error.code`
 * `SUBSCRIPTION_TOKEN_INVALID`, `error.detail`, and `error.meta.component`.
 * Authentication failures are therefore NOT 401/403, and the machine-readable
 * `code` is what distinguishes them — the provider carries both fields into its
 * error message instead of assuming an unauthorized status.
 */
export interface BraveErrorResponse {
  /** Brave's envelope discriminator; observed as `ErrorResponse`, never branched on. */
  type?: string | null
  error?: {
    /** Brave's machine-readable failure code, such as `SUBSCRIPTION_TOKEN_INVALID`. */
    code?: string | null
    /** Human-readable explanation, carried verbatim into the provider error message. */
    detail?: string | null
    /** Brave's failure attribution; recorded for completeness, never branched on. */
    meta?: { component?: string | null } | null
    /** The status Brave echoes inside the envelope. */
    status?: number | null
  } | string | null
}
