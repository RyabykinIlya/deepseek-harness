---
kind: upgrade-guide
description: "The `tiers` route enforces each tier's `input` declaration per model, so an image request reaches only a model the OpenRouter catalog shows accepting image input."
---

# The `tiers` route enforces tier `input` declarations for image requests

English | [中文](guide.zh.md)

## Change

In v0.2.1-alpha.1, `@deepseek-ai/dsh-experimental-model-routing` enforces the `input` field of every tier. That field already set the `inputModalities` the route advertised; it now also decides which models may answer. A request that reaches the route carrying an image is ranked over only those candidate models whose OpenRouter catalog entry lists `image` in `architecture.input_modalities`. Every endpoint of a model that does not list it — including a model the catalog does not list at all — is rejected with the new `modality` reason, whose count appears in the `MODEL_ROUTING_NO_ENDPOINT` message as `modality=<n>`. A Session whose pinned model cannot serve the image drops that pin and decides again inside the same tier, recording boundary `start`. When the catalog cannot be read, no model is shown to accept image input, so the request fails the same way after one warning line naming the unreadable catalog.

A deployment whose tiers declare `input: [text]` is unaffected: whenever the resolved model does not advertise image input, `dsh-llm` projects image content to text placeholders before the request reaches the route. Deployments whose tiers declare `image` are affected. Adding a text-only model to such a tier is safe, because that model is simply never chosen for an image request, but it can no longer serve a Session that has read an image, since the image stays in the Session's history and is replayed on every later request. `auto` reports the intersection across tiers, so it declares `image` only when every tier does.

## Migration

1. For every tier that declares `image`, confirm that at least one listed model appears in the OpenRouter model catalog with `image` in `architecture.input_modalities`. Remove text-only models from that tier, or accept that they serve text requests only.
2. If a tier that should serve images lists no image-capable model, add one to its `models:` list in the profile patch row and declare the modality:

   ```yaml
   - { name: pro, label: Pro, models: [z-ai/glm-5.3], contextWindow: 1000000, maxTokens: 32768, input: [text, image], minQuantization: fp8, unknownQuantization: reject, free: 'off' }
   ```

3. Send a Session an image and confirm the turn completes. A tier with no image-capable candidate now fails with `model-routing: no endpoint of tier "<name>" passes the filters: ... modality=<n>`, where the count is the number of candidate endpoints the catalog does not show accepting image input.
