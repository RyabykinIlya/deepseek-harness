---
description: "Compose a Project and its Threads: a coordinator preset with the Thread tools and contracts, and a worker preset a Thread is composed from."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-threads-preset

English | [中文](README.zh.md)

## Summary

A **Project** is an ordinary Session whose agent was composed from this package's `project` preset — no new session kind, no persistence change. The registry stamps the preset id into `SessionHeader.agentPreset`, which is how a client matches a Project. `project` is the coordinator: a contract on splitting a goal into Threads and integrating them, `subagent` retargeted at the worktree-isolated `thread` backend, the bounded `thread_status` / `thread_diff` reads, the memory tools, and the steering tools. `project-thread` is the worker every Thread child is composed from, with no Thread tool and no `thread` delegation. The Host half is the [profile bundle](../threads-profile/README.md).

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

Mount this row beside the [Threads profile bundle](../threads-profile/README.md), which supplies the Host rows the presets consume and points `childAgentPreset` at the worker id:

```yaml
- insert:
    - id: threads-preset
      name: '@deepseek-ai/dsh-experimental-threads-preset'
      config:
        id: project
        workerId: project-thread
        provider: thread
        basePreset: standard
```

A client then selects `project` for a session, and a Thread child is composed from `project-thread` because the provider asks for it:

```ts
import type { AgentSetup } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { PROJECT_PRESET_ID } from '@deepseek-ai/dsh-experimental-threads-preset'

declare const ctx: Context
declare const sessionId: SessionId
declare const mount: AgentSetup

await ctx.agents.create({ sessionId, meta: { agentPreset: PROJECT_PRESET_ID }, setup: mount })
```

| Field | Default | Meaning |
|---|---|---|
| `id` | `project` | Coordinator preset identity recorded in `SessionHeader.agentPreset` |
| `name` | `Project` | Coordinator roster display name |
| `description` | see source | Coordinator roster display description |
| `order` | `20` | Coordinator roster sort position |
| `workerId` | `project-thread` | Worker preset id; the `thread` provider's `childAgentPreset` must name it |
| `workerName` | `Project Thread (internal)` | Worker roster display name |
| `workerDescription` | see source | Worker roster display description |
| `workerOrder` | `1000` | Worker roster sort position, after every preset meant for a person |
| `provider` | `thread` | Subagent provider the coordinator's `subagent` row targets |
| `basePreset` | unset | Already-registered preset whose rows both presets extend, for example `standard` |
| `workerMaxDepth` | unset | Delegation depth cap for the `subagent` row a Thread inherits; the Host default of 1 rejects a Thread's helpers |
| `checkIn` | `milestones` | Coordinator contract: `milestones`, `each-thread`, or `quiet` |
| `spawn` | `ask` | Coordinator contract: `ask` or `auto` |
| `mergePolicy` | `ask` | Coordinator contract: `ask` or `auto` |
| `tools` | `{ defaultLimit: 20, maxLimit: 100 }` | Config of the `thread_status` / `thread_diff` row; that plugin validates every key |
| `threadProvider`, `threadModel`, `threadReasoningEffort`, `threadMaxTokens` | unset | Model options for every Thread; all four are required together |

`basePreset` exists because the Web agent plane disables its tool rows in the host composition and mounts them per preset instead. A deployment whose tools are global rows omits it, and each Threads preset then contributes only its own rows.

### What the presets mount

| Row id | Package | Role |
|---|---|---|
| `thread-contract` | this package's `./threads-contract` subpath | `threads:contract` in the coordinator, `threads:worker-contract` in the worker |
| `tool-subagent` | `@deepseek-ai/dsh-tool-subagent` | The ordinary delegation tool, repointed at the `thread` provider in continuable background mode |
| `tool-threads` | `@deepseek-ai/dsh-experimental-threads-tool` | `thread_status` and `thread_diff`, the bounded reads of Thread state |
| `tool-subagent-control` | `@deepseek-ai/dsh-tool-subagent-control` | `send_message` and `interrupt_agent`, the only handles on a running Thread |
| `project-memory-tools` | `@deepseek-ai/dsh-experimental-project-memory/tools` | `memory_read` and `memory_write` over the Project memory, in both presets |

The coordinator keeps the base rows except those it replaces: `tool-subagent` (repointed), `tool-subagent-fork` (a fork child would run in the Project checkout with no worktree) and `tool-subagent-list-agents` (`thread_status` is its bounded replacement). It mounts `tool-subagent-control` itself only when the base rows do not already carry it. The worker keeps every base row unchanged, so its `subagent` stays on the shipped `spawn` provider.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The declaring row: reads the base rows, registers both presets, owns their disposers |
| [`src/project-preset.ts`](src/project-preset.ts) | Row assembly for both presets, the preset ids, and the published row specifiers |
| [`src/threads-contract.ts`](src/threads-contract.ts) | The contract texts, their sentence variants, and the runtime-context row |
| [`tests/project-preset.spec.ts`](tests/project-preset.spec.ts) | Mounts both presets through the real roster and reads one agent's scope |

Properties that shape the design:

