---
description: "The Project Session's background Thread roster in the conversation header, over the two orthogonal liveness / stopReason axes, with per-row Stop, Archive and Copy branch actions, plus the addressed Thread chat that opens one Thread as a full conversation."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-threads

English | [中文](README.zh.md)

## Summary

Show a Project Session's background Threads in one header control and open any of them as a conversation in the main workspace or a Sidebar tab. Each row shows liveness read from the Session store beside the `stopReason` of the last finished turn, and carries Stop, Archive, and Copy branch. Archive asks before it removes a worktree holding uncommitted changes. In a Project the roster is a control, not a report: it appears before the first Thread exists and opens the Project's shared memory to edit. A `New Project` action in the sidebar footer starts one.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Add this package to a Web composition that already projects a Project Session's Threads:

```yaml
- name: '@deepseek-ai/dsh-experimental-client-ui-threads'
```

It needs the `threads` projection to be registered Host-side, which the Threads domain package does:

```yaml
# the Threads domain seam that publishes `threads`
- name: '@deepseek-ai/dsh-experimental-threads'
```

### When to choose it

Choose it when a user needs to see what background work a Project Session has running, to stop or archive one Thread, and to read one Thread's conversation. Avoid it when you need a Thread's worktree contents on disk, or when you need Thread creation to happen without the model deciding to — the New Thread row stages an instruction in the composer and the model calls `subagent` itself.

### Configuration

| Key | Type | Default | Meaning |
|---|---|---|---|
| `projectAgentPresets` | `string[]` | `['project']` | Agent preset ids whose sessions are Projects. The first entry is also the preset a `New Project` action composes. |

Nothing here imports the Project preset package: a deployment names the preset ids, and the browser half derives everything else from that list. The default names the shipped `project` preset, because a client row's config is never delivered to the browser and only the schema default can reach it; naming it is what makes the feature live out of the box.

<a id="what-the-control-shows"></a>
### What the control shows

Outside a Project the trigger is absent until the projection shows at least one Thread. Inside a Project it is always there, counting zero when there is nothing yet. Its label is the running count while any Thread runs and the total otherwise:

| Trigger | Meaning |
|---|---|
| `2 threads running` | Two Threads are live; the roster may hold more |
| `3 threads` | Three Threads exist and none is live right now |

Each row carries the Thread's label, a secondary line of durable work facts, and both status axes:

| Axis | Source | Shown as |
|---|---|---|
| Liveness | `sessions.byId[threadId].running` | A spinner while a turn is in flight, a dim dot otherwise |
| Outcome | `stopReason` | A distinct glyph and label per outcome; absent while a turn is in flight |

The outcomes map one-to-one — `completed` (a check), `aborted` (a pause bar), `error` (an exclamation), `max-tokens` (a truncated bar), `refusal` (a struck circle) — and the last three share a tone without sharing a label or a glyph. A row with no live Session and no `stopReason` is idle/settled: it carries no outcome chip and is never presented as a failure.

The secondary line joins whatever the durable row holds, skipping the empty parts: the branch name, `N commits ahead` when the Thread has committed, and `M uncommitted` when its worktree holds uncommitted changes. The start of the Thread's closing note sits on its own line below it, truncated to the row width, with the full text as its tooltip.

<a id="row-actions"></a>
### Row actions

Every row is still one `role="option"` that opens the Thread in the main conversation on click, Enter, or Space, and the trailing buttons act on that Thread without opening it. The buttons are real buttons inside the row, so they take focus and Enter themselves, and ArrowUp/ArrowDown still walk the roster's roving focus from any of them.

| Action | Shown | What it calls |
|---|---|---|
| Stop | The Thread is live | `ctx.remote.subagents.interruptByParent(threadId, projectSessionId, 'continuable')` |
| Archive | Always | `ctx.remote.threads.archive(projectSessionId, threadId, { force })` |
| Copy branch | The Thread has a branch | The shared clipboard helper |
| Open in sidebar | Always | The same Thread as a right-Sidebar chat tab |

