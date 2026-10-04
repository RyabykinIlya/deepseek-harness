/**
 * Read-only access to OpenRouter's model catalog: `GET /api/v1/models`.
 *
 * The catalog is what turns a model id into a family. OpenRouter publishes every
 * release of a model under its own id and states, in `canonical_slug`, which
 * dated release that id *is*: `deepseek/deepseek-v4-pro` is
 * `deepseek/deepseek-v4-pro-20260423`, `deepseek/deepseek-v4-pro-0813` is
 * `deepseek/deepseek-v4-pro-20260813`. So the set of ids sharing a canonical
 * slug is the model family, and its newest member is the newest snapshot — a
 * fact read from OpenRouter rather than parsed out of a display name, which is
 * what lets a caller keep naming `deepseek/deepseek-v4-pro` and still be served
 * the latest release.
 *
 * **Nothing here is stored**, and no module in this package reads this path on
 * its own: {@link fetchOpenRouterModelCatalog} always reaches the network when it
 * is called, so a deployment that wants a cache wraps it in one.
 *
 * The reply is a third party's, so a field that is absent, null, or not a string
 * narrows instead of throwing. An entry without a usable `id` is skipped rather
 * than guessed at: a catalog entry with no identity cannot name a family, and a
 * body that is not the documented envelope raises a classified {@link LlmError}.
 *
 * @module dsh-llm-pi-ai/openrouter-catalog
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import { OPENROUTER_DEFAULT_BASE_URL } from './openrouter-endpoints.ts'
import { readOpenRouterJson } from './openrouter-http.ts'

/**
 * Default request timeout, matching the per-model endpoint listing: both are read
 * on the path that decides which upstream serves a request, so neither may hold
 * that request longer than the caller's own budget.
 */
export const OPENROUTER_CATALOG_TIMEOUT_MS = 10_000

/**
 * Ceiling on a reply body. The full catalog is roughly 760 kB across several
 * hundred models today and grows with every release OpenRouter lists, so this is
 * a runaway guard set an order of magnitude above the real thing rather than a
 * working bound.
 */
export const OPENROUTER_CATALOG_MAX_BYTES = 8 * 1024 * 1024

/** Stable machine code for a reply that is not a parseable model catalog. */
export const MALFORMED_CATALOG_CODE = 'OPENROUTER_CATALOG_MALFORMED'

/** Stable machine code for a non-2xx answer from the catalog URL. */
export const CATALOG_HTTP_ERROR_CODE = 'OPENROUTER_CATALOG_HTTP'

/** Stable machine code for a catalog URL this process could not reach. */
export const CATALOG_UNREACHABLE_CODE = 'OPENROUTER_CATALOG_UNREACHABLE'

/**
 * One catalog entry's identity fields.
 *
 * `canonicalSlug` is the id without OpenRouter's display-suffix spelling and
 * carries the release date; an entry that names no dated release states its own
 * id there, which is how a model outside any dated family is recognized.
 */
export interface OpenRouterCatalogEntry {
  /** The id requests are dispatched under, such as `deepseek/deepseek-v4-pro-0813`. */
  id: string
  /** The dated identity of that id, such as `deepseek/deepseek-v4-pro-20260813`. */
  canonicalSlug: string
}

/** Transport, timeout, credential, and deployment headers for one catalog read. */
export interface OpenRouterCatalogRequest {
  /** API root the `/models` path is appended to; defaults to {@link OPENROUTER_DEFAULT_BASE_URL}. */
  baseURL?: string
  /** Request timeout in milliseconds; defaults to {@link OPENROUTER_CATALOG_TIMEOUT_MS}. */
  timeoutMs?: number
  /** Caller cancellation; reported as `ABORTED` rather than a timeout. */
  signal?: AbortSignal
  /** Credential for the listing; OpenRouter serves the catalog without one. */
  apiKey?: string
  /** Deployment-owned request headers, such as a proxy's. Attribution names win collisions. */
  headers?: Readonly<Record<string, string>>
}

/** Read a trimmed non-empty string field, or `undefined` when absent or blank. */
function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/**
 * Read the catalog out of a parsed reply body.
 *
 * A body that is not the documented envelope raises one coded failure rather
 * than reading as an empty catalog: an empty catalog would look like "no family
 * has a newer release", and every configured model would then silently stay on
 * whatever id it was pinned to.
 * @param body - the parsed reply body.
 * @returns the entries the reply names, in the order it listed them.
 * @throws LlmError `OPENROUTER_CATALOG_MALFORMED` for any other shape.
 */
export function parseOpenRouterCatalog(body: unknown): readonly OpenRouterCatalogEntry[] {
  const malformed = (detail: string): LlmError =>
    new LlmError(`llm-pi-ai: ${detail} in the OpenRouter model catalog`, MALFORMED_CATALOG_CODE)
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw malformed('expected a JSON object')
  }
  const data: unknown = (body as { data?: unknown }).data
  if (!Array.isArray(data)) throw malformed('expected a "data" array')
  return data.flatMap((raw) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return []
    const entry = raw as { id?: unknown; canonical_slug?: unknown }
    const id = text(entry.id)
    if (id === undefined) return []
    const canonical = text(entry.canonical_slug)
    return [{ id, canonicalSlug: canonical ?? id }]
  })
}

/**
 * Fetch the model catalog.
 *
 * The caller is expected to have already decided that a routing decision needs
 * it: this function always reaches the network when it is called, which is why
 * nothing in this package calls it on its own.
 * @param request - transport, timeout, credential, and deployment headers.
 * @returns the catalog entries the reply names.
 * @throws LlmError with a stable code for an unreachable endpoint, a non-2xx
 *   answer, an over-large body, a non-JSON body, or an envelope this package
 *   cannot read.
 */
export async function fetchOpenRouterModelCatalog(
  request: OpenRouterCatalogRequest = {},
): Promise<readonly OpenRouterCatalogEntry[]> {
  const base = (request.baseURL ?? OPENROUTER_DEFAULT_BASE_URL).replace(/\/+$/, '')
  const body = await readOpenRouterJson(`${base}/models`, request, {
    timeoutMs: request.timeoutMs ?? OPENROUTER_CATALOG_TIMEOUT_MS,
    maxBytes: OPENROUTER_CATALOG_MAX_BYTES,
  }, {
    http: CATALOG_HTTP_ERROR_CODE,
    malformed: MALFORMED_CATALOG_CODE,
    unreachable: CATALOG_UNREACHABLE_CODE,
  })
  return parseOpenRouterCatalog(body)
}
