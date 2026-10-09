/**
 * Configuration schema, plain-value reader, and validator for the `tiers` route.
 *
 * Two kinds of field live here and the split is load-bearing. Non-volatile
 * fields change which models the route advertises and which endpoints it may
 * read, so changing one remounts the plugin; volatile fields are the user's
 * settings surface, so the settings editor and the config editor address exactly
 * the `.volatile()` names below as the `model-routing` namespace.
 *
 * `readSettings` exists because a request must not see a half-applied settings
 * document: it reads every `.get()` once into a plain object, and `validateSettings`
 * is the single place that decides whether that object is usable. Every caller
 * runs both, which is why the route never serves a decision taken under a
 * configuration that would have been refused at load.
 *
 * @module dsh-experimental-model-routing/config
 */

import type { Volatile, VolatileSnapshot } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

/** Weight quantizations OpenRouter names, coarsest last; the rank floor of §3.1 lives in `quantization.ts`. */
export const QUANTIZATIONS = [
  'int4', 'int8', 'fp4', 'mxfp4', 'nvfp4', 'fp6', 'fp8', 'mxfp8', 'fp16', 'bf16', 'fp32',
] as const

/** One quantization name OpenRouter may declare. */
export type Quantization = typeof QUANTIZATIONS[number]

/** What a tier does with endpoints that cost nothing. */
export type FreeMode = 'off' | 'prefer' | 'only'

/** Input modality a tier advertises to the model catalog. */
export type ModelInput = 'text' | 'image'

/** Prices of one direct source candidate, in USD per token. */
export interface ExtraSourcePrice {
  /** Flat per-token USD for input, output and cache alike; the subscription-style spelling. */
  usdPerToken?: number
  /** USD per input token; also the cache-read rate when `cacheReadUsdPerToken` is absent. */
  promptUsdPerToken?: number
  /** USD per output token; a flat `usdPerToken` also covers it. */
  completionUsdPerToken?: number
  /** USD per cached input token; absent charges `promptUsdPerToken` for a cache hit. */
  cacheReadUsdPerToken?: number
}

/** One non-OpenRouter candidate source of a tier: a pi-ai route and the models it serves. */
export interface ExtraSource {
  /** The pi-ai provider route that dispatches these models, for example `claude-proxy`. */
  route: string
  /** Model ids the route serves under their own names. */
  models: string[]
  /**
   * Canonical id to the route's own id, so `xiaomi/mimo-v2.6-pro` and
   * `mimo-v2.6-pro` rank as one model. A value may append `@` and a JSON price
   * object to state that candidate's own prices; {@link directSourceModels} is
   * the only reader of that spelling.
   */
  modelMap: Record<string, string>
  /** Prices every candidate of this source is priced at, when none states its own. */
  price: ExtraSourcePrice
  /**
   * Whether this route's models take tool calls (default `true`).
   *
   * An OpenRouter endpoint declares `tools` in `supportedParameters`; a direct
   * source states no parameters at all, so this is the declaration the `tools`
   * filter reads. Set it to `false` for a route that cannot serve a request
   * carrying tools — leaving it unset admits the source, never drops it silently.
   */
  tools: boolean
}

/**
 * One candidate one `extraSources` entry names: the canonical id it ranks under,
 * the route's own id, and the prices the entry states — the source's `price`, or
 * the candidate's own `@{...}` price object. This is the single reader of
 * `modelMap`, so the `@` spelling has exactly one meaning.
 */
export interface DirectSourceModel {
  /** Canonical model id, exactly as the tier or a request names it. */
  model: string
  /** The route's own id for this model. */
  id: string
  /** The prices this candidate is blended at, when it states any. */
  price?: ExtraSourcePrice
}

/** One price entry as a settings read returns it. */
export type ExtraSourcePriceSnapshot = VolatileSnapshot<ExtraSourcePrice>

/** One `extraSources` entry as a settings read returns it. */
export type ExtraSourceSnapshot = VolatileSnapshot<ExtraSource>

/** One direct-source candidate as {@link directSourceModels} returns it. */
export type DirectSourceModelSnapshot = VolatileSnapshot<DirectSourceModel>

