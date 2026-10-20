# Agent Note: Cross-provider LLM fallback

Status: implemented

English | [中文](2026-10-20-cross-provider-llm-fallback.zh.md)

## Problem

The current LLM retry mechanism (`dsh-llm-retry`) only retries on the same provider that failed. Each provider adapter owns its retry policy (bounded normal mode or unbounded always mode). When a provider fails with a non-retryable code or exhausts its budget, the turn ends with an error — no attempt is made to use a different provider.

Users have requested automatic fallback to alternative providers (e.g., DeepSeek → Claude → OpenRouter) when the primary provider fails. This is architecturally significant because:

- Model identity changes — a request specifies provider + model. Fallback changes both, affecting context window, modalities, reasoning, pricing, and prompt compatibility.
- Credential isolation — each provider route has independent credentials. Fallback needs cross-provider auth resolution.
- Routing policy violation — deployments explicitly choose providers for cost, latency, data residency. Silent fallback bypasses that intent.
- Session log fidelity — the log records provider per request. Mid-turn provider change breaks replay and debugging.
- This requires a new capability seam (Service Definition / Provider / Consumer roles), not a tweak to llm-retry.

An earlier implementation attempt was reverted because it mutated core agent-loop types, created a cyclic dependency between core and the leaf plugin, hardcoded deployment-specific providers, and introduced an infinite loop in the step() while(true) loop.

## Decision

Cross-provider LLM fallback ships as the `@deepseek-ai/dsh-llm-fallback` package. It uses only the two existing waterfall listeners, with no core changes:

| Seam | Role |
|---|---|
| `agent/request-error` | Schedules the transition to chain step N+1, appends the durable `llm/fallback` session event, and returns `{ kind: 'retry' }` so the loop restarts the step on the same durable history |
| `agent/request` | Consumes the pending record and returns `LlmCallConfig` with the next chain step's provider/model |

`prepareRequest` calls `llm.prepareCall(proposedConfig)`, so returning a different provider resolves the other adapter. Prior art: `packages/experimental/model-routing/src/service.ts` rewrites config on this seam.

### Listener order and retry coordination

`llm-retry` mounts earlier on `agent/request-error`; `llm-fallback` calls `next()` first — so each provider exhausts its own retry budget before the chain advances. The retry state key is the `(provider, policyKey)` pair (`llm-retry/src/index.ts`), so the new provider starts with a fresh budget.

### Chain resolution and termination

The chain step index grows monotonically and never re-matches a failed provider. Matching uses the `(provider, model)` pair strictly — otherwise a chain with one provider and multiple models would resolve to the wrong index. If there is no next step, `retry` is not returned and the error stays terminal (no loop).

### Progress state

Progress state is one slot per agent in a `WeakMap` — `lastProposed` (the `(provider, model)` pair the plugin's `agent/request` listener last returned for that `(turn, step)`) and `pending` (the scheduled transition). A pending is consumed exactly once by `agent/request`; no reset listeners are needed because `(turn, step)` never repeats within a session, `lastProposed` is overwritten on every request, and an unconsumed `pending` only blocks re-advancing the same `(turn, step)` — the loop guard. The durable part is the `llm/fallback` session event (informational attempt log), appended with `ignorable: true`: readers may skip it, and its [persistence acknowledgement](../../../../docs/persistence-changes/2026-10-20-llm-fallback-event.md) records the same-version decision.

### Configuration

Fallback chains are a validated schemastery plugin `Config` keyed by intent resolved from the agent session's `agentPreset` projection; no deployment-specific providers are hardcoded in defaults. The intent name is the dictionary key; `chainIntent` in the event comes from it, not from a constant. If no matching chain exists, the plugin no-ops and logs once at mount. Invalid configuration fails at mount and names the chain key.

### Mounting is opt-in

The plugin is not mounted in any shipped bundle or profile. No deployment-independent default chain exists — the hardcoded provider defaults were removed by design — and an always-mounted plugin without chains logs its mount-time warning in every composition, while repository policy keeps opt-ins out of shipped defaults. A composition that wants cross-provider recovery mounts `@deepseek-ai/dsh-llm-fallback` explicitly with its `chains` config; the mount row is in the package README.

## Alternatives considered

**Extend llm-retry with provider iteration.** Rejected: violates provider-owned retry policy; mixes retry semantics with routing semantics; llm-retry has no access to other providers' configs.

**Add fallback to model-routing (experimental).** Rejected: model-routing selects before the request based on price/availability; fallback is a recovery action after failure. Different triggers, different config.

**Per-model fallback in provider config.** Rejected: couples provider config to other providers; no central chain management; no session-level visibility.

**Mutate core RequestErrorAction to include 'fallback'.** Rejected: adds a leaf-plugin action to a core type; everything needed is already expressible with the two existing waterfalls.

## Consequences

Every attempt is a full request and is billed; token metering and UI display for multi-provider turns are not included. Auxiliary calls (`session-title`, compaction) bypass `step()` and do not trigger fallback. After a fallback the responding provider remains the route for the rest of the session — a decision, not an accident. There is no mid-stream provider switching: each attempt is a complete request. The integration is subtle — calling `next()` first in `agent/request-error` is what lets llm-retry run first — and the upstream waterfall APIs it relies on are stable. A provider outside every chain, or a session whose preset has no chain, behaves exactly as before the feature.

## Testing

[tests/loader-composition.spec.ts](../../../../packages/llm/llm-fallback/tests/loader-composition.spec.ts) mounts the plugin from a `cordis.yml` through the real Loader (with the workspace modules mapped), pins the function-plugin surface with no default export, and accepts or rejects chains through the exported Config schema. [tests/fallback.spec.ts](../../../../packages/llm/llm-fallback/tests/fallback.spec.ts) drives a real agent loop over scripted adapters: the primary exhausts its retry budget and the wire sequence is `['a', 'a', 'b']`, the `llm/fallback` event carries the transition payload with the `ignorable` marker, the fallback provider starts a fresh retry budget, and the negative controls pin the exhausted-chain loop guard (a regression loops), the once-only advance of a two-step chain, providers and intents without a matching chain staying on the pre-feature terminal path, and mount-time rejection of an empty chain or a duplicate `(provider, model)` pair. [tests/config.spec.ts](../../../../packages/llm/llm-fallback/tests/config.spec.ts) covers config validation: chain id generation, empty steps/provider/model rejection, duplicate-pair rejection naming the chain, and agreement between the exported schema and the resolved config.
