/**
 * The Host-side surface of the `tiers` route: `ctx.modelRouting` and its Remote
 * methods.
 *
 * The service owns everything that outlives one request — the adapter
 * registration, the projection registration, the two `agent/request` rewrites,
 * and the quote/free-budget queries the settings page reads. It is the plugin
 * class itself, so unloading it withdraws the route, the projection, and the
 * service together rather than leaving any of them half-registered.
 *
 * @module dsh-experimental-model-routing/service
 */

import type { Context } from '@deepseek-ai/cordis'
import { attributionHeaders } from '@deepseek-ai/dsh-llm'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
// The projections this service folds over, read but never written.
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { tokenUsageProjectionDefinition } from '@deepseek-ai/dsh-token-meter'
import type { TokenUsageState } from '@deepseek-ai/dsh-token-meter'
// The `agent/request` seam this service rewrites.
import type {} from '@deepseek-ai/dsh-agent'
// `ctx.llmRetryControl`: the asks that end a pending retry wait, so a switch the
// person just flipped applies to an attempt already scheduled.
import type {} from '@deepseek-ai/dsh-llm-retry'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { fetchOpenRouterEndpoints, fetchOpenRouterModelCatalog } from '@deepseek-ai/dsh-llm-pi-ai'
import { TiersAdapter } from './adapter.ts'
import { routingDirectOf, routingEndpointOf } from './endpoint.ts'
import { Config, directSourceModels, readSettings, validateSettings } from './config.ts'
import type { RoutingSettings, TierSettingsSnapshot } from './config.ts'
import { resolveApiKeyRef } from './credentials.ts'
import { EndpointsCache } from './endpoints-cache.ts'
import { FamilyCache } from './family-cache.ts'
import { askJudge } from './judge.ts'
import { KeyInfo } from './key-info.ts'
import { modelRoutingProjectionDefinition } from './projection.ts'
import { DiagnosticsFile } from './diagnostics.ts'
import { defaultMix, directSourcesOf, isDirect, policyFor, rankWithRelaxation } from './select.ts'
import type { EndpointLists } from './select.ts'
import type { FreeUsage, ModelQuote, ModelRoutingControl, ModelRoutingState } from './types.ts'

/** The most models one `quote` call may price at once. */
const QUOTE_MODEL_LIMIT = 50

/** The `tiers` route, its settings, and `ctx.modelRouting`. */
export class ModelRoutingService extends TypertRemoteService implements ModelRoutingControl {
  static inject = ['llm']
  static Config = Config

