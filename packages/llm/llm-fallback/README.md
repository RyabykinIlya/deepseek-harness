---
description: "The fallback executor for users and maintainers configuring cross-provider model-request recovery at durable agent-step boundaries."
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-fallback

English | [中文](README.zh.md)

## Summary

Mount `@deepseek-ai/dsh-llm-fallback` to automatically switch to the next provider in a configured chain after the current provider's failure is terminal. Chains are ordered lists of `{provider, model, label?}` steps keyed by intent (the session's agent preset); the failing provider first exhausts its own retry budget via `llm-retry` — fallback listens after `llm-retry` and only advances the chain when the failure would otherwise be terminal. Each attempt is a complete, billed request; the durable `llm/fallback` session event (appended with `ignorable: true`) records the transition; on exhaustion the error stays terminal with no loop.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin when agent runs should recover from terminal provider failures by trying an alternative provider — e.g., DeepSeek → Claude → OpenRouter — instead of ending the turn. It is the executor: the chain configuration itself lives in this plugin's `chains` dictionary, and the retry policy for each provider remains on its adapter via `dsh-llm-retry`.

### When to choose it

Choose it when a composition runs the agent loop and wants cross-provider recovery at durable step boundaries. The plugin is a function plugin with a `chains` config; provider adapters such as `dsh-llm-deepseek` and `dsh-llm-pi-ai` own the `retryPolicy` for their routes. Skip it when the composition does not mount `dsh-llm-retry` — without it, every failure is terminal and the chain cannot advance.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-llm-fallback'
  config:
    chains:
      sib-general:
        steps:
          - provider: deepseek
            model: deepseek-chat
            label: primary
          - provider: claude-proxy
            model: claude-3-5-sonnet
            label: fallback-1
          - provider: openrouter
            model: deepseek/deepseek-chat
            label: fallback-2

