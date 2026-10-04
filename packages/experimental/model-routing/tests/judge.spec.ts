import { describe, expect, it, vi } from 'vitest'
import type { RequestMessage } from '@deepseek-ai/dsh-llm'
import { Config, readSettings } from '../src/config.ts'
import type { RoutingSettings } from '../src/config.ts'
import { askJudge, judgeQuestions, judgeState, tierFromVerdict } from '../src/judge.ts'
import type { JudgeState } from '../src/judge.ts'
import type { JudgeVerdict } from '../src/types.ts'
import { decisionOf } from './fixtures.ts'

const MODEL = 'typesafe/jev-1.13'

function settings(over: Record<string, unknown> = {}): RoutingSettings {
  return readSettings(Config({
    tiers: [
      { name: 'pro', label: 'Pro', models: ['deepseek/deepseek-v4-pro'], contextWindow: 1000000, maxTokens: 32768, unknownQuantization: 'reject' },
      { name: 'flash', label: 'Flash', models: ['deepseek/deepseek-v4-flash'], contextWindow: 1000000, maxTokens: 32768, unknownQuantization: 'reject' },
    ],
    defaultTier: 'flash',
    ...over,
  } as never))
}

/** A recorded reply, served by a fetch double that also records the request. */
async function judgeFixture(name: string, state: JudgeState): Promise<{
  verdict: Omit<JudgeVerdict, 'rule'>
  calls: { url: string; init: RequestInit }[]
}> {
  const fixture = await decisionOf(name) as { status: number; response: unknown }
  const calls: { url: string; init: RequestInit }[] = []
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: url instanceof Request ? url.url : url.toString(), init: init ?? {} })
    return new Response(typeof fixture.response === 'string' ? fixture.response : JSON.stringify(fixture.response), {
      status: fixture.status,
      headers: { 'content-type': 'application/json' },
    })
  })
  let clock = 0
  const verdict = await askJudge({
    url: 'https://openrouter.ai/api/alpha/decisions',
    apiKey: 'key',
    model: MODEL,
    state,
    questions: judgeQuestions(settings()),
    proTier: 'pro',
    timeoutMs: 3000,
    signal: new AbortController().signal,
    headers: { 'http-title': 'DSH' },
    fetch: fetch,
    now: () => (clock += 512),
  })
  return { verdict, calls }
}

const LATEST: JudgeState = { latest_user_message: 'Rename `cnt` to `count`' }

describe('judgeQuestions', () => {
  it('assembles the three typed questions from settings', () => {
    const value = settings()
    expect(judgeQuestions(value)).toEqual({
      tier: { type: 'choice', instructions: value.judgeTierInstructions, criteria: { flash: value.judgeFlashCriteria, pro: value.judgeProCriteria } },
      difficulty: { type: 'score', instructions: value.judgeDifficultyInstructions, criteria: ['Trivial', 'Routine', 'Moderate', 'Hard', 'Very hard'] },
      precision: { type: 'noul', instructions: value.judgePrecisionInstructions, criteria: { true: value.judgePrecisionTrue, false: value.judgePrecisionFalse } },
    })
  })
})

describe('askJudge', () => {
  it('reads a recorded easy verdict and sends the documented request', async () => {
    const { verdict, calls } = await judgeFixture('easy', LATEST)
    expect(verdict).toEqual({
      model: MODEL,
      answeredBy: 'typesafe/jev-1.13-20260917',
      pPro: 0,
      confidence: 1,
      difficulty: 0.09,
      precision: 0.07,
      costUsd: 2.1966e-05,
      latencyMs: 512,
    })
    expect(calls).toHaveLength(1)
    const headers = calls[0]?.init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer key')
    expect(headers['content-type']).toBe('application/json')
    expect(headers['http-title']).toBe('DSH')
    expect(JSON.parse(calls[0]?.init.body as string)).toMatchObject({ model: MODEL, state: LATEST })
  })

  it('reports an HTTP failure as a verdict error rather than rejecting', async () => {
    const { verdict } = await judgeFixture('error-missing-criteria', LATEST)
    expect(verdict.error).toMatch(/^HTTP 400: /)
    expect(verdict.pPro).toBeUndefined()
  })

  it('times out instead of hanging the request', async () => {
    let clock = 0
    const verdict = await askJudge({
      url: 'https://openrouter.ai/api/alpha/decisions',
      apiKey: 'key',
      model: MODEL,
      state: LATEST,
      questions: {},
      proTier: 'pro',
      timeoutMs: 50,
      signal: new AbortController().signal,
      headers: {},
      fetch: ((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => { clock += 50; reject(new Error('The operation was aborted')) }, { once: true })
      })) as unknown as typeof fetch,
      now: () => clock,
    })
    expect(verdict.error).toBeDefined()
    expect(verdict.latencyMs).toBeGreaterThanOrEqual(50)
    expect(verdict.pPro).toBeUndefined()
  })

  it('refuses a reply larger than it can trust', async () => {
    const verdict = await askJudge({
      url: 'https://openrouter.ai/api/alpha/decisions',
      apiKey: 'key',
      model: MODEL,
      state: LATEST,
      questions: {},
      proTier: 'pro',
      timeoutMs: 3000,
      signal: new AbortController().signal,
      headers: {},
      fetch: async () => new Response('x'.repeat(300 * 1024)),
      now: () => 0,
    })
    expect(verdict.error).toBe('response too large')
  })

  it('refuses a reply that does not match the decision schema', async () => {
    const verdict = await askJudge({
      url: 'https://openrouter.ai/api/alpha/decisions',
      apiKey: 'key',
      model: MODEL,
      state: LATEST,
      questions: {},
      proTier: 'pro',
      timeoutMs: 3000,
      signal: new AbortController().signal,
      headers: {},
      fetch: async () => new Response(JSON.stringify({ model: 'm' }), { status: 200 }),
      now: () => 0,
    })
    expect(verdict.error).toContain('does not match the decision schema')
  })
})

