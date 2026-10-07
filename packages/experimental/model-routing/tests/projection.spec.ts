import { describe, expect, it } from 'vitest'
import type { SessionEvent, SessionEventMap, SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import {
  applyModelRoutingEvent,
  emptyModelRoutingState,
  modelRoutingProjectionDefinition,
  modelRoutingView,
} from '../src/projection.ts'
import type { ModelRoutingState } from '../src/types.ts'

let seq = 0

/** One event of the type under test, with a distinct time and sequence. */
function event<T extends keyof SessionEventMap>(
  type: T,
  data: SessionEventMap[T],
  time = ++seq,
): SessionEvent<T> {
  return {
    type,
    data,
    time,
    seq: SessionSeq(seq),
    ignorable: true,
  } as SessionEvent<T>
}

/** A decision carrying every field the view reads. */
const DECISION: SessionEventMap['model-routing/decision'] = {
  boundary: 'start',
  requested: 'auto',
  tier: 'flash',
  judge: { model: 'typesafe/jev-1.13', answeredBy: 'typesafe/jev-1.13-20260917', pPro: 0, confidence: 1, latencyMs: 512, rule: 'start-flash' },
  model: 'deepseek/deepseek-v4-flash',
  source: { kind: 'openrouter', tag: 'streamlake/fp8' },
  endpoint: { tag: 'streamlake/fp8', providerName: 'StreamLake', quantization: 'fp8', promptUsd: 1e-8, completionUsd: 2e-8 },
  blendedUsdPerToken: 8.4e-9,
  considered: 42,
  runnersUp: [],
  excludedTags: [],
}

describe('applyModelRoutingEvent', () => {
  it('records a decision and clears the compaction mark', () => {
    const before: ModelRoutingState = { ...emptyModelRoutingState(), compactedSinceDecision: true }
    const applied = applyModelRoutingEvent(before, event('model-routing/decision', DECISION, 10))
    expect(applied.decision).toBe(DECISION)
    expect(applied.decidedAt).toBe(10)
    expect(applied.compactedSinceDecision).toBe(false)
  })

  it('stamps the latest assistant response', () => {
    const applied = applyModelRoutingEvent(emptyModelRoutingState(), event('assistant/message', {} as never, 5))
    expect(applied.lastResponseAt).toBe(5)
    expect(applyModelRoutingEvent(applied, event('assistant/attempt', {} as never, 7)).lastResponseAt).toBe(7)
  })

  it('marks a completed compaction and ignores a failed one', () => {
    const decided = applyModelRoutingEvent(emptyModelRoutingState(), event('model-routing/decision', DECISION, 1))
    const compacted = applyModelRoutingEvent(decided, event('compaction/end', {} as never, 3))
    expect(compacted.compactedSinceDecision).toBe(true)
    // Repeating the mark is not a state change, so downstream views stay cached.
    expect(applyModelRoutingEvent(compacted, event('compaction/end', {} as never, 4))).toBe(compacted)

    const failed = applyModelRoutingEvent(decided, event('compaction/end', { error: 'boom' } as never, 5))
    expect(failed).toBe(decided)
  })

  it('marks an explicit selection once', () => {
    const selected = applyModelRoutingEvent(emptyModelRoutingState(), event('model/selection', {} as never, 2))
    expect(selected.explicitSelection).toBe(true)
    expect(applyModelRoutingEvent(selected, event('model/selection', {} as never, 3))).toBe(selected)
  })

  it('accumulates Thread tier overrides by Thread id', () => {
    const first = applyModelRoutingEvent(emptyModelRoutingState(), event('model-routing/tier-override', { threadId: 't1', tier: 'pro' }, 1))
    expect(first.overrides).toEqual({ t1: 'pro' })
    const second = applyModelRoutingEvent(first, event('model-routing/tier-override', { threadId: 't2', tier: 'flash' }, 2))
    expect(second.overrides).toEqual({ t1: 'pro', t2: 'flash' })
    const moved = applyModelRoutingEvent(second, event('model-routing/tier-override', { threadId: 't1', tier: 'flash' }, 3))
    expect(moved.overrides).toEqual({ t1: 'flash', t2: 'flash' })
  })

  it('returns the same reference for an event it does not own', () => {
    const state = emptyModelRoutingState()
    expect(applyModelRoutingEvent(state, event('turn/start', {} as never))).toBe(state)
  })
})

describe('modelRoutingView', () => {
  it('has no view before the first decision', () => {
    expect(modelRoutingView(emptyModelRoutingState())).toBeNull()
  })

  it('projects the pinned model, provider, quantization, and boundary', () => {
    const state = applyModelRoutingEvent(emptyModelRoutingState(), event('model-routing/decision', DECISION, 42))
    expect(modelRoutingView(state)).toEqual({
      requested: 'auto',
      tier: 'flash',
      model: 'deepseek/deepseek-v4-flash',
      providerName: 'StreamLake',
      quantization: 'fp8',
      boundary: 'start',
      decidedAt: 42,
      unpinned: false,
    })
  })

  it('marks an unpinned decision', () => {
    const { endpoint: _omitted, ...withoutEndpoint } = DECISION
    const unpinned: SessionEventMap['model-routing/decision'] = {
      ...withoutEndpoint,
      unpinnedReason: 'HTTP 503',
    }
    const state = applyModelRoutingEvent(emptyModelRoutingState(), event('model-routing/decision', unpinned, 1))
    expect(modelRoutingView(state)).toMatchObject({ unpinned: true })
    expect(modelRoutingView(state)?.providerName).toBeUndefined()
  })
})

describe('modelRoutingProjectionDefinition', () => {
  it('registers under `modelRouting` at state version 1', () => {
    expect(modelRoutingProjectionDefinition.key).toBe('modelRouting')
    expect(modelRoutingProjectionDefinition.stateVersion).toBe(1)
    expect(modelRoutingProjectionDefinition.init({} as SessionHeader, SessionLogOffset(0))).toEqual(emptyModelRoutingState())
  })

  it('validates the pre-decision view the registry publishes', () => {
    const { wire } = modelRoutingProjectionDefinition
    expect(wire.viewSchema.parse(wire.view(emptyModelRoutingState()))).toBeNull()
  })

  it('validates a decided view', () => {
    const { wire } = modelRoutingProjectionDefinition
    const decided = applyModelRoutingEvent(emptyModelRoutingState(), event('model-routing/decision', DECISION, 11))
    expect(wire.viewSchema.parse(wire.view(decided))).toEqual(modelRoutingView(decided))
  })
})

describe('a decision that named a direct source', () => {
  it('folds and projects the source the pin came from', () => {
    const decision: SessionEventMap['model-routing/decision'] = {
      boundary: 'start',
      requested: 'flash',
      tier: 'flash',
      model: 'xiaomi/mimo-v2.6-pro',
      source: { kind: 'xiaomi-plan', tag: 'mimo-v2.6-pro' },
      endpoint: { tag: 'mimo-v2.6-pro', providerName: 'xiaomi-plan', promptUsd: 4.363636e-7, completionUsd: 8.727273e-7, cacheReadUsd: 3.636364e-9 },
      blendedUsdPerToken: 5.56363616e-08,
      considered: 1,
      runnersUp: [],
      excludedTags: [],
    }
    const applied = applyModelRoutingEvent(emptyModelRoutingState(), event('model-routing/decision', decision, 10))
    expect(applied.decision?.source).toEqual({ kind: 'xiaomi-plan', tag: 'mimo-v2.6-pro' })
    const view = modelRoutingView(applied)
    expect(view).toMatchObject({ model: 'xiaomi/mimo-v2.6-pro', providerName: 'xiaomi-plan', unpinned: false })
  })
})
