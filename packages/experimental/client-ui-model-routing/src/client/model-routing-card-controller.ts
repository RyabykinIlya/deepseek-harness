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
import type { SettingsFormScope, SettingsFormShell } from '@deepseek-ai/dsh-client-ui-primitives'
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
}

/** Registration-side face for the model-routing card. */
export interface ModelRoutingCardFace {
  hooks: {
    modelRoutingCard: SnapshotStore<ModelRoutingCardState>
  }
  setView: (view: ModelRoutingViewMode) => void
  selectTier: (index: number) => void
  setFilter: (index: number, filter: string) => void
  toggleModel: (index: number, model: string) => void
  setTierField: (index: number, field: 'label' | 'minQuantization' | 'unknownQuantization' | 'free', value: string) => void
  setTrustedProviders: (value: string) => void
  setJudgeEnabled: (value: boolean) => void
  setDefaultTier: (value: string) => void
  setCacheIdleMinutes: (value: number) => void
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
        this.draftExtra = { ...this.draftExtra, trustedUnknownProviders: splitList(value) }
        void this.price()
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
        this.draftExtra = { ...this.draftExtra, cacheIdleMs: Math.round(value * 60_000) }
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
    return { ...current, ...this.draftExtra, tiers: this.draftTiers ?? current.tiers }
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
    field: 'label' | 'minQuantization' | 'unknownQuantization' | 'free',
    value: string,
  ): void {
    const tiers = this.beginDraft()
    const tier = tiers[index]
    if (tier === undefined || this.saving || !this.scope.getSnapshot().writable) return
    if (field === 'label') tier.label = value
    else if (field === 'minQuantization') tier.minQuantization = value as Quantization
    else if (field === 'unknownQuantization') {
      tier.unknownQuantization = value as TierSettings['unknownQuantization']
    } else tier.free = value as TierSettings['free']
    void this.price()
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
    await this.scope.mutate([
      { op: 'set', path: ['tiers'], value: desired.tiers.map(tier => ({ ...tier })) },
      { op: 'set', path: ['judgeEnabled'], value: desired.judgeEnabled },
      { op: 'set', path: ['defaultTier'], value: desired.defaultTier },
      { op: 'set', path: ['cacheIdleMs'], value: desired.cacheIdleMs },
      { op: 'set', path: ['freeForSubagents'], value: desired.freeForSubagents },
      { op: 'set', path: ['trustedUnknownProviders'], value: [...desired.trustedUnknownProviders] },
    ], this.draftRevision)
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
    const tiers = this.desired().tiers
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
      tiers: tiers.map((tier, index) => ({ ...tier, index, filter: this.filters[index] ?? '', dirty })),
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
