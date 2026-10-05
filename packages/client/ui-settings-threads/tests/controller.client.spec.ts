/**
 * The Threads controller over a scope whose section mirrors the real
 * `threads-preset` row: all seven fields the page edits, named exactly as the
 * Host's `z.object({ ... })` declares them.
 *
 * The fixture is deliberately the whole section rather than a convenient subset.
 * A card built over a field set that does not match the Host row still passes
 * every test that only exercises the fields it happens to pick — that is how the
 * per-provider web-search card shipped with a field the Host does not serve and
 * stayed broken, because each test only touched DeepSeek's two fields. So every
 * test here names a field of the real row, and the last one asserts the full set
 * at once.
 */

import { describe, expect, it, vi } from 'vitest'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import { stubConfigForm, type StubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import {
  ThreadsCardController, THREAD_MODEL_FIELDS, type ThreadsSettings,
} from '../src/client/threads-card-controller.ts'

/**
 * A served section carrying all seven of the page's field names.
 *
 * Its type is the page's own `ThreadsSettings`, so renaming or dropping a field
 * there is a compile error here before it is a runtime one.
 */
const SERVED: ThreadsSettings = {
  checkIn: 'milestones',
  spawn: 'ask',
  mergePolicy: 'ask',
  threadProvider: 'deepseek',
  threadModel: 'deepseek-chat',
  threadReasoningEffort: 'high',
  threadMaxTokens: 8192,
}

/** A served section whose Thread model options are all unset, as a fresh row has it. */
const KNOBS_ONLY: ThreadsSettings = { checkIn: 'milestones', spawn: 'ask', mergePolicy: 'ask' }

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

/** A controller over a scope already serving `section`; `user` defaults to no override at all. */
function ready(section: ThreadsSettings = SERVED, user: ThreadsSettings = {}) {
  const host = stubConfigForm<ThreadsSettings>()
  acceptWrites(host)
  const controller = new ThreadsCardController(host.scope)
  host.publish({ status: 'ready', writable: true, value: section, base: section, user })
  return { host, face: controller.inject(), controller }
}

/** The write ops one save sent, as `path[0]` names in the order the Host received them. */
function writtenFields(host: StubConfigForm<ThreadsSettings>): (string | undefined)[] {
  return host.mutate.mock.calls[0]![0].map(op => op.path[0])
}

describe('ThreadsCardController', () => {
  it('writes each coordinator knob to the path the Host row declares', async () => {
    const { host, face } = ready(KNOBS_ONLY)

    face.edit('checkIn', 'quiet')
    face.edit('spawn', 'auto')
    face.edit('mergePolicy', 'auto')
    face.save()

    await vi.waitFor(() => {
      expect(host.mutate).toHaveBeenCalledWith([
        { op: 'set', path: ['checkIn'], value: 'quiet' },
        { op: 'set', path: ['spawn'], value: 'auto' },
        { op: 'set', path: ['mergePolicy'], value: 'auto' },
      ], undefined)
    })
    expect(face.hooks.threadsCard.getSnapshot()).toMatchObject({
      dirty: false, invalid: false, partialThreadModel: false,
      checkIn: { text: 'quiet', overridden: true },
    })
  })

  it('accepts every cadence and approval value the Host union declares', () => {
    for (const value of ['milestones', 'each-thread', 'quiet']) {
      const { face } = ready(KNOBS_ONLY)
      face.edit('checkIn', value)
      expect(face.hooks.threadsCard.getSnapshot().checkIn).toMatchObject({ text: value, invalid: false })
    }
    for (const value of ['ask', 'auto']) {
      const { face } = ready(KNOBS_ONLY)
      face.edit('mergePolicy', value)
      expect(face.hooks.threadsCard.getSnapshot().mergePolicy).toMatchObject({ text: value, invalid: false })
    }
  })

  it('refuses a cadence or approval value the Host row does not declare', () => {
    const { host, face } = ready(KNOBS_ONLY)

    face.edit('checkIn', 'hourly')
    face.save()

    expect(face.hooks.threadsCard.getSnapshot().checkIn).toMatchObject({ text: 'hourly', invalid: true })
    expect(face.hooks.threadsCard.getSnapshot().invalid).toBe(true)
    expect(host.mutate).not.toHaveBeenCalled()
  })

  it('treats an emptied knob as a clear back to the deployment default', async () => {
    const { host, face } = ready({ checkIn: 'quiet', spawn: 'ask', mergePolicy: 'ask' }, { checkIn: 'quiet' })

    face.edit('checkIn', '')
    expect(face.hooks.threadsCard.getSnapshot().checkIn).toMatchObject({ invalid: false })
    face.save()

    await vi.waitFor(() => {
      expect(host.mutate).toHaveBeenCalledWith([{ op: 'unset', path: ['checkIn'] }], undefined)
    })
  })

  it('writes the four Thread model options as four paths the Host row declares', async () => {
    const { host, face } = ready(KNOBS_ONLY)

    face.edit('threadProvider', 'deepseek')
    face.edit('threadModel', 'deepseek-chat')
    face.edit('threadReasoningEffort', 'max')
    face.edit('threadMaxTokens', '4096')
    expect(face.hooks.threadsCard.getSnapshot().partialThreadModel).toBe(false)
    face.save()

    await vi.waitFor(() => {
      expect(host.mutate).toHaveBeenCalledWith([
        { op: 'set', path: ['threadProvider'], value: 'deepseek' },
        { op: 'set', path: ['threadModel'], value: 'deepseek-chat' },
        { op: 'set', path: ['threadReasoningEffort'], value: 'max' },
        { op: 'set', path: ['threadMaxTokens'], value: 4096 },
      ], undefined)
    })
  })

  it('refuses to write one Thread model option without the other three', () => {
    const { host, face } = ready(KNOBS_ONLY)

    face.edit('threadModel', 'deepseek-chat')
    face.save()

    expect(face.hooks.threadsCard.getSnapshot()).toMatchObject({ invalid: true, partialThreadModel: true })
    expect(host.mutate).not.toHaveBeenCalled()
  })

  it('refuses a save that would clear one of a stored group of four', () => {
    // The stored row is complete, so only the reset makes it partial; the card
    // must read a staged clear as an absence rather than as the value the
    // control keeps showing.
    const { host, face } = ready(SERVED, SERVED)

    face.resetField('threadMaxTokens')
    expect(face.hooks.threadsCard.getSnapshot()).toMatchObject({ invalid: true, partialThreadModel: true })
    face.save()

    expect(host.mutate).not.toHaveBeenCalled()
  })

  it('accepts clearing a stored group of four one field at a time', async () => {
    const { host, face } = ready(SERVED, SERVED)

    for (const field of THREAD_MODEL_FIELDS) face.resetField(field)
    expect(face.hooks.threadsCard.getSnapshot().partialThreadModel).toBe(false)
    face.save()

    await vi.waitFor(() => { expect(host.mutate).toHaveBeenCalled() })
    expect(writtenFields(host)).toEqual([...THREAD_MODEL_FIELDS])
    expect(host.mutate.mock.calls[0]![0]).toEqual(THREAD_MODEL_FIELDS.map(field => ({ op: 'unset', path: [field] })))
  })

  it('rejects a Thread token ceiling the Host schema would refuse', () => {
    const { host, face } = ready(KNOBS_ONLY)

    face.edit('threadMaxTokens', '0')
    face.save()

    expect(face.hooks.threadsCard.getSnapshot().threadMaxTokens).toMatchObject({ invalid: true })
    expect(host.mutate).not.toHaveBeenCalled()
  })

  it('clears the Thread token ceiling on an emptied draft and refuses a non-numeric one', () => {
    const { host, face } = ready({ ...KNOBS_ONLY, threadMaxTokens: 8192 }, { threadMaxTokens: 8192 })

    // Empty means "inherit", so it stages an unset rather than an invalid draft.
    face.edit('threadMaxTokens', '')
    expect(face.hooks.threadsCard.getSnapshot().threadMaxTokens).toMatchObject({ invalid: false })
    face.save()
    expect(host.mutate).toHaveBeenCalledWith([{ op: 'unset', path: ['threadMaxTokens'] }], undefined)

    face.edit('threadMaxTokens', 'lots')
    expect(face.hooks.threadsCard.getSnapshot().threadMaxTokens).toMatchObject({ invalid: true })
    face.save()
    expect(host.mutate).toHaveBeenCalledTimes(1)
  })

  it('reports a read-only document so the card can disable its controls', () => {
    const host = stubConfigForm<ThreadsSettings>()
    const controller = new ThreadsCardController(host.scope)

    host.publish({ status: 'ready', writable: false, value: SERVED })

    expect(controller.inject().hooks.threadsCard.getSnapshot().writable).toBe(false)
  })

  it('drops its staged drafts on discard, so a half-written group stops blocking', () => {
    const { host, face } = ready(SERVED, SERVED)

    face.edit('threadModel', '')
    expect(face.hooks.threadsCard.getSnapshot().partialThreadModel).toBe(true)
    face.discard()

    // The stored group is complete again, and nothing is left to write.
    expect(face.hooks.threadsCard.getSnapshot()).toMatchObject({ dirty: false, partialThreadModel: false })
    expect(host.mutate).not.toHaveBeenCalled()
  })

  it('releases its accepted-value subscription when the fiber disposes the page', () => {
    const host = stubConfigForm<ThreadsSettings>()
    const controller = new ThreadsCardController(host.scope)

    expect(host.listenerCount()).toBe(1)
    controller.dispose()
    expect(host.listenerCount()).toBe(0)
  })
})
