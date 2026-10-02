/**
 * Durable storage declaration for Project memory entries.
 * @module @deepseek-ai/dsh-experimental-project-memory
 */

import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { MemoryEntry, MemoryEntryId, ProjectId } from './types.ts'

const timestamp = z.number().int().nonnegative()

/** Stored entry validation; a malformed row rejects opening the domain. */
export const memoryEntrySchema = z.object({
  id: z.string().min(1).transform(value => brandString<MemoryEntryId>(value)),
  projectId: z.string().min(1).transform(value => brandString<ProjectId>(value)),
  text: z.string().min(1),
  author: z.enum(['coordinator', 'thread', 'user']),
  authorSessionId: z.string().min(1).transform(SessionId).optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict()

/** Authoritative storage for Project memory; one table of entries keyed by entry id. */
export const projectMemoryDomain = defineDomain({
  name: 'project_memory',
  version: 1,
  tables: { entries: domainTable<MemoryEntryId, MemoryEntry>(memoryEntrySchema) },
})
