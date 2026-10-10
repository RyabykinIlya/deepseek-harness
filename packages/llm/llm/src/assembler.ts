/**
 * Incremental chunk-to-message assembler. This is the single canonical assembly
 * algorithm used by the agent loop to build an assistant message from a chunk
 * stream while logging the raw chunks for replay fidelity.
 *
 * @module @deepseek-ai/dsh-llm/assembler
 */

import { brandString } from '@deepseek-ai/dsh-brand'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { ToolCallId } from './brand.ts'
import { createAssistantMessage } from './message.ts'
import type { AssistantMessage, ModelMessageSource } from './message.ts'
import type { ContentBlock, FinishReason, ReplayEnvelope, StreamChunk, TokenUsage } from './types.ts'

interface PartialBlock {
  blockType: string
  text: string
  toolCallId?: ToolCallId
  toolCallName?: string
  toolCallArguments: string
  /** Set by `block-end` — authoritative, and freezes the partial. */
  block?: ContentBlock
}

/**
 * Minimum repetition count that collapses degenerate text repetition.
 * A fixed assembly invariant, not a Config field: assembly semantics are
 * durable-log semantics shared by writer and verifier, so a
 * deployment-configurable threshold would break model-visible⟺logged
 * reconstruction and migration verification across builds.
 */
const DEGENERATE_REPEAT_MIN = 2

/**
 * Shortest minimal unit the self-repetition heuristic collapses.
 * A one-character unit is excluded because runs of a single character are
 * normally intentional formatting — a Markdown rule `---`, a table delimiter,
 * `***` — while degenerate repetition is long text. The reasoning match needs
 * no such floor: text mirroring the message's own reasoning is direct evidence
 * of the provider bug, not a heuristic.
 */
const MIN_SELF_REPEAT_UNIT = 2

/** Smallest non-empty prefix `u` of `text` with `text` equal to `u` repeated. */
function minimalTextUnit(text: string): string {
  for (let size = 1; size < text.length; size += 1) {
    if (text.length % size !== 0) continue
    const unit = text.slice(0, size)
    if (unit.repeat(text.length / size) === text) return unit
  }
  return text
}

/**
 * Collapse provider-generated degenerate text repetition into one copy.
 *
 * Providers occasionally stream a message's own reasoning text verbatim N times
 * before continuing with a valid tool call, and bill the full duplicated output.
 * For each `text` block with text `t` and `r` the concatenation of every
 * `reasoning` block's text in `blocks`: when `r` is non-empty and `t` equals `r`
 * repeated `j >= 1` times, `t` becomes `r` for `j >= 2` and stays verbatim for
 * `j = 1`; otherwise `t` collapses to its minimal non-empty unit when that unit
 * is at least two characters and repeats `k >= 2` times, and stays unchanged
 * when it does not. Detection
 * prefers the reasoning match, which keeps a verbatim single copy of even a
 * reducible reasoning text intact — text and reasoning mirror each other — and
 * makes the collapse idempotent: a collapsed result is never itself exact
 * repetition except that kept verbatim copy.
 *
 * Only `text` blocks change; reasoning, tool-call, image, file, and all other
 * blocks pass through by reference, as does empty or whitespace-only text.
 *
 * @param blocks - one message's content blocks.
 * @returns one block per input block, in the same order; degenerate `text`
 *   repetition replaced by one copy and every other block passed through
 *   unchanged.
 */
export function collapseDegenerateRepetition(blocks: readonly ContentBlock[]): ContentBlock[] {
  const reasoning = blocks.reduce(
    (text, block) => block.type === 'reasoning' ? text + block.text : text,
    '',
  )
  return blocks.map((block) => {
    if (block.type !== 'text' || block.text.trim() === '') return block
    const { text } = block
    if (reasoning !== '' && text.length % reasoning.length === 0
      && text === reasoning.repeat(text.length / reasoning.length)) {
      return text.length >= reasoning.length * DEGENERATE_REPEAT_MIN
        ? { type: 'text', text: reasoning }
        : block
    }
    const unit = minimalTextUnit(text)
    return unit.length >= MIN_SELF_REPEAT_UNIT && text.length >= unit.length * DEGENERATE_REPEAT_MIN
      ? { type: 'text', text: unit }
      : block
  })
}

/**
 * Incrementally assembles raw {@link StreamChunk}s into complete
 * {@link ContentBlock}s and a final assistant {@link Message}.
 *
 * The agent loop feeds it while logging raw chunks for replay fidelity, then
 * reads `blocks()` / `message()` / `usage` / `finish` once the stream ends,
 * or `interruptedBlocks()` when cancellation cut the stream short.
 *
 * Tolerant of delta-only protocols (no block-start/end); deltas arriving for
 * an index already closed by `block-end` are ignored (malformed stream) so a
 * misbehaving adapter cannot grow memory or corrupt a completed block.
 */
export class BlockAssembler {
  private partials = new Map<number, PartialBlock>()
  private order: number[] = []
  private _usage: TokenUsage | undefined
  private _finish: FinishReason | undefined
  private _replayState: ReplayEnvelope | undefined

