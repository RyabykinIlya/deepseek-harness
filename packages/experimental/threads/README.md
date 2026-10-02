---
description: "Project a Project Session's background Threads as a durable status read model, write the log-only Thread events from the Thread provider's lifecycle, and archive Threads."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-threads

English | [中文](README.zh.md)

## Summary

`dsh-experimental-threads` is the domain layer of the Threads feature: the log-only `thread/*` session events a Project Session records for its background Threads, the `threads` Session projection that folds them into a durable status read model, the listener that writes those events from the Thread provider's `subagent/start` and `subagent/end`, live liveness, and the `threads.archive` Remote method. It contributes no model tools and starts no agents. It is published under its experimental name and carries no stability promise.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Add this package when a Project Session owns background Threads whose status must be readable from one place, without asking any Thread's transcript. Mount it beside durable session storage:

```yaml
# smallest threads setup — durable storage plus the domain package
- name: '@deepseek-ai/dsh-session-persistence-jsonl'
- name: '@deepseek-ai/dsh-experimental-threads'
```

### When to choose it

Choose it when a session needs a whole, replayable value describing background work it spawned — a list of Threads with their branch, worktree, and last known outcome. Avoid it when you need a Thread's transcript (this layer deliberately never carries one), when status must reflect a live agent registry rather than what the durable log recorded, or when per-Thread isolation of the filesystem is the requirement — no worktree is created here.

<a id="status-rows"></a>
### Status rows

`threads` publishes one row per Thread. Every field is a durable fact; liveness is not part of the row.

| Field | Meaning |
|---|---|
| `threadId` | Durable Thread identity (the child Session id) |
| `label` | The task this Thread was given at spawn |
| `stopReason` | Outcome of the last finished turn (`completed`, `aborted`, `error`, `max-tokens`, `refusal`); absent before the first one |
| `branch` | `dsh/<thread-short>`, absent for a detached worktree |
| `worktree` | Absolute path of the Thread's working directory |
| `baseSha` | Commit the worktree was created at |
| `commitsAhead` | Commits on the worktree HEAD since `baseSha`, as of the last settlement |
| `uncommitted` | Uncommitted entries in the worktree, as of the last settlement |
| `note` | Bounded start of the Thread's closing message |

The session-level `interrupted` reason reaches the row as `aborted`.

<a id="liveness"></a>
### Liveness

`ctx.threads.isRunning(threadId)` is true while the Thread's Agent is registered and a driver is active. It is computed from the runtime on every call and never persisted, so a Thread that died with its process reads as not running after a restart. A client derives the same flag from its own session list; it must not wait for a `thread/status` event to learn that a turn started.

<a id="reading-threads"></a>
### Reading Thread status

Through the service:

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ThreadsService } from '@deepseek-ai/dsh-experimental-threads'

declare const ctx: Context
declare const session: Session

// host: whole durable state, and the client-visible rows
const state = ctx.threads.stateOf(session)
const rows = ctx.threads.viewOf(session)
```

Through the registry directly:

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import type { ThreadsService } from '@deepseek-ai/dsh-experimental-threads'

declare const ctx: Context
declare const session: Session

// the client wire value, at one consistent cut
const { values } = ctx.sessionProjections.snapshot(session, ['threads'])
```

A browser package takes those types from the `./client` subpath, which re-exports `ThreadStatusRow`, `ThreadStopReason`, and `ThreadId` and nothing else. `./client` exists because `src/types.ts` also carries the Host-only `declare module` augmentations of `@deepseek-ai/dsh-typert-protocol` and `@deepseek-ai/dsh-session-projection/types`; a Client importing that module directly would pull both into a browser build whose `node_modules` carries neither. The `threads` Remote namespace is reached separately, through the generated `./remote` contribution.

<a id="publishing-threads"></a>
### Thread events

The listener on `subagent/start` and `subagent/end` writes the events itself; nothing else needs to append them. It reacts only to runs whose `info.provider` equals the `providerName` config, and it needs the `sessionProjections` registry so it can skip a Thread the Project already holds.

| Edge | Event appended to the Project Session |
|---|---|
| first `subagent/start` of a Thread | `thread/created { threadId, label, worktree, branch, baseSha }`; `label` is the child's frozen creation label, `worktree` its cwd, `branch` and `baseSha` come from `ctx.worktrees.get` when that service is loaded |
| `subagent/end` | `thread/status { threadId, stopReason, note }`, appended without yielding when the creation is complete |
| shortly after `subagent/end` | `thread/status { threadId, commitsAhead, uncommitted }` from `ctx.worktrees.status`, best effort |

