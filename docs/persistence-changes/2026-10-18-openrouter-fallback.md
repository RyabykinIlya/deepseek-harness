---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-18-openrouter-fallback

English | [中文](2026-10-18-openrouter-fallback.zh.md)

## Summary

Adds the per-Session OpenRouter fallback choice as a new ignorable event, records the effective value on each routing decision, and adds the subscription-only rejection key.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-18-openrouter-fallback
baseline: false
changes:
  - root: "event:model-routing/decision"
    previous: "2026-10-05-model-routing-decision-diagnostics"
    after: "4881e34a99b95c4c750b1a7c7baaf21ffadf8077e63dd614d58f9309fe8aa4e3"
    decision: same-version
  - root: "event:model-routing/openrouter-fallback"
    previous: null
    after: "ab604067b9a99516a7d23eb6578528e82925046b6a7f758ff01f3c43d2e69136"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Same version. Older readers that do not know `model-routing/openrouter-fallback` skip it, because the envelope marks it ignorable, and an absent choice means the Session follows the deployment default. `openRouterFallback` on a decision is optional, so a log written before this change reads as a decision that stated no value and the projection answers the default. The new `subscription-only` key appears only in `rejections` and `cheapestRejected[].rejection` values written after the change; readers enumerate those records rather than requiring every key, and a record written earlier therefore reads as a count that never occurred. The remaining items this record covers were written earlier in this tree and are additive or optional in the same way: `source` and `cheapestRejected[].source` optional, and `endpoint.promptUsd`/`completionUsd` made optional so an unpinned or directly-served decision can state an endpoint without inventing prices.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/experimental/model-routing packages/experimental/client-ui-model-routing: 29 files, 412 tests passed; projection spec covers the fold of the new event and the view value, adapter spec covers both switch states.

<a id="dev-note"></a>
## Dev Note

None.
