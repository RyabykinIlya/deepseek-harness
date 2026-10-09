/**
 * Endpoint filtering and ranking: which upstream providers may serve a tier's
 * models, and in what order the cheapest one is tried.
 *
 * A tier's candidates come from two kinds of source and the ranking treats both
 * the same way. An `OpenRouterEndpoint` is one upstream provider of one OpenRouter
 * model, carrying the measurements OpenRouter publishes. A `DirectSource` is one
 * model served by its own pi-ai route — a proxy, a subscription plan — whose
 * prices a tier's `extraSources` entry states and whose measurements nobody has.
 * Both are {@link Candidate}s: only the data-bearing filters (`status`, `uptime`,
 * `quantization`) differ, and there they are neutral for a direct source, because
 * an absent measurement must not reject — otherwise a direct source could never
 * rank. The capability filters (`tools`, `context`, and the per-model `modality`
 * rule) apply to both, and `tools` reads the spelling each kind declares.
 *
 * The ranking key is a *blended* price per token, not a prompt price. An agent
 * turn is overwhelmingly cached input (§B.1: a 100k-token session re-reads 95k of
 * it), and the providers that look cheapest on prompt alone frequently publish no
 * cache-read discount at all — §B.1 measures Relace sixth and 7.5× the leader once
 * the cache term is in. So the mix is the decision, and the mix is either the
 * tier's configured default or the session's own measured usage. A direct source
 * is blended under the same formula from the per-token prices its entry declares.
 *
 * A tier's `input` declaration is enforced rather than assumed: a request that
 * carries an image reaches only a model the catalog shows accepting one, so a
 * tier whose candidates are all text-only refuses the request instead of sending
 * it. Silence in the catalog is not a capability.
 *
 * `preferModel` is what keeps a mid-dialog failure from changing the model. When
 * an endpoint fails, the exclusion list takes it out and the re-rank must exhaust
 * the *same* model's other providers before it reaches a different model; without
 * that rule one provider's rate limit would silently re-route a conversation.
 *
 * @module dsh-experimental-model-routing/select
 */

import type { OpenRouterEndpoint } from '@deepseek-ai/dsh-llm-pi-ai'
import type {
  DirectSourceModelSnapshot,
  ExtraSourcePriceSnapshot,
  ExtraSourceSnapshot,
  FreeMode,
  Quantization,
  RoutingSettings,
  TierSettingsSnapshot,
} from './config.ts'
import { quantizationRank } from './quantization.ts'

/** Prices of one direct source candidate, resolved from `prompt`/`completion` or a single flat rate. */
export interface DirectPrices {
  /** USD per input token; also the cache-read rate when `cacheRead` is absent. */
  prompt: number
  /** USD per output token. */
  completion: number
  /** USD per cached input token; absent charges `prompt` for a cache hit. */
  cacheRead?: number
}

/**
 * One model served by its own pi-ai route rather than by OpenRouter endpoints.
 *
 * A direct source states no status, uptime or quantization, so the data-bearing
 * filters are neutral for it. The `tools` filter still applies, and reads
 * `tools`: a route must say it takes tool calls rather than inherit the
 * OpenRouter endpoint's `supportedParameters` spelling.
 */
export interface DirectSource {
  kind: 'direct'
  /** The pi-ai route that dispatches this model. */
  route: string
  /** Canonical model id, the one the tier and the request name. */
  model: string
  /** The route's own id for this model, which is what the dispatch carries. */
  id: string
  /** The prices the ranking blends; absent prices make the candidate `unpriced`. */
  prices?: DirectPrices
  /** Whether this route's models take tool calls (default `true`). */
  tools?: boolean
  /** Largest context this route serves this model in, in tokens, when the tier states one. */
  contextLength?: number
}

/** One candidate of a ranking pass: an OpenRouter endpoint, or a direct route source. */
export type Candidate = OpenRouterEndpoint | DirectSource

/** Fraction of a turn's tokens spent in each bucket; the three sum to 1. */
export interface TurnMix {
  cached: number
  fresh: number
  output: number
}

