---
description: "Composer chip, settings page, and Thread roster entry for the tiers model route on the dsh web client."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-model-routing

English | [中文](README.zh.md)

## Summary

`dsh-experimental-client-ui-model-routing` is the browser half of the `tiers` model route: it mounts the `modelRouting` Remote namespace, registers the composer chip that names the running tier and the model that answered, registers the transcript row that names a change of model or route, and registers the "Model routing" settings page on the Plugins page, where a person decides which models belong to which tier and sees what each would cost. It shows nothing on a Host that does not serve the `model-routing` namespace. It is published under its experimental name and carries no stability promise.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this package beside `@deepseek-ai/dsh-experimental-model-routing`, which serves the `model-routing` settings namespace the page edits and the `modelRouting` Remote the page prices through. The bundle in `cordis.patch.yml` mounts both.

### When to choose it

Choose it when a deployment runs the `tiers` route and a person needs to see or change which models a tier may choose. Avoid it when the deployment picks one model per Session by hand: without the routing plugin there are no tiers, and the chip, the page, and the roster column all correctly render nothing.

<a id="chip"></a>
### The composer chip

The chip reads two projections and shows `<tier> · <model>`, with the model stripped of its `author/` prefix — the tier already says which vendor's tier this is. The provider, the quantization, and the boundary that produced the decision live in the tooltip, because they are what a person reads when a turn went wrong, not what they read while composing the next one. A model picked in the composer is not in force until the next request, because the route decides at a request boundary, so while a selection is waiting the chip names it after an arrow — `<tier> · <answered> → <next>` — and the tooltip says it applies to the next request. Without that, a chip naming only the answered model reads as if the pick had been ignored.

<a id="switch"></a>
### The transcript row

The chip names the model that is answering, but only ever the latest one, so a turn that began on one route and finished on another left no trace of the change in the transcript. The row closes that gap: one row per decision that moved the session onto a different model or a different route, naming both sides and the boundary that allowed the move — `claude-proxy/claude-opus-5 → xiaomi-token-plan-sgp/mimo-v2.6-pro`, after a provider failure.

The row reads the decision before it through the Conversation Context reader instead of a new event, because `model-routing/decision` already records every boundary and the preceding decision is reachable from the current one. A session's first decision publishes nothing, and neither does a re-decision that keeps the same route and model. The row keeps its own segment beside the retry rows the `llm-retry` plugin writes, so a turn that retried one route and then moved reads as that sequence.

<a id="page"></a>
### The settings page

The page stages a draft and writes it as one revision-fenced mutation, which is what stops two editors from interleaving two half-applied tier lists. Prices are read through `modelRouting.quote` per tier and are never stored: a price is a live fact and a stored one is stale on arrival. A tab strip switches between tiers, one editable at a time, because a tier list read as several separate forms at once is several separate mistakes.

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
| `src/client/index.ts` | Remote mount, chip seat, transcript-row seat, settings page seat |
| `src/client/ModelRoutingChip.tsx` | The composer chip |
| `src/client/model-switch.ts` | The transcript row's Definition: which decision moved the session, and to what |
| `src/client/ModelSwitchNotice.tsx` | The transcript row |
| `src/client/ModelRoutingCard.tsx` | The settings card |
| `src/client/model-routing-card-controller.ts` | The staged draft, the catalog join, and the quotes |
| `src/client/locales.ts` | English and Chinese copy |

### Conditional registration

Both surfaces register through `whileServed([…])` or a scoped `slots.inject`, so a composition without the routing Host plugin never renders an empty frame. The Remote namespace is mounted here rather than from a shipped Remote assembly, which keeps this experimental package out of the product's `dsh-api-remotes` bundle.

### Projection reads

The chip reads the `modelRouting` Session projection through the session standard `useProjection` seat, and the `modelSelection` projection beside it for the selection no request has consumed yet. The Thread roster reads the routing value out of the Session list's projection map, defensively — see `thread-model.ts` in `dsh-experimental-client-ui-threads` — because that map is untyped and a Host without the plugin simply has no such block.

</details>

-----

<a id="model-experience"></a>
## Model Experience

None, as this is a browser-side settings surface and composer chip that register no model surface.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Adding or removing a tier is not offered here. A tier is a policy, not a per-session preference, so reshaping the policy itself stays a configuration-file decision; membership, filters, label, context window, output cap, and the route-wide judge and cache settings are all editable.
- The page prices through one live read per tier per draft. A tier with many models therefore costs one endpoint read per model on every edit; a debounced, shared price cache would be the next step.
- The transcript row states a change of model or route, not every retry: a request that retries the same candidate before moving publishes the same route twice, and only the move is a row. The retry rows the `llm-retry` plugin writes carry that half. The row also folds with its turn's process disclosure once the turn completes, exactly as those retry rows do, so a reader of a finished turn finds it by expanding that turn.

<a id="dev-note"></a>
### Dev Note

None.
