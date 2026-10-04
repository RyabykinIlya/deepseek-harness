/**
 * Keyless DuckDuckGo `WebSearchProvider` plugin. It contributes to the `ctx.web`
 * registry without owning the service.
 *
 * @module @deepseek-ai/dsh-web-search-duckduckgo
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import {
  DuckDuckGoSearchProvider,
  DUCKDUCKGO_DEFAULT_ENDPOINT,
  DUCKDUCKGO_DEFAULT_MAX_RESPONSE_BYTES,
  DUCKDUCKGO_DEFAULT_TIMEOUT_MS,
  DUCKDUCKGO_DEFAULT_USER_AGENT,
} from './provider.ts'

export {
  DUCKDUCKGO_DEFAULT_ENDPOINT,
  DUCKDUCKGO_DEFAULT_MAX_RESPONSE_BYTES,
  DUCKDUCKGO_DEFAULT_TIMEOUT_MS,
  DUCKDUCKGO_DEFAULT_USER_AGENT,
  DUCKDUCKGO_PROVIDER_ID,
  DuckDuckGoSearchProvider,
} from './provider.ts'
export type { DuckDuckGoSearchProviderOptions } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-duckduckgo'

/** The web seam this provider registers into. */
export const inject = ['web']

/**
 * Plugin config (every field optional — `apply` fills the constant defaults).
 * There is no credential field because DuckDuckGo's HTML endpoint is keyless;
 * `available()` therefore reports the provider usable unless one of these
 * settings is itself unusable.
 */
export interface Config {
  /** HTML endpoint the query is POSTed to. Defaults to DuckDuckGo's HTML endpoint. */
  endpoint?: string
  /**
   * `User-Agent` sent on every request. Defaults to a browser identity, which
   * the endpoint requires to answer with results rather than a challenge page.
   */
  userAgent?: string
  /** Default result count when a request carries no `maxResults`. Omitted = none. */
  numResults?: number
  /** Request timeout in milliseconds. */
  timeoutMs?: number
  /** Byte cap on the response body this provider will read. */
  maxResponseBytes?: number
}

export const Config: z<Config> = z.object({
  endpoint: z.string(),
  userAgent: z.string(),
  numResults: z.number().step(1).min(1),
  timeoutMs: z.number().step(1).min(1),
  maxResponseBytes: z.number().step(1).min(1),
})

/** Register the DuckDuckGo search provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  ctx.web.registerSearchProvider(new DuckDuckGoSearchProvider({
    endpoint: config.endpoint ?? DUCKDUCKGO_DEFAULT_ENDPOINT,
    userAgent: config.userAgent ?? DUCKDUCKGO_DEFAULT_USER_AGENT,
    timeoutMs: config.timeoutMs ?? DUCKDUCKGO_DEFAULT_TIMEOUT_MS,
    maxResponseBytes: config.maxResponseBytes ?? DUCKDUCKGO_DEFAULT_MAX_RESPONSE_BYTES,
    ...config.numResults !== undefined ? { numResults: config.numResults } : {},
  }))
}
