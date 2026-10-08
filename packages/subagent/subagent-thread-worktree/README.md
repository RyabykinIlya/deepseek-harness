---
description: "Worktree-isolated continuable subagent backend: every Thread child runs in its own self-contained clone."
kind: "package-reference"
---

# @deepseek-ai/dsh-subagent-thread-worktree

English | [中文](README.zh.md)

## Summary

Use this package to give an agent a named subagent backend in which every continuable child is isolated in its own self-contained clone. The backend resolves the repository the delegation names, creates the clone as part of child creation, returns its absolute path as the child's durable `cwd`, and owns rollback of that clone when creation aborts. Because a session's `cwd` is also its sandbox write root, the clone is what confines the child's writes. It is not itself the worktree manager: it depends on `@deepseek-ai/dsh-worktree-manager` for the git operations, durable intent records, and startup reconciliation.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the worktree manager first, then this backend, then a delegation tool pointed at it. The provider registers under a name of your choosing, and that name is what the tool's `provider` field selects:

```yaml
- name: '@deepseek-ai/dsh-worktree-manager'
  config:
    worktreeRoot: ~/.dsh/worktrees
    pruneOnStart: true
- name: '@deepseek-ai/dsh-subagent'
- name: '@deepseek-ai/dsh-subagent-thread-worktree'
  config:
    providerName: thread
    branchPerThread: true
    branchTemplate: dsh/thread-{{id}}
    baseRef: head
    childAgentPreset: project-thread
- name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: thread
    backgroundMode: continuable
```

| Field | Default | Meaning |
|---|---|---|
| `providerName` | `thread` | Registry name on `ctx.subagents`; the delegation tool selects it |
| `branchPerThread` | `true` | Give each child its own branch; `false` creates detached worktrees |
| `branchTemplate` | `dsh/thread-{{id}}` | Branch name; `{{id}}` is the child's `threadSlug`, the same slug that names the worktree directory |
| `baseRef` | `head` | `head` creates the worktree at the parent's committed `HEAD`; `head-with-uncommitted` also captures tracked uncommitted changes with `git stash create` (falls back to `HEAD` when clean). Untracked files are not included. |
| `childAgentPreset` | unset | Agent preset id returned as `ContinuableCreateSpec.agentPreset`; unset means the child inherits the parent's preset |

The orphan grace period (`adoptionGraceMs`) and the per-repository limit (`maxWorktreesPerRepo`) are fields of the [worktree manager](../worktree-manager/README.md), which owns the record timestamps.

### What a Thread gets

Each continuable child receives a worktree checked out from the repository the delegation selects, at the configured `baseRef`. The child's `cwd` is the worktree root plus the selected repository's path below that repository's top level: naming the repository itself gives the worktree root, and naming a directory inside it gives that subdirectory, so a delegation naming `packages/app` gets a child in `<worktree>/packages/app`. If that directory is not in the base commit, the worktree is removed and creation fails with `WORKTREE_SUBDIRECTORY_MISSING`. The `cwd` is what the sandbox derives its writable root from, so a child cannot write outside its own tree. The child starts with no inherited parent history, which is what keeps its context window independent.

### Selecting the repository

`prepareContinuable` resolves the delegation's optional `repository` — a path inside the parent session's working directory, usually the subdirectory name — to that repository's top level and creates the worktree from it. Omit the parameter when the parent session's working directory is itself a repository; the worktree then comes from that repository. Name one when the working directory is a workspace directory holding several repositories.

When the repository cannot be resolved — the delegation named none while the working directory holds several repositories, or a named path that is missing, is a file, lies outside the parent's working directory, or sits in no git work tree — creation is refused with `NOT_A_GIT_REPO`, and the error lists the candidate repositories:

`thread worktrees: the repository for this Thread is not resolvable from <target>; name a repository inside <parentCwd> with the repository parameter. Repositories under <parentCwd>: <candidates>.`

`<target>` is the path the delegation resolved to — the parent session's working directory when it named none, otherwise that directory joined with the named repository. `<parentCwd>` is the parent session's working directory, and `<candidates>` is the sorted comma-separated list of its immediate subdirectory names that are repository top levels, or `none found`.

### When creation fails

Every failure is loud and typed; this package never falls back to an unisolated child. A parent session without a `cwd`, an unresolvable `repository`, a repository that is not a git work tree, an existing branch, or an occupied worktree path each reject before or during creation. A one-shot start that names a `repository` is refused too: that route builds no worktree and would ignore the name. If the caller's signal aborts after the worktree exists, the provider removes it before propagating — the continuation manager cannot, because it holds no handle for a child that was never published.

