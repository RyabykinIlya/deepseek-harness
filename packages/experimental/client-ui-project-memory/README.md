---
description: "Settings page of the Project memory caps on the dsh web client's Plugins page: how many entries a Project keeps and how long each one may be."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-project-memory

English | [中文](README.zh.md)

## Summary

`dsh-experimental-client-ui-project-memory` is the browser half of the Project memory caps: it registers the "Project memory" settings page on the Plugins page, where a person decides how many entries one Project keeps and how long a single entry may be. It shows nothing on a Host that does not serve the `project-memory` namespace. It is published under its experimental name and carries no stability promise.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this package beside `@deepseek-ai/dsh-experimental-project-memory`, which serves the `project-memory` settings namespace the page edits. The Threads profile bundle in `cordis.patch.yml` mounts both.

### When to choose it

Choose it when a deployment runs Projects whose shared memory outgrew its default caps and a person needs to widen them. Avoid it when the defaults suffice: the page only appears while the Host serves the namespace, and a cap that is never reached needs no control.

<a id="page"></a>
### The settings page

The page edits the two volatile caps of the namespace, `maxEntries` and `maxEntryChars`, and stages them into one revision-fenced save. Both are read by the Host on the next write, so widening a cap takes effect on the following `memory_write` rather than at the next restart. The Host row's remaining fields — the coordinator preset ids and the lineage depth — are boot composition and are not offered here: a first edit would pin them into the profile row.

A fractional draft is refused before the save, because no bound the Host enforces could use one. The accepted range stays the Host's to answer, so a value outside it arrives as a refused save rather than as a control that silently clamps.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The observable behavior is fully covered in [Use this package](#use-this-package).

### Source map

| File | Role |
|---|---|
| `src/index.ts` | Host entry; contributes nothing |
| `src/client/index.ts` | Locale dictionary and settings page seat |
| `src/client/ProjectMemoryCard.tsx` | The settings card |
| `src/client/project-memory-card-controller.ts` | The staged form over the two caps |
| `src/client/locales.ts` | English and Chinese copy |

### Conditional registration

The page registers through `configForms.whileServed(['project-memory'], …)`, so a composition without the Project memory Host plugin never renders an empty card.

</details>

-----

<a id="model-experience"></a>
## Model Experience

None, as this is a browser-side settings surface that registers no model surface.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits are current package constraints, not a task backlog.

- **No entry preview.** The page edits the bounds, not the entries. Reading and editing the entries themselves is the Project memory panel's work.
- **No per-Project override.** Both caps are deployment-wide, so a deployment that wants one roomy Project and several tight ones cannot express it here.
- **Experimental prototype with no stability promise** — the namespace, the copy, and the card's field set can change while it incubates.

<a id="dev-note"></a>
### Dev Note

None.
