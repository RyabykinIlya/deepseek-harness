/** Bounded Thread note text derived from a closing assistant message. */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'

const ELLIPSIS = '…'
const encoder = new TextEncoder()

/**
 * Render a Thread's closing message as one bounded line.
 *
 * Text blocks are joined, every whitespace run collapses to one space, and the
 * result is cut at a code-point boundary so its UTF-8 size never exceeds the
 * limit; a cut result ends with an ellipsis that counts toward the limit.
 * @param content - the child's final assistant content blocks.
 * @param maxBytes - maximum UTF-8 size of the returned note.
 * @returns the note, or `undefined` when the message has no text.
 */
export function threadNote(content: readonly ContentBlock[], maxBytes: number): string | undefined {
  const text = content
    .flatMap(block => block.type === 'text' ? [block.text] : [])
    .join(' ')
    .replace(/\s+/gu, ' ')
    .trim()
  if (text.length === 0) return undefined
  if (encoder.encode(text).length <= maxBytes) return text
  const budget = maxBytes - encoder.encode(ELLIPSIS).length
  if (budget < 0) return undefined
  let used = 0
  let kept = ''
  for (const char of text) {
    const size = encoder.encode(char).length
    if (used + size > budget) break
    used += size
    kept += char
  }
  return `${kept.trimEnd()}${ELLIPSIS}`
}
