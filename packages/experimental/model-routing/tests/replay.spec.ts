import { describe, expect, it } from 'vitest'
import type { ReplayEnvelope, RequestMessage } from '@deepseek-ai/dsh-llm'
import { readRoutedReplay, unwrapHistory, wrapReplay } from '../src/replay.ts'
import type { RoutedReplayResponse } from '../src/replay.ts'

const INNER: ReplayEnvelope = {
  response: { kind: 'pi-ai', version: 2, api: 'openai-completions', provider: 'openrouter', model: 'deepseek/deepseek-v4-flash', stopReason: 'stop' },
  blocks: [{ type: 'text' }],
}

/** A durable assistant message as the outer route recorded it. */
function assistant(replayState: unknown, provider = 'tiers', model = 'flash'): RequestMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: 'done' }],
    source: { provider, model, ...replayState === undefined ? {} : { replayState } },
  } as unknown as RequestMessage
}

describe('wrapReplay and readRoutedReplay', () => {
  it('round-trips the route, model, inner envelope, and blocks', () => {
    const wrapped = wrapReplay(INNER, 'openrouter', 'deepseek/deepseek-v4-flash')
    const read = readRoutedReplay(wrapped)
    expect(read?.response).toEqual({
      kind: 'model-routing',
      version: 1,
      route: 'openrouter',
      model: 'deepseek/deepseek-v4-flash',
      inner: INNER.response,
    })
    expect(read?.blocks).toEqual(INNER.blocks)
  })

  it('wraps an envelope that carried no blocks', () => {
    const wrapped = wrapReplay({ response: { kind: 'pi-ai' } }, 'openrouter', 'm')
    expect(readRoutedReplay(wrapped)?.response.inner).toEqual({ kind: 'pi-ai' })
    expect(readRoutedReplay(wrapped)?.blocks).toBeUndefined()
  })

  it('wraps a finish chunk that carried no replay state at all', () => {
    const wrapped = wrapReplay(undefined, 'openrouter', 'm')
    expect(readRoutedReplay(wrapped)?.response.inner).toBeUndefined()
  })

  it('reads nothing out of a foreign or malformed envelope', () => {
    expect(readRoutedReplay(undefined)).toBeUndefined()
    expect(readRoutedReplay(null)).toBeUndefined()
    expect(readRoutedReplay([])).toBeUndefined()
    expect(readRoutedReplay({})).toBeUndefined()
    expect(readRoutedReplay({ response: { kind: 'pi-ai', version: 2 } })).toBeUndefined()
    expect(readRoutedReplay({ response: { kind: 'model-routing', version: 2, route: 'r', model: 'm' } })).toBeUndefined()
    expect(readRoutedReplay({ response: { kind: 'model-routing', version: 1 } })).toBeUndefined()
  })
})

describe('unwrapHistory', () => {
  it('rewrites this route\'s assistant messages onto the inner route and model', () => {
    const history: readonly RequestMessage[] = Object.freeze([
      assistant(wrapReplay(INNER, 'openrouter', 'deepseek/deepseek-v4-flash')),
    ])
    const [message] = unwrapHistory(history, 'tiers')
    const source = (message as { source: { provider: string; model: string; replayState?: ReplayEnvelope } }).source
    expect(source.provider).toBe('openrouter')
    expect(source.model).toBe('deepseek/deepseek-v4-flash')
    expect(source.replayState?.response).toEqual(INNER.response)
    expect(source.replayState?.blocks).toEqual(INNER.blocks)
    // The frozen input is untouched.
    expect((history[0] as { source: { provider: string } }).source.provider).toBe('tiers')
  })

  it('returns another route\'s messages as the same objects', () => {
    const foreign = assistant(wrapReplay(INNER, 'openrouter', 'deepseek/deepseek-v4-flash'), 'openrouter', 'deepseek/deepseek-v4-flash')
    const user = { role: 'user', content: [{ type: 'text', text: 'hi' }] } as unknown as RequestMessage
    const out = unwrapHistory([foreign, user], 'tiers')
    expect(out[0]).toBe(foreign)
    expect(out[1]).toBe(user)
  })

  it('drops the replay state of a wrapper this build cannot read, keeping the identity', () => {
    const message = assistant({ response: { kind: 'something-else' } })
    const [out] = unwrapHistory([message], 'tiers')
    const source = (out as { source: { provider: string; model: string; replayState?: unknown } }).source
    expect(source.provider).toBe('tiers')
    expect(source.model).toBe('flash')
    expect(source.replayState).toBeUndefined()
  })

  it('keeps the inner identity but drops the state when the wrapper carries no inner envelope', () => {
    const wrapper: RoutedReplayResponse = { kind: 'model-routing', version: 1, route: 'openrouter', model: 'z-ai/glm-5.3' }
    const [out] = unwrapHistory([assistant({ response: wrapper, blocks: [{ type: 'text' }] })], 'tiers')
    const source = (out as { source: { provider: string; model: string; replayState?: unknown } }).source
    expect(source.provider).toBe('openrouter')
    expect(source.model).toBe('z-ai/glm-5.3')
    expect(source.replayState).toBeUndefined()
  })
})