The `threads` and `projectMemory` namespaces are mounted by this package itself from their domain packages' generated contributions, so the shipped Remote assembly (`dsh-api-remotes`) never depends on an experimental package; both namespaces are withdrawn with the plugin, and a failed second mount withdraws the first.

Stop goes through the parent address rather than the Project's own live turn, so the Project does not have to be running for a Stop to reach its Thread. A refused Stop is reported in a warning toast and the row stays as it is.

Archive is destructive — it removes the Thread's git worktree — so it asks first when the worktree holds uncommitted changes. The Host refuses such an archive with `threads/worktree-dirty`; the row then opens a confirmation that names the Thread and states that the uncommitted changes cannot be recovered, and the `Archive anyway` button stays disabled until the acknowledgement checkbox is ticked. Only then is the same call retried with `force: true`. Any other failure, and a success, are reported in a toast.

The toasts and the confirmation are rendered by the header seat rather than inside the roster menu, because archiving the last Thread hides the control: the notice for that archive has to outlive the menu that started it.

<a id="opening-a-thread"></a>
### Opening a Thread

A row opens in the main workspace conversation. The row's Open in sidebar button opens the same Thread as a chat tab in the right Sidebar, so a user can keep reading the Project Session while a Thread runs.

Both routes land on the same proven path: a `dsh-resource://threadchat/session/<threadId>?parent=<sessionId>` address, a resource provider that retains the Thread's Session for the address's lifetime, and the shared `conversation.content` factory rendered with `variant: 'embedded'` under a `SessionProvider`. This package contains no chat renderer.

<a id="starting-a-thread"></a>
### Starting a Thread

In a Project the menu carries a `New thread` row under the list. It stages a prepared instruction in that session's composer and sends nothing: the user edits and sends, and the model decides that a background Thread is what the request needs and calls `subagent`. That keeps tool choice with the model, needs no new Host surface, and means a half-written instruction never spawns work.

The row is a button rather than a listbox option — a listbox admits options and groups only — and it joins the same roving-focus walk, so ArrowDown reaches it even when the roster is empty and it is the only row there is.

<a id="starting-a-project"></a>
### Starting a Project

A `New Project` button in the sidebar foot creates a blank Session and opens it as a Project, in the Workspace holding the most recently updated Session.

That seat was chosen deliberately. `conversation.hero.agentPreset` is a single-occupant seat the agent-preset picker already holds, `sidebar.panellist` entries address a main panel instead of running an action, and a Session "..." menu row would imply acting on that Session rather than creating a new one. The footer sits beside Settings in every sidebar width, outside the Session list, so the action reads as app-level and creates a row instead of changing one.

Creating it is three steps, in this order: `ctx.sessions.create({ workspaceId })`, then `ctx.remote.agentPresets.select(sessionId, preset)` while the Session is still blank, then the open. Creation carries no preset — a client cannot ask for one — and the composition is chosen the same way the agent-preset picker stages one, before the first turn. The Session is opened only after the selection takes, so a Project's first prompt never runs under the default composition. A failure is reported in a warning toast naming the cause: no configured preset, no Workspace to create in, a refused creation, a preset the deployment does not have, or a Session that already started and is locked. A created-then-refused Session is deliberately left open for the user rather than silently deleted.

<a id="thread-header"></a>
### Thread header

A Thread opened in the main conversation gets a compact header in the session header band, and a Thread opened as a right-Sidebar tab gets the same header above its chat. It shows the label, the liveness state, the last outcome, and the branch, with Stop (while the Thread runs) and Archive on the right. Both surfaces use the roster's action code, so the dirty-worktree confirmation, the toasts, and the in-flight guard behave the same; the Project is the Thread Session's parent.

<a id="project-memory"></a>
### Project memory

In a Project the roster footer has a `Memory` row next to `New thread`. It replaces the Thread list in the same popover with the Project's entries, newest first, each with its author (coordinator, thread, or you) and age. A form at the bottom adds an entry; each entry has Edit and Delete. Every change is followed by a fresh read. A refusal such as an empty or oversized text is shown in place with the Host's message, and the list stays as it was. With no entries the view says so. Leaving the Thread list pins the popover so a hover-out does not close the view; Escape closes it and the next open starts on the Threads.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

### Design philosophy

