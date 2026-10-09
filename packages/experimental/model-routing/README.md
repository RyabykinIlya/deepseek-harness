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

A tier is a named group of interchangeable models plus the filters every endpoint serving one of them must pass: `minQuantization`, `unknownQuantization`, `free`, and the `contextWindow` the tier advertises. `input` (default `[text]`) declares the modalities the tier advertises, and a decision enforces it per model against the OpenRouter model catalog: a request that reaches the route carrying an image reaches only a model whose catalog entry states `image` in `architecture.input_modalities`, and every endpoint of a model that does not state it — including a model the catalog does not list at all — is rejected, because silence is not a capability.

A text-only model in a tier that declares `image` is therefore safe: it is simply not used for an image request. It cannot serve a Session that has read an image, because the image stays in that Session's history and is replayed on every later request.

When no candidate model of the tier is shown to accept image input, the decision fails with `MODEL_ROUTING_NO_ENDPOINT`, whose message counts the rejected endpoints by reason, `modality=<n>` among them. A catalog that cannot be read produces that outcome for every candidate, and one warning line names the unreadable catalog as the reason. A text request never reads the catalog for modalities and is unaffected by this filter.

`validateSettings` refuses a settings value the route cannot act on — a tier name that is not a route model id, a model id without an `author/`, a default effort outside the effort list, an inverted pair of judge thresholds — with one message naming the first field that cannot be served.

<a id="extra-sources"></a>
### Extra sources

A tier's candidates are not only OpenRouter endpoints. `extraSources` (default `[]`) lists the non-OpenRouter sources the same tier ranks: each entry names the pi-ai route that dispatches its models (`route`), the model ids that route serves — under their own names (`models`), or through a `modelMap` from a canonical id to the route's own id — and the per-token prices the ranking blends (`price`). `xiaomi/mimo-v2.6-pro` on OpenRouter and `mimo-v2.6-pro` on a direct route are therefore one model's two sources, and the blended price decides between them.

A `modelMap` value may append `@` and a JSON price object to state that candidate's own prices. A plan that charges one flat rate per token names `usdPerToken`; a plan that weights tokens by kind names the buckets separately (`promptUsdPerToken`, `completionUsdPerToken`, `cacheReadUsdPerToken`), which is how a credit-weighted subscription is priced — Xiaomi MiMo Token Plan charges credits per cache-hit, cache-miss and output token, so its source states the three buckets, e.g. `mimo-v2.6-pro@{"promptUsdPerToken":4.363636e-7,"completionUsdPerToken":8.727273e-7,"cacheReadUsdPerToken":3.636364e-9}`. An entry without a price object is priced by the source's `price`, and a source that states none at all is ranked as `unpriced` — never as free. The per-model object is the only place `modelMap`'s `@` spelling is read, so it has exactly one meaning.

A direct source states no status, uptime or quantization, so those filters are neutral for it: an absent measurement must not reject, or no direct source could ever rank. The capability filters still apply. `tools` is the one a route must declare — `tools` (default `true`) on the source — and `context` and the per-model `modality` rule bind exactly as they do for an endpoint. A source whose route `@deepseek-ai/dsh-llm-pi-ai` has not configured never ranks; the decision reports it as undispatchable instead of pinning a request to a route nobody serves.

A chosen direct source dispatches with `provider` set to its own route and without the OpenRouter `provider` block: pi-ai rejects that block on a model that does not speak `openai-completions`. The `model-routing/decision` event records which kind of source won (`source: { kind, tag }`, `kind: 'openrouter'` or the route key) and, for a priced direct source, the exact per-token prices its blended price was computed from, so a decision log says why a source won.

<a id="snapshots"></a>
### Snapshots

An unversioned model id is not a rolling alias. `deepseek/deepseek-v4-pro` names the **0423** release of that family, and `deepseek/deepseek-v4-pro-0813` names the same family in August, so a tier that lists the former stays on it for as long as nobody edits the configuration. `snapshotPolicy` is the switch between the two positions:

- `pinned` (the default) decides under the ids the configuration names, which is what makes a deployment's cost and behavior reproducible from that configuration alone.
- `latest` moves each id forward to the newest snapshot of its family before deciding, reading the family from OpenRouter's catalog rather than from the model's display name: OpenRouter states for every entry which dated release that id is, and the entries sharing that dated identity are the family. A tier that lists `deepseek/deepseek-v4-pro` then follows new releases on its own.

Under `latest` a request that named one of those ids itself is resolved the same way, because the model picker offers the ids a tier lists and picking `deepseek/deepseek-v4-pro` there means the pro model rather than one release of it. Two configured ids of one tier may resolve to the same release, and only the release is ranked. The resolution is reported in the log once per move — `"deepseek/deepseek-v4-pro" now resolves to "deepseek/deepseek-v4-pro-0813"` — and every `model-routing/decision` event records the release that actually answered. A catalog that cannot be read is not a routing failure: the tier decides under its configured ids and the log says the catalog was unavailable.

A resolved release is used only if the inner route can dispatch it. OpenRouter publishes a release to its catalog before the pinned `pi-ai` dependency learns it, and a request for an id the inner route has never heard of fails `UNKNOWN_MODEL` on every turn — an error no reroute covers, because every endpoint of that release is equally unknown. A tier whose resolved release is not yet dispatchable stays on the id its configuration named, and the log reports the release it cannot reach instead of the move it cannot make.

