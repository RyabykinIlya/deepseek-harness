# Agent Note: 跨提供商 LLM 回退

Status: proposed

[English](2026-10-20-cross-provider-llm-fallback.md) | 中文

## 问题

当前的 LLM 重试机制（`dsh-llm-retry`）只在失败的同一提供商上重试。每个提供商适配器拥有自己的重试策略（有界的 normal 模式或无界的 always 模式）。当提供商以不可重试的错误码失败或耗尽预算时，回合以错误结束 — 不会尝试使用不同的提供商。

用户请求在主提供商失败时自动回退到备选提供商（例如 DeepSeek → Claude → OpenRouter）。这在架构上很重要，因为：

- 模型身份改变 — 请求指定 provider + model。回退会改变两者，影响上下文窗口、模态、推理、定价和提示词兼容性。
- 凭据隔离 — 每个提供商路由有独立凭据。回退需要跨提供商的认证解析。
- 路由策略违规 — 部署显式选择提供商以控制成本、延迟、数据驻留。静默回退绕过了该意图。
- Session 日志保真度 — 日志按请求记录 provider。回合中途更换提供商会破坏重放和调试。
- 这需要一个新的能力缝合点（服务定义 / 提供方 / 消费方角色），而不是对 llm-retry 的微调。

一次早期的实现尝试被撤销，因为它修改了核心 agent-loop 类型，在核心与叶子插件之间制造了循环依赖，硬编码了特定部署的提供商，并在 step() 的 while(true) 循环中引入了无限循环。

## 提案

将跨提供商 LLM 回退实现为新包 `dsh-llm-fallback`，仅使用两个现有的 waterfall 监听器，不修改核心：

| 缝合点 | 角色 |
|---|---|
| `agent/request-error` | 记录“下一次尝试走向链步骤 N+1”并返回 `{ kind: 'retry' }`，使循环在同一 durable 历史上重启该步骤 |
| `agent/request` | 下一个 `prepareRequest` 消费待处理记录，并返回带有下一链步骤 provider/model 的 `LlmCallConfig` |

`prepareRequest` 调用 `llm.prepareCall(proposedConfig)`，因此返回不同的 provider 会真正解析到另一个适配器。现有技术：`packages/experimental/model-routing/src/service.ts` 正是在该缝合点上重写配置。

### 监听器顺序与重试协调

`llm-retry` 在 `agent/request-error` 上更早挂载；`llm-fallback` 先调用 `next()` — 因此每个提供商先耗尽自己的重试预算，然后链才前进。重试状态的键是 `(provider, policyKey)` 对（`llm-retry/src/index.ts`），所以新提供商从全新的预算开始。

### 链解析与终止

链步骤索引单调增长，永远不重新匹配已失败的提供商。匹配严格使用 `(provider, model)` 对 — 否则只含一个提供商但多个模型的链会解析到错误索引。如果没有下一步，不返回 `retry`，错误保持终态（无循环）。

### 进度状态

进度状态是以 `(turn, step)` 为键的内存 `Map`，在 `step/start` 和 `turn/end` 时重置。Durable 部分只有已有的 `llm/fallback` 事件（非表面的尝试日志）。待处理记录由 `agent/request` 恰好消费一次；同一步骤上重复的 `agent/request` 不会复用该过渡。

### 配置

回退链是一个经过验证的 schemastery 插件 `Config`，按从 agent session（preset/tier）解析出的 intent 索引；默认值中不硬编码任何特定部署的提供商。intent 名称即字典键；事件中的 `intent` 来自它，而非常量。若不存在匹配的链，插件在挂载时记录一次日志并无操作。

### 明确记录的既定决策

成功回退后，响应的提供商继续作为该会话后续步骤的路由（这是一个决策，而非副作用）。辅助调用（`session-title`、`compaction`）绕过 `step()`，不在范围内。每次尝试都会计费 — 用量计量与 UI 展示是单独任务（非目标）。

## 考虑过的替代方案

**在 llm-retry 中增加提供商迭代。** 拒绝：违反提供商拥有的重试策略；混淆了重试语义与路由语义；llm-retry 无法访问其他提供商的配置。

**在 model-routing（实验性）中增加回退。** 拒绝：model-routing 基于价格/可用性在请求前选择；回退是失败后的恢复动作。触发条件不同，配置也不同。

**在提供商配置中按模型回退。** 拒绝：将提供商配置耦合到其他提供商；无中央链管理；无会话级可见性。

**修改核心 RequestErrorAction 以包含 'fallback'。** 拒绝：向核心类型添加叶子插件的动作；两个现有 waterfall 已能表达所需的一切。

## 验收标准

- `llm-fallback` 包无需核心变更即可挂载。
- 双 mock 适配器测试：第一个总是以可重试错误码失败，第二个响应。日志显示带有 `from`/`to` 的 `llm/fallback`、带有 `reason: 'change'` 和新 `provider` 的 `request/header`、来自第二个提供商的最终 `assistant/message`。第一个提供商恰好收到其重试预算；第二个从零开始。
- 链耗尽 → 终态错误，非循环。
- 链外提供商 → 行为与功能引入前一致。
- 无效配置 → 挂载时失败，错误信息清晰指明是哪条链。
- `pnpm run test:docs` 通过。
- `pnpm run hygiene` 通过。

## 风险

- 两个 waterfall 的上游 API 是稳定的，但集成很微妙：在 `agent/request-error` 中先调用 `next()` 至关重要，这样 llm-retry 才会先运行。
- 每次尝试都是完整请求并会计费；多提供商回合的 token 计量与 UI 展示不在范围内。
- 辅助调用（session-title、compaction）超出范围 — 它们绕过 step()，不会触发回退。
- 回退后，新提供商在会话剩余时间内保持路由；这被记录为决策，而非意外。
- 无中流提供商切换 — 每次尝试都是完整请求。