/**
 * Which of the Project memory row's fields the harness settings surface can
 * show and write.
 *
 * `SettingsForms.describe()` projects only volatile fields, and `write()`
 * refuses a path that is not beneath one, so a field missing its `.volatile()`
 * declaration is neither rendered nor accepted: the whole card silently does
 * nothing for it. That predicate is `node.meta.volatile` — the same property
 * `volatileForm()` and `isVolatilePath()` read in `packages/settings/settings`
 * — so asserting it here is what keeps the settings page and the Host row in
 * agreement, in both directions: the caps a person tunes are volatile, and the
 * Project-identity fields the boot composition owns are not.
 */

import { describe, expect, it } from 'vitest'
import ProjectMemoryService from '../src/index.ts'

/** The caps a person tunes from the Plugins page. */
const USER_FACING = ['maxEntries', 'maxEntryChars'] as const

/** Which presets are coordinators, and how far lineage is followed: boot composition. */
const BOOT_COMPOSITION = ['projectPresets', 'maxLineageDepth'] as const

/** The row's own schema, the predicate the settings form reads. */
const { dict } = ProjectMemoryService.Config

/** Whether one declared field is a stable reference a settings form may edit. */
function isVolatile(field: string): boolean {
  return dict?.[field]?.meta?.volatile === true
}

describe('the Project memory row as a settings section', () => {
  it('declares exactly the user-facing caps volatile', () => {
    expect(Object.keys(dict ?? {}).filter(isVolatile).sort())
      .toEqual([...USER_FACING].sort())
  })

  it('leaves the Project-identity fields out of the settings section', () => {
    // A settings section that carried these would pin Project composition into
    // the profile row on the first edit, and a preset id is not a preference.
    for (const field of BOOT_COMPOSITION) expect(isVolatile(field)).toBe(false)
  })

  it('resolves the caps to references the service re-reads per write', () => {
    const resolved = ProjectMemoryService.Config({})
    expect(resolved.maxEntryChars?.get()).toBe(2000)
    expect(resolved.maxEntries?.get()).toBe(200)
  })
})