/** Where a decision's token mix came from: measured session usage, or the configured default. */
export type MixSource = 'default' | 'usage'

/** A turn mix carrying the source it was measured or defaulted from, for the decision record. */
export interface MeasuredMix extends TurnMix {
  source: MixSource
}

/** A session's measured token spend, from the token-usage projection. */
export interface UsageTotals {
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/** An input modality a request requires beyond text, which every model declares. */
export type RequiredInput = 'image'

/** Why one endpoint did not reach the ranking. */
export type EndpointRejection =
  | 'modality'
  | 'excluded'
  | 'status'
  | 'uptime'
  | 'tools'
  | 'context'
  | 'quantization'
  | 'untrusted-unknown'
  | 'unpriced'
  | 'free'
  | 'paid'

/** Everything the filters and the ranking read for one decision. */
export interface SelectionPolicy {
  contextWindow: number
  minQuantization: Quantization
  unknownQuantization: 'reject' | 'trusted' | 'accept'
  trustedUnknownProviders: ReadonlySet<string>
  free: FreeMode
  /** Whether this caller may use free endpoints at all (subagent origins usually may not). */
  allowFree: boolean
  minUptime: number
  requireNormalStatus: boolean
  /** Endpoint tags excluded after recent failures. */
  excludedTags: ReadonlySet<string>
  /**
   * Direct candidates excluded after a failure, by `route:id`.
   *
   * One route may serve the same id as several models' candidates — `models`
   * and a `modelMap` entry can name it under two canonical ids — so the route
   * id alone cannot say which candidate failed.
   */
  excludedSources?: ReadonlySet<string>
  /** The modality this request carries, when it carries one beyond text. */
  requiredInput?: RequiredInput
  /**
   * The input modalities the catalog declares per model id, keyed by that id.
   *
   * Absent means no declaration was applied at all; an entry that names no
   * modalities and a missing entry are both an absent capability.
   */
  modalities?: ReadonlyMap<string, readonly string[] | undefined>
  /** Model whose endpoints sort before every other model's, used when re-routing after a failure. */
  preferModel?: string
  /** Non-OpenRouter candidates the tier's `extraSources` named, keyed by canonical model id. */
  extraSources?: ReadonlyMap<string, readonly DirectSource[]>
  /** Drops the uptime floor; set by `rankWithRelaxation` when nothing else passed. */
  readonly ignoreUptime?: true
}

/** One candidate that passed every filter, with the price the ranking used. */
export interface RankedEndpoint {
  model: string
  endpoint: Candidate
  blendedUsdPerToken: number
  free: boolean
}

/** One candidate a filter or a missing price dropped, with the reason it carries. */
export interface RejectedEndpoint {
  model: string
  endpoint: Candidate
  reason: EndpointRejection
}

/** The outcome of one ranking pass. */
export interface SelectionResult {
  ranked: readonly RankedEndpoint[]
  /** Every {@link EndpointRejection} key present, zero by default. */
  rejections: Readonly<Record<EndpointRejection, number>>
  /** Candidates seen across every candidate model and direct source, admitted or not. */
  considered: number
  /** Models whose endpoint list could not be read. */
  unreadable: readonly { model: string; reason: string }[]
  /** Every dropped candidate with its reason, in the order the walk met them. */
  rejected: readonly RejectedEndpoint[]
}

/** Candidate list per model, or the failure that model reported. */
export type EndpointLists = ReadonlyMap<string, readonly Candidate[] | Error>
/**
 * The tier's configured mix, normalized to sum 1.
 *
 * The three weights are fractions the operator wrote, not a probability
 * distribution the schema enforces, so a set that sums to anything but 1 is
 * scaled rather than rejected: `defaultMix` feeds a price comparison, and a
 * comparison is unaffected by a common factor.
 * @param settings - the whole settings value.
 * @returns the normalized mix.
 */
export function defaultMix(settings: RoutingSettings): TurnMix {
  const sum = settings.mixCached + settings.mixFresh + settings.mixOutput
  return {
    cached: settings.mixCached / sum,
    fresh: settings.mixFresh / sum,
    output: settings.mixOutput / sum,
  }
}

/**
 * The mix a session actually ran, or the configured default.
 *
 * Usage is only trusted above `mixMinTokens`: a session that has exchanged two
 * short messages has not established a cache pattern, and pricing its next turn
 * by that would pin an endpoint for a shape the conversation has not taken yet.
 * The returned `source` says which of the two happened, so a decision record can
 * show whether a price was compared under a measured shape or the default one.
 * @param usage - the session's measured totals, when a projection holds any.
 * @param fallback - the configured default mix.
 * @param minTokens - the total below which measured usage is not believed.
 * @returns the measured mix when it is believed, otherwise `fallback`, each with its source.
 */
export function mixFromUsage(usage: UsageTotals | undefined, fallback: TurnMix, minTokens: number): MeasuredMix {
  if (usage === undefined) return { ...fallback, source: 'default' }
  const cached = usage.cacheReadTokens
  const fresh = usage.uncachedInputTokens + usage.cacheWriteTokens
  const output = usage.outputTokens
  const total = cached + fresh + output
  if (total < minTokens) return { ...fallback, source: 'default' }
  return { cached: cached / total, fresh: fresh / total, output: output / total, source: 'usage' }
}

/**
 * Cost of one token of the turn under one candidate, in USD.
 *
 * A provider with no cache-read price charges the prompt price for a cache hit;
 * that is the honest reading, and it is why an unpriced cache term never
 * flatters a provider. A direct source states its own per-token prices, which
 * the same formula blends.
 * @param endpoint - the candidate being priced.
 * @param mix - the turn's token buckets.
 * @returns the blended price, or `undefined` when the candidate states no price.
 */
export function blendedPrice(endpoint: Candidate, mix: TurnMix): number | undefined {
  const prices = pricesOf(endpoint)
  if (prices === undefined) return undefined
  return mix.cached * (prices.cacheRead ?? prices.prompt)
    + mix.fresh * prices.prompt
    + mix.output * prices.completion
}

/** The per-token prices one candidate charges, or `undefined` when it states none. */
function pricesOf(endpoint: Candidate): DirectPrices | undefined {
  if (isDirect(endpoint)) return endpoint.prices
  const { promptPrice, completionPrice } = endpoint
  if (promptPrice === undefined || completionPrice === undefined) return undefined
  return {
    prompt: promptPrice,
    completion: completionPrice,
    ...endpoint.inputCacheReadPrice === undefined ? {} : { cacheRead: endpoint.inputCacheReadPrice },
  }
}

/**
 * Whether one candidate is a direct route source rather than an OpenRouter endpoint.
 * @param candidate - the candidate to classify.
 * @returns whether it carries a `route` rather than an endpoint listing.
 */
export function isDirect(candidate: Candidate): candidate is DirectSource {
  return 'route' in candidate
}

/**
 * The direct-source candidates of one `extraSources` entry, as the ranking sees them.
 *
 * The `route` travels with every candidate because dispatch needs it and the
 * price entry alone does not carry it; the prices are exactly what
 * {@link directPricesOf} resolved, so a source that states none is ranked as
 * `unpriced` rather than as free.
 * @param source - one configured entry.
 * @param models - the candidates {@link directSourceModels} read from it.
 * @returns one ranked-candidate shape per named model.
 */
export function directSourcesOf(source: ExtraSourceSnapshot, models: readonly DirectSourceModelSnapshot[]): DirectSource[] {
  return models.map((entry) => {
    const prices = directPricesOf(entry.price)
    return {
      kind: 'direct',
      route: source.route,
      model: entry.model,
      id: entry.id,
      ...prices === undefined ? {} : { prices },
      tools: source.tools,
    }
  })
}

/**
 * The per-token prices of one direct source candidate.
 *
 * `usdPerToken` is the one-rate spelling for a subscription-style source that
 * charges input, output and cache alike; the prompt/completion pair is the
 * ordinary spelling. Both may be present, in which case the pair wins for the
 * buckets it names and the flat rate fills the rest — a partial pair is not
 * silently completed from the flat rate, so the configuration states exactly
 * what the ranking charges.
 * @param price - the price entry, or `undefined` when the source declares none.
 * @returns the resolved prices, or `undefined` when nothing states one.
 */
export function directPricesOf(price: ExtraSourcePriceSnapshot | undefined): DirectPrices | undefined {
  if (price === undefined) return undefined
  const flat = price.usdPerToken
  const prompt = price.promptUsdPerToken ?? flat
  const completion = price.completionUsdPerToken ?? flat
  if (prompt === undefined || completion === undefined) return undefined
  const cacheRead = price.cacheReadUsdPerToken ?? price.promptUsdPerToken
  return { prompt, completion, ...cacheRead === undefined ? {} : { cacheRead } }
}

/**
 * Base provider slug of an endpoint tag.
 *
 * OpenRouter's tag is `slug/quantization`, and the bare slug — `nvidia` from
 * `nvidia/nvfp4`, `stealth` from `stealth` — is the unit `only` and the trust
 * list speak in.
 * @param slug - the endpoint tag.
 * @returns the part before the first `/`.
 */
export function baseSlugOf(slug: string): string {
  const slash = slug.indexOf('/')
  return slash === -1 ? slug : slug.slice(0, slash)
}

/** Whether a candidate costs nothing for both directions. */
function isFree(endpoint: Candidate): boolean {
  const prices = pricesOf(endpoint)
  return prices !== undefined && prices.prompt === 0 && prices.completion === 0
}

/**
 * Whether one candidate model cannot serve what this request carries.
 *
 * The catalog is the only evidence available, so an id it does not list and an
 * id it lists with no modalities are the same answer: the model is not shown to
 * accept the modality, and the request is refused rather than sent to a model
 * that may reject it mid-turn.
 * @param model - the exact model id about to be ranked.
 * @param policy - the tier's filters and this request's requirements.
 * @returns `'modality'` when the request needs a modality this model is not shown to accept, otherwise `undefined`.
 */
export function modelRejectionOf(model: string, policy: SelectionPolicy): EndpointRejection | undefined {
  const required = policy.requiredInput
  if (required === undefined) return undefined
  const declared = policy.modalities?.get(model)
  if (declared?.includes(required) !== true) return 'modality'
  return undefined
}

/**
 * The first reason one candidate cannot serve the tier, or `undefined` when it can.
 *
 * Order is the order the failures are worth reporting in: a tag excluded after a
 * failure explains everything below it, and a candidate nobody may use at all
 * explains itself better than a quantization it happens to declare.
 *
 * For a direct source the data-bearing filters (`status`, `uptime`,
 * `quantization`) are neutral: the route publishes no measurement, and an absent
 * measurement must not reject — that would keep every direct source out of the
 * ranking. The capability filters below them still apply, and `tools` is never
 * silent: a direct source states it with `tools`, an endpoint with
 * `supportedParameters`.
 * @param endpoint - the candidate to check.
 * @param policy - the tier's filters.
 * @returns the first failing reason, or `undefined` when the candidate is admissible.
 */
export function rejectionOf(endpoint: Candidate, policy: SelectionPolicy): EndpointRejection | undefined {
  const direct = isDirect(endpoint)
  const tag = direct ? endpoint.id : endpoint.slug
  if (policy.excludedTags.has(tag)) return 'excluded'
  if (direct && policy.excludedSources?.has(`${endpoint.route}:${endpoint.id}`) === true) return 'excluded'
  if (!direct) {
    if (policy.requireNormalStatus && endpoint.status !== undefined && endpoint.status !== 0) return 'status'
    if (policy.ignoreUptime !== true
      && endpoint.uptimeLast30m !== undefined && endpoint.uptimeLast30m < policy.minUptime) {
      return 'uptime'
    }
  }
  if (direct ? endpoint.tools === false
    : endpoint.supportedParameters === undefined || !endpoint.supportedParameters.includes('tools')) return 'tools'
  const contextLength = endpoint.contextLength
  if (contextLength !== undefined && contextLength < policy.contextWindow) return 'context'
  if (!direct) {
    const rank = quantizationRank(endpoint.quantization)
    const floor = quantizationRank(policy.minQuantization)
    if (rank === undefined) {
      const trusted = policy.unknownQuantization === 'accept'
        || (policy.unknownQuantization === 'trusted' && policy.trustedUnknownProviders.has(baseSlugOf(endpoint.slug)))
      if (!trusted) return 'untrusted-unknown'
    } else if (floor !== undefined && rank < floor) {
      return 'quantization'
    }
  }
  const prices = pricesOf(endpoint)
  if (prices === undefined) return 'unpriced'
  if (isFree(endpoint)) {
    if (policy.free === 'off' || !policy.allowFree) return 'free'
  } else if (policy.free === 'only') {
    return 'paid'
  }
  return undefined
}

/** Every rejection key at zero, so a caller never has to guard a missing field. */
function emptyRejections(): Record<EndpointRejection, number> {
  return {
    modality: 0,
    excluded: 0,
    status: 0,
    uptime: 0,
    tools: 0,
    context: 0,
    quantization: 0,
    'untrusted-unknown': 0,
    unpriced: 0,
    free: 0,
    paid: 0,
  }
}

/** The tag a candidate ranks and is excluded under: an endpoint's slug, a direct source's route id. */
function tagOf(candidate: Candidate): string {
  return isDirect(candidate) ? candidate.id : candidate.slug
}

/**
 * Filter and rank every candidate of every candidate model.
 *
 * Models are considered in the tier's own order — OpenRouter endpoints first,
 * then the model's direct sources in `extraSources` order — which is what makes
 * `preferModel` the only ordering rule that can override price: it sorts one
 * model's entries ahead of every other model's, and everything inside that group
 * is still price-ordered. Ties break on measured uptime, then on model and tag,
 * so the same fixture list always produces the same decision; a direct source
 * states no uptime and therefore sorts behind an equally priced endpoint that
 * measures one.
 * @param lists - candidate list per model, or the failure that model reported.
 * @param models - candidate model ids, in tier order.
 * @param policy - the tier's filters and this request's requirements.
 * @param mix - the turn's token buckets.
 * @returns the admitted candidates in order, plus why the rest were dropped.
 */
export function rankEndpoints(
  lists: EndpointLists,
  models: readonly string[],
  policy: SelectionPolicy,
  mix: TurnMix,
): SelectionResult {
  const rejections = emptyRejections()
  const unreadable: { model: string; reason: string }[] = []
  const ranked: RankedEndpoint[] = []
  const rejected: RejectedEndpoint[] = []
  let considered = 0
  for (const model of models) {
    const list = lists.get(model)
    if (list === undefined || list instanceof Error) {
      unreadable.push({ model, reason: list === undefined ? 'no endpoint list' : list.message })
      continue
    }
    const modelRejection = modelRejectionOf(model, policy)
    const candidates: readonly Candidate[] = [...list, ...(policy.extraSources?.get(model) ?? [])]
    for (const endpoint of candidates) {
      considered += 1
      const rejection = modelRejection ?? rejectionOf(endpoint, policy)
      if (rejection !== undefined) {
        rejections[rejection] += 1
        rejected.push({ model, endpoint, reason: rejection })
        continue
      }
      const price = blendedPrice(endpoint, mix)
      /* v8 ignore start -- `rejectionOf` has already refused anything unpriced,
         so this guard only narrows `price` for the ranking below. */
      if (price === undefined) {
        rejections.unpriced += 1
        rejected.push({ model, endpoint, reason: 'unpriced' })
        continue
      }
      /* v8 ignore stop */
      ranked.push({ model, endpoint, blendedUsdPerToken: price, free: isFree(endpoint) })
    }
  }
  ranked.sort((left, right) => {
    if (policy.preferModel !== undefined) {
      const leftPreferred = left.model === policy.preferModel
      const rightPreferred = right.model === policy.preferModel
      if (leftPreferred !== rightPreferred) return leftPreferred ? -1 : 1
    }
    if (left.blendedUsdPerToken !== right.blendedUsdPerToken) {
      return left.blendedUsdPerToken - right.blendedUsdPerToken
    }
    const leftUptime = isDirect(left.endpoint) ? undefined : left.endpoint.uptimeLast30m
    const rightUptime = isDirect(right.endpoint) ? undefined : right.endpoint.uptimeLast30m
    if (leftUptime !== rightUptime) {
      if (leftUptime === undefined) return 1
      if (rightUptime === undefined) return -1
      return rightUptime - leftUptime
    }
    if (left.model !== right.model) return left.model.localeCompare(right.model)
    return tagOf(left.endpoint).localeCompare(tagOf(right.endpoint))
  })
  return { ranked, rejections, considered, unreadable, rejected }
}

/**
 * Build the policy for one tier and one request.
 * @param tier - the tier whose filters apply.
 * @param settings - the whole settings value.
 * @param options - per-request overrides: free admission, recent failures, the model to keep, and the modality the request carries.
 * @returns the policy to rank under.
 */
export function policyFor(
  tier: TierSettingsSnapshot,
  settings: RoutingSettings,
  options: {
    allowFree: boolean
    excludedTags: ReadonlySet<string>
    preferModel?: string
    ignoreUptime?: boolean
    requiredInput?: RequiredInput
    modalities?: ReadonlyMap<string, readonly string[] | undefined>
    extraSources?: ReadonlyMap<string, readonly DirectSource[]>
    excludedSources?: ReadonlySet<string>
  },
): SelectionPolicy {
  return {
    contextWindow: tier.contextWindow,
    minQuantization: tier.minQuantization,
    unknownQuantization: tier.unknownQuantization,
    trustedUnknownProviders: new Set(settings.trustedUnknownProviders),
    free: tier.free,
    allowFree: options.allowFree,
    minUptime: settings.minUptime,
    requireNormalStatus: settings.requireNormalStatus,
    excludedTags: options.excludedTags,
    // §19 №5 / §3.3: the uptime floor is soft, so an unpassable one is dropped
    // rather than turned into a failure, and the relaxation is reported.
    ...options.ignoreUptime === true ? { ignoreUptime: true as const } : {},
    ...options.preferModel === undefined ? {} : { preferModel: options.preferModel },
    ...options.requiredInput === undefined ? {} : { requiredInput: options.requiredInput },
    ...options.modalities === undefined ? {} : { modalities: options.modalities },
    ...options.extraSources === undefined ? {} : { extraSources: options.extraSources },
    ...options.excludedSources === undefined ? {} : { excludedSources: options.excludedSources },
  }
}

/**
 * Rank, and once more without the uptime floor when nothing passed it.
 *
 * Re-ranking only when the floor is what emptied the list keeps the relaxation
 * narrow: a tier whose endpoints all lack `tools` still fails loudly rather than
 * dropping a filter the operator set for a different reason.
 * @param lists - endpoint list per model, or the failure that model reported.
 * @param models - candidate model ids, in tier order.
 * @param policy - the tier's filters.
 * @param mix - the turn's token buckets.
 * @returns the ranking plus whether the uptime floor had to be dropped.
 */
export function rankWithRelaxation(
  lists: EndpointLists,
  models: readonly string[],
  policy: SelectionPolicy,
  mix: TurnMix,
): SelectionResult & { relaxedUptime: boolean } {
  const first = rankEndpoints(lists, models, policy, mix)
  if (first.ranked.length === 0 && first.rejections.uptime > 0) {
    return { ...rankEndpoints(lists, models, { ...policy, ignoreUptime: true }, mix), relaxedUptime: true }
  }
  return { ...first, relaxedUptime: false }
}