OpenRouter's own `~author/slug-latest` aliases are not a substitute for this. They redirect on the chat-completions path, but `/endpoints` answers them with an empty list, so a tier naming one has nothing to rank.

The same cached catalog read also states what each release accepts as input, and the modality filter reads the release a decision actually ranks: under `latest` it is the newest snapshot's declaration that decides whether a tier can serve an image request, so a family whose new release drops image input stops serving image requests until the configuration pins a release that accepts them.

<a id="ranking"></a>
### Ranking

`rankEndpoints` sorts candidates by a **blended** price per token, `cached · cacheRead + fresh · prompt + output · completion`, because an agent turn is overwhelmingly cached input and the providers that look cheapest on prompt alone frequently publish no cache-read discount at all. `preferModel` puts one model's endpoints ahead of every other model's while leaving price order intact inside that group, which is what keeps a failed provider from re-routing a conversation onto a different model mid-dialog. `rankWithRelaxation` re-runs once without the uptime floor when that floor is what emptied the list, and reports `relaxedUptime` so the decision log says so.

An `extraSources` candidate is ranked under the same formula from the prices its entry declares, and a direct source is excluded by `route:id` rather than by its route id alone: one route may serve the same id as several models' candidates, and only the pair says which one failed.

The modality filter is the one rejection decided per model rather than per endpoint: when the request carries an image, every endpoint of a candidate model the catalog does not show accepting one is rejected as `modality`, and each of those endpoints still counts toward `considered`. Relaxation does not cover it — `rankWithRelaxation` drops only the uptime floor — so a tier with no image-capable candidate fails instead of retrying without the requirement.

<a id="diagnostics"></a>
### Diagnostics

Every decision is recorded twice. The `model-routing/decision` event in the Session log carries the miniature a reader needs at a glance: model and endpoint, the blended price, the token mix it was computed under and whether that mix was measured from the session or taken from the configuration, the filters in force, how many endpoints each rejection reason dropped, and the cheapest endpoint each reason dropped. That last field is what answers "the leader is not the cheapest — where did the cheaper one go" from the log alone.

The full candidate table goes to the file `diagnosticsPath` names: one JSON line per decision, holding every endpoint the ranking walked with its prices, its OpenRouter discount, its measurements, and then either its rank or its rejection reason. A price decision taken weeks ago can be re-checked against the data as it was then, rather than against a catalog that has since moved. An empty `diagnosticsPath` — the default — writes no file at all.

Each line is bounded to `diagnosticsMaxBytes` (256 KiB by default) in UTF-8 bytes, metadata included: candidates are kept in ranking order and the ones that did not fit are simply absent, which `considered` against `candidates.length` shows. A budget too small to hold one record at all writes nothing and says so on every decision, rather than keeping a silently incomplete history. The file is append-only and never rotated; retention is the deployment's own.

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
| `src/select.ts` | Endpoint and model rejection reasons, the blended price, ranking, uptime relaxation |
| `src/diagnostics.ts` | The candidate table of one decision and the bounded JSONL file it is appended to |
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
- Ranking reads a live endpoint list. Between the read and the request the cheapest provider can fail; the adapter handles that by re-deciding at the `failure` boundary, not by re-reading here. A candidate is benched for `excludeAfterFailureMs` once it has failed `excludeAfterFailures` times in a row (default 5), and that candidate's next success clears the count, as does the bench lapsing — so one blip does not displace a route that has been answering, and a route that returns after its cooldown is not still serving the run that benched it. A request retries the pinned candidate until the count reaches the threshold and only then moves, so `maxReroutes` bounds the moves between candidates rather than the attempts on one. A failure that arrives after content has already streamed benches the candidate the same way, even though that attempt cannot be replayed, so the re-decision cannot land on it again.
- `minQuantization` is a floor, not a proof: a provider declaring `unknown` on a trusted host states no format at all, and this package accepts the host's word for it (§3.2 of the plan).
- Under `snapshotPolicy: 'latest'` a tier follows its families, so a new release changes the model and the price behind a configuration nobody edited. The catalog is read at most every `catalogTtlMs`, and the move is reported once in the log and recorded in every decision, but nothing asks first. A deployment that has to approve a release change belongs on `pinned`.
- The family comes from the catalog's `canonical_slug`, so a model published only as an undated id — including every OpenRouter `~alias` — has no family and never moves.
- The diagnostics file is append-only and never rotated. Each line is bounded, the file is not: a deployment that enables it owns its retention.
- A direct source declares its own prices and its `tools` capability; nothing measures its status, uptime or quantization, so those filters stay neutral for it. A deployment that needs one of those to bind must express it in the source's configuration, not expect a measurement to appear.
- Rerouting is the default for every failure that arrives before the first content chunk, and `noRerouteCodes` names the exceptions — the codes no candidate can serve: `CONTEXT_WINDOW_EXCEEDED` (a model window, whose remedy is compaction), `IMAGE_OFFLOAD_REQUIRED` (an image budget every route shares) and `ABORTED` (a cancelled request). A provider rejection the taxonomy has never seen therefore reroutes by default, at the cost of at most `maxReroutes` moves to another candidate on a request that is invalid everywhere.

<a id="dev-note"></a>
### Dev Note

None.