  private modelRoutingHandle: ProjectionHandle<ModelRoutingState> | undefined
  private tokenUsageHandle: ProjectionHandle<TokenUsageState> | undefined
  private readonly adapter: TiersAdapter
  private readonly endpoints: EndpointsCache
  private readonly catalog: FamilyCache
  private readonly keyInfo: KeyInfo

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'modelRouting')
    // A settings value the route cannot act on is a configuration fault, and it
    // fails here rather than on the first request of a session.
    validateSettings(readSettings(config))
    const settings = (): RoutingSettings => {
      const value = readSettings(config)
      validateSettings(value)
      return value
    }
    const now = (): number => Date.now()
    this.endpoints = new EndpointsCache(
      (model, signal) => fetchOpenRouterEndpoints(model, {
        baseURL: config.baseUrl,
        timeoutMs: settings().endpointsTimeoutMs,
        signal,
      }),
      now,
    )
    this.catalog = new FamilyCache(
      signal => fetchOpenRouterModelCatalog({
        baseURL: config.baseUrl,
        timeoutMs: settings().catalogTimeoutMs,
        signal,
      }),
      now,
    )
    this.keyInfo = new KeyInfo({
      fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
      now,
      baseUrl: () => config.baseUrl,
      apiKey: () => resolveApiKeyRef(ctx, config.apiKeyRef),
      headers: () => attributionHeaders(),
    })
    const diagnostics = new DiagnosticsFile({
      path: () => settings().diagnosticsPath,
      maxBytes: () => settings().diagnosticsMaxBytes,
      warn: (message) => { ctx.logger.warn(message) },
    })
    this.adapter = new TiersAdapter({
      settings,
      dispatch: () => ctx.get('piAiDispatch'),
      session: id => ctx.get('sessions')?.get(id),
      routingState: session => this.modelRoutingHandle?.stateOf(session),
      usage: (session) => {
        const totals = this.tokenUsageHandle === undefined ? undefined : this.tokenUsageHandle.stateOf(session).totals
        return totals === undefined
          ? undefined
          : {
            uncachedInputTokens: totals.uncachedInputTokens,
            outputTokens: totals.outputTokens,
            cacheReadTokens: totals.cacheReadTokens,
            cacheWriteTokens: totals.cacheWriteTokens,
          }
      },
      innerEfforts: async (model, route, signal) => {
        // A model the route's catalog does not describe has no effort vocabulary;
        // the request then simply carries none, which is what pi-ai would do.
        const info = await ctx.llm.resolveModelInfo(route, model, signal).catch(() => undefined)
        return info?.reasoning?.efforts.map(effort => String(effort.id))
      },
      innerCanDispatch: (model, route, signal) =>
        ctx.llm.resolveModelInfo(route, model, signal).then(() => true, () => false),
      endpoints: this.endpoints,
      catalog: this.catalog,
      keyInfo: this.keyInfo,
      judge: request => askJudge({
        ...request,
        fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
        now,
      }),
      apiKey: () => resolveApiKeyRef(ctx, config.apiKeyRef),
      headers: () => attributionHeaders(),
      now,
      diagnostics: (record) => { diagnostics.record(record) },
      warn: (message) => { ctx.logger.warn(message) },
    }, {
      routeName: config.routeName,
      routeLabel: config.routeLabel,
      innerRoute: config.innerRoute,
      decisionsUrl: config.decisionsUrl,
    })
    ctx.llm.registerAdapter([config.routeName], this.adapter)
    ctx.on('session/disposed', (session: Session) => { this.adapter.forget(session.id) })
    ctx.inject(['sessionProjections'], async (projectionCtx) => {
      this.modelRoutingHandle = await projectionCtx.sessionProjections.register(modelRoutingProjectionDefinition)
      this.tokenUsageHandle = await projectionCtx.sessionProjections.register(tokenUsageProjectionDefinition)
    })
    ctx.effect(() => () => {
      this.modelRoutingHandle = undefined
      this.tokenUsageHandle = undefined
    })
    ctx.effect(() => this.rewrites(ctx))
    this.warnEmptyCatalog(ctx)
    // `super(ctx, 'modelRouting')` already registered this instance under that
    // key, so `ctx.modelRouting` resolves without a second provide.
  }

  /**
   * The configured tier names, in configuration order.
   * @returns every tier name, empty while the route is dormant.
   */
  tierNames(): readonly string[] {
    return readSettings(this.config).tiers.map(tier => tier.name)
  }

  /**
   * Switch a Thread to a tier from its next model request.
   *
   * The decision is an event in the Project's own log rather than a field on the
   * Thread: a cold resume of a Thread rebuilds its composition from that log, so
   * an override held anywhere else would be lost on the next Host restart.
   * @param project - the Project Session whose log receives the override.
   * @param threadId - the Thread's child Session id.
   * @param tier - a configured tier name.
   * @throws Error naming the configured tiers when `tier` is not one of them.
   */
  setThreadTier(project: Session, threadId: string, tier: string): void {
    const names = this.tierNames()
    if (!names.includes(tier)) {
      throw new Error(`model-routing: unknown tier "${tier}"; configured tiers: ${names.join(', ')}`)
    }
    project.append('model-routing/tier-override', { threadId, tier }, { ignorable: true })
  }

  /**
   * Choose, for one Session, whether an exhausted subscription source may be
   * replaced by an OpenRouter candidate.
   *
   * The choice is recorded in the Session's own log, so it outlives a Host
   * restart and a cold resume; a Session that never chose keeps following the
   * deployment default.
   * @param session - the Session the choice belongs to.
   * @param enabled - true when an exhausted subscription may fall through to OpenRouter.
   */
  setOpenRouterFallback(session: Session, enabled: boolean): void {
    session.append('model-routing/openrouter-fallback', { enabled }, { ignorable: true })
    // A turn already waiting on a subscription cooldown scheduled that wait under
    // the previous choice, and nothing else would end it before the cooldown does:
    // the person who just overruled the choice would watch a spent subscription
    // hold the Session for the rest of the cooldown. Ending the wait resumes the
    // next attempt at once, and that attempt reads this value.
    this.ctx.get('llmRetryControl')?.wake(session.id)
  }

  /**
   * The Remote form of {@link setOpenRouterFallback}, for the composer chip.
   *
   * A browser surface knows the Session it renders but not the Host's Session
   * object, so the id crosses the wire and is resolved here.
   * @param request - the Session id the choice belongs to, and the value.
   * @throws RemoteError `model-routing/unknown-session` when the Host holds no such Session.
   */
  @Remote('setOpenRouterFallback')
  setSessionOpenRouterFallback(request: { sessionId: SessionId; enabled: boolean }): void {
    const session = this.ctx.get('sessions')?.get(request.sessionId)
    if (session === undefined) {
      throw new RemoteError('model-routing/unknown-session', `model-routing: session "${request.sessionId}" is not open`, {
        sessionId: request.sessionId,
      })
    }
    this.setOpenRouterFallback(session, request.enabled)
  }

  /**
   * Price what one tier's models would cost this turn.
   *
   * Under `snapshotPolicy: 'latest'` the reply prices the releases the route
   * would actually decide under rather than the ids the tier names, because the
   * price of an April snapshot says nothing about what an August one costs.
   * @param request - the tier to price under, and the model ids to price.
   * @returns one quote per resolved model, in tier order.
   * @throws RemoteError `model-routing/unknown-tier` for a tier no configuration names,
   *   `model-routing/too-many-models` past the request limit,
   *   `model-routing/invalid-settings` for a settings document no request could act on.
   */
  @Remote('quote')
  async quote(request: { tier: string; models: string[] }): Promise<ModelQuote[]> {
    const settings = readSettings(this.config)
    // A staged draft the settings card has not yet saved is validated only by
    // the schema; an invalid value it would admit (e.g. `unknownQuantization:
    // 'trusted'` with an emptied `trustedUnknownProviders`) must fail the same
    // way a real request would, or the card keeps quoting prices for a tier
    // that cannot actually be dispatched and hides the breakage from the person
    // about to save it.
    try {
      validateSettings(settings)
    } catch (error: unknown) {
      throw new RemoteError(
        'model-routing/invalid-settings',
        error instanceof Error ? error.message : String(error),
        {},
      )
    }
    const tier = settings.tiers.find(candidate => candidate.name === request.tier)
    if (tier === undefined) {
      throw new RemoteError(
        'model-routing/unknown-tier',
        `model-routing: no configured tier "${request.tier}"`,
        { tier: request.tier, configured: settings.tiers.map(entry => entry.name) },
      )
    }
    if (request.models.length > QUOTE_MODEL_LIMIT) {
      throw new RemoteError(
        'model-routing/too-many-models',
        `model-routing: quote accepts at most ${QUOTE_MODEL_LIMIT} models`,
        { limit: QUOTE_MODEL_LIMIT },
      )
    }
    const signal = new AbortController().signal
    const batch = settings.snapshotPolicy === 'latest'
      ? await this.catalog.resolve(request.models, settings.catalogTtlMs, signal)
      : {
        resolutions: request.models.map(model => ({ configured: model, resolved: model, moved: false })),
        unreadable: false,
      }
    const models = batch.resolutions.map(resolution => resolution.resolved)
    const lists = await this.endpoints.read(models, settings.endpointsTtlMs, signal)
    return models.map(model => quoteOne(model, lists, tier, settings))
  }
  /**
   * The account's remaining free-model requests for today.
   * @returns the budget, or `null` when no key is stored or the read failed.
   */
  @Remote('freeUsage')
  async freeUsage(): Promise<FreeUsage | null> {
    const usage = await this.keyInfo.freeUsage(this.config.keyInfoTtlMs.get(), new AbortController().signal)
    return usage ?? null
  }

  /** The two `agent/request` rewrites: the preset's model, and a Thread's tier override. */
  private rewrites(ctx: Context): () => void {
    return ctx.on('agent/request', async ({ agent }: { agent: Agent }, next: () => Promise<LlmCallConfig>) => {
      const proposed = await next()
      const modelRoutingHandle = this.modelRoutingHandle
      if (modelRoutingHandle === undefined) return proposed
      const settings = readSettings(this.config)
      let result = proposed
      const presetRoute = settings.presetRoutes.find(route => route.preset === presetOf(ctx, agent.session))
      const own = modelRoutingHandle.stateOf(agent.session)
      if (presetRoute !== undefined && !own.explicitSelection) {
        // The effort belongs to the route the proposal came from, and a tier never
        // chose it, so it is dropped rather than forwarded.
        const { reasoningEffort: _dropped, ...rest } = proposed
        result = { ...rest, provider: this.config.routeName, model: presetRoute.model }
      }
      const parentId = agent.session.header.parentSession
      const parent = parentId === undefined ? undefined : ctx.get('sessions')?.get(parentId)
      const override = parent === undefined
        ? undefined
        : modelRoutingHandle.stateOf(parent).overrides[agent.id]
      if (override !== undefined && result.provider === this.config.routeName && result.model !== override) {
        result = { ...result, model: override }
      }
      return result
    })
  }

  /** One warning per mount when the model list cannot be described. */
  private warnEmptyCatalog(ctx: Context): void {
    const tiers = this.config.tiers.get()
    if (tiers.length === 0) return
    try {
      if (this.adapter.catalog(this.config.routeName).length > 0) return
    } catch (error: unknown) {
      // An empty catalog is what the picker shows when settings are unusable;
      // the log is where the operator learns why it is empty.
      ctx.logger.warn(`model-routing: the model list for route "${this.config.routeName}" is empty: ${String(error)}`)
      return
    }
    ctx.logger.warn(`model-routing: the model list for route "${this.config.routeName}" is empty`)
  }
}

