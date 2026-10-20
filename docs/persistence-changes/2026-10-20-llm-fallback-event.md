---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-20-llm-fallback-event

English | [中文](2026-10-20-llm-fallback-event.zh.md)

## Summary

Adds the llm/fallback session event, recording each cross-provider fallback transition after a provider failure is terminal.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-20-llm-fallback-event
baseline: false
changes:
  - root: "event:llm/fallback"
    previous: null
    after: "55933918f0652f7c9d8f1e67fea8e3434cc7ed07cf79c9bced52c502064cf9ed"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Both reader directions are safe, so this stays same-version. The event is log-only and appended with the ignorable envelope marker: a reader that does not know the type skips it per that marker instead of refusing the log, and no reader requires it to interpret the session. Readers of old logs simply never encounter it, because no earlier writer appends it. Nothing reconstructs state from it — no projection consumes it and no replay path reads it — so its presence or absence cannot change derived state. The event payload adds only a new root; no existing event member changes.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/llm/llm-fallback/tests/config.spec.ts: 11 tests passed. pnpm --silent run verify-persistence-changes: passes after this record is written.

<a id="dev-note"></a>
## Dev Note

None.
