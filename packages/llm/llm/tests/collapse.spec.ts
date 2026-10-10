import { describe, expect, it } from 'vitest'
import {
  BlockAssembler,
  ToolCallId,
  collapseDegenerateRepetition,
  type ContentBlock,
} from '@deepseek-ai/dsh-llm'

describe('collapseDegenerateRepetition', () => {
  it('collapses text repeating the reasoning text to one copy', () => {
    expect(collapseDegenerateRepetition([
      { type: 'reasoning', text: 'thinking…' },
      { type: 'text', text: 'thinking…thinking…' },
    ])).toEqual([
      { type: 'reasoning', text: 'thinking…' },
      { type: 'text', text: 'thinking…' },
    ])
  })

  it('collapses 27 copies of the reasoning text to one copy', () => {
    const raw = 'plan'.repeat(27)
    expect(collapseDegenerateRepetition([
      { type: 'reasoning', text: 'plan' },
      { type: 'text', text: raw },
    ])).toEqual([
      { type: 'reasoning', text: 'plan' },
      { type: 'text', text: 'plan' },
    ])
  })

  it('collapses self-repetition to the minimal unit', () => {
    expect(collapseDegenerateRepetition([{ type: 'text', text: 'abababab' }]))
      .toEqual([{ type: 'text', text: 'ab' }])
    expect(collapseDegenerateRepetition([{ type: 'text', text: 'xyzxyz' }]))
      .toEqual([{ type: 'text', text: 'xyz' }])
  })

  it('keeps a repeated single character, which is normally intentional formatting', () => {
    for (const text of ['---', 'aaaa', '***', '===', '###', '-----']) {
      const block: ContentBlock = { type: 'text', text }
      expect(collapseDegenerateRepetition([block])[0]).toBe(block)
    }
    // A one-character reasoning unit does not rule out the reasoning match.
    expect(collapseDegenerateRepetition([
      { type: 'reasoning', text: '-' },
      { type: 'text', text: '----' },
    ])).toEqual([
      { type: 'reasoning', text: '-' },
      { type: 'text', text: '-' },
    ])
  })

  it('collapses at the two-copy threshold and keeps a single copy unchanged', () => {
    expect(collapseDegenerateRepetition([
      { type: 'reasoning', text: 'ab' },
      { type: 'text', text: 'abab' },
      { type: 'text', text: 'ab' },
    ])).toEqual([
      { type: 'reasoning', text: 'ab' },
      { type: 'text', text: 'ab' },
      { type: 'text', text: 'ab' },
    ])
  })

  it('keeps legitimate near-repetition unchanged', () => {
    expect(collapseDegenerateRepetition([
      { type: 'reasoning', text: 'x' },
      { type: 'text', text: 'ababac' },
    ])).toEqual([
      { type: 'reasoning', text: 'x' },
      { type: 'text', text: 'ababac' },
    ])
    expect(collapseDegenerateRepetition([{ type: 'text', text: 'abcabcab' }]))
      .toEqual([{ type: 'text', text: 'abcabcab' }])
  })

  it('passes reasoning, tool-call, and tool-addition blocks through by reference', () => {
    const reasoning: ContentBlock = { type: 'reasoning', text: 'abababab' }
    const call: ContentBlock = { type: 'tool-call', id: ToolCallId('call-1'), name: 'echo', arguments: '{}' }
    const addition: ContentBlock = { type: 'tool-addition', toolName: 'search' }
    const collapsed = collapseDegenerateRepetition([reasoning, call, addition])
    expect(collapsed[0]).toBe(reasoning)
    expect(collapsed[1]).toBe(call)
    expect(collapsed[2]).toBe(addition)
  })

  it('leaves empty and whitespace-only text untouched', () => {
    const empty: ContentBlock = { type: 'text', text: '' }
    const blank: ContentBlock = { type: 'text', text: '   ' }
    const collapsed = collapseDegenerateRepetition([empty, blank])
    expect(collapsed[0]).toBe(empty)
    expect(collapsed[1]).toBe(blank)
  })

  it('collapses every text block against the concatenated reasoning text', () => {
    expect(collapseDegenerateRepetition([
      { type: 'reasoning', text: 'a' },
      { type: 'reasoning', text: 'b' },
      { type: 'text', text: 'abab' },
      { type: 'text', text: 'abababababab' },
      { type: 'tool-call', id: ToolCallId('call-1'), name: 'echo', arguments: '{}' },
    ])).toEqual([
      { type: 'reasoning', text: 'a' },
      { type: 'reasoning', text: 'b' },
      { type: 'text', text: 'ab' },
      { type: 'text', text: 'ab' },
      { type: 'tool-call', id: ToolCallId('call-1'), name: 'echo', arguments: '{}' },
    ])
  })

  it('keeps one verbatim copy of a reducible reasoning text', () => {
    expect(collapseDegenerateRepetition([
      { type: 'reasoning', text: 'abab' },
      { type: 'text', text: 'abab' },
    ])).toEqual([
      { type: 'reasoning', text: 'abab' },
      { type: 'text', text: 'abab' },
    ])
  })

  it('prefers the reasoning match over self-collapse', () => {
    expect(collapseDegenerateRepetition([
      { type: 'reasoning', text: 'abab' },
      { type: 'text', text: 'abababab' },
    ])).toEqual([
      { type: 'reasoning', text: 'abab' },
      { type: 'text', text: 'abab' },
    ])
  })
})

