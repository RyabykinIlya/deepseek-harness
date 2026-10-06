---
description: "Git worktree manager for background Threads: creation, durable intent records, explicit removal, and startup reconciliation."
kind: "package-reference"
---

# @deepseek-ai/dsh-worktree-manager

English | [中文](README.zh.md)

## Summary

Give every background Thread its own self-contained local clone, so a Thread's commits, index, and working files never touch the project checkout. Creation fails loudly with a typed error rather than handing a Thread the parent directory, and a crash between the durable intent record and creating the clone is repaired at the next start. Nothing is deleted automatically: removal is an explicit call that imports the branch into the parent before deleting the directory, and it refuses a dirty worktree until you confirm. Read a Thread's commits, changed files, and merge prediction without moving a ref.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Errors](#errors)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Load it as a Host service; it registers `ctx.worktrees` and validates its configuration once, at load.

```yaml
- name: '@deepseek-ai/dsh-worktree-manager'
  config:
    worktreeRoot: /Users/you/.dsh/worktrees
    maxWorktreesPerRepo: 32
    adoptionGraceMs: 600000
    base: head-with-uncommitted
```

| Field | Default | Meaning |
|---|---|---|
| `worktreeRoot` | `~/.dsh/worktrees` | Absolute directory holding the intent log and every managed worktree. Must not live inside a registered checkout. |
| `repoRootResolution` | `explicit` | Where an empty `spec.repoRoot` comes from: `explicit` (the caller must name one) or `parent-cwd` (the checkout the harness was launched in). |
| `base` | `head` | What a new Thread's worktree is created from: `head` (the committed `HEAD`) or `head-with-uncommitted` (that plus the parent's tracked uncommitted changes). A spec's `base` overrides it per call. See [the base policy](#understand-the-implementation/the-base-policy). |
| `pruneOnStart` | `true` | Run the reconciliation sweep when the service loads. |
| `maxWorktreesPerRepo` | `32` | Maximum active (non-terminal) worktrees per repository, integer ≥ 1. Exceeding it throws `WORKTREE_LIMIT_REACHED`, whose message lists the existing Thread ids; remove one to free a slot. Running-Thread concurrency is limited separately by `maxActiveSubagents` in `dsh-subagent`. |
| `adoptionGraceMs` | `600000` | Minimum age of a record before a missing session makes it an orphan; covers the window between worktree creation and session publication. |
| `lockTimeoutMs` | `10000` | Longest wait for the registry lock shared by processes on one `worktreeRoot`; past it the call fails with `WORKTREE_REGISTRY_LOCKED`. |
| `lockRetryIntervalMs` | `50` | Pause between lock attempts, integer ≥ 1. |
| `lockStaleMs` | `30000` | Age after which a lock whose holder stopped refreshing it (a crashed process) may be taken over, integer ≥ 5000. |

<a id="use-this-package/session-existence"></a>
### Tell the service which Threads still have a session

The service does not know about sessions — the continuation manager owns session persistence — so it never guesses. Assign the probe once, right after mounting:

```ts
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { WorktreeService } from '@deepseek-ai/dsh-worktree-manager'

declare const ctx: Context

ctx.worktrees.sessionExists = async (threadId: string) => (await ctx.sessionPersistence.stat(brandString<SessionId>(threadId))) !== undefined
```

`dsh-subagent-thread-worktree` installs this probe itself and removes it when it is disposed.

Without a probe, `reconcile()` still repairs records whose worktree is missing from disk, but it will never call a record an orphan on session grounds.

<a id="understand-the-implementation"></a>
## Understand the implementation

<a id="understand-the-implementation/the-base-policy"></a>
### The base policy

`create()` decides the commit a Thread starts from with `spec.base`, falling back to the configured `base`. The default is **`head`**, which is exactly what this package did before the policy existed: `baseRef` resolved to a commit, and nothing else.

**`head`** — the committed state. A Thread branched while its coordinator is mid-edit does *not* see the edit, which is the point of a clean base: two Threads from the same commit never collide on work neither of them did.

