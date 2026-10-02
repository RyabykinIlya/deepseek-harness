/**
 * Host-side shared memory for a Project.
 *
 * A Project's Threads run in separate worktrees whose sandboxes only allow
 * writing inside their own worktree, so memory they share lives in Host
 * storage instead of a file. Tools reach it through {@link ProjectMemoryService.resolveProject};
 * a browser panel reaches it through the Remote methods.
 * @module @deepseek-ai/dsh-experimental-project-memory
 */

import { randomUUID } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Session, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { ProjectMemoryError } from './errors.ts'
import { projectMemoryDomain } from './storage.ts'
import type {
  MemoryAuthor, MemoryEntry, MemoryEntryId, ProjectId, ProjectMemoryAddRequest, ProjectMemoryErrorCode,
  ProjectMemoryListRequest, ProjectMemoryRemoveRequest, ProjectMemoryUpdateRequest,
} from './types.ts'

export type * from './types.ts'
export { ProjectMemoryError } from './errors.ts'
export { projectMemoryDomain } from './storage.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Durable per-Project shared memory. */
    projectMemory: ProjectMemoryService
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The memory service refused the request; `reason` is the stable failure kind. */
    'project-memory/refused': { readonly reason: ProjectMemoryErrorCode }
  }
}

/** Configuration of the Project memory service. */
export interface Config {
  /** Entries kept per Project; adding beyond it fails until one is removed. */
  maxEntries?: number
  /** Longest entry text in Unicode code points. */
  maxEntryChars?: number
  /** Agent preset ids whose Sessions are Project coordinators. */
  projectPresets?: string[]
  /** Parent hops followed from a calling Session while looking for its Project. */
  maxLineageDepth?: number
}

/** Count Unicode code points, so one emoji counts once. */
function codePoints(text: string): number {
  let count = 0
  for (const _ of text) count++
  return count
}

/** Convert a refusal to the Remote failure carrying the same message. */
function toRemote(error: unknown): unknown {
  return error instanceof ProjectMemoryError
    ? new RemoteError('project-memory/refused', error.message, { reason: error.code })
    : error
}

/**
 * Shared per-Project memory over the `project_memory` storage domain.
 *
 * Every mutation is serialized, so the per-Project entry cap holds under
 * concurrent writers. Reads return the in-memory view of durable state.
 */
export class ProjectMemoryService extends TypertRemoteService {
  static inject = ['storageDomain', 'sessions']

  static Config: z<Config> = z.object({
    maxEntries: z.number().step(1).min(1).max(10_000).default(200),
    maxEntryChars: z.number().step(1).min(1).max(100_000).default(500),
    projectPresets: z.array(z.string()).default(['project']),
    maxLineageDepth: z.number().step(1).min(0).max(32).default(4),
  })

  private readonly maxEntries: number
  private readonly maxEntryChars: number
  private readonly projectPresets: ReadonlySet<string>
  private readonly maxLineageDepth: number
  private readonly initialized: Promise<Domain<typeof projectMemoryDomain>>
  private chain: Promise<unknown> = Promise.resolve()

  /**
   * @param ctx - Host services providing storage domains and live Sessions.
   * @param config - Validated limits and Project preset ids.
   */
  constructor(private readonly host: Context, config: Config) {
    super(host, 'projectMemory')
    this.maxEntries = config.maxEntries ?? 200
    this.maxEntryChars = config.maxEntryChars ?? 500
    this.projectPresets = new Set(config.projectPresets ?? ['project'])
    this.maxLineageDepth = config.maxLineageDepth ?? 4
    this.initialized = host.storageDomain.open(projectMemoryDomain)
    // A rejected open surfaces through Service.init; the guard stops an unhandled rejection before then.
    this.initialized.catch(() => undefined)
    host.effect(() => async () => {
      await this.chain
      // An open that failed left nothing to close; its error already reached Service.init.
      const domain = await this.initialized.catch(() => undefined)
      await domain?.close()
    })
  }

