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

import { LlmAdapter, LlmError, ReasoningEffortId, contentHasImage } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmModelReasoningInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  RequestMessage,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { OpenRouterEndpoint, OpenRouterRoutingBlock, PiAiDispatch } from '@deepseek-ai/dsh-llm-pi-ai'
import type { Session, SessionEventMap, SessionId } from '@deepseek-ai/dsh-session'
import { boundaryOf } from './boundary.ts'
import { directSourceModels } from './config.ts'
import type { RoutingSettings, TierSettingsSnapshot } from './config.ts'
import { mapEffort } from './effort.ts'
import type { EndpointsCache } from './endpoints-cache.ts'
import type { FamilyCache } from './family-cache.ts'
import type { FamilyResolution } from './family.ts'
import { routingDirectOf, routingEndpointOf, routingSourceOf } from './endpoint.ts'
import { candidatesOf, cheapestRejectedOf } from './diagnostics.ts'
import { judgeQuestions, judgeState, tierFromVerdict } from './judge.ts'
import type { JudgeRequest } from './judge.ts'
import type { KeyInfo } from './key-info.ts'
import { quantizationsAtOrAbove } from './quantization.ts'
import { unwrapHistory, wrapReplay } from './replay.ts'
import { directSourcesOf, defaultMix, isDirect, mixFromUsage, policyFor, rankWithRelaxation } from './select.ts'
import type { DirectSource, RequiredInput } from './select.ts'
import type { UsageTotals } from './select.ts'
import type {
  JudgeRule,
  JudgeVerdict,
  ModelRoutingState,
  RoutingBoundary,
  RoutingDecision,
  RoutingDiagnosticsRecord,
  RoutingFilters,
  RoutingSource,
} from './types.ts'

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
  /** The canonical model id the request resolves to. */
  model: string
  /** The source the pin dispatches through: OpenRouter, or one direct route. */
  source: RoutingSource
  /** The OpenRouter endpoint the pin names; absent on a direct-source or unpinned pin. */
  endpoint?: OpenRouterEndpoint
  /** The OpenRouter `provider` block, exactly as the OpenRouter route expects it. */
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
  /** Reasoning efforts one route's model actually supports. */
  innerEfforts(model: string, route: string, signal: AbortSignal): Promise<readonly string[] | undefined>
  /**
   * Whether one pi-ai route can dispatch one exact model id.
   *
   * Under `snapshotPolicy: 'latest'` a tier's id is resolved against OpenRouter's
   * live catalog, which runs ahead of the static catalog the inner pi-ai route
   * was built with. A resolved release the inner route has never heard of would
   * be dispatched anyway and fail `UNKNOWN_MODEL` on every turn, so a decision
   * asks this before ranking. The same question applies to an `extraSources`
   * entry: a route the runtime has never configured is not a candidate either.
   * @param model - the id the dispatch would carry: a resolved `{author}/{slug}`
   *   release, or a direct source's own route id.
   * @param route - the pi-ai route key the request would go out on.
   * @param signal - the request's cancellation.
   * @returns whether that route resolves the id.
   */
  innerCanDispatch(model: string, route: string, signal: AbortSignal): Promise<boolean>
  endpoints: EndpointsCache
  /** The whole OpenRouter catalog, read behind a cache; decides which snapshot a configured id names. */
  catalog: FamilyCache
  keyInfo: KeyInfo
  /** One judge call, with `fetch` and `now` already bound by the host. */
  judge(request: Omit<JudgeRequest, 'fetch' | 'now'>): Promise<Omit<JudgeVerdict, 'rule'>>
  apiKey(): Promise<string | undefined>
  headers(): Readonly<Record<string, string>>
  now(): number
  /** Receives the full candidate table of every decision; the diagnostics file owns what happens to it. */
  diagnostics(record: RoutingDiagnosticsRecord): void
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

/** The `provider` block a direct source carries: an empty one, since the route is not OpenRouter. */
const EMPTY_BLOCK: OpenRouterRoutingBlock = {}

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

/**
 * The input modality one request requires of the model that serves it.
 *
 * Text is what every model declares, so only a modality beyond it can make a
 * request unservable. The image content of a Session is part of its durable
 * history, which is why the requirement applies to every later request and not
 * only to the request that read the image.
 * @param messages - the complete request history.
 * @returns the required modality, or undefined when the request is text-only.
 */
