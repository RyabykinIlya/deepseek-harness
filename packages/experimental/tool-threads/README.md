---
description: "The bounded thread_status, thread_diff, library_list, and thread_tier tools that let a Project model see what its background Threads are doing, inspect what each committed, list its Library, and move one Thread to another model tier, for compositions that mount the Threads domain."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-threads-tool

English | [中文](README.zh.md)

## Summary

Four model tools for a Project coordinator, three of them always present. `thread_status` lists the Project's background Threads with state, branch, and counts. `thread_diff` shows what one Thread committed on its own branch. `library_list` lists the Project's Library: chat attachments, presented files, and the files each Thread changed. `thread_tier` moves one Thread to another model tier and registers only while `@deepseek-ai/dsh-experimental-model-routing` is mounted. Each reads only the calling Project session's own data and bounds the complete rendered result in bytes, naming what was omitted; no unbounded mode exists. Experimental, with no stability promise.

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

Add it beside `@deepseek-ai/dsh-experimental-threads` and `@deepseek-ai/dsh-worktree-manager` in any composition where a Project agent spawns background Threads:

```yaml
- id: threads-tool
  name: '@deepseek-ai/dsh-experimental-threads-tool'
  config:
    maxResultBytes: 8192
```

All settings are optional:

| Field | Default | Meaning |
|---|---|---|
| `defaultLimit` | `20` | `thread_status` rows when the model omits `limit` (ceiling 100) |
| `maxLimit` | `100` | Largest `limit` the model may request (ceiling 100) |
| `maxResultBytes` | `8192` | UTF-8 byte bound over the complete rendered result of `thread_status`, `thread_diff`, and `library_list`, footer included (1024 through 32768); `thread_tier` renders one line and applies no bound |
| `maxCommits` | `30` | Commits `thread_diff` lists (ceiling 100) |
| `maxFiles` | `100` | Changed files `thread_diff` lists (ceiling 500) |
| `maxPatchBytes` | `16384` | Bytes of one file patch `thread_diff` reads (256 through 65536) |
| `maxOverviewThreads` | `20` | Threads the `thread_diff` overview reads; each costs git calls (ceiling 100) |
| `maxPairChecks` | `50` | Overlapping Thread pairs the overview runs a merge check on (ceiling 200) |
| `libraryDefaultLimit` | `20` | `library_list` entries per shown section when the model omits `limit` (ceiling 100) |
| `libraryMaxLimit` | `100` | Largest per-section `limit` the model may request from `library_list` (ceiling 100) |

Every value is clamped to its ceiling in code, so no configuration can recreate an unbounded listing. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-threads-tool) is the exhaustive source for every accepted field and its JSDoc.

### When to choose it

Choose it when the model must survey outstanding work across background Threads and review a Thread's result before merging it. Avoid it when the children are continuable subagents: `list_agents` and `send_message` already describe those.

### What the model sees

`thread_status` takes two optional parameters:

| Parameter | Type | Meaning |
|---|---|---|
| `status` | `running`, `idle`, `completed`, `aborted`, `error`, `max-tokens`, `refusal` | Exact state filter; omit for every state |
| `limit` | integer 1–100 | Rows to return; defaults to `defaultLimit` |

It renders one line per Thread in creation order; branch, counts, and note appear only when known:

```
<threadId> [<state>] <label> | branch <branch> | <n> commits ahead, <m> uncommitted | note: <closing message start>
```

When a limit or the byte bound dropped rows, the last line names them:

```
(3 of 5 threads omitted; filter by state or raise limit)
```

A Project that owns no Threads renders `(no threads)`.

`thread_diff` takes an optional `thread_id` and an optional repo-relative `path` (which needs `thread_id`). Without `path` it renders the merge command, base and head commits, commits newest first, and committed files with line counts. With `path` it renders the committed patch of that file, ending in a marker that names the `git -C` command for the rest when the patch was cut. The worktree path is printed once in the summary, where the uncommitted count points to it, and in the truncation marker.

