/**
 * Read the catalog contributions workspace manifests declare under
 * `dsh.catalog`, and splice them into a generator's own entry list.
 *
 * A generator states the entries it owns; a contributing package states the
 * entry describing itself, in the manifest that already declares its name and
 * directory. Each declared entry names the entry it follows, so the merged list
 * keeps the generator's render order while the generator names no contributing
 * package.
 * @module scripts/catalog-declarations
 */

import { globSync, readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'

/** Package-name prefix shared by every workspace package. */
const SCOPE = '@deepseek-ai/dsh-'

/** The sub-objects `dsh.catalog` admits; each generator reads the one it owns. */
export interface CatalogFields {
  /** A capability-seam service role, for the graph generator. */
  service?: Record<string, unknown>
  /** A tool package entry, for the tool-catalog generator. */
  tools?: Record<string, unknown>
}

/** One manifest's `dsh.catalog` contributions and the package that declared them. */
export interface CatalogContribution {
  /** Repository-relative manifest path; the label of every diagnostic about this declaration. */
  manifest: string
  /** Declared npm package name. */
  pkg: string
  /** Declared name with {@link SCOPE} removed, the short name the graphs use. */
  short: string
  /** Leaf directory under `packages/<group>/`. */
  leaf: string
  /** The declared `dsh.catalog` sub-objects. */
  catalog: CatalogFields
}

/** One declared sub-object being read, labelled for diagnostics. */
export interface CatalogScope {
  /** Object the fields belong to, for example `packages/x/package.json dsh.catalog.service`. */
  label: string
  /** The declared fields. */
  fields: Record<string, unknown>
}

/** A manifest-declared entry to place among a generator's own entries. */
export interface DeclaredEntry<T> {
  /** Identity of the entry this one is placed directly after. */
  after: string
  /** The generator-shaped entry, already read from the manifest. */
  entry: T
}

/** Inputs of {@link spliceCatalogEntries}. */
export interface SpliceOptions<T> {
  /** Command name used in diagnostics. */
  gate: string
  /** Entries the generator itself states, in render order. */
  scripted: readonly T[]
  /** Manifest-declared entries to place among them. */
  declared: readonly DeclaredEntry<T>[]
  /** Every identifier an entry answers to, used to resolve `after` anchors. */
  identities: (entry: T) => readonly string[]
}

interface ManifestJson {
  name?: unknown
  dsh?: { catalog?: unknown }
}

/**
 * Collect every workspace package that declares `dsh.catalog`.
 *
 * Walks the same `packages/<group>/<pkg>/package.json` set the other workspace
 * gates use, in sorted manifest order, so two runs of a generator see one
 * order. `gate` and the manifest path label every diagnostic, because the
 * declaration lives in the file the author must edit.
 *
 * @param root - absolute repository root.
 * @param gate - command name used in diagnostics.
 * @returns One contribution per declaring package, in manifest-path order.
 * @throws Error when a declared `dsh.catalog` is not an object, names an unknown
 *   sub-object, or sits in a manifest whose package name is not workspace-scoped.
 */
export function collectCatalogContributions(root: string, gate: string): CatalogContribution[] {
  const contributions: CatalogContribution[] = []
  const manifests = globSync('packages/*/*/package.json', { cwd: root })
    .map(path => path.split(sep).join('/'))
    .sort()
  for (const manifest of manifests) {
    const parsed = JSON.parse(readFileSync(resolve(root, manifest), 'utf8')) as ManifestJson
    const declared = parsed.dsh?.catalog
    if (declared === undefined) continue
    if (typeof declared !== 'object' || declared === null || Array.isArray(declared)) {
      throw new Error(`${gate}: ${manifest}: dsh.catalog must be an object`)
    }
    if (typeof parsed.name !== 'string' || !parsed.name.startsWith(SCOPE)) {
      throw new Error(`${gate}: ${manifest}: dsh.catalog requires a package name starting with ${SCOPE}`)
    }
    const leaf = manifest.split('/')[2]
    if (leaf === undefined) throw new Error(`${gate}: ${manifest}: unexpected package path`)
    const catalog: CatalogFields = {}
    for (const [key, value] of Object.entries(declared)) {
      if (key !== 'service' && key !== 'tools') {
        throw new Error(`${gate}: ${manifest}: dsh.catalog.${key} is not a catalog contribution this repository defines`)
      }
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error(`${gate}: ${manifest}: dsh.catalog.${key} must be an object`)
      }
      catalog[key] = value as Record<string, unknown>
    }
    contributions.push({
      manifest,
      pkg: parsed.name,
      short: parsed.name.slice(SCOPE.length),
      leaf,
      catalog,
    })
  }
  return contributions
}

/**
 * Open one `dsh.catalog` sub-object of a contribution.
 * @param contribution - the package that declared it.
 * @param key - sub-object name, `service` or `tools`.
 * @param gate - command name used in diagnostics.
 * @returns The labelled fields, or undefined when the package declared no such sub-object.
 */
