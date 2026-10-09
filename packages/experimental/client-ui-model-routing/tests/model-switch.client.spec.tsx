// @vitest-environment jsdom
/**
 * The model-switch node and row: when a decision is reported as a change, and
 * what the row says about it.
 *
 * The Definition compares the current decision with the one before it, so these
 * cases drive `start` with a stub reader instead of a whole Conversation
 * binding: the comparison is the behavior under test, and the engine-owned
 * assembly around it belongs to the Conversation suites.
 */

import type { ComponentProps } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ConversationContextReader } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { RoutingDecision } from '@deepseek-ai/dsh-experimental-model-routing/types'
import { ModelSwitchNotice } from '../src/client/ModelSwitchNotice.tsx'
import type { ModelSwitchNoticeProps } from '../src/client/ModelSwitchNotice.tsx'
import { modelSwitchDefinition, servingOf } from '../src/client/model-switch.ts'
import type { ModelSwitchData, ModelSwitchState } from '../src/client/model-switch.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t = ((key: string) => (en as Record<string, string>)[key] ?? key) as ModelSwitchNoticeProps['t']

/** One recorded decision, as the session log carries it: claude served `pro`. */
function decision(over: Partial<RoutingDecision> = {}): RoutingDecision {
  return {
    boundary: 'failure',
    requested: 'pro',
    tier: 'pro',
    model: 'xiaomi/mimo-v2.6-pro',
    source: { kind: 'claude-proxy', tag: 'claude-opus-5' },
    endpoint: { tag: 'claude-opus-5', providerName: 'claude-proxy', promptUsd: 1e-12, completionUsd: 1e-12 },
    considered: 3,
    runnersUp: [],
    excludedTags: [],
    ...over,
  }
}

/** What one earlier decision left in the Context the reader hands back. */
function before(serving: ModelSwitchState['serving']): ModelSwitchState {
  return { seq: 16, time: 900, serving }
}

/** A reader that answers with the state one earlier decision left behind. */
function readerWith(state: ModelSwitchState | undefined): ConversationContextReader {
  return {
    previous: () => (state === undefined
      ? undefined
      : { key: 'k', kind: 'model-switch', id: '16', startSeq: 16, state, matches: [] }),
  } as never
}

/** Run one decision through the Definition the way the engine does. */
function run(value: RoutingDecision, previous: ModelSwitchState | undefined, seq = 17) {
  const context = { key: 'k', id: String(seq), matches: [], start: undefined } as never
  const match = {
    id: String(seq),
    role: 'start',
    event: { type: 'model-routing/decision', seq, time: 1_000, data: value },
  } as never
  const state = modelSwitchDefinition.start(context, match, readerWith(previous))
  const node = modelSwitchDefinition.buildViewNode?.({ key: 'k', id: String(seq), matches: [], start: undefined, state } as never)
    ?? null
  return { state, data: (node?.data ?? null) as ModelSwitchData | null }
}

describe('servingOf', () => {
  it('names a direct source by its route and the id that route serves', () => {
    expect(servingOf(decision())).toEqual({ route: 'claude-proxy', model: 'claude-opus-5' })
  })

  it('names a pinned OpenRouter endpoint by its slug and the tier model', () => {
    expect(servingOf(decision({
      source: { kind: 'openrouter', tag: 'xiaomi/mimo-v2.6-pro' },
      endpoint: { tag: 'baidu/fp8', providerName: 'Baidu', promptUsd: 1e-7, completionUsd: 3e-7 },
    }))).toEqual({ route: 'baidu/fp8', model: 'xiaomi/mimo-v2.6-pro' })
  })

  it('reports nothing for a decision that names neither a source nor an endpoint', () => {
    // Built rather than spread over the defaults, because leaving both fields out
    // is the case under test and an explicit `undefined` is not a legal value for
    // them under `exactOptionalPropertyTypes`.
    const bare: RoutingDecision = {
      boundary: 'failure', requested: 'pro', tier: 'pro', model: 'xiaomi/mimo-v2.6-pro',
      considered: 1, runnersUp: [], excludedTags: [],
    }
    expect(servingOf(bare)).toBeUndefined()
  })
})

