---
description: "Enable worktree-isolated background Threads, their status tools, and the Web roster with one experimental bundle that changes no ordinary session."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-threads-profile

English | [中文](README.zh.md)

## Summary

Install the Threads feature as one unit: the worktree service, the `threads` Session projection, the worktree-isolated continuable-subagent backend, the Web Thread roster, and the two agent presets. It only inserts rows, so an ordinary preset behaves the same without it, and unlike the Agent Teams bundle it does not ship in the dsh installation.

`project` is the coordinator: `subagent` on the `thread` provider, `thread_status` and `thread_diff`, the memory and steering tools, and the coordinator contract. `project-thread` is what every Thread child is composed from, with no Thread tool and no `thread` delegation; this layer points `childAgentPreset` at it.

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

### Install into a profile

Add the package to an initialized profile that already composes the agent plane, then run a task that asks the agent to coordinate background work:

```sh
dsh plugin --profile web add @deepseek-ai/dsh-experimental-threads-profile
dsh --profile web "Plan the auth-test fix and the docs drift as a Project, then tell me how each Thread ended."
```

The profile must already contain the agent plane this layer extends: `@deepseek-ai/dsh-web-app` composes the agent-preset registry and the `standard` preset, and the bundle's `threads-preset` row names `standard` as its `basePreset`. A profile whose tools are global rows instead of preset rows sets `basePreset` to nothing. Removing the package with `dsh plugin --profile <name> remove @deepseek-ai/dsh-experimental-threads-profile` removes the bundle from the profile's ordered layer list.

The Plugins page reads the bundle's [icon](icon.svg) from its `package.json.icon` declaration, including while the bundle is disabled.

### What you get

The layer inserts six rows and changes nothing else:

| Row | Package | Role |
|---|---|---|
| `worktree-manager` | `@deepseek-ai/dsh-worktree-manager` | One git worktree per Thread under `dshHomePath('worktrees')`, with `pruneOnStart` reconciliation |
| `threads` | `@deepseek-ai/dsh-experimental-threads` | The log-only `thread/*` events and the durable `threads` Session projection |
| `subagent-thread-worktree` | `@deepseek-ai/dsh-subagent-thread-worktree` | The `thread` continuable provider: one branch and worktree per child, each composed from `project-thread` |
| `ui-threads` | `@deepseek-ai/dsh-experimental-client-ui-threads` | The Web Thread roster and the addressed Thread chat resource |
| `project-memory` | `@deepseek-ai/dsh-experimental-project-memory` | The Project memory service behind the `memory_read` and `memory_write` tools the presets mount |
| `threads-preset` | `@deepseek-ai/dsh-experimental-threads-preset` | The `project` coordinator preset and the `project-thread` worker preset |

An ordinary session's tool list and its `subagent` provider are unchanged: the base `subagent` row keeps its own provider, and no Thread tool or contract reaches a session that did not select one of the two presets. A Project session gets the coordinator composition; a Thread child gets the worker composition.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package's runtime content is [`cordis.patch.yml`](cordis.patch.yml). Applied after the base and Web layers, it inserts the six rows above and patches nothing. Two row ids are coupled by configuration: `subagent-thread-worktree` registers the provider under `thread` and asks for `childAgentPreset: project-thread`, and `threads-preset` declares that worker id beside the `project` coordinator id, so the two must be changed together.

The UI plugin has an inert Host entry; only the Web Client loader mounts its browser entry, so a headless profile needs no Web server. `ui-threads` carries no config: a client row's config never reaches the browser, so the package's own default of `project` is what the roster matches on.

| File | Role |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | Ordered insertion over the base and Web layers |
| [`src/index.ts`](src/index.ts) | Empty module entry; the patch is the runtime content |
| — | No runtime invariant companion is published; the package carries only a static profile patch. The worktree service, the projection, the provider, the presets, and the UI package own their mutable relationships. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Experimental packages](../README.md) — incubation status and publication policy.
- [Threads presets](../threads-preset/README.md) — the two compositions and the contract texts this layer mounts.
- [Threads service](../threads/README.md) — the log-only events and the durable status read model.
- [Threads tools](../tool-threads/README.md) — the bounded `thread_status` and `thread_diff` surfaces the model sees.
- [Worktree manager](../../subagent/worktree-manager/README.md) — the durable worktree lifecycle behind `ctx.worktrees`.
- [Thread provider](../../subagent/subagent-thread-worktree/README.md) — the continuable backend that isolates each child.
- [Base bundle](../../bundle/base/README.md) — the profile layer this patch extends.

-----

<a id="model-experience"></a>
## Model Experience

### Composition, not new tools

#### What the model sees

This bundle adds no prompt text of its own. What the model sees is decided by the preset its session was composed from: a Project reads the coordinator contract and is offered `subagent`, `thread_status`, `thread_diff`, `send_message`, and `interrupt_agent`; a Thread reads the worker contract and is offered the ordinary tools, including a `subagent` bound to the shipped `spawn` provider for helpers inside its own worktree; an ordinary session is offered exactly what it was offered before the bundle was installed. The delegation description, the `thread_status` schema, and both contract texts belong to the [preset package](../threads-preset/README.md) and the tool package.

#### Token effect

Nothing is added to an ordinary session. A Project pays the coordinator contract and the `thread_status` / `thread_diff` schemas; a Thread pays the worker contract. A status call costs a bounded page of at most the configured `maxLimit` lines.

#### KV Cache effect

An ordinary session's prefix is unchanged by installing this bundle, which is what keeps the bundle from invalidating existing conversations. A Project's or Thread's prefix is stable while its contract configuration, the provider name, and the tool schemas remain unchanged.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Opt-in only** — the package is not in the launcher's optional-bundle list, so no shipped CLI, Web, SDK, ACP, or Python profile enables it; install it by name.
- **It depends on the Web agent plane** — the shipped status values name `standard` as `basePreset` and the `thread` provider id. A profile that composes tools globally sets `basePreset` to nothing, and a profile that renames the worker id must restate the provider's `childAgentPreset`.
- **The worker preset is visible in the roster** — the preset registry has no hidden flag, so a person can select `project-thread`. It is ordered last and named for its role, but selecting it yields a session with the worker contract and no Thread tools.
- **Threads that need helpers need a depth cap** — the layer sets `workerMaxDepth: 2`, because the Host default of 1 rejects a subagent the Thread itself starts.
- **Status is the last recorded value** — `running` is computed live from the runtime, while the outcome the status row reports is what the last `thread/status` event recorded; a Thread that died without reporting reads as it was last known.
- **A completed Thread is not merged** — the worktree and branch survive the Thread; reviewing and merging them is the coordinator's git work, not something this bundle automates.
- **`ui-threads` needs a Web client** — a headless profile mounts the row (its Host entry is inert) but the roster only appears where the Web client loader mounts the browser entry.
- **Base profile required** — the patch names row ids and services supplied by the base and Web layers; it is not a standalone profile.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The bundle publishes no runtime invariant companion: it is a static profile patch, and every row it names owns its own relationships. The profile suite boots the base agent-plane rows and the bundle's inserted rows through the real Loader with a scripted model, and asserts that an ordinary session's tool set and `subagent` provider are identical with and without the bundle.

Run the suite from the repository root:

```bash
pnpm vitest run packages/experimental/threads-profile
```

</details>
