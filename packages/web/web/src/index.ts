/**
 * Service Definition for the web access capability seam (`ctx.web`): registries and provider-selecting execution for search and
 * fetch. Duplicate ids are rejected. At execution time, a configured provider must exist and
 * be usable; without one, exactly one usable provider is required, so selection never depends
 * on registration order.
 * @module @deepseek-ai/dsh-web
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Volatile } from '@deepseek-ai/cosmokit'
import type {
  WebFetchProvider,
  WebFetchRequest,
  WebFetchResult,
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
} from './types.ts'
import { WebError } from './types.ts'

export {
  WebError,
} from './types.ts'
export type {
  WebFetchBody,
  WebFetchProvider,
  WebFetchRequest,
  WebFetchResult,
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from './types.ts'

/**
 * Search provider ids this Harness ships, for a settings surface to render as a
 * choice. The list is the KNOWN ids, not the accepted ones: `WebRuntime`
 * registers any plugin's id, so a configuration naming an id that is absent from
 * this list must still load and fail at selection time with
 * `WEB_PROVIDER_CONFIGURED_MISSING` rather than be refused by the schema. Adding
 * a provider package means adding its id here.
 */
export const WEB_SEARCH_PROVIDER_IDS = [
  'brave',
  'deepseek-official',
  'duckduckgo',
  'exa',
  'perplexity',
  'tavily',
] as const

/**
 * One shipped search provider id. Widened with `string` so a configuration, a
 * third-party provider, or a newer id still typechecks; the seam rejects an
 * unregistered id at selection with its own diagnostic.
 */
export type WebSearchProviderId = typeof WEB_SEARCH_PROVIDER_IDS[number] | (string & {})

/** Fetch provider ids this Harness ships. See {@link WEB_SEARCH_PROVIDER_IDS}. */
export const WEB_FETCH_PROVIDER_IDS = ['http'] as const

/** One shipped fetch provider id. Widened as {@link WebSearchProviderId} is. */
export type WebFetchProviderId = typeof WEB_FETCH_PROVIDER_IDS[number] | (string & {})

declare module '@deepseek-ai/cordis' {
  interface Context {
    web: WebRuntime
  }
}

/** Selection inputs for execution-time provider resolution. */
interface Selection<P> {
  /** The configured provider id for this capability, if any. */
  readonly configuredId?: string
  /** Providers registered for this capability kind. */
  readonly providers: ReadonlyMap<string, P>
}

/**
 * Selection config for the web seam. `searchProvider` / `fetchProvider` pin
 * which provider wins for each capability; both are optional (a single
 * registered usable provider auto-selects). Operational overrides such as
 * environment variables must feed these same fields rather than introduce a
 * hidden priority chain.
 *
 * This is the shape a profile patch, a settings write, or a direct
 * `ctx.plugin(WebRuntime, ...)` supplies. Both fields are declared volatile in
 * {@link WebRuntime.Config}, so the Host actually resolves them to live
 * references it later rewrites in place — see {@link selectedId}, which accepts
 * either form.
 */
export interface WebRuntimeConfig {
  /** Explicit search provider id. Omitted = auto-select when exactly one usable. */
  readonly searchProvider?: WebSearchProviderId
  /** Explicit fetch provider id. Omitted = auto-select when exactly one usable. */
  readonly fetchProvider?: WebFetchProviderId
}

/** One selection field as it can arrive: a plain id, or the Host's live reference to one. */
type WebSelection = WebRuntimeConfig['searchProvider'] | Volatile<string | undefined>

/**
 * The web access service. Registered as `ctx.web` (one instance per context).
 *
 * Selection is LIVE: the configured ids are Host-owned references committed in
 * place by a settings write, so {@link search} and {@link fetch} resolve against
 * the value each call, never against a construction-time snapshot.
 *
 * Selection semantics (resolved at execution time, never order-dependent):
 * - A configured id that is registered and `available()` → that provider.
 * - A configured id not registered → `WEB_PROVIDER_CONFIGURED_MISSING`.
 * - A configured id registered but unavailable →
 *   `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`.
 * - No id configured, exactly one registered usable provider → that provider.
 * - No id configured, multiple usable providers → `WEB_PROVIDER_AMBIGUOUS`.
 * - No id configured, no usable provider → `WEB_PROVIDER_UNAVAILABLE`.
 */
export class WebRuntime extends Service {
  /**
   * Selection config, live-editable. Operational env overrides feed the SAME
   * fields: `$DSH_WEB_SEARCH_PROVIDER` / `$DSH_WEB_FETCH_PROVIDER` are
   * equivalent to `searchProvider` / `fetchProvider` and are NOT a hidden
   * priority chain. Both fields stay open strings so an id this build does not
   * know still reaches {@link resolveProvider} and reports itself there.
   *
   * The schema is deliberately NOT annotated `z<WebRuntimeConfig>`: Schemastery
   * types a volatile field as its storage type, so such a pin would claim plain
   * strings where the Host actually supplies live references. Every other
   * volatile plugin here (brave, tavily, deepseek) carries the same split.
   */
  static Config = z.object({
    searchProvider: z.string().volatile(),
    fetchProvider: z.string().volatile(),
  })

  private searchProviders = new Map<string, WebSearchProvider>()
  private fetchProviders = new Map<string, WebFetchProvider>()
  private readonly searchProviderId: WebSelection
  private readonly fetchProviderId: WebSelection