/**
 * Whether a tier's configured model ids stand for themselves or for the family
 * they belong to (default `pinned`).
 *
 * `pinned` decides under the ids the configuration names, which is what makes a
 * deployment's cost and behavior reproducible from that configuration alone.
 * `latest` moves each id forward to the newest snapshot of its family before
 * deciding, so a tier follows new releases without being edited. An unversioned
 * id is not a rolling alias — `deepseek/deepseek-v4-pro` is the April snapshot of
 * that family — so `pinned` is the mode that can silently hold an old release.
 */
export type SnapshotPolicy = 'pinned' | 'latest'

/** One named group of interchangeable models. */
export interface TierSettings {
  /** Model id on the route: `^[a-z][a-z0-9-]*$`, not `auto`, unique. */
  name: string
  /** Label in the model picker. */
  label: string
  /** OpenRouter model ids `author/slug[:variant]`; non-empty, no duplicates within a tier. */
  models: string[]
  /** Model context window this tier advertises; integer > 0. Endpoints with `context_length` below it are rejected. */
  contextWindow: number
  /** Default output cap; integer > 0. */
  maxTokens: number
  /** Input modalities this tier advertises (default `['text']`). */
  input: ModelInput[]
  /** Lowest allowed quantization (default `fp8`). */
  minQuantization: Quantization
  /**
   * How an endpoint with `unknown` or absent quantization is treated (default `trusted`):
   * `reject` drops it, `trusted` admits it when its base provider slug is in
   * `trustedUnknownProviders`, `accept` admits every one.
   */
  unknownQuantization: 'reject' | 'trusted' | 'accept'
  /** Free endpoints: `off` rejects them, `prefer` admits them (price 0 always wins), `only` admits only them (default `off`). */
  free: FreeMode
  /**
   * Non-OpenRouter candidate sources, ranked alongside the tier's OpenRouter
   * endpoints (default `[]`). Each entry names the pi-ai route that dispatches
   * its models, the model ids that route serves — under their own names, or
   * through a `modelMap` from a canonical id to the route's id — and the
   * per-token prices the ranking blends. A source whose route is not configured
   * in `@deepseek-ai/dsh-llm-pi-ai` never ranks: the decision reports it as
   * undispatchable instead of pinning a request to a route nobody serves.
   */
  extraSources: ExtraSource[]
}

/** One agent preset whose Sessions start on a fixed `tiers` model. */
export interface PresetRoute {
  /** Agent preset id, for example `project`. */
  preset: string
  /** Model id of the `tiers` route the preset's sessions start on, for example `pro`. */
  model: string
}

/**
 * A tier exactly as a volatile settings read returns it.
 *
 * `Volatile.get()` hands back a deep-readonly snapshot, so this — not
 * {@link TierSettings} — is the type a request reads a tier under. The two agree
 * field for field; only the mutability differs, and a decision must never mutate
 * the settings it was taken from.
 */
export type TierSettingsSnapshot = VolatileSnapshot<TierSettings>

/** One agent preset as a settings read returns it. */
export type PresetRouteSnapshot = VolatileSnapshot<PresetRoute>

