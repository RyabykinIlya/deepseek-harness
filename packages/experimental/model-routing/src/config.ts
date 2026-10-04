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
  rerouteCodes: Volatile<string[]>
  excludeAfterFailureMs: Volatile<number>
  freeForSubagents: Volatile<boolean>
  freeMinRemaining: Volatile<number>
  keyInfoTtlMs: Volatile<number>
  snapshotPolicy: Volatile<SnapshotPolicy>
  catalogTtlMs: Volatile<number>
  catalogTimeoutMs: Volatile<number>
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
  readonly rerouteCodes: readonly string[]
  readonly excludeAfterFailureMs: number
  readonly freeForSubagents: boolean
  readonly freeMinRemaining: number
  readonly keyInfoTtlMs: number
  readonly snapshotPolicy: SnapshotPolicy
  readonly catalogTtlMs: number
  readonly catalogTimeoutMs: number
}

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
  rerouteCodes: z.array(z.string())
    .default(['RATE_LIMIT', 'SERVER', 'TRANSPORT', 'TIMEOUT', 'PI_AI_ERROR'])
    .volatile(),
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
    rerouteCodes: config.rerouteCodes.get(),
    excludeAfterFailureMs: config.excludeAfterFailureMs.get(),
    freeForSubagents: config.freeForSubagents.get(),
    freeMinRemaining: config.freeMinRemaining.get(),
    keyInfoTtlMs: config.keyInfoTtlMs.get(),
    snapshotPolicy: config.snapshotPolicy.get(),
    catalogTtlMs: config.catalogTtlMs.get(),
    catalogTimeoutMs: config.catalogTimeoutMs.get(),
  }
}

/** A tier name is a route model id, so it must read as one and must not shadow `auto`. */
const TIER_NAME = /^[a-z][a-z0-9-]*$/

/** Fail a configuration the route cannot serve; the prefix every message carries. */
function invalid(message: string): never {
  throw new Error(`model-routing: ${message}`)
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
}
