/**
 * The staged editor for the `model-routing` settings namespace.
 *
 * The page edits one thing — which models belong to which tier, and the filters
 * that decide which provider may serve one — so the controller's whole job is to
 * keep a draft, price the models the draft selects, and persist the change as a
 * single revision-fenced mutation. Everything else the page shows is read
 * straight from the Host's settings value.
 *
 * Prices are fetched per tier and per draft, and are never part of what is
 * written: a price is a live fact that changes every hour, and storing one in
 * the settings document would make it stale the moment it landed.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ModelProviderGroup } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsFormPathOp, SettingsFormScope, SettingsFormShell } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ModelQuote, Quantization, TierSettings } from '@deepseek-ai/dsh-experimental-model-routing/client'

export type { TierSettings }

/** Namespace of the Host-owned model-routing settings. */
export const MODEL_ROUTING_NS = 'model-routing'

/** Settings fields this page reads and writes. */
export interface ModelRoutingSettings {
  tiers: readonly TierSettings[]
  judgeEnabled: boolean
  defaultTier: string
  /** Idle interval in milliseconds; the page edits it in minutes. */
  cacheIdleMs: number
  freeForSubagents: boolean
  trustedUnknownProviders: readonly string[]
}

/** How the page presents the form. */
export type ModelRoutingViewMode = 'full' | 'summary'

/** One tier row plus what the draft changed. */
export interface TierRow extends TierSettings {
  /** Index in the draft, used as a stable key. */
  index: number
  /** Substring filter over the catalog list. */
  filter: string
  /** Whether this tier has unsaved edits. */
  dirty: boolean
  /** `contextWindow` as the numeric control's raw staged text, mid-edit included. */
  contextWindowText: string
  /** `maxTokens` as the numeric control's raw staged text, mid-edit included. */
  maxTokensText: string
}

/** One catalog model the draft may check. */
export interface ModelCandidate {
  /** OpenRouter model id. */
  model: string
  /** Adapter-owned display name. */
  modelName: string
  /** Whether the draft selected this model for its tier. */
  selected: boolean
}

/** What a quote answered about one selected model. */
export interface QuoteRow {
  model: string
  text: string
  unavailable: boolean
}

/** State rendered by the staged card. */
export interface ModelRoutingCardState extends SettingsFormShell {
  view: ModelRoutingViewMode
  tiers: readonly TierRow[]
  candidates: readonly ModelCandidate[]
  quotes: Readonly<Record<string, QuoteRow>>
  selectedTier: number
  dirty: boolean
  saving: boolean
  failed: boolean
  conflicted: boolean
  catalogStatus: 'idle' | 'loading' | 'ready' | 'error'
  freeUsage: { used: number; limit: number } | undefined
  freeUsageKnown: boolean
  /** Whether the judge picks the tier, or the session stays on one model. */
  judgeEnabled: boolean
  /** Tier a session starts on before the judge speaks. */
  defaultTier: string
  /** Idle interval in minutes, as the numeric control edits it. */
  cacheIdleMinutes: number
  /** `cacheIdleMinutes` as the numeric control's raw staged text, mid-edit included. */
  cacheIdleMinutesText: string
  /** Whether subagents may use free endpoints. */
  freeForSubagents: boolean
  /** The trusted unknown-quantization provider slugs, space-separated for the text control. */
  trustedProvidersText: string
}

/** Tier fields the card's controls stage, and the coercions they apply. */
export type TierField = 'label' | 'minQuantization' | 'unknownQuantization' | 'free' | 'contextWindow' | 'maxTokens'

/** Registration-side face for the model-routing card. */
export interface ModelRoutingCardFace {
  hooks: {
    modelRoutingCard: SnapshotStore<ModelRoutingCardState>
  }
  setView: (view: ModelRoutingViewMode) => void
  selectTier: (index: number) => void
  setFilter: (index: number, filter: string) => void
  toggleModel: (index: number, model: string) => void
  setTierField: (index: number, field: TierField, value: string) => void
  setTrustedProviders: (value: string) => void
  setJudgeEnabled: (value: boolean) => void
  setDefaultTier: (value: string) => void
  setCacheIdleMinutes: (value: string) => void
  setFreeForSubagents: (value: boolean) => void
  retryCatalog: () => void
  save: () => void
  discard: () => void
}

/**
 * The inner pi-ai route whose catalog publishes the tier's model ids.
 *
 * Spelled here rather than read from the Host: this is a browser bundle, and the
 * row it must find is the one `dsh-experimental-model-routing` dispatches
 * through by default.
 */
