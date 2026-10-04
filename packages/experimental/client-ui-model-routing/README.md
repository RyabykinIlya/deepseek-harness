---
description: "Composer chip, settings page, and Thread roster entry for the tiers model route on the dsh web client."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-model-routing

English | [中文](README.zh.md)

## Summary

`dsh-experimental-client-ui-model-routing` is the browser half of the `tiers` model route: it mounts the `modelRouting` Remote namespace, registers the composer chip that names the running tier and the model that answered, and registers the "Model routing" settings page on the Plugins page, where a person decides which models belong to which tier and sees what each would cost. It shows nothing on a Host that does not serve the `model-routing` namespace. It is published under its experimental name and carries no stability promise.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount this package beside `@deepseek-ai/dsh-experimental-model-routing`, which serves the `model-routing` settings namespace the page edits and the `modelRouting` Remote the page prices through. The bundle in `cordis.patch.yml` mounts both.

### When to choose it

Choose it when a deployment runs the `tiers` route and a person needs to see or change which models a tier may choose. Avoid it when the deployment picks one model per Session by hand: without the routing plugin there are no tiers, and the chip, the page, and the roster column all correctly render nothing.

<a id="chip"></a>
### The composer chip

The chip reads one projection and shows `<tier> · <model>`, with the model stripped of its `author/` prefix — the tier already says which vendor's tier this is. The provider, the quantization, and the boundary that produced the decision live in the tooltip, because they are what a person reads when a turn went wrong, not what they read while composing the next one.

<a id="page"></a>
### The settings page

The page stages a draft and writes it as one revision-fenced mutation, which is what stops two editors from interleaving two half-applied tier lists. Prices are read through `modelRouting.quote` per tier and are never stored: a price is a live fact and a stored one is stale on arrival. The page shows one tier at a time, with the other tiers' model counts still visible, because a tier list read as three separate forms is three separate mistakes.

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
| `src/client/index.ts` | Remote mount, chip seat, settings page seat |
| `src/client/ModelRoutingChip.tsx` | The composer chip |
| `src/client/ModelRoutingCard.tsx` | The settings card |
| `src/client/model-routing-card-controller.ts` | The staged draft, the catalog join, and the quotes |
| `src/client/locales.ts` | English and Chinese copy |

### Conditional registration

Both surfaces register through `whileServed([…])` or a scoped `slots.inject`, so a composition without the routing Host plugin never renders an empty frame. The Remote namespace is mounted here rather than from a shipped Remote assembly, which keeps this experimental package out of the product's `dsh-api-remotes` bundle.

### Projection reads

The chip reads the `modelRouting` Session projection through the session standard `useProjection` seat. The Thread roster reads the same value out of the Session list's projection map, defensively — see `thread-model.ts` in `dsh-experimental-client-ui-threads` — because that map is untyped and a Host without the plugin simply has no such block.

</details>

-----

<a id="model-experience"></a>
## Model Experience

None, as this is a browser-side settings surface and composer chip that register no model surface.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Adding or removing a tier is not offered here. A tier is a policy, and the plan's §5 keeps that a configuration decision; only its membership, filters, and label are editable.
- `contextWindow` and `maxTokens` are shown read-only. They bound what compaction believes the model can hold, and a wrong value fails later and further away than this page.
- The page prices through one live read per tier per draft. A tier with many models therefore costs one endpoint read per model on every edit; a debounced, shared price cache would be the next step.

-----

<a id="dev-note"></a>
## Dev Note

None.
