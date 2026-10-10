# Agent Note: Bound provider-stall failover latency

Status: proposed

English | [中文](2026-10-10-provider-stall-failover-latency.zh.md)

## Problem

During the 2026-10-09 multi-thread run, `claude-proxy` endpoints stalled repeatedly. One model request produced 300.1 s of complete silence — the adapter `streamIdleTimeoutMs` default owned by [bounded LLM request recovery](../../implemented/architecture/2026-06-21-bounded-llm-request-recovery.md) — after which [model-routing](../../../../packages/experimental/model-routing/README.md) failed over through several more endpoints, and the next attempt stalled 155.8 s more until a manual abort. Other steps in the same thread showed 90–196 s gaps, and that thread recorded 13 `model-routing/decision: failure` events; sibling threads hit the same failures the same evening, and they were still recurring at 23:55 MSK. Recovery cost is bounded only by idle timeout × routes tried, so a stalled route reads as a hung thread to both the operator and a coordinating agent — on that evening it contributed to a wasted thread relaunch. The project owner deferred work on 2026-10-10: tolerate the latency for now and keep the record.

## Proposal

Deferred; when work resumes, candidate directions:

- Routing-aware idle timeout: fail over non-final model-routing candidate routes on a shorter idle budget than the configured final-route timeout.
- Surface idle/failover progress so a multi-minute wait is legible instead of silent.
- Order or probe routes by recent stall history; no circuit breakers exist today, and [bounded recovery](../../implemented/architecture/2026-06-21-bounded-llm-request-recovery.md) explicitly leaves them out of scope.

The five-minute default itself stays owned by bounded recovery; any change there updates that note.

## Alternatives considered

- **Lower the global `streamIdleTimeoutMs`.** Rejected for now: the five-minute default has documented prior art (Codex), interactive single-route users pay the trade-off differently, and the stall evidence implicates specific routes, not the watchdog.
- **Only watch provider status externally.** Rejected as the sole response: the failure recurred within one evening and already misled an automated coordinator; this note is the record kept without a code change.

## Acceptance criteria

When work resumes: a stalled non-final route fails over within a bounded sub-minute delay or emits visible idle progress; the final route keeps its configured idle timeout; `llm/retry` and routing events still reconstruct each attempt; tests pin stall→failover timing.

## Risks

Shorter per-route budgets can abort slow-but-valid reasoning streams; probes add moving parts and their own failure modes; any timeout change crosses the bounded-recovery ownership and must update that note and its verification.