The two status axes are the load-bearing decision. The domain states plainly that liveness and `stopReason` are orthogonal and that collapsing them into one enum would have to invent states the runtime never produces. So `ThreadStatus` carries `liveness` and `outcome` in separate fields, and the row renders two separate elements. Nothing in the package produces a single combined status string, so no component can accidentally invent one.

Liveness is also not durable, so it cannot come from the row: `roster.ts` merges the catalog and `threads` projections into durable rows, and `withLiveness` attaches the Session store's `running` last. `ThreadStatusRow` on the wire has no `running` field at all, which is what keeps a stale durable value from ever being rendered as current.

### Source map

| Path | Role |
|---|---|
| [`src/client/ThreadStatus.tsx`](src/client/ThreadStatus.tsx) | The two axes as separate values, plus one glyph per `stopReason` |
| [`src/client/ThreadsHeaderAction.tsx`](src/client/ThreadsHeaderAction.tsx) | The header control, its roster, its row actions, its feedback surfaces, and the mirrored dropdown interaction |
| [`src/client/ThreadActions.tsx`](src/client/ThreadActions.tsx) | Stop, Archive and Copy branch with their toasts and the dirty-archive confirmation, shared by the roster and the Thread header |
| [`src/client/ThreadChatHeader.tsx`](src/client/ThreadChatHeader.tsx) | The Thread header above a Sidebar chat and in the session header band |
| [`src/client/MemoryPanel.tsx`](src/client/MemoryPanel.tsx) | The Memory view: list, add, edit, delete, in-place refusals |
| [`src/client/memory-types.ts`](src/client/memory-types.ts) | The memory entry and id types read off the `projectMemory` Remote |
| [`src/client/useThreadRoster.ts`](src/client/useThreadRoster.ts) | The merged Thread rows and load state of one Project, for both surfaces |
| [`src/client/mount.ts`](src/client/mount.ts) | Mounts the `threads` and `projectMemory` Remote namespaces, then registers every contribution |
| [`src/client/roster.ts`](src/client/roster.ts) | Catalog and `threads` rows merged, then liveness attached |
| [`src/client/actions.ts`](src/client/actions.ts) | The action outcome type shared between the Remote calls and the rows |
| [`src/client/project.ts`](src/client/project.ts) | Which session is a Project, which preset a new one composes, and which Workspace it is created in |
| [`src/client/project/NewProjectFooterAction.tsx`](src/client/project/NewProjectFooterAction.tsx) | The `sidebar.footer.action` button that starts a Project |
| [`src/client/config.ts`](src/client/config.ts) | `projectAgentPresets`, the one deployment-configured fact |
| [`src/client/thread-chat/index.tsx`](src/client/thread-chat/index.tsx) | The Thread chat address, resource provider, Sidebar tab, and embedded Conversation |
| [`src/client/locales.ts`](src/client/locales.ts) | The `threads` dictionaries (zh is the key-set source of truth) |

### The dropdown interaction is the catalog's

The hover-open, pin-on-click, grace-period hover-out, outside-pointer dismissal, and Escape focus return are `SubagentHeaderLineage`'s interaction, reused rather than reinvented: 150ms to open on hover, 120ms grace on the way out, and the same `focusAt` wrapping key handling. The Thread roster is flat, so its rows use `role="option"` inside a `role="listbox"` rather than the catalog's tree roles; the key handling, the wrap-around, and the roving focus are unchanged. A focused row button belongs to its row for that walk, so ArrowDown from the Archive button moves to the next Thread rather than to the row's other buttons.

### Thread identity is the Session identity

A Thread's durable identity is the identity of the Session that runs it — the worktree provider records `threadId: request.sessionId` when it prepares a Thread's isolated checkout. `threadSessionId()` is the one place that fact is asserted, so a future provider that separates the two changes one line rather than every call site. It is also what lets Stop and Archive name a Thread by the two identities their Remote calls want.

### Visibility needs evidence

The control renders nothing before the projection has been read, while a read is still in flight with no rows, or for a Session that has no Threads at all — the same rule the subagent catalog follows. A failed read is the one exception: the control appears with the error and a retry. A Project is the other, and it is not an exception to the evidence rule so much as different evidence: there, the Session's own composition is the evidence, so the roster appears before the `threads` read lands and stays when the read settles empty.

