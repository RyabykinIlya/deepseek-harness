/**
 * Endpoint filtering and ranking: which upstream providers may serve a tier's
 * models, and in what order the cheapest one is tried.
 *
 * The ranking key is a *blended* price per token, not a prompt price. An agent
 * turn is overwhelmingly cached input (§B.1: a 100k-token session re-reads 95k of
 * it), and the providers that look cheapest on prompt alone frequently publish no
 * cache-read discount at all — §B.1 measures Relace sixth and 7.5× the leader once
 * the cache term is in. So the mix is the decision, and the mix is either the
 * tier's configured default or the session's own measured usage.
 *
 * `preferModel` is what keeps a mid-dialog failure from changing the model. When
 * an endpoint fails, the exclusion list takes it out and the re-rank must exhaust
 * the *same* model's other providers before it reaches a different model; without
 * that rule one provider's rate limit would silently re-route a conversation.
 *
 * @module dsh-experimental-model-routing/select
 */

import type { OpenRouterEndpoint } from '@deepseek-ai/dsh-llm-pi-ai'
import type { FreeMode, Quantization, RoutingSettings, TierSettingsSnapshot } from './config.ts'
import { quantizationRank } from './quantization.ts'

/** Fraction of a turn's tokens spent in each bucket; the three sum to 1. */
export interface TurnMix {
  cached: number
  fresh: number
  output: number
}

/** A session's measured token spend, from the token-usage projection. */
export interface UsageTotals {
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/** Why one endpoint did not reach the ranking. */
export type EndpointRejection =
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
  /** Tags excluded after recent failures. */
  excludedTags: ReadonlySet<string>
  /** Model whose endpoints sort before every other model's, used when re-routing after a failure. */
  preferModel?: string
  /** Drops the uptime floor; set by `rankWithRelaxation` when nothing else passed. */
  readonly ignoreUptime?: true
}

/** One endpoint that passed every filter, with the price the ranking used. */
export interface RankedEndpoint {
  model: string
  endpoint: OpenRouterEndpoint
  blendedUsdPerToken: number
  free: boolean
}

/** The outcome of one ranking pass. */
export interface SelectionResult {
  ranked: readonly RankedEndpoint[]
  /** Every {@link EndpointRejection} key present, zero by default. */
  rejections: Readonly<Record<EndpointRejection, number>>
  /** Endpoints seen across every candidate model, admitted or not. */
  considered: number
  /** Models whose endpoint list could not be read. */
  unreadable: readonly { model: string; reason: string }[]
}

/** Endpoint list per model, or the failure that model reported. */
export type EndpointLists = ReadonlyMap<string, readonly OpenRouterEndpoint[] | Error>

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
 * @param usage - the session's measured totals, when a projection holds any.
 * @param fallback - the configured default mix.
 * @param minTokens - the total below which measured usage is not believed.
 * @returns the measured mix when it is believed, otherwise `fallback`.
 */
export function mixFromUsage(usage: UsageTotals | undefined, fallback: TurnMix, minTokens: number): TurnMix {
  if (usage === undefined) return fallback
  const cached = usage.cacheReadTokens
  const fresh = usage.uncachedInputTokens + usage.cacheWriteTokens
  const output = usage.outputTokens
  const total = cached + fresh + output
  if (total < minTokens) return fallback
  return { cached: cached / total, fresh: fresh / total, output: output / total }
}

/**
 * Cost of one token of the turn under one endpoint, in USD.
 *
 * A provider with no cache-read price charges the prompt price for a cache hit;
 * that is the honest reading, and it is why an unpriced cache term never
 * flatters a provider.
 * @param endpoint - the endpoint being priced.
 * @param mix - the turn's token buckets.
 * @returns the blended price, or `undefined` when the endpoint states no price.
 */
