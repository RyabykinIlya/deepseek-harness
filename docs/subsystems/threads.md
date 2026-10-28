# Threads and Projects

English | [中文](threads.zh.md)

Types for Projects, background Threads, their git worktrees, and Project memory. A Project is a Session composed from agent preset `project` (the coordinator). A Thread is a continuable child created by subagent provider `thread` (package `@deepseek-ai/dsh-subagent-thread-worktree`); it runs in its own git worktree on its own branch and is composed from agent preset `project-thread` (the worker). This page records the durable and client-visible forms from [`worktree-manager`](../../packages/subagent/worktree-manager/src/types.ts), [`threads`](../../packages/experimental/threads/src/types.ts), and [`project-memory`](../../packages/experimental/project-memory/src/types.ts). The package READMEs own operation details: [worktree-manager](../../packages/subagent/worktree-manager/README.md), [subagent-thread-worktree](../../packages/subagent/subagent-thread-worktree/README.md), [threads](../../packages/experimental/threads/README.md), [tool-threads](../../packages/experimental/tool-threads/README.md), [threads-preset](../../packages/experimental/threads-preset/README.md), [threads-profile](../../packages/experimental/threads-profile/README.md), and [project-memory](../../packages/experimental/project-memory/README.md).

## Worktrees

`ctx.worktrees` gives every Thread its own git worktree. The service writes one append-only transition per operation to a sidecar log under `worktreeRoot`; `WorktreeRecord` is the fold of that log, where the last transition for a Thread wins.

```ts type-equiv
/** One durable worktree intent, as folded from the sidecar log. */
interface WorktreeRecord {
  /** The Thread this worktree belongs to. */
  readonly threadId: string
  /** Absolute path of the worktree on disk (the future session cwd). */
  readonly path: string
  /** Created branch, or `undefined` for a detached worktree. */
  readonly branch?: string
  /**
   * The ref this worktree was created from — the ref the REQUEST named. Under
   * {@link WorktreeBasePolicy `'head-with-uncommitted'`} it is not the commit the Thread started
   * at; {@link WorktreeRecord.baseSha} is.
   */
  readonly baseRef: string
  /**
   * The policy that produced {@link WorktreeRecord.baseSha}. Absent only on records written before
   * the field existed, which are read as plain `head` behaviour.
   */
  readonly base?: WorktreeBasePolicy
  /**
   * Commit the worktree was created at, resolved from `baseRef` (or, under
   * `base: 'head-with-uncommitted'`, the working-state snapshot) when creation succeeded.
   * Absent on records written before the field existed and on `reserved` records.
   */
  readonly baseSha?: string
  /** Epoch milliseconds when the `reserved` intent was written; absent on records written before the field existed. */
  readonly createdAt?: number
  /** Current lifecycle state; see {@link WorktreeState}. */
  readonly state: WorktreeState
  /**
   * Absolute top level of the owning git repository. Carried on the record (rather than
   * re-derived) so {@link WorktreeService.list} and {@link WorktreeService.remove} can act
   * on a record the caller kept from an earlier session.
   */
  readonly repoRoot: string
}
```

A record is in one `WorktreeState`: `reserved` (intent written before the clone is created), `ready` (the only state a session cwd may be bound to), `rolled-back` (a failed or aborted creation was undone by deleting the half-created clone), `orphaned` (reconciliation found no live Session), `removing` (a failed removal left a tombstone), or `removed` (terminal). A fully removed Thread may be created again. `maxWorktreesPerRepo` bounds active (non-terminal) worktrees per repository; exceeding it throws `WORKTREE_LIMIT_REACHED` with the existing Thread ids.

`create` receives one `WorktreeSpec`:

