/**
 * The `tiers` LLM route: an adapter that answers every model request with a
 * decision, not with a fixed provider.
 *
 * The route is virtual in exactly one way: it appears to the rest of DSH as a
 * provider whose models are `auto`, the configured tiers, and the individual
 * favorites inside them, while the request always leaves under the inner pi-ai
 * route with a `provider` block pinned to one upstream provider. That is what
 * keeps the composer's heading at `tiers/<…>` — a concrete model substituted into
 * the request instead would break the model-selection accounting and inject a
 * "[model changed]" notice into every step.
 *
 * Two rules shape everything below. The decision is taken **at boundaries only**
 * (see `boundary.ts`), because changing model or provider invalidates the prompt
 * cache and a cache miss costs about six times a cache hit. And when an endpoint
 * fails, the re-decision prefers *another provider of the same model* before any
 * other model is considered, because switching model mid-dialog is the one outcome
 * the whole design exists to avoid.
 *
 * @module dsh-experimental-model-routing/adapter
 */

import { LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmModelReasoningInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { OpenRouterEndpoint, OpenRouterRoutingBlock, PiAiDispatch } from '@deepseek-ai/dsh-llm-pi-ai'
import type { Session, SessionEventMap, SessionId } from '@deepseek-ai/dsh-session'
import { boundaryOf } from './boundary.ts'
import type { RoutingSettings, TierSettingsSnapshot } from './config.ts'
import { mapEffort } from './effort.ts'
import type { EndpointsCache } from './endpoints-cache.ts'
import type { FamilyCache } from './family-cache.ts'
import type { FamilyResolution } from './family.ts'
import { routingEndpointOf } from './endpoint.ts'
import { judgeQuestions, judgeState, tierFromVerdict } from './judge.ts'
import type { JudgeRequest } from './judge.ts'
import type { KeyInfo } from './key-info.ts'
import { quantizationsAtOrAbove } from './quantization.ts'
import { unwrapHistory, wrapReplay } from './replay.ts'
import { defaultMix, mixFromUsage, policyFor, rankWithRelaxation } from './select.ts'
import type { UsageTotals } from './select.ts'
import type { JudgeRule, JudgeVerdict, ModelRoutingState, RoutingBoundary } from './types.ts'

/** Machine code for a tier whose endpoint lists could not be read at all. */
export const MODEL_ROUTING_UNAVAILABLE_CODE = 'MODEL_ROUTING_UNAVAILABLE'

/** Machine code for a tier with endpoints, none of which pass the filters. */
export const MODEL_ROUTING_NO_ENDPOINT_CODE = 'MODEL_ROUTING_NO_ENDPOINT'

/** What the caller asked for, resolved against the configured tiers. */
type RequestedTarget =
  | { kind: 'auto' }
  | { kind: 'tier'; tier: string }
  | { kind: 'fixed'; tier: string; model: string }

/** What the route currently has pinned for one session. */
interface Pin {
  requested: string
  tier: string
  model: string
  endpoint?: OpenRouterEndpoint
  block: OpenRouterRoutingBlock
  lastActivityAt?: number
}

/** Everything the adapter reads from the host, injected so tests need no Cordis. */
export interface TiersAdapterDeps {
  /** `readSettings` plus `validateSettings`; throws on an unusable configuration. */
  settings(): RoutingSettings
  /** The pi-ai dispatch service, when `dsh-llm-pi-ai` is loaded. */
  dispatch(): PiAiDispatch | undefined
  /** The live Session registry. */
  session(id: SessionId): Session | undefined
  /** The folded `modelRouting` state of one Session. */
  routingState(session: Session): ModelRoutingState | undefined
  /** The session's measured token spend, from the token-usage projection. */
  usage(session: Session): UsageTotals | undefined
  /** Reasoning efforts the inner route's model actually supports. */
  innerEfforts(model: string, signal: AbortSignal): Promise<readonly string[] | undefined>
  endpoints: EndpointsCache
  /** The whole OpenRouter catalog, read behind a cache; decides which snapshot a configured id names. */
  catalog: FamilyCache
  keyInfo: KeyInfo
  /** One judge call, with `fetch` and `now` already bound by the host. */
  judge(request: Omit<JudgeRequest, 'fetch' | 'now'>): Promise<Omit<JudgeVerdict, 'rule'>>
  apiKey(): Promise<string | undefined>
  headers(): Readonly<Record<string, string>>
  now(): number
  warn(message: string): void
}

/**
 * The route's own configuration, which is non-volatile: changing any of it
 * remounts the plugin, so an adapter instance may hold these for its whole life.
 */
export interface TiersRoute {
  /** The route key requests name, `tiers` by default. */
  routeName: string
  /** The group label the model picker shows. */
  routeLabel: string
  /** The pi-ai route every resolved request is dispatched through. */
  innerRoute: string
  /** The Decisions API endpoint the judge posts to. */
  decisionsUrl: string
}

/** The session-less requests the adapter serves share one pin slot. */
const NO_SESSION_KEY = ''

/** Finish reasons that carry no provider failure worth rerouting around. */
const SUCCESSFUL_FINISH = new Set(['stop', 'tool-calls', 'max-tokens'])

/** The next UTC midnight, the instant a free-endpoint block expires. */
function nextUtcMidnight(now: number): number {
  const day = 86_400_000
  return now - (now % day) + day
}

/** Every input modality a tier advertises, as the catalog spells them. */
function modalitiesOf(tier: TierSettingsSnapshot): readonly ('text' | 'image')[] {
  return [...tier.input]
}

/** The tier-level effort vocabulary, branded the way the catalog spells it. */
function tierEfforts(settings: RoutingSettings): LlmModelReasoningInfo['efforts'] {
  return settings.efforts.map(id => ({ id: ReasoningEffortId(id), name: id }))
}

/** The `sort: 'price'` block a tier falls back to when its lists cannot be read. */
function unpinnedBlock(tier: TierSettingsSnapshot): OpenRouterRoutingBlock {
  return {
    sort: 'price',
    quantizations: quantizationsAtOrAbove(tier.minQuantization, tier.unknownQuantization !== 'reject'),
    allow_fallbacks: true,
  }
}

/** One decision, before it becomes a pin. */
interface Decision {
  pin: Pin
  payload: SessionEventMap['model-routing/decision']
}

/** Adapter serving the virtual `tiers` route. */
export class TiersAdapter extends LlmAdapter {
  private readonly pins = new Map<string, Pin>()
  private readonly failures = new Set<string>()
  private readonly excluded = new Map<string, Map<string, number>>()
  private readonly snapshots = new Map<string, string>()
  private readonly reported = new Set<string>()
  private freeBlockedUntil = 0

  constructor(
    private readonly deps: TiersAdapterDeps,
    private readonly route: TiersRoute,
  ) {
    super()
  }

  /**
   * Drop everything pinned for a Session that is gone.
   *
   * A pin holds a model, an endpoint, and a set of recent failures for one
   * Session. Nothing else can observe when that Session ends, so the map would
   * grow for the life of the Host without this.
   * @param sessionId - the disposed Session's identity.
   */
  forget(sessionId: SessionId): void {
    this.pins.delete(sessionId)
    this.excluded.delete(sessionId)
    this.failures.delete(sessionId)
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.route.routeLabel }
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve().then(() => this.catalog(provider))
  }

  /**
   * What the model picker shows for this route, in C2's order.
   *
   * Synchronous so the plugin can check the catalog once per settings revision
   * without an async gap between reading the tiers and reporting an empty one.
   * @param provider - the route key, which every entry carries.
   * @returns the advertised models, empty while no tier is configured.
   */
  catalog(provider: string): readonly LlmModelInfo[] {
    const settings = this.deps.settings()
    const tiers = settings.tiers
    if (tiers.length === 0) return []
    const models: LlmModelInfo[] = []
    const push = (id: string, name: string, input: readonly ('text' | 'image')[]): void => {
      models.push({ provider, id, name, inputModalities: input })
    }
    if (settings.judgeEnabled && tiers.length >= 2) {
      // `auto` must describe the weakest tier: a caller that resolves it against
      // the strongest would be promised a context window no chosen model has.
      const weakest = tiers.reduce((low, tier) =>
        tier.contextWindow < low.contextWindow ? tier : low)
      push('auto', settings.autoLabel, modalitiesOf(weakest))
    }
    for (const tier of tiers) push(tier.name, tier.label, modalitiesOf(tier))
    const seen = new Set<string>()
    for (const tier of tiers) {
      for (const model of tier.models) {
        if (seen.has(model)) continue
        seen.add(model)
        push(model, model, modalitiesOf(tier))
      }
    }
    return models
  }

  override resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return Promise.resolve().then(() => this.modelInfoOf(provider, model))
  }

  private modelInfoOf(provider: string, model: string): LlmResolvedModelInfo {
    const settings = this.deps.settings()
    const tiers = settings.tiers
    const unknown = (): never => {
      throw new LlmError(`model-routing: route "${provider}" has no model "${model}"`, 'UNKNOWN_MODEL')
    }
    if (model === 'auto') {
      if (!settings.judgeEnabled || tiers.length < 2) return unknown()
      const narrowest = tiers.reduce((low, tier) =>
        tier.contextWindow < low.contextWindow ? tier : low)
      return {
        provider,
        id: model,
        name: settings.autoLabel,
        // The minimum across tiers: a decision could land on any of them, and a
        // larger promise would let compaction's threshold outrun the model.
        context: { contextWindow: Math.min(...tiers.map(tier => tier.contextWindow)) },
        defaultMaxTokens: Math.min(...tiers.map(tier => tier.maxTokens)),
        inputModalities: [...tiers.reduce<readonly ('text' | 'image')[]>(
          (input, tier) => input.filter(modality => tier.input.includes(modality)),
          modalitiesOf(narrowest),
        )],
        reasoning: {
          efforts: tierEfforts(settings),
          defaultEffort: ReasoningEffortId(settings.defaultEffort),
        },
      }
    }
    const tier = tiers.find(candidate => candidate.name === model)
    if (tier !== undefined) {
      return {
        provider,
        id: model,
        name: tier.label,
        context: { contextWindow: tier.contextWindow },
        defaultMaxTokens: tier.maxTokens,
        inputModalities: modalitiesOf(tier),
        reasoning: {
          efforts: tierEfforts(settings),
          defaultEffort: ReasoningEffortId(settings.defaultEffort),
        },
      }
    }
    // A favorite advertises the metadata of the first tier that lists it: that is
    // the tier whose filters will actually be applied to it.
    const owning = tiers.find(candidate => candidate.models.includes(model))
    if (owning === undefined) return unknown()
    return {
      provider,
      id: model,
      name: model,
      context: { contextWindow: owning.contextWindow },
      defaultMaxTokens: owning.maxTokens,
      inputModalities: modalitiesOf(owning),
      reasoning: {
        efforts: tierEfforts(settings),
        defaultEffort: ReasoningEffortId(settings.defaultEffort),
      },
    }
  }

  /** Rebuild a pin from a decision a previous Host instance wrote to this Session's log. */
  private restorePin(settings: RoutingSettings, decision: SessionEventMap['model-routing/decision']): Pin {
    const endpoint = decision.endpoint
    if (endpoint === undefined) {
      return {
        requested: decision.requested,
        tier: decision.tier,
        model: decision.model,
        block: unpinnedBlock(this.tierNamed(settings, decision.tier)),
      }
    }
    return {
      requested: decision.requested,
      tier: decision.tier,
      model: decision.model,
      endpoint: {
        slug: endpoint.tag,
        ...endpoint.providerName === undefined ? {} : { providerName: endpoint.providerName },
        ...endpoint.quantization === undefined ? {} : { quantization: endpoint.quantization },
        promptPrice: endpoint.promptUsd,
        completionPrice: endpoint.completionUsd,
        ...endpoint.cacheReadUsd === undefined ? {} : { inputCacheReadPrice: endpoint.cacheReadUsd },
        ...endpoint.contextLength === undefined ? {} : { contextLength: endpoint.contextLength },
        ...endpoint.maxCompletionTokens === undefined ? {} : { maxCompletionTokens: endpoint.maxCompletionTokens },
      },
      block: { only: [endpoint.tag], allow_fallbacks: false },
    }
  }

  /** Resolve what the request asked for against the configured tiers. */
  private resolveRequested(provider: string, model: string, settings: RoutingSettings): RequestedTarget {
    if (model === 'auto') return { kind: 'auto' }
    const tier = settings.tiers.find(candidate => candidate.name === model)
    if (tier !== undefined) return { kind: 'tier', tier: model }
    const owning = settings.tiers.find(candidate => candidate.models.includes(model))
    if (owning !== undefined) return { kind: 'fixed', tier: owning.name, model }
    throw new LlmError(`model-routing: route "${provider}" has no model "${model}"`, 'UNKNOWN_MODEL')
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const settings = this.deps.settings()
    const provider = options.provider
    const dispatch = this.deps.dispatch()
    if (dispatch === undefined) {
      throw new LlmError(
        `model-routing: route "${provider}" needs @deepseek-ai/dsh-llm-pi-ai (service piAiDispatch is absent)`,
        'NO_ADAPTER',
      )
    }
    const target = this.resolveRequested(provider, options.model, settings)
    const key = options.sessionId ?? NO_SESSION_KEY
    // Only an agent's own turn may re-decide and record. Compaction, session
    // titles and every other `purpose` call rides whatever the turn pinned.
    const main = options.purpose === undefined && options.sessionId !== undefined
    const session = options.sessionId === undefined ? undefined : this.deps.session(options.sessionId)
    const state = session === undefined ? undefined : this.deps.routingState(session)
    const consumer = new AbortController()
    const upstream = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal])
    try {
      yield* this.run({ settings, dispatch, options, target, key, main, session, state, signal: upstream })
    } finally {
      consumer.abort('model-routing stream consumer stopped')
    }
  }

  /** The request path, split out so `stream()` stays a thin lifecycle wrapper. */
  private async * run(input: {
    settings: RoutingSettings
    dispatch: PiAiDispatch
    options: GenerateOptions
    target: RequestedTarget
    key: string
    main: boolean
    session: Session | undefined
    state: ModelRoutingState | undefined
    signal: AbortSignal
  }): AsyncIterable<StreamChunk> {
    const { settings, dispatch, options, target, key, main, session, state, signal } = input
    let pin = this.pins.get(key)
    // A restart is not a boundary: the log already recorded what this Session
    // decided, and re-deciding would pin a different provider than the one whose
    // prompt cache the history is still holding.
    if (pin === undefined && state?.decision != null) {
      pin = this.restorePin(settings, state.decision)
    }
    const boundary = main
      ? boundaryOf({
        pinned: pin,
        requested: options.model,
        failurePending: this.failures.has(key),
        compactedSinceDecision: state?.compactedSinceDecision ?? false,
        lastActivityAt: Math.max(state?.lastResponseAt ?? Number.NEGATIVE_INFINITY, pin?.lastActivityAt ?? Number.NEGATIVE_INFINITY),
        now: this.deps.now(),
        cacheIdleMs: settings.cacheIdleMs,
      })
      : undefined
    if ((main && boundary !== undefined) || pin === undefined) {
      const decided = await this.decide({
        settings, target, pin, session, options, signal, persist: main, key,
        ...boundary === undefined ? {} : { boundary },
      })
      pin = decided.pin
      if (main) this.pins.set(key, pin)
    }
    yield* this.dispatchWithReroute({ settings, dispatch, options, pin, key, signal, main })
  }

  /** The tier a decision named; a decision always names a configured one. */
  private tierNamed(settings: RoutingSettings, name: string): TierSettingsSnapshot {
    const tier = settings.tiers.find(candidate => candidate.name === name)
    /* v8 ignore next -- a decision event is written from a configured tier, so a restored log always names one. */
    if (tier === undefined) throw new LlmError(`model-routing: no configured tier named "${name}"`, 'INVALID_CONFIG')
    return tier
  }

  /** Take one decision at a boundary, and record it when the Session asked for one. */
  private async decide(input: {
    settings: RoutingSettings
    target: RequestedTarget
    pin: Pin | undefined
    session: Session | undefined
    options: GenerateOptions
    signal: AbortSignal
    persist: boolean
    key: string
    boundary?: RoutingBoundary
  }): Promise<Decision> {
    const { settings, target, pin, session, options, signal, persist, key } = input
    const boundary = input.boundary ?? 'start'
    const current = pin?.tier
    let tierName: string
    let judge: JudgeVerdict | undefined
    if (target.kind === 'fixed') tierName = target.tier
    else if (target.kind === 'tier') tierName = target.tier
    else {
      const outcome = await this.judgeTier({ settings, options, signal, ...current === undefined ? {} : { current } })
      tierName = outcome.tier
      judge = outcome.verdict
    }
    const tier = this.tierNamed(settings, tierName)
    const models = await this.candidateModels(settings, target, tier, signal)
    const lists = await this.deps.endpoints.read(models, settings.endpointsTtlMs, signal)
    const allowFree = await this.freeAdmission({ settings, tier, session })
    const excludedTags = this.excludedTagsOf(key)
    const mix = mixFromUsage(
      session === undefined ? undefined : this.deps.usage(session),
      defaultMix(settings),
      settings.mixMinTokens,
    )
    const preferModel = pin !== undefined && pin.tier === tier.name && target.kind !== 'fixed' ? pin.model : undefined
    const result = rankWithRelaxation(
      lists,
      models,
      policyFor(tier, settings, { allowFree, excludedTags, ...preferModel === undefined ? {} : { preferModel } }),
      mix,
    )
    const best = result.ranked[0]
    let decidedModel: string
    let endpoint: OpenRouterEndpoint | undefined
    let block: OpenRouterRoutingBlock
    let unpinnedReason: string | undefined
    if (best !== undefined) {
      decidedModel = best.model
      endpoint = best.endpoint
      block = { only: [best.endpoint.slug], allow_fallbacks: false }
    } else if (result.unreadable.length === models.length && result.unreadable.length > 0) {
      const reasons = result.unreadable.map(entry => `${entry.model}: ${entry.reason}`).join('; ')
      if (settings.onEndpointsUnavailable === 'fail') {
        throw new LlmError(
          `model-routing: no endpoint list could be read for tier "${tier.name}": ${reasons}`,
          MODEL_ROUTING_UNAVAILABLE_CODE,
        )
      }
      const first = models[0]
      if (first === undefined) {
        // A tier with no models cannot reach here — `validateSettings` refuses
        // one — so this is the guard that keeps the branch total if it ever did.
        throw new LlmError(`model-routing: tier "${tier.name}" lists no models`, 'INVALID_CONFIG')
      }
      decidedModel = first
      block = unpinnedBlock(tier)
      unpinnedReason = reasons
    } else {
      const counts = Object.entries(result.rejections)
        .filter(([, count]) => count > 0)
        .map(([reason, count]) => `${reason}=${count}`)
        .join(', ')
      throw new LlmError(
        `model-routing: no endpoint of tier "${tier.name}" passes the filters: ${counts}`,
        MODEL_ROUTING_NO_ENDPOINT_CODE,
      )
    }
    const payload = {
      boundary,
      requested: options.model,
      tier: tier.name,
      ...judge === undefined ? {} : { judge },
      model: decidedModel,
      ...endpoint === undefined ? {} : { endpoint: routingEndpointOf(endpoint) },
      ...unpinnedReason === undefined ? {} : { unpinnedReason },
      ...best === undefined ? {} : { blendedUsdPerToken: best.blendedUsdPerToken },
      ...result.relaxedUptime ? { relaxedUptime: true as const } : {},
      considered: result.considered,
      runnersUp: result.ranked.slice(1, 4).map(entry => ({
        model: entry.model,
        tag: entry.endpoint.slug,
        blendedUsdPerToken: entry.blendedUsdPerToken,
      })),
      excludedTags: [...excludedTags].sort(),
    }
    if (persist && session !== undefined) {
      try {
        session.append('model-routing/decision', payload, { ignorable: true })
      } catch (error: unknown) {
        // The request is worth more than the record of it: a Session that cannot
        // take the event still needs this turn to run, and the next boundary
        // will decide again anyway.
        this.deps.warn(`model-routing: could not record the decision for session ${session.id}: ${String(error)}`)
      }
    }
    this.failures.delete(key)
    const next: Pin = {
      requested: options.model,
      tier: tier.name,
      model: decidedModel,
      ...endpoint === undefined ? {} : { endpoint },
      block,
    }
    return { pin: next, payload }
  }

  /**
   * The model ids one decision ranks over.
   *
   * Under `latest` a tier's list is a list of *families* rather than releases,
   * which is the only way an unversioned id such as `deepseek/deepseek-v4-pro`
   * stops meaning the April snapshot forever. A request that named one of those
   * ids itself is resolved the same way, because the model picker offers the ids
   * a tier lists and picking `deepseek/deepseek-v4-pro` there means the pro
   * model, not one release of it. A deployment that wants a tier to stay on an
   * exact release says so with `snapshotPolicy: 'pinned'`.
   * @param settings - the whole settings value.
   * @param target - what this request asked for.
   * @param tier - the tier the decision landed on.
   * @param signal - the request's cancellation.
   * @returns the ids to rank, in tier order.
   */
  private async candidateModels(
    settings: RoutingSettings,
    target: RequestedTarget,
    tier: TierSettingsSnapshot,
    signal: AbortSignal,
  ): Promise<string[]> {
    const configured = target.kind === 'fixed' ? [target.model] : [...tier.models]
    if (settings.snapshotPolicy !== 'latest') return configured
    const batch = await this.deps.catalog.resolve(tier.models, settings.catalogTtlMs, signal)
    if (batch.unreadable) {
      // The turn still has to be decided, and the configured ids are the ones
      // every other part of the deployment names, so the catalog failing is not
      // a reason to refuse.
      this.warnOnce(
        'catalog',
        'model-routing: the OpenRouter model catalog could not be read, so tiers are deciding under'
        + ' their configured model ids',
      )
      return configured
    }
    for (const resolution of batch.resolutions) this.announce(resolution)
    return batch.resolutions.map(resolution => resolution.resolved)
  }

  /**
   * Report a model id that now names a different release than it did last time.
   *
   * A decision runs on every boundary of every turn, so the remembered value is
   * what keeps this to one line per move: a route that re-announced an unchanged
   * resolution would bury the one line that says a tier changed models.
   * @param resolution - one configured id and the release it resolved to.
   */
  private announce(resolution: FamilyResolution): void {
    if (!resolution.moved || this.snapshots.get(resolution.configured) === resolution.resolved) return
    this.snapshots.set(resolution.configured, resolution.resolved)
    this.deps.warn(
      `model-routing: "${resolution.configured}" now resolves to "${resolution.resolved}",`
      + ' the newest snapshot of its family',
    )
  }

  /**
   * Report a condition once for the life of this adapter.
   * @param key - what identifies the condition.
   * @param message - the line to log the first time it is seen.
   */
  private warnOnce(key: string, message: string): void {
    if (this.reported.has(key)) return
    this.reported.add(key)
    this.deps.warn(message)
  }

  /** Whether this caller may spend a turn on a free endpoint right now. */
  private async freeAdmission(input: {
    settings: RoutingSettings
    tier: TierSettingsSnapshot
    session: Session | undefined
  }): Promise<boolean> {
    const { settings, tier, session } = input
    const subagent = session?.header.origin === 'subagent'
    let allowFree = (!subagent || settings.freeForSubagents) && this.deps.now() >= this.freeBlockedUntil
    if (allowFree && tier.free !== 'off') {
      const usage = await this.deps.keyInfo.freeUsage(settings.keyInfoTtlMs, new AbortController().signal)
      // An unreadable counter does not block free endpoints: refusing them on a
      // transport blip would cost more than the budget it protects.
      if (usage !== undefined && usage.remaining < settings.freeMinRemaining) allowFree = false
    }
    return allowFree
  }

  /** The tags this session's recent failures excluded, still live. */
  private excludedTagsOf(key: string): ReadonlySet<string> {
    const now = this.deps.now()
    const recorded = this.excluded.get(key)
    if (recorded === undefined) return new Set()
    const live = new Set<string>()
    for (const [tag, until] of recorded) if (until > now) live.add(tag)
    return live
  }

  /** Ask the judge, or fall back to the default tier when it cannot be asked. */
  private async judgeTier(input: {
    settings: RoutingSettings
    options: GenerateOptions
    signal: AbortSignal
    current?: string
  }): Promise<{ tier: string; verdict: JudgeVerdict }> {
    const { settings, options, signal, current } = input
    if (!settings.judgeEnabled) {
      return {
        tier: current ?? settings.defaultTier,
        verdict: { model: settings.judgeModel, latencyMs: 0, rule: 'judge-off' },
      }
    }
    const state = judgeState(options.messages, settings.judgeUserMessages, settings.judgeMaxStateChars)
    if (state === undefined) {
      return {
        tier: current ?? settings.defaultTier,
        verdict: { model: settings.judgeModel, latencyMs: 0, rule: 'judge-error', error: 'no user text' },
      }
    }
    const apiKey = await this.deps.apiKey()
    if (apiKey === undefined) {
      return {
        tier: current ?? settings.defaultTier,
        verdict: { model: settings.judgeModel, latencyMs: 0, rule: 'judge-error', error: 'no credential' },
      }
    }
    const answered = await this.deps.judge({
      url: this.route.decisionsUrl,
      apiKey,
      model: settings.judgeModel,
      state,
      questions: judgeQuestions(settings),
      proTier: settings.judgeProTier,
      timeoutMs: settings.judgeTimeoutMs,
      signal,
      headers: this.deps.headers(),
    })
    const { tier, rule } = tierFromVerdict(answered, current, settings)
    return { tier, verdict: { ...answered, rule } }
  }

  /** Stream one request, rerouting around an endpoint that fails before its first content. */
  private async * dispatchWithReroute(input: {
    settings: RoutingSettings
    dispatch: PiAiDispatch
    options: GenerateOptions
    pin: Pin
    key: string
    signal: AbortSignal
    /** Whether this is the agent's own turn, the only request allowed to leave a pin behind. */
    main: boolean
  }): AsyncIterable<StreamChunk> {
    const { settings, dispatch, options, key, signal, main } = input
    const tier = this.tierNamed(settings, input.pin.tier)
    let pin = input.pin
    for (let attempt = 0; ; attempt += 1) {
      const efforts = await this.deps.innerEfforts(pin.model, signal)
      const requestedMax = options.maxTokens ?? tier.maxTokens
      const endpointCap = pin.endpoint?.maxCompletionTokens ?? Number.POSITIVE_INFINITY
      const inner: GenerateOptions = {
        ...options,
        provider: this.route.innerRoute,
        model: pin.model,
        messages: unwrapHistory(options.messages, this.route.routeName),
        maxTokens: Math.min(requestedMax, endpointCap),
        ...effortOf(mapEffort(options.reasoningEffort, efforts)),
      }
      // `AsyncIterable` types its iterator's value as `any`, so the inner stream is
      // re-declared through a helper that carries the chunk type the caller knows
      // it produces. Nothing here converts a value; it names one.
      const iterator = chunkIterator(dispatch.stream(inner, { openRouterRouting: pin.block }))
      let first: IteratorResult<StreamChunk>
      try {
        first = await iterator.next()
      } catch (error: unknown) {
        const reroutable = error instanceof LlmError
          && settings.rerouteCodes.includes(error.code)
          && attempt < settings.maxReroutes
          && pin.endpoint !== undefined
        if (!reroutable) throw error
        this.excludeEndpoint(key, pin, error.code, settings)
        pin = await this.reroute({ settings, target: { kind: 'tier', tier: pin.tier }, pin, session: this.sessionOf(options), options, signal, persist: main, key })
        continue
      }
      if (first.done === true) return
      const chunk = first.value
      const failure = failureOf(chunk)
      const reroutable = failure !== undefined
        && settings.rerouteCodes.includes(failure)
        && attempt < settings.maxReroutes
        && pin.endpoint !== undefined
      if (reroutable) {
        await iterator.return?.(undefined)
        this.excludeEndpoint(key, pin, failure, settings)
        pin = await this.reroute({ settings, target: { kind: 'tier', tier: pin.tier }, pin, session: this.sessionOf(options), options, signal, persist: main, key })
        continue
      }
      if (failure !== undefined) {
        this.failures.add(key)
        if (pin.endpoint !== undefined) this.excludeEndpoint(key, pin, failure, settings)
      }
      yield chunk.type === 'finish' && SUCCESSFUL_FINISH.has(chunk.reason.kind)
        ? { ...chunk, replayState: wrapReplay(chunk.replayState, this.route.innerRoute, pin.model) }
        : chunk
      let done = false
      try {
        while (!done) {
          const next = await iterator.next()
          if (next.done === true) {
            done = true
            break
          }
          const item = next.value
          if (item.type === 'finish') {
            const code = failureOf(item)
            if (code !== undefined) this.failures.add(key)
            yield SUCCESSFUL_FINISH.has(item.reason.kind)
              ? { ...item, replayState: wrapReplay(item.replayState, this.route.innerRoute, pin.model) }
              : item
            if (code === undefined) this.failures.delete(key)
          } else {
            yield item
          }
        }
      } finally {
        if (!done) await iterator.return?.(undefined)
      }
      // A `purpose` call rides the Session's pin without owning it: compaction
      // and session titles must not stamp the turn's idleness or leave behind a
      // pin the next real request would treat as its own `start`.
      if (main) {
        pin.lastActivityAt = this.deps.now()
        this.pins.set(key, pin)
      }
      return
    }
  }

  /** The Session this request belongs to, when it named one. */
  private sessionOf(options: GenerateOptions): Session | undefined {
    return options.sessionId === undefined ? undefined : this.deps.session(options.sessionId)
  }

  /** Re-decide after a failure, preferring another provider of the same model. */
  private reroute(input: {
    settings: RoutingSettings
    target: RequestedTarget
    pin: Pin
    session: Session | undefined
    options: GenerateOptions
    signal: AbortSignal
    persist: boolean
    key: string
  }): Promise<Pin> {
    return this.decide({ ...input, boundary: 'failure' }).then(decision => decision.pin)
  }

  /** Exclude the failed tag for a while, and block free endpoints until tomorrow after a rate limit. */
  private excludeEndpoint(key: string, pin: Pin, code: string, settings: RoutingSettings): void {
    const tag = pin.endpoint?.slug
    if (tag === undefined) return
    const recorded = this.excluded.get(key) ?? new Map<string, number>()
    recorded.set(tag, this.deps.now() + settings.excludeAfterFailureMs)
    this.excluded.set(key, recorded)
    const endpoint = pin.endpoint
    const free = endpoint !== undefined && endpoint.promptPrice === 0 && endpoint.completionPrice === 0
    if (free && code === 'RATE_LIMIT') this.freeBlockedUntil = nextUtcMidnight(this.deps.now())
  }
}