const INNER_ROUTE = 'openrouter'

/** Every quantization name the tier filter may name. */
export const QUANTIZATION_NAMES: readonly Quantization[] = [
  'int4', 'int8', 'fp4', 'mxfp4', 'nvfp4', 'fp6', 'fp8', 'mxfp8', 'fp16', 'bf16', 'fp32',
]

/**
 * Format a blended per-token price as a per-million price.
 *
 * The route blends the three token buckets with one mix, so there is no single
 * "price per token" to show — per million of the mix is the unit a person can
 * compare against a provider's own table.
 * @param blendedUsdPerToken - blended USD per token.
 * @returns three significant figures of USD per million tokens.
 */
export function pricePerMillion(blendedUsdPerToken: number): string {
  const perMillion = blendedUsdPerToken * 1e6
  return perMillion === 0 ? '0' : perMillion.toPrecision(3)
}

/** Whether two settings values say the same thing. */
function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/** Key one tier's staged numeric-field raw text is stored under. */
function numberDraftKey(index: number, field: 'contextWindow' | 'maxTokens'): string {
  return `${index}:${field}`
}

/**
 * Parse a positive integer a numeric control staged.
 *
 * The rounded value, not the raw parse, is what must be positive: `0.4` is a
 * finite number greater than zero, but rounds to `0`, which every numeric
 * field here treats as empty rather than as a stored value.
 * @param text - the control's raw staged text.
 * @returns the rounded positive integer, or `undefined` while the text is not one.
 */
function parsePositiveInteger(text: string): number | undefined {
  const parsed = Number(text)
  const rounded = Math.round(parsed)
  return Number.isFinite(parsed) && rounded > 0 ? rounded : undefined
}

/**
 * Parse a positive minute count into milliseconds.
 * @param text - the control's raw staged text.
 * @returns the rounded millisecond value, or `undefined` while the text is not a positive number.
 */
function parsePositiveMinutesMs(text: string): number | undefined {
  const parsed = Number(text)
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * 60_000) : undefined
}

/** Bridges the `model-routing` configuration form and the live catalog onto a staged card. */
export class ModelRoutingCardController {
  private catalogGroups: readonly ModelProviderGroup[] = []
  private catalogStatus: ModelRoutingCardState['catalogStatus'] = 'idle'
  private view: ModelRoutingViewMode = 'full'
  private selectedTier = 0
  private filters: string[] = []
  private draftTiers: TierSettings[] | undefined
  private draftExtra: Partial<ModelRoutingSettings> | undefined
  private draftRevision: number | undefined
  /** Raw text staged for the trusted-providers control; `undefined` while unedited. */
  private trustedProvidersDraft: string | undefined
  /** Raw text staged for the cache-idle-minutes control; `undefined` while unedited. */
  private cacheIdleText: string | undefined
  /** Raw text staged per tier numeric field, keyed by {@link numberDraftKey}. */
  private readonly tierNumberDrafts = new Map<string, string>()
  private quotes: Record<string, QuoteRow> = {}
  private freeUsage: { used: number; limit: number } | undefined
  private freeUsageKnown = false
  private saving = false
  private failed = false
  private conflicted = false
  private disposed = false
  private generation = 0
  private readonly store: SnapshotStore<ModelRoutingCardState>
  private readonly unsubscribe: () => void

  /**
   * @param scope - bound `model-routing` configuration form.
   * @param ctx - the plugin context, whose Remote answers quotes and the free budget.
   */
  constructor(
    private readonly scope: SettingsFormScope<ModelRoutingSettings>,
    private readonly ctx: ClientContext,
  ) {
    this.store = createSnapshotStore(this.projection())
    this.unsubscribe = scope.subscribe(() => {
      if (!this.saving && this.draftTiers !== undefined
        && scope.getSnapshot().revision !== this.draftRevision) {
        if (this.matches()) this.clearDraft()
        else this.conflicted = true
      }
      if (this.catalogStatus === 'idle') void this.loadCatalog()
      void this.loadFreeUsage()
      this.publish()
    })
    void this.loadCatalog()
    void this.loadFreeUsage()
  }

  /** Stop observing settings and suppress late catalog settlements. */
  dispose(): void {
    this.disposed = true
    this.generation += 1
    this.unsubscribe()
  }