**`head-with-uncommitted`** — that commit *plus the parent's tracked uncommitted changes*, captured as a commit object with `git stash create`. A Thread started while its coordinator is mid-edit therefore sees the work in progress, and a later merge cannot conflict on lines the parent never committed. The commit lands on the Thread's own branch, so it is the Thread's *starting point*: `status()` reports `commitsAhead: 0` and `changes()` reports no commits until the Thread itself commits something.

Three properties are worth stating plainly, because they are the ones a reader cannot derive from git's own documentation:

- **The parent's working tree is never touched.** `git stash create` only adds object-database entries — nothing lands in the ref namespace, no file moves, `git stash list` stays empty. A `git stash push`/`pop` would empty the parent's working tree and race every other agent in the same checkout, which is why it is not used.
- **Untracked files are NOT included.** Git cannot represent them in a stash without `-u`, which is deliberately not passed. A staged new file *is* included, because it is part of the index.
- **A clean working tree is not a failure.** `git stash create` exits 0 with empty output; the committed base is then the whole story and the Thread is created from it. A *failing* `git stash create` is a different matter and fails the create with `WORKTREE_CREATE_FAILED` — silently falling back to `HEAD` would hand the Thread a base nobody asked for and put the conflict back.

`baseRef` is still resolved and validated under both policies, so an unusable base is refused either way. Under `head-with-uncommitted` it names the ref the snapshot is taken against and the fallback for a clean tree; `WorktreeRecord.baseSha` is always the commit actually used, and `WorktreeRecord.base` records the policy that produced it.

A **restarted** Thread never re-snapshots. It is re-created as a fresh clone checked out on the branch that removal imported into the parent, so its branch keeps its own history; re-snapshotting the parent would record a base that is no longer an ancestor of the Thread's work and make `changes`/`filePatch` diff it against a commit it never had. Instead the earlier lineage's `baseSha` — and the policy that produced it — are inherited, so a resumed Thread keeps measuring from where it actually started.

### Durable intent comes before the side effect

`create()` appends a `reserved` line to `worktrees.jsonl` **before** it clones, writes `ready` only after the clone and its checkout succeeded, and deletes the half-created clone in a `finally` when creation fails or is aborted. That ordering is the whole design: a crash between the intent write and the clone leaves a detectable record, instead of an invisible directory nobody can attribute.

The sidecar is append-only JSONL, one line per transition, folded in memory (last line for a `threadId` wins). State is therefore *derived*, never stored in a second machine that could disagree with the log. A torn final line — the normal artifact of a crash mid-append — is skipped; a malformed line anywhere else is refused loudly rather than silently discarding records.

### The state machine

```text
reserved ──clone + checkout ok──▶ ready ──explicit remove──▶ removing ──▶ removed
   │                               │                              ▲
   │ create failed / signal.abort  │ reconcile: no session        │ reconcile sweep
   ▼                               ▼                              │
rolled-back ──────────────────── orphaned ────────────────────────┘
```

Transitions are idempotent (re-asserting the current state writes nothing) and guarded by an explicit edge list; anything off the list throws `WORKTREE_STATE_ILLEGAL`. The only edge out of a terminal state is `removed → reserved` / `rolled-back → reserved`, the documented **restart** edge: a Thread whose worktree was fully removed may be created again.

### What the branch is, and what removal deletes

The branch (`dsh/thread-<slug>` by default; the worktree directory is named with the same `threadSlug(threadId)`, and the full `threadId` stays in the record) is a derived convenience handle, never the identity. Removal is keyed on `(threadId, path)`: **`remove()` deletes the worktree directory, importing the record's branch into the parent repository first when there is one** — deleting the branch could orphan the commits a Thread made. Integration fetches that branch out of the Thread's directory into the checkout that merges it: `git fetch <worktree> <branch>`, then `git merge --no-ff <branch>`. Because of that, a restarted Thread is exempt from the `WORKTREE_BRANCH_EXISTS` check for the branch it owned before, and is re-created as a fresh clone checked out on that branch so its earlier commits survive. Any other pre-existing branch — another Thread's, or yours — is still refused.

### Reconciliation

`reconcile()` sweeps records under two independent rules, and never touches a worktree it does not own:

