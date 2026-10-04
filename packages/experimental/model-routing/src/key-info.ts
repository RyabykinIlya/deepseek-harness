/**
 * The account's free-model daily budget, read from `GET /key`.
 *
 * OpenRouter counts every `:free` request against one account-wide daily quota,
 * so a free tier that silently hits the ceiling mid-conversation turns into a
 * cascade of `RATE_LIMIT`s. The route reads this counter *before* picking a free
 * endpoint and keeps a paid one when the remaining budget is low; once a free
 * endpoint actually fails, the adapter blocks free endpoints until the next UTC
 * midnight. Both thresholds are configurable, and an unreadable counter blocks
 * nothing — the failure mode it protects against is worse than the one it causes.
 *
 * @module dsh-experimental-model-routing/key-info
 */

import type { FreeUsage } from './types.ts'

/** Largest `/key` reply read; the documented body is a few hundred bytes. */
const MAX_BODY_BYTES = 64 * 1024

/** Everything `KeyInfo` reads from, injected so the tests never reach the network. */
export interface KeyInfoDeps {
  fetch: typeof fetch
  now: () => number
  baseUrl: () => string
  apiKey: () => Promise<string | undefined>
  headers: () => Readonly<Record<string, string>>
}

/** Reads and caches the free-model daily budget. */
export class KeyInfo {
  private cached: { at: number; usage: FreeUsage } | undefined

  constructor(private readonly deps: KeyInfoDeps) {}

  /**
   * The account's remaining free-model requests for today.
   *
   * Every failure mode — no credential, an HTTP error, a body that is not the
   * documented envelope — answers `undefined` rather than throwing: the caller
   * treats an unknown budget as a budget that does not constrain anything.
   * @param ttlMs - how long a reading is reused.
   * @param signal - the request's cancellation.
   * @returns the budget, or `undefined` while it cannot be read.
   */
  async freeUsage(ttlMs: number, signal: AbortSignal): Promise<FreeUsage | undefined> {
    const cached = this.cached
    if (cached !== undefined && this.deps.now() - cached.at < ttlMs) return cached.usage
    const apiKey = await this.deps.apiKey()
    // An empty credential is as absent as a missing one: OpenRouter would answer
    // 401, and sending `Bearer ` gains nothing over not asking.
    if (apiKey === undefined || apiKey.length === 0) return undefined
    let response: Response
    try {
      response = await this.deps.fetch(`${this.deps.baseUrl()}/key`, {
        headers: { authorization: `Bearer ${apiKey}`, ...this.deps.headers() },
        signal,
      })
    } catch {
      return undefined
    }
    if (!response.ok) return undefined
    let body: string
    try {
      body = await response.text()
    } catch {
      return undefined
    }
    if (body.length > MAX_BODY_BYTES) return undefined
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      return undefined
    }
    const usage = readFreeUsage(parsed)
    if (usage !== undefined) this.cached = { at: this.deps.now(), usage }
    return usage
  }
}

/**
 * Read `free_model_daily_requests` out of a `/key` body.
 *
 * @param body - the parsed reply.
 * @returns the budget, or `undefined` when the body does not carry a complete one.
 */
function readFreeUsage(body: unknown): FreeUsage | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const data = (body as { data?: unknown }).data
  if (typeof data !== 'object' || data === null) return undefined
  const counter = (data as { free_model_daily_requests?: unknown }).free_model_daily_requests
  if (typeof counter !== 'object' || counter === null) return undefined
  const { used, limit, remaining } = counter as Record<string, unknown>
  if (typeof used !== 'number' || typeof limit !== 'number' || typeof remaining !== 'number') return undefined
  return { used, limit, remaining }
}