  /**
   * Build the renderer face for this card.
   * @returns The snapshot and staged card actions injected into the renderer.
   */
  inject(): ModelRoutingCardFace {
    return {
      hooks: { modelRoutingCard: this.store },
      setView: (value) => { this.view = value; this.publish() },
      selectTier: (index) => {
        this.beginDraft()
        this.selectedTier = Math.max(index, 0)
        this.publish()
      },
      setFilter: (index, filter) => {
        this.beginDraft()
        this.filters[index] = filter
        this.publish()
      },
      toggleModel: (index, model) => { this.toggleModel(index, model) },
      setTierField: (index, field, value) => { this.setTierField(index, field, value) },
      setTrustedProviders: (value) => {
        this.beginDraft()
        this.trustedProvidersDraft = value
        this.publish()
      },
      setJudgeEnabled: (value) => {
        this.beginDraft()
        this.draftExtra = { ...this.draftExtra, judgeEnabled: value }
        this.publish()
      },
      setDefaultTier: (value) => {
        this.beginDraft()
        this.draftExtra = { ...this.draftExtra, defaultTier: value }
        this.publish()
      },
      setCacheIdleMinutes: (value) => {
        this.beginDraft()
        this.cacheIdleText = value
        this.publish()
      },
      setFreeForSubagents: (value) => {
        this.beginDraft()
        this.draftExtra = { ...this.draftExtra, freeForSubagents: value }
        this.publish()
      },
      retryCatalog: () => { void this.loadCatalog() },
      save: () => { void this.save() },
      discard: () => { this.discard() },
    }
  }

  private current(): ModelRoutingSettings {
    const value = this.scope.getSnapshot().value
    return {
      tiers: value?.tiers ?? [],
      judgeEnabled: value?.judgeEnabled ?? true,
      defaultTier: value?.defaultTier ?? 'flash',
      cacheIdleMs: value?.cacheIdleMs ?? 600_000,
      freeForSubagents: value?.freeForSubagents ?? false,
      trustedUnknownProviders: value?.trustedUnknownProviders ?? [],
    }
  }

  private desired(): ModelRoutingSettings {
    const current = this.current()
    return {
      ...current,
      ...this.draftExtra,
      tiers: this.draftTiers ?? current.tiers,
      // Parsed from staged raw text, not re-derived from it: the raw text is
      // what the control shows, and re-joining a parsed value back into text
      // would normalize whatever separators the person is still typing.
      cacheIdleMs: this.cacheIdleText === undefined
        ? current.cacheIdleMs
        : (parsePositiveMinutesMs(this.cacheIdleText) ?? current.cacheIdleMs),
      trustedUnknownProviders: this.trustedProvidersDraft === undefined
        ? current.trustedUnknownProviders
        : splitList(this.trustedProvidersDraft),
    }
  }

  private matches(): boolean {
    const current = this.current()
    const desired = this.desired()
    return sameJson(current.tiers, desired.tiers)
      && current.judgeEnabled === desired.judgeEnabled
      && current.defaultTier === desired.defaultTier
      && current.cacheIdleMs === desired.cacheIdleMs
      && current.freeForSubagents === desired.freeForSubagents
      && sameJson(current.trustedUnknownProviders, desired.trustedUnknownProviders)
  }

  private beginDraft(): TierSettings[] {
    if (this.draftTiers === undefined) {
      const snapshot = this.scope.getSnapshot()
      this.draftTiers = this.current().tiers.map(tier => ({ ...tier }))
      this.draftExtra = {}
      this.draftRevision = snapshot.revision
      this.filters = this.draftTiers.map(() => '')
    }
    return this.draftTiers
  }

  private clearDraft(): void {
    this.draftTiers = undefined
    this.draftExtra = undefined
    this.draftRevision = undefined
    this.trustedProvidersDraft = undefined
    this.cacheIdleText = undefined
    this.tierNumberDrafts.clear()
    this.failed = false
    this.conflicted = false
  }

  private discard(): void {
    if (this.saving) return
    this.clearDraft()
    this.publish()
  }

  private toggleModel(index: number, model: string): void {
    const tiers = this.beginDraft()
    const tier = tiers[index]
    if (tier === undefined || this.saving || !this.scope.getSnapshot().writable) return
    // Order follows the tier's own list, not the click order, so a price shown
    // beside a model cannot move while the person edits the rest of the tier.
    tier.models = tier.models.includes(model)
      ? tier.models.filter(entry => entry !== model)
      : [...tier.models, model]
    void this.price()
    this.publish()
  }