- name: '@deepseek-ai/dsh-llm-retry'
```

The `chains` dictionary is keyed by intent. The intent is resolved from the session's agent preset (the `agentPreset` projection). In this example, a session whose preset is `sib-general` will use the three-step chain above. A session with a preset that has no matching chain leaves the plugin inactive (a single mount-time warning is logged). Each chain's `steps` array is ordered: the first step is the primary provider; subsequent steps are tried only when the previous step's failure is terminal after its retry budget is exhausted. A chain with one step is valid but never advances.

### How a chain is chosen

The session's agent preset name is the intent key used to look up a chain in `config.chains`. If no chain matches the preset, the plugin is inactive for that session and logs one warning at mount time: `llm-fallback: no fallback chains configured; the plugin is inactive`. The plugin does not fall back to a default chain — the configuration must explicitly cover the presets in use.

### Ordering with llm-retry

The plugin registers on `agent/request-error` after `llm-retry` (standard Cordis listener order). In its listener, it calls `next()` first, so `llm-retry` runs first and decides whether to retry on the same provider. Only when `llm-retry` returns a non-`retry` action (exhausted budget or ineligible failure code) does the fallback listener advance the chain and return `{ kind: 'retry' }`, causing the loop to restart the same step with the next provider. The new provider starts with a fresh retry budget because `llm-retry`'s state key is the `(provider, policyKey)` pair.

### What happens on exhaustion

If the failing step is the last in its chain, the plugin returns the downstream action (terminal error) and does not return `retry`. The turn ends with the original failure — no loop, no silent retry. The session log shows the failed step's provider/model and the chain exhaustion.

### Cost note

Every attempt — primary, retries on the primary, and each fallback step — is a complete provider request and is billed accordingly. The `llm/fallback` event itself contributes no tokens.

### What you can observe

Each fallback transition is durable before the next attempt: the plugin appends a non-surface `llm/fallback` event carrying the turn, step, target provider/model, chain id, chain intent, 1-based `attempt` (primary = 1, first fallback = 2), the failed `from` provider/model, and the failure that triggered the transition. The event is appended with `ignorable: true` — readers may skip it without data loss. The subsequent `request/header` event for the retried step shows the new provider.

### Failures and recovery

A failure before any final adapter is selected has no chain and delegates downstream unchanged. A chain whose current step is not found in the chain (provider/model mismatch) delegates. A chain whose current step is the last delegates. The plugin never mutates the chain or rewinds — the step index grows monotonically.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design behind the executor; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The executor is built on one rule: **durable before advance, open-step boundaries.** A fallback transition is scheduled through the session log before the loop restarts the step, so a crash or cancellation never leaves an invisible pending transition. Recovery runs on the agent loop's `agent/request-error` waterfall, the open-step extension point, rather than wrapping `ctx.llm.stream()` — a raw stream cannot separate already-emitted chunks durably, while the loop can re-run the failed step inside the same open turn.

### Source map

| File | Role |
|---|---|
| [`src/index-plugin.ts`](src/index-plugin.ts) | The function plugin: waterfall listeners, chain resolution, durable event append |
| [`src/config.ts`](src/config.ts) | Config validation and resolution (once at mount) |
| [`src/types.ts`](src/types.ts) | Browser-safe `llm/fallback` event payload type + `SessionEventMap` merge |
| [`src/brand.ts`](src/brand.ts) | The `FallbackChainId` brand shared by the event payload |

### Recovery flow

A failed step arrives on the waterfall with its provider and failure. The `agent/request-error` listener calls `next()` first (so `llm-retry` runs), then checks whether downstream returned `retry`. If not, it reads the per-agent slot to match the `(provider, model)` pair last proposed by `agent/request` for this `(turn, step)`. A loop guard blocks re-advance if a pending transition for the same `(turn, step)` exists but was not consumed. The chain for the session's intent is resolved; the current step index is found by strict `(provider, model)` match. If a next step exists, a pending transition is recorded, the `llm/fallback` event is appended, and `{ kind: 'retry' }` is returned. The subsequent `agent/request` listener consumes the pending transition and returns the next step's provider/model.

### Progress state

Progress state is one slot per agent in a `WeakMap` — `lastProposed` (the `(provider, model)` pair the `agent/request` listener last returned for that `(turn, step)`) and `pending` (the scheduled transition). A pending is consumed exactly once by `agent/request`; no reset listeners are needed because `(turn, step)` never repeats within a session, `lastProposed` is overwritten on every request, and an unconsumed `pending` only blocks re-advancing the same `(turn, step)` — the loop guard.

### Waterfall composition

The plugin is one listener in the `agent/request-error` waterfall. Its "downstream first" posture means `llm-retry` exhausts its budget before the chain advances. A later policy that ignores cancellation and never settles also prevents fallback, turn quiescence, and plugin disposal from completing; success, cancellation, or disposal stops fallback after active delegated recovery reaches quiescence.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the service contract to the adapters that own retry policies and the retry executor that runs before fallback.

- [dsh-llm service](../llm/README.md) — the provider-neutral service whose adapters own `retryPolicy`.
- [llm-deepseek adapter](../llm-deepseek/README.md) — a provider adapter with a route-level `retryPolicy`.
- [llm-pi-ai adapter](../llm-pi-ai/README.md) — a multi-provider adapter with per-profile `retryPolicy`.
- [llm-retry package](../llm-retry/README.md) — the retry executor that runs before fallback on `agent/request-error`.
- [Terminal LLM stream failures](../../../.agents/notes/implemented/architecture/2026-07-29-terminal-llm-stream-failures.md) — how failures reach the service boundary as terminal chunks.
- [LLM streaming subsystem](../../../docs/subsystems/llm-streaming.md) — the `StreamChunk` protocol and adapter contract.

-----

<a id="model-experience"></a>
## Model Experience

### Model-request recovery

#### What the model sees

No fallback event, provider change, or failed partial output is model-visible. The retried step reconstructs the same explicit provider/model request from durable surface history unless a downstream recovery policy deliberately changes that surface; failed chunks never enter derived messages.

#### Token effect

Each fallback attempt is a new provider request and may repeat input-token billing. The primary provider's retries are governed by its `retryPolicy`; each fallback step starts with a fresh budget. `llm/fallback` itself contributes no tokens.

#### KV Cache effect

The reconstructed request preserves the prior prefix and is eligible for provider cache reuse under that provider's rules. The non-surface fallback event does not change cache identity. A provider change resets cache eligibility to the new provider's rules.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define where the executor stops and future work begins. They are current package constraints, not a general fallback comparison or a task backlog.

- **Agent turns are the only fallback boundary** — auxiliary calls (`session-title`, `compaction`) bypass `step()` and are not covered by the chain; they remain single-attempt on their configured provider.
- **No mid-stream switching** — each attempt (primary, retries, fallbacks) is a whole request; a streaming response from a failed provider is not salvaged by switching mid-stream.
- **After a successful fallback the responding provider remains the route for the session** — the new provider is used for subsequent steps of the same turn and future turns; this is a recorded decision, not an implicit side effect.
- **Usage metering and UI for multi-provider turns is out of scope** — every attempt is billed; aggregating or displaying cross-provider usage is a separate task.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: notes for maintainers and open questions. Shipped behavior and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

- The `(provider, model)` strict match for chain indexing means a chain with duplicate pairs is rejected at mount time; the chain ID is generated if not provided.
- The `ignorable: true` envelope on `llm/fallback` means a reader that does not know the type skips it per the marker instead of refusing the log — this is the same compatibility pattern as `llm/retry`.
- Chain intent is the preset name; changing the preset mid-session does not re-resolve the chain — the chain is resolved once per `agent/request-error` from the current projection state.

</details>