describe('tierFromVerdict', () => {
  it('starts a session from the probabilities', async () => {
    const easy = (await judgeFixture('easy', LATEST)).verdict
    const hard = (await judgeFixture('hard', LATEST)).verdict
    const bare = (await judgeFixture('continue-bare', LATEST)).verdict
    const context = (await judgeFixture('continue-context', LATEST)).verdict

    expect(tierFromVerdict(easy, undefined, settings())).toEqual({ tier: 'flash', rule: 'start-flash' })
    expect(tierFromVerdict(hard, undefined, settings())).toEqual({ tier: 'pro', rule: 'start-pro' })
    expect(tierFromVerdict(bare, undefined, settings())).toEqual({ tier: 'flash', rule: 'start-flash' })
    expect(tierFromVerdict(bare, undefined, settings({ judgeMinConfidence: 0.6 })))
      .toEqual({ tier: 'flash', rule: 'low-confidence' })
    expect(tierFromVerdict(context, 'flash', settings())).toEqual({ tier: 'pro', rule: 'to-pro' })
    expect(tierFromVerdict(easy, 'pro', settings())).toEqual({ tier: 'flash', rule: 'to-flash' })
  })

  it('keeps a mid-conversation tier the verdict does not clearly move', () => {
    expect(tierFromVerdict({ pPro: 0.45, confidence: 0.9, precision: 0.1, model: MODEL, latencyMs: 1 }, 'pro', settings()))
      .toEqual({ tier: 'pro', rule: 'keep' })
  })

  it('goes pro on a high-precision request whatever the tier probabilities say', () => {
    expect(tierFromVerdict({ precision: 0.85, pPro: 0, confidence: 1, model: MODEL, latencyMs: 1 }, 'flash', settings()))
      .toEqual({ tier: 'pro', rule: 'precision' })
  })

  it('keeps the pinned tier when the judge failed outright', () => {
    expect(tierFromVerdict({ error: 'HTTP 500', model: MODEL, latencyMs: 1 }, 'pro', settings()))
      .toEqual({ tier: 'pro', rule: 'judge-error' })
    expect(tierFromVerdict({ error: 'HTTP 500', model: MODEL, latencyMs: 1 }, undefined, settings()))
      .toEqual({ tier: 'flash', rule: 'judge-error' })
  })
})

describe('judgeState', () => {
  it('has nothing to judge without user text', () => {
    expect(judgeState([], 3, 12000)).toBeUndefined()
    const assistantOnly: readonly RequestMessage[] = [
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } as unknown as RequestMessage,
    ]
    expect(judgeState(assistantOnly, 3, 12000)).toBeUndefined()
  })

  it('collects the latest user message, earlier ones, and the compaction checkpoint', () => {
    const history: readonly RequestMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'first ask' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'answer' }] } as unknown as RequestMessage,
      { role: 'user', content: [{ type: 'text', text: 'second ask' }] },
      { role: 'tool', content: [{ type: 'text', text: 'tool output' }] } as unknown as RequestMessage,
      { role: 'user', content: [{ type: 'text', text: 'checkpoint' }], source: { kind: 'compact-checkpoint' } } as unknown as RequestMessage,
      { role: 'user', content: [{ type: 'text', text: 'third ask' }] },
    ]
    expect(judgeState(history, 3, 12000)).toEqual({
      latest_user_message: 'third ask',
      previous_user_messages: ['first ask', 'second ask'],
      compaction_summary: 'checkpoint',
    })
  })

  it('keeps only as many earlier messages as asked for', () => {
    const history: readonly RequestMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'a' }] },
      { role: 'user', content: [{ type: 'text', text: 'b' }] },
      { role: 'user', content: [{ type: 'text', text: 'c' }] },
    ]
    expect(judgeState(history, 1, 12000)?.previous_user_messages).toEqual(['b'])
    expect(judgeState(history, 0, 12000)?.previous_user_messages).toBeUndefined()
  })

  it('spends the budget on the latest message first and truncates with an ellipsis', () => {
    const long = 'x'.repeat(200)
    const history: readonly RequestMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'old' }] },
      { role: 'user', content: [{ type: 'text', text: long }], source: { kind: 'compact-checkpoint' } } as unknown as RequestMessage,
      { role: 'user', content: [{ type: 'text', text: long }] },
    ]
    const state = judgeState(history, 2, 100)!
    expect(state.latest_user_message).toHaveLength(50)
    expect(state.latest_user_message.endsWith('…')).toBe(true)
    expect(state.compaction_summary).toHaveLength(25)
  })

  it('joins several text blocks and skips a message that carries none', () => {
    const history: readonly RequestMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] },
      { role: 'user', content: [{ type: 'image', imageId: 'img' }] } as unknown as RequestMessage,
      { role: 'user', content: [] },
    ]
    expect(judgeState(history, 3, 12000)).toEqual({ latest_user_message: 'one\ntwo' })
  })
})
