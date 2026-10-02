/** UTF-8 byte helpers shared by the Thread tools' result bounds. @module */

/**
 * UTF-8 byte length of a string.
 * @param text - the string to measure.
 * @returns its encoded size in bytes.
 */
export function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/**
 * Cut a string to at most `maxBytes` UTF-8 bytes without splitting a code point.
 * @param text - the string to cut.
 * @param maxBytes - inclusive byte budget.
 * @returns `text` itself when it fits, otherwise its longest whole-code-point prefix within the budget.
 */
export function truncateUtf8(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= maxBytes) return text
  // A byte budget lands wherever it lands, possibly inside a code point. Walking
  // whole code points forward and stopping at the first one that would cross the
  // budget keeps the longest prefix that decodes cleanly, with no out-of-range
  // probe: `end` only ever advances by a code point this loop has measured.
  let end = 0
  for (const char of text) {
    const next = end + byteLength(char)
    if (next > maxBytes) break
    end = next
  }
  return bytes.subarray(0, end).toString('utf8')
}

/**
 * Collapse whitespace so free text occupies one rendered line, then cap it.
 * @param text - free text such as a label or closing message.
 * @param maxBytes - byte budget including the trailing ellipsis.
 * @returns the single-line text, ending in an ellipsis when it was cut.
 */
export function oneLine(text: string, maxBytes: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (byteLength(flat) <= maxBytes) return flat
  return `${truncateUtf8(flat, maxBytes - 3)}…`
}

/**
 * A count with its English noun, singular for exactly one.
 * @param n - the count.
 * @param singular - the noun for one item.
 * @param plural - the noun for any other count.
 * @returns for example `1 commit` or `3 commits`.
 */
export function count(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`
}
