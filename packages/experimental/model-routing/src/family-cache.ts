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

/** Reads the catalog. A rejection is answered from the last reading, never propagated. */
export type CatalogReader = (signal: AbortSignal) => Promise<readonly OpenRouterCatalogEntry[]>

/** What one batch of configured ids resolved to. */
export interface FamilyResolutionBatch {
  /** One resolution per configured id, in the order asked. */
  resolutions: readonly FamilyResolution[]
  /** Whether the catalog could not be read, leaving every id as configured. */
  unreadable: boolean
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
    if (shared !== undefined) return this.settled(shared)
    // A reader is a caller-supplied function, so a synchronous throw is answered
    // the same way a rejection is rather than escaping past the cache.
    const reading = Promise.resolve()
      .then(() => this.reader(signal))
      .then((catalog) => {
        this.fresh = { at: this.now(), catalog }
        this.stale = catalog
        return catalog
      })
      .finally(() => { this.inFlight = undefined })
    this.inFlight = reading
    return this.settled(reading)
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
