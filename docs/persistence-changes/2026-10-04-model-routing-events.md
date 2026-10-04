---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-04-model-routing-events

English | [中文](2026-10-04-model-routing-events.zh.md)

## Summary

Adds the two log-only events the `tiers` route records: `model-routing/decision`, written at every routing boundary with the tier, the concrete OpenRouter model, the pinned upstream endpoint, the runners-up, and the judge verdict behind an `auto` choice; and `model-routing/tier-override`, written when a Project coordinator moves one of its Threads to another tier. No Session format version changes.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-04-model-routing-events
baseline: false
changes:
  - root: "event:model-routing/decision"
    previous: null
    after: "a9dfa40309b88aa7bf4f8ea47f97a6ebb46e92d0096ae2d07d72c40fa671c623"
    decision: same-version
  - root: "event:model-routing/tier-override"
    previous: null
    after: "54ac409b8c99304d18d596b8c587b46a0ce778630b8739bf45e1f06729b26c86"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Two new roots in the same Session format version. Existing logs contain neither and stay valid; a reader that predates them refuses a log carrying one **unless the event is marked `ignorable: true`**, and both appends pass that marker. That is what makes the route safe to install out of tree: `session-persistence` skips an unknown ignorable event rather than refusing the whole log, so a DSH build without the model-routing bundle still opens a Project session whose log carries a decision. Both events are log-only — neither carries a `surfaceOp` — so neither is joined into the model-visible surface or replayed as a message, and a decision costs a conversation nothing.

The decision event is the only durable record of which upstream provider served a Session, which is why it is written even when the choice is uninteresting: a turn that went wrong cannot be diagnosed from a model id alone. `relaxedUptime` marks the one case where a filter was dropped rather than satisfied, and `unpinnedReason` marks the one case where the request went out with no provider pinned at all. `model-routing/tier-override` is written to the Project's own log rather than to the Thread's, because a cold resume of a Thread rebuilds its composition from the Project log; an override held anywhere else would be lost on the next Host restart.

The writer is `dsh-experimental-model-routing`'s adapter plus `ctx.modelRouting.setThreadTier`; the readers are the `modelRouting` projection, the composer chip, the Thread roster, and the settings page's price column. Both are appended only by the model-routing profile bundle.

<a id="verification"></a>
## Verification

`pnpm exec vitest run packages/experimental/model-routing packages/subagent/tool-subagent packages/llm/llm-pi-ai packages/experimental/threads-preset packages/experimental/tool-threads packages/experimental/client-ui-model-routing packages/experimental/model-routing-profile`: 928 tests passed. `packages/experimental/model-routing/tests/projection.spec.ts` folds every event of the `modelRouting` unit, including the `compaction/end` case that a failed compaction does not count as a boundary. `packages/experimental/model-routing/tests/adapter.spec.ts` writes both events from the real request path and asserts the ignored marker the reload rule depends on. `packages/core/session/tests/append-ignorable.spec.ts` covers the envelope marker itself.

<a id="dev-note"></a>
## Dev Note

None.
