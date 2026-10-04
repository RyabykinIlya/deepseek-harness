---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-04-model-routing-events

[English](2026-10-04-model-routing-events.md) | 中文

## 概述

新增 `tiers` 路由记录的两个纯日志事件：`model-routing/decision`，在每个路由边界写入，包含层级、具体的 OpenRouter 模型、固定的上游端点、次优候选，以及 `auto` 选择背后的裁判结论；以及 `model-routing/tier-override`，由 Project 协调器把某个 Thread 切换到另一层级时写入。Session 格式版本不变。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

同一 Session 格式版本中的两个新根。既有日志两者都不包含，依然有效；早于它们存在的读取方会拒绝包含它们的日志，**除非事件被标记为 `ignorable: true`**，而两次追加都带上了该标记。正是这一点让该路由可以安全地在树外安装：`session-persistence` 会跳过未知的可忽略事件，而不是拒绝整份日志，因此没有装 model-routing 捆绑包的 DSH 构建仍能打开日志里带有决策记录的 Project 会话。两个事件都是纯日志事件——都不携带 `surfaceOp`——因此都不会被并入模型可见的消息面，也不会被当作消息重放，一次决策不会给对话带来任何代价。

决策事件是「哪个上游服务商服务了某个 Session」唯一的持久记录，这正是即使选择并不显眼也要写入的原因：一次出错的轮次无法仅凭模型 id 诊断。`relaxedUptime` 标记唯一一种「过滤器被放下而非被满足」的情况，`unpinnedReason` 标记唯一一种「请求完全没有固定服务商就发出去」的情况。`model-routing/tier-override` 写在 Project 自己的日志里而不是 Thread 的日志里，因为 Thread 的冷恢复是从 Project 日志重建其组合的；放在别处的覆盖会在下次 Host 重启时丢失。

写入方是 `dsh-experimental-model-routing` 的适配器与 `ctx.modelRouting.setThreadTier`；读取方是 `modelRouting` 投影、输入框的芯片、Thread 名册，以及设置页的价格列。两者都只由 model-routing 捆绑包追加。

<a id="verification"></a>
## 验证

`pnpm exec vitest run packages/experimental/model-routing packages/subagent/tool-subagent packages/llm/llm-pi-ai packages/experimental/threads-preset packages/experimental/tool-threads packages/experimental/client-ui-model-routing packages/experimental/model-routing-profile`：928 个测试通过。`packages/experimental/model-routing/tests/projection.spec.ts` 折叠了 `modelRouting` 单元的每个事件，包括「失败的 compaction 不算作边界」这一分支。`packages/experimental/model-routing/tests/adapter.spec.ts` 从真实请求路径写入两个事件，并断言重载规则所依赖的可忽略标记。`packages/core/session/tests/append-ignorable.spec.ts` 覆盖该标记本身。

<a id="dev-note"></a>
## 开发备注

无。