```ts type-equiv
/** Input for {@link WorktreeService.create}: one Thread asking for its own working tree. */
interface WorktreeSpec {
  /** Absolute path inside the project checkout; resolved to the enclosing repository's top level. */
  readonly repoRoot: string
  /** Deterministic Thread key. Its {@link threadSlug} is the worktree directory name and the default branch suffix. */
  readonly threadId: string
  /**
   * Ref the new worktree is created from; always resolved and validated, so an
   * unusable base is refused under either policy.
   *
   * Under `base: 'head-with-uncommitted'` this names the ref the snapshot is *taken against* and
   * the fallback when the working tree is clean — the commit the Thread actually starts from is
   * then {@link WorktreeRecord.baseSha}, not this string.
   */
  readonly baseRef: string
  /**
   * Check out detached at the resolved base instead of creating a branch: the record then
   * carries no `branch` field at all, matching {@link WorktreeRecord.branch}. Mutually
   * exclusive with {@link WorktreeSpec.branch}; a spec carrying both is refused.
   */
  readonly detached?: boolean
  /**
   * Which base {@link WorktreeService.create} resolves. Defaults to the service's configured
   * `base`, which itself defaults to `'head'` — a spec that omits this field gets exactly the
   * behaviour that package shipped before the policy existed.
   */
  readonly base?: WorktreeBasePolicy
  /**
   * Branch to create alongside the worktree. Defaults to `dsh/thread-<threadSlug(threadId)>`.
   * The branch is a convenience handle, never the identity: removal is keyed on `(threadId, path)`.
   */
  readonly branch?: string
}
```

`status` and `changes` read live git state of one worktree:

```ts type-equiv
/** Result of {@link WorktreeService.status}. */
interface WorktreeStatus {
  /** True only when `git status --porcelain` reported nothing at all. */
  readonly clean: boolean
  /** Number of porcelain entries (staged, unstaged, and untracked paths combined). */
  readonly changed: number
  /** Commits on the worktree's HEAD since `baseSha` (the record's `baseRef` when `baseSha` is absent). */
  readonly commitsAhead: number
}
```

```ts type-equiv
/** Result of {@link WorktreeService.changes}: committed work since the base plus the uncommitted count. */
interface WorktreeChanges {
  /** Commit the comparison starts from. */
  readonly baseSha: string
  /** Current HEAD of the worktree. */
  readonly headSha: string
  /** Commits of `baseSha..HEAD`, newest first, at most `maxCommits`; subjects are cut to 200 characters. */
  readonly commits: readonly { readonly sha: string; readonly subject: string }[]
  /** Number of commits in `baseSha..HEAD`, including those not listed. */
  readonly commitsTotal: number
  /** Files changed by `baseSha..HEAD` without rename detection, at most `maxFiles`, in git order. */
  readonly files: readonly WorktreeFileChange[]
  /** Number of files changed by `baseSha..HEAD`, including those not listed. */
  readonly filesTotal: number
  /** Uncommitted porcelain entries (staged, unstaged, untracked). */
  readonly uncommitted: number
}
```

`mergeCheck` predicts whether a worktree's HEAD would merge cleanly into a target ref in the main checkout, without touching any ref, index, or working tree:

```ts type-equiv
/** Options of {@link WorktreeService.mergeCheck}. */
interface WorktreeMergeCheckOptions {
  /** Ref the worktree's HEAD would be merged into, resolved in the main checkout: `HEAD`, a branch, or a commit. */
  readonly target: string
}
```

```ts type-equiv
/**
 * Predicted result of merging a worktree's HEAD into a target ref, computed by
 * `git merge-tree --write-tree` without touching any checkout or ref.
 * `supported: false` means the installed git predates `merge-tree --write-tree` (git 2.38).
 */
type WorktreeMergeCheck =
  | { readonly supported: false }
  | {
    readonly supported: true
    /** Commit the target ref resolved to. */
    readonly targetSha: string
    /** Commit the worktree's HEAD resolved to. */
    readonly headSha: string
    /** Whether the merge would complete without conflicts. */
    readonly clean: boolean
    /** Repository-relative paths that would conflict, at most `maxConflicts`; empty when clean. */
    readonly conflicts: readonly string[]
    /** Number of conflicting paths, including those not listed. */
    readonly conflictsTotal: number
  }
```

