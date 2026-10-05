/**
 * A cached catalog read behind {@link resolveModelFamily}.
 *
 * The catalog is one list for the whole deployment rather than one list per
 * model, so this cache holds a single reading: it exists so that every Thread of
 * a Project deciding at the same moment shares one request, and so that a fresh
 * read that fails leaves the last catalog of any age in place. A model family
 * whose newest release is a day old is a better answer than a tier that has
 * stopped routing.
 *
 * A read that fails with no earlier catalog to fall back on resolves every model
 * to itself. That is the same posture the endpoint cache takes when it has
 * nothing stale to serve, and it is why the caller receives an `unreadable`
 * answer to warn about rather than a rejection: the turn must still be decided.
 * The failure's own reason is the reader's to report, because this cache's only
 * obligation is to keep the last usable catalog in hand.
 *
 * @module dsh-experimental-model-routing/family-cache
 */

import type { OpenRouterCatalogEntry } from '@deepseek-ai/dsh-llm-pi-ai'
import type { FamilyResolution } from './family.ts'
import { resolveModelFamily } from './family.ts'
import { uncancellable } from './uncancellable.ts'

/** Reads the catalog. A rejection is answered from the last reading, never propagated. */
export type CatalogReader = (signal: AbortSignal) => Promise<readonly OpenRouterCatalogEntry[]>

/** What one batch of configured ids resolved to. */
export interface FamilyResolutionBatch {
  /** One resolution per configured id, in the order asked. */
  resolutions: readonly FamilyResolution[]
  /** Whether the catalog could not be read, leaving every id as configured. */
  unreadable: boolean
}

/** What the catalog declares about the input of one batch of model ids. */
export interface ModalityBatch {
  /**
   * The modalities named for each asked id, keyed by that id.
   *
   * A missing entry and an entry that names no modalities are both absent: the
   * catalog is the only evidence available, and silence is not a capability.
   */
  readonly declared: ReadonlyMap<string, readonly string[] | undefined>
  /** Whether the catalog could not be read, so nothing is known about any id. */
  readonly unreadable: boolean
}

/** The whole-catalog cache every tier decision resolves its models against. */
export class FamilyCache {
  private fresh: { at: number; catalog: readonly OpenRouterCatalogEntry[] } | undefined
  private stale: readonly OpenRouterCatalogEntry[] | undefined
  private inFlight: Promise<readonly OpenRouterCatalogEntry[]> | undefined

  constructor(
    private readonly reader: CatalogReader,
    private readonly now: () => number,
  ) {}

  /**
   * Resolve configured ids against the catalog, one shared read for the batch.
   *
   * Two ids of one tier may resolve to the same release, so the resolved list is
   * deduplicated in configured order: ranking the same model twice would double
   * its endpoints in the candidate pool for no reason.
   * @param models - the configured ids, in tier order.
   * @param ttlMs - how long a catalog is considered fresh.
   * @param signal - the request's cancellation.
   * @returns one resolution per configured id, and whether the catalog was read.
   */
  async resolve(models: readonly string[], ttlMs: number, signal: AbortSignal): Promise<FamilyResolutionBatch> {
    const catalog = await this.read(ttlMs, signal)
    if (catalog === undefined) {
      return {
        resolutions: models.map(model => ({ configured: model, resolved: model, moved: false })),
        unreadable: true,
      }
    }
    const resolutions: FamilyResolution[] = []
    const seen = new Set<string>()
    for (const model of models) {
      const resolution = resolveModelFamily(model, catalog)
      if (seen.has(resolution.resolved)) continue
      seen.add(resolution.resolved)
      resolutions.push(resolution)
    }
    return { resolutions, unreadable: false }
  }

  /**
   * The input modalities the catalog declares for exact ids, on one shared read.
   *
   * A caller deciding what a request may be routed to needs the same catalog
   * reading that resolves families, so both answers come from this cache rather
   * than from a second request per decision.
   * @param models - the exact ids to look up, as the decision will rank them.
   * @param ttlMs - how long a catalog is considered fresh.
   * @param signal - the request's cancellation.
   * @returns what the catalog names per id, and whether it could be read at all.
   */
  async modalities(models: readonly string[], ttlMs: number, signal: AbortSignal): Promise<ModalityBatch> {
    const catalog = await this.read(ttlMs, signal)
    if (catalog === undefined) return { declared: new Map(), unreadable: true }
    const byId = new Map<string, readonly string[] | undefined>()
    for (const entry of catalog) byId.set(entry.id, entry.inputModalities)
    return { declared: new Map(models.map(model => [model, byId.get(model)])), unreadable: false }
  }

  /**
   * The catalog, fresh where possible and otherwise the last one that was read.
   *
   * `undefined` means no catalog has ever been read: there is nothing to resolve
   * against, and the caller decides under its configured ids.
   */
  private read(ttlMs: number, signal: AbortSignal): Promise<readonly OpenRouterCatalogEntry[] | undefined> {
    if (this.fresh !== undefined && this.now() - this.fresh.at < ttlMs) {
      return Promise.resolve(this.fresh.catalog)
    }
    const shared = this.inFlight
    if (shared !== undefined) {
      // The shared read runs under its own cancellation (see `start`), so a
      // joiner that aborts stops waiting without stopping everyone else's read.
      return uncancellable(this.settled(shared), signal)
    }
    return uncancellable(this.settled(this.start(signal)), signal)
  }

  /**
   * Begin the catalog read every caller shares until it settles.
   *
   * The read gets a private controller rather than the first caller's signal: a
   * read started for one Project decision outlives that decision, so a
   * coordinator that abandons its request must not abort the catalog a parallel
   * Thread is still waiting on.
   * @param _signal - the starting caller's cancellation, deliberately unused.
   * @returns the read's own catalog, before the stale fallback is applied.
   */
  private start(_signal: AbortSignal): Promise<readonly OpenRouterCatalogEntry[]> {
    // A reader is a caller-supplied function, so a synchronous throw is answered
    // the same way a rejection is rather than escaping past the cache.
    const reading = Promise.resolve()
      .then(() => this.reader(new AbortController().signal))
      .then((catalog) => {
        this.fresh = { at: this.now(), catalog }
        this.stale = catalog
        return catalog
      })
      .finally(() => { this.inFlight = undefined })
    // A caller that aborts before awaiting this read never attaches a rejection
    // handler, and a read whose every joiner did that would reject unhandled.
    reading.catch(() => {})
    this.inFlight = reading
    return reading
  }

  /**
   * One read's outcome: its own catalog, or the last catalog this cache read.
   *
   * The rejection is absorbed rather than inspected: what a caller can act on is
   * that it is resolving under configured ids, which `resolve` reports as
   * `unreadable`.
   */
  private settled(reading: Promise<readonly OpenRouterCatalogEntry[]>): Promise<readonly OpenRouterCatalogEntry[] | undefined> {
    return reading.catch(() => this.stale)
  }
}
