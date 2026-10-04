---
description: "The Threads presets' settings page on the dsh web client's Plugins page: the coordinator's check-in and approval cadence, and the model every Thread runs on."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-threads

English | [中文](README.zh.md)

## Summary

Open **Plugins** in the sidebar and select **Threads** in the Official group to set how a Project narrates and approves its work, and which model every Thread runs on. The page stages what is typed and writes it only on save, marks a value the user overrode, and offers to reset it to the deployment's default. The page exists while the Host serves the `threads-preset` namespace.

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

The **Threads** card in the Official group opens the page. It edits seven fields of one Host row:

- **Progress reporting** — the cadence a Project uses to narrate what its Threads are doing: `milestones`, `each-thread`, or `quiet`.
- **Approval before starting a Thread** and **Approval before merging** — whether the Project waits for you: `ask` or `auto`.
- **Thread model** — the provider, model, reasoning effort, and output-token ceiling every Thread runs on.

Nothing is written until **Save**; leaving the page drops the draft, an empty field saves as a reset, and text that is not one of the values the Host row declares blocks the save and says so under the field.

The four **Thread model** fields are read and written as one. The Host row refuses to load when only some of them are set, so the page blocks a save that would leave the group half written and says so under the heading, whether the group is half filled in or half cleared.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Host half is an empty `apply`, present only so the package holds a Loader row the client module system serves the browser half for. The browser half binds the `threads-preset` namespace through `ctx.configForms.get`, keeps the staged form in `ThreadsCardController` over the shared `SettingsFormModel` of `ui-primitives`, and registers `ThreadsCard` into the Plugins page's `plugins.item` slot through `ctx.configForms.whileServed`. The page's copy lives in this package's `settings.threads` dictionary.

`ui-primitives` ships a text control and no select, so each fixed-value field is a text control whose parser accepts only the literals the Host row's union declares; anything else is an invalid draft, which the shared form already refuses to save. The Host row is the authority on which values exist.

The all-or-nothing rule over the four Thread model fields spans more than one field and so belongs to no single `SettingsFieldSpec`. The card evaluates it itself, over a small mirror of what each staged field intends: a staged clear leaves the control showing the composition layer's value while the save writes an unset for it, and only the card can tell that apart from a value the Host already holds.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [ui-plugin-manager](../ui-plugin-manager/README.md) — the Plugins page and the `plugins.item` slot the page registers into.
- [ui-settings](../ui-settings/README.md) — the settings scope and the served-namespace watch the page rides.
- [ui-primitives](../ui-primitives/README.md) — the settings form model and fields the page renders.
- [threads-preset](../../experimental/threads-preset/README.md) — the Threads presets, and the Host row whose volatile fields this page edits.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side settings surface that registers no model surface.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **A saved change applies at the next start** — the Host row's volatile references update, but the two presets are registered once, when the plugin activates, so a Project session still runs the cadence and the model its presets were registered with. The page says so under the Thread model heading rather than implying the running Project changed.
- **The tool budget is not editable here** — `tools` carries `thread_status` / `thread_diff` bounds as a dict of numbers, and the shared form model stages one top-level field name per control, so a control bound to `tools.defaultLimit` would write a path the Host does not serve. It stays a `cordis.yml` edit.
- **The worktree rows are not editable here** — `worktree-manager` and `subagent-thread-worktree` are separate Host namespaces with their own volatile contracts; a second companion package owns them.
- **Preset identities are not editable here** — `id`, `workerId`, `name`, `description`, `order`, `provider`, `basePreset`, and `workerMaxDepth` are boot composition rather than preferences, and a settings section carrying them would pin them into the profile row on the first edit.
- **Runtime invariant:** No companion is published. The page holds no owned relationship of its own: what it shows derives from the settings mirror, and what it writes the Host validates.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The field names this page stages are spelled here rather than imported: a client package must not depend on a Host package, so the schema they mirror cannot be read from here. They are kept in step by `packages/experimental/threads-preset/tests/config-volatility.spec.ts`, which asserts on the Host row which fields are volatile — the same `meta.volatile` predicate `SettingsForms` projects and writes through — and by the controller suite, whose fixture is a section typed as the page's own `ThreadsSettings` and names every field of the row the page edits.

</details>
