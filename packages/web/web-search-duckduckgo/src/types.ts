/**
 * Wire types for DuckDuckGo's keyless HTML endpoint. Unlike the sibling providers
 * there is no JSON envelope: one results page is an HTML document whose result
 * blocks carry a `result__a` anchor (title and target) and, when the snippet was
 * rendered, a following `result__snippet` anchor. These types describe the
 * extracted HTML fragments before any of them is decoded to a portable source.
 *
 * @module @deepseek-ai/dsh-web-search-duckduckgo/types
 */

/**
 * One result block, reduced to the raw HTML fragments the parser captured. The
 * title and snippet are still markup: they carry DuckDuckGo's own `<b>` emphasis
 * and HTML entities, and are decoded to plain text only when they are mapped to a
 * `WebSearchSource`.
 */
export interface DuckDuckGoResultLink {
  /** The anchor's `href` attribute, entities still undecoded. */
  readonly href: string
  /** The title anchor's inner HTML (tags and entities undecoded). */
  readonly titleHtml: string
  /** The snippet anchor's inner HTML; absent when the page rendered no snippet. */
  readonly snippetHtml?: string
}
