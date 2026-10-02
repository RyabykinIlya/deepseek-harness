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
  /** The ref this worktree was created from. */
  readonly baseRef: string
  /**
   * Commit the worktree was created at, resolved from `baseRef` when the add succeeded.
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

A record is in one `WorktreeState`: `reserved` (intent written before `git worktree add`), `ready` (the only state a session cwd may be bound to), `rolled-back` (a failed or aborted add was undone), `orphaned` (reconciliation found no live Session), `removing` (a failed `git worktree remove` left a tombstone), or `removed` (terminal). A fully removed Thread may be created again. `maxWorktreesPerRepo` bounds active (non-terminal) worktrees per repository; exceeding it throws `WORKTREE_LIMIT_REACHED` with the existing Thread ids.

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

`remove` refuses a dirty worktree with `REMOVE_DIRTY_WITHOUT_FORCE` unless `WorktreeRemoveOptions.force` is set. Removal deletes the worktree, not the branch.

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

A Thread's sandbox confines writes to its worktree. Reads, the network, and the shared git object store stay open, and `git push` remains possible. There is no read fence.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

<a id="ctxworktrees--worktreeservice"></a>

### `ctx.worktrees` — `WorktreeService`

The worktree service (`ctx.worktrees`).

One worktree per Thread, placed under a configured root that survives restarts. The service owns creation, the durable intent log, explicit removal, status, and the startup reconciliation sweep; it owns nothing about sessions, which the continuation manager keeps.

```ts cordis-catalog
/**
 * Create (or re-attach to) the worktree for one Thread.
 *
 * The call is idempotent by `threadId`: a second `create` for a Thread whose
 * worktree still exists returns the SAME record without a second `git worktree
 * add`. An abort is honored at every boundary — before any git process is
 * spawned, and again after the add resolves — and either way the reserved
 * intent is rolled back with `git worktree remove --force`.
 * Each call first runs {@link WorktreeService.reconcile}, so abandoned worktrees do not hold limit slots.
 * @param spec - the repository, Thread, base ref, and optional branch.
 * @param signal - aborts the attempt; the worktree is rolled back, never left half-created.
 * @returns the `ready` record whose `path` may be used as a session cwd.
 */
create(spec: WorktreeSpec, signal: AbortSignal): Promise<WorktreeRecord>

/**
 * Remove a Thread's worktree.
 *
 * Removal is explicit and never automatic: a settled Thread's worktree holds its
 * result, and deleting a turn's output silently is not acceptable. The order is
 * NOT the mirror of creation — the durable record goes to `removing` first, then
 * git, then `removed` — so a failed git removal leaves a `removing` tombstone a
 * later prune can finish, instead of claiming a deletion that never happened.
 * @param record - the record to remove (may come from an earlier session).
 * @param opts - `force` discards local modifications; without it a dirty worktree is refused.
 */
async remove(record: WorktreeRecord, opts: WorktreeRemoveOptions = {}): Promise<void>

/**
 * List the active worktrees of one repository.
 * @param repoRoot - any path inside the repository.
 * @returns records in a live state, ordered by `threadId`; terminal records are history, not worktrees.
 */
async list(repoRoot: string): Promise<WorktreeRecord[]>

/**
 * Latest record of a Thread in any state.
 * @param threadId - the Thread key.
 * @returns the folded record (terminal states included), or `undefined` when the Thread never had one.
 */
async get(threadId: string): Promise<WorktreeRecord | undefined>

/**
 * Report whether a worktree is clean and how far it is ahead of its base.
 *
 * A record whose path is gone throws `WORKTREE_NOT_FOUND`. It NEVER reports
 * `clean: true` for a missing directory: "nothing to report" and "nothing
 * wrong" are different facts, and conflating them would let a crashed Thread
 * look finished.
 * @param record - the worktree to inspect.
 * @returns `{ clean, changed, commitsAhead }` from `git status --porcelain` and `git rev-list --count`.
 */
async status(record: WorktreeRecord): Promise<WorktreeStatus>

/**
 * Summarize the work a Thread did: commits and files since its base plus the uncommitted count.
 *
 * Every list is bounded by the caller's limits; totals count what was not listed. Same
 * `WORKTREE_NOT_FOUND` rule as {@link WorktreeService.status}.
 * @param record - the worktree to inspect.
 * @param opts - non-negative integer `maxCommits` and `maxFiles`.
 * @returns the {@link WorktreeChanges} of `baseSha..HEAD`.
 */
async changes(record: WorktreeRecord, opts: WorktreeChangesOptions): Promise<WorktreeChanges>

/**
 * Predict whether merging the worktree's HEAD into `target` would conflict.
 *
 * `target` is resolved in the main checkout (`repoRoot`), so `HEAD` names the
 * main checkout's current commit and a branch name may be another Thread's branch.
 * Uncommitted edits in either checkout are not part of the prediction. No ref,
 * index, or working tree changes. Same `WORKTREE_NOT_FOUND` rule as {@link WorktreeService.status}.
 * @param record - the worktree whose HEAD would be merged.
 * @param options - the target ref.
 * @param maxConflicts - non-negative bound on the listed conflicting paths.
 * @returns the predicted result, or `{ supported: false }` when git lacks `merge-tree --write-tree`.
 */
async mergeCheck(record: WorktreeRecord, options: WorktreeMergeCheckOptions, maxConflicts: number): Promise<WorktreeMergeCheck>

/**
 * Committed diff `baseSha..HEAD` of one file, cut at a byte bound.
 *
 * Uncommitted edits are not included. The cut never splits a multibyte character, so the returned
 * patch may be shorter than `maxBytes`; git is stopped as soon as the bound is exceeded.
 * @param record - the worktree to inspect.
 * @param path - repository-relative path; absolute paths and `..` segments are rejected.
 * @param maxBytes - non-negative byte bound of the returned patch.
 * @returns the patch text and whether it was truncated.
 */
async filePatch(record: WorktreeRecord, path: string, maxBytes: number): Promise<{ patch: string; truncated: boolean }>

/**
 * Sweep records that no longer describe a live Thread.
 *
 * Two independent rules, both of which only ever REMOVE worktrees that git
 * already owns:
 * 1. a `reserved`/`ready` record whose path is missing from disk — a crash
 *    between the intent write and the add;
 * 2. a `reserved`/`ready` record whose Thread has no persisted session, judged
 *    by {@link WorktreeService.sessionExists} (skipped when no probe is installed,
 *    because session existence is not this service's knowledge) and whose record
 *    is older than `adoptionGraceMs`.
 *
 * In-flight creations of this process are never swept. Each orphan is marked
 * `orphaned`, removed with `git worktree remove --force`, and settled to
 * `removed` (or `rolled-back` when nothing was ever on disk).
 * @returns the records classified as orphans, in their `orphaned` state.
 */
async reconcile(): Promise<WorktreeRecord[]>
```

Source: [`packages/subagent/worktree-manager/src/index.ts`](../../packages/subagent/worktree-manager/src/index.ts)
<!-- END GENERATED cordis-surface -->
