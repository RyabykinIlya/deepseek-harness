---
description: "Rank OpenRouter endpoints by blended price and fold model-routing decisions into a per-session projection."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-model-routing

English | [中文](README.zh.md)

## Summary

`dsh-experimental-model-routing` is the pure decision layer of the `tiers` model route: the tier configuration schema and its validator, the endpoint filters and price ranking that pick the cheapest qualifying OpenRouter provider, the `modelRouting` Session projection that records what a decision chose, and the shared event and Remote vocabulary the route and its surfaces speak. It dispatches nothing itself. It is published under its experimental name and carries no stability promise.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this package through the `model-routing` bundle, which also loads the adapter that serves the `tiers` LLM route and the browser-side settings page. This package on its own is useful only to a caller that already holds the tier configuration and wants the same ranking or the same projection state.

### When to choose it

Choose it when a tier's models must be ranked by what the *next agent turn* costs rather than by a per-token list price, or when a Session log must be able to answer which model, provider, and quantization its last routing decision chose. Avoid it when the ranking must be reproducible from a recorded list alone — every price here is read live from OpenRouter's `/endpoints`, and this package never caches it itself.

<a id="tiers"></a>
### Tiers

A tier is a named group of interchangeable models plus the filters every endpoint serving one of them must pass: `minQuantization`, `unknownQuantization`, `free`, and the `contextWindow` the tier advertises. `validateSettings` refuses a settings value the route cannot act on — a tier name that is not a route model id, a model id without an `author/`, a default effort outside the effort list, an inverted pair of judge thresholds — with one message naming the first field that cannot be served.

<a id="snapshots"></a>
### Snapshots

An unversioned model id is not a rolling alias. `deepseek/deepseek-v4-pro` names the **0423** release of that family, and `deepseek/deepseek-v4-pro-0813` names the same family in August, so a tier that lists the former stays on it for as long as nobody edits the configuration. `snapshotPolicy` is the switch between the two positions:

- `pinned` (the default) decides under the ids the configuration names, which is what makes a deployment's cost and behavior reproducible from that configuration alone.
- `latest` moves each id forward to the newest snapshot of its family before deciding, reading the family from OpenRouter's catalog rather than from the model's display name: OpenRouter states for every entry which dated release that id is, and the entries sharing that dated identity are the family. A tier that lists `deepseek/deepseek-v4-pro` then follows new releases on its own.

Under `latest` a request that named one of those ids itself is resolved the same way, because the model picker offers the ids a tier lists and picking `deepseek/deepseek-v4-pro` there means the pro model rather than one release of it. Two configured ids of one tier may resolve to the same release, and only the release is ranked. The resolution is reported in the log once per move — `"deepseek/deepseek-v4-pro" now resolves to "deepseek/deepseek-v4-pro-0813"` — and every `model-routing/decision` event records the release that actually answered. A catalog that cannot be read is not a routing failure: the tier decides under its configured ids and the log says the catalog was unavailable.

OpenRouter's own `~author/slug-latest` aliases are not a substitute for this. They redirect on the chat-completions path, but `/endpoints` answers them with an empty list, so a tier naming one has nothing to rank.

<a id="ranking"></a>
### Ranking

`rankEndpoints` sorts candidates by a **blended** price per token, `cached · cacheRead + fresh · prompt + output · completion`, because an agent turn is overwhelmingly cached input and the providers that look cheapest on prompt alone frequently publish no cache-read discount at all. `preferModel` puts one model's endpoints ahead of every other model's while leaving price order intact inside that group, which is what keeps a failed provider from re-routing a conversation onto a different model mid-dialog. `rankWithRelaxation` re-runs once without the uptime floor when that floor is what emptied the list, and reports `relaxedUptime` so the decision log says so.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The observable behavior is fully covered in [Use this package](#use-this-package).

### Source map

| File | Role |
|---|---|
| `src/index.ts` | Re-exports of the pure modules; W4 replaces it with the plugin |
| `src/config.ts` | Tier schema, `readSettings`, `validateSettings`, the W0 trust list |
| `src/family.ts` | Which snapshot of a family a configured id names, from `canonical_slug` |
| `src/family-cache.ts` | The whole-catalog cache, with the stale reading that survives a failed read |
| `src/types.ts` | Session events, projection state and view, `ctx.modelRouting`, quote types |
| `src/quantization.ts` | Precision ranks and the `quantizations` filter list |
| `src/select.ts` | Endpoint rejection reasons, the blended price, ranking, uptime relaxation |
| `src/projection.ts` | The `modelRouting` projection and its wire view |

### Fold identity

`applyModelRoutingEvent` returns the identical state reference for every event it does not own, and for the events that only re-state a fact it already holds (`compaction/end` twice, `model/selection` twice). The registry caches views by state identity, so a streaming conversation would otherwise rebuild the composer's chip on every token.

### Quantization ranks

`QUANTIZATION_RANK` groups formats by precision rather than ordering them exactly: `int4`, `fp4`, `mxfp4` and `nvfp4` all sit at rank 2, and `int8`, `fp8` and `mxfp8` all sit at rank 4. A tier names a floor, not a format, so it does not have to know the names. `unknown` has no rank at all — admitting it is a separate decision, `unknownQuantization`, whose `'trusted'` mode consults `trustedUnknownProviders`.

</details>

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is an LLM route adapter that registers no model-facing tool.

#### KV Cache effect

None; this package dispatches nothing itself. The route that consumes its ranking is `dsh-experimental-model-routing`'s own adapter, which pins one upstream provider per Session precisely so that the provider does not change between turns.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The default `trustedUnknownProviders` list comes from a 30-model survey of official-author models (the W0 report). A provider that only serves third-party models was never measured, so `unknown` on such a model is admitted only when its host is already trusted for another reason.
- Ranking reads a live endpoint list. Between the read and the request the cheapest provider can fail; the adapter handles that by re-deciding at the `failure` boundary, not by re-reading here.
- `minQuantization` is a floor, not a proof: a provider declaring `unknown` on a trusted host states no format at all, and this package accepts the host's word for it (§3.2 of the plan).
- Under `snapshotPolicy: 'latest'` a tier follows its families, so a new release changes the model and the price behind a configuration nobody edited. The catalog is read at most every `catalogTtlMs`, and the move is reported once in the log and recorded in every decision, but nothing asks first. A deployment that has to approve a release change belongs on `pinned`.
- The family comes from the catalog's `canonical_slug`, so a model published only as an undated id — including every OpenRouter `~alias` — has no family and never moves.

<a id="dev-note"></a>
### Dev Note

None.