  private setTierField(
    index: number,
    field: TierField,
    value: string,
  ): void {
    const tiers = this.beginDraft()
    const tier = tiers[index]
    if (tier === undefined || this.saving || !this.scope.getSnapshot().writable) return
    if (field === 'label') tier.label = value
    else if (field === 'minQuantization') tier.minQuantization = value as Quantization
    else if (field === 'unknownQuantization') {
      tier.unknownQuantization = value as TierSettings['unknownQuantization']
    } else if (field === 'free') tier.free = value as TierSettings['free']
    else {
      // The raw text is staged unconditionally, so the control shows exactly
      // what was typed — including empty, a leading zero, or a value that
      // hasn't become positive yet. Only a value that parses to a positive
      // integer updates the tier the draft will save.
      this.tierNumberDrafts.set(numberDraftKey(index, field), value)
      const parsed = parsePositiveInteger(value)
      if (parsed !== undefined) {
        if (field === 'contextWindow') tier.contextWindow = parsed
        else tier.maxTokens = parsed
      }
    }
    this.publish()
  }

  private async save(): Promise<void> {
    const snapshot = this.scope.getSnapshot()
    const desired = this.desired()
    if (this.disposed || snapshot.status !== 'ready' || !snapshot.writable || this.saving) return
    if (this.matches()) return
    if (this.draftTiers !== undefined && snapshot.revision !== this.draftRevision) {
      this.conflicted = true
      this.publish()
      return
    }
    const generation = this.generation
    this.saving = true
    this.failed = false
    this.conflicted = false
    this.publish()
    // Only a field the person actually staged is written, each as its own `set`
    // into the user layer — writing every field unconditionally (the prior
    // behavior) would pin the other five as user overrides on every save,
    // including ones the person never touched, and a later change to one of
    // them in the base or profile layer would then silently stop applying.
    const ops: SettingsFormPathOp[] = []
    // `draftTiers` is seeded with a copy of the current tiers the moment ANY
    // field is first edited (`beginDraft()`), so its mere presence does not
    // mean the tiers themselves changed — only a value difference does.
    if (this.draftTiers !== undefined && !sameJson(this.draftTiers, this.current().tiers)) {
      ops.push({ op: 'set', path: ['tiers'], value: desired.tiers.map(tier => ({ ...tier })) })
    }
    if (this.draftExtra?.judgeEnabled !== undefined) {
      ops.push({ op: 'set', path: ['judgeEnabled'], value: desired.judgeEnabled })
    }
    if (this.draftExtra?.defaultTier !== undefined) {
      ops.push({ op: 'set', path: ['defaultTier'], value: desired.defaultTier })
    }
    if (this.cacheIdleText !== undefined && parsePositiveMinutesMs(this.cacheIdleText) !== undefined) {
      ops.push({ op: 'set', path: ['cacheIdleMs'], value: desired.cacheIdleMs })
    }
    if (this.draftExtra?.freeForSubagents !== undefined) {
      ops.push({ op: 'set', path: ['freeForSubagents'], value: desired.freeForSubagents })
    }
    if (this.trustedProvidersDraft !== undefined) {
      ops.push({ op: 'set', path: ['trustedUnknownProviders'], value: [...desired.trustedUnknownProviders] })
    }
    await this.scope.mutate(ops, this.draftRevision)
    if (generation !== this.generation) return
    const landed = this.matches()
    this.saving = false
    this.failed = !landed
    if (landed) this.clearDraft()
    this.publish()
  }

  /** Reload the OpenRouter model catalog after the Host's model inputs changed. */
  refreshCatalog(): void {
    this.generation += 1
    this.catalogStatus = 'idle'
    this.catalogGroups = []
    void this.loadCatalog()
  }

  private async loadCatalog(): Promise<void> {
    if (this.disposed || this.catalogStatus === 'loading') return
    const generation = this.generation
    this.catalogStatus = 'loading'
    this.publish()
    const response = await this.ctx.remote.session.modelCatalog()
    if (generation !== this.generation) return
    if (response.ok) {
      // A tier lists OpenRouter model ids; the catalog publishes them under the
      // inner pi-ai route that serves them, so no other group's rows are
      // candidates — a model the operator cannot dispatch would price nothing.
      this.catalogGroups = response.value.groups.filter(group => group.id === INNER_ROUTE)
      this.catalogStatus = 'ready'
    } else {
      this.catalogStatus = 'error'
    }
    this.publish()
  }

