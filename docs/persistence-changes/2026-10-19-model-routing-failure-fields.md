---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-19-model-routing-failure-fields

English | [中文](2026-10-19-model-routing-failure-fields.zh.md)

## Summary

Adds optional failedTag and failureCode to model-routing failure re-decisions: the benched candidate tag whose dispatch failed, and the provider failure code.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-19-model-routing-failure-fields
baseline: false
changes:
  - root: "event:model-routing/decision"
    previous: "2026-10-18-openrouter-fallback"
    after: "721843be2eb73a9896a6bd8126f70d98d28fb8b2a6123b983cfe31676c2a359a"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing records remain valid: both fields are optional, and readers that do not know them ignore unknown properties on an ignorable log-only event. Absence of failureCode means the decision was not a failure re-decision (or predates these fields); absence of failedTag with a failureCode means the failed pin named no concrete endpoint. The record also picks up the previously unrecorded optional imagesOmitted field, which is likewise additive.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/experimental/model-routing packages/experimental/client-ui-model-routing packages/experimental/model-routing-profile: 24 files, 353 tests passed, including new cases for failure tag/code recording, fixed-model error text, and auxiliary purpose scope isolation.

<a id="dev-note"></a>
## Dev Note

None.
