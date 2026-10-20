---
description: "面向用户与维护者的回退执行器说明：在持久 agent（智能体）步骤边界上配置跨提供方的模型请求恢复。"
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-fallback

[English](README.md) | 中文

## 概述

挂载 `@deepseek-ai/dsh-llm-fallback`，可在当前提供方的失败为终态后，自动切换到配置链中的下一提供方。链是按 intent（会话的 agent preset）索引的、有序的 `{provider, model, label?}` 步骤列表；失败的提供方先通过 `llm-retry` 耗尽自己的重试预算 — 回退监听在 `llm-retry` 之后，仅当失败本应为终态时才前进链。每次尝试都是一次完整、计费的请求；持久的 `llm/fallback` 会话事件（带 `ignorable: true` 追加）记录过渡；链耗尽时错误保持终态，无循环。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当 agent 运行应通过尝试备选提供方从终态提供方失败中恢复 — 例如 DeepSeek → Claude → OpenRouter — 而不是结束轮次时，挂载本插件。它是执行器：链配置本身位于本插件的 `chains` 字典中，而每个提供方的重试策略仍保留在其适配器上，通过 `dsh-llm-retry`。

### 何时选择

当组合运行 agent loop（智能体循环）并需要在持久步骤边界上进行跨提供方恢复时选择它。本插件是带 `chains` 配置的函数插件；`dsh-llm-deepseek` 与 `dsh-llm-pi-ai` 等提供方适配器拥有各自路由的 `retryPolicy`。未挂载 `dsh-llm-retry` 时链仍会前进 — 在每个提供方的首次失败时立即移动；若希望每个提供方先耗尽自身重试预算再前进链，请挂载 `dsh-llm-retry`。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-llm-fallback'
  config:
    chains:
      sib-general:
        steps:
          - provider: deepseek
            model: deepseek-chat
            label: primary
          - provider: claude-proxy
            model: claude-3-5-sonnet
            label: fallback-1
          - provider: openrouter
            model: deepseek/deepseek-chat
            label: fallback-2

- name: '@deepseek-ai/dsh-llm-retry'
```

`chains` 字典按 intent 索引。intent 从会话的 agent preset（`agentPreset` 投影）解析。本例中，preset 为 `sib-general` 的会话将使用上述三步链。preset 没有匹配链的会话会让插件处于非活跃状态（挂载时记录一次警告）。每条链的 `steps` 数组有序：第一步是主提供方；后续步骤仅在前一步失败为终态且重试预算耗尽后尝试。单步链合法但永不前进。

### 链如何被选择

会话的 agent preset 名称即用于在 `config.chains` 中查找链的 intent 键。若 preset 没有匹配链，插件对该会话非活跃，并在挂载时记录一次警告：`llm-fallback: no fallback chains configured; the plugin is inactive`。插件不回退到默认链 — 配置必须显式覆盖使用中的 preset。

### 与 llm-retry 的顺序

插件在 `agent/request-error` 上注册，位于 `llm-retry` 之后（标准 Cordis 监听器顺序）。在其监听器中，它先调用 `next()`，因此 `llm-retry` 先运行并决定是否在同一提供方上重试。仅当 `llm-retry` 返回非 `retry` 动作（预算耗尽或不合格失败 code）时，回退监听器才前进链并返回 `{ kind: 'retry' }`，导致 loop 以下一提供方重启同一步骤。新提供方从全新的重试预算开始，因为 `llm-retry` 的状态键是 `(provider, policyKey)` 对。

### 耗尽时发生什么

若失败步骤是其链的最后一步，插件返回下游动作（终态错误）且不返回 `retry`。轮次以原始失败结束 — 无循环、无静默重试。会话日志显示失败步骤的 provider/model 与链耗尽。

### 成本提示

每次尝试 — 主提供方、主提供方上的重试、以及每个回退步骤 — 都是一次完整的提供方请求并相应计费。`llm/fallback` 事件本身不贡献任何 token。

### 你可以观察到什么

每次回退过渡在下一次尝试前就是持久的：插件追加一个非表层 `llm/fallback` 事件，携带 turn、step、目标 provider/model、chain id、chain intent、1-based `attempt`（主提供方 = 1，首次回退 = 2）、失败的 `from` provider/model、以及触发过渡的失败。事件带 `ignorable: true` 追加 — 读取方可跳过而不丢失数据。随后重试步骤的 `request/header` 事件显示新 provider。

### 失败与恢复

在任何最终适配器被选中之前发生的失败没有链，原样委派下游。当前步骤未在链中找到（provider/model 不匹配）的链委派。当前步骤为最后一步的链委派。插件从不改写链或倒退 — 步骤索引单调增长。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释执行器背后的设计；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

执行器建立在一条规定之上：**先持久、后前进，打开步骤边界。** 任何 loop 重启步骤之前，回退过渡就已通过会话日志计划，因此崩溃或取消永远不会留下不可见的待处理过渡。恢复运行在 agent loop 的 `agent/request-error` waterfall（瀑布式事件），即打开步骤扩展点上，而不是包装 `ctx.llm.stream()`——原始流无法持久地区分已发出的分片，而 loop 可以在同一个打开的轮次内重跑失败步骤。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index-plugin.ts`](src/index-plugin.ts) | 函数插件：waterfall 监听器、链解析、持久事件追加 |
| [`src/config.ts`](src/config.ts) | 配置验证与解析（挂载时一次性） |
| [`src/types.ts`](src/types.ts) | 浏览器安全的 `llm/fallback` 事件载荷类型 + `SessionEventMap` 合并 |
| [`src/brand.ts`](src/brand.ts) | 事件载荷共享的 `FallbackChainId` 品牌 |