export function catalogScope(
  contribution: CatalogContribution,
  key: keyof CatalogFields,
  gate: string,
): CatalogScope | undefined {
  const fields = contribution.catalog[key]
  if (fields === undefined) return undefined
  return { label: `${gate}: ${contribution.manifest} dsh.catalog.${key}`, fields }
}

/**
 * Refuse a declared field this generator does not consume, so a misspelled key
 * fails the gate instead of silently rendering a wrong entry.
 * @param scope - the sub-object being read.
 * @param allowed - field names the shape accepts.
 * @throws Error naming the first unknown field.
 */
export function catalogUnknownFields(scope: CatalogScope, allowed: readonly string[]): void {
  const unknown = Object.keys(scope.fields).filter(field => !allowed.includes(field))
  if (unknown.length > 0) {
    throw new Error(`${scope.label}: unknown field${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')}`)
  }
}

/**
 * Read a required string field.
 * @param scope - the sub-object being read.
 * @param key - field name.
 * @returns The declared string.
 * @throws Error when the field is absent or not a string.
 */
export function catalogString(scope: CatalogScope, key: string): string {
  const value = scope.fields[key]
  if (typeof value !== 'string' || value === '') {
    throw new Error(`${scope.label}.${key}: expected a non-empty string`)
  }
  return value
}

/**
 * Read an optional string field.
 * @param scope - the sub-object being read.
 * @param key - field name.
 * @returns The declared string, or undefined when the field is absent.
 * @throws Error when the field is present but not a string.
 */
export function catalogOptionalString(scope: CatalogScope, key: string): string | undefined {
  const value = scope.fields[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value === '') {
    throw new Error(`${scope.label}.${key}: expected a non-empty string`)
  }
  return value
}

/**
 * Read a required list of strings.
 * @param scope - the sub-object being read.
 * @param key - field name.
 * @returns The declared list.
 * @throws Error when the field is absent or holds a non-string member.
 */
export function catalogStrings(scope: CatalogScope, key: string): string[] {
  const value = scope.fields[key]
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${scope.label}.${key}: expected a non-empty list of strings`)
  }
  return value.map((member: unknown) => {
    if (typeof member !== 'string' || member === '') {
      throw new Error(`${scope.label}.${key}: expected a non-empty string member`)
    }
    return member
  })
}

/**
 * Read an optional list of strings.
 * @param scope - the sub-object being read.
 * @param key - field name.
 * @returns The declared list, or undefined when the field is absent.
 * @throws Error when the field is present but holds a non-string member.
 */
export function catalogOptionalStrings(scope: CatalogScope, key: string): string[] | undefined {
  if (scope.fields[key] === undefined) return undefined
  return catalogStrings(scope, key)
}

/**
 * Read a required field restricted to a closed set of values.
 * @param scope - the sub-object being read.
 * @param key - field name.
 * @param allowed - the admitted values.
 * @returns The declared value.
 * @throws Error when the field is absent or holds an unlisted value.
 */
export function catalogChoice<T extends string>(scope: CatalogScope, key: string, allowed: readonly T[]): T {
  const value = catalogString(scope, key)
  if (!allowed.includes(value as T)) {
    throw new Error(`${scope.label}.${key}: expected one of ${allowed.join(', ')}, received ${value}`)
  }
  return value as T
}

/**
 * Place declared entries among the entries a generator states.
 *
 * Each declared entry names the entry it follows, so a package can insert
 * itself without the generator naming it. Anchors resolve by identity, which
 * lets one declared entry follow another; a pass that places nothing means the
 * remaining anchors are unknown or cyclic.
 *
 * @param options - scripted entries, declared entries, and the identity function.
 * @returns The scripted entries with every declared entry spliced in.
 * @throws Error when an anchor names no entry or more than one — a name shared
 *   by two entries cannot place anything deterministically, so it fails here
 *   rather than depending on which entry has already been spliced in.
 */
export function spliceCatalogEntries<T>(options: SpliceOptions<T>): T[] {
  const { gate, scripted, declared, identities } = options
  const every = [...scripted, ...declared.map(declared => declared.entry)]
  for (const candidate of declared) {
    const named = new Set(every.filter(entry => identities(entry).includes(candidate.after)))
    if (named.size > 1) {
      throw new Error(
        `${gate}: the anchor ${candidate.after} names ${named.size} entries; `
        + 'a declared entry must follow exactly one, so name a key or package that is unique',
      )
    }
  }
  const placed = [...scripted]
  let pending = [...declared]
  while (pending.length > 0) {
    const deferred: DeclaredEntry<T>[] = []
    let progress = false
    for (const candidate of pending) {
      const anchor = placed
        .map((entry, index) => ({ entry, index }))
        .find(({ entry }) => identities(entry).includes(candidate.after))
      if (anchor === undefined) {
        deferred.push(candidate)
        continue
      }
      placed.splice(anchor.index + 1, 0, candidate.entry)
      progress = true
    }
    if (!progress) {
      throw new Error(
        `${gate}: declared catalog entries follow unknown or cyclic anchors: `
        + deferred.map(candidate => candidate.after).join(', '),
      )
    }
    pending = deferred
  }
  return placed
}
