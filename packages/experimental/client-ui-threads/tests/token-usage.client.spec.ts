/** The Project token ledger: the `tokenUsage` fold, the empty reading, and the compact figure. */
import { describe, expect, it } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  aggregateTokenSpend, formatTokenCount, hasTokenSpend, isTokenBuckets, type TokenSpend,
} from '../src/client/token-usage.ts'
import { en, zh } from '../src/client/locales.ts'

const sid = (id: string): SessionId => id as SessionId
const t = makeTranslate(zh, en)

/** One published `tokenUsage` value, with any bucket left at zero unless given. */
function usage(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uncachedInputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ...over,
  }
}

describe('isTokenBuckets', () => {
  it('accepts a value carrying all four finite buckets', () => {
    expect(isTokenBuckets(usage({ uncachedInputTokens: 12, outputTokens: 3 }))).toBe(true)
  })

  it.each([
    ['a missing value', undefined],
    ['null', null],
    ['a non-object', '4'],
    ['a value missing one bucket', { uncachedInputTokens: 1, outputTokens: 2, cacheReadTokens: 3 }],
    ['a bucket that is not a number', usage({ cacheWriteTokens: 'many' })],
    ['a bucket the Host could not fold into a number', usage({ outputTokens: Number.NaN })],
  ])('rejects %s rather than folding it', (_label, value) => {
    expect(isTokenBuckets(value)).toBe(false)
  })
})

describe('aggregateTokenSpend', () => {
  it('adds the four buckets of the Project and every Thread', () => {
    const readings: Record<string, Record<string, unknown>> = {
      project: usage({ uncachedInputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 3 }),
      'thread-1': usage({ uncachedInputTokens: 200, outputTokens: 40, cacheReadTokens: 7, cacheWriteTokens: 1 }),
      'thread-2': usage({ uncachedInputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 }),
    }
    const spend = aggregateTokenSpend(
      sessionId => readings[String(sessionId)],
      [sid('project'), sid('thread-1'), sid('thread-2')],
    )
    expect(spend).toEqual({
      inputTokens: 301,
      cacheReadTokens: 12,
      cacheWriteTokens: 4,
      outputTokens: 62,
      totalTokens: 379,
      sessions: 3,
    })
  })

  it('leaves a Session that published nothing out of every bucket', () => {
    const spend = aggregateTokenSpend(
      sessionId => (sessionId === 'thread-1' ? usage({ outputTokens: 10 }) : undefined),
      [sid('project'), sid('thread-1'), sid('thread-2')],
    )
    expect(spend).toEqual({
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 10,
      totalTokens: 10,
      sessions: 1,
    })
  })

  it('skips a published value it cannot trust instead of counting part of it', () => {
    // A deployment without the token meter has no key at all; a half-formed
    // value is data, not a partial sum.
    const spend = aggregateTokenSpend(
      sessionId => (sessionId === 'thread-1' ? usage({ outputTokens: 10 }) : { uncachedInputTokens: 5 }),
      [sid('project'), sid('thread-1')],
    )
    expect(spend.totalTokens).toBe(10)
    expect(spend.sessions).toBe(1)
  })

  it('reads an empty Project as nothing at all, never as a zero Session count', () => {
    expect(aggregateTokenSpend(() => undefined, [])).toEqual({
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      sessions: 0,
    })
  })
})

describe('hasTokenSpend', () => {
  const spend = (totalTokens: number): TokenSpend => ({
    inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, totalTokens, sessions: 1,
  })

  it('is false for a Project whose buckets are all still zero', () => {
    // Recorded usage only exists once a provider reported it, so a zero total
    // is an absence of readings rather than a measurement.
    expect(hasTokenSpend(spend(0))).toBe(false)
  })

  it('is true as soon as one token has been reported', () => {
    expect(hasTokenSpend(spend(1))).toBe(true)
  })
})

describe('formatTokenCount', () => {
  it.each([
    { value: 0, text: '0' },
    { value: 517, text: '517' },
    { value: 999, text: '999' },
    { value: 1_000, text: '1K' },
    { value: 12_249, text: '12.2K' },
    { value: 12_250, text: '12.3K' },
    { value: 517_400, text: '517K' },
    { value: 999_999, text: '1000K' },
    { value: 1_000_000, text: '1M' },
    { value: 1_249_999, text: '1.2M' },
    { value: 517_000_000, text: '517M' },
    { value: 1_500_000_000, text: '1.5B' },
    { value: 517_000_000_000, text: '517B' },
  ])('renders $value tokens as $text', ({ value, text }) => {
    expect(formatTokenCount(value, t)).toBe(text)
  })

  it('formats the same figure through the English dictionary', () => {
    expect(formatTokenCount(12_249, makeTranslate(en))).toBe('12.2K')
  })
})
