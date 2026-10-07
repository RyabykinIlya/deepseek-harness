# Threads — self-contained Thread worktrees (R1)

Status: **in work.** Accepted 2026-10-05 after the ADR round: replace linked git
worktrees with local clones, so a Thread can edit **and commit** inside its own
sandbox root with zero approval prompts. This file is the implementation
brief; subagents get work packages from it. Follow-up items (R2: per-Thread
repository selection and the New Project dialog) are out of scope here and stay
in [STATUS.md](../STATUS.md) priority 9.

## 1. Problem

A Thread session's writable root is exactly its cwd (`sandbox-policy.resolve`
→ `writableRoots` = `[session cwd, /tmp, tmpdir()]`). Today that cwd is a linked
worktree: files under `<worktreeRoot>/<repoBucket>/<threadSlug>`, git metadata in
the parent repository's `.git`. Consequences, both observed:

1. `git commit` inside the worktree writes `index.lock`, objects, and the branch
   ref into the parent `.git` — outside the Thread's root. Under the default
   `workspace-write` sandbox **a Thread cannot commit at all** (HIGH finding in
   [STATUS.md](../STATUS.md), reproduced through `sandbox-exec`). The whole
   contract "Thread commits → coordinator reviews → merges" is dead on arrival.
2. Agents try to repair this by hand: requesting `danger-full-access` for git,
   or cloning repositories into random places (observed in session
   `9e695015`: coordinator cloned `repos/atlas-frontend` into the wrapper
   checkout, which the Thread still could not write). Both escape hatches are
   wrong; the first must be forbidden by contract, the second is impossible to
   make work without breaking isolation.

## 2. Decision (R1) and rejected alternatives

**Decision.** `dsh-worktree-manager` creates each Thread's working tree as a
**local clone** (`git clone --local`), not `git worktree add`. The clone's `.git`
lives inside the Thread's directory, so the single sandbox root covers files and
git metadata alike. Threads use ordinary git through the existing shell with no
escalation. Merge, review, archive all stay in place; only the plumbing changes.

Rejected:

- **Widen `writableRoots` to the worktree's gitdir.** Touches upstream
  `dsh-sandbox` plus four platform backends; grants writes into the parent
  repository's shared object store and refs; against the fork's core principle
  ([README.md](../README.md): merge pain ∝ number of modified upstream files).
  Viable later as an upstream proposal if multi-root policies ever exist.
- **Host-side git-proxy tool for Threads.** A second, partial git surface;
  replaces the agent's ordinary shell git; the merge contract already runs
  through the shell by accepted decision D3.
- **`--shared` clones (alternates).** Breaks when the parent gc/prunes; `--local`
  hardlinks survive it.
- **Keep linked worktrees, document the limitation.** The feature's primary
  contract (commit then merge) does not work at all; not documentable around.

Side effects we accept, all improvements: the Thread no longer shares the
parent's object store (stronger isolation than the current "write and git state"
claim in [DECISIONS.md](../DECISIONS.md)); leaked `dsh/thread-<uuid>` branches
from failed creations disappear naturally (branch lives and dies with the
directory); `git worktree list` no longer shows Threads (the sidecar registry is
the only source of truth — it already is); sweep no longer needs the parent
repository to be reachable at all.

## 3. Invariants

- **Zero upstream files change.** All work inside `packages/subagent/worktree-manager`,
  `packages/subagent/subagent-thread-worktree`, `packages/experimental/threads-preset`,
  docs, and snapshot fixtures. No new packages, no `pnpm-workspace.yaml` or
  `tsconfig` edits, no sandbox code.
- **Registry format, states, and record fields are unchanged.** `WorktreeRecord`
  keeps `path`, `repoRoot` (still the parent top level), `branch?`, `baseRef`,
  `base?`, `baseSha?`, `createdAt?`, `state`. `thread/*` events and their payloads
  are unchanged. The sidecar stays the durable intent log; `reserved` before the
  side effect, `ready` only after the clone exists.
