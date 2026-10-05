---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-05-model-routing-decision-diagnostics

[English](2026-10-05-model-routing-decision-diagnostics.md) | 中文

## 概述

在 `model-routing/decision` 中新增路由决策的 token 配比、生效的过滤器、按原因统计的拒绝计数与各原因淘汰的最便宜候选，并在其携带的 endpoint 与次优记录中新增 `discount` 字段。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

已有日志仍可读：新增字段全部可选，缺少这些字段的决策只是早于本次变化，并不表示更少的事实。写入方从决策所依据的同一次排序中写出全部字段，因此缺失不携带任何需要读者猜测的含义。没有任何读取方依赖这些字段，也不带来 session 格式版本变化。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/experimental/model-routing：219 个测试通过，包括 tests/adapter.spec.ts 与 tests/service.spec.ts 中的决策事件与诊断文件用例。

<a id="dev-note"></a>
## 开发备注

无。
