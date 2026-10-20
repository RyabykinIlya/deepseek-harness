# ADR-0001: Implement cross-provider LLM fallback as a new capability seam

- Status: accepted
- Date: 2026-10-20
- Deciders: DeepSeek Harness team

## Context

The current LLM retry mechanism (`dsh-llm-retry`) only retries on the **same provider** that failed. Each provider adapter owns its `retryPolicy` (bounded `normal` mode or unbounded `always` mode). When a provider fails with a non-retryable code or exhausts its budget, the turn ends with an error — no attempt is made to use a different provider.

Users have requested automatic fallback to alternative providers (e.g., DeepSeek → Claude → OpenRouter) when the primary provider fails. This is architecturally significant because:

1. **Model identity changes** — A request specifies `provider + model`. Fallback changes both, affecting context window, modalities, reasoning, pricing, and prompt compatibility.
2. **Credential isolation** — Each provider route has independent credentials. Fallback needs cross-provider auth resolution.
3. **Routing policy violation** — Deployments explicitly choose providers for cost, latency, data residency. Silent fallback bypasses that intent.
4. **Session log fidelity** — The log records `provider` per request. Mid-turn provider change breaks replay and debugging.
5. **New capability seam** — This requires Service Definition / Provider / Consumer roles, not a tweak to `llm-retry`.

## Decision

We will implement **cross-provider LLM fallback** as a new package `dsh-llm-fallback` that provides:

1. **Service Definition**: `LlmFallbackRouter` — resolves an ordered fallback chain for a request intent and executes it with per-provider retry coordination.
2. **Configuration**: Fallback chains per intent (e.g., `default`, `coding`, `title`) in user settings / `cordis.yml`.
3. **Agent-loop integration**: A listener on `agent/request-error` that, after the current provider's retry policy is exhausted, advances to the next provider in the chain.
4. **Session logging**: Each fallback attempt recorded as `llm/fallback` event with provider, model, reason, and previous failure.
5. **Per-provider retry coordination**: The existing `llm-retry` plugin runs first on each provider; fallback only triggers after that provider's policy is exhausted.
6. **Prompt/message translation**: Re-derive the request for each provider's protocol (system prompt slot, tool schema format, message roles).

Non-goals:
- Transparent mid-stream provider switching (each attempt is a full request)
- Fallback for `ctx.llm.stream()` direct calls (only agent-loop turns)
- Model-only fallback within the same provider (handled by `model-routing`)

## Alternatives Considered

- **Extend `llm-retry` with provider iteration** — Rejected: violates provider-owned retry policy; mixes retry semantics with routing semantics; `llm-retry` has no access to other providers' configs.
- **Add fallback to `model-routing` (experimental)** — Rejected: `model-routing` selects *before* the request based on price/availability; fallback is a *recovery* action after failure. Different triggers, different config.
- **Per-model fallback in provider config** — Rejected: couples provider config to other providers; no central chain management; no session-level visibility.

## Consequences

- Good: Resilience for unattended sessions; survives provider outages/quotas; explicit chain configuration.
- Bad: More complex request derivation; prompt translation may lose fidelity; token metering per actual provider; UI must show which provider answered.
- Neutral: `llm-retry` unchanged; providers still own their policies; fallback is opt-in via configuration.

## Revisit When

- If `model-routing` graduates and unifies selection + fallback (check in 6 months).
- If multi-provider streaming becomes viable (provider protocol convergence).
- If prompt translation proves too lossy for key use cases (monitor session logs).

## Affected Packages

- New: `packages/llm/llm-fallback/`
- Modified: `packages/core/agent-loop/` (integration point), `packages/llm/llm/` (types), `packages/client/` (UI projection)