- **Fail loud, no silent degradation** — the package's own design rule. Every
  new failure path gets a typed `WorktreeError` code from the existing taxonomy;
  add codes only when none fits.
- **No new config knobs.** The clone switch is unconditional. A
  `mode: 'clone' | 'worktree'` toggle would be a dead knob; if the old mode is
  ever needed, git history has it.
- Repo conventions apply throughout: ESM, `ctx.effect` registrations, JSDoc with
  `@param`/`@returns` on exported functions, comments state contracts not
  reasoning, one trailing newline, no `as unknown`, oxlint clean.

## 4. Design

### 4.1 `git.ts` — new subprocess surface

Replace the worktree trio (`addWorktree`, `addWorktreeAtExistingBranch`,
`removeWorktree`) and the porcelain parser (`listWorktrees`,
`parseWorktreePorcelain`, `GitWorktreeEntry`) with:

- `cloneLocal(repoRoot, destPath)` → `git clone --local --no-checkout <repoRoot> <destPath>`.
  `--no-checkout`: the one checkout happens in the branch step below, at the
  recorded base, not twice at HEAD then base. Keep `GIT_TERMINAL_PROMPT: '0'`
  and the argv-array discipline already in the module. The clone keeps its
  default `origin` → parent path (file transport); a Thread's `git push` to it
  writes outside its root and the sandbox refuses it — document this as the
  isolation property it is.
- `checkoutNewBranch(clonePath, branch, at)` → `git checkout -b <branch> <at>`
  (first attempt). `at` is the resolved base commit.
- `checkoutExistingBranch(clonePath, branch)` → `git checkout <branch>` (restart
  of an archived Thread: the branch was imported back into the parent on
  removal, §4.4, so a fresh clone already contains it with its commits).
- `checkoutDetached(clonePath, at)` → `git checkout --detach <at>`. Honors
  `branchPerThread: false` (see §4.6).
- `fetchIntoClone(clonePath, source, what)` → `git fetch <source> <what>` inside
  the clone. Two callers: pulling the `head-with-uncommitted` snapshot commit
  from the parent (§4.3), and pulling a merge-check target (§4.5).
- `fetchBranchIntoParent(repoRoot, clonePath, branch)` →
  `git fetch <clonePath> +refs/heads/<branch>:refs/heads/<branch>` run in the
  parent. Archive-time branch import (§4.4).
- `isRepoTopLevel(path)` → `git rev-parse --show-toplevel` in `path` equals
  `path`. The clone-era liveness test (§4.7).

`runGit`, `runGitBounded`, `stashCreate`, `worktreeStatus`, `resolveRepoTopLevel`,
`branchExists` stay as they are.

### 4.2 Creation (`createWorktree`)

The flow keeps its shape: validate → reserve under lock (limit, path, branch
checks unchanged) → side effect → `ready`. The side effect becomes:

1. `rev-parse --verify <baseRef>^{commit}` in the parent — unchanged.
2. `resolveBase(...)` — unchanged, including the stash snapshot for
   `head-with-uncommitted`.