1. a `reserved`/`ready` record whose path is missing from disk (a crash mid-creation);
2. a `reserved`/`ready` record whose Thread has no persisted session, per `sessionExists`, and whose record is older than `adoptionGraceMs`. A creation still in flight in this process is never swept.

The sweep runs at start and before every `create()`, so abandoned worktrees do not hold limit slots. Each orphan is marked `orphaned`, deleted from disk — with its branch imported into the parent where one exists — and settled to `removed`, or to `rolled-back` when nothing was ever on disk. A removal that fails leaves a `removing` tombstone for a later sweep.

### Recorded base and changes

`create()` resolves the base policy to a commit and stores it as `baseSha`, together with the policy that produced it as `base` (records written earlier have neither and fall back to `baseRef`). `get(threadId)` returns the latest record in any state. `status()` adds `commitsAhead` (`git rev-list --count baseSha..HEAD`). `changes(record, { maxCommits, maxFiles })` returns commits newest first, committed files of `baseSha..HEAD` with binary detection, totals, and the uncommitted count. `filePatch(record, path, maxBytes)` returns the committed diff of one repository-relative path, cut by bytes on a character boundary; absolute and `..` paths are rejected. Every list and patch is bounded. `mergeCheck(record, { target }, maxConflicts)` predicts with `git merge-tree --write-tree` whether merging the worktree's HEAD into `target` would conflict, listing at most `maxConflicts` paths plus the total; no ref or working tree moves, and git before 2.38 yields `{ supported: false }`. The target resolves in the main checkout first and, when that fails, from another Thread's branch served by that Thread's clone; a commit the worktree's own clone lacks is fetched in before `merge-tree` compares the two.

### Several processes on one root

Every state transition, and the limit check plus reservation inside `create()`, runs under a `proper-lockfile` advisory lock on the registry directory: under the lock the process folds the lines other processes appended, validates the transition against that view, and appends one line with a single `O_APPEND` write, so check-and-reserve is atomic across processes. A `reserved` record younger than `adoptionGraceMs` is never swept, because another process may still be adding it.

### Git invocation

Every call shells out through `execFile` with an argument **array** and no shell, so a Thread id or a ref can never become shell syntax. A non-zero exit is data the service classifies; only a failure to spawn `git` at all rejects (`GIT_SPAWN_FAILED`).

<a id="errors"></a>
## Errors

Every failure is a `WorktreeError` (a `HarnessError`) carrying a stable `code`. Route on `code`, never by parsing `message`. The codes continue the existing `SubagentError` vocabulary rather than starting a parallel one.

| Code | Raised when |
|---|---|
| `NOT_A_GIT_REPO` | `repoRoot` is not inside a git work tree (or is relative/empty under `explicit` resolution). |
| `WORKTREE_CREATE_FAILED` | The clone or checkout step failed for a reason no other code describes, or the spec carried an unusable branch/thread id. |
| `WORKTREE_BRANCH_EXISTS` | The Thread's branch already exists and is not its own from a previous run. |
| `WORKTREE_PATH_IN_USE` | The target worktree path is occupied on disk. |
| `GIT_SPAWN_FAILED` | The `git` executable could not be spawned. |
| `REMOVE_DIRTY_WITHOUT_FORCE` | A dirty worktree was removed without `force`. |
| `WORKTREE_LIMIT_REACHED` | `maxWorktreesPerRepo` active worktrees already exist for the repository; the message lists their Thread ids. |
| `WORKTREE_ORPHANED` | A durable record claims a worktree that is gone; the record is classified as orphaned rather than silently re-added. |
| `WORKTREE_NOT_FOUND` | `status()` (or `remove()`) named a Thread with no worktree on disk. Never reported as `clean: true`. |
| `WORKTREE_SUBDIRECTORY_MISSING` | The Thread provider found the parent's subdirectory missing in the new worktree. |
| `WORKTREE_STATE_ILLEGAL` | An internal state-machine guard rejected a transition. |
| `WORKTREE_OPERATION_FAILED` | A `list`/`remove`/`status` git invocation failed for another reason. |
| `WORKTREE_REGISTRY_LOCKED` | The shared registry lock was not acquired within `lockTimeoutMs`, or was lost mid-transition. |

