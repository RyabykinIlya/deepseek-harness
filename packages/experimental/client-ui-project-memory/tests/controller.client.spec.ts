/** The card's staged form over a stubbed `project-memory` namespace. */

import { describe, expect, it, vi } from 'vitest'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import { stubConfigForm, type StubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { ProjectMemoryCardController, type ProjectMemorySettings } from '../src/client/project-memory-card-controller.ts'

/** Make the stub behave like a Host that accepts every write. */
function acceptWrites<T>(host: StubConfigForm<T>): void {
  const section = (): Record<string, unknown> => ({ ...host.scope.getSnapshot().value as object })
  const layer = (): Record<string, unknown> => ({ ...host.scope.getSnapshot().user as object })
  host.set.mockImplementation((field: string, value: unknown) => {
    host.publish({ value: { ...section(), [field]: value } as T, user: { ...layer(), [field]: value } })
  })
  host.mutate.mockImplementation((ops: readonly SettingsPathOpView[]) => {
    const value = { ...section() }
    const user = { ...layer() }
    for (const op of ops) {
      const field = op.path[0]!
      if (op.op === 'set') {
        value[field] = op.value
        user[field] = op.value
      } else {
        Reflect.deleteProperty(user, field)
        value[field] = (host.scope.getSnapshot().base as Record<string, unknown> | undefined)?.[field]
      }
    }
    host.publish({ value: value as T, user })
    return Promise.resolve(true)
  })
  host.unset.mockImplementation((field: string) => {
    const user = Object.fromEntries(Object.entries(layer()).filter(([key]) => key !== field))
    const base = host.scope.getSnapshot().base as Record<string, unknown> | undefined
    host.publish({ value: { ...section(), [field]: base?.[field] } as T, user })
  })
}

describe('ProjectMemoryCardController', () => {
  it('saves both caps it owns', async () => {
    const host = stubConfigForm<ProjectMemorySettings>()
    acceptWrites(host)
    const controller = new ProjectMemoryCardController(host.scope)
    host.publish({
      status: 'ready',
      writable: true,
      value: { maxEntries: 200, maxEntryChars: 2000 },
      base: { maxEntries: 200, maxEntryChars: 2000 },
      user: {},
    })
    const face = controller.inject()

    face.edit('maxEntryChars', '4000')
    face.edit('maxEntries', '500')
    face.save()
    await vi.waitFor(() => {
      expect(host.mutate).toHaveBeenCalledWith([
        { op: 'set', path: ['maxEntryChars'], value: 4000 },
        { op: 'set', path: ['maxEntries'], value: 500 },
      ], undefined)
    })

    expect(face.hooks.projectMemoryCard.getSnapshot()).toMatchObject({
      dirty: false,
      maxEntryChars: { text: '4000', overridden: true },
      maxEntries: { text: '500', overridden: true },
    })
  })

  it('refuses a fractional cap, which no bound it enforces could use', () => {
    const host = stubConfigForm<ProjectMemorySettings>()
    const controller = new ProjectMemoryCardController(host.scope)
    host.publish({ status: 'ready', writable: true, value: { maxEntries: 200, maxEntryChars: 2000 } })
    const face = controller.inject()

    face.edit('maxEntryChars', '2000.5')

    expect(face.hooks.projectMemoryCard.getSnapshot()).toMatchObject({
      dirty: true,
      invalid: true,
      maxEntryChars: { invalid: true },
    })
  })

  it('reports a read-only document so the card can disable its controls', () => {
    const host = stubConfigForm<ProjectMemorySettings>()
    const controller = new ProjectMemoryCardController(host.scope)

    host.publish({ status: 'ready', writable: false, value: { maxEntries: 200, maxEntryChars: 2000 } })

    expect(controller.inject().hooks.projectMemoryCard.getSnapshot().writable).toBe(false)
  })
})
