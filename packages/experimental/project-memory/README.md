---
description: "Host-side shared memory for a Project and the memory_read and memory_write tools that let a Project coordinator and its Threads keep decisions in one place."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-project-memory

English | [中文](README.zh.md)

## Summary

Keep the short shared facts of one Project — decisions, agreed constraints, dates, contacts, conventions — where a Project coordinator and every Thread can read and edit them, even though each Thread's sandbox only allows writes inside its own worktree. Models reach the entries through `memory_read` and `memory_write`; a user reaches them through a client panel. Entries survive a restart, a Project holds at most `maxEntries` of them, and anything that is not shared knowledge — file contents, logs, transient progress — belongs in the worktree or the Thread transcript instead.

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

Mount the Host service once, and the tool plugin in each preset whose agents should reach the memory (the Project coordinator preset and the Thread worker preset):

```yaml
- id: project-memory
  name: '@deepseek-ai/dsh-experimental-project-memory'
  config:
    maxEntries: 200
- id: project-memory-tools
  name: '@deepseek-ai/dsh-experimental-project-memory/tools'
  config:
    maxReadBytes: 8192
```

The service needs `storageDomain` and `sessions`. Service settings, all optional:

| Field | Default | Meaning |
|---|---|---|
| `maxEntries` | `200` | Entries kept per Project; adding beyond it fails until one is removed |
| `maxEntryChars` | `500` | Longest entry text in Unicode code points |
| `projectPresets` | `['project']` | Agent preset ids whose Sessions are Project coordinators |
| `maxLineageDepth` | `4` | Parent hops followed while looking for the Project |

Tool settings, all optional:

| Field | Default | Meaning |
|---|---|---|
| `maxReadBytes` | `8192` | UTF-8 byte bound over the complete `memory_read` result, truncation line included (256 through 1000000) |
| `defaultLimit` | `20` | Entries returned when the model omits `limit` |
| `maxLimit` | `100` | Largest `limit` the model may request |

The generated [configuration catalog](../../../docs/config-catalog.md) is the exhaustive source for every accepted field.

### When to choose it

Choose it when a Project's Threads need decisions, agreed constraints, dates, contacts, or conventions that outlive one Thread. Avoid it for file contents, logs, or progress notes; those belong in the worktree or the Thread transcript.

### Project resolution

The Project id is the calling Session's own id when its `agentPreset` is in `projectPresets`. Otherwise the service follows `parentSession`, at most `maxLineageDepth` hops, reading each ancestor from its live Session first and then from its persisted header (live Sessions only when no `sessionPersistence` service is loaded), so a Thread and a helper the Thread started both reach their Project's memory. A Session with no Project in its lineage gets `This session is not part of a Project, so it has no shared memory. Keep notes in your own reply instead.`

### Entries

An entry has an id, the Project id, trimmed text, the last writer's role (`coordinator`, `thread`, or `user`) and Session, and creation and update times. `memory_write` records `coordinator` when the caller is the Project Session and `thread` otherwise. Writes are serialized, so the entry cap holds under concurrent writers.

### Remote methods

`list`, `add`, `update`, and `delete` let a client panel show and edit memory as `user` (`delete`, not `remove`: the client's Remote namespace proxy reserves `remove` for its own descriptor-unmount method). A refused request fails with the Remote code `project-memory/refused` and the stable reason in `details.reason`.

### What success and failure look like

Every refusal is a model-facing error that names the cause and the next action: empty text, text over the limit with its length, a full Project, an unknown id (call `memory_read`), a session outside any Project, and a missing service when the tool plugin is mounted without the Host service.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design philosophy

- **Host storage, not files.** Thread sandboxes cannot write outside their worktree, and a file in the Project worktree would travel with git.
- **Resolve at execution.** The tool plugin injects only `tools`; `projectMemory` is read with `ctx.get` when a tool runs, so the schemas stay stable and a missing service produces an actionable message.
- **Bound the complete result.** `memory_read` drops whole entries until the rendered text, truncation line included, fits `maxReadBytes`.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `ProjectMemoryService`: CRUD, limits, Project resolution, Remote methods, `Config` |
| [`src/storage.ts`](src/storage.ts) | The `project_memory` storage domain and entry validation |
| [`src/errors.ts`](src/errors.ts) | `ProjectMemoryError` |
| [`src/types.ts`](src/types.ts) | Entry, id, and request types |
| [`src/tools.ts`](src/tools.ts) | `memory_read` and `memory_write` (export path `./tools`) |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Storage domain package](../../storage/storage-domain/README.md) — the domain contract this service stores through.
- `@deepseek-ai/dsh-experimental-threads` — the Thread events and projection of a Project Session.
- [Generated tool catalog](../../../docs/tool-catalog.md) — the model-facing schemas.

-----

<a id="model-experience"></a>
## Model Experience

### Tool schemas

#### What the model sees

Two tools, with their exact schemas in the [generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-experimental-project-memory). `memory_read` takes optional `query` and `limit`; its description tells the model to read the memory when it starts a task. `memory_write` takes `action` (`add`, `update`, `remove`), `id`, and `text`; its description says what belongs in memory (decisions, constraints, dates, contacts, conventions) and what does not (file contents, logs, transient progress).

#### Token effect

Fixed schema cost on every request in any Agent that mounts the tool plugin.

#### KV Cache effect

Prefix-stable. Schemas and descriptions do not change at runtime; configured limits are baked in at load.

### Read result

#### What the model sees

One line per entry, newest first: `<id> [<author>, <ISO time>] <text>`. `(no memory entries)` when nothing matches. When `limit` or the byte bound cut entries, the last line reads `(showing <n> of <total> matching entries; narrow with query or raise limit to see more)`.

#### Token effect

Grows with the returned entries, capped by `limit` and by `maxReadBytes` over the whole text.

#### KV Cache effect

Append-only; each result follows the reusable request prefix. Results are logged as ordinary tool results, so a resumed Session replays them.

### Write result

#### What the model sees

`added <id>`, `updated <id>`, or `removed <id>`; errors carry the corrective action.

#### Token effect

One short line per call.

#### KV Cache effect

Append-only; the result follows the reusable request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits are current package constraints, not a task backlog.

- **Lineage needs a stored ancestor** — Project resolution reads live Sessions and persisted headers; a Thread whose parent Session is neither loaded nor stored (or, without a `sessionPersistence` service, not loaded) gets an error asking the user to reopen the Project.
- **No cursor** — `memory_read` cuts one page from the newest entry; older entries are reachable by narrowing with `query`.
- **No access control per entry** — any Thread of the Project can edit or remove any entry; the last writer's role is recorded.
- **No Typert export generated** — the Remote methods are not yet wired into a `./typert` export or a client panel.
- **Experimental prototype with no stability promise** — names, limits, and result text can change while it incubates.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Run the suite from the repository root:

```bash
pnpm vitest run packages/experimental/project-memory
```

`tests/harness.ts` mounts the real service over the in-memory storage backend and drives the tools through `ctx.tools.execute`. The suite pins limits (exact, exceeded, multibyte), persistence across a simulated restart, Project resolution including the depth bound, the byte bound (tiny, exact, multibyte), Remote refusals, and tool disposal across plugin reload.

</details>

**Runtime invariant:** No companion is published. Entries live in the `project_memory` storage domain, which owns the authoritative table; this service keeps no cache and no second copy, so the entry cap, the text bound, and the ownership check each read the domain's own rows inside the call that could break them.