  /** Wait for the storage domain; the domain closes with the plugin. */
  async [Service.init](): Promise<void> {
    await this.domain()
  }

  private async domain(): Promise<Domain<typeof projectMemoryDomain>> {
    return await this.initialized
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work)
    this.chain = next.catch(() => undefined)
    return next
  }

  /**
   * Read a Project's entries.
   * @param projectId - Project whose memory is read.
   * @returns Entries newest first by last write; equal times keep later insertions first.
   */
  async list(projectId: ProjectId): Promise<MemoryEntry[]> {
    const domain = await this.domain()
    return [...domain.table('entries').entries()]
      .map(([, entry]) => entry)
      .filter(entry => entry.projectId === projectId)
      .reverse()
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  private checkText(raw: string): string {
    const text = raw.trim()
    if (text.length === 0) {
      throw new ProjectMemoryError('empty-text', 'The memory text is empty. Write one self-contained fact or decision.')
    }
    const length = codePoints(text)
    if (length > this.maxEntryChars) {
      throw new ProjectMemoryError('text-too-long',
        `The memory text is ${length} characters; the limit is ${this.maxEntryChars}. Shorten it or split it into separate entries.`)
    }
    return text
  }

  private notFound(id: MemoryEntryId): ProjectMemoryError {
    return new ProjectMemoryError('not-found',
      `No memory entry "${id}" exists in this Project. Call memory_read to see the current ids.`)
  }

  /**
   * Add an entry.
   * @param projectId - Project receiving the entry.
   * @param text - Entry text; trimmed and bounded by `maxEntryChars`.
   * @param author - Role of the writer.
   * @param authorSessionId - Writing Session, when a Session wrote it.
   * @returns The stored entry.
   * @throws ProjectMemoryError for empty or oversized text, or when the Project holds `maxEntries`.
   */
  add(projectId: ProjectId, text: string, author: MemoryAuthor, authorSessionId?: SessionId): Promise<MemoryEntry> {
    return this.serialize(async () => {
      const clean = this.checkText(text)
      const table = (await this.domain()).table('entries')
      const held = [...table.entries()].filter(([, entry]) => entry.projectId === projectId).length
      if (held >= this.maxEntries) {
        throw new ProjectMemoryError('entry-limit',
          `This Project already holds ${this.maxEntries} memory entries. Remove or merge outdated entries with memory_write before adding more.`)
      }
      let id = brandString<MemoryEntryId>(`m${randomUUID().slice(0, 8)}`)
      while (table.get(id) !== undefined) id = brandString<MemoryEntryId>(`m${randomUUID().slice(0, 8)}`)
      const now = Date.now()
      const entry: MemoryEntry = {
        id, projectId, text: clean, author,
        ...authorSessionId === undefined ? {} : { authorSessionId },
        createdAt: now, updatedAt: now,
      }
      await table.put(id, entry)
      return entry
    })
  }

  /**
   * Rewrite an entry; the writer becomes the entry's author.
   * @param projectId - Project that must own the entry.
   * @param id - Entry to rewrite.
   * @param text - Replacement text.
   * @param author - Role of the writer.
   * @param authorSessionId - Writing Session, when a Session wrote it.
   * @returns The stored entry.
   * @throws ProjectMemoryError when the entry is absent from the Project or the text is invalid.
   */
  update(
    projectId: ProjectId, id: MemoryEntryId, text: string, author: MemoryAuthor, authorSessionId?: SessionId,
  ): Promise<MemoryEntry> {
    return this.serialize(async () => {
      const clean = this.checkText(text)
      const table = (await this.domain()).table('entries')
      const current = table.get(id)
      if (current === undefined || current.projectId !== projectId) throw this.notFound(id)
      const { authorSessionId: _previous, ...rest } = current
      const entry: MemoryEntry = {
        ...rest, text: clean, author,
        ...authorSessionId === undefined ? {} : { authorSessionId },
        updatedAt: Math.max(Date.now(), current.updatedAt),
      }
      await table.put(id, entry)
      return entry
    })
  }

  /**
   * Delete an entry.
   * @param projectId - Project that must own the entry.
   * @param id - Entry to delete.
   * @throws ProjectMemoryError when the entry is absent from the Project.
   */
  remove(projectId: ProjectId, id: MemoryEntryId): Promise<void> {
    return this.serialize(async () => {
      const table = (await this.domain()).table('entries')
      const current = table.get(id)
      if (current === undefined || current.projectId !== projectId) throw this.notFound(id)
      await table.delete(id)
    })
  }

  /**
   * Find the Project a calling Session belongs to.
   *
   * The Session itself is the Project when its preset is configured in
   * `projectPresets`; otherwise its `parentSession` chain is followed for at most
   * `maxLineageDepth` hops. Each ancestor is read from its live Session when loaded,
   * otherwise from its persisted header; without a `sessionPersistence` service only
   * live Sessions are consulted.
   * @param session - Calling Session.
   * @returns The Project id.
   * @throws ProjectMemoryError when no Project is found within the bound or an ancestor is neither live nor persisted.
   */
  async resolveProject(session: Session): Promise<ProjectId> {
    let current: Pick<SessionHeader, 'id' | 'agentPreset' | 'parentSession'> = session.header
    for (let hops = 0; ; hops++) {
      const preset = current.agentPreset
      if (preset !== undefined && this.projectPresets.has(preset)) return brandString<ProjectId>(current.id)
      const parent = current.parentSession
      if (parent === undefined) {
        throw new ProjectMemoryError('not-in-project',
          'This session is not part of a Project, so it has no shared memory. Keep notes in your own reply instead.')
      }
      if (hops >= this.maxLineageDepth) {
        throw new ProjectMemoryError('lineage-too-deep',
          `This session is not part of a Project within ${this.maxLineageDepth} levels of delegation, so it has no shared memory.`)
      }
      const next = this.host.sessions.get(parent)?.header ?? (await this.host.get('sessionPersistence')?.stat(parent))?.header
      if (next === undefined) {
        throw new ProjectMemoryError('lineage-unavailable',
          `This session is not part of a loaded Project: its parent session "${parent}" does not exist. Ask the user to reopen the Project.`)
      }
      current = next
    }
  }

  /**
   * Remote read for a client panel.
   * @param request - Project to read.
   * @returns Entries newest first.
   */
  @Remote('list')
  async remoteList(request: ProjectMemoryListRequest): Promise<MemoryEntry[]> {
    return await this.list(request.projectId)
  }

  /**
   * Remote add by a person.
   * @param request - Project and text.
   * @returns The stored entry.
   * @throws RemoteError `project-memory/refused` when the text or the entry cap is refused.
   */
  @Remote('add')
  async remoteAdd(request: ProjectMemoryAddRequest): Promise<MemoryEntry> {
    try { return await this.add(request.projectId, request.text, 'user') }
    catch (error) { throw toRemote(error) }
  }

  /**
   * Remote rewrite by a person.
   * @param request - Project, entry id, and replacement text.
   * @returns The stored entry.
   * @throws RemoteError `project-memory/refused` when the entry is absent or the text is refused.
   */
  @Remote('update')
  async remoteUpdate(request: ProjectMemoryUpdateRequest): Promise<MemoryEntry> {
    try { return await this.update(request.projectId, request.id, request.text, 'user') }
    catch (error) { throw toRemote(error) }
  }

  /**
   * Remote deletion by a person.
   *
   * Named `delete` on the wire, not `remove`: the client's Remote namespace proxy
   * reserves `remove` for its own descriptor-unmount method
   * (`RemoteNamespaceService.prototype.remove`), so a namespace method of that
   * name fails to mount with "conflicts with its namespace service".
   * @param request - Project and entry id.
   * @throws RemoteError `project-memory/refused` when the entry is absent.
   */
  @Remote('delete')
  async remoteDelete(request: ProjectMemoryRemoveRequest): Promise<void> {
    try { await this.remove(request.projectId, request.id) }
    catch (error) { throw toRemote(error) }
  }
}

export default ProjectMemoryService