- **Every row contributes a tool or a prompt, never a service.** A preset that published a service into the root realm would fail its own mount, and the services a Project consumes — `tools`, `subagents`, `systemPrompt`, `sessionProjections` — are all Host-plane.
- **The contracts are runtime contexts, not system-prompt sections**, for the same reason `SUBAGENT_DELEGATION_CONTEXT` is one: the deployment's system prompt stays uniform across a Project and the Threads it spawns, and these are facts about the agent reading them. A `PromptContext` is also scope-shadowed, so a session on another preset never sees a contract.
- **The contract text is a pure function of the row's `Config`**, never of the session, so the assembled prefix is stable across turns and restarts.
- **`basePreset` is read through `agentPresets.readDocument`** and parsed with `entryListSchema`, so `!!js` conditions such as `disabled: !!js process.platform === 'win32'` survive into both presets instead of being flattened to the truth value of the reading process.

The declared rows name their *published* package specifiers, which is what a profile resolves. Running from `src`, `row()` hands the Loader the same code by path instead, because the Loader imports rows through Node's ESM resolver, which never resolves a bare specifier to a package's `src` — and the experimental packages have no `lib/` in a working tree. `PROJECT_PRESET_ROW_NAMES` is the published identity, and the suite asserts it beside the mounted rows.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Experimental packages](../README.md) — incubation status and publication policy.
- [Threads profile bundle](../threads-profile/README.md) — the Host rows these presets consume.
- [Threads service](../threads/README.md) — the log-only events and the durable status read model.
- [Threads tools](../tool-threads/README.md) — the bounded `thread_status` and `thread_diff` surfaces.
- [Agent preset](../../preset/agent-preset/README.md) — the declaration contract a preset is written against.
- [System prompt assembly](../../../docs/subsystems/system-prompt.md) — the section and runtime-context ordering rules.

-----

<a id="model-experience"></a>
## Model Experience

### The two contracts

#### What the model sees

A Project sees one runtime context named `threads:contract`. It states that the Project coordinates the work; that a Thread is a background agent in its own git worktree on its own branch whose edits reach the checkout only through a merge; that the model should restate the goal, propose a split, and start Threads with the `subagent` tool, which is asynchronous and returns an id rather than the work; that a Thread reports back on its own when it finishes, so the model must not poll in a loop; that `thread_status` is bounded and may omit Threads; that `thread_diff` reviews a finished Thread; that integration is `git merge --no-ff <branch>` with conflicts resolved and tests run, and that a merge order is proposed when several Threads touched the same files; and that archiving a merged Thread is done by the user from the interface. A Thread sees one runtime context named `threads:worker-contract`. It states that the model is a Thread of a Project working on one delegated task, that its checkout and branch are its own, that it commits each finished step, that it does not push or touch other branches unless asked, and that when it is done it sends its parent a self-contained summary with `send_message`: what changed, how it was verified, the remaining risks, and the branch name from `git branch --show-current`. Three sentence variants come from this row's `Config`: the check-in cadence (`milestones`, `each-thread`, `quiet`), whether the model waits for approval before starting Threads (`ask`, `auto`), and whether it asks before merging (`ask`, `auto`); each variant is a fixed sentence swapped into the contract, and the rest of the text is identical. The delegation description, the schema, and the `thread_status` schema belong to the rows these presets mount, not to this package.

#### Token effect

The coordinator contract is under 2 kB of prompt text, added once per Project session and only for Project sessions. The worker contract is under 0.8 kB, added once per Thread. Both cost nothing on a session that selected another preset.

#### KV Cache effect

Each contract is a static string per deployment configuration, so a Project's or Thread's assembled prefix is stable across turns and restarts. The variants are deployment choices: changing one changes the prefix once, for sessions composed after the change.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Not a profile** — the presets declare rows they do not supply. Without the [Threads profile bundle](../threads-profile/README.md) on the Host plane, `subagent` never appears in the model-facing tool list, because a delegation tool with no matching provider is not registered at all.
- **The worker preset appears in the roster** — the preset registry has no hidden flag, so `project-thread` is listed beside every preset a person may choose. It is ordered last (1000) and named "Project Thread (internal)" to keep it out of the way, but a user can still select it and get a session with the worker contract and no Thread tools.
- **No new session kind** — a Project is a preset choice, and a client that renders a different Project affordance matches on `SessionHeader.agentPreset`. Nothing in the persistence format distinguishes a Project.
- **The roster is user-editable** — a profile may insert this composition under another id, and that session is then not a Project under the name `'project'`. Match the id, not the package. A profile that renames the worker id must also restate the provider's `childAgentPreset`, or a Thread falls back to inheriting its parent's preset.
- **Isolation is the backend's guarantee, not the preset's** — the presets state the worktree rule to the model and mount the tool; the worktree itself is created and rolled back by `@deepseek-ai/dsh-subagent-thread-worktree`.
- **A completed Thread is not merged** — the worktree and branch survive the Thread, and porting the change back to the Project checkout stays a manual git step the model performs.
- **`basePreset` is read once, at load** — a base preset edited afterwards does not propagate into the already-mounted Threads presets; reload the row to pick the change up.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The `threads:contract` order is a literal `130`, not a `getContextOrder()` name. `dsh-system-prompt` owns that central table and its generated catalog, and an incubating package adding a key there would couple its release to a core allocation; the literal sits in the same band (sandbox 110, approval 115, subagent delegation 120) and the suite asserts it stays above the last allocated slot.

Run the suite from the repository root:

```bash
pnpm vitest run packages/experimental/threads-preset
```

</details>

**Runtime invariant:** No companion is published. The package contributes no service and emits no event: it reads the base rows once at load, registers the two presets, and owns only their disposers, so every mutable relationship a mounted row creates is held by the subagent registry, the tool registry, or the session projection registry.