A resumed Thread starts a new residency epoch and emits `subagent/start` again; the listener finds the Thread in the projection and appends no second `thread/created`. All events carry `ignorable: true` and are never joined into the model-visible surface. A failure inside a listener is logged as a warning and never reaches the subagent runtime.

<a id="archive"></a>
### Archive a Thread

```ts
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { ThreadsService, ThreadId } from '@deepseek-ai/dsh-experimental-threads'

declare const ctx: Context
declare const projectAgent: Agent
declare const threadId: ThreadId

// client: ctx.remote.threads.archive(projectSessionId, threadId, { force })
await ctx.threads.archive(projectAgent, threadId, { force: false })
```

`archive` checks that the Thread is in the Project's `threads` projection, refuses a dirty worktree unless `force` is set, interrupts a running Thread under the Project's user authority and waits up to `archiveStopTimeoutMs`, removes the worktree through `ctx.worktrees.remove`, and appends `thread/removed`. The Thread's branch and Session are kept. Failures are `RemoteError`s: `threads/not-found { threadId }`, `threads/worktree-dirty { threadId }` (nothing was changed), and `threads/stop-timeout { threadId }` (the worktree was left in place). Without the worktrees service, `archive` throws.

`library` (`ctx.remote.threads.library({ projectId })`) is a read model for a Project Session with nothing stored. It returns three bounded sections, each `{ items, total, truncated }`: the images and files the user sent in the Project chat (`attachmentId`, name, media type, bytes); the files declared with `present` by the Project and by its Threads (`path`, `description`, presenting `sessionId` and `threadId`, `seq` and `index` that address the present-open route, time); and the changed files of each Thread, read from `ctx.worktrees.changes` for a live worktree and from the Thread's last `workspace/changes` summary when it is archived and still served, otherwise omitted. Thread sessions are read from live sessions first and `ctx.sessionPersistence` second. An unknown id or a preset outside `projectPresets` fails with `threads/project-not-found { projectId, reason }`. Present-open verifies a path against the presenting Session's workspace root and accepts absolute paths, so a worktree file outside the workspace may be refused.

<a id="configuration"></a>
### Configuration

| Key | Default | Meaning |
|---|---|---|
| `providerName` | `thread` | Subagent provider whose children are Threads |
| `noteMaxBytes` | `600` | Maximum UTF-8 size of `note`, ellipsis included; text is whitespace-collapsed and cut at a code point |
| `archiveStopTimeoutMs` | `30000` | How long `archive` waits for a running Thread to stop |
| `projectPresets` | `['project']` | Agent presets whose Sessions `library` accepts as Projects |
| `libraryMaxAttachments` | `200` | Attachments listed by `library` |
| `libraryMaxPresented` | `200` | Presented files listed by `library` |
| `libraryMaxThreads` | `50` | Newest Threads whose logs and worktrees `library` reads |
| `libraryMaxFiles` | `100` | Changed files listed per Thread by `library` |

-----


<a id="understand-the-implementation"></a>
## Understand the implementation

### Design philosophy

The unit is a fold, not a query. It never reads a live agent registry, another session's log, or the filesystem, so a cold read from a stored log reproduces exactly what the live drive produced. That is what makes `note` trustworthy: it is the text the provider durably recorded, not a value guessed at render time.

`apply` returns the **identical state reference** for any event outside the `thread/*` domain. An unchanged reference is what suppresses all downstream work, so the rule is load-bearing rather than an optimization.

### Source map

<a id="source-map"></a>

| Path | Role |
|---|---|
| [`src/types.ts`](src/types.ts) | `ThreadId`, the client row, the remote error codes, and the `SessionEventMap` / `SessionProjectionMap` merges |
| [`src/projection.ts`](src/projection.ts) | `ThreadState`, the pure fold, the Zod schemas, and `threadsProjectionDefinition` |
| [`src/lifecycle.ts`](src/lifecycle.ts) | The `subagent/start` / `subagent/end` listener that appends `thread/*` events |
| [`src/note.ts`](src/note.ts) | `threadNote`, the bounded single-line note |
| [`src/index.ts`](src/index.ts) | `ThreadsService`: registration, `isRunning`, and the `archive` Remote method |
| [`src/client.ts`](src/client.ts) | The `./client` subpath: the client-safe `ThreadStatusRow`, `ThreadStopReason`, and `ThreadId` types, without the Host-only module augmentations |

