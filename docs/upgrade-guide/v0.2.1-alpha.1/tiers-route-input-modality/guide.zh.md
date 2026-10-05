---
kind: upgrade-guide
description: "The `tiers` route enforces each tier's `input` declaration per model, so an image request reaches only a model the OpenRouter catalog shows accepting image input."
---

# `tiers` 路由针对图片请求强制执行 tier 的 `input` 声明

[English](guide.md) | 中文

## 变更

在 v0.2.1-alpha.1 中，`@deepseek-ai/dsh-experimental-model-routing` 开始强制执行每个 tier 的 `input` 字段。该字段原本用于设置路由对外公布的 `inputModalities`；现在它还决定哪些模型可以作答。一个到达该路由时携带图片的请求，只会在那些目录条目于 `architecture.input_modalities` 中列出 `image` 的候选模型上参与排序。未列出 `image` 的模型——包括目录根本没有列出的模型——其每一个 endpoint 都会以新的 `modality` 原因被拒绝，该计数出现在 `MODEL_ROUTING_NO_ENDPOINT` 消息中，形式为 `modality=<n>`。若某个 Session 被 pin 的模型无法服务该图片，它会丢弃该 pin，并在同一个 tier 内重新决策，记录的 boundary 为 `start`。目录读不出来时，没有任何模型被证明接受图片输入，因此该请求以同样方式失败，并在此之前有一行警告说明目录不可读。

声明 `input: [text]` 的 tier 不受影响：只要解析出的模型未公布图片输入，`dsh-llm` 就会在请求到达路由之前把图片内容投影为文本占位符。声明 `image` 的 tier 会受影响。向这样的 tier 添加纯文本模型是安全的，因为该模型只是永远不会被图片请求选中；但它无法再服务于一个已经读过图片的 Session，因为该图片会留在该 Session 的历史中，并在之后的每一次请求里被重放。`auto` 上报各 tier 的交集，因此只有当每个 tier 都声明时才声明 `image`。

## 迁移

1. 对每一个声明 `image` 的 tier，确认其列出的模型中至少有一个在 OpenRouter 模型目录里以 `architecture.input_modalities` 包含 `image` 的形式出现。从该 tier 中移除纯文本模型，或接受它们只服务文本请求。
2. 若某个本应服务图片的 tier 没有列出任何能接受图片的模型，请在 profile patch 行的 `models:` 列表中加入一个，并声明该模态：

   ```yaml
   - { name: pro, label: Pro, models: [z-ai/glm-5.3], contextWindow: 1000000, maxTokens: 32768, input: [text, image], minQuantization: fp8, unknownQuantization: reject, free: 'off' }
   ```

3. 让一个 Session 接收一张图片并确认该轮完成。没有任何可接受图片的候选的 tier 现在会失败：`model-routing: no endpoint of tier "<name>" passes the filters: ... modality=<n>`，其中的计数就是目录未证明接受图片输入的候选 endpoint 数量。