`remove` refuses a dirty worktree with `REMOVE_DIRTY_WITHOUT_FORCE` unless `WorktreeRemoveOptions.force` is set. Removal imports the Thread's branch into the parent repository when it has one, then deletes the worktree directory; the branch itself is never deleted.

## Threads projection

`ctx.threads` folds the log-only `thread/created`, `thread/status`, and `thread/removed` events into the `threads` Session projection of the Project Session. All three are appended with `ignorable: true`, so a build without the plugin still opens the Project Session. `thread/status` is a field-wise partial update: an absent field leaves the recorded value untouched. `thread/removed` drops the row and keeps the branch and the Thread's Session.

`running` is computed live by `ThreadsService.isRunning` and is never stored in the row or the log.

```ts type-equiv
/**
 * One Thread status row published to clients through the `threads` Session
 * projection. Durable facts only: live "is a turn active" is computed from the
 * runtime (`ThreadsService.isRunning`) and is never part of the row.
 */
interface ThreadStatusRow {
  /** Durable Thread identity. */
  readonly threadId: ThreadId
  /** The task this Thread was given at spawn; freely renameable, never identity. */
  readonly label: string
  /** Outcome of the last finished turn; absent before the first one finishes. */
  readonly stopReason?: ThreadStopReason
  /** `dsh/<thread-short>` branch, absent for a detached worktree. */
  readonly branch?: string
  /** Absolute path of the Thread's working directory. */
  readonly worktree?: string
  /** Commit the worktree was created at. */
  readonly baseSha?: string
  /** Commits on the worktree's HEAD since {@link baseSha}, as last reported at settlement. */
  readonly commitsAhead?: number
  /** Uncommitted entries in the worktree, as last reported at settlement. */
  readonly uncommitted?: number
  /** Bounded start of the Thread's closing message. */
  readonly note?: string
}
```

`archive` checks that the Thread is in the `threads` projection, refuses a dirty worktree unless `ThreadArchiveOptions.force` is set, interrupts a running Thread and waits up to `archiveStopTimeoutMs`, removes the worktree, and appends `thread/removed`. Failures are Remote errors: `threads/not-found`, `threads/worktree-dirty` (nothing changed), and `threads/stop-timeout` (the worktree stays in place).

## Project memory

`ctx.projectMemory` stores short shared entries per Project in the `project_memory` Host storage domain, because Thread sandboxes cannot share a file. The Project id is the id of the coordinator Session; a Thread resolves it through its parent lineage. `maxEntries` bounds entries per Project and `maxEntryChars` bounds one entry's text. Entries are written by `memory_write` as `coordinator` or `thread`, and by clients as `user` through the Remote methods `list`, `add`, `update`, and `remove`. `memory_read` returns entries to the model.

```ts type-equiv
/** One durable memory entry. */
interface MemoryEntry {
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
```

## Library

`ctx.threads.library` is a read model of a Project's shared material: nothing is stored, every entry is derived from the Project's log and its Threads' worktrees at call time.

```ts type-equiv
/** Request of the `threads.library` Remote method. */
interface ThreadsLibraryRequest {
  /** The Project Session whose library is read. */
  readonly projectId: SessionId
}
```

```ts type-equiv
/** Read model of a Project's Library: nothing stored, everything derived from logs and worktrees at call time. */
interface ThreadsLibrary {
  /** Attachments sent in the Project chat, newest first. */
  readonly attachments: LibraryList<LibraryAttachment>
  /** Files presented by the Project and its Threads, newest first. */
  readonly presented: LibraryList<LibraryPresentedFile>
  /**
   * Changed files per Thread, newest Thread first. Only the newest `libraryMaxThreads` Threads are read;
   * `total` counts every Thread the Project created, and a read Thread without a live worktree or recorded summary is omitted from `items`.
   */
  readonly changes: LibraryList<LibraryThreadChanges>
}
```

A live Thread's changed files come from `ctx.worktrees.changes`; an archived Thread's come from its last recorded `workspace/changes` summary, held in Host memory only while its Session stays loaded. A Thread with neither is omitted from `changes.items`. Presented files open through the deliverables present-open route addressed by `sessionId`, `seq`, and `index`; a live Thread's changed files have no such route today.