  constructor(ctx: Context, config: WebRuntimeConfig = {}) {
    super(ctx, 'web')
    // Keep the references, never their current values: the Host writes a new
    // value into these exact objects when the setting changes.
    this.searchProviderId = config.searchProvider
    this.fetchProviderId = config.fetchProvider
  }

  /**
   * Register a search provider. Throws {@link WebError} `WEB_DUPLICATE_PROVIDER`
   * if its id is already registered for search. Returns a disposer; disposed
   * with the calling fiber.
   * @param provider - the provider; its `id` is the registry key.
   * @returns the disposer that unregisters the provider.
   */
  registerSearchProvider(provider: WebSearchProvider): () => void {
    return this.registerProvider(this.searchProviders, provider)
  }

  /**
   * Register a fetch provider. Throws {@link WebError} `WEB_DUPLICATE_PROVIDER`
   * if its id is already registered for fetch. Returns a disposer; disposed
   * with the calling fiber.
   * @param provider - the provider; its `id` is the registry key.
   * @returns the disposer that unregisters the provider.
   */
  registerFetchProvider(provider: WebFetchProvider): () => void {
    return this.registerProvider(this.fetchProviders, provider)
  }

  private registerProvider<P extends { readonly id: string }>(store: Map<string, P>, provider: P): () => void {
    if (store.has(provider.id)) {
      throw new WebError(`a web provider with id "${provider.id}" is already registered`, 'WEB_DUPLICATE_PROVIDER')
    }
    const dispose = this.ctx.effect(function* () {
      store.set(provider.id, provider)
      yield () => store.delete(provider.id)
    }, 'web.registerProvider()')
    // ctx.effect's disposer returns Promise<void>; our disposer API is
    // synchronous fire-and-forget — discard the (always-resolved) promise.
    return () => void dispose()
  }

  /**
   * Run one search through the selected provider. Resolves the provider at call
   * time with the selection rules above; throws {@link WebError} when the
   * capability cannot run. The seam enforces `request.maxResults` on the result:
   * if the provider over-returns, `sources[]` is truncated and `truncated` set.
   * @param request - the query and optional result limit.
   * @param signal - optional cancellation signal forwarded to the provider.
   * @returns the provider's results, capped to `request.maxResults`.
   */
  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const configuredId = selectedId(this.searchProviderId, 'DSH_WEB_SEARCH_PROVIDER')
    const provider = resolveProvider({
      providers: this.searchProviders,
      ...configuredId !== undefined ? { configuredId } : {},
    })
    const result = await provider.search(request, signal)
    return capSources(result, request.maxResults)
  }

  /**
   * Retrieve one URL through the selected provider. Resolves the provider at
   * call time with the selection rules above; throws {@link WebError} when the
   * capability cannot run. A non-2xx response is a result, not a throw.
   * @param request - the URL plus retrieval options.
   * @param signal - optional cancellation signal forwarded to the provider.
   * @returns the retrieval outcome; non-2xx responses resolve descriptively.
   */
  async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
    const configuredId = selectedId(this.fetchProviderId, 'DSH_WEB_FETCH_PROVIDER')
    const provider = resolveProvider({
      providers: this.fetchProviders,
      ...configuredId !== undefined ? { configuredId } : {},
    })
    return provider.fetch(request, signal)
  }
}

/**
 * The id configured for one capability at this instant. Read at use time because
 * the Host commits a settings write into the same reference this runtime holds,
 * and because `$DSH_WEB_*` stays an equivalent override for an absent value
 * rather than a hidden priority chain.
 * @param field The configured id, or the live reference holding it.
 * @param envName The equivalent environment variable name.
 * @returns The id to configure selection with, or undefined to auto-select.
 */
function selectedId(field: WebSelection, envName: string): string | undefined {
  if (field === undefined) return process.env[envName]
  const configured = typeof field === 'string' ? field : field.get()
  return configured ?? process.env[envName]
}

interface ResolvableProvider {
  readonly id: string
  available(): boolean
}

/** Resolve the selected provider or throw the matching {@link WebError}. */
function resolveProvider<P extends ResolvableProvider>(selection: Selection<P>): P {
  const { configuredId, providers } = selection
  if (configuredId !== undefined) {
    const provider = providers.get(configuredId)
    if (!provider) {
      throw new WebError(`configured web provider "${configuredId}" is not registered`, 'WEB_PROVIDER_CONFIGURED_MISSING')
    }
    if (!provider.available()) {
      throw new WebError(`configured web provider "${configuredId}" is registered but unavailable`, 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE')
    }
    return provider
  }
  const usable = [...providers.values()].filter(provider => provider.available())
  const [single] = usable
  if (single === undefined) {
    throw new WebError('no usable web provider is registered', 'WEB_PROVIDER_UNAVAILABLE')
  }
  if (usable.length > 1) {
    const ids = usable.map(provider => provider.id).join(', ')
    throw new WebError(`multiple usable web providers are registered (${ids}); configure one explicitly`, 'WEB_PROVIDER_AMBIGUOUS')
  }
  return single
}

/** Enforce `maxResults` on a search result: truncate `sources[]` and flag it. */
function capSources(result: WebSearchResult, maxResults: number | undefined): WebSearchResult {
  if (maxResults === undefined || result.sources.length <= maxResults) return result
  return { ...result, sources: result.sources.slice(0, maxResults), truncated: true }
}

export default WebRuntime