3. `cloneLocal(repoRoot, path)`.
4. **Snapshot delivery:** when the effective base is a stash commit
   (`base === 'head-with-uncommitted'` and `baseSha !== baseRefSha`), run
   `fetchIntoClone(path, repoRoot, baseSha)` so the commit is present in the
   clone by construction, not by relying on `--local` copying dangling objects
   wholesale (it does today, but that is an implementation detail, not a
   contract). If the fetch refuses a bare sha on the local file transport in the
   supported git range, fall back to `fetchIntoClone(path, repoRoot, `refs/heads/*`)`
   **only if** the snapshot commit is reachable that way — it is not (dangling),
   so in practice verify with a test; if neither works, the accepted fallback is
   `git -C <parent> pack-objects | git -C <clone> unpack-objects`… do not
   implement that. The acceptance test in §6 decides; expected outcome: a plain
   sha fetch from a local path works on git ≥ 2.30.
5. Branch step: `detached` → `checkoutDetached(path, baseSha)`; restart with own
   branch → `checkoutExistingBranch(path, branch)`; otherwise
   `checkoutNewBranch(path, branch, baseSha)`.
6. Abort checkpoints, `ready` transition with the **effective** base/baseSha —
   unchanged.

Failure classification: rewrite `classifyAddFailure` as `classifyCloneFailure`
covering: destination exists (`repository … already exists` /
`already exists and is not an empty directory`) → `WORKTREE_PATH_IN_USE`;
`not a git repository` → `NOT_A_GIT_REPO`; checkout refusing an existing branch
(`branch … already exists`, `fatal: a branch named`) → `WORKTREE_BRANCH_EXISTS`;
checkout with an unknown base sha (`invalid object name`) →
`WORKTREE_CREATE_FAILED` naming the sha; anything else →
`WORKTREE_CREATE_FAILED` with git's text. Same narrow-pattern philosophy as
today.

### 4.3 `status` / `changes` / `filePatch`

No code changes: all already run git with `record.path` as cwd against the
recorded `baseSha`. The only new requirement is that `baseSha` is guaranteed
present in the clone (§4.2 step 4) — after that these work identically. Verify by
test, do not touch the implementations.

### 4.4 Removal and archive

`remove(record, opts)`:

1. Order preserved: `removing` transition first, then the side effect, then
   `removed`/`rolled-back`.
2. **Dirty refusal without `force`** moves from `git worktree remove`'s stderr
   to an explicit `worktreeStatus(path)` check: any porcelain line →
   `REMOVE_DIRTY_WITHOUT_FORCE` with the same message shape. Then `git status`
   is the authority on dirt, not git's remove.
3. **Branch import before deletion:** when `record.branch` is set, run
   `fetchBranchIntoParent(record.repoRoot, record.path, branch)` and treat a
   non-zero exit as a removal failure (loud — the public archive contract
   promises "the branch and the Thread's session are kept"; silently dropping
   the branch would break it). Force-update refspec: the clone owns its branch
   while it lives. A branch with no unique commits still imports fine (ref
   points at an existing object).
4. Delete the directory with `node:fs.rm(path, { recursive: true, force: true })`
   — no shell. Hardlinked objects elsewhere are unaffected. `rm` failure →
   `WORKTREE_OPERATION_FAILED`, tombstone `removing` stays for the next sweep,
   exactly as a failed `git worktree remove` behaves today.

`rollback` (failed/aborted creation): same import is **not** needed — a rolled
back Thread never produced a branch worth keeping; delete the directory if it
exists, transition `rolled-back`. Unconditional `force: true` on the rm.

### 4.5 `mergeCheck`

Today: resolve `target` in the parent, `merge-tree` in the worktree path. Both
shas must live in one object store — with clones that is the clone. New order:

1. Resolve `target` in the parent (`record.repoRoot`) as today; on failure, try
   the sibling path (step 2) before throwing.
2. Sibling fallback: `list(record.repoRoot)` finds the active record whose
   `branch` equals the target; if one exists, its clone is the source:
   `fetchIntoClone(record.path, sibling.path, sibling.branch)` (fetching the
   branch name from the sibling's path), then resolve the sha in the clone.
3. `merge-tree --write-tree` in `record.path` with `(targetSha, headSha)` —
   unchanged otherwise, including the git < 2.38 `supported: false` path.

This keeps `thread_diff`'s cross-Thread pair checks working: a target naming
another Thread's branch is served from that Thread's clone; the coordinator's
own `HEAD` or any parent ref resolves in the parent first.

### 4.6 `detached` spec field (fixes the `branchPerThread: false` dead knob)

Add optional `readonly detached?: boolean` to `WorktreeSpec` (default absent =
branch as today). `subagent-thread-worktree` passes `detached: true` when
`branchPerThread` is false. `create` then checks out detached at the base and
records **no** `branch` field — matching the documented contract
("a detached worktree and `WorktreeRecord.branch` stays empty") that the current
`addWorktree` always-`-b` behavior silently violates. Update the type-equiv
block for `WorktreeSpec` in [docs/subsystems/threads.md](../../docs/subsystems/threads.md)
to match the source.

### 4.7 Liveness and sweep

`requireLiveWorktree`: replace "git registers this path as a worktree" with
`isRepoTopLevel(record.path)` plus the existing directory check. Keep the
comment's spirit: git, not the filesystem, decides — a directory without a
working `.git` is not a live Thread checkout.

`sweep()`: liveness becomes `isDirectory(path) && isRepoTopLevel(path)`. The
per-record `git worktree list` on the parent disappears entirely, which also
fixes two recorded findings: one unreachable/missing parent repository no longer
kills the whole batch (HIGH), and the per-record subprocess storm (MEDIUM) is
gone. Sweep's session-probe rule and grace windows are unchanged.

### 4.8 Contract text (`threads-preset/src/threads-contract.ts`)

Coordinator merge sentence, currently
`Integrate a reviewed Thread by merging its branch into the Project checkout with `git merge --no-ff <branch>`, …`
becomes fetch-then-merge. Use the worktree path from the status/diff tools:

> `Integrate a reviewed Thread by importing its branch from its worktree into the Project checkout with `git fetch <worktree> <branch>:<branch>` and merging with `git merge --no-ff <branch>`, resolving conflicts, and running the tests. thread_status and thread_diff show each Thread's worktree path.`

Worker contract, after the commit sentence, add one sentence stating the
guarantee and the two prohibitions (the R3 part that belongs in the contract):

> `Your checkout is a complete standalone repository: ordinary git commands work in it without any escalation. Never create a git worktree, clone, or copy of any repository, and never request wider file access for a git operation; if you cannot write inside your own checkout, report that to the coordinator instead of working around it.`

Keep additions minimal — every changed sentence is asserted verbatim in
`packages/experimental/threads-preset/tests/project-preset.spec.ts` (grep for the
old strings; update every assertion), and the recorded snapshot sessions carry
the same text. Do not touch sentence variants you were not asked to change.

## 5. What must NOT change

- `subagent-thread-worktree` provider logic apart from passing `detached`:
  `childCwd` subdirectory mapping works identically for a clone.
- The `threads` package: `archive`, projections, `thread/*` emission — the
  service API they call is unchanged.
- `tool-threads` signatures and rendering apart from `mergeLine` (see below); its fake-service tests stay valid.
  **Amendment (accepted during implementation):** `src/diff.ts`'s `mergeLine` told
  the model to `git merge --no-ff <branch>` with no fetch — after R1 that
  instruction silently stops working, so it is part of the change surface after
  all: the branch line now reads `import it into the Project checkout with
  \`git fetch <worktree> <branch>:<branch>\`, then merge with \`git merge --no-ff <branch>\``
  and the detached line names the full head sha (an abbreviated one is not
  fetchable). The five assertions of the old text are updated with it.
- Sidecar registry format and every state machine edge.
- Sandbox, shell, approval, `worktreeRoot` guard (`resolveConfiguredRoot`
  unchanged — a clone root inside the checkout would be exactly the litter the
  guard exists to refuse).

## 6. Acceptance tests (red → green where a bug existed)

In `packages/subagent/worktree-manager/tests/`, using the existing real-git
fixture style:

1. **The invariant, stated directly:** after `create`, `git -C <path>
   rev-parse --git-dir` resolves **inside** `<path>` (this is the property that
   makes commits sandbox-legal), and `git -C <path> status` works with no
   parent repo reachable.
2. **Commit works standalone:** `git -C <path> add` + `git -C <path> commit`
   inside a created worktree succeed; `changes()` reports the commit;
   `status()` reports it ahead of base.
3. **`head-with-uncommitted`:** parent with tracked uncommitted edits → create →
   the edits are present in the clone; `baseSha` resolves in the clone;
   `changes()` diffs against it. If the bare-sha fetch is unavailable in the
   supported git range, this test fails — resolve per §4.2 step 4, do not delete
   the test.
4. **Archive keeps the branch:** commit in the clone → `remove` → directory
   gone, parent has the branch at the Thread's tip, record is `removed`;
   **restart** with the same threadId re-attaches to the imported branch with
   commits intact.
5. **Dirty refusal:** uncommitted edits + `remove` without force →
   `REMOVE_DIRTY_WITHOUT_FORCE`; with force → gone, branch imported.
6. **mergeCheck across clones:** parent moves ahead after the Thread's base
   (target = parent `HEAD` newer than clone base) → still answers; two Threads,
   target = the other Thread's branch name → answered from the sibling clone.
7. **Sweep independence:** a record whose parent repoRoot is deleted from disk
   (rename it away) still sweeps to a terminal state instead of throwing —
   red on the old code (the HIGH batch-kill finding), green on the new.
8. **Detached mode:** `branchPerThread: false` → `branch` absent from the
   record, `git -C <path> branch --show-current` is empty — red today, green
   after.
9. Existing suites in the package (`base-policy`, `git-failures`,
   `multi-process`, `merge-check`, `worktree-manager`) keep passing; delete
   tests of removed behavior (porcelain parser, worktree-add failure wording)
   with the behavior.

`threads-preset`: updated verbatim assertions for the two changed contract
sentences.

Beyond the suites, acceptance was proven live under the REAL seatbelt profile:
[r1-sandbox-e2e.mts](r1-sandbox-e2e.mts) mounts the service, creates a Thread
worktree, and runs `git add` + `git commit` inside it under `sandbox-exec` with
the deployment `workspace-write` policy — exit 0, commit landed. The red
control in the same run performs the identical commit in a LINKED worktree
under the identical profile and is denied with the pre-R1
`…worktrees/<name>/index.lock: Operation not permitted` error. The fixture
dirs sit outside the platform temp area (`writableRoots` grants all of
`tmpdir()`, which would invalidate the control) and the script runs with a cwd
outside the checkout (the `worktreeRoot` guard measures containment against
the process cwd).

## 7. Work packages

| Package | Scope | Owner |
|---|---|---|
| A | `worktree-manager`: git.ts surface, creation/removal/sweep/liveness/mergeCheck, detached field, all package tests | subagent |
| B | `threads-preset`: contract sentences + preset test assertions; `subagent-thread-worktree`: pass `detached` | subagent (parallel with A; different packages, zero file overlap) |
| C | Docs: worktree-manager README + README.zh (line-paired), docs/subsystems/threads{.md,.zh.md} prose + `WorktreeSpec` type-equiv block, JSDoc wording across touched files | subagent, after A+B land |
| D | Snapshot fixtures `snapshots/session/threads-project-worktree{,-tiers}`: update expectations to the new contract text and mechanics, in agreement with source | subagent, after A+B land |
| E | Integration: merge branches, run gates (`vitest` on touched packages, `tsc` typecheck, oxlint, `gen-cordis-api` regeneration, `doc-sync` fast checks), record results in [STATUS.md](../STATUS.md) | coordinator (this session) |

## 8. Out of scope (do not do)

- R2: per-Thread repository selection, the New Project dialog, multi-repo
  Projects — separate effort, stays at [STATUS.md](../STATUS.md) priority 9.
- Any change to `dsh-sandbox`, shell, approval flow, or their configs.
- Upstream PRs (the `ContinuableCreateSpec.cwd` seam already exists and is used).
- Fixing the ten stale shell-tool snapshot scenarios — pre-existing, separate
  item in [STATUS.md](../STATUS.md) "Общее".
