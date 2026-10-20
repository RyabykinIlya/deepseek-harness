---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-19-model-routing-failure-fields

[English](2026-10-19-model-routing-failure-fields.md) | 中文

## 概述

在 model-routing 的 failure 重决策上新增可选的 failedTag 与 failureCode：派发失败从而被停用的候选 tag，以及提供方失败码。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

已有记录仍然有效：两个字段都是可选的，不认识它们的读取方会忽略这个可忽略的纯日志事件上的未知属性。缺少 failureCode 表示该决策不是 failure 重决策（或早于这两个字段）；有 failureCode 但缺少 failedTag 表示失败的 pin 未指名具体 endpoint。该记录同时补记此前未记录的可选 imagesOmitted 字段，它同样是加法式变更。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/experimental/model-routing packages/experimental/client-ui-model-routing packages/experimental/model-routing-profile：24 个文件、353 个测试通过，包括 failure tag/code 记录、fixed 模型错误文案与辅助 purpose 作用域隔离的新用例。

<a id="dev-note"></a>
## 开发备注

无。