/**
 * The async iterator over a stream this adapter knows yields {@link StreamChunk}s.
 *
 * `AsyncIterable`'s own iterator is typed with an `any` value, which would make
 * every read of the next chunk an unchecked assignment. This restates the same
 * iterator with the element type the producer guarantees; it performs no cast.
 * @param stream - the inner route's chunk stream.
 * @returns the same iterator, typed by its element.
 */
function chunkIterator(stream: AsyncIterable<StreamChunk>): AsyncIterator<StreamChunk, undefined> {
  const iterator = stream[Symbol.asyncIterator]()
  return {
    next: () => iterator.next() as Promise<IteratorResult<StreamChunk, undefined>>,
    return: () => Promise.resolve(iterator.return?.(undefined)).then(result => result as IteratorResult<StreamChunk, undefined>),
  }
}

/** Brand one mapped effort, or omit the field when there is none. */
function effortOf(value: string | undefined): { reasoningEffort?: ReasoningEffortId } {
  return value === undefined ? {} : { reasoningEffort: ReasoningEffortId(value) }
}

/** The provider failure code a chunk reports, or `undefined` when it is not a failure. */
function failureOf(chunk: StreamChunk): string | undefined {
  if (chunk.type !== 'finish' || chunk.reason.kind !== 'error') return undefined
  return chunk.reason.failure.code
}

/** Re-exported for the service's Remote methods. */
export type { JudgeRule }
