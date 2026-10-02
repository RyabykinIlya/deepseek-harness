/**
 * Roster sources: the delegation catalog projected into Thread rows, and the
 * merge with the `threads` projection rows.
 */
import { describe, expect, it } from 'vitest'
import { catalogRows, mergeRosterRows, withLiveness } from '../src/client/roster.ts'
import type { ThreadStatusRow } from '@deepseek-ai/dsh-experimental-threads/types'
import { fake } from './support.client.ts'
import { SessionId } from '@deepseek-ai/dsh-session/types'

/** One Thread row with only the fields a test cares about. */
function row(over: Partial<Omit<ThreadStatusRow, 'threadId'>> & { threadId: string }): ThreadStatusRow {
  const { threadId, ...rest } = over
  return { threadId: threadId as ThreadStatusRow['threadId'], label: '', ...rest }
}

/** One delegation catalog entry, with the branded id the projection declares. */
type CatalogEntry = NonNullable<Parameters<typeof catalogRows>[0]>[number]
function entry(over: { id?: string; mode?: CatalogEntry['mode']; label?: string | undefined } = {}): CatalogEntry {
  const { id = 'child-1', mode = 'continuable' } = over
  const label = 'label' in over ? over.label : 'work'
  // A continuable child whose creation label was not read back violates the declared type on purpose.
  if (label === undefined) return fake<CatalogEntry>({ id: SessionId(id), createdAt: 0, mode })
  return { id: SessionId(id), createdAt: 0, mode, label }
}

describe('catalogRows', () => {
  it('projects every continuable child into a row', () => {
    const rows = catalogRows([entry({ id: 'a', label: 'first' }), entry({ id: 'b', label: 'second' })])
    expect(rows.map(r => r.threadId)).toEqual(['a', 'b'])
    expect(rows.map(r => r.label)).toEqual(['first', 'second'])
  })

  it('skips a one-shot child, which is not a Thread', () => {
    expect(catalogRows([entry({ id: 'a' }), entry({ id: 'b', mode: 'one-shot' })])
      .map(r => r.threadId)).toEqual(['a'])
  })

  it('falls back to the child id when the creation label was not read back', () => {
    const [only] = catalogRows([entry({ id: 'a', label: undefined })])
    expect(only?.label).toBe('a')
  })

  it('treats an absent catalog as no Threads rather than throwing', () => {
    expect(catalogRows(undefined)).toEqual([])
  })
})

describe('withLiveness', () => {
  it('reads liveness from the caller, because durable rows carry none', () => {
    const rows = withLiveness([row({ threadId: 'a' }), row({ threadId: 'b' })], id => id === 'b')
    expect(rows.map(r => r.running)).toEqual([false, true])
  })

  it('keeps every durable field and the row order', () => {
    const [only] = withLiveness([row({ threadId: 'a', branch: 'dsh/a', stopReason: 'refusal' })], () => false)
    expect(only).toMatchObject({ threadId: 'a', branch: 'dsh/a', stopReason: 'refusal', running: false })
  })
})

describe('mergeRosterRows', () => {
  it('keeps catalog rows that no Thread row describes', () => {
    const merged = mergeRosterRows([row({ threadId: 'a' })], [])
    expect(merged.map(r => r.threadId)).toEqual(['a'])
  })

  it('keeps Thread rows that the catalog never named', () => {
    // The regression this guards: merging over an empty base dropped every
    // richer row, which made the roster empty in a live Project.
    const merged = mergeRosterRows([], [row({ threadId: 'a', stopReason: 'completed' })])
    expect(merged.map(r => r.threadId)).toEqual(['a'])
    expect(merged[0]?.stopReason).toBe('completed')
  })

  it('lets the richer row win for a child both sources name, without doubling it', () => {
    const merged = mergeRosterRows(
      [row({ threadId: 'a', label: 'from catalog' }), row({ threadId: 'b', label: 'only catalog' })],
      [row({ threadId: 'a', label: 'from threads', branch: 'dsh/thread-a' })],
    )
    expect(merged).toHaveLength(2)
    expect(merged[0]).toMatchObject({ threadId: 'a', label: 'from threads', branch: 'dsh/thread-a' })
    expect(merged[1]).toMatchObject({ threadId: 'b', label: 'only catalog' })
  })

  it('appends a Thread row the catalog did not name after the catalog order', () => {
    const merged = mergeRosterRows([row({ threadId: 'a' })], [row({ threadId: 'z' })])
    expect(merged.map(r => r.threadId)).toEqual(['a', 'z'])
  })
})