/** The preset a Session effectively runs, or `undefined` when the preset registry is absent. */
function presetOf(ctx: Context, session: Session): string | undefined {
  // A composition without the preset package leaves the service unregistered;
  // that is capability absence, not a fault to propagate into every request.
  return ctx.get('agentPresets')?.presetForSession(session) ?? undefined
}

/**
 * Price one model under one tier's filters.
 *
 * The tier's `extraSources` candidates for this model ride the same ranking as
 * the OpenRouter endpoints, so a quote says what the model would cost this turn
 * whichever source serves it — and `total` counts both kinds of candidate.
 */
function quoteOne(
  model: string,
  lists: EndpointLists,
  tier: TierSettingsSnapshot,
  settings: RoutingSettings,
): ModelQuote {
  const list = lists.get(model)
  if (list === undefined || list instanceof Error) {
    return { model, eligible: 0, total: 0, error: list instanceof Error ? list.message : 'no endpoint list' }
  }
  const extraSources = tier.extraSources.flatMap(source =>
    directSourcesOf(source, directSourceModels(source)).filter(candidate => candidate.model === model))
  const result = rankWithRelaxation(
    lists,
    [model],
    policyFor(tier, settings, {
      allowFree: true,
      excludedTags: new Set(),
      ...extraSources.length === 0 ? {} : { extraSources: new Map([[model, extraSources]]) },
    }),
    defaultMix(settings),
  )
  const best = result.ranked[0]
  return {
    model,
    ...best === undefined ? {} : {
      endpoint: isDirect(best.endpoint) ? routingDirectOf(best.endpoint) : routingEndpointOf(best.endpoint),
      blendedUsdPerToken: best.blendedUsdPerToken,
    },
    eligible: result.ranked.length,
    total: list.length + extraSources.length,
  }
}