### 恢复流程

失败步骤连同其提供方与失败一起到达 waterfall。`agent/request-error` 监听器先调用 `next()`（这样 `llm-retry` 先运行），然后检查下游是否返回了 `retry`。如果没有，它读取按 agent 分槽的状态，匹配 `agent/request` 为此 `(turn, step)` 最后返回的 `(provider, model)` 对。循环卫士阻止若同一 `(turn, step)` 的待处理过渡存在但未被消费则重复前进。为会话的 intent 解析链；通过严格的 `(provider, model)` 匹配找到当前步骤索引。若存在下一步，记录待处理过渡，追加 `llm/fallback` 事件，并返回 `{ kind: 'retry' }`。随后的 `agent/request` 监听器消费待处理过渡，并返回下一步的 provider/model。

### 进度状态

进度状态是按 agent 分槽的 `WeakMap` 中的一个槽位 — `lastProposed`（`agent/request` 监听器为此 `(turn, step)` 最后返回的 `(provider, model)` 对）与 `pending`（计划的过渡）。待处理由 `agent/request` 恰好消费一次；无需重置监听器，因为 `(turn, step)` 在会话内永不重复，`lastProposed` 在每次请求时覆写，而未被消费的 `pending` 仅阻止对同一 `(turn, step)` 的重复前进 — 即循环卫士。

### Waterfall 组合

本插件是 `agent/request-error` waterfall 中的一个监听器。其"下游优先"姿态意味着 `llm-retry` 在链前进前耗尽预算。之后忽略取消且永不结算的策略也会阻止回退、轮次完全停稳与插件释放完成；成功、取消或释放会在活动委派恢复达到完全停稳后停止回退。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从服务约定逐步进入拥有重试策略的适配器、以及在回退前运行的重试执行器。

- [dsh-llm 服务](../llm/README.zh.md)——其适配器拥有 `retryPolicy` 的提供方无关服务。
- [llm-deepseek 适配器](../llm-deepseek/README.zh.md)——带路由级 `retryPolicy` 的提供方适配器。
- [llm-pi-ai 适配器](../llm-pi-ai/README.zh.md)——带逐 profile `retryPolicy` 的多提供方适配器。
- [llm-retry 包](../llm-retry/README.zh.md)——在 `agent/request-error` 上回退前运行的重试执行器。
- [LLM 流终止失败](../../../.agents/notes/implemented/architecture/2026-07-29-terminal-llm-stream-failures.zh.md)——失败如何以终止分片到达服务边界。
- [LLM 流式子系统](../../../docs/subsystems/llm-streaming.zh.md)——`StreamChunk` 协议与适配器约定（adapter contract）。

-----

<a id="model-experience"></a>
## 模型体验

### 模型请求恢复

#### 模型看到什么

回退事件、提供方切换或失败的部分输出都不会对模型可见。除非下游恢复策略刻意改变该表层，重试步骤会从持久表层历史中重建相同的显式提供方／模型请求；失败分片绝不进入派生消息。

#### Token 影响

每次回退尝试都是一次新的提供方请求，可能重复输入 token 计费。主提供方的重试由其 `retryPolicy` 管辖；每个回退步骤从全新预算开始。`llm/fallback` 本身不贡献任何 token。

#### KV Cache 影响

重建的请求保留此前前缀，有资格按该提供方规则复用提供方缓存。非表层回退事件不改变缓存标识。提供方切换将缓存资格重置为新提供方的规则。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明执行器在哪里停止、由未来工作接续。它们是当前包约束，不是通用回退对比或任务积压。

- **agent 轮次是唯一回退边界**——辅助调用（`session-title`、`compaction`）绕过 `step()`，不在链覆盖范围内；它们仍在其配置的提供方上单次尝试。
- **无中流切换**——每次尝试（主提供方、重试、回退）都是完整请求；失败提供方的流式响应不能通过中流切换挽救。
- **成功回退后，响应的提供方继续作为该会话的路由**——新提供方用于同一轮次的后续步骤与未来轮次；这是一个记录在案的决策，而非隐式副作用。
- **多提供方回合的用量计量与 UI 超出范围**——每次尝试都会计费；聚合或展示跨提供方用量是单独任务。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是不具权威性的工作上下文：维护者备注与开放问题。已交付的行为与既定理由以上文、包代码和相关 Agent Note 为准。

- 对链索引的严格 `(provider, model)` 匹配意味着重复对的链在挂载时被拒绝；未提供时链 ID 自动生成。
- `llm/fallback` 上的 `ignorable: true` 信封意味着不知该类型的读取方按标记跳过而非拒绝日志 — 这与 `llm/retry` 相同的兼容性模式。
- Chain intent 即 preset 名称；链在每次 `agent/request-error` 时从当前投影状态重新解析，因此会话中途改变 preset 影响的是下一次过渡，而非进行中的过渡。

</details>