  private async loadFreeUsage(): Promise<void> {
    const response = await this.ctx.remote.modelRouting.freeUsage()
    if (this.disposed) return
    this.freeUsageKnown = response.ok
    this.freeUsage = response.ok && response.value !== null
      ? { used: response.value.used, limit: response.value.limit }
      : undefined
    this.publish()
  }

  /** Re-price every model the draft selects, one quote per tier. */
  private async price(): Promise<void> {
    const generation = this.generation
    const tiers = this.desired().tiers
    const next: Record<string, QuoteRow> = {}
    await Promise.all(tiers.map(async (tier) => {
      if (tier.models.length === 0) return
      const response = await this.ctx.remote.modelRouting.quote({ tier: tier.name, models: [...tier.models] })
      if (generation !== this.generation || this.disposed) return
      for (const quote of response.ok ? response.value : []) {
        next[quoteRowKey(tier.name, quote)] = quoteRow(quote)
      }
    }))
    if (generation !== this.generation || this.disposed) return
    this.quotes = next
    this.publish()
  }

  private projection(): ModelRoutingCardState {
    const snapshot = this.scope.getSnapshot()
    const current = this.current()
    const desired = this.desired()
    const tiers = desired.tiers
    const dirty = !this.matches()
    const filter = this.filters[this.selectedTier] ?? ''
    const candidates = this.catalogGroups.flatMap(group => group.models)
      .filter(model => filter === '' || model.id.includes(filter))
      .map(model => ({
        model: model.id,
        modelName: model.name,
        selected: tiers[this.selectedTier]?.models.includes(model.id) ?? false,
      }))
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      // A draft that outlived its revision cannot be written as one mutation.
      invalid: dirty && this.conflicted,
      view: this.view,
      tiers: tiers.map((tier, index) => ({
        ...tier,
        index,
        filter: this.filters[index] ?? '',
        dirty,
        contextWindowText: this.tierNumberDrafts.get(numberDraftKey(index, 'contextWindow'))
          ?? String(tier.contextWindow),
        maxTokensText: this.tierNumberDrafts.get(numberDraftKey(index, 'maxTokens')) ?? String(tier.maxTokens),
      })),
      candidates,
      quotes: this.quotes,
      selectedTier: this.selectedTier,
      dirty,
      saving: this.saving,
      failed: this.failed,
      conflicted: this.conflicted,
      catalogStatus: this.catalogStatus,
      freeUsage: this.freeUsage,
      freeUsageKnown: this.freeUsageKnown,
      judgeEnabled: desired.judgeEnabled,
      defaultTier: desired.defaultTier,
      cacheIdleMinutes: Math.round(desired.cacheIdleMs / 60_000),
      cacheIdleMinutesText: this.cacheIdleText ?? String(Math.round(current.cacheIdleMs / 60_000)),
      freeForSubagents: desired.freeForSubagents,
      // The raw staged text, not the parsed-and-rejoined list: rejoining would
      // normalize separators out from under whatever the person is still typing.
      trustedProvidersText: this.trustedProvidersDraft ?? current.trustedUnknownProviders.join(' '),
    }
  }

  private publish(): void {
    this.store.set(this.projection())
  }
}

/**
 * The stable key one tier's quote about one model is stored under.
 * @param tier - the tier name the quote was priced under.
 * @param quote - the quote for one model.
 * @returns the key the card stores and reads that row under.
 */
export function quoteRowKey(tier: string, quote: ModelQuote): string {
  return `${tier} ${quote.model}`
}

/**
 * Project one quote into the row the card renders.
 * @param quote - the quote the Host answered for one model.
 * @returns the rendered text, marked unavailable when the list could not be read.
 */
export function quoteRow(quote: ModelQuote): QuoteRow {
  if (quote.error !== undefined || quote.endpoint === undefined) {
    return { model: quote.model, text: quote.error ?? '', unavailable: true }
  }
  return {
    model: quote.model,
    text: `${quote.endpoint.tag} · ${quote.endpoint.quantization ?? '?'} · ${pricePerMillion(quote.blendedUsdPerToken ?? 0)}`,
    unavailable: false,
  }
}

/**
 * Split a comma- or space-separated provider list into bare slugs.
 * @param value - what the settings field holds as text.
 * @returns the slugs, with no empty entries.
 */
export function splitList(value: string): string[] {
  return value.split(/[\s,]+/).map(entry => entry.trim()).filter(entry => entry.length > 0)
}
