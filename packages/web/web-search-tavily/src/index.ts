/**
 * Tavily-backed `WebSearchProvider` plugin. It contributes a credentialed search
 * provider to the `ctx.web` registry without owning the service.
 *
 * The key is resolved once per search through the credentials seam, falling back
 * to the launching environment, so a key the user pastes into Settings > Web
 * search reaches the next search without a restart. Unlike the sibling DeepSeek
 * provider, `available()` answers from a resolution that actually completed
 * instead of from the existence of a resolver, so this provider never advertises
 * itself while no key can be sent.
 * @module @deepseek-ai/dsh-web-search-tavily
 */

import type { Volatile } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { credentialRef, isCredentialRefName } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type {} from '@deepseek-ai/dsh-web'
import {
  TavilySearchProvider,
  TAVILY_DEFAULT_ENDPOINT,
  TAVILY_DEFAULT_MAX_CONTENT_CHARS,
  TAVILY_DEFAULT_MAX_RESULTS,
  TAVILY_DEFAULT_TIMEOUT_MS,
  TAVILY_SETTINGS_NAMESPACE,
} from './provider.ts'
import type { TavilySearchProviderOptions } from './provider.ts'

export {
  TAVILY_DEFAULT_ENDPOINT,
  TAVILY_DEFAULT_MAX_CONTENT_CHARS,
  TAVILY_DEFAULT_MAX_RESULTS,
  TAVILY_DEFAULT_TIMEOUT_MS,
  TAVILY_PROVIDER_ID,
  TAVILY_SETTINGS_NAMESPACE,
  TavilySearchProvider,
  boundContent,
  mapTavilyResponse,
  mapTavilyResult,
  tavilyErrorDetail,
} from './provider.ts'
export type { TavilySearchProviderOptions } from './provider.ts'
export type { TavilyResult, TavilySearchResponse } from './types.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-tavily'

/** The web seam this provider registers into. */
export const inject = ['web']

/**
 * Settings namespace carrying this provider's endpoint, result bound, snippet
 * bound, and credential reference. A settings page binds to this name, and it is
 * the name the Web settings card already lists for this provider.
 */
export const WEB_SEARCH_TAVILY_SETTINGS_NAMESPACE = TAVILY_SETTINGS_NAMESPACE

/** Credential reference used when the section names none. */
const DEFAULT_API_KEY_ENV = 'TAVILY_API_KEY'

/** Plugin config (every field optional — the schema carries the defaults). */
export interface Config {
  /** Literal Tavily API key; prefer {@link apiKeyEnv} so no secret enters configuration files. */
  apiKey: Volatile<string | undefined>
  /** Credential reference resolved for each search; defaults to `TAVILY_API_KEY`. */
  apiKeyEnv: Volatile<string>
  /** Full search endpoint, path included. Defaults to `https://api.tavily.com/search`. */
  baseURL: Volatile<string>
  /** Result count requested when a search carries no bound of its own. Defaults to 5. */
  numResults: Volatile<number>
  /** Request timeout in milliseconds. Defaults to 15000. */
  timeoutMs: Volatile<number>
  /** Character cap on one result's snippet; Tavily's extracted page text can be long. Defaults to 2000. */
  maxContentChars: Volatile<number>
}

export const Config = z.object({
  apiKey: z.string().role('secret').volatile(),
  // The defaults are declared here rather than only at the use site: a
  // configuration surface renders the resolved section, so a default the schema
  // does not carry reads there as no value at all.
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV).volatile(),
  baseURL: z.string().default(TAVILY_DEFAULT_ENDPOINT).volatile(),
  numResults: z.number().step(1).min(1).default(TAVILY_DEFAULT_MAX_RESULTS).volatile(),
  timeoutMs: z.number().step(1).min(1).default(TAVILY_DEFAULT_TIMEOUT_MS).volatile(),
  maxContentChars: z.number().step(1).min(1).default(TAVILY_DEFAULT_MAX_CONTENT_CHARS).volatile(),
})

/** The currently authoritative configuration section, with every default filled in. */
type ConfigSection = { [K in keyof Config]: ReturnType<Config[K]['get']> }

/**
 * The plugin's last completed credential answer, kept outside the options thunk
 * because `available()` is synchronous: it reports what a resolution actually
 * returned, and which reference that answer describes, so a section that has
 * since named a different reference cannot inherit the old answer.
 */
interface CredentialAnswer {
  name: string | undefined
  present: boolean
}

