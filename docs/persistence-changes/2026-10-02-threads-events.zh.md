---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-02-threads-events

[English](2026-10-02-threads-events.md) | 中文

## 概述

新增 Project Session 为其后台 Thread 记录的三个仅写日志事件：Thread 实体化时写 `thread/created`，一个回合结束时写 `thread/status`，Thread 被归档时写 `thread/removed`。Session 格式版本不变。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

同一 Session 格式版本下新增三个根。既有日志中不含它们，依然有效；早于它们的读取方遇到这类日志会拒绝，**除非事件被标记为 `ignorable: true`**，而这三处 append 都带上了该标记。正是这个标记让树外插件可以安全地新增事件类型：`session-persistence` 会跳过未知的 ignorable 事件，而不是拒绝整份日志，因此未安装 Threads 扩展包的 DSH 构建在其 worktree 被删除之后，依然能够打开 Project 会话。这些事件仅写日志——都不带 `surfaceOp`，因此都不会并入模型可见的 surface，也不会被当作消息重放。

持久化的 Thread 事实存放于此；存活状态则刻意不存。「运行中」在每次读取时由 Agent 注册表现场计算，从不落盘，因此随进程一同死掉的 Thread 在重启后读作未运行，而不会永远停留在 `running`。`thread/status` 事件是按字段的部分更新：事件中缺席的字段保持原值，所以一份 worktree 事实报告不会抹掉已记录的结局。

写入方是 `subagent/start` 与 `subagent/end` 监听器以及归档路径；读取方是 `threads` 投影、`thread_status` / `thread_diff` 工具和 Project 的 Thread 列表。这三个事件都只由 Threads profile 扩展包写入。

<a id="verification"></a>
## 验证

`pnpm exec vitest run packages/experimental/threads packages/experimental/tool-threads packages/experimental/threads-profile packages/subagent/worktree-manager packages/subagent/subagent-thread-worktree`：312 个测试通过。`packages/experimental/threads/tests/lifecycle-edges.spec.ts` 覆盖了写入方的每一条失败路径，包括读取过程中 Project 消失以及 append 被拒绝，并通过日志导出器断言错误被收敛。`packages/core/session/tests/append-ignorable.spec.ts` 覆盖信封标记与重载路径。`docs/subsystems/threads.md` 记录了这三个事件与「仅写隔离」。

<a id="dev-note"></a>
## 开发备注

无。