`WORKTREE_NOT_FOUND`, `WORKTREE_SUBDIRECTORY_MISSING`, `WORKTREE_STATE_ILLEGAL`, and `WORKTREE_OPERATION_FAILED` are additions to the design's table: SBFT row A8 requires a typed "not found" that is not `clean: true`, and the guard and generic-failure codes keep those cases from being misreported as `WORKTREE_CREATE_FAILED`.

Cancelling a `create()` rejects with the platform's `AbortError` (from `AbortSignal`), after the reserved intent has been rolled back — cancellation is not a worktree failure and does not get a worktree code.

<a id="model-experience"></a>
## Model Experience

### Thread worktree facts

#### What the model sees

Nothing directly: this package registers no model-facing tool, prompt section, or message. A Project model reaches its Threads' worktrees through the bounded `thread_status` and `thread_diff` tools, which read `get`, `status`, and `changes` from this service and render the result themselves.

#### Token effect

None from this package. The row and patch text a model reads is produced by `@deepseek-ai/dsh-experimental-threads-tool`; nothing here is added to a request.

#### KV Cache effect

Nothing here enters a model request, so provider cache reuse is unaffected.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **An omitted `branch` is not a detached checkout.** `WorktreeSpec.branch` is optional, but a spec without it gets the default derived branch; a detached checkout requires `WorktreeSpec.detached` (the two are mutually exclusive), and the design assigns the `branchMode` decision to the Thread provider package.
- **Reads are not fenced.** A worktree isolates *writes* and git state: the Thread's repository is self-contained, with its own object store inside the Thread's directory. Reads themselves stay open, so a Thread can still read the whole repository. This package does not attempt a read fence.
- **`maxWorktreesPerRepo` is enforced per repository**, matching `list(repoRoot)`, not globally across the process.
- **Isolation covers writes only.** Reads and the network are not isolated, and `/tmp` is shared. A `git push` from a Thread targets its clone's `origin`, the parent repository's path, which lies outside the Thread's sandbox root, so the sandbox refuses it; the worker contract forbids push in any session.
- **Multi-process safety relies on the local filesystem.** The lock uses atomic directory creation, which network filesystems do not guarantee.
- **The startup sweep cannot see session existence** until a probe is installed, because a probe cannot arrive through YAML. The sweep before each `create()` is probe-aware once one is installed.
- **Registering the package requires the generated tsconfig alias.** `tsconfig.base.json` carries generated `@deepseek-ai/dsh-*` package aliases; run `pnpm run gen-tsconfig-paths` after adding this package.

<a id="dev-note"></a>
### Dev Note

- Source layout: `src/index.ts` (the service), `src/registry.ts` (durable intent log and state machine), `src/git.ts` (the git subprocess surface), `src/error.ts` (typed failures), `src/types.ts` (public data shapes), `src/states.ts` (state sets).
- The base-policy suite builds a dirty parent checkout for real and reads the created worktree's files back off disk, so `git stash create` is distinguished from `git stash push`/`pop` by what it does *not* do to the parent (`git status --porcelain` unchanged, `git stash list` empty) rather than by a mocked return value.
- The tests build a real temporary git repository per case (`mkdtemp` + `git init` + one commit), create each worktree as a local clone, and read every assertion back out of git — `git rev-parse --git-dir` resolving inside the worktree's own directory, `git branch --list`, `git status --porcelain` — rather than trusting the service's own bookkeeping. They cover SBFT rows A1–A9 plus the configuration guards and the state-machine edges.
- `sbft A6` (abort during creation) is made deterministic by a sleeping `post-checkout` hook delivered through `core.hooksPath` — a clone does not copy the parent's hooks — so the abort provably lands while the clone's checkout is in flight instead of racing it.

**Runtime invariant:** No companion is published. The sidecar log is the only state this service holds: each transition is validated against the freshly folded log under the advisory lock, so an illegal edge throws from the very append that would have written it, and branch, commit, and working-tree facts are read from `git` at call time instead of from a maintained projection.
