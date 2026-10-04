/**
 * Brave Search-backed `WebSearchProvider` plugin. It contributes to the
 * `ctx.web` registry without owning the service.
 *
 * The plugin owns the credential *reference*, never the secret: each search
 * resolves `apiKeyEnv` through `ctx.credentials` (falling back to the launch
 * environment when that service is absent) and sends it as Brave's
 * `X-Subscription-Token` header. Because `available()` is a synchronous
 * predicate, the plugin also reports what the credential plane holds — once at
 * load and on every committed change — so the provider is selected only when a
 * key is actually observable, never merely because a resolver exists.
 * @module @deepseek-ai/dsh-web-search-brave
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import { credentialRef, isCredentialRefName } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import {
  BraveSearchProvider,
  BRAVE_DEFAULT_BASE_URL,
  BRAVE_DEFAULT_MAX_RESULTS,
  BRAVE_DEFAULT_TIMEOUT_MS,
} from './provider.ts'
import type { BraveSearchProviderOptions } from './provider.ts'

export {
  BraveSearchProvider,
  BRAVE_DEFAULT_BASE_URL,
  BRAVE_DEFAULT_MAX_RESULTS,
  BRAVE_DEFAULT_TIMEOUT_MS,
  BRAVE_MAX_COUNT,
  BRAVE_PROVIDER_ID,
  apiErrorMessage,
  mapBraveResponse,
  mapBraveResult,
  searchEndpoint,
} from './provider.ts'
export type { BraveSearchProviderOptions } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-brave'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Credential reference the provider resolves when the section names none. */
const DEFAULT_API_KEY_ENV = 'BRAVE_API_KEY'

/**
 * Settings namespace carrying this provider's endpoint, credential reference,
 * and bounds. A settings page binds its scope to this string so a user can paste
 * a key through the credentials domain without editing a configuration file.
 */
export const WEB_SEARCH_BRAVE_SETTINGS_NAMESPACE = 'web-search-brave'

/** Plugin config (all optional — the schema supplies defaults, `apply` the env fallback). */
export interface Config {
  /** Literal Brave subscription token; prefer {@link apiKeyEnv} so no secret enters configuration files. */
  apiKey: Volatile<string | undefined>
  /** Credential reference resolved for each search; defaults to `BRAVE_API_KEY`. */
  apiKeyEnv: Volatile<string>
  /** Brave API base; `/res/v1/web/search` is appended. Defaults to Brave's public API. */
  baseURL: Volatile<string | undefined>
  /** Result count sent as Brave's `count` when a request carries no `maxResults`. Defaults to 8. */
  maxResults: Volatile<number>
  /** Request timeout in milliseconds. Defaults to 15000. */
  timeoutMs: Volatile<number>
}

export const Config = z.object({
  apiKey: z.string().role('secret').volatile(),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV).volatile(),
  // Declared without a default like `apiKey`: a configuration surface renders the
  // resolved section, so a default the schema does not carry reads there as no
  // value at all rather than as "Brave's public API".
  baseURL: z.string().volatile(),
  maxResults: z.number().step(1).min(1).default(BRAVE_DEFAULT_MAX_RESULTS).volatile(),
  timeoutMs: z.number().step(1).min(1).default(BRAVE_DEFAULT_TIMEOUT_MS).volatile(),
})

/**
 * Project one resolved section into the options the provider serves its next
 * search with. The credential resolution closure lives here rather than in the
 * provider: every value the provider reads is already fully defaulted, and the
 * plugin is the only owner of the environment plane.
 * @param ctx - plugin context supplying the credential and environment planes.
 * @param config - the currently authoritative section.
 * @returns options for one search.
 */
