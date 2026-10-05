# Agent Note: Input modality is enforced per model from the catalog

Status: implemented

English | [中文](2026-10-05-per-model-input-modality-enforcement.zh.md)

## Problem

A tier's `input` field declares which modalities the tier advertises, and the route reports that declaration as the `inputModalities` of every model it serves. The declaration is a deployment's statement about the tier, not evidence about each model the tier lists: a tier that declares `image` while listing text-only models describes a capability its candidates do not have, and a real image then reaches a model that rejects it. The rejection arrives as a provider error after the turn has been paid for, and because an image that entered the durable history is replayed on every later request, the Session repeats it.

The evidence for what a model accepts exists in the OpenRouter model catalog the snapshot policy reads: each entry states `architecture.input_modalities`. Two questions follow. Whether the capability belongs to the tier's declaration or to the model the decision picks, and whether reading the catalog per decision costs more than the declaration is worth.

## Decision

### The catalog states the capability

`FamilyCache.modalities()` reads the same whole-catalog cache as `FamilyCache.resolve()` (`src/family-cache.ts`), so a decision that resolves families and looks up modalities makes one read rather than two. `parseOpenRouterCatalog` copies each entry's `architecture.input_modalities` into `inputModalities` (`packages/llm/llm-pi-ai/src/openrouter-catalog.ts`), and the cache maps exact model ids to that list.

### A model with no declaration is not a candidate

`rankEndpoints` asks `modelRejectionOf` for the model before it applies the per-endpoint filters (`src/select.ts`). When the request requires `image`, a model whose catalog entry does not list `image` is rejected, and every endpoint of that model is counted under the `modality` reason. A model the catalog does not list is treated the same way, because silence is not a capability. Each rejected endpoint still increments `considered`, and the existing `MODEL_ROUTING_NO_ENDPOINT` message reports `modality=<n>` beside the other rejection counts.

A catalog that cannot be read leaves no model shown to accept image input, so an image request fails with the same code and counts, plus one warning line naming the unreadable catalog as the reason. An unreadable catalog is not a routing failure for a text request, which never reads the catalog for modalities.

### The requirement comes from the request history

`requiredInputOf` scans every message of the request for image content (`src/adapter.ts`). An image that entered the durable Session history is replayed on every later request, so one image makes the Session image-bound rather than only the request that introduced it. Only a request that carries an image reads the catalog for modalities; a text request's ranking cannot depend on them and does not pay for the read.

### A pin that cannot serve the request is dropped, and the tier decides again

`tierForInput` asks the catalog about the pinned model and returns the pin's tier when the model is not shown to accept the required modality (`src/adapter.ts`). The adapter then discards the pin and targets that tier, so the new decision ranks the same tier under the same filters. The recorded boundary is `start`, because the request reaches a decision without a usable pin. `RoutingBoundary` keeps its five members — `start`, `selection-change`, `compaction`, `idle`, and `failure` (`src/types.ts`) — because the modality case is the unpinned case that `start` already names.

## Alternatives considered

- **Filter at the tier from its `input` declaration** — rejected because the declaration is the claim under test. A per-tier rule cannot express which of the tier's listed models accepts the image, and a tier declaring `image` over text-only models would stay wrong.
- **Configure accepted modalities per model** — rejected because the deployment would restate a catalog fact for every model it lists, and `snapshotPolicy: 'latest'` moves a tier's ids onto releases a static list cannot follow.
- **Re-decide onto a different tier when the pin cannot serve the request** — rejected because the tier is the deployment's cost and quality contract. The modality narrows which model inside the tier may answer; re-asking the judge on an image would change that contract on a content change and re-price the Session.
- **Add a `modality` member to `RoutingBoundary`** — rejected because the union names why a decision was taken relative to a pin. The modality case takes a decision with no usable pin, which `start` already records; a new member would make every reader enumerate a case it cannot distinguish from `start`.
- **Dispatch the image anyway when the catalog cannot be read** — rejected because no model is shown to accept it. The alternative is a provider rejection mid-turn on a request that cannot be replayed, which is the outcome the filter exists to prevent.

## Testing

`tests/select.spec.ts` covers the `modality` rejection, its count under `considered`, the unlisted and modality-less entries, and the unchanged ranking for a text-only request. `tests/adapter.spec.ts` covers serving an image request only from a catalog-declared model, re-deciding inside the pinned tier once an image arrives, and refusing an image request with the `modality=` counts when nothing is shown to accept one, including the unreadable-catalog warning. `tests/family-cache.spec.ts` covers the shared cached read behind `FamilyCache.modalities()`.

## Consequences

- A tier that declares `image` serves image requests only from models the catalog shows accepting image input, and fails loudly with `MODEL_ROUTING_NO_ENDPOINT` when none does.
- Adding a text-only model to that tier is safe, because the model is simply not chosen for an image request. It can never serve a Session that has read an image, because the image stays in the Session's history.
- The route advertises what the tier declares and enforces what the catalog states, so `auto` continues to report the intersection of the tiers' `input` declarations and declares `image` only when every tier does.
- A text request pays no catalog read and no new filter, and an image-bound Session re-decides inside the tier it was already on.
