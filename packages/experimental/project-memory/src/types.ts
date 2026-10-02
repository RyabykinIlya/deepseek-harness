/**
 * Types of the Project memory service.
 * @module @deepseek-ai/dsh-experimental-project-memory
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** Identity of a Project: the id of its coordinator Session. */
export type ProjectId = Branded<'ProjectId'>

/** Identity of one memory entry, unique across all Projects. */
export type MemoryEntryId = Branded<'MemoryEntryId'>

/** Who wrote an entry: the Project Session, a Thread, or a person through a client. */
export type MemoryAuthor = 'coordinator' | 'thread' | 'user'

/** One durable memory entry. */
export interface MemoryEntry {
  /** Entry identity the model passes back to update or remove it. */
  readonly id: MemoryEntryId
  /** Project the entry belongs to. */
  readonly projectId: ProjectId
  /** Entry text, trimmed and at most `maxEntryChars` code points. */
  readonly text: string
  /** Role of the last writer. */
  readonly author: MemoryAuthor
  /** Session of the last writer, when a Session wrote it. */
  readonly authorSessionId?: SessionId | undefined
  /** Creation time, Unix epoch milliseconds. */
  readonly createdAt: number
  /** Last write time, Unix epoch milliseconds. */
  readonly updatedAt: number
}

/** Stable failure kinds of `ProjectMemoryError`. */
export type ProjectMemoryErrorCode =
  | 'not-in-project'
  | 'lineage-too-deep'
  | 'lineage-unavailable'
  | 'not-found'
  | 'empty-text'
  | 'text-too-long'
  | 'entry-limit'

/** Remote request that reads one Project's entries. */
export interface ProjectMemoryListRequest {
  /** Project whose entries are read. */
  readonly projectId: ProjectId
}

/** Remote request that adds an entry as a user. */
export interface ProjectMemoryAddRequest {
  /** Project receiving the entry. */
  readonly projectId: ProjectId
  /** Entry text. */
  readonly text: string
}

/** Remote request that rewrites an entry as a user. */
export interface ProjectMemoryUpdateRequest {
  /** Project owning the entry. */
  readonly projectId: ProjectId
  /** Entry to rewrite. */
  readonly id: MemoryEntryId
  /** Replacement text. */
  readonly text: string
}

/** Remote request that deletes an entry. */
export interface ProjectMemoryRemoveRequest {
  /** Project owning the entry. */
  readonly projectId: ProjectId
  /** Entry to delete. */
  readonly id: MemoryEntryId
}