### Project identity is a composition, not a flag

No Session carries a "Project" flag anywhere on the wire. The rule is `isProjectSession(preset, projectAgentPresets)` over the `agentPreset` Session projection the agent-preset registry already publishes — the same value the preset label reads — so recognizing a Project costs one projection read and no new Host surface. The preset itself is never imported: the deployment names its ids through plugin config, and the default names the shipped one.

-----

<a id="model-experience"></a>
## Model Experience

### The Threads roster and chat

#### What the model sees

Nothing. This package renders the browser half: it registers slots and mounts the `threads` and `projectMemory` Remote namespaces, and contributes no tool, prompt section, or message. A Project model reads the same durable rows through `thread_status` and `thread_diff`, and the `New thread` row stages an instruction the user sends, so the model decides that a background Thread is what a request needs.

#### Token effect

Zero from this package. The staged instruction is ordinary user text in the composer, and the Thread chat reuses the shared Conversation renderer, so nothing here is added to a model request.

#### KV Cache effect

Nothing here enters a model request, so provider cache reuse is unaffected.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No Thread creation of its own.** The New Thread row stages an instruction; the model calls `subagent`. There is no Host RPC here that starts a Thread directly, and none is needed unless a deployment wants a button that spawns work without a user editing it.
- **A Stop waits for the Thread's own settlement.** The interrupt is acknowledged as soon as the Host accepts it; the row keeps its spinner until the Thread's Session reports that it stopped.
- **Archive is the only way to remove a Thread.** There is no separate delete, and a Thread archived by another client simply leaves the roster on the next projection read.
- **No rename.** `label` is fixed at `thread/created`, so the roster renders what was recorded and never edits it.
- **One Session per Thread.** `threadSessionId()` assumes a Thread is a Session. A provider that keeps a Thread outside the Session catalog would need its own resolution step.
- **No ordering beyond creation order.** Rows follow the projection's durable creation order; there is no recency or activity sort.
- **One Project preset per deployment.** `projectAgentPresets` recognizes several presets but a New Project action always composes the first.
- **New Project needs an existing Session to pick a Workspace.** With no Workspaces at all the button reports that instead of asking for a directory; creating a Workspace is the Workspace browser's job.
- **Memory only.** The Library view is not part of this package yet; the Memory view edits entries as a user, and the Host stamps them with the `user` author.

<a id="dev-note"></a>
### Dev Note

Run the suite from the repository root:

```bash
pnpm vitest run packages/client/ui-threads
```

`tests/threads-header-action.client.spec.tsx` covers the projection-driven rows, each `stopReason`'s own glyph and label, liveness read from the Session store, the keyboard traversal and dismissal rules, opening a Thread, the row actions (Stop, Archive including the dirty-worktree confirmation and its forced retry, Copy branch, and every failure's toast), and everything the Project identity adds — always-visible visibility, the empty-list copy, and the New Thread row's staged instruction; `tests/roster.client.spec.ts` covers the catalog projection, the merge, and the liveness attach; `tests/project-identity.client.spec.ts` covers the identity rule, its config, and Workspace selection; `tests/new-project-footer-action.client.spec.tsx` covers the button's Workspace resolution, activation, failure copy, and re-entry guard; `tests/thread-chat.client.spec.tsx` covers the address round-trip, the resource provider's lifetime, and the embedded Conversation; `tests/browser-plugin.client.spec.ts` covers the slot registrations, the navigation they bind, and the exact Remote calls the actions make. `tests/thread-chat-header.client.spec.tsx` covers the Thread header and its shared actions; `tests/memory-panel.client.spec.tsx` covers the Memory view; `tests/index.client.spec.ts` covers the package entry points.

**Runtime invariant:** No companion is published. Every value this package shows is projected from Host-owned state — the `threads` rows, the liveness flag read from the Session store, and the entries behind the `projectMemory` Remote — so the only thing it holds at run time is a set of slot and Remote-namespace registrations that unwind with the plugin.