describe('collapseDegenerateRepetition idempotence', () => {
  const cases: readonly ContentBlock[][] = [
    [{ type: 'reasoning', text: 'abab' }, { type: 'text', text: 'abababab' }],
    [{ type: 'reasoning', text: 'thinking…' }, { type: 'text', text: 'thinking…thinking…' }],
    [{ type: 'text', text: 'abababab' }],
    [{ type: 'reasoning', text: 'abab' }, { type: 'text', text: 'abab' }],
    [{ type: 'reasoning', text: 'x' }, { type: 'text', text: 'ababac' }],
    [{ type: 'text', text: 'hello world' }],
    [{ type: 'text', text: '---' }],
    [{ type: 'reasoning', text: '-' }, { type: 'text', text: '----' }],
  ]

  it('collapsing an already-collapsed list never shrinks it further', () => {
    for (const blocks of cases) {
      expect(collapseDegenerateRepetition(collapseDegenerateRepetition(blocks)))
        .toEqual(collapseDegenerateRepetition(blocks))
    }
  })

  it('keeps the reasoning-copy result verbatim instead of self-collapsing it', () => {
    // Reasoning "abab" with text "abababab" collapses to "abab", and re-running
    // the collapse must not shrink that kept copy to its own minimal unit "ab".
    const collapsed = collapseDegenerateRepetition([
      { type: 'reasoning', text: 'abab' },
      { type: 'text', text: 'abababab' },
    ])
    expect(collapsed[1]).toEqual({ type: 'text', text: 'abab' })
    expect(collapseDegenerateRepetition(collapsed)[1]).toEqual({ type: 'text', text: 'abab' })
  })
})

describe('BlockAssembler degenerate repetition collapse', () => {
  it('blocks() and message() commit collapsed content', () => {
    const assembler = new BlockAssembler()
    assembler.push({ type: 'block-start', index: 0, blockType: 'reasoning' })
    assembler.push({ type: 'reasoning-delta', index: 0, text: 'plan' })
    assembler.push({ type: 'block-end', index: 0, block: { type: 'reasoning', text: 'plan' } })
    assembler.push({ type: 'block-start', index: 1, blockType: 'text' })
    assembler.push({ type: 'text-delta', index: 1, text: 'planplanplanplan' })
    assembler.push({ type: 'block-end', index: 1, block: { type: 'text', text: 'planplanplanplan' } })

    expect(assembler.blocks()).toEqual([
      { type: 'reasoning', text: 'plan' },
      { type: 'text', text: 'plan' },
    ])
    expect(assembler.message({ provider: 'mock', model: 'mock' }).content).toEqual([
      { type: 'reasoning', text: 'plan' },
      { type: 'text', text: 'plan' },
    ])
  })

  it('interruptedBlocks() commits collapsed content', () => {
    const assembler = new BlockAssembler()
    assembler.push({ type: 'reasoning-delta', index: 0, text: 'abab' })
    assembler.push({ type: 'text-delta', index: 1, text: 'abababab' })
    expect(assembler.interruptedBlocks()).toEqual([
      { type: 'reasoning', text: 'abab' },
      { type: 'text', text: 'abab' },
    ])
  })

  it('keeps per-block replay metadata aligned across the collapse', () => {
    const assembler = new BlockAssembler()
    assembler.push({ type: 'block-end', index: 0, block: { type: 'reasoning', text: 'plan' } })
    assembler.push({ type: 'block-end', index: 1, block: { type: 'text', text: 'planplanplanplan' } })
    const replayState = { response: { responseId: 'resp-1' }, blocks: ['meta-0', 'meta-1'] }
    assembler.push({ type: 'finish', reason: { kind: 'stop' }, replayState })

    expect(assembler.blocks().map(block => block.type)).toEqual(['reasoning', 'text'])
    expect(assembler.replayState).toEqual(replayState)
  })
})