/** Plugin configuration. */
export interface Config {
  // Non-volatile: a change remounts the plugin.
  routeName: string
  routeLabel: string
  innerRoute: string
  baseUrl: string
  decisionsUrl: string
  apiKeyRef: string
  // Volatile: user-editable settings.
  tiers: Volatile<TierSettings[]>
  efforts: Volatile<string[]>
  defaultEffort: Volatile<string>
  autoLabel: Volatile<string>
  defaultTier: Volatile<string>
  presetRoutes: Volatile<PresetRoute[]>
  judgeEnabled: Volatile<boolean>
  judgeModel: Volatile<string>
  trustedUnknownProviders: Volatile<string[]>
  judgeTimeoutMs: Volatile<number>
  judgeUserMessages: Volatile<number>
  judgeMaxStateChars: Volatile<number>
  judgeProTier: Volatile<string>
  judgeFlashTier: Volatile<string>
  judgeStartProAt: Volatile<number>
  judgeToProAt: Volatile<number>
  judgeToFlashAt: Volatile<number>
  judgeMinConfidence: Volatile<number>
  judgePrecisionProAt: Volatile<number>
  judgeTierInstructions: Volatile<string>
  judgeFlashCriteria: Volatile<string>
  judgeProCriteria: Volatile<string>
  judgeDifficultyInstructions: Volatile<string>
  judgeDifficultyLevels: Volatile<string[]>
  judgePrecisionInstructions: Volatile<string>
  judgePrecisionTrue: Volatile<string>
  judgePrecisionFalse: Volatile<string>
  cacheIdleMs: Volatile<number>
  endpointsTtlMs: Volatile<number>
  endpointsTimeoutMs: Volatile<number>
  minUptime: Volatile<number>
  requireNormalStatus: Volatile<boolean>
  onEndpointsUnavailable: Volatile<'sort-price' | 'fail'>
  mixCached: Volatile<number>
  mixFresh: Volatile<number>
  mixOutput: Volatile<number>
  mixMinTokens: Volatile<number>
  maxReroutes: Volatile<number>
  noRerouteCodes: Volatile<string[]>
  /**
   * How many consecutive failures one candidate may record before it is benched
   * for {@link excludeAfterFailureMs} (default 5).
   *
   * The count is per candidate and per Session, and a success clears it, so one
   * blip does not displace a route that has been answering. `1` benches on the
   * first failure.
   */
  excludeAfterFailures: Volatile<number>
  /**
   * How long a benched candidate stays out of the ranking, in milliseconds
   * (default 600000).
   *
   * Benching exists so a retry can reach a different candidate: the failure
   * boundary outranks every reason to keep the current pin, so without it the
   * next decision would pick the endpoint that just failed again.
   */
  excludeAfterFailureMs: Volatile<number>
  freeForSubagents: Volatile<boolean>
  freeMinRemaining: Volatile<number>
  keyInfoTtlMs: Volatile<number>
  snapshotPolicy: Volatile<SnapshotPolicy>
  catalogTtlMs: Volatile<number>
  catalogTimeoutMs: Volatile<number>
  diagnosticsPath: Volatile<string>
  diagnosticsMaxBytes: Volatile<number>
}

/**
 * Every volatile field read once, as one plain value.
 *
 * A request runs this before it decides anything: reading each `.get()` at the
 * point of use would let a settings edit land mid-decision and produce a
 * decision no single configuration authorizes.
 */
export interface RoutingSettings {
  readonly tiers: readonly TierSettingsSnapshot[]
  readonly efforts: readonly string[]
  readonly defaultEffort: string
  readonly autoLabel: string
  readonly defaultTier: string
  readonly presetRoutes: readonly PresetRouteSnapshot[]
  readonly judgeEnabled: boolean
  readonly judgeModel: string
  readonly trustedUnknownProviders: readonly string[]
  readonly judgeTimeoutMs: number
  readonly judgeUserMessages: number
  readonly judgeMaxStateChars: number
  readonly judgeProTier: string
  readonly judgeFlashTier: string
  readonly judgeStartProAt: number
  readonly judgeToProAt: number
  readonly judgeToFlashAt: number
  readonly judgeMinConfidence: number
  readonly judgePrecisionProAt: number
  readonly judgeTierInstructions: string
  readonly judgeFlashCriteria: string
  readonly judgeProCriteria: string
  readonly judgeDifficultyInstructions: string
  readonly judgeDifficultyLevels: readonly string[]
  readonly judgePrecisionInstructions: string
  readonly judgePrecisionTrue: string
  readonly judgePrecisionFalse: string
  readonly cacheIdleMs: number
  readonly endpointsTtlMs: number
  readonly endpointsTimeoutMs: number
  readonly minUptime: number
  readonly requireNormalStatus: boolean
  readonly onEndpointsUnavailable: 'sort-price' | 'fail'
  readonly mixCached: number
  readonly mixFresh: number
  readonly mixOutput: number
  readonly mixMinTokens: number
  readonly maxReroutes: number
  readonly noRerouteCodes: readonly string[]
  readonly excludeAfterFailures: number
  readonly excludeAfterFailureMs: number
  readonly freeForSubagents: boolean
  readonly freeMinRemaining: number
  readonly keyInfoTtlMs: number
  readonly snapshotPolicy: SnapshotPolicy
  readonly catalogTtlMs: number
  readonly catalogTimeoutMs: number
  /** File the decision diagnostics are appended to; empty writes no history. */
  readonly diagnosticsPath: string
  /** The largest one diagnostics line may reach, in bytes. */
  readonly diagnosticsMaxBytes: number
}