Without `thread_id`, `thread_diff` renders an overview to read before merging several Threads: per Thread commits, files, and uncommitted counts; committed paths touched by two or more Threads; a merge prediction into the Project checkout's `HEAD` and between overlapping Threads (`git merge-tree --write-tree`, git 2.38+; older git still gets overlaps); skipped Threads with the reason; and a merge order that puts Threads with no overlap and no predicted conflict first, then the rest by fewest overlaps. Committed work only; the overview is cut to `maxResultBytes` with an omission line.

`library_list` takes two optional parameters:

| Parameter | Type | Meaning |
|---|---|---|
| `section` | `attachments`, `presented`, `changes` | List only this section of the Library; omit for all three |
| `limit` | integer 1–100 | Entries per shown section; defaults to `libraryDefaultLimit` |

It renders one block per requested section, separated by a blank line, each headed `<section> (<total>):` and then one line per entry: an attachment as its id, `image` or `file`, its name or `(unnamed)`, its byte size, and an ISO timestamp; a presented file as its path, its description when it has one, `presented by the Project` or `presented by thread <threadId>`, and an ISO timestamp; a Thread's changes as its id, `live` or `archived`, its label, its branch, its commit and uncommitted counts, and up to five changed paths followed by `(+<n> more)`. An empty section renders `(no attachments)`, `(no presented files)`, or `(no Threads with changes)`; a cut section ends in `(<n> of <total> <noun> omitted; raise limit or request this section alone)`.

`thread_tier` takes `thread_id` from `thread_status` and a `tier` name such as `pro` or `flash`; neither is marked required in the schema, so a call that omits either fails with `thread_tier needs both thread_id and tier`. It renders one line, `Thread <threadId> switches to tier <tier> from its next model request.`, and applies no byte bound. The tool records the decision through `modelRouting.setThreadTier` rather than touching the Thread: the Thread keeps its worktree, branch, and history, and the new tier applies when its next model request is built.

### State and liveness

`running` comes from the runtime (`ctx.threads.isRunning`), never from the log. Otherwise the state is the outcome of the last finished turn: `completed`, `aborted`, `error`, `max-tokens`, or `refusal`. `idle` means not running and no outcome recorded yet.

### What success and failure look like