## Write-only isolation

A Thread's sandbox confines writes to its worktree. Reads and the network stay open, and the object store is the worktree's own: a `git push` targets its `origin`, the parent repository's path outside the sandbox root, so the sandbox refuses it, and the worker contract forbids push in any session. There is no read fence.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxmodelrouting--modelroutingcontrol"></a>

### `ctx.modelRouting` — `ModelRoutingControl`

Host-side surface other plugins use; the plugin class implements it.

```ts cordis-catalog
/**
 * The tier names this deployment configured, in configuration order.
 * @returns every tier name, empty while the route is dormant.
 */
tierNames(): readonly string[]

/**
 * Switch a Thread to a tier from its next model request.
 * @param project - the Project Session (the caller), whose log receives `model-routing/tier-override`.
 * @param threadId - the Thread's child SessionId string.
 * @param tier - a configured tier name.
 * @throws Error `model-routing: unknown tier "<tier>"; configured tiers: <a, b>`.
 */
setThreadTier(project: Session, threadId: string, tier: string): void

/**
 * Choose, for one Session, whether an exhausted subscription source may be
 * replaced by an OpenRouter candidate.
 *
 * The choice is an event in that Session's own log, so it survives a Host
 * restart and a cold resume, and a Session that never chose keeps following
 * the deployment default.
 * @param session - the Session the choice belongs to.
 * @param enabled - true when an exhausted subscription may fall through to OpenRouter.
 */
setOpenRouterFallback(session: Session, enabled: boolean): void
```

Types: [Session](session.md)

Source: [`packages/experimental/model-routing/src/types.ts`](../../packages/experimental/model-routing/src/types.ts)

<a id="ctxprojectmemory--projectmemoryservice"></a>

### `ctx.projectMemory` — `ProjectMemoryService`

Shared per-Project memory over the `project_memory` storage domain.

Every mutation is serialized, so the per-Project entry cap holds under concurrent writers. Reads return the in-memory view of durable state.

```ts cordis-catalog
/**
 * Read a Project's entries.
 * @param projectId - Project whose memory is read.
 * @returns Entries newest first by last write; equal times keep later insertions first.
 */
async list(projectId: ProjectId): Promise<MemoryEntry[]>

/**
 * Add an entry.
 * @param projectId - Project receiving the entry.
 * @param text - Entry text; trimmed and bounded by `maxEntryChars`.
 * @param author - Role of the writer.
 * @param authorSessionId - Writing Session, when a Session wrote it.
 * @returns The stored entry.
 * @throws ProjectMemoryError for empty or oversized text, or when the Project holds `maxEntries`.
 */
add(projectId: ProjectId, text: string, author: MemoryAuthor, authorSessionId?: SessionId): Promise<MemoryEntry>

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
update( projectId: ProjectId, id: MemoryEntryId, text: string, author: MemoryAuthor, authorSessionId?: SessionId, ): Promise<MemoryEntry>

/**
 * Delete an entry.
 * @param projectId - Project that must own the entry.
 * @param id - Entry to delete.
 * @throws ProjectMemoryError when the entry is absent from the Project.
 */
remove(projectId: ProjectId, id: MemoryEntryId): Promise<void>

/**
 * Find the Project a calling Session belongs to.
 *
 * The Session itself is the Project when its preset is configured in
 * `projectPresets`; otherwise its `parentSession` chain is followed for at most
 * `maxLineageDepth` hops. Each ancestor is read from its live Session when loaded,
 * otherwise from its persisted header; without a `sessionPersistence` service only
 * live Sessions are consulted.
 *
 * The preset read is the effective one, never the header alone: a Session created
 * under the default preset and switched to a Project preset before its first turn
 * still names the default in its frozen creation header.
 * @param session - Calling Session.
 * @returns The Project id.
 * @throws ProjectMemoryError when no Project is found within the bound or an ancestor is neither live nor persisted.
 */
async resolveProject(session: Session): Promise<ProjectId>

/**
 * Remote read for a client panel.
 * @param request - Project to read.
 * @returns Entries newest first.
 */
@Remote('list') async remoteList(request: ProjectMemoryListRequest): Promise<MemoryEntry[]>

/**
 * Remote add by a person.
 * @param request - Project and text.
 * @returns The stored entry.
 * @throws RemoteError `project-memory/refused` when the text or the entry cap is refused.
 */
@Remote('add') async remoteAdd(request: ProjectMemoryAddRequest): Promise<MemoryEntry>

/**
 * Remote rewrite by a person.
 * @param request - Project, entry id, and replacement text.
 * @returns The stored entry.
 * @throws RemoteError `project-memory/refused` when the entry is absent or the text is refused.
 */
@Remote('update') async remoteUpdate(request: ProjectMemoryUpdateRequest): Promise<MemoryEntry>

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
@Remote('delete') async remoteDelete(request: ProjectMemoryRemoveRequest): Promise<void>
```