export function blendedPrice(endpoint: OpenRouterEndpoint, mix: TurnMix): number | undefined {
  const { promptPrice, completionPrice } = endpoint
  if (promptPrice === undefined || completionPrice === undefined) return undefined
  return mix.cached * (endpoint.inputCacheReadPrice ?? promptPrice)
    + mix.fresh * promptPrice
    + mix.output * completionPrice
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

/** Whether an endpoint costs nothing for both directions. */
function isFree(endpoint: OpenRouterEndpoint): boolean {
  return endpoint.promptPrice === 0 && endpoint.completionPrice === 0
}

/**
 * The first reason one endpoint cannot serve the tier, or `undefined` when it can.
 *
 * Order is the order the failures are worth reporting in: a tag excluded after a
 * failure explains everything below it, and an endpoint nobody may use at all
 * explains itself better than a quantization it happens to declare.
 * @param endpoint - the endpoint to check.
 * @param policy - the tier's filters.
 * @returns the first failing reason, or `undefined` when the endpoint is admissible.
 */
export function rejectionOf(endpoint: OpenRouterEndpoint, policy: SelectionPolicy): EndpointRejection | undefined {
  if (policy.excludedTags.has(endpoint.slug)) return 'excluded'
  if (policy.requireNormalStatus && endpoint.status !== undefined && endpoint.status !== 0) return 'status'
  if (policy.ignoreUptime !== true
    && endpoint.uptimeLast30m !== undefined && endpoint.uptimeLast30m < policy.minUptime) {
    return 'uptime'
  }
  if (endpoint.supportedParameters === undefined || !endpoint.supportedParameters.includes('tools')) return 'tools'
  if (endpoint.contextLength !== undefined && endpoint.contextLength < policy.contextWindow) return 'context'
  const rank = quantizationRank(endpoint.quantization)
  const floor = quantizationRank(policy.minQuantization)
  if (rank === undefined) {
    const trusted = policy.unknownQuantization === 'accept'
      || (policy.unknownQuantization === 'trusted' && policy.trustedUnknownProviders.has(baseSlugOf(endpoint.slug)))
    if (!trusted) return 'untrusted-unknown'
  } else if (floor !== undefined && rank < floor) {
    return 'quantization'
  }
  if (endpoint.promptPrice === undefined || endpoint.completionPrice === undefined) return 'unpriced'
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

/**
 * Filter and rank every endpoint of every candidate model.
 *
 * Models are considered in the tier's own order, which is what makes
 * `preferModel` the only ordering rule that can override price: it sorts one
 * model's entries ahead of every other model's, and everything inside that group
 * is still price-ordered. Ties break on measured uptime, then on model and tag,
 * so the same fixture list always produces the same decision.
 * @param lists - endpoint list per model, or the failure that model reported.
 * @param models - candidate model ids, in tier order.
 * @param policy - the tier's filters.
 * @param mix - the turn's token buckets.
 * @returns the admitted endpoints in order, plus why the rest were dropped.
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
  let considered = 0
  for (const model of models) {
    const list = lists.get(model)
    if (list === undefined || list instanceof Error) {
      unreadable.push({ model, reason: list === undefined ? 'no endpoint list' : list.message })
      continue
    }
    for (const endpoint of list) {
      considered += 1
      const rejection = rejectionOf(endpoint, policy)
      if (rejection !== undefined) {
        rejections[rejection] += 1
        continue
      }
      const price = blendedPrice(endpoint, mix)
      if (price === undefined) {
        rejections.unpriced += 1
        continue
      }
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
    const leftUptime = left.endpoint.uptimeLast30m
    const rightUptime = right.endpoint.uptimeLast30m
    if (leftUptime !== rightUptime) {
      if (leftUptime === undefined) return 1
      if (rightUptime === undefined) return -1
      return rightUptime - leftUptime
    }
    if (left.model !== right.model) return left.model.localeCompare(right.model)
    return left.endpoint.slug.localeCompare(right.endpoint.slug)
  })
  return { ranked, rejections, considered, unreadable }
}

/**
 * Build the policy for one tier and one request.
 * @param tier - the tier whose filters apply.
 * @param settings - the whole settings value.
 * @param options - per-request overrides: free admission, recent failures, and the model to keep.
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