/**
 * Per-token price of one direct source candidate, as a settings row spells it.
 *
 * The field names mirror {@link ExtraSourcePrice} rather than OpenRouter's
 * endpoint vocabulary: a direct source states what a token costs on its own
 * route, and `usdPerToken` is the one-number spelling a subscription-style
 * source uses for input, output and cache alike. `directPricesOf` decides what
 * an entry means; nothing else interprets these fields.
 */
const extraSourcePrice: z<ExtraSourcePrice> = z.object({
  usdPerToken: z.number(),
  promptUsdPerToken: z.number(),
  completionUsdPerToken: z.number(),
  cacheReadUsdPerToken: z.number(),
})

const extraSource: z<ExtraSource> = z.object({
  route: z.string(),
  models: z.array(z.string()),
  modelMap: z.dict(z.string()),
  price: extraSourcePrice,
  tools: z.boolean().default(true),
})

const tierSettings: z<TierSettings> = z.object({
  name: z.string(),
  label: z.string(),
  models: z.array(z.string()),
  contextWindow: z.number(),
  maxTokens: z.number(),
  input: z.array(z.union(['text', 'image'] as const)).default(['text']),
  minQuantization: z.union(QUANTIZATIONS).default('fp8'),
  unknownQuantization: z.union(['reject', 'trusted', 'accept'] as const).default('trusted'),
  free: z.union(['off', 'prefer', 'only'] as const).default('off'),
  extraSources: z.array(extraSource).default([]),
})

/**
 * `trustedUnknownProviders` default, from the W0 survey (`quantization-survey/report.md`, §8).
 * Every entry is a hyperscale cloud, a model author's own runtime, or a large inference
 * platform that declares `unknown` on official-author models. The newcomer hosts —
 * `relace`, `venice`, `wafer`, `phala`, `dekallm` and the rest — are deliberately absent:
 * there `unknown` is a way of not saying.
 */
export const DEFAULT_TRUSTED_UNKNOWN_PROVIDERS: readonly string[] = [
  'amazon-bedrock',
  'anthropic',
  'azure',
  'cloudflare',
  'cohere',
  'deepseek',
  'fireworks',
  'google-ai-studio',
  'google-vertex',
  'groq',
  'mistral',
  'novita',
  'sambanova',
  'streamlake',
  'together',
  'stealth',
]