describe('modelSwitchDefinition', () => {
  it('matches a routing decision and ignores every other event', () => {
    expect(modelSwitchDefinition.match({
      type: 'model-routing/decision', seq: 17, time: 1_000, data: decision(),
    } as never)).toMatchObject({ id: '17', role: 'start' })
    expect(modelSwitchDefinition.match({ type: 'turn/start', seq: 1, time: 1, data: {} } as never)).toBeNull()
  })

  it('publishes a row when the route changed, naming both sides', () => {
    // The case the live session hit: claude's relay dropped the stream, the
    // failure boundary benched it, and the next decision served the same tier on
    // another route. The row reports the move rather than the destination alone.
    const { data } = run(decision(), before({
      route: 'xiaomi-token-plan-sgp', model: 'mimo-v2.6-pro',
    }))
    expect(data).toMatchObject({
      from: { route: 'xiaomi-token-plan-sgp', model: 'mimo-v2.6-pro' },
      to: { route: 'claude-proxy', model: 'claude-opus-5' },
      boundary: 'failure',
      seq: 17,
    })
  })

  it('reports a route change even when the model id stays the same', () => {
    // Same canonical model, different upstream: a different answer stream that
    // the chip alone cannot distinguish, so the row is the only trace of it.
    const { data } = run(decision({
      model: 'xiaomi/mimo-v2.6-pro',
      source: { kind: 'xiaomi-token-plan-sgp', tag: 'mimo-v2.6-pro' },
      endpoint: { tag: 'mimo-v2.6-pro', providerName: 'xiaomi-token-plan-sgp', promptUsd: 1e-12, completionUsd: 1e-12 },
    }), before({ route: 'claude-proxy', model: 'mimo-v2.6-pro' }))
    expect(data).toMatchObject({
      from: { route: 'claude-proxy', model: 'mimo-v2.6-pro' },
      to: { route: 'xiaomi-token-plan-sgp', model: 'mimo-v2.6-pro' },
    })
  })

  it('publishes nothing for the first decision of a session', () => {
    const { data, state } = run(decision(), undefined)
    expect(data).toBeNull()
    // The serving is still held: it is what the NEXT decision compares against.
    expect(state.serving).toEqual({ route: 'claude-proxy', model: 'claude-opus-5' })
  })

  it('publishes nothing when the same route and model were chosen again', () => {
    const { data } = run(decision(), before({ route: 'claude-proxy', model: 'claude-opus-5' }))
    expect(data).toBeNull()
  })
})

describe('ModelSwitchNotice', () => {
  it('names both servings and the boundary that allowed the change', () => {
    // The keyed Chat renderer itself: the framework props it never reads are
    // stubbed, exactly as the Conversation suites stub them.
    const props: Partial<ComponentProps<typeof ModelSwitchNotice>> = {
      node: {
        key: 'switch:17', id: '17', kind: 'model-switch', target: 'chat', anchorSeq: 17,
        location: { kind: 'session' }, visibility: 'visible',
        data: {
          seq: 17,
          time: 1_000,
          from: { route: 'claude-proxy', model: 'claude-opus-5' },
          to: { route: 'xiaomi-token-plan-sgp', model: 'mimo-v2.6-pro' },
          boundary: 'failure',
        },
      },
      t,
    }
    render(<ModelSwitchNotice {...props as ComponentProps<typeof ModelSwitchNotice>} />)
    expect(screen.getByTestId('model-switch')).toBeTruthy()
    expect(screen.getByText('Model switched')).toBeTruthy()
    expect(screen.getByText('claude-proxy/claude-opus-5')).toBeTruthy()
    expect(screen.getByText('xiaomi-token-plan-sgp/mimo-v2.6-pro')).toBeTruthy()
    expect(screen.getByText('after a provider failure')).toBeTruthy()
  })
})
