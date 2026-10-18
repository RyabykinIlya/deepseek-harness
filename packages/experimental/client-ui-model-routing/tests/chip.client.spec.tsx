// @vitest-environment jsdom
/** The composer chip as the input bar renders it: a tier, a model, and a tooltip. */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ModelSelectionProjection } from '@deepseek-ai/dsh-api-session-controller/types'
import { allowAllAccess } from '@deepseek-ai/dsh-client-test-runtime'
import type { ModelRoutingView } from '@deepseek-ai/dsh-experimental-model-routing/client'
import { ModelRoutingChip, pendingModel, shortModel } from '../src/client/ModelRoutingChip.tsx'
import type { ModelRoutingChipProps } from '../src/client/ModelRoutingChip.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t = ((key: string, params?: Record<string, unknown>) => {
  const template = (en as Record<string, string>)[key] ?? key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = params[name]
    return typeof value === 'string' ? value : `{${name}}`
  })
}) as ModelRoutingChipProps['t']

/** Stub the projection seat: a key-addressed table of whole values. */
function projections(values: Record<string, unknown>): ModelRoutingChipProps['useProjection'] {
  return (key: string) => values[key]
}

// The chip reads one projection and its own dictionary; every other framework
// seat is unreachable from this isolated render.
const unusedHook = (): never => { throw new Error('ModelRoutingChip does not consume this framework seat') }
const unusedActions: ModelRoutingChipProps['inputActions'] = {
  captureInsertion: unusedHook,
  insertText: unusedHook,
  setDraft: unusedHook,
  persistDraft: unusedHook,
  addAttachments: unusedHook,
  removeAttachment: unusedHook,
  pruneAttachments: unusedHook,
  submit: unusedHook,
}

/** Render the chip over one published routing value and one selection value. */
function chip(
  view: ModelRoutingView | null | undefined,
  selection?: ModelSelectionProjection | null,
  setOpenRouterFallback: ModelRoutingChipProps['setOpenRouterFallback'] = () => Promise.resolve(),
) {
  const props: ModelRoutingChipProps = {
    ...allowAllAccess,
    useProjection: projections({ modelRouting: view, modelSelection: selection }),
    useSession: unusedHook,
    sessionId: 's1' as ModelRoutingChipProps['sessionId'],
    useConversation: unusedHook,
    useInput: unusedHook,
    inputActions: unusedActions,
    useTrajectory: unusedHook,
    useChat: unusedHook,
    usePanelInfo: unusedHook,
    useSessions: unusedHook,
    useSessionStatus: unusedHook,
    useSessionRetainInfo: unusedHook,
    useResource: unusedHook,
    useWorkspaces: unusedHook,
    t,
    setOpenRouterFallback,
  }
  return render(<ModelRoutingChip {...props} />)
}

const DECIDED: ModelRoutingView = {
  requested: 'auto',
  tier: 'flash',
  model: 'deepseek/deepseek-v4-flash',
  providerName: 'StreamLake',
  quantization: 'fp8',
  boundary: 'start',
  decidedAt: 1,
  unpinned: false,
  openRouterFallback: true,
}

/** A selection projection whose next request would ask for a different model. */
const WAITING: ModelSelectionProjection = {
  lastUsed: { provider: 'tiers', model: 'auto' },
  next: { provider: 'tiers', model: 'deepseek/deepseek-v4.1-flash', reasoningEffort: 'high' },
}

