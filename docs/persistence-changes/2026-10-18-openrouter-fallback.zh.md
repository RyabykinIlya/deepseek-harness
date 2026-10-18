---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-18-openrouter-fallback

[English](2026-10-18-openrouter-fallback.md) | 中文

## 概述

将每个会话的 OpenRouter 回退选择新增为可忽略事件，把生效值记录到每次路由决策上，并新增 subscription-only 拒绝原因。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

版本不变。不认识 `model-routing/openrouter-fallback` 的旧读取方会跳过它，因为信封标记为可忽略；缺少选择表示该会话沿用部署默认值。决策上的 `openRouterFallback` 是可选字段，因此本次改动之前写入的日志读作未声明取值，投影返回默认值。新的 `subscription-only` 键只会出现在改动之后写入的 `rejections` 与 `cheapestRejected[].rejection` 中；读取方遍历这些记录而不要求键齐全，因此更早的记录读作从未发生的计数。本条记录同时涵盖本代码树更早写入的其余项，它们同样是增量或可选的：`source` 与 `cheapestRejected[].source` 可选，`endpoint.promptUsd`/`completionUsd` 变为可选，使未固定或直连来源的决策可以在不虚构价格的情况下记录端点。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/experimental/model-routing packages/experimental/client-ui-model-routing：29 个文件、412 个测试通过；投影测试覆盖新事件的折叠与视图取值，适配器测试覆盖开关的两种状态。

<a id="dev-note"></a>
## 开发备注

无。
