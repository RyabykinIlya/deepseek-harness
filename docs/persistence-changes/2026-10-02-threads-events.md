---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-02-threads-events

English | [中文](2026-10-02-threads-events.zh.md)

## Summary

Adds the three log-only events a Project Session records for its background Threads: `thread/created` when a Thread is materialized, `thread/status` when a turn settles, and `thread/removed` when a Thread is archived. No Session format version changes.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-02-threads-events
baseline: false
changes:
  - root: "event:thread/created"
    previous: null
    after: "d5fe3d4064bc38f5494a185a9989874d2554a87f80f160c81b1511806dd8b0a2"
    decision: same-version
  - root: "event:thread/removed"
    previous: null
    after: "5e7e26c486fa1d27d7e44d7dd526033e857f74536d331c8e252f7196e1f7de83"
    decision: same-version
  - root: "event:thread/status"
    previous: null
    after: "a1e5859ef5ae9c15b177997a3451fc5330ee51585ff22c6a73cd77ce44e96580"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Three new roots in the same Session format version. Existing logs contain none of them and stay valid; a reader that predates them refuses a log carrying one **unless the event is marked `ignorable: true`**, and all three appends pass that marker. That marker is what makes an out-of-tree plugin safe to add event types at all: `session-persistence` skips an unknown ignorable event instead of refusing the whole log, so a DSH build without the Threads bundle still opens a Project session after its worktrees are gone. The events are log-only — none carries a `surfaceOp`, so none is joined into the model-visible surface or replayed as a message.

Durable Thread facts live here; liveness deliberately does not. "Running" is computed live from the Agent registry on every read and is never stored, so a Thread that died with its process reads as not running after a restart instead of staying `running` forever. A `thread/status` event is a field-wise partial update: a field absent from the event is left untouched, so a worktree-facts report never erases a recorded outcome.

Writers are the `subagent/start` and `subagent/end` listener plus the archive path; readers are the `threads` projection, the `thread_status` / `thread_diff` tools, and the Project roster. All three are appended only by the Threads profile bundle.

<a id="verification"></a>
## Verification

`pnpm exec vitest run packages/experimental/threads packages/experimental/tool-threads packages/experimental/threads-profile packages/subagent/worktree-manager packages/subagent/subagent-thread-worktree`: 312 tests passed. `packages/experimental/threads/tests/lifecycle-edges.spec.ts` covers every emitter failure path, including a Project that disappears mid-read and a rejected append, asserting containment through a logger exporter. `packages/core/session/tests/append-ignorable.spec.ts` covers the envelope marker and the reload path. `docs/subsystems/threads.md` documents the three events and the write-only isolation.

<a id="dev-note"></a>
## Dev Note

None.
