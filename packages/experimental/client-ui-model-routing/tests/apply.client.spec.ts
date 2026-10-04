/** What the browser half registers, when, and that it all leaves with the fiber. */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { RemoteError, TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply as settingsApply, inject as settingsInject } from '@deepseek-ai/dsh-client-ui-settings/client'
import { apply, inject } from '../src/client/index.ts'
import type { ModelRoutingCardFace } from '../src/client/index.ts'
import { apply as hostApply } from '../src/index.ts'

/** One Host view of a served namespace. */
function view(ns: string, revision = 0) {
  return { ns, schema: {}, value: {}, applies: 'live', secrets: [], revision }
}

/**
 * @param served - namespaces the Host describes; omitted answers a failed read.
 * @param mountNamespace - whether `remote.modelRouting` is available, as a real
 *   `$mount` makes it; `false` stands for the window before the mount settles.
 */
async function bench(served?: string[], mountNamespace = true) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  const models = vi.fn(() => Promise.resolve({ ok: true as const, value: { groups: [], failures: [] } }))
  const describeSettings = vi.fn(() => Promise.resolve(served === undefined
    ? { ok: false, error: new RemoteError('gateway/internal', 'no provider', {}) }
    : { ok: true, value: { writable: true, hasDocument: true, namespaces: served.map(ns => view(ns)) } }))
  const modelRouting = {
    quote: vi.fn(() => Promise.resolve({ ok: true, value: [] })),
    freeUsage: vi.fn(() => Promise.resolve({ ok: true, value: { used: 0, limit: 1000, remaining: 1000 } })),
  }
  const remote = new TestRemote(ctx, {
    session: { modelCatalog: models },
    settings: { describe: describeSettings },
    ...mountNamespace ? { modelRouting } : {},
  })
  // The generated Remote contribution is not what these cases exercise, so the
  // double accepts a mount and records the namespaces the page will then call.
  const mounted: string[] = []
  remote.$mount = (contribution) => {
    mounted.push(Object.keys(contribution as unknown as Record<string, unknown>).join(','))
    return Promise.resolve(async () => { mounted.length = 0 })
  }
  await ctx.plugin({ inject: [...settingsInject], apply: settingsApply }).await()
  return { ctx, slots: ctx.get('slots') as SlotRegistry, describeSettings, models, modelRouting, remote, mounted }
}

/** The Plugins page's item slot, as its owner declares it. */
function declareRoot(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: { 'plugins.item': { kind: 'list', scope: 'root' } },
  } as never, () => null)
}

/** The composer's input-bar right seat, as its owner declares it. */
function declareInput(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: { 'conversation.input.right': { kind: 'list', scope: 'session' } },
  } as never, () => null)
}

describe('ui-model-routing apply', () => {
  it('keeps the host Loader entry inert', () => {
    expect(hostApply).not.toThrow()
  })

  it('declares the services it uses', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote', 'remote.session', 'configForms'])
  })

  it('registers the settings page while the Host serves the namespace', async () => {
    const { ctx, slots } = await bench(['model-routing'])
    declareRoot(slots)

    await ctx.plugin({ inject: [...inject], apply }).await()

    await vi.waitFor(() => { expect(slots.entries('plugins.item')).toHaveLength(1) })
    const entry = slots.entries('plugins.item')[0]!
    expect(entry.options).toMatchObject({ id: 'model-routing', order: 35 })
    expect(resolveSlotLabel(entry.options.label)).toBe('模型路由')
    const face = (entry.inject as () => Pick<ModelRoutingCardFace, 'hooks'>)()
    expect(Object.keys(face.hooks)).toEqual(['modelRoutingCard'])
  })

  it('registers no page while the Host does not serve the namespace', async () => {
    const { ctx, slots } = await bench([])
    declareRoot(slots)

    await ctx.plugin({ inject: [...inject], apply }).await()

    await vi.waitFor(() => { expect(slots.entries('plugins.item')).toHaveLength(0) })
  })

  it('holds the settings page until the mounted namespace is available', async () => {
    const { ctx, slots, remote, modelRouting } = await bench(['model-routing'], false)
    declareRoot(slots)

    await ctx.plugin({ inject: [...inject], apply }).await()
    expect(slots.entries('plugins.item')).toHaveLength(0)

    remote.provideNamespaces({ modelRouting })

    await vi.waitFor(() => { expect(slots.entries('plugins.item')).toHaveLength(1) })
  })

  it('registers the composer chip', async () => {
    const { ctx, slots } = await bench(['model-routing'])
    declareInput(slots)

    await ctx.plugin({ inject: [...inject], apply }).await()

    await vi.waitFor(() => { expect(slots.entries('conversation.input.right')).toHaveLength(1) })
    expect(slots.entries('conversation.input.right')[0]?.options)
      .toMatchObject({ id: 'model-routing', order: 50 })
  })
})