function requiredInputOf(messages: readonly RequestMessage[]): RequiredInput | undefined {
  return messages.some(message => contentHasImage(message.content)) ? 'image' : undefined
}

/**
 * Whether what the catalog declares for one model covers what a request needs.
 *
 * Silence is not a capability: a model the catalog does not list, or lists
 * without the modality, is treated as unable to serve the request, because the
 * alternative is sending an image to a model that may reject it.
 * @param declared - what the catalog states the model accepts as input.
 * @param requiredInput - the modality the request carries.
 * @returns whether the declaration proves the model can serve it.
 */
function acceptsInput(declared: readonly string[] | undefined, requiredInput: RequiredInput): boolean {
  return declared !== undefined && declared.includes(requiredInput)
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

/**
 * The tier filters one ranking applied, as a decision records them.
 *
 * A decision is only explicable against the filters it was taken under, and a
 * settings edit can change those after the fact, so the record carries them
 * rather than pointing at a configuration that may no longer read the same.
 * @param tier - the tier the decision landed on.
 * @param settings - the whole settings value.
 * @param allowFree - whether this caller may use free endpoints.
 * @param requiredInput - the input modality this request required beyond text.
 * @returns the filters, as plain serializable values.
 */
function filtersOf(
  tier: TierSettingsSnapshot,
  settings: RoutingSettings,
  allowFree: boolean,
  requiredInput: RequiredInput | undefined,
): RoutingFilters {
  return {
    contextWindow: tier.contextWindow,
    minQuantization: tier.minQuantization,
    unknownQuantization: tier.unknownQuantization,
    free: tier.free,
    allowFree,
    minUptime: settings.minUptime,
    requireNormalStatus: settings.requireNormalStatus,
    trustedUnknownProviders: [...settings.trustedUnknownProviders],
    ...requiredInput === undefined ? {} : { requiredInput },
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
  /** Consecutive failures per Session and tag, cleared by that tag's next success. */
  private readonly failureStreaks = new Map<string, Map<string, number>>()
  private readonly snapshots = new Map<string, string>()
  private readonly reported = new Set<string>()
  /** Whether the inner route dispatches one id, remembered for this adapter's life. */
  private readonly dispatchable = new Map<string, boolean>()
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
    this.failureStreaks.delete(sessionId)
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

  /**
   * Rebuild a pin from a decision a previous Host instance wrote to this Session's log.
   *
   * A decision recorded before the source field existed pins an OpenRouter
   * endpoint; one that names a direct source rebuilds the pin from the
   * `extraSources` entry still configured for that route and model, so the
   * dispatch goes out on the same route it came in on after a Host restart.
   * @returns `undefined` when the decision's tier or direct source no longer exists in the
   *   current settings — a live settings edit can rename or remove one after the decision
   *   was recorded, and nothing remains to build an unpinned routing block from.
   */
  private restorePin(settings: RoutingSettings, decision: SessionEventMap['model-routing/decision']): Pin | undefined {
    const endpoint = decision.endpoint
    const source = decision.source
    if (source !== undefined && source.kind !== 'openrouter') {
      const tier = settings.tiers.find(candidate => candidate.name === decision.tier)
      const direct = tier === undefined ? undefined : this.directCandidates(tier).get(decision.model)?.find(
        candidate => candidate.route === source.kind && candidate.id === source.tag,
      )
      if (direct === undefined) return undefined
      return {
        requested: decision.requested,
        tier: decision.tier,
        model: decision.model,
        source: routingSourceOf(direct),
        block: EMPTY_BLOCK,
      }
    }
    if (endpoint === undefined) {
      const tier = settings.tiers.find(candidate => candidate.name === decision.tier)
      if (tier === undefined) return undefined
      return {
        requested: decision.requested,
        tier: decision.tier,
        model: decision.model,
        source: { kind: 'openrouter', tag: decision.model },
        block: unpinnedBlock(tier),
      }

    }
    return {
      requested: decision.requested,
      tier: decision.tier,
      model: decision.model,
      source: { kind: 'openrouter', tag: endpoint.tag },
      endpoint: {
        slug: endpoint.tag,
        ...endpoint.providerName === undefined ? {} : { providerName: endpoint.providerName },
        ...endpoint.quantization === undefined ? {} : { quantization: endpoint.quantization },
        ...endpoint.promptUsd === undefined ? {} : { promptPrice: endpoint.promptUsd },
        ...endpoint.completionUsd === undefined ? {} : { completionPrice: endpoint.completionUsd },
        ...endpoint.cacheReadUsd === undefined ? {} : { inputCacheReadPrice: endpoint.cacheReadUsd },
        ...endpoint.contextLength === undefined ? {} : { contextLength: endpoint.contextLength },
        ...endpoint.maxCompletionTokens === undefined ? {} : { maxCompletionTokens: endpoint.maxCompletionTokens },
      },
      block: { only: [endpoint.tag], allow_fallbacks: false },
    }
  }

  /**
   * The direct-source candidates one tier's `extraSources` name, keyed by canonical model id.
   *
   * The map is the one place a request's model id is matched against a route's
   * own id, so a `modelMap` entry and an OpenRouter model with the same
   * canonical id rank as one model's two sources.
   * @param tier - the tier whose sources to read.
   * @returns the candidates per canonical id, in configuration order.
   */
  private directCandidates(tier: TierSettingsSnapshot): Map<string, DirectSource[]> {
    const map = new Map<string, DirectSource[]>()
    for (const source of tier.extraSources) {
      for (const candidate of directSourcesOf(source, directSourceModels(source))) {
        const candidates = map.get(candidate.model) ?? []
        candidates.push(candidate)
        map.set(candidate.model, candidates)
      }
    }
    return map
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
    // A live settings edit can rename or remove the tier a live or restored pin
    // names, between the request that set it and this one. Nothing in the
    // current settings can validate or dispatch against a tier that is gone, so
    // the pin is discarded here rather than clinching every request behind it
    // with `INVALID_CONFIG` until an unrelated boundary happens to re-decide.
    const pinnedTier = pin?.tier
    if (pinnedTier !== undefined && !settings.tiers.some(candidate => candidate.name === pinnedTier)) pin = undefined
    const requiredInput = requiredInputOf(options.messages)
    // A pin whose model is not shown to accept what this request carries cannot
    // serve it. The image that demands a vision model stays in the Session's
    // history, so every later request carries it too and the pin would keep
    // failing for the rest of the Session. The re-decision stays inside the pin's
    // tier, because the tier is the deployment's cost and quality contract, and a
    // request that reaches a decision without a usable pin records `start`.
    const tierForInput = pin === undefined || requiredInput === undefined
      ? undefined
      : await this.tierForInput(settings, pin, requiredInput, signal)
    if (tierForInput !== undefined) pin = undefined
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
      // At `failure`, the pin's own tier is the target, never the raw request:
      // a provider hiccup must stay inside the tier the session is already
      // on. Re-resolving `auto` here would re-ask the judge on every single
      // provider failure — the exact mid-dialog model change `cacheIdleMs`
      // and the other boundaries exist to prevent — and could switch tier or
      // model on nothing more than a transient 5xx. `dispatchWithReroute`'s
      // own internal reroute already decides this way; this keeps the two
      // consistent.
      const decisionTarget: RequestedTarget = boundary === 'failure' && pin !== undefined
        ? { kind: 'tier', tier: pin.tier }
        : tierForInput !== undefined ? { kind: 'tier', tier: tierForInput }
          : target
      const decided = await this.decide({
        settings, target: decisionTarget, pin, session, options, signal, persist: main, key, requiredInput,
        ...boundary === undefined ? {} : { boundary },
      })
      pin = decided.pin
      if (main) this.pins.set(key, pin)
    }
    yield* this.dispatchWithReroute({ settings, dispatch, options, pin, key, signal, main, requiredInput })
  }

  /**
   * The tier a name resolved against the current settings already names.
   * Every call site resolves `name` against the same `settings.tiers` beforehand
   * (`resolveRequested`, the judge's verdict, or a pin `run()` already confirmed
   * still names a configured tier), so a miss here would be a resolution bug,
   * not a stale reference.
   */
  private tierNamed(settings: RoutingSettings, name: string): TierSettingsSnapshot {
    const tier = settings.tiers.find(candidate => candidate.name === name)
    /* v8 ignore next -- every call site already validated `name` against these same settings. */
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
    requiredInput: RequiredInput | undefined
    boundary?: RoutingBoundary
  }): Promise<Decision> {
    const { settings, target, pin, session, options, signal, persist, key, requiredInput } = input
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
    const excluded = this.excludedTagsOf(key)
    const mix = mixFromUsage(
      session === undefined ? undefined : this.deps.usage(session),
      defaultMix(settings),
      settings.mixMinTokens,
    )
    const preferModel = pin !== undefined && pin.tier === tier.name && target.kind !== 'fixed' ? pin.model : undefined
    const requirement = requiredInput === undefined ? undefined : {
      requiredInput,
      modalities: await this.declaredModalities(settings, models, requiredInput, signal),
    }
    // Direct sources ride the same ranking, keyed by the canonical id a
    // request names: a `modelMap` entry and an OpenRouter model of that id are
    // one model's two sources, and price decides between them. A route the
    // runtime cannot dispatch is not a candidate at all — the decision reports
    // it as undispatchable rather than pinning a request to a route nobody serves.
    const directAll = this.directCandidates(tier)
    const extraSources = new Map<string, DirectSource[]>()
    for (const model of models) {
      const candidates = directAll.get(model)
      if (candidates === undefined) continue
      const usable: DirectSource[] = []
      for (const candidate of candidates) {
        if (await this.innerKnows(candidate.id, candidate.route, signal)) usable.push(candidate)
        else this.warnUndispatchableSource(candidate)
      }
      if (usable.length > 0) extraSources.set(model, usable)
    }
    const result = rankWithRelaxation(
      lists,
      models,
      policyFor(tier, settings, {
        allowFree,
        excludedTags: excluded.tags,
        ...excluded.sources.size === 0 ? {} : { excludedSources: excluded.sources },
        ...preferModel === undefined ? {} : { preferModel },
        ...requirement,
        ...extraSources.size === 0 ? {} : { extraSources },
      }),
      mix,
    )
    const best = result.ranked[0]
    let decidedModel: string
    let endpoint: OpenRouterEndpoint | undefined
    let direct: DirectSource | undefined
    let source: RoutingSource
    let block: OpenRouterRoutingBlock
    let unpinnedReason: string | undefined
    if (best !== undefined && isDirect(best.endpoint)) {
      decidedModel = best.model
      direct = best.endpoint
      source = routingSourceOf(best.endpoint)
      // A direct source has no OpenRouter `provider` block: pi-ai refuses one on
      // a model that does not speak `openai-completions`, so the dispatch carries
      // the route alone.
      block = EMPTY_BLOCK
    } else if (best !== undefined) {
      const chosen = best.endpoint
      if (isDirect(chosen)) throw new LlmError('model-routing: a direct source reached the OpenRouter branch', 'INVALID_CONFIG')
      decidedModel = best.model
      endpoint = chosen
      source = routingSourceOf(chosen)
      block = { only: [chosen.slug], allow_fallbacks: false }
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
      source = { kind: 'openrouter', tag: first }
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
    const candidates = candidatesOf(result, mix)
    const payload: RoutingDecision = {
      boundary,
      requested: options.model,
      tier: tier.name,
      ...judge === undefined ? {} : { judge },
      model: decidedModel,
      source,
      ...endpoint === undefined
        ? direct === undefined ? {} : { endpoint: routingDirectOf(direct) }
        : { endpoint: routingEndpointOf(endpoint) },
      ...unpinnedReason === undefined ? {} : { unpinnedReason },
      ...best === undefined ? {} : { blendedUsdPerToken: best.blendedUsdPerToken },
      ...result.relaxedUptime ? { relaxedUptime: true as const } : {},
      considered: result.considered,
      runnersUp: result.ranked.slice(1, 4).map((entry) => {
        const routed = isDirect(entry.endpoint) ? routingDirectOf(entry.endpoint) : routingEndpointOf(entry.endpoint)
        return {
          model: entry.model,
          tag: routed.tag,
          blendedUsdPerToken: entry.blendedUsdPerToken,
          ...routed.quantization === undefined ? {} : { quantization: routed.quantization },
          ...routed.discount === undefined ? {} : { discount: routed.discount },
        }
      }),
      // Both kinds of exclusion, in one list: a reader of the event must see
      // every candidate a failure took out, and `route:id` is the spelling that
      // says which copy of a shared canonical id failed.
      excludedTags: [...excluded.tags, ...excluded.sources].sort(),
      mix,
      rejections: result.rejections,
      cheapestRejected: cheapestRejectedOf(candidates),
      filters: filtersOf(tier, settings, allowFree, requiredInput),
    }
    // The file takes every decision, including those no Session asked to keep:
    // a turn that could not record its event is exactly the turn a later
    // investigation will ask about.
    this.deps.diagnostics({
      ...payload,
      at: this.deps.now(),
      ...session === undefined ? {} : { sessionId: session.id },
      unreadable: result.unreadable,
      candidates,
    })
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
      source,
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
    // Resolve exactly the ids this request ranks over — `configured`, not the
    // whole tier. A request that named one model of the tier means that model:
    // resolving `tier.models` here would hand the ranking every other family of
    // the tier as well, and the request would quietly be priced against and
    // dispatched from models it did not ask for.
    const batch = await this.deps.catalog.resolve(configured, settings.catalogTtlMs, signal)
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
    for (const [index, resolution] of batch.resolutions.entries()) {
      if (resolution.resolved === resolution.configured) continue
      if (await this.innerKnows(resolution.resolved, this.route.innerRoute, signal)) this.announce(resolution)
      else this.warnUndispatchable(resolution, configured[index] ?? resolution.resolved)
    }
    return this.dispatchableModels(batch.resolutions, configured, signal)
  }

  /** Whether one route can dispatch one id, answered once per decision. */
  private innerKnows(model: string, route: string, signal: AbortSignal): Promise<boolean> {
    const key = `${route}:${model}`
    const cached = this.dispatchable.get(key)
    if (cached !== undefined) return Promise.resolve(cached)
    return this.deps.innerCanDispatch(model, route, signal).then((answer) => {
      this.dispatchable.set(key, answer)
      return answer
    })
  }

  /**
   * Report an `extraSources` candidate whose route the runtime cannot dispatch.
   *
   * One line per route and model, not per boundary: the same configuration
   * recurs on every decision of every turn until the route is configured.
   * @param candidate - the direct candidate that names an unknown route.
   */
  private warnUndispatchableSource(candidate: DirectSource): void {
    this.warnOnce(
      `inner-unknown-source:${candidate.route}:${candidate.id}`,
      `model-routing: extraSource "${candidate.route}" serves "${candidate.id}", which no`
      + ' configured pi-ai route can dispatch, so that source never ranks — @deepseek-ai/dsh-llm-pi-ai'
      + ` has no route "${candidate.route}"`,
    )
  }

  /**
   * Report an id that `latest` resolved to but the inner route cannot dispatch.
   *
   * One line per model, not per boundary: the same resolution recurs on every
   * decision of every turn until a dependency bump changes it.
   * @param resolution - the configured id and the undispatchable release it resolved to.
   * @param configured - the id the configuration named, which the route does know.
   */
  private warnUndispatchable(resolution: FamilyResolution, configured: string): void {
    this.warnOnce(
      `inner-unknown:${resolution.resolved}`,
      `model-routing: "${resolution.configured}" resolves to "${resolution.resolved}", which`
      + ` the inner route "${this.route.innerRoute}" cannot dispatch, so the tier keeps "${configured}"`
      + ' — @deepseek-ai/dsh-llm-pi-ai has not learned that release yet',
    )
  }

  /**
   * Restrict a catalog resolution to ids the inner route can actually dispatch.
   *
   * OpenRouter publishes a release to its catalog before the pinned `pi-ai`
   * dependency learns it, so `latest` can resolve a tier onto an id the inner
   * route answers `UNKNOWN_MODEL` for — an error no reroute covers, because
   * every endpoint of that model is equally unknown. A resolution the inner
   * route cannot serve falls back to the id the configuration named, which the
   * route knows by construction, so the tier keeps working and stays on the
   * release it can serve until a dependency bump moves the ceiling.
   * @param resolutions - what `latest` resolved each configured id to.
   * @param configured - the ids the configuration named, in tier order.
   * @param signal - the request's cancellation.
   * @returns the ids to rank, in tier order.
   */
  private async dispatchableModels(
    resolutions: readonly FamilyResolution[],
    configured: readonly string[],
    signal: AbortSignal,
  ): Promise<string[]> {
    const ranked: string[] = []
    for (const [index, resolution] of resolutions.entries()) {
      const dispatchable = resolution.resolved === resolution.configured
        || await this.innerKnows(resolution.resolved, this.route.innerRoute, signal)
      // `resolutions` is derived one-for-one from `configured`, so the index is
      // always present; `resolved` is the total fallback if that ever changed.
      ranked.push(dispatchable ? resolution.resolved : configured[index] ?? resolution.resolved)
    }
    return ranked
  }

  /**
   * The tier a pinned model cannot serve, when the request carries something it
   * is not shown to accept.
   *
   * An image stays in the Session's history once it has been read, so a model
   * pinned before that point cannot serve the Session afterwards either. The
   * re-decision stays inside the pin's own tier: the tier is the deployment's
   * cost and quality contract, and the requirement is about which model inside it
   * may answer, not about which contract this Session is on.
   *
   * Only an OpenRouter pin is checked against the catalog: a direct source's
   * modality is not something OpenRouter's catalog knows, so a direct pin is
   * never re-decided on this ground and its own decision's `modality` filter is
   * what admits it.
   * @param settings - the whole settings value.
   * @param pin - the pin this Session is held to.
   * @param requiredInput - the input modality the request carries.
   * @param signal - the request's cancellation.
   * @returns the pin's tier when the pin cannot serve the request, otherwise undefined.
   */
  private async tierForInput(
    settings: RoutingSettings,
    pin: Pin,
    requiredInput: RequiredInput,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    if (pin.source.kind !== 'openrouter') return undefined
    const batch = await this.deps.catalog.modalities([pin.model], settings.catalogTtlMs, signal)
    if (acceptsInput(batch.declared.get(pin.model), requiredInput)) return undefined
    this.warnOnce(
      `input:${pin.model}:${requiredInput}`,
      `model-routing: "${pin.model}" is not shown to accept ${requiredInput} input, so this Session`
      + ` decides its ${pin.tier} tier again on a model that does`,
    )
    return pin.tier
  }

  /**
   * What the catalog declares about the input of every model one decision ranks.
   *
   * Only a request that carries an image reads the catalog: a text request's
   * ranking cannot depend on modalities, and it must not pay for a catalog read
   * to learn that.
   * @param settings - the whole settings value.
   * @param models - the exact ids the decision ranks, in tier order.
   * @param requiredInput - the input modality the request carries.
   * @param signal - the request's cancellation.
   * @returns the declared modalities per id; an empty map when the catalog could not be read.
   */
  private async declaredModalities(
    settings: RoutingSettings,
    models: readonly string[],
    requiredInput: RequiredInput,
    signal: AbortSignal,
  ): Promise<ReadonlyMap<string, readonly string[] | undefined>> {
    const batch = await this.deps.catalog.modalities(models, settings.catalogTtlMs, signal)
    if (batch.unreadable) {
      // Every model then fails the requirement, and the decision reports that
      // with the tier's other counts. This line says why the counts are what
      // they are.
      this.warnOnce(
        'modalities',
        'model-routing: the OpenRouter model catalog could not be read, so no model is shown to'
        + ` accept ${requiredInput} input and an image request has no endpoint to serve it`,
      )
    }
    return batch.declared
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

  /** The candidates this session's recent failures excluded, still live, split by kind. */
  private excludedTagsOf(key: string): { tags: ReadonlySet<string>; sources: ReadonlySet<string> } {
    const now = this.deps.now()
    const recorded = this.excluded.get(key)
    const tags = new Set<string>()
    const sources = new Set<string>()
    for (const [tag, until] of recorded ?? []) {
      if (until <= now) {
        // The bench has lapsed, so the candidate is eligible again and its
        // failure count starts over with it: `excludeAfterFailures` counts
        // failures in a row, and a route that comes back after its cooldown is
        // not still serving the streak that benched it. Without this the count
        // would be spent once per Session and every later failure would bench
        // immediately, which is the behavior the count exists to avoid.
        recorded?.delete(tag)
        this.failureStreaks.get(key)?.delete(tag)
        continue
      }
      const at = tag.indexOf(':')
      if (at === -1) tags.add(tag)
      else sources.add(tag)
    }
    if (recorded?.size === 0) this.excluded.delete(key)
    return { tags, sources }
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
    requiredInput: RequiredInput | undefined
  }): AsyncIterable<StreamChunk> {
    const { settings, dispatch, options, key, signal, main, requiredInput } = input
    const tier = this.tierNamed(settings, input.pin.tier)
    let pin = input.pin
    // `maxReroutes` bounds how many times one request may move to a DIFFERENT
    // candidate, not how many attempts it makes. A re-decision that lands on the
    // candidate that just failed is that same route being tried again — what
    // `excludeAfterFailures` asks for — so it must not spend the budget: charging
    // it would exhaust the budget before the failure count reached its threshold,
    // and the request would fail on a route the ranking replaces one attempt
    // later.
    let reroutes = 0
    for (;;) {
      const efforts = await this.deps.innerEfforts(
        pin.source.kind === 'openrouter' ? pin.model : pin.source.tag,
        pin.source.kind === 'openrouter' ? this.route.innerRoute : pin.source.kind,
        signal,
      )
      const requestedMax = options.maxTokens ?? tier.maxTokens
      const endpointCap = pin.endpoint?.maxCompletionTokens ?? Number.POSITIVE_INFINITY
      const inner: GenerateOptions = {
        ...options,
        provider: pin.source.kind === 'openrouter' ? this.route.innerRoute : pin.source.kind,
        model: pin.source.kind === 'openrouter' ? pin.model : pin.source.tag,
        messages: unwrapHistory(options.messages, this.route.routeName),
        maxTokens: Math.min(requestedMax, endpointCap),
        ...effortOf(mapEffort(options.reasoningEffort, efforts)),
      }
      // `AsyncIterable` types its iterator's value as `any`, so the inner stream is
      // re-declared through a helper that carries the chunk type the caller knows
      // it produces. Nothing here converts a value; it names one.
      const iterator = chunkIterator(dispatch.stream(inner, pin.source.kind === 'openrouter'
        ? { openRouterRouting: pin.block }
        : {}))
      // pi-ai's in-band failure reporting always yields a `usage` chunk before the
      // error `finish` (llm-pi-ai's stream.ts `'error'` case), so "has this attempt
      // produced any content yet" must look past a leading `usage` chunk — reading
      // only the very first `.next()` would see `usage`, never the failure, and
      // rerouting would never fire for pi-ai's own error reporting (only for a
      // thrown `LlmError`, which this attempt budget already covers below).
      const leadingUsage: StreamChunk[] = []
      let committed: IteratorResult<StreamChunk>
      try {
        for (;;) {
          const next = await iterator.next()
          if (next.done === true || next.value.type !== 'usage') { committed = next; break }
          leadingUsage.push(next.value)
        }
      } catch (error: unknown) {
        const reroutable = error instanceof LlmError
          && !settings.noRerouteCodes.includes(error.code)
          && reroutes < settings.maxReroutes
          && (pin.endpoint !== undefined || pin.source.kind !== 'openrouter')
        if (!reroutable) throw error
        const failed = tagOfPin(pin)
        this.excludeEndpoint(key, pin, error.code, settings)
        pin = await this.reroute({ settings, target: { kind: 'tier', tier: pin.tier }, pin, session: this.sessionOf(options), options, signal, persist: main, key, requiredInput })
        if (tagOfPin(pin) !== failed) reroutes += 1
        continue
      }
      if (committed.done === true) return
      const chunk = committed.value
      const failure = failureOf(chunk)
      const reroutable = failure !== undefined
        && !settings.noRerouteCodes.includes(failure)
        && reroutes < settings.maxReroutes
        && (pin.endpoint !== undefined || pin.source.kind !== 'openrouter')
      if (reroutable) {
        await iterator.return?.(undefined)
        const failed = tagOfPin(pin)
        this.excludeEndpoint(key, pin, failure, settings)
        pin = await this.reroute({ settings, target: { kind: 'tier', tier: pin.tier }, pin, session: this.sessionOf(options), options, signal, persist: main, key, requiredInput })
        if (tagOfPin(pin) !== failed) reroutes += 1
        continue
      }
      if (failure !== undefined) {
        this.failures.add(key)
        this.excludeEndpoint(key, pin, failure, settings)
      } else if (chunk.type === 'finish' && SUCCESSFUL_FINISH.has(chunk.reason.kind)) {
        this.failures.delete(key)
        this.clearFailureStreak(key, pin)
      }
      for (const usageChunk of leadingUsage) yield usageChunk
      yield chunk.type === 'finish' && SUCCESSFUL_FINISH.has(chunk.reason.kind)
        ? { ...chunk, replayState: wrapReplay(chunk.replayState, pin.source.kind === 'openrouter' ? this.route.innerRoute : pin.source.kind, pin.model) }
        : chunk
      let done = false
      try {
        while (!done) {
          let next: IteratorResult<StreamChunk>
          try {
            next = await iterator.next()
          } catch (error: unknown) {
            // Chunks have already reached the caller, so — like a failure chunk
            // arriving here — this attempt cannot be replayed on another
            // endpoint. Excluding the failed one is still required: without it
            // the next turn's failure boundary re-decides onto the same one.
            this.failures.add(key)
            this.excludeEndpoint(key, pin, error instanceof LlmError ? error.code : 'PI_AI_ERROR', settings)
            throw error
          }
          if (next.done === true) {
            done = true
            break
          }
          const item = next.value
          if (item.type === 'finish') {
            const code = failureOf(item)
            if (code !== undefined) {
              this.failures.add(key)
              // Chunks have already reached the caller, so this attempt cannot be
              // replayed on another endpoint. Excluding the failed one is still
              // required: without it the failure boundary re-decides to the same
              // endpoint and the next turn fails on it again.
              this.excludeEndpoint(key, pin, code, settings)
            }
            yield SUCCESSFUL_FINISH.has(item.reason.kind)
              ? { ...item, replayState: wrapReplay(item.replayState, pin.source.kind === 'openrouter' ? this.route.innerRoute : pin.source.kind, pin.model) }
              : item
            if (code === undefined) {
              this.failures.delete(key)
              this.clearFailureStreak(key, pin)
            }
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
    requiredInput: RequiredInput | undefined
  }): Promise<Pin> {
    return this.decide({ ...input, boundary: 'failure' }).then(decision => decision.pin)
  }

  /**
   * Count one failure against the candidate that produced it, and bench it for
   * `excludeAfterFailureMs` once the count reaches `excludeAfterFailures`.
   *
   * Benching exists so a retry can reach a different candidate: the failure
   * boundary outranks every reason to keep the current pin, so without it the
   * next decision picks the endpoint that just failed again. Counting first
   * keeps a single blip from displacing a route that has been answering: the
   * retry stays on the same candidate until it fails the configured number of
   * times in a row, and a success clears the count.
   *
   * A direct candidate is excluded by `route:id`, not by its id alone: one route
   * may serve the same id as several models' candidates, and only the pair says
   * which one failed.
   */
  private excludeEndpoint(key: string, pin: Pin, code: string, settings: RoutingSettings): void {
    const tag = tagOfPin(pin)
    if (tag !== undefined) {
      const streaks = this.failureStreaks.get(key) ?? new Map<string, number>()
      const streak = (streaks.get(tag) ?? 0) + 1
      streaks.set(tag, streak)
      this.failureStreaks.set(key, streaks)
      if (streak >= settings.excludeAfterFailures) {
        const recorded = this.excluded.get(key) ?? new Map<string, number>()
        recorded.set(tag, this.deps.now() + settings.excludeAfterFailureMs)
        this.excluded.set(key, recorded)
      }
    }
    const endpoint = pin.endpoint
    const free = endpoint !== undefined && endpoint.promptPrice === 0 && endpoint.completionPrice === 0
    if (free && code === 'RATE_LIMIT') this.freeBlockedUntil = nextUtcMidnight(this.deps.now())
  }

  /**
   * Clear one candidate's consecutive-failure count.
   *
   * Called where an attempt finished without a failure, so a candidate that
   * answers again starts from zero rather than being benched by a count it
   * accumulated days ago.
   * @param key - the Session's pin key.
   * @param pin - the pin whose candidate answered.
   */
  private clearFailureStreak(key: string, pin: Pin): void {
    const tag = tagOfPin(pin)
    if (tag === undefined) return
    const streaks = this.failureStreaks.get(key)
    if (streaks === undefined) return
    streaks.delete(tag)
    if (streaks.size === 0) this.failureStreaks.delete(key)
  }
}

/**
 * The tag a pin's candidate is counted and excluded under: an OpenRouter
 * endpoint's slug, or a direct source's `route:id`.
 * @param pin - the pin an attempt ran under.
 * @returns the tag, or undefined when the pin names no concrete endpoint.
 */
function tagOfPin(pin: Pin): string | undefined {
  return pin.source.kind === 'openrouter'
    ? pin.endpoint?.slug
    : `${pin.source.kind}:${pin.source.tag}`
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
