---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-05-model-routing-decision-diagnostics

English | [中文](2026-10-05-model-routing-decision-diagnostics.zh.md)

## Summary

Adds the routing decision's token mix, applied filters, per-reason rejection counts, and cheapest-rejected candidates to `model-routing/decision`, and a `discount` field to the endpoint and runner-up records it carries.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-05-model-routing-decision-diagnostics
baseline: false
changes:
  - root: "event:model-routing/decision"
    previous: "2026-10-04-model-routing-events"
    after: "c363ac97e1e21dda433390f84a7f732f4b7ea5020a0f169c8e9b66cb024f4876"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing logs stay readable: every added field is optional, and a decision that lacks them predates this change rather than stating less. Producers write all of them from the one ranking the decision was taken over, so absence carries no meaning a reader must guess. No reader requires the fields, and no session format version follows.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/experimental/model-routing: 219 tests passed, including the decision-event and diagnostics-file cases in tests/adapter.spec.ts and tests/service.spec.ts.

<a id="dev-note"></a>
## Dev Note

None.
