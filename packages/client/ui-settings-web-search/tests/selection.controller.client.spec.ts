import { describe, expect, it, vi } from 'vitest'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import { stubConfigForm, type StubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import {
  WEB_SEARCH_SELECTABLE_IDS, WEB_SEAM_NS, WebSearchSelectionController, type WebSeamSettings,
} from '../src/client/web-search-selection-controller.ts'

/** Make the stub behave like a Host that accepts every write. */
function acceptWrites<T>(host: StubConfigForm<T>): void {
  const layer = (source: unknown): Record<string, unknown> => ({ ...source as Record<string, unknown> })
  host.mutate.mockImplementation((ops: readonly SettingsPathOpView[]) => {
    const value = layer(host.scope.getSnapshot().value)
    const user = layer(host.scope.getSnapshot().user)
    for (const op of ops) {
      const field = op.path[0]!
      if (op.op === 'set') {
        value[field] = op.value
        user[field] = op.value
      } else {
        Reflect.deleteProperty(user, field)
        value[field] = layer(host.scope.getSnapshot().base)[field]
      }
    }
    host.publish({ value: value as T, user })
    return Promise.resolve(true)
  })
}

describe('WebSearchSelectionController', () => {
  it('edits the web seam namespace, not a provider block namespace', () => {
    // The selector's whole reason to exist: the value it writes is the seam's
    // own `searchProvider`, which no provider block can reach.
    expect(WEB_SEAM_NS).toBe('web')
  })

  it('offers more ids than the page has credential blocks for', () => {
    // DuckDuckGo runs keyless and so has no credential block, yet the default
    // composition selects it — a list drawn from the blocks could not name it.
    expect(WEB_SEARCH_SELECTABLE_IDS).toContain('duckduckgo')
    expect(WEB_SEARCH_SELECTABLE_IDS).toEqual([
      'duckduckgo', 'deepseek-official', 'brave', 'tavily', 'exa', 'perplexity',
    ])
  })

  it('renders the pinned selection and nothing else while the Host is still reading', () => {
    const host = stubConfigForm<WebSeamSettings>()
    const controller = new WebSearchSelectionController(host.scope)

    expect(controller.inject().hooks.webSearchSelection.getSnapshot()).toMatchObject({
      available: false,
      searchProvider: { text: '', overridden: false, invalid: false },
    })
  })

  it('shows the current selection, marked overridden once the user layer holds it', () => {
    const host = stubConfigForm<WebSeamSettings>()
    const controller = new WebSearchSelectionController(host.scope)
    host.publish({ status: 'ready', writable: true, value: { searchProvider: 'brave' }, user: { searchProvider: 'brave' } })

    expect(controller.inject().hooks.webSearchSelection.getSnapshot()).toMatchObject({
      available: true,
      searchProvider: { text: 'brave', overridden: true, invalid: false },
    })
  })

  it('shows an id this page does not know verbatim rather than rewriting it', () => {
    const host = stubConfigForm<WebSeamSettings>()
    const controller = new WebSearchSelectionController(host.scope)
    host.publish({ status: 'ready', writable: true, value: { searchProvider: 'someone-elses-provider' }, user: {} })

    const state = controller.inject().hooks.webSearchSelection.getSnapshot()
    expect(state.searchProvider.text).toBe('someone-elses-provider')
    expect(WEB_SEARCH_SELECTABLE_IDS).not.toContain('someone-elses-provider')
    // Untouched: nothing wrote, so the Host still holds exactly what it had.
    expect(host.mutate).not.toHaveBeenCalled()
  })

  it('writes the chosen id through the form, staged until save', async () => {
    const host = stubConfigForm<WebSeamSettings>()
    acceptWrites(host)
    const controller = new WebSearchSelectionController(host.scope)
    host.publish({ status: 'ready', writable: true, value: {}, base: {}, user: {} })
    const face = controller.inject()

    face.edit('searchProvider', 'brave')
    expect(face.hooks.webSearchSelection.getSnapshot()).toMatchObject({ dirty: true, searchProvider: { text: 'brave' } })
    expect(host.mutate).not.toHaveBeenCalled()

    face.save()
    await vi.waitFor(() => { expect(host.mutate).toHaveBeenCalledTimes(1) })

    expect(host.mutate.mock.calls[0]![0]).toEqual([{ op: 'set', path: ['searchProvider'], value: 'brave' }])
    await vi.waitFor(() => {
      expect(face.hooks.webSearchSelection.getSnapshot()).toMatchObject({ dirty: false, searchProvider: { text: 'brave' } })
    })
  })

  it('unsets the field when the automatic entry is chosen, handing the choice back to the seam', async () => {
    const host = stubConfigForm<WebSeamSettings>()
    acceptWrites(host)
    const controller = new WebSearchSelectionController(host.scope)
    host.publish({
      status: 'ready', writable: true,
      value: { searchProvider: 'brave' }, base: { searchProvider: 'duckduckgo' }, user: { searchProvider: 'brave' },
    })
    const face = controller.inject()

    face.edit('searchProvider', '')
    face.save()
    await vi.waitFor(() => { expect(host.mutate).toHaveBeenCalledTimes(1) })

    expect(host.mutate.mock.calls[0]![0]).toEqual([{ op: 'unset', path: ['searchProvider'] }])
    // Re-inherited rather than stored: the empty draft clears the user layer and
    // the composition's value comes back, which is what "automatic" means.
    await vi.waitFor(() => {
      expect(face.hooks.webSearchSelection.getSnapshot()).toMatchObject({ searchProvider: { text: 'duckduckgo' } })
    })
  })

  it('refuses to stage a save on a read-only document', async () => {
    const host = stubConfigForm<WebSeamSettings>()
    acceptWrites(host)
    const controller = new WebSearchSelectionController(host.scope)
    host.publish({ status: 'ready', writable: false, value: {}, base: {}, user: {} })
    const face = controller.inject()

    face.edit('searchProvider', 'tavily')
    face.save()
    await Promise.resolve()

    expect(host.mutate).not.toHaveBeenCalled()
    expect(face.hooks.webSearchSelection.getSnapshot()).toMatchObject({ writable: false, dirty: true })
  })

  it('reports a refused save and keeps the staged selection for correction', async () => {
    const host = stubConfigForm<WebSeamSettings>()
    host.mutate.mockResolvedValue(false)
    const controller = new WebSearchSelectionController(host.scope)
    host.publish({ status: 'ready', writable: true, value: {}, base: {}, user: {} })
    const face = controller.inject()

    face.edit('searchProvider', 'tavily')
    face.save()

    await vi.waitFor(() => {
      expect(face.hooks.webSearchSelection.getSnapshot()).toMatchObject({ failed: true, dirty: true })
    })
  })

  it('stops following the namespace once disposed', () => {
    const host = stubConfigForm<WebSeamSettings>()
    const controller = new WebSearchSelectionController(host.scope)
    expect(host.listenerCount()).toBe(1)

    controller.dispose()

    expect(host.listenerCount()).toBe(0)
  })

  it('adopts a selection another surface wrote without writing it back', () => {
    const host = stubConfigForm<WebSeamSettings>()
    acceptWrites(host)
    const controller = new WebSearchSelectionController(host.scope)
    host.publish({ status: 'ready', writable: true, value: { searchProvider: 'brave' }, base: {}, user: {} })
    const face = controller.inject()

    // A write from the plugin manager's configuration editor reaches the same
    // namespace, so this control follows it rather than reasserting its draft.
    host.publish({ status: 'ready', writable: true, value: { searchProvider: 'tavily' }, user: { searchProvider: 'tavily' } })

    expect(face.hooks.webSearchSelection.getSnapshot()).toMatchObject({ searchProvider: { text: 'tavily', overridden: true } })
    expect(host.mutate).not.toHaveBeenCalled()
  })
})