/** Runtime schema for {@link Config}. */
export const Config = z.object({
  routeName: z.string().default('tiers'),
  routeLabel: z.string().default('Tiers'),
  innerRoute: z.string().default('openrouter'),
  baseUrl: z.string().default('https://openrouter.ai/api/v1'),
  decisionsUrl: z.string().default('https://openrouter.ai/api/alpha/decisions'),
  apiKeyRef: z.string().default('OPENROUTER_API_KEY').role('credential-ref'),
  tiers: z.array(tierSettings).default([]).volatile(),
  efforts: z.array(z.string()).default(['low', 'medium', 'high']).volatile(),
  defaultEffort: z.string().default('high').volatile(),
  autoLabel: z.string().default('Auto').volatile(),
  defaultTier: z.string().default('flash').volatile(),
  presetRoutes: z.array(z.object({
    preset: z.string(),
    model: z.string(),
  })).default([]).volatile(),
  judgeEnabled: z.boolean().default(true).volatile(),
  // Pinned, not an alias: §19 №1 — an alias silently moves to a new version and
  // every calibrated threshold below stops meaning what it meant.
  judgeModel: z.string().default('typesafe/jev-1.13').volatile(),
  trustedUnknownProviders: z.array(z.string()).default([...DEFAULT_TRUSTED_UNKNOWN_PROVIDERS]).volatile(),
  judgeTimeoutMs: z.number().default(3000).volatile(),
  judgeUserMessages: z.number().default(3).volatile(),
  judgeMaxStateChars: z.number().default(12000).volatile(),
  judgeProTier: z.string().default('pro').volatile(),
  judgeFlashTier: z.string().default('flash').volatile(),
  judgeStartProAt: z.number().default(0.5).volatile(),
  judgeToProAt: z.number().default(0.6).volatile(),
  judgeToFlashAt: z.number().default(0.3).volatile(),
  judgeMinConfidence: z.number().default(0.5).volatile(),
  judgePrecisionProAt: z.number().default(0.8).volatile(),
  judgeTierInstructions: z.string().default(
    'Which model tier should handle the user\'s latest request in a coding agent?',
  ).volatile(),
  judgeFlashCriteria: z.string().default(
    'Routine, well-specified work: small edits, lookups, renames, running commands, summarizing,'
    + ' straightforward bug fixes with an obvious cause.',
  ).volatile(),
  judgeProCriteria: z.string().default(
    'Hard work: architecture or design decisions, ambiguous requirements, subtle concurrency/lifecycle'
    + ' bugs, multi-file refactors, security-sensitive changes, debugging with unknown cause.',
  ).volatile(),
  judgeDifficultyInstructions: z.string().default(
    'How difficult is the user\'s latest request for a coding agent?',
  ).volatile(),
  judgeDifficultyLevels: z.array(z.string())
    .default(['Trivial', 'Routine', 'Moderate', 'Hard', 'Very hard'])
    .volatile(),
  judgePrecisionInstructions: z.string().default(
    'Does a mistake here carry a high cost (data loss, security, broken release, wrong design that is'
    + ' expensive to undo)?',
  ).volatile(),
  judgePrecisionTrue: z.string().default('A mistake is costly or hard to undo').volatile(),
  judgePrecisionFalse: z.string().default('A mistake is cheap and easy to fix').volatile(),
  cacheIdleMs: z.number().default(600000).volatile(),
  endpointsTtlMs: z.number().default(3600000).volatile(),
  endpointsTimeoutMs: z.number().default(10000).volatile(),
  minUptime: z.number().default(90).volatile(),
  requireNormalStatus: z.boolean().default(true).volatile(),
  onEndpointsUnavailable: z.union(['sort-price', 'fail'] as const).default('sort-price').volatile(),
  mixCached: z.number().default(0.9).volatile(),
  mixFresh: z.number().default(0.08).volatile(),
  mixOutput: z.number().default(0.02).volatile(),
  mixMinTokens: z.number().default(1000).volatile(),
  maxReroutes: z.number().default(2).volatile(),
  // Rerouting is the default for every failure that arrives before the first
  // content chunk: nothing has streamed yet, so another candidate serves the
  // request without costing the turn. This list names the codes no candidate
  // can serve — the request itself is the problem, not the endpoint — so they
  // surface to the caller instead of spending the reroute budget. A cancelled
  // request and an image budget every route shares belong here for the same
  // reason; a code missing from this list reroutes, so a new provider rejection
  // is covered by default rather than becoming a failed turn.
  noRerouteCodes: z.array(z.string())
    .default(['CONTEXT_WINDOW_EXCEEDED', 'IMAGE_OFFLOAD_REQUIRED', 'ABORTED'])
    .volatile(),
  excludeAfterFailures: z.number().default(5).volatile(),
  excludeAfterFailureMs: z.number().default(600000).volatile(),
  freeForSubagents: z.boolean().default(false).volatile(),
  freeMinRemaining: z.number().default(20).volatile(),
  keyInfoTtlMs: z.number().default(60000).volatile(),
  snapshotPolicy: z.union(['pinned', 'latest'] as const).default('pinned').volatile(),
  // The catalog is one list for the whole deployment and changes only when a
  // publisher releases something, so it outlives the endpoint lists' own churn by
  // an order of magnitude and is read on the same one-hour cadence.
  catalogTtlMs: z.number().default(3600000).volatile(),
  // A catalog read transfers the whole list, which is an order of magnitude more
  // than one model's endpoint list, so it is given more of the caller's budget.
  catalogTimeoutMs: z.number().default(15000).volatile(),
  // The diagnostics history is an operator artefact rather than product state:
  // it records the candidate table of every decision, so it is off until a
  // deployment names a file to keep it in.
  diagnosticsPath: z.string().default('').volatile(),
  // One decision line is bounded in bytes rather than in candidate count,
  // because a candidate's size is decided by what the wire sent, not by the
  // number of rows.
  diagnosticsMaxBytes: z.number().default(262144).volatile(),
})

/**
 * Read every volatile field once into a plain value.
 * @param config - the plugin's resolved configuration section.
 * @returns one immutable settings value a whole request can decide under.
 */