<a id="understand-the-implementation"></a>
## Understand the implementation

The provider's whole participation in a continuable child is `prepareContinuable`: it resolves the repository the delegation names, creates the worktree through `ctx.worktrees`, returns `{ cwd }`, and compensates for its own failure. Identity reservation, composition, prompt delivery, cold resume, ownership, and disposal all belong to the continuation manager, so this package carries no lifecycle of its own.

The one-shot `start` path is inherited from the shared in-process driver and does NOT isolate: a one-shot child necessarily shares the parent's working directory. Isolation is a property of continuable Threads only, and one-shot delegation in this backend is not a supported way to get a worktree.

Rollback has three parts. A failure or abort inside the provider's own call is handled inline by removing the worktree. A crash of the whole process is handled by the worktree manager, which persists a `reserved` intent record before it mutates git and reconciles orphaned records on the next start. A failure after `prepareContinuable` returns, inside the continuation manager (admission refusal, duplicate id, materialization error), leaves a worktree without a session; the provider installs `worktrees.sessionExists` on `ctx.sessionPersistence.stat`, and the manager's sweep removes such a worktree once its record is older than `adoptionGraceMs`. The sweep runs at start and before each create. Without a session persistence service the probe reports "exists" and logs once, so nothing is swept on a guess.

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package contract is not enough:

- [Worktree manager](../worktree-manager/README.md) — the git operations, durable intent records, and reconciliation this provider depends on.
- [Threads domain projection](../../experimental/threads/README.md) — the log-only `thread/*` events and the two-axis status read model this backend's children report into.
- [Subagent subsystem](../../../docs/subsystems/subagent.md) — providers, continuable children, activations, and the authority rules.
- [dsh-tool-subagent](../tool-subagent/README.md) — the model-facing delegation tool this backend is selected by.

<a id="model-experience"></a>
## Model Experience

### Starting a Thread

#### What the model sees

The model sees no new tool from this package. It uses the ordinary delegation tool configured against this provider; the tool's `run_in_background` and `backgroundMode: continuable` settings determine whether a call returns a child id immediately. This backend also gives the tool its `repository` parameter, which names the repository a Thread works in.

#### Token effect

The `repository` parameter costs one fixed entry in the delegation schema; this package adds no tool. A continued Thread's turns cost tokens only inside that child's own session.

#### KV Cache effect

Append-only; the provider changes no model-visible prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **One-shot delegation is unisolated.** A child started through the one-shot path shares the parent's checkout. Use `backgroundMode: continuable`.
- **One repository per Thread.** Each delegation names a single repository, resolved when the Thread starts; a Thread never sees several repositories at once.
- **No merge-back.** The branch is created for the child and left in place; nothing merges it into the selected repository's checkout, and nothing deletes it when a child settles.
- **Removal requires the worktree manager.** This package never removes a worktree during normal operation; removal is an explicit manager call.
- **Uncommitted changes need `baseRef: head-with-uncommitted`.** With the default, a child does not see changes in the parent checkout. Even with it, untracked files are not copied.
- **Write isolation only.** Reads and the network are not isolated; the object store is the child's own inside its directory, and only `/tmp` is shared. A `git push` targets its clone's `origin`, the parent repository's path, which lies outside the child's sandbox root, so the sandbox refuses it, and the worker contract forbids push in any session.
- **One `worktreeRoot` per DSH process.** Several processes sharing one root are not yet coordinated.

<a id="dev-note"></a>
### Dev Note

- Source layout: `src/index.ts` holds the provider, its config schema, and the `prepareContinuable` compensation path.
- Tests drive the provider against a recording `WorktreeService` double and against the real service over temporary git repositories (subdirectory cwd, `head-with-uncommitted`, orphan sweep). The double asserts the two compensation cases directly: an already-aborted signal never reaches `create`, and a signal that aborts after creation triggers `remove(record, { force: true })` before the rejection propagates.

**Runtime invariant:** No companion is published. A Thread's identity, composition, prompt delivery, cold resume, ownership, and disposal belong to the continuation manager, and the record's own state machine and orphan sweep belong to the worktree manager; this package contributes one call that creates the worktree, returns a `cwd`, and removes what it created when that call fails, so it has no independent observation to compare.
