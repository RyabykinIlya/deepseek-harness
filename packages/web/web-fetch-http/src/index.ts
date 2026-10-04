/**
 * Anonymous public HTTP(S) `WebFetchProvider` plugin. It contributes to the
 * `ctx.web` registry without owning the service.
 *
 * @module @deepseek-ai/dsh-web-fetch-http
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import { HttpFetchProvider } from './provider.ts'
import type { HttpFetchLimits } from './provider.ts'
import { compileTrustedAddressRanges } from './network.ts'

const MAX_NODE_TIMER_DELAY_MS = 2_147_483_647

export {
  LOCAL_FETCH_PROVIDER_ID,
  HttpFetchProvider,
} from './provider.ts'
export type { HttpFetchLimits, HttpFetchResolver } from './provider.ts'

/** Default `User-Agent`: an explicit product agent, never a browser disguise. */
export const DEFAULT_USER_AGENT = 'deepseek-harness/0.0.1 (+https://github.com/deepseek-ai)'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-fetch-http'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Plugin config: the provider's transport and size limits plus its `User-Agent` (all defaulted). */
export interface Config {
  /** Maximum response body size in bytes. */
  maxResponseBytes?: number
  /** Maximum decoded body length in characters. */
  maxBodyChars?: number
  /** Default fetch timeout in milliseconds, within Node's timer range. */
  timeoutMs?: number
  /** Maximum number of same-origin redirect hops to follow. */
  maxRedirects?: number
  /** `User-Agent` header sent on every request. */
  userAgent?: string
  /**
   * CIDR blocks this deployment's DNS proxy answers proxied hostnames with — the synthetic
   * stand-in pool of a transparent proxy in `fake-ip` mode, e.g. `198.18.0.0/15`. Addresses
   * inside a declared block are accepted as reachable instead of refused as non-public.
   * Default `[]`: no block is declared, and every address the guard refuses today stays refused.
   *
   * TRADE-OFF: declaring a block trusts it to be that proxy's synthetic pool and grants
   * reachability to whatever the proxy maps it to. The block stops being a barrier, so a
   * resolver answering with a private or loopback address inside it would be fetched. Only the
   * declared blocks are affected; `10/8`, `172.16/12`, `192.168/16`, `100.64/10`, `127/8`,
   * `169.254/16`, `fc00::/7` and the IPv4-mapped forms of all of them stay blocked. IPv6 and
   * IPv4 blocks may be mixed. A block that is not a CIDR fails the plugin at construction.
   *
   * PREFERRED REMEDY: fix the network instead — run the proxy in `redir-host`/`real-ip` mode
   * so DNS returns the origin's real, publicly routable addresses and this option is
   * unnecessary. Reach for it only where the proxy's mode cannot be changed.
   */
  trustedProxyAddressRanges?: string[]
}

export const Config: z<Config> = z.object({
  maxResponseBytes: z.number().default(5_000_000),
  maxBodyChars: z.number().default(100_000),
  timeoutMs: z.number().default(30_000),
  maxRedirects: z.number().default(5),
  userAgent: z.string().default(DEFAULT_USER_AGENT),
  trustedProxyAddressRanges: z.array(z.string()).default([]),
})

/** Complete config after schemastery applies every field default. */
type ResolvedConfig = Required<Config>

/** A resource limit (byte/char/length/timeout cap) must be a positive finite number. */
function assertPositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`web-fetch-http: ${name} must be a positive finite number`)
  }
}

/** Node coerces larger timer delays to 1 ms, so reject them at configuration time. */
function assertTimeoutMs(value: number): void {
  assertPositiveFinite('timeoutMs', value)
  if (value > MAX_NODE_TIMER_DELAY_MS) {
    throw new Error(`web-fetch-http: timeoutMs must be no greater than ${MAX_NODE_TIMER_DELAY_MS}`)
  }
}

/** The redirect hop cap must be a non-negative integer (0 follows no redirects). */
function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`web-fetch-http: ${name} must be a non-negative integer`)
  }
}

/** Register the local HTTP(S) fetch provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  // schemastery (Config) has already filled every defaulted field.
  const resolved = config as ResolvedConfig
  assertPositiveFinite('maxResponseBytes', resolved.maxResponseBytes)
  assertPositiveFinite('maxBodyChars', resolved.maxBodyChars)
  assertTimeoutMs(resolved.timeoutMs)
  assertNonNegativeInteger('maxRedirects', resolved.maxRedirects)
  const limits: HttpFetchLimits = {
    maxResponseBytes: resolved.maxResponseBytes,
    maxBodyChars: resolved.maxBodyChars,
    timeoutMs: resolved.timeoutMs,
    maxRedirects: resolved.maxRedirects,
    userAgent: resolved.userAgent,
    // Compiled here, so a malformed block is a construction error and the guard's hot path
    // never re-parses the operator's strings.
    trustedProxyAddressRanges: compileTrustedAddressRanges(resolved.trustedProxyAddressRanges),
  }
  ctx.web.registerFetchProvider(new HttpFetchProvider(limits))
}