Types: [Session](session.md) · [SessionId](core.md)

Source: [`packages/experimental/project-memory/src/index.ts`](../../packages/experimental/project-memory/src/index.ts)

<a id="ctxthreads--threadsservice"></a>

### `ctx.threads` — `ThreadsService`

`ctx.threads`: owner of the `threads` projection key, the Thread event writer, and Thread archival.

```ts cordis-catalog
/**
 * Read one Session's durable Thread state after materializing the unit at the
 * Session cursor. The returned value is live; callers must not mutate it.
 * @param session - the Project Session whose Threads state is read.
 * @returns the folded state, or `undefined` when the registry is absent.
 */
stateOf(session: Session): ThreadsProjectionState | undefined

/**
 * Read one Session's client-visible Thread rows at a single consistent cut.
 * @param session - the Project Session whose Thread rows are read.
 * @returns the status rows in durable creation order; empty when unavailable.
 */
viewOf(session: Session): ThreadStatusRow[]

/**
 * Live runtime liveness of one Thread: its Agent is registered and a driver
 * is active (a turn, or pre-step/close processing). Never persisted — the log
 * records outcomes, not liveness, so a Thread that died with its process reads
 * as not running after restart.
 * @param threadId - the Thread (its child Session id).
 * @returns whether the Thread's Agent is currently executing.
 */
isRunning(threadId: ThreadId): boolean

/**
 * Archive a Thread: stop it if it runs, remove its worktree, and record
 * `thread/removed`. The branch and the Thread's session are kept.
 *
 * A dirty worktree without `force` is refused before anything is stopped or
 * recorded. A worktree removal that fails after the Thread was interrupted
 * leaves the row in place so the call can be repeated.
 * @param agent - the Project agent whose projection owns the Thread.
 * @param threadId - the Thread to archive.
 * @param options - `force` discards uncommitted work.
 * @throws {RemoteError} `threads/not-found`, `threads/worktree-dirty`, or `threads/stop-timeout`.
 * @throws {Error} when the worktree service is not loaded.
 */
@Remote('archive') async archive(agent: Agent, threadId: ThreadId, options?: ThreadArchiveOptions): Promise<void>

/**
 * Read a Project's Library: the attachments sent in its chat, the files it and
 * its Threads presented, and the files each Thread changed. Nothing is stored;
 * every call derives the result from the Session logs and live worktrees.
 * Thread sessions are read from the live store first and persistence second;
 * a Thread whose session is in neither contributes no presented files.
 * @param request - the Project Session to read.
 * @returns the three bounded sections, see {@link ThreadsLibrary}.
 * @throws {RemoteError} `threads/project-not-found` when the id is unknown or its preset is not a Project preset.
 */
@Remote('library') async library(request: ThreadsLibraryRequest): Promise<ThreadsLibrary>
```

Types: [Agent](core.md) · [Session](session.md)

Source: [`packages/experimental/threads/src/index.ts`](../../packages/experimental/threads/src/index.ts)
<!-- END GENERATED cordis-surface -->
