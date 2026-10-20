---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-20-llm-fallback-event

[English](2026-10-20-llm-fallback-event.md) | 中文

## 概述

新增 llm/fallback 会话事件，在提供方失败为终态后记录每次跨提供方回退过渡。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

两个读取方向都安全，因此保持同版本。该事件仅写入日志，并以 ignorable 信封标记追加：不知该类型的读取方按该标记跳过，而不是拒绝日志，也没有读取方需要它来解释会话。旧日志的读取方永远不会遇到它，因为更早的写入方不会追加它。没有任何逻辑从中重建状态——没有投影消费它，也没有重放路径读取它——因此它的存在与否不会改变派生状态。该事件载荷只新增一个根，不改变任何既有事件成员。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/llm/llm-fallback/tests/config.spec.ts：11 个测试通过。写入本记录后 pnpm --silent run verify-persistence-changes 通过。

<a id="dev-note"></a>
## 开发备注

无。