  /**
   * Feed one chunk into the assembly state.
   * @param chunk - the next raw chunk, in stream order.
   */
  push(chunk: StreamChunk): void {
    switch (chunk.type) {
      case 'block-start': {
        if (!this.partials.has(chunk.index)) {
          this.order.push(chunk.index)
          this.partials.set(chunk.index, {
            blockType: chunk.blockType,
            text: '',
            toolCallArguments: '',
          })
        }
        return
      }
      case 'text-delta':
      case 'reasoning-delta': {
        const partial = this.ensure(chunk.index, chunk.type === 'text-delta' ? 'text' : 'reasoning')
        if (partial.block) return // closed by block-end; ignore stragglers
        partial.text += chunk.text
        return
      }
      case 'tool-call-delta': {
        const partial = this.ensure(chunk.index, 'tool-call')
        if (partial.block) return // closed by block-end; ignore stragglers
        partial.toolCallId = chunk.id
        if (chunk.name) partial.toolCallName = chunk.name
        partial.toolCallArguments += chunk.argumentsDelta
        return
      }
      case 'block-end': {
        const partial = this.ensure(chunk.index, chunk.block.type)
        // First close wins; ignoring re-close stragglers keeps streamed output
        // and the final assembled block in agreement.
        if (partial.block) return
        partial.block = chunk.block
        return
      }
      case 'usage': {
        this._usage = chunk.usage
        return
      }
      case 'finish': {
        this._finish = chunk.reason
        this._replayState = chunk.replayState
        return
      }
      default: return assertNever(chunk, 'BlockAssembler.push')
    }
  }

  private ensure(index: number, blockType: string): PartialBlock {
    let partial = this.partials.get(index)
    if (!partial) {
      partial = { blockType, text: '', toolCallArguments: '' }
      this.partials.set(index, partial)
      this.order.push(index)
    }
    return partial
  }

  private assemble(partial: PartialBlock, index: number): ContentBlock {
    if (partial.block) return partial.block
    switch (partial.blockType) {
      case 'text': return { type: 'text', text: partial.text }
      case 'reasoning': return { type: 'reasoning', text: partial.text }
      case 'tool-call': return {
        type: 'tool-call',
        id: partial.toolCallId ?? brandString<ToolCallId>(`call-${index}`),
        name: partial.toolCallName ?? '',
        arguments: partial.toolCallArguments,
      }
      default: throw new Error(`cannot assemble incomplete block of type "${partial.blockType}"`)
    }
  }

  /** Invariant accessor: every index in `order` has a partial. */
  private mustGet(index: number): PartialBlock {
    const partial = this.partials.get(index)
    if (!partial) throw new Error(`BlockAssembler invariant violated: no partial for index ${index}`)
    return partial
  }

  /**
   * The one shared keep/drop decision over all seen blocks: max-token
   * truncation drops tool calls that cannot be executed safely. Emitted blocks
   * and replay metadata both derive from this result, so they cannot disagree.
   */
  private assembled(): { blocks: ContentBlock[]; replay: ReplayEnvelope | undefined } {
    const all = this.order.map(index => this.assemble(this.mustGet(index), index))
    const kept = this.finish.kind === 'max-tokens'
      ? all.map(block => block.type !== 'tool-call')
      : undefined
    const blocks = collapseDegenerateRepetition(kept === undefined ? all : all.filter((_, position) => kept[position]))
    const envelope = this._replayState
    if (envelope?.blocks === undefined) return { blocks, replay: envelope }
    if (envelope.blocks.length !== all.length) return { blocks, replay: undefined }
    return {
      blocks,
      replay: kept === undefined || blocks.length === all.length
        ? envelope
        : { response: envelope.response, blocks: envelope.blocks.filter((_, position) => kept[position]) },
    }
  }

  /**
   * Assemble all blocks seen so far, in stream order.
   * @returns one block per seen index, except that max-token truncation drops
   *   tool calls that cannot be executed safely and
   *   {@link collapseDegenerateRepetition} shrinks degenerate text repetition;
   *   an open block assembles from its accumulated deltas (an unknown block
   *   type never closed by `block-end` throws).
   */
  blocks(): ContentBlock[] {
    return this.assembled().blocks
  }

  /**
   * Assemble the prefix an interrupted stream can safely finalize: closed and
   * open text/reasoning blocks with non-whitespace content, in stream order,
   * with degenerate text repetition collapsed as in {@link blocks}.
   * Tool calls are omitted because interruption precedes dispatch; retaining
   * one would require a fabricated result. Open unknown blocks are also omitted.
   * @returns the kept blocks; empty when nothing streamed before the interruption.
   */
  interruptedBlocks(): ContentBlock[] {
    return collapseDegenerateRepetition(this.order
      .map((index) => {
        const partial = this.mustGet(index)
        const type = partial.block?.type ?? partial.blockType
        if (type !== 'text' && type !== 'reasoning') return undefined
        return this.assemble(partial, index)
      })
      .filter((block): block is ContentBlock =>
        (block?.type === 'text' || block?.type === 'reasoning') && block.text.trim() !== ''))
  }

  /** Usage from the `usage` chunk; undefined until one arrives. */
  get usage(): TokenUsage | undefined {
    return this._usage
  }

  /** Finish reason from the `finish` chunk; `{kind: 'stop'}` when the stream ended without one. */
  get finish(): FinishReason {
    return this._finish ?? { kind: 'stop' }
  }

  /**
   * Replay metadata from the terminal finish chunk, if any, with per-block
   * entries pruned in step with {@link blocks}. Undefined when the envelope's
   * entries do not align with the emitted blocks.
   */
  get replayState(): ReplayEnvelope | undefined {
    return this.assembled().replay
  }

  /**
   * The assembled assistant message.
   * @param source - provider/model attribution (without the `kind` tag) for the assembled message.
   * @returns a frozen assistant-role message over `blocks()` (same open-block assembly rules).
   */
  message(source: Omit<ModelMessageSource, 'kind'>): AssistantMessage {
    return createAssistantMessage({ content: this.blocks(), source })
  }
}