A missing capability fails loudly rather than reading as an empty Project. If the Threads domain is absent, the call is an errored result naming the package to load; `thread_status`, `thread_diff`, and `thread_tier` also fail when the `threads` Session projection is unavailable, while `library_list` does not read that projection and so does not require it. `thread_diff` names `@deepseek-ai/dsh-worktree-manager` when it is absent, `thread_tier` names `@deepseek-ai/dsh-experimental-model-routing` when `ctx.get('modelRouting')` finds no service at call time, and a tier name the routing service does not accept fails with that service's own message. A `thread_id` outside the caller's projection fails with `unknown thread id; call thread_status`, in `thread_diff` and in `thread_tier` alike. An archived or missing worktree fails with the branch to inspect with `git log`. An out-of-range `limit` from `thread_status` or `library_list`, and an unsafe `path`, are refused before anything is read.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the adapter; the observable behavior is covered in [Use this package](#use-this-package).

### Design philosophy

The adapter is built on three commitments:

- **One caller, one page.** `thread_status`, `thread_diff`, and `thread_tier` read `ctx.threads.viewOf(exec.agent.session)`, and `library_list` reads `threads.library({ projectId: exec.agent.session.id })`. A second Project's Threads and Library are not reachable, because the session is derived from the calling Agent rather than taken from the arguments, and `thread_diff` and `thread_tier` accept only ids present in that projection.
- **Bounded where the whole value is known.** Row, commit, and file counts have ceilings, free text is shortened per item, and the byte bound is applied to the complete rendered text: whole rows, commits, or files are dropped until the text including its footer fits, and a patch is cut at a UTF-8 code-point boundary leaving room for its header and marker.
- **Absence is an error.** The tools turn a missing capability into a failure, never an empty list.

### Registration shape

The package-level `inject` is `['tools']`, so `thread_status`, `thread_diff`, and `library_list` are registered for as long as the package is loaded. `src/tier.ts` nests `ctx.inject(['modelRouting'], …)`, so `thread_tier` appears and disappears with that service. `ctx.threads`, `ctx.worktrees`, and `ctx.modelRouting` are read with `ctx.get` at execution time, so the schemas stay stable and a missing service produces an actionable message instead of an unknown-tool error.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config, the three unconditional tool registrations, service access, path validation |
| [`src/status.ts`](src/status.ts) | `thread_status` entries, state resolution, rendering, and byte fitting |
| [`src/diff.ts`](src/diff.ts) | `thread_diff` summary and patch rendering and byte fitting |
| [`src/overview.ts`](src/overview.ts) | `thread_diff` overview collection, merge prediction, merge order, rendering, and byte fitting |
| [`src/library.ts`](src/library.ts) | `library_list` sections, entry projection, per-section rendering, and the byte cut that drops `changes` first |
| [`src/tier.ts`](src/tier.ts) | `thread_tier` registration under `ctx.inject(['modelRouting'], …)`, the caller-ownership check, and the recorded switch |
| [`src/text.ts`](src/text.ts) | UTF-8 length, cut, and single-line helpers |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the model tools down to the services they read.

- `@deepseek-ai/dsh-experimental-threads` — the `threads` projection, `ThreadStatusRow`, and `isRunning`.
- `@deepseek-ai/dsh-worktree-manager` — the `get`, `changes`, and `filePatch` reads behind `thread_diff`.
- `@deepseek-ai/dsh-subagent-thread-worktree` — the provider that creates a worktree per Thread.
- [Generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-experimental-threads-tool) — the model-facing schemas.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-threads-tool) — every accepted config field.

-----

<a id="model-experience"></a>
## Model Experience

### Tool schemas

#### What the model sees

Four tools; their schemas and descriptions are in the [generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-experimental-threads-tool). `thread_status`, `thread_diff`, and `library_list` are registered whenever the package is loaded; `thread_tier` is registered inside `ctx.inject(['modelRouting'], …)`, so the model sees it only while `@deepseek-ai/dsh-experimental-model-routing` is mounted and loses it again when that plugin unmounts. The descriptions tell the model that Threads report back on their own when they finish, that output is bounded and says what was omitted, that a Thread's work stays on its branch until the model merges it, that `library_list` only reports what the Library already holds and never fetches a path the model supplies, and that a tier switch applies from the Thread's next model request and discards that Thread's prompt cache.

#### Token effect

Fixed schema cost for the three unconditional tools on every request in any Agent that can reach them. They are global registrations, so a composition that mounts this package pays it in every session, including child sessions that own no Threads. `thread_tier` costs its schema only in a composition that also mounts the model-routing plugin.

#### KV Cache effect

Prefix-stable. Schemas and descriptions do not change at runtime; only the configured limits are baked into the parameter descriptions at load. Mounting or unmounting the model-routing plugin adds or removes the `thread_tier` schema, so a prefix built under one of those topologies is not the prefix sent under the other.

### Status result

#### What the model sees

One line per returned Thread: id, state, label, and, when known, branch, commits-ahead and uncommitted counts, and the start of the closing message. `(no threads)` for a Project that owns none. A shortened page appends `(<n> of <total> threads omitted; filter by state or raise limit)`.

#### Token effect

Grows with the returned page, capped by `limit` and by `maxResultBytes` (default 8192 bytes) over the whole text. Labels are capped at 160 bytes and notes at 320 bytes per row.

#### KV Cache effect

Append-only; each result follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Diff result

#### What the model sees

