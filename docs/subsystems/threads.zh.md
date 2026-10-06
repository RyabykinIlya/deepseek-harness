# Threads 与 Projects

[English](threads.md) | 中文

Project、后台 Thread、其 git worktree 与 Project memory 的类型。Project 是由 agent preset `project`（协调者）组成的 Session。Thread 是由 subagent provider `thread`（包 `@deepseek-ai/dsh-subagent-thread-worktree`）创建的 continuable 子级；它在自己的 git worktree 与分支上运行，由 agent preset `project-thread`（执行者）组成。本页记录 [`worktree-manager`](../../packages/subagent/worktree-manager/src/types.ts)、[`threads`](../../packages/experimental/threads/src/types.ts) 与 [`project-memory`](../../packages/experimental/project-memory/src/types.ts) 中的持久与客户端可见形式。操作细节由各包 README 负责：[worktree-manager](../../packages/subagent/worktree-manager/README.zh.md)、[subagent-thread-worktree](../../packages/subagent/subagent-thread-worktree/README.zh.md)、[threads](../../packages/experimental/threads/README.zh.md)、[tool-threads](../../packages/experimental/tool-threads/README.zh.md)、[threads-preset](../../packages/experimental/threads-preset/README.zh.md)、[threads-profile](../../packages/experimental/threads-profile/README.zh.md)、[project-memory](../../packages/experimental/project-memory/README.zh.md)。

## Worktrees

`ctx.worktrees` 为每个 Thread 提供独立的 git worktree。服务把每次操作的一条仅追加转换写入 `worktreeRoot` 下的 sidecar 日志；`WorktreeRecord` 是该日志的折叠结果，同一 Thread 以最后一条转换为准。

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

记录处于某个 `WorktreeState`：`reserved`（在创建克隆之前写入意图）、`ready`（session cwd 唯一可绑定的状态）、`rolled-back`（失败或中止的创建已通过删除半成品克隆撤销）、`orphaned`（对账未发现存活 Session）、`removing`（移除失败后留下的墓碑）或 `removed`（终态）。已完全移除的 Thread 可以重新创建。`maxWorktreesPerRepo` 限制每个仓库的活动（非终态）worktree 数量；超出时抛出 `WORKTREE_LIMIT_REACHED` 并列出现有 Thread id。

`create` 接收一个 `WorktreeSpec`：

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

`status` 与 `changes` 读取单个 worktree 的实时 git 状态：

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

`mergeCheck` 预测把某个 worktree 的 HEAD 合并进主 checkout 中的目标 ref 是否会干净完成，期间不改动任何 ref、索引或工作区：

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

`WorktreeRemoveOptions.force` 未设置时，`remove` 以 `REMOVE_DIRTY_WITHOUT_FORCE` 拒绝有未提交改动的 worktree。移除会先把 Thread 的分支导入父仓库（有分支时），再删除 worktree 目录；分支本身绝不会被删除。

## Threads 投影

`ctx.threads` 把仅日志的 `thread/created`、`thread/status` 与 `thread/removed` 事件折叠为 Project Session 的 `threads` Session 投影。三者都以 `ignorable: true` 追加，因此没有该插件的构建仍可打开 Project Session。`thread/status` 是按字段的部分更新：缺失的字段保持已记录的值不变。`thread/removed` 删除对应行，并保留分支与该 Thread 的 Session。

`running` 由 `ThreadsService.isRunning` 实时计算，从不存入行或日志。

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

`archive` 检查该 Thread 在 `threads` 投影中，除非设置 `ThreadArchiveOptions.force`，否则拒绝有未提交改动的 worktree；它会中断运行中的 Thread 并最多等待 `archiveStopTimeoutMs`，移除 worktree，然后追加 `thread/removed`。失败以 Remote 错误返回：`threads/not-found`、`threads/worktree-dirty`（未做任何更改）与 `threads/stop-timeout`（worktree 保持原样）。

## Project memory

`ctx.projectMemory` 在 Host 存储域 `project_memory` 中按 Project 保存简短的共享条目，因为 Thread 的沙箱无法共享文件。Project id 是协调者 Session 的 id；Thread 通过父级谱系解析它。`maxEntries` 限制每个 Project 的条目数，`maxEntryChars` 限制单条文本长度。条目由 `memory_write` 以 `coordinator` 或 `thread` 写入，由客户端通过 Remote 方法 `list`、`add`、`update`、`remove` 以 `user` 写入。`memory_read` 把条目返回给模型。

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

`ctx.threads.library` 是 Project 共享材料的只读视图：不存储任何内容，每次调用时都从 Project 的日志与其 Thread 的 worktree 中派生全部条目。

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

存活 Thread 的改动文件来自 `ctx.worktrees.changes`；已归档 Thread 的改动文件来自其最后记录的 `workspace/changes` 摘要，该摘要只在其 Session 保持加载期间存于 Host 内存中。两者都没有的 Thread 会从 `changes.items` 中省略。已 present 的文件通过由 `sessionId`、`seq` 与 `index` 寻址的 deliverables present-open 路由打开；存活 Thread 的改动文件目前没有这样的路由。

## 仅写隔离

Thread 的沙箱把写入限制在其 worktree 内。读取与网络保持开放，而 object store 是 worktree 自己的：`git push` 指向它的 `origin`，即沙箱根之外的父仓库路径，因此沙箱会拒绝它，worker 契约在任何会话中都禁止 push。不存在读取围栏。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
```

Types: [Session](session.zh.md)

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

Types: [Session](session.zh.md) · [SessionId](core.zh.md)

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

Types: [Agent](core.zh.md) · [Session](session.zh.md)

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
 * worktree still exists returns the SAME record without a second clone. An abort
 * is honored at every boundary — before any git process is spawned, and again
 * after the checkout resolves — and either way the reserved intent is rolled
 * back by deleting the half-created clone.
 * Each call first runs {@link WorktreeService.reconcile}, so abandoned worktrees do not hold limit slots.
 * The commit the Thread starts from is chosen by the base policy — `spec.base`, else the configured
 * `base` — and `head-with-uncommitted` snapshots the parent's tracked uncommitted changes with
 * `git stash create`, which leaves the parent's working tree untouched.
 * @param spec - the repository, Thread, base ref and policy, and optional branch or `detached`.
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
 * the branch import and the directory deletion, then `removed` — so a failed
 * removal leaves a `removing` tombstone a later sweep can finish, instead of
 * claiming a deletion that never happened.
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
 * main checkout's current commit and a branch name may be another Thread's branch,
 * served from that Thread's clone. `merge-tree` compares two commits of one object
 * store — the worktree's own clone — so a target commit the clone has not seen is
 * fetched in first; that writes only objects and `FETCH_HEAD`, never a ref, index
 * entry, or file. Uncommitted edits in either checkout are not part of the
 * prediction. Same `WORKTREE_NOT_FOUND` rule as {@link WorktreeService.status}.
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
 * `orphaned`, deleted from disk (and its branch imported into the parent where one
 * exists), and settled to `removed` (or `rolled-back` when nothing was ever on disk).
 * @returns the records classified as orphans, in their `orphaned` state.
 */
async reconcile(): Promise<WorktreeRecord[]>
```

Source: [`packages/subagent/worktree-manager/src/index.ts`](../../packages/subagent/worktree-manager/src/index.ts)
<!-- END GENERATED cordis-surface -->