export function readSettings(config: Config): RoutingSettings {
  return {
    tiers: config.tiers.get(),
    efforts: config.efforts.get(),
    defaultEffort: config.defaultEffort.get(),
    autoLabel: config.autoLabel.get(),
    defaultTier: config.defaultTier.get(),
    presetRoutes: config.presetRoutes.get(),
    judgeEnabled: config.judgeEnabled.get(),
    judgeModel: config.judgeModel.get(),
    trustedUnknownProviders: config.trustedUnknownProviders.get(),
    judgeTimeoutMs: config.judgeTimeoutMs.get(),
    judgeUserMessages: config.judgeUserMessages.get(),
    judgeMaxStateChars: config.judgeMaxStateChars.get(),
    judgeProTier: config.judgeProTier.get(),
    judgeFlashTier: config.judgeFlashTier.get(),
    judgeStartProAt: config.judgeStartProAt.get(),
    judgeToProAt: config.judgeToProAt.get(),
    judgeToFlashAt: config.judgeToFlashAt.get(),
    judgeMinConfidence: config.judgeMinConfidence.get(),
    judgePrecisionProAt: config.judgePrecisionProAt.get(),
    judgeTierInstructions: config.judgeTierInstructions.get(),
    judgeFlashCriteria: config.judgeFlashCriteria.get(),
    judgeProCriteria: config.judgeProCriteria.get(),
    judgeDifficultyInstructions: config.judgeDifficultyInstructions.get(),
    judgeDifficultyLevels: config.judgeDifficultyLevels.get(),
    judgePrecisionInstructions: config.judgePrecisionInstructions.get(),
    judgePrecisionTrue: config.judgePrecisionTrue.get(),
    judgePrecisionFalse: config.judgePrecisionFalse.get(),
    cacheIdleMs: config.cacheIdleMs.get(),
    endpointsTtlMs: config.endpointsTtlMs.get(),
    endpointsTimeoutMs: config.endpointsTimeoutMs.get(),
    minUptime: config.minUptime.get(),
    requireNormalStatus: config.requireNormalStatus.get(),
    onEndpointsUnavailable: config.onEndpointsUnavailable.get(),
    mixCached: config.mixCached.get(),
    mixFresh: config.mixFresh.get(),
    mixOutput: config.mixOutput.get(),
    mixMinTokens: config.mixMinTokens.get(),
    maxReroutes: config.maxReroutes.get(),
    noRerouteCodes: config.noRerouteCodes.get(),
    excludeAfterFailures: config.excludeAfterFailures.get(),
    excludeAfterFailureMs: config.excludeAfterFailureMs.get(),
    freeForSubagents: config.freeForSubagents.get(),
    freeMinRemaining: config.freeMinRemaining.get(),
    keyInfoTtlMs: config.keyInfoTtlMs.get(),
    snapshotPolicy: config.snapshotPolicy.get(),
    catalogTtlMs: config.catalogTtlMs.get(),
    catalogTimeoutMs: config.catalogTimeoutMs.get(),
    diagnosticsPath: config.diagnosticsPath.get(),
    diagnosticsMaxBytes: config.diagnosticsMaxBytes.get(),
  }
}

/**
 * The candidates one tier's `extraSources` name, in configuration order.
 *
 * `models` entries rank under their own id; every `modelMap` entry ranks under
 * its canonical key against the route's own id. A `modelMap` value may append
 * `@` and a JSON {@link ExtraSourcePrice} object to state that candidate's own
 * prices — a subscription plan's flat `usdPerToken` is the usual shape — and an
 * entry without one is priced by the source's `price`. This is the only reader
 * of `modelMap`, so the `@` spelling has exactly one meaning.
 * @param source - one configured `extraSources` entry.
 * @returns the candidates this entry names, in configuration order.
 * @throws Error prefixed `model-routing: ` for an entry the route cannot serve.
 */
export function directSourceModels(source: ExtraSourceSnapshot): DirectSourceModel[] {
  const candidates: DirectSourceModel[] = []
  for (const model of source.models) candidates.push({ model, id: model, ...priced(source) })
  for (const [canonical, value] of Object.entries(source.modelMap)) {
    const at = value.indexOf('@')
    const id = at === -1 ? value : value.slice(0, at)
    const own = at === -1 ? undefined : parsePrice(value.slice(at + 1), `tier extraSource "${source.route}"`, canonical)
    candidates.push({ model: canonical, id, ...priced({ price: own ?? source.price }) })
  }
  return candidates
}

