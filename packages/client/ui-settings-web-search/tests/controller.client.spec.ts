import { describe, expect, it, vi } from 'vitest'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import { RemoteError, stubConfigForm, type StubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { WebSearchCardController, type WebSearchCardState, type WebSearchSectionFieldState, type WebSearchSettings } from '../src/client/web-search-card-controller.ts'

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

/** The card plugin's context, scripted down to the namespaces a card reaches. */
function ctxWith(namespaces: object) {
  return { remote: namespaces } as never
}

/**
 * One declared section field as the snapshot carries it.
 * @param state - the card snapshot.
 * @param field - field name to read.
 * @returns that field's entry, which must exist because the card declared it.
 */
function section(state: WebSearchCardState, field: string): WebSearchSectionFieldState {
  const declared = state.sectionFields.find(entry => entry.field === field)
  expect(declared, `card declares no ${field}`).toBeDefined()
  return declared!
}

function credentialsApi(configured: boolean) {
  const describe = vi.fn((refs: readonly string[]) => Promise.resolve({
    ok: true as const,
    value: Object.fromEntries(refs.map(ref => [ref, { configured, writable: true }])),
  }))
  const set = vi.fn(() => Promise.resolve({ ok: true as const, value: undefined }))
  return { ctx: ctxWith({ credentials: { describe, set } }), describe, set }
}

describe('WebSearchCardController', () => {
  it('reads the credential state for the reference the tab names', async () => {
    const host = stubConfigForm<WebSearchSettings>()
    const credentials = credentialsApi(true)
    const controller = new WebSearchCardController(host.scope, credentials.ctx)
    const state = () => controller.inject().hooks.webSearchCard.getSnapshot()
    await vi.waitFor(() => { expect(credentials.describe).toHaveBeenCalled() })

    host.publish({ status: 'ready', writable: true, value: { baseURL: 'https://search.test/v1' }, user: {} })
    await vi.waitFor(() => { expect(state().apiKeyConfigured).toBe(true) })

    expect(section(state(), 'baseURL')).toMatchObject({ text: 'https://search.test/v1', overridden: false })
    expect(state().apiKey).toMatchObject({ text: '', overridden: false })
  })

  it('writes the staged key through the credentials domain, never the settings section', async () => {
    const host = stubConfigForm<WebSearchSettings>()
    const credentials = credentialsApi(false)
    const controller = new WebSearchCardController(host.scope, credentials.ctx)
    host.publish({ status: 'ready', writable: true, value: {}, user: {} })
    const face = controller.inject()

    face.edit('apiKey', ' ds-secret ')
    expect(face.hooks.webSearchCard.getSnapshot().dirty).toBe(true)
    expect(credentials.set).not.toHaveBeenCalled()

    credentials.describe.mockImplementation((refs: readonly string[]) => Promise.resolve({
      ok: true as const, value: Object.fromEntries(refs.map(ref => [ref, { configured: true, writable: true }])),
    }))
    face.save()
    await vi.waitFor(() => { expect(credentials.set).toHaveBeenCalled() })

    expect(credentials.set).toHaveBeenCalledWith('DEEPSEEK_API_KEY', 'ds-secret')
    expect(host.set).not.toHaveBeenCalled()
    await vi.waitFor(() => {
      expect(face.hooks.webSearchCard.getSnapshot()).toMatchObject({ dirty: false, apiKeyConfigured: true })
    })
  })

  it('keeps the stored key when the draft is left blank', () => {
    const host = stubConfigForm<WebSearchSettings>()
    const credentials = credentialsApi(true)
    const controller = new WebSearchCardController(host.scope, credentials.ctx)
    host.publish({ status: 'ready', writable: true, value: {}, user: {} })
    const face = controller.inject()

    face.edit('apiKey', '   ')

    expect(face.hooks.webSearchCard.getSnapshot().dirty).toBe(false)
    face.save()

    expect(credentials.set).not.toHaveBeenCalled()
  })

  it('re-reads when the Host reports the watched reference changed', async () => {
    const host = stubConfigForm<WebSearchSettings>()
    const credentials = credentialsApi(false)
    const controller = new WebSearchCardController(host.scope, credentials.ctx)
    host.publish({ status: 'ready', writable: true, value: {}, user: {} })
    await vi.waitFor(() => { expect(credentials.describe).toHaveBeenCalled() })
    credentials.describe.mockClear()

    // Another reference is not this card's business.
    controller.refreshCredential('OTHER_KEY')
    expect(credentials.describe).not.toHaveBeenCalled()

    // A key written on another surface reaches this card only through this signal.
    credentials.describe.mockImplementation((refs: readonly string[]) => Promise.resolve({
      ok: true as const, value: Object.fromEntries(refs.map(ref => [ref, { configured: true, writable: true }])),
    }))
    controller.refreshCredential('DEEPSEEK_API_KEY')

    await vi.waitFor(() => {
      expect(controller.inject().hooks.webSearchCard.getSnapshot().apiKeyConfigured).toBe(true)
    })
  })

  it('addresses the reference the tab declares rather than the default', async () => {
    const host = stubConfigForm<WebSearchSettings>()
    const credentials = credentialsApi(false)
    const controller = new WebSearchCardController(host.scope, credentials.ctx)
    host.publish({ status: 'ready', writable: true, value: { apiKeyEnv: 'SEARCH_KEY' }, user: {} })
    const face = controller.inject()

    face.edit('apiKey', 'ds-secret')
    face.save()
    await vi.waitFor(() => { expect(credentials.set).toHaveBeenCalled() })

    expect(credentials.set).toHaveBeenCalledWith('SEARCH_KEY', 'ds-secret')
  })

  it('reports a key the Host did not store as a failed save', async () => {
    const host = stubConfigForm<WebSearchSettings>()
    const credentials = credentialsApi(false)
    const controller = new WebSearchCardController(host.scope, credentials.ctx)
    host.publish({ status: 'ready', writable: true, value: {}, user: {} })
    const face = controller.inject()

    face.edit('apiKey', 'ds-secret')
    face.save()

    await vi.waitFor(() => {
      expect(face.hooks.webSearchCard.getSnapshot()).toMatchObject({ failed: true, dirty: true })
    })
  })

  it('keeps the card usable when the credential read is refused', async () => {
    const host = stubConfigForm<WebSearchSettings>()
    const refusal = () => Promise.resolve({
      ok: false as const,
      error: new RemoteError('credential/rejected', 'offline', { ref: 'DEEPSEEK_API_KEY' }),
    })
    const describe = vi.fn(refusal)
    const set = vi.fn(refusal)
    const controller = new WebSearchCardController(host.scope, ctxWith({ credentials: { describe, set } }))
    const face = controller.inject()
    await vi.waitFor(() => { expect(describe).toHaveBeenCalled() })

    host.publish({ status: 'ready', writable: true, value: { baseURL: 'https://search.test/v1' }, user: {} })
    face.edit('apiKey', 'ds-secret')
    face.save()
    await vi.waitFor(() => { expect(set).toHaveBeenCalled() })

    expect(face.hooks.webSearchCard.getSnapshot()).toMatchObject({ available: true, apiKeyConfigured: false })
    expect(section(face.hooks.webSearchCard.getSnapshot(), 'baseURL')).toMatchObject({ text: 'https://search.test/v1' })
  })

  it('ignores a credential read the Host refused', async () => {
    const host = stubConfigForm<WebSearchSettings>()
    const describe = vi.fn(() => Promise.resolve({
      ok: false as const,
      error: new RemoteError('gateway/internal', 'no credential provider', {}),
    }))
    const controller = new WebSearchCardController(host.scope, ctxWith({
      credentials: { describe, set: vi.fn() },
    }))
    await vi.waitFor(() => { expect(describe).toHaveBeenCalled() })

    expect(controller.inject().hooks.webSearchCard.getSnapshot().apiKeyConfigured).toBe(false)
  })

  it('keeps an unknown credential reference writable and unconfigured', async () => {
    const host = stubConfigForm<WebSearchSettings>()
    const credentials = credentialsApi(true)
    const controller = new WebSearchCardController(host.scope, credentials.ctx)
    const state = () => controller.inject().hooks.webSearchCard.getSnapshot()
    host.publish({ status: 'ready', writable: true, value: {}, user: {} })
    await vi.waitFor(() => { expect(state().apiKeyConfigured).toBe(true) })

    credentials.describe.mockResolvedValue({ ok: true, value: {} })
    controller.refreshCredential('DEEPSEEK_API_KEY')

    await vi.waitFor(() => {
      expect(state()).toMatchObject({ apiKeyConfigured: false, apiKeyWritable: true })
    })
  })

  it('reads once per settings publication wave after the eager read', async () => {
    const host = stubConfigForm<WebSearchSettings>()
    const credentials = credentialsApi(true)
    const controller = new WebSearchCardController(host.scope, credentials.ctx)
    try {
      expect(credentials.describe).toHaveBeenCalledTimes(1)
      host.publish({ status: 'ready', writable: true, value: {}, user: {} })
      await Promise.resolve()
      expect(credentials.describe).toHaveBeenCalledTimes(2)
      host.publish({ status: 'ready', writable: true, value: {}, user: {} })
      await Promise.resolve()
      expect(credentials.describe).toHaveBeenCalledTimes(3)
      for (const args of credentials.describe.mock.calls) expect(args).toEqual([['DEEPSEEK_API_KEY']])
    } finally { controller.dispose() }
  })

  it('reads once when a settings publication wave renames the credential reference', async () => {
    const host = stubConfigForm<WebSearchSettings>()
    const credentials = credentialsApi(true)
    const controller = new WebSearchCardController(host.scope, credentials.ctx)
    const state = () => controller.inject().hooks.webSearchCard.getSnapshot()
    try {
      host.publish({ status: 'ready', writable: true, value: {}, user: {} })
      await vi.waitFor(() => { expect(state().apiKeyConfigured).toBe(true) })
      const count = credentials.describe.mock.calls.length

      host.publish({ value: { apiKeyEnv: 'RENAMED_KEY' } })

      expect(state().apiKeyConfigured).toBe(false)
      await Promise.resolve()
      expect(credentials.describe).toHaveBeenCalledTimes(count + 1)
      expect(credentials.describe).toHaveBeenLastCalledWith(['RENAMED_KEY'])
    } finally { controller.dispose() }
  })

  it.each(['before', 'after'])('keeps the credential update when the pending settings read finishes %s it', async (order) => {
    const host = stubConfigForm<WebSearchSettings>()
    const credentials = credentialsApi(false)
    const controller = new WebSearchCardController(host.scope, credentials.ctx)
    const state = () => controller.inject().hooks.webSearchCard.getSnapshot()
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof credentials.describe>>>()
    const updated = Promise.withResolvers<Awaited<ReturnType<typeof credentials.describe>>>()
    try {
      await Promise.resolve()
      credentials.describe.mockImplementationOnce(() => pending.promise)
      host.publish({ status: 'ready', writable: true, value: {}, user: {} })
      await Promise.resolve()
      const count = credentials.describe.mock.calls.length
      credentials.describe.mockImplementationOnce(() => updated.promise)
      controller.refreshCredential('DEEPSEEK_API_KEY')
      expect(credentials.describe).toHaveBeenCalledTimes(count + 1)
      if (order === 'before') {
        pending.resolve({ ok: true, value: { DEEPSEEK_API_KEY: { configured: false, writable: true } } })
        await Promise.resolve()
      }
      updated.resolve({ ok: true, value: { DEEPSEEK_API_KEY: { configured: true, writable: true } } })
      await vi.waitFor(() => { expect(state().apiKeyConfigured).toBe(true) })
      pending.resolve({ ok: true, value: { DEEPSEEK_API_KEY: { configured: false, writable: true } } })
      await Promise.resolve()
      expect(state().apiKeyConfigured).toBe(true)
    } finally {
      controller.dispose()
      pending.resolve({ ok: true, value: {} })
      updated.resolve({ ok: true, value: {} })
      await Promise.all([pending.promise, updated.promise])
    }
  })

  it('discards queued reads and late credential answers after disposal', async () => {
    const host = stubConfigForm<WebSearchSettings>()
    const credentials = credentialsApi(false)
    const controller = new WebSearchCardController(host.scope, credentials.ctx)
    const face = controller.inject()
    const state = () => face.hooks.webSearchCard.getSnapshot()
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof credentials.describe>>>()
    const publish = vi.fn()
    const off = face.hooks.webSearchCard.subscribe(publish)
    try {
      await Promise.resolve()
      credentials.describe.mockImplementationOnce(() => pending.promise)
      controller.refreshCredential('DEEPSEEK_API_KEY')
      host.publish({ status: 'ready', writable: true, value: {}, user: {} })
      controller.dispose()
      const count = credentials.describe.mock.calls.length
      publish.mockClear()
      pending.resolve({ ok: true, value: { DEEPSEEK_API_KEY: { configured: true, writable: true } } })
      await Promise.resolve()
      expect(credentials.describe).toHaveBeenCalledTimes(count)
      expect(publish).not.toHaveBeenCalled()
      expect(state().apiKeyConfigured).toBe(false)
      controller.refreshCredential('DEEPSEEK_API_KEY')
      host.publish({ status: 'ready', writable: true, value: {}, user: {} })
      await Promise.resolve()
      expect(credentials.describe).toHaveBeenCalledTimes(count)
    } finally {
      off()
      controller.dispose()
      pending.resolve({ ok: true, value: {} })
      await pending.promise
    }
  })

  it('clears a changed reference immediately and drops its previous pending answer', async () => {
    const host = stubConfigForm<WebSearchSettings>()
    const credentials = credentialsApi(true)
    const controller = new WebSearchCardController(host.scope, credentials.ctx)
    const state = () => controller.inject().hooks.webSearchCard.getSnapshot()
    const previous = Promise.withResolvers<Awaited<ReturnType<typeof credentials.describe>>>()
    const renamed = Promise.withResolvers<Awaited<ReturnType<typeof credentials.describe>>>()
    try {
      host.publish({ status: 'ready', writable: true, value: {}, user: {} })
      await vi.waitFor(() => { expect(state().apiKeyConfigured).toBe(true) })
      credentials.describe.mockImplementationOnce(() => previous.promise)
      controller.refreshCredential('DEEPSEEK_API_KEY')
      credentials.describe.mockImplementation(() => renamed.promise)
      host.publish({ value: { apiKeyEnv: 'RENAMED_KEY' } })
      expect(state().apiKeyConfigured).toBe(false)
      previous.resolve({ ok: true, value: { DEEPSEEK_API_KEY: { configured: true, writable: true } } })
      await Promise.resolve()
      expect(state().apiKeyConfigured).toBe(false)
      renamed.resolve({ ok: true, value: { RENAMED_KEY: { configured: true, writable: false } } })
      await vi.waitFor(() => { expect(state()).toMatchObject({ apiKeyConfigured: true, apiKeyWritable: false }) })
    } finally {
      controller.dispose()
      previous.resolve({ ok: true, value: {} })
      renamed.resolve({ ok: true, value: {} })
      await Promise.all([previous.promise, renamed.promise])
    }
  })

  it('accepts its successful key readback while a newer credential read is pending', async () => {
    const host = stubConfigForm<WebSearchSettings>()
    const credentials = credentialsApi(false)
    const controller = new WebSearchCardController(host.scope, credentials.ctx)
    const face = controller.inject()
    const state = () => face.hooks.webSearchCard.getSnapshot()
    const readback = Promise.withResolvers<Awaited<ReturnType<typeof credentials.describe>>>()
    const newer = Promise.withResolvers<Awaited<ReturnType<typeof credentials.describe>>>()
    try {
      host.publish({ status: 'ready', writable: true, value: {}, user: {} })
      await vi.waitFor(() => { expect(credentials.describe).toHaveBeenCalledTimes(2) })
      credentials.describe.mockImplementationOnce(() => readback.promise)
      face.edit('apiKey', 'ds-secret')
      face.save()
      await vi.waitFor(() => { expect(credentials.describe).toHaveBeenCalledTimes(3) })
      credentials.describe.mockImplementationOnce(() => newer.promise)
      controller.refreshCredential('DEEPSEEK_API_KEY')
      expect(credentials.describe).toHaveBeenCalledTimes(4)
      readback.resolve({ ok: true, value: { DEEPSEEK_API_KEY: { configured: true, writable: true } } })
      await vi.waitFor(() => { expect(state()).toMatchObject({ dirty: false, saving: false, failed: false }) })
      newer.resolve({ ok: true, value: { DEEPSEEK_API_KEY: { configured: true, writable: true } } })
      await vi.waitFor(() => { expect(state().apiKeyConfigured).toBe(true) })
    } finally {
      controller.dispose()
      readback.resolve({ ok: true, value: {} })
      newer.resolve({ ok: true, value: {} })
      await Promise.all([readback.promise, newer.promise])
    }
  })

  it('saves the endpoint and the search budget together', async () => {
    const host = stubConfigForm<WebSearchSettings>()
    acceptWrites(host)
    const credentials = credentialsApi(true)
    const controller = new WebSearchCardController(host.scope, credentials.ctx)
    host.publish({ status: 'ready', writable: true, value: {}, base: {}, user: {} })
    const face = controller.inject()

    face.edit('baseURL', 'https://other.test')
    face.edit('maxUses', '3')
    face.save()
    await vi.waitFor(() => { expect(host.mutate).toHaveBeenCalledTimes(1) })

    expect(host.mutate.mock.calls.map(([ops]) => ops)).toEqual([[['baseURL', 'https://other.test'], ['maxUses', 3]].map(([field, value]) => ({ op: 'set', path: [field], value }))])
    expect(credentials.set).not.toHaveBeenCalled()
  })

  it('releases every subscription on dispose', () => {
    const host = stubConfigForm<WebSearchSettings>()
    const credentials = credentialsApi(true)
    const controller = new WebSearchCardController(host.scope, credentials.ctx)
    host.publish({ status: 'ready', writable: true, value: {}, user: {} })

    controller.dispose()

    expect(host.listenerCount()).toBe(0)
  })
})
