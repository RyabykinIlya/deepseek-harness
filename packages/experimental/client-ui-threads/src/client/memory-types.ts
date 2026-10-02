/**
 * Project memory value types the browser half reads off the `projectMemory`
 * Remote namespace. They restate the fields the panel uses rather than importing
 * the service's types, whose module also declares Host session services that
 * must not enter this browser program; the brands are the service's own, so the
 * ids pass back to the Remote unchanged.
 */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Identity of a Project: the id of its coordinator Session. */
export type ProjectId = Branded<'ProjectId'>

/** Identity of one memory entry. */
export type MemoryEntryId = Branded<'MemoryEntryId'>

/** Who wrote an entry. */
export type MemoryAuthor = 'coordinator' | 'thread' | 'user'

/** One memory entry, as far as the panel reads it. */
export interface MemoryEntry {
  /** Entry identity. */
  readonly id: MemoryEntryId
  /** Entry text. */
  readonly text: string
  /** Role of the last writer. */
  readonly author: MemoryAuthor
  /** Creation time, Unix epoch milliseconds. */
  readonly createdAt: number
  /** Last write time, Unix epoch milliseconds. */
  readonly updatedAt: number
}
