/**
 * Which snapshot of a model family a configured id currently names.
 *
 * A tier names models by id, and the id a publisher leaves unversioned is not a
 * rolling alias — it is the *oldest* release of that family. `deepseek/deepseek-v4-pro`
 * reads as "the current pro model" and is in fact the April snapshot, while
 * `deepseek/deepseek-v4-pro-0813` is the same family in August. So a deployment
 * that wants the latest release has two choices: pin the newest id and edit the
 * configuration at every release, or name the family and let this module move
 * the id forward.
 *
 * The family comes from OpenRouter's `canonical_slug`, not from parsing the
 * displayed name: OpenRouter states for every catalog entry which dated release
 * that id is, so the ids sharing a dated identity are the family, and their
 * newest date is the newest snapshot. Nothing here reads the network and nothing
 * here decides which model an endpoint list belongs to — it answers one question,
 * and the caller ranks the result.
 *
 * @module dsh-experimental-model-routing/family
 */

import type { OpenRouterCatalogEntry } from '@deepseek-ai/dsh-llm-pi-ai'

/**
 * A dated release identity: the family it belongs to and the date that names
 * this release within it.
 *
 * A canonical slug without one is a model outside any dated family, such as
 * `deepseek/deepseek-r1-0528` or an OpenRouter `~alias`, and is never dated here.
 */
const DATED_SLUG = /^(?<family>.+)-(?<date>\d{8})$/u

/** One configured model id, resolved against a catalog. */
export interface FamilyResolution {
  /** The id the configuration named. */
  configured: string
  /** The id to decide with: the family's newest snapshot, or `configured` itself. */
  resolved: string
  /** Whether `resolved` names a different release than `configured`. */
  moved: boolean
}

/** The dated identity of a canonical slug, or `undefined` when it names no date. */
function dated(canonicalSlug: string): { family: string; date: string } | undefined {
  const match = DATED_SLUG.exec(canonicalSlug)
  const family = match?.groups?.['family']
  const date = match?.groups?.['date']
  return family === undefined || date === undefined ? undefined : { family, date }
}

/**
 * The newest snapshot of the family a configured id belongs to.
 *
 * A configured id the catalog does not list, and one whose identity names no
 * date, both resolve to themselves: there is nothing to move to, and a decision
 * taken under an id the catalog cannot place is the caller's to make, not this
 * module's to invent.
 * @param model - the configured `{author}/{slug}` model id.
 * @param catalog - the OpenRouter model catalog.
 * @returns the resolution to decide under.
 */
export function resolveModelFamily(model: string, catalog: readonly OpenRouterCatalogEntry[]): FamilyResolution {
  const configured = catalog.find(entry => entry.id === model)
  const own = configured === undefined ? undefined : dated(configured.canonicalSlug)
  if (own === undefined) return { configured: model, resolved: model, moved: false }
  let newest: { date: string; id: string } | undefined
  for (const entry of catalog) {
    const release = dated(entry.canonicalSlug)
    if (release?.family !== own.family) continue
    // Dates are zero-padded to eight digits, so a lexicographic comparison is the
    // chronological one; nothing here parses a date into anything.
    if (newest !== undefined && release.date < newest.date) continue
    // Several entries can share one dated identity — `…/deepseek-v4.1-flash` and
    // `…/deepseek-v4.1-flash:batch` are both the 20260910 release — and the plain
    // id wins the tie, because a `:variant` is a different mode of serving the
    // same release and a tier lists the model rather than a mode of it.
    const tiesPlain = newest !== undefined
      && release.date === newest.date && newest.id.includes(':') && !entry.id.includes(':')
    if (newest === undefined || release.date > newest.date || tiesPlain) {
      newest = { date: release.date, id: entry.id }
    }
  }
  if (newest === undefined || newest.date <= own.date) {
    return { configured: model, resolved: model, moved: false }
  }
  return { configured: model, resolved: newest.id, moved: newest.id !== model }
}