function resolveOptions(
  ctx: Context, config: { [K in keyof Config]: ReturnType<Config[K]['get']> },
): BraveSearchProviderOptions {
  const apiKeyEnv = credentialRef(config.apiKeyEnv)
  const literalApiKey = config.apiKey != null && config.apiKey.length > 0 ? config.apiKey : undefined
  return {
    ...literalApiKey === undefined ? {} : { apiKey: literalApiKey },
    apiKeyEnv,
    baseURL: config.baseURL ?? BRAVE_DEFAULT_BASE_URL,
    maxResults: config.maxResults,
    timeoutMs: config.timeoutMs,
    resolveApiKey: async () => {
      const credentials = ctx.get('credentials')
      // A mounted credentials service is authoritative; without one the
      // launching environment is the whole credential plane.
      if (credentials === undefined) return ambientApiKey(ctx, apiKeyEnv)
      return (await credentials.resolve(apiKeyEnv))?.value
    },
  }
}

/**
 * The launching environment's value for one credential reference. An empty value
 * is absent everywhere in this repository, so it never counts as a key.
 * @param ctx - plugin context supplying the environment plane.
 * @param ref - the credential reference to resolve.
 * @returns the non-empty value, or `undefined` when no layer supplies one.
 */
function ambientApiKey(ctx: Context, ref: CredentialRef): string | undefined {
  const value = launchEnvironmentOf(ctx).get(ref)?.value
  return value != null && value.length > 0 ? value : undefined
}

/**
 * Ask the credential plane what it holds for one section reference. An unreadable
 * store, or a name outside the credential grammar, answers "not configured":
 * neither is evidence that a key exists, and refusing to guess leaves the next
 * probe — or the search itself — to report the real reason.
 * @param ctx - plugin context supplying the credential plane.
 * @param apiKeyEnv - the section's credential reference.
 * @returns the reference (absent when the section named an invalid one) and whether resolving it would return a value.
 */
async function probeCredential(
  ctx: Context, apiKeyEnv: string,
): Promise<{ ref: CredentialRef | undefined; configured: boolean }> {
  const ref = isCredentialRefName(apiKeyEnv) ? credentialRef(apiKeyEnv) : undefined
  if (ref === undefined) return { ref, configured: false }
  const credentials = ctx.get('credentials')
  // Without the seam the launch environment is the whole credential plane, and it
  // answers without awaiting anything.
  if (credentials === undefined) return { ref, configured: ambientApiKey(ctx, ref) !== undefined }
  try {
    return { ref, configured: (await credentials.describe(ref)).configured }
  } catch {
    return { ref, configured: false }
  }
}

/**
 * Record one credential observation on the provider. The probe is deliberately
 * not awaited by its callers: `available()` is synchronous, so the answer can
 * only ever arrive as a later update, and a slow or failing store must not delay
 * a search.
 * @param ctx - plugin context supplying the credential and environment planes.
 * @param apiKeyEnv - the section's credential reference.
 * @param provider - the provider whose availability this observation describes.
 */
function refreshCredentialPresence(
  ctx: Context, apiKeyEnv: string, provider: BraveSearchProvider,
): void {
  void probeCredential(ctx, apiKeyEnv).then((observation) => {
    provider.observeCredential(observation.ref, observation.configured)
  })
}

/** Register the Brave search provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  const provider = new BraveSearchProvider(() => resolveOptions(ctx, {
    apiKey: config.apiKey.get(), apiKeyEnv: config.apiKeyEnv.get(), baseURL: config.baseURL.get(),
    maxResults: config.maxResults.get(), timeoutMs: config.timeoutMs.get(),
  }))
  ctx.web.registerSearchProvider(provider)
  // Every observation about this section's reference arrives here: once at load,
  // then on each committed change the credentials seam reports. The listener is
  // fiber-scoped, so it is disposed with this plugin like the registration is.
  const refresh = (): void => { refreshCredentialPresence(ctx, config.apiKeyEnv.get(), provider) }
  refresh()
  ctx.on('credentials/reference-updated', (ref) => {
    if (ref === config.apiKeyEnv.get()) refresh()
  })
}