/** Read the authoritative section from the config fields. */
function readSection(config: Config): ConfigSection {
  return {
    apiKey: config.apiKey.get(),
    apiKeyEnv: config.apiKeyEnv.get(),
    baseURL: config.baseURL.get(),
    numResults: config.numResults.get(),
    timeoutMs: config.timeoutMs.get(),
    maxContentChars: config.maxContentChars.get(),
  }
}

/**
 * The credential reference a configured name denotes, or `undefined` when that
 * name is outside the reference grammar. A typo in settings must not throw while
 * the plugin stays mounted, and a name that cannot be a reference also has
 * nothing to resolve — which is what keeps such a section unavailable.
 *
 * @param apiKeyEnv - the configured reference name.
 * @returns the branded reference, or `undefined` for a name that cannot be one.
 */
function refOf(apiKeyEnv: string): CredentialRef | undefined {
  return isCredentialRefName(apiKeyEnv) ? credentialRef(apiKeyEnv) : undefined
}

/**
 * Resolve one reference to its current value, with the precedence the provider
 * uses per search: the credentials service when it is mounted, and the launching
 * environment — the whole credential plane — when it is not.
 *
 * @param ctx - plugin context supplying the credential and environment planes.
 * @param ref - the reference to resolve.
 * @returns the value, or `undefined` while no layer supplies one.
 */
async function resolveKey(ctx: Context, ref: CredentialRef): Promise<string | undefined> {
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) return (await credentials.resolve(ref))?.value
  const ambient = launchEnvironmentOf(ctx).get(ref)
  return ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined
}

/**
 * Project one resolved section into the options the provider serves its next
 * search with. Environment fallbacks stay here rather than in the provider:
 * every value it reads is already fully defaulted.
 *
 * @param ctx - plugin context supplying the credential and environment planes.
 * @param section - the currently authoritative section.
 * @param answer - the plugin's last completed credentials-service answer.
 * @returns options for one search.
 */
function resolveOptions(
  ctx: Context, section: ConfigSection, answer: CredentialAnswer,
): TavilySearchProviderOptions {
  const literalApiKey = section.apiKey !== undefined && section.apiKey.length > 0
    ? section.apiKey
    : undefined
  return {
    ...literalApiKey === undefined ? {} : { apiKey: literalApiKey },
    // A configured name outside the reference grammar never reaches here: such a
    // section is unavailable, and an unavailable provider is never dispatched.
    resolveApiKey: () => resolveKey(ctx, credentialRef(section.apiKeyEnv)),
    credentialName: section.apiKeyEnv,
    endpoint: section.baseURL,
    maxResults: section.numResults,
    timeoutMs: section.timeoutMs,
    maxContentChars: section.maxContentChars,
    ambientKeyPresent: ambientKeyPresent(ctx, section.apiKeyEnv),
    credentialAnswerName: answer.name,
    credentialPresent: answer.present,
  }
}

/**
 * Whether the launch environment already supplies a value for a reference name.
 * This half needs no await and so is read fresh on every check; it is the reason
 * a composition that exports the key is usable the instant it mounts.
 *
 * @param ctx - plugin context supplying the environment plane.
 * @param apiKeyEnv - the configured reference name.
 * @returns whether the environment holds a non-empty value for it.
 */
function ambientKeyPresent(ctx: Context, apiKeyEnv: string): boolean {
  const ref = refOf(apiKeyEnv)
  if (ref === undefined) return false
  const ambient = launchEnvironmentOf(ctx).get(ref)
  return ambient !== undefined && ambient.value.length > 0
}

/** Register the Tavily search provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  // The credentials seam answers asynchronously, so its verdict is recorded
  // here rather than recomputed per check: it is a fact about a resolution that
  // actually completed, together with the reference that resolution described.
  const answer: CredentialAnswer = { name: undefined, present: false }

  /** Resolve the reference the current section names and record what came back. */
  const refresh = async (): Promise<void> => {
    const ref = refOf(config.apiKeyEnv.get())
    answer.name = ref
    answer.present = ref !== undefined && (await resolveKey(ctx, ref)) !== undefined
  }

  void refresh()
  // A composition may mount this provider before its credentials seam, so the
  // first answer is taken whenever the seam appears — and again if it is ever
  // replaced by a provider that reads different storage.
  ctx.inject({ credentials: null }, () => { void refresh() })

  // A key written from anywhere — the Web search page, the Models page, an
  // external edit of the store — commits as this event, so the answer is re-read
  // rather than left stale until the next search happens to run.
  ctx.on('credentials/reference-updated', (ref) => {
    if (ref === answer.name) void refresh()
  })

  ctx.web.registerSearchProvider(new TavilySearchProvider(() => resolveOptions(ctx, readSection(config), answer)))
}
