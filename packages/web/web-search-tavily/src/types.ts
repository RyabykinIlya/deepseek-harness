/**
 * Wire types for Tavily's search API (`POST https://api.tavily.com/search`). Every
 * field is optional: the endpoint's failure and success envelopes differ in
 * shape, and a field a plan does not return must not become a missing-key crash.
 *
 * These types describe the documented success envelope and the ONE error shape
 * that was actually observed against the live endpoint (HTTP 401 carrying
 * `detail.error`). Anything else in an error body is read defensively.
 *
 * @module @deepseek-ai/dsh-web-search-tavily/types
 */

/** Request body sent to Tavily's search endpoint. */
export interface TavilySearchRequest {
  /** The search query; the only required field. */
  query: string
  /** Tavily's result-count control (`max_results`); the seam still bounds the result on return. */
  max_results?: number
}

/**
 * One entry of Tavily's flat `results[]`. `content` is Tavily's own extract of
 * the page, not a verbatim copy, and can run long — the provider bounds it.
 */
export interface TavilyResult {
  url: string
  title?: string | null
  /** Extracted page text relevant to the query; absent or empty is normal. */
  content?: string | null
  /**
   * Tavily's 0..1 relevance score. The web seam has no field for it, so the
   * provider does not map it and does not re-rank by it: Tavily already returns
   * `results[]` in its own ranking order.
   */
  score?: number | null
}

/** Tavily's search response envelope. */
export interface TavilySearchResponse {
  /** The query as Tavily executed it; informational only. */
  query?: string
  /** Absent or empty when the query matched nothing. */
  results?: TavilyResult[]
  /** Generated answer, `null` unless the request asked for one — which this provider never does. */
  answer?: string | null
  /** Tavily's own latency report in seconds; unused, the seam times nothing from it. */
  response_time?: number | null
}

/**
 * Tavily's error envelope, best-effort: `detail` is an object carrying `error`
 * on the observed HTTP 401, a bare string on some validation failures, and other
 * deployments use a top-level `error` or `message`.
 */
export interface TavilyError {
  detail?: string | { error?: string | null } | null
  error?: string | null
  message?: string | null
}