describe('ModelRoutingChip', () => {
  it('names the tier and the model, with the provider and quantization in the tooltip', () => {
    chip(DECIDED)
    const element = screen.getByTestId('model-routing-chip')
    expect(element.textContent).toBe('flash · deepseek-v4-flash')
    const title = element.getAttribute('title')
    expect(title).toContain('deepseek/deepseek-v4-flash')
    expect(title).toContain('StreamLake')
    expect(title).toContain('fp8')
    expect(title).toContain('session start')
  })

  it('names the waiting model after an arrow and says so in the tooltip', () => {
    chip(DECIDED, WAITING)
    const element = screen.getByTestId('model-routing-chip')
    expect(element.textContent).toBe('flash · deepseek-v4-flash → deepseek-v4.1-flash')
    expect(element.getAttribute('title')).toContain('next request: deepseek/deepseek-v4.1-flash')
  })

  it('names one model when the selection asks for what the decision already requested', () => {
    chip(DECIDED, { lastUsed: { provider: 'tiers', model: 'auto' }, next: { provider: 'tiers', model: 'auto' } })
    const element = screen.getByTestId('model-routing-chip')
    expect(element.textContent).toBe('flash · deepseek-v4-flash')
    expect(element.getAttribute('title')).not.toContain('next request')
  })

  it('names one model when no selection projection is served', () => {
    chip(DECIDED, undefined)
    expect(screen.getByTestId('model-routing-chip').textContent).toBe('flash · deepseek-v4-flash')
    cleanup()
    chip(DECIDED, null)
    expect(screen.getByTestId('model-routing-chip').textContent).toBe('flash · deepseek-v4-flash')
  })

  it('says the provider is unpinned when the decision pinned none', () => {
    const { providerName: _omitted, ...withoutProvider } = DECIDED
    chip({ ...withoutProvider, unpinned: true })
    expect(screen.getByTestId('model-routing-chip').getAttribute('title'))
      .toContain('no provider pinned')
  })

  it('shows an unknown quantization as a question mark rather than a blank', () => {
    const { quantization: _omitted, ...withoutQuantization } = DECIDED
    chip(withoutQuantization)
    expect(screen.getByTestId('model-routing-chip').getAttribute('title')).toContain('?')
  })

  it('renders nothing before the first decision', () => {
    chip(null)
    expect(screen.queryByTestId('model-routing-chip')).toBeNull()
    cleanup()
    chip(undefined)
    expect(screen.queryByTestId('model-routing-chip')).toBeNull()
  })

  it('renders a tier it has no translation for under its own name', () => {
    chip({ ...DECIDED, tier: 'turbo' })
    expect(screen.getByTestId('model-routing-chip').textContent).toBe('turbo · deepseek-v4-flash')
  })

  it('names the dispatched model on a direct source, so label and tooltip agree', () => {
    // The view resolves a direct source to the id the request carried, so the
    // chip never names a canonical id beside the route that dispatched another.
    chip({ ...DECIDED, tier: 'pro', model: 'claude-opus-5', providerName: 'claude-proxy' })
    const element = screen.getByTestId('model-routing-chip')
    expect(element.textContent).toBe('pro · claude-opus-5')
    const title = element.getAttribute('title')
    expect(title).toContain('claude-opus-5')
    expect(title).toContain('claude-proxy')
    expect(title).not.toContain('mimo')
  })
})

describe('pendingModel', () => {
  it('returns the model a waiting selection would apply', () => {
    expect(pendingModel('auto', WAITING)).toBe('deepseek/deepseek-v4.1-flash')
  })

  it('returns nothing when the selection matches the decision request', () => {
    expect(pendingModel('auto', { lastUsed: null, next: { provider: 'tiers', model: 'auto' } })).toBeUndefined()
  })

  it('returns nothing without a selection projection or without a next value', () => {
    expect(pendingModel('auto', undefined)).toBeUndefined()
    expect(pendingModel('auto', { lastUsed: null, next: null })).toBeUndefined()
  })
})

describe('ModelRoutingChip fallback switch', () => {
  it('shows whether this Session would leave a spent subscription for OpenRouter', () => {
    chip(DECIDED)
    const toggle = screen.getByTestId('model-routing-fallback') as HTMLInputElement
    expect(toggle.checked).toBe(true)
    expect(toggle.closest('label')?.getAttribute('title')).toContain('subscription runs out of quota')
  })

  it('renders the recorded value rather than a local default', () => {
    chip({ ...DECIDED, openRouterFallback: false })
    expect((screen.getByTestId('model-routing-fallback')).checked).toBe(false)
  })

  it('records the flipped value for this Session', async () => {
    const recorded: boolean[] = []
    chip(DECIDED, undefined, (enabled) => {
      recorded.push(enabled)
      return Promise.resolve()
    })
    const toggle = screen.getByTestId('model-routing-fallback') as HTMLInputElement
    toggle.click()
    expect(recorded).toEqual([false])
  })
})

describe('shortModel', () => {
  it('drops the author prefix and leaves a bare id alone', () => {
    expect(shortModel('deepseek/deepseek-v4-flash')).toBe('deepseek-v4-flash')
    expect(shortModel('stealth')).toBe('stealth')
  })
})
