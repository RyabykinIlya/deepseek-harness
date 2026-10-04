/**
 * Which of the Threads preset row's fields the harness settings surface can
 * show and write.
 *
 * `SettingsForms.describe()` projects only volatile fields, and `write()`
 * refuses a path that is not beneath one, so a field missing its `.volatile()`
 * declaration is neither rendered nor accepted: the whole card silently does
 * nothing for it. That predicate is `node.meta.volatile` — the same property
 * `volatileForm()` and `isVolatilePath()` read in `packages/settings/settings`
 * — so asserting it here is what keeps the settings page and the Host row in
 * agreement, in both directions: the user-facing knobs are volatile, and the
 * boot composition around them is not.
 */

import { describe, expect, it } from 'vitest'
import { Config, threadAgentOptionsOf } from '../src/index.ts'

/** The fields a person tunes from the Plugins page. */
const USER_FACING = [
  'checkIn', 'spawn', 'mergePolicy',
  'threadProvider', 'threadModel', 'threadReasoningEffort', 'threadMaxTokens',
  'threadModels', 'tierContract',
] as const

/** Everything else the row declares: preset ids, display text, and boot composition. */
const BOOT_COMPOSITION = [
  'id', 'name', 'description', 'order', 'workerId', 'workerName', 'workerDescription',
  'workerOrder', 'provider', 'basePreset', 'workerMaxDepth', 'tools',
] as const

/** Whether one declared field is a stable reference a settings form may edit. */
function isVolatile(field: string): boolean {
  return Config.dict?.[field]?.meta?.volatile === true
}

describe('the Threads preset row as a settings section', () => {
  it('declares exactly the user-facing fields volatile', () => {
    expect(Object.keys(Config.dict ?? {}).filter(isVolatile).sort())
      .toEqual([...USER_FACING].sort())
  })

  it('leaves the preset identities and display fields out of the settings section', () => {
    // A settings section that carried these would pin boot composition into the
    // profile row on the first edit, and a preset id is not a preference.
    for (const field of BOOT_COMPOSITION) expect(isVolatile(field)).toBe(false)
  })

  it('resolves the volatile knobs to their schema defaults as references', () => {
    const resolved = Config({})

    expect(resolved.checkIn.get()).toBe('milestones')
    expect(resolved.spawn.get()).toBe('ask')
    expect(resolved.mergePolicy.get()).toBe('ask')
    // The four Thread model options have no default: unset is how "inherit"
    // looks on the wire, and the reference reads as absent rather than empty.
    expect(resolved.threadProvider?.get()).toBeUndefined()
    expect(resolved.threadModel?.get()).toBeUndefined()
    expect(resolved.threadReasoningEffort?.get()).toBeUndefined()
    expect(resolved.threadMaxTokens?.get()).toBeUndefined()
  })

  it('reads the Thread model options out of a resolved row, all four or none', () => {
    const full = Config({
      threadProvider: 'deepseek', threadModel: 'deepseek-chat', threadReasoningEffort: 'high', threadMaxTokens: 4096,
    })

    expect(threadAgentOptionsOf(full)).toEqual({ provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high', maxTokens: 4096 })
    expect(threadAgentOptionsOf(Config({}))).toBeUndefined()
    expect(() => threadAgentOptionsOf(Config({ threadModel: 'deepseek-chat' })))
      .toThrow('must be set together')
  })
})