### Merge extension, not modification

Both type tables are declaration-merged, so this package adds keys without editing `dsh-session` or `dsh-session-projection`:

```ts
import type { ThreadId, ThreadStopReason } from '@deepseek-ai/dsh-experimental-threads'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'thread/created': { threadId: ThreadId; label: string; worktree?: string; branch?: string; baseSha?: string }
    'thread/status': { threadId: ThreadId; stopReason?: ThreadStopReason; note?: string; commitsAhead?: number; uncommitted?: number }
    'thread/removed': { threadId: ThreadId }
  }
}
```

### Merging status reports

`thread/status` is a partial update: a field absent from the event keeps its value. The one exception is a report that carries a `stopReason`: it closes a turn, so it replaces the previous `note` with its own (or none), and a note never outlives its turn.

### Fold totality

A `thread/status` for a Thread this log never created, and a `thread/removed` for an unknown Thread, are both ignored and return the same reference. The fold never throws mid-replay, because a throw during `restore` would leave a cold read with no value at all.

### Registration and capability absence

The unit is installed through `ctx.inject(['sessionProjections'], …)`, so registration rides the injected fiber. A headless assembly without the registry is unaffected, and unloading this plugin makes the key disappear from subsequent drives and snapshots — which clients read as capability absence, not corruption.

### Durability

Host state is plain JSON (the persisted-cache precondition) and is checkpointed with the session. `stateVersion` is `2`; bump it whenever the serialized state fields or the fold semantics change, so persisted `(sessionId, key, ver, seq, val)` rows from an older unit are discarded and refolded instead of being forward-applied into garbage. Registering the same key at a *different* `stateVersion` throws, which is the cross-plugin single-version constraint; registering it again at the same version is a counted share.

## Model Experience

### Thread lifecycle events

#### What the model sees

Nothing. `thread/created`, `thread/status`, and `thread/removed` are log-only, appended with `ignorable: true`: they are recorded and folded for clients, and the request assembly never joins them into the model-visible surface. The Project's model learns that a Thread settled from the settlement notice the subagent runtime sends as an ordinary message.

#### Token effect

Zero direct effect: this package registers no prompt section, tool schema, or message.

#### KV Cache effect

Nothing here enters a model request, so provider cache reuse is unaffected.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Liveness is not in the log.** After a crash the log still shows the last settled outcome; `isRunning` answers only for Agents registered in the current process.
- **No label rename.** `label` is set by `thread/created` and is not changeable through `thread/status`; a rename needs either a `label` field on the status event or a dedicated event.
- **No transcript, and no ordering guarantee between Threads.** Rows keep durable creation order; there is no recency ordering.
- **Worktree facts are a settlement snapshot.** `commitsAhead` and `uncommitted` are read once after `subagent/end`; they go stale while the Project edits the worktree, and a Project that is not registered at that moment gets no report.
- **An archived Thread can reappear.** Its session is kept, so resuming it emits `subagent/start` again and appends a new `thread/created`.
- **The writer needs the projection registry.** With no `sessionProjections` service (or with this plugin unloaded) no `thread/*` event is appended at all: the projection is the only way to tell whether a Project already holds the Thread. A composition that wants the events must load the registry.
- **The Remote method needs an `api-remotes` mount.** The package exports `./remote` and `./types`; a Client sees `ctx.remote.threads` only when the `api-remotes` assembly imports them.

-----


<a id="dev-note"></a>
### Dev Note

Run the suite from the repository root:

```bash
pnpm vitest run packages/experimental/threads
```

`tests/fold.spec.ts` exercises the pure fold directly; `tests/registry.spec.ts` drives it through the real `ctx.sessionProjections` registry, including checkpoint/tail restore and the `stateVersion` guards; `tests/plugin.spec.ts` covers registration and capability absence; `tests/lifecycle.spec.ts` drives the real continuable-subagent path with a fake worktree service to cover the emitter, note bounds, resume idempotency, plugin disposal, liveness, and archive.

**Runtime invariant:** No companion is published. The fold is total and derives every row from the committed event prefix alone, and each fact copied into an event — the worktree path, the branch, the base commit, the commit and uncommitted counts — is read once while that event is appended and never re-observed, so the package keeps no second observation that could drift from the log it was derived from.