The summary shows the merge command, base and head commits, up to `maxCommits` commit subjects, and up to `maxFiles` committed files with line counts, each list followed by an omitted count when cut. The `path` form shows the committed patch of one file, cut at `maxPatchBytes` and `maxResultBytes` with an explicit marker.

#### Token effect

Grows with the commits, files, or patch returned, bounded by `maxResultBytes` over the whole text.

#### KV Cache effect

Append-only; each result follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Library result

#### What the model sees

One block per requested section, each headed `<section> (<total>):` and then one line per entry: an attachment as its id, `image` or `file`, its name or `(unnamed)`, its byte size, and an ISO timestamp; a presented file as its path, its description when it has one, `presented by the Project` or `presented by thread <threadId>`, and an ISO timestamp; a Thread's changes as its id, `live` or `archived`, its label, its branch, its commit and uncommitted counts, and up to five changed paths followed by `(+<n> more)`. An empty section renders `(no <noun>)`, and a cut section ends in `(<n> of <total> <noun> omitted; raise limit or request this section alone)`.

#### Token effect

Grows with the entries of each shown section, capped by `limit` per section (`libraryDefaultLimit`, default 20, ceiling 100) and by `maxResultBytes` over the whole text. Attachment names are capped at 160 bytes, presented paths and descriptions at 200 bytes each, Thread labels at 120 bytes, and inlined file names at five per Thread. The byte cut drops whole entries from `changes` first, then `presented`, then `attachments`, because an inlined file list makes a `changes` entry the most expensive one.

#### KV Cache effect

Append-only; each result follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Tier result

#### What the model sees

One line, `Thread <threadId> switches to tier <tier> from its next model request.` A `thread_id` outside the calling Project's Threads fails with `unknown thread id <threadId>; call thread_status to list this Project's threads`, and a tier name the routing service does not accept fails with that service's own message, so the result carries no other text.

#### Token effect

One short line per call, with only the Thread id and the tier name varying. No listing is read and no byte bound applies.

#### KV Cache effect

Append-only for the calling Project: the line follows the reusable request prefix and does not invalidate existing KV-cache entries. For the switched Thread the effect is elsewhere — the decision is recorded in the Project log and read when that Thread's next request is built, so its following requests go to another model and cannot reuse the prefix cached under its previous tier, which is the cost the tool description names.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits describe what the tools cannot tell a Project model. They are current package constraints.

- **No cursor** — `limit` and the byte bound cut one page from the start, so rows past the cut are reachable only by narrowing with `status`.
- **Creation order only** — the newest Threads come last and may fall outside a truncated page.
- **Committed work only** — `thread_diff` patches show `baseSha..HEAD`; uncommitted files are only counted, and the Thread must commit them before the Project can merge them.
- **Counts are last-reported** — `commitsAhead` and `uncommitted` in `thread_status` are the values recorded at the last status event, not read from git at call time; `thread_diff` reads git live.
- **Experimental prototype with no stability promise** — the tool names, state vocabulary, and result text can change freely while it incubates.
- **No shipped composition mounts it** — a deployment opts in explicitly.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Run the suite from the repository root:

```bash
pnpm vitest run packages/experimental/tool-threads
```

`tests/threads-tools.spec.ts` appends real `thread/*` events to real Agent-owned sessions, supplies a fake worktree service, and drives both tools through `ctx.tools.execute`. It pins the rendered text, the filter-before-limit order, tiny, exact, and multibyte byte bounds, patch truncation, capability-absence failures, and teardown.

The `status` enum is the rendered vocabulary, not a field on the row. If a new `ThreadStopReason` is added to `@deepseek-ai/dsh-experimental-threads`, add it to `THREAD_STATES` in `src/status.ts` too.

</details>

**Runtime invariant:** No companion is published. Each call renders from nothing this package kept: the `threads` rows, the live registry answer, and the git reads all belong to their own services, and no value survives between invocations, so the only relations available to check are the ones the same call just computed.
