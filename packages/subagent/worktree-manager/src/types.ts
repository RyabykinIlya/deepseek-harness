/**
 * Public data shapes of the git-worktree service (`ctx.worktrees`).
 *
 * Every record here is a *derived* view: the durable sidecar under the service's
 * configured `worktreeRoot` stores one append-only transition per operation, and
 * these types are the fold of that log (last transition wins). The service is the
 * only writer.
 *
 * @module @deepseek-ai/dsh-worktree-manager/types
 */

/**
 * Lifecycle state of one managed worktree.
 *
 * ```text
 * reserved ──clone + checkout ok──▶ ready ──explicit remove──▶ removing ──▶ removed
 *    │                               │                              ▲
 *    │ create failed / signal.abort  │ reconcile: no session        │ reconcile sweep
 *    ▼                               ▼                              │
 * rolled-back ──────────────────── orphaned ────────────────────────┘
 * ```
 *
 * - `reserved` — durable intent, written BEFORE the clone is created. A crash
 *   after this line is what {@link WorktreeService.reconcile} exists to repair.
 * - `ready` — the clone and its checkout succeeded; the ONLY state a session cwd may be bound to.
 * - `rolled-back` — a failed or aborted creation was explicitly undone by deleting
 *   the half-created clone.
 * - `orphaned` — reconcile classified the record as having no live session.
 * - `removing` — tombstone left behind when the removal failed, so a later sweep
 *   can finish the job.
 * - `removed` — terminal: the worktree is gone and the record is history.
 */
export type WorktreeState =
  | 'reserved'
  | 'ready'
  | 'rolled-back'
  | 'removing'
  | 'removed'
  | 'orphaned'

/**
 * What a new Thread's worktree is created from.
 *
 * - `head` — the repository's committed state: `spec.baseRef` resolved with
 *   `git rev-parse --verify <baseRef>^{commit}`, and nothing else.
 * - `head-with-uncommitted` — that same commit *plus the parent's tracked uncommitted changes*,
 *   captured as a commit object with `git stash create`. A Thread started while its coordinator is
 *   mid-edit therefore sees the work in progress instead of the last commit, and a later merge
 *   cannot collide on lines the parent never committed.
 *
 * Untracked files are NOT part of the snapshot: git cannot represent them in a stash without `-u`,
 * which is deliberately not used (see the README). A clean working tree is not a failure — git
 * answers with empty output and the committed base is the whole story.
 */
export type WorktreeBasePolicy = 'head' | 'head-with-uncommitted'

/** Input for {@link WorktreeService.create}: one Thread asking for its own working tree. */
export interface WorktreeSpec {
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

/** One durable worktree intent, as folded from the sidecar log. */
export interface WorktreeRecord {
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

/** Options for {@link WorktreeService.remove}. */
export interface WorktreeRemoveOptions {
  /**
   * Discard local modifications. Without it a dirty worktree is refused with
   * `REMOVE_DIRTY_WITHOUT_FORCE` — losing unsaved work must never happen silently.
   */
  readonly force?: boolean
}

/** Result of {@link WorktreeService.status}. */
export interface WorktreeStatus {
  /** True only when `git status --porcelain` reported nothing at all. */
  readonly clean: boolean
  /** Number of porcelain entries (staged, unstaged, and untracked paths combined). */
  readonly changed: number
  /** Commits on the worktree's HEAD since `baseSha` (the record's `baseRef` when `baseSha` is absent). */
  readonly commitsAhead: number
}

/** One committed file change of {@link WorktreeChanges}. */
export interface WorktreeFileChange {
  /** Repository-relative path, `/`-separated. */
  readonly path: string
  /** Added line count; absent for binary files. */
  readonly added?: number
  /** Removed line count; absent for binary files. */
  readonly removed?: number
  /** True when git reports the file as binary. */
  readonly binary?: boolean
}

/** Bounds for {@link WorktreeService.changes}. */
export interface WorktreeChangesOptions {
  /** Maximum number of commits listed (non-negative integer). */
  readonly maxCommits: number
  /** Maximum number of files listed (non-negative integer). */
  readonly maxFiles: number
}

/** Options of {@link WorktreeService.mergeCheck}. */
export interface WorktreeMergeCheckOptions {
  /** Ref the worktree's HEAD would be merged into, resolved in the main checkout: `HEAD`, a branch, or a commit. */
  readonly target: string
}

/**
 * Predicted result of merging a worktree's HEAD into a target ref, computed by
 * `git merge-tree --write-tree` without touching any checkout or ref.
 * `supported: false` means the installed git predates `merge-tree --write-tree` (git 2.38).
 */
export type WorktreeMergeCheck =
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

/** Result of {@link WorktreeService.changes}: committed work since the base plus the uncommitted count. */
export interface WorktreeChanges {
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

/**
 * Answers "does a persisted session still exist for this Thread?". The continuation
 * manager owns session persistence, so this service does not guess: a deployment that
 * wants startup reconciliation supplies the predicate. With none supplied, no record is
 * ever treated as an orphan (reconcile still verifies git-side consistency).
 */
export type SessionExistsProbe = (threadId: string) => boolean | Promise<boolean>

/** Advisory-lock settings of the registry shared by processes on one `worktreeRoot`. */
export interface WorktreeRegistryLocking {
  /** Longest wait for the lock in milliseconds before `WORKTREE_REGISTRY_LOCKED`. */
  readonly timeoutMs: number
  /** Pause between lock attempts in milliseconds. */
  readonly retryIntervalMs: number
  /** Age in milliseconds after which a lock whose holder stopped refreshing it may be taken over (at least 5000). */
  readonly staleMs: number
}