/** The priced fields of one candidate, omitted when the entry states no prices. */
function priced(source: { readonly price: ExtraSourcePriceSnapshot }): Pick<DirectSourceModel, 'price'> {
  return Object.keys(source.price).length === 0 ? {} : { price: source.price }
}

/**
 * One candidate's own price object from its `modelMap` value.
 * @param text - the text after the value's `@`.
 * @param where - the entry's own naming in a message, `tier "…" extraSource "…"`.
 * @param canonical - the canonical id whose value is being read.
 * @returns the parsed prices.
 * @throws Error prefixed `model-routing: ` for text that is not a price object of non-negative numbers.
 */
function parsePrice(text: string, where: string, canonical: string): ExtraSourcePrice {
  const fail = (reason: string): never => invalid(
    `${where} modelMap["${canonical}"] price must be ${reason}`,
  )
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return fail('a JSON object')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return fail('a JSON object')
  const known = new Set(['usdPerToken', 'promptUsdPerToken', 'completionUsdPerToken', 'cacheReadUsdPerToken'])
  const price: ExtraSourcePrice = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!known.has(key) || typeof value !== 'number' || !(value >= 0)) {
      return fail('a JSON object of the price fields with non-negative numbers')
    }
    Object.assign(price, { [key]: value })
  }
  return price
}

/** A tier name is a route model id, so it must read as one and must not shadow `auto`. */
const TIER_NAME = /^[a-z][a-z0-9-]*$/

/** Fail a configuration the route cannot serve; the prefix every message carries. */
function invalid(message: string): never {
  throw new Error(`model-routing: ${message}`)
}

/**
 * Refuse an `extraSources` entry the route cannot serve.
 *
 * A source names models by route, not by OpenRouter id, so the checks are about
 * identity rather than format: a non-empty route key, a non-empty canonical id
 * and route id per candidate, and one candidate per canonical id — a duplicate
 * would make the ranking's candidate map ambiguous. A price object the parser
 * cannot read is refused here rather than at the first decision that prices it.
 * @param tier - the tier whose sources to check.
 * @throws Error prefixed `model-routing: ` naming the first field that cannot be served.
 */
function validateExtraSources(tier: TierSettingsSnapshot): void {
  const seen = new Set<string>()
  for (const source of tier.extraSources) {
    if (source.route.trim() === '') {
      invalid(`tier "${tier.name}" extraSource route must be a non-empty route key`)
    }
    if (source.models.length === 0 && Object.keys(source.modelMap).length === 0) {
      invalid(`tier "${tier.name}" extraSource "${source.route}" names no models`)
    }
    const route = `tier "${tier.name}" extraSource "${source.route}"`
    for (const model of source.models) {
      if (model.trim() === '') invalid(`${route} model must be a non-empty id`)
      const key = `${source.route}:${model}`
      if (seen.has(key)) invalid(`${route} model "${model}" appears twice in the tier's sources`)
      seen.add(key)
    }
    for (const [field, price] of Object.entries(source.price)) {
      if (typeof price !== 'number' || !(price >= 0)) invalid(`${route} price ${field} must be a non-negative number`)
    }
    for (const [canonical, value] of Object.entries(source.modelMap)) {
      if (canonical.trim() === '') invalid(`${route} modelMap key must be a non-empty canonical id`)
      const at = value.indexOf('@')
      const id = at === -1 ? value : value.slice(0, at)
      if (id.trim() === '') invalid(`${route} modelMap["${canonical}"] must be a non-empty route id`)
      // Two sources serving one canonical id is the whole point of `extraSources`
      // — they rank against each other — so the duplication worth refusing is one
      // route naming the same canonical id twice, which would make its own
      // candidate list ambiguous.
      const key = `${source.route}:${canonical}`
      if (seen.has(key)) invalid(`${route} modelMap["${canonical}"] names a model this source already serves`)
      seen.add(key)
      if (at !== -1) parsePrice(value.slice(at + 1), route, canonical)
    }
  }
}

