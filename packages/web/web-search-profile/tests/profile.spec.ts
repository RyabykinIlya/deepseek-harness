/**
 * The web-search profile bundle: its patch document and the layering it relies
 * on.
 *
 * The bundle carries no configuration of its own beyond the two overrides: the
 * search default belongs to a person's deployment, so the patch repoints the
 * `web` row at the keyless provider and leaves every keyed provider mounted and
 * unselected until `searchProvider` names one.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

interface Row {
  id?: string
  name?: string
  disabled?: boolean
  config?: Record<string, unknown>
  insert?: Row[]
}

const root = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  name?: string
  icon?: string
  publishConfig?: { access?: string }
  exports?: Record<string, unknown>
  dependencies?: Record<string, string>
  dsh?: { bundle?: { patch?: string } }
}
const patchSource = readFileSync(resolve(root, manifest.dsh!.bundle!.patch!), 'utf8')
const patches = yaml.load(patchSource, { schema: entryListSchema }) as Row[]
const inserted = patches.flatMap(patch => patch.insert ?? [])

/** The one patch entry targeting `id`, which the loader resolves against an earlier layer. */
function overrideOf(id: string): Row {
  const found = patches.filter(patch => patch.id === id && patch.insert === undefined)
  expect(found).toHaveLength(1)
  return found[0]!
}

describe('web-search profile bundle', () => {
  it('declares a public bundle with a parseable patch and an icon', () => {
    expect(manifest.name).toBe('@deepseek-ai/dsh-web-search-profile')
    expect(manifest.publishConfig?.access).toBe('public')
    expect(manifest.icon).toBe('./icon.svg')
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.exports?.['./cordis.patch.yml']).toBe('./cordis.patch.yml')
    expect(patches.length).toBeGreaterThan(0)
  })

  it('repoints the base web row at the keyless provider and keeps the fetch provider', () => {
    // The base ships `deepseek-official` and `http`; a patch replaces the whole
    // `config`, so dropping `fetchProvider` would leave fetch unselected.
    expect(overrideOf('web').config).toEqual({
      searchProvider: 'duckduckgo',
      fetchProvider: 'http',
    })
  })

  it('inserts exactly the three search providers, in mount order', () => {
    expect(inserted.map(row => [row.id, row.name])).toEqual([
      ['web-search-duckduckgo', '@deepseek-ai/dsh-web-search-duckduckgo'],
      ['web-search-brave', '@deepseek-ai/dsh-web-search-brave'],
      ['web-search-tavily', '@deepseek-ai/dsh-web-search-tavily'],
    ])
  })

  it('declares the fetch range a fake-IP transparent-proxy host needs', () => {
    expect(overrideOf('web-fetch-http').config).toEqual({
      trustedProxyAddressRanges: ['198.18.0.0/15'],
    })
  })

  it('addresses the overridden rows by id only', () => {
    // A name here would have to match the earlier layer's row exactly, and the
    // row is that layer's to rename; the bundle loads no plugin of its own for
    // an override.
    for (const id of ['web', 'web-fetch-http']) {
      expect(overrideOf(id).name).toBeUndefined()
    }
    // Every inserted row is a plugin load and names one.
    for (const row of inserted) expect(row.name).toBeDefined()
  })

  it('mounts every keyed provider unselected, so no credential is implied', () => {
    for (const row of inserted) expect(row.config).toBeUndefined()
  })

  it('depends on every package the inserted rows load', () => {
    const dependencies = manifest.dependencies ?? {}
    for (const row of inserted) {
      expect(dependencies[row.name!]).toMatch(/^workspace:/)
    }
  })
})

describe('the rationale the patch carries', () => {
  it('states why a named search provider has no fallback', () => {
    // A configured id that is unregistered fails the search; the comment is what
    // tells an operator the selector pins the value instead of falling back.
    expect(patchSource).toContain('a configured id has no fallback')
  })

  it('keeps the security rationale and the preferred remedy for the trusted range', () => {
    // The range relaxes a guard for the synthetic address only; dropping either
    // sentence would leave the trade-off unstated.
    expect(patchSource).toContain('never the domain\'s real destination')
    expect(patchSource).toContain('Preferred remedy: switch the transparent client to `redir-host`/`real-ip`')
  })
})
