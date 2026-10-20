# Agent Note: Cross-provider LLM fallback

Status: proposed

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

## Proposal

Implement cross-provider LLM fallback as a new package `dsh-llm-fallback` that uses only the two existing waterfall listeners, with no core changes:

| Seam | Role |
|---|---|
| `agent/request-error` | Record "next attempt goes to chain step N+1" and return `{ kind: 'retry' }` so the loop restarts the step on the same durable history |
| `agent/request` | The next `prepareRequest` consumes the pending record and returns `LlmCallConfig` with the next chain step's provider/model |

`prepareRequest` calls `llm.prepareCall(proposedConfig)`, so returning a different provider actually resolves the other adapter. Prior art: `packages/experimental/model-routing/src/service.ts` rewrites config on this seam.

### Listener order and retry coordination

`llm-retry` mounts earlier on `agent/request-error`; `llm-fallback` calls `next()` first — so each provider exhausts its own retry budget before the chain advances. The retry state key is the `(provider, policyKey)` pair (`llm-retry/src/index.ts`), so the new provider starts with a fresh budget.

### Chain resolution and termination

The chain step index grows monotonically and never re-matches a failed provider. Matching uses the `(provider, model)` pair strictly — otherwise a chain with one provider and multiple models would resolve to the wrong index. If there is no next step, `retry` is not returned and the error stays terminal (no loop).

### Progress state

Progress state is one slot per agent in a `WeakMap` — `lastProposed` (the `(provider, model)` pair the plugin's `agent/request` listener last returned for that `(turn, step)`) and `pending` (the scheduled transition). A pending is consumed exactly once by `agent/request`; no reset listeners are needed because `(turn, step)` never repeats within a session, `lastProposed` is overwritten on every request, and an unconsumed `pending` only blocks re-advancing the same `(turn, step)` — the loop guard. The durable part is only the existing `llm/fallback` session event (non-surface attempt log), appended with `ignorable: true`: it is informational, and readers may skip it.

### Configuration

Fallback chains are a validated schemastery plugin `Config` keyed by intent resolved from the agent session (preset/tier); no deployment-specific providers are hardcoded in defaults. The intent name is the dictionary key; `intent` in the event comes from it, not from a constant. If no matching chain exists, the plugin no-ops and logs once at mount.

### Settled decisions (record explicitly)

After a successful fallback, the responding provider remains the route for subsequent steps of the session (a decision, not a side effect). Auxiliary calls (`session-title`, `compaction`) bypass `step()` and are out of scope. Every attempt is billed — usage metering and UI display is a separate task (non-goal).

## Alternatives considered

**Extend llm-retry with provider iteration.** Rejected: violates provider-owned retry policy; mixes retry semantics with routing semantics; llm-retry has no access to other providers' configs.

**Add fallback to model-routing (experimental).** Rejected: model-routing selects before the request based on price/availability; fallback is a recovery action after failure. Different triggers, different config.

**Per-model fallback in provider config.** Rejected: couples provider config to other providers; no central chain management; no session-level visibility.

**Mutate core RequestErrorAction to include 'fallback'.** Rejected: adds a leaf-plugin action to a core type; everything needed is already expressible with the two existing waterfalls.

## Acceptance criteria

- The `llm-fallback` package mounts without core changes.
- A two-mock-adapter test: first always fails with retryable code, second responds. Log shows `llm/fallback` with `from`/`to`, `request/header` with `reason: 'change'` and new `provider`, final `assistant/message` from second provider. First provider receives exactly its retry budget; second starts fresh.
- Chain exhaustion → terminal error, not a loop.
- Provider outside chains → behavior as before the feature.
- Invalid config → fails at mount with a clear message naming the chain.
- `pnpm run test:docs` passes.
- `pnpm run hygiene` passes.

## Risks

- The upstream API of the two waterfalls is stable, but the integration is subtle: calling `next()` first in `agent/request-error` is essential so llm-retry runs first.
- Every attempt is a full request and is billed; token metering and UI display for multi-provider turns is not included.
- Auxiliary calls (session-title, compaction) are out of scope — they bypass step() and would not trigger fallback.
- After fallback, the new provider sticks for the rest of the session; this is recorded as a decision, not an accident.
- No mid-stream provider switching — each attempt is a complete request.