/**
 * Refuse a settings value the route cannot act on.
 *
 * The checks are ordered cheapest-first and stop at the first failure, because
 * one unusable settings object has one message: the operator fixes that and
 * re-reads. Tier-name and tier-reference checks are skipped when `tiers` is
 * empty — an unconfigured route is dormant, not broken.
 * @param settings - the plain settings value to check.
 * @throws Error prefixed `model-routing: ` naming the first field that cannot be served.
 */
export function validateSettings(settings: RoutingSettings): void {
  const names = new Set<string>()
  for (const tier of settings.tiers) {
    if (!TIER_NAME.test(tier.name) || tier.name === 'auto') {
      invalid(`tier name "${tier.name}" must match ^[a-z][a-z0-9-]*$ and must not be "auto"`)
    }
    if (names.has(tier.name)) invalid(`tier name "${tier.name}" is used twice`)
    names.add(tier.name)
    if (tier.models.length === 0) invalid(`tier "${tier.name}" lists no models`)
    const models = new Set<string>()
    for (const model of tier.models) {
      if (!model.includes('/') || models.has(model)) {
        invalid(`tier "${tier.name}" model "${model}" must be an OpenRouter id author/slug and appear once`)
      }
      models.add(model)
    }
    if (!Number.isInteger(tier.contextWindow) || tier.contextWindow <= 0) {
      invalid(`tier "${tier.name}" contextWindow must be a positive integer`)
    }
    if (!Number.isInteger(tier.maxTokens) || tier.maxTokens <= 0) {
      invalid(`tier "${tier.name}" maxTokens must be a positive integer`)
    }
    if (tier.unknownQuantization === 'trusted' && settings.trustedUnknownProviders.length === 0) {
      invalid(`tier "${tier.name}" trusts unknown quantization but trustedUnknownProviders is empty`)
    }
    validateExtraSources(tier)
  }
  if (settings.efforts.length === 0 || new Set(settings.efforts).size !== settings.efforts.length) {
    invalid('efforts must be a non-empty list of unique ids')
  }
  if (!settings.efforts.includes(settings.defaultEffort)) {
    invalid(`defaultEffort "${settings.defaultEffort}" is not in efforts`)
  }
  if (settings.tiers.length > 0) {
    const tierRef = (field: string, value: string, allowAuto: boolean): void => {
      if (value === 'auto' && allowAuto) return
      if (!names.has(value)) invalid(`${field} "${value}" is not a configured tier`)
    }
    tierRef('defaultTier', settings.defaultTier, false)
    tierRef('judgeProTier', settings.judgeProTier, false)
    tierRef('judgeFlashTier', settings.judgeFlashTier, false)
    for (const route of settings.presetRoutes) tierRef('presetRoutes[].model', route.model, true)
  }
  const thresholds = [
    settings.judgeStartProAt, settings.judgeToProAt, settings.judgeToFlashAt, settings.judgeMinConfidence,
    settings.judgePrecisionProAt,
  ]
  if (thresholds.some(value => !(value >= 0 && value <= 1)) || settings.judgeToFlashAt >= settings.judgeToProAt) {
    invalid('judge thresholds must lie in [0, 1] with judgeToFlashAt < judgeToProAt')
  }
  const mixSum = settings.mixCached + settings.mixFresh + settings.mixOutput
  if (settings.mixCached < 0 || settings.mixFresh < 0 || settings.mixOutput < 0 || mixSum === 0) {
    invalid('mixCached, mixFresh and mixOutput must be non-negative with a positive sum')
  }
  if (!Number.isInteger(settings.maxReroutes) || settings.maxReroutes < 0) {
    invalid('maxReroutes must be a non-negative integer')
  }
  if (!Number.isInteger(settings.excludeAfterFailures) || settings.excludeAfterFailures < 1) {
    invalid('excludeAfterFailures must be a positive integer')
  }
  if (settings.noRerouteCodes.some(code => code.length === 0)
    || new Set(settings.noRerouteCodes).size !== settings.noRerouteCodes.length) {
    invalid('noRerouteCodes must contain unique non-empty codes')
  }
  if (!Number.isInteger(settings.diagnosticsMaxBytes) || settings.diagnosticsMaxBytes < 1) {
    invalid('diagnosticsMaxBytes must be a positive integer')
  }
}
