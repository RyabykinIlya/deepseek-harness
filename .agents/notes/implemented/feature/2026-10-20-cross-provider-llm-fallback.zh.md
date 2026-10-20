# Agent Note: 跨提供商 LLM 回退

Status: implemented

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

## 决策

跨提供商 LLM 回退以 `@deepseek-ai/dsh-llm-fallback` 包发布。它仅使用两个现有的 waterfall 监听器，不修改核心：

| 缝合点 | 角色 |
|---|---|
| `agent/request-error` | 计划向链步骤 N+1 的过渡，追加 durable 的 `llm/fallback` 会话事件，并返回 `{ kind: 'retry' }`，使循环在同一 durable 历史上重启该步骤 |
| `agent/request` | 消费待处理记录，并返回带有下一链步骤 provider/model 的 `LlmCallConfig` |

`prepareRequest` 调用 `llm.prepareCall(proposedConfig)`，因此返回不同的 provider 会真正解析到另一个适配器。现有技术：`packages/experimental/model-routing/src/service.ts` 正是在该缝合点上重写配置。

### 监听器顺序与重试协调

`llm-retry` 在 `agent/request-error` 上更早挂载；`llm-fallback` 先调用 `next()` — 因此每个提供商先耗尽自己的重试预算，然后链才前进。重试状态的键是 `(provider, policyKey)` 对（`llm-retry/src/index.ts`），所以新提供商从全新的预算开始。

### 链解析与终止

链步骤索引单调增长，永远不重新匹配已失败的提供商。匹配严格使用 `(provider, model)` 对 — 否则只含一个提供商但多个模型的链会解析到错误索引。如果没有下一步，不返回 `retry`，错误保持终态（无循环）。

### 进度状态

进度状态是按 agent 分槽的 `WeakMap` 中的一个槽位 — `lastProposed`（插件 `agent/request` 监听器为此 `(turn, step)` 最后返回的 `(provider, model)` 对）与 `pending`（计划的过渡）。待处理由 `agent/request` 恰好消费一次；无需重置监听器，因为 `(turn, step)` 在会话内永不重复，`lastProposed` 在每次请求时覆写，而未被消费的 `pending` 仅阻止对同一 `(turn, step)` 的重复前进 — 即循环卫士。Durable 部分是 `llm/fallback` 会话事件（信息性尝试日志），带 `ignorable: true` 追加：读取方可以跳过它，其[持久化确认](../../../../docs/persistence-changes/2026-10-20-llm-fallback-event.zh.md)记录了同版本的决策。

### 配置

回退链是一个经过验证的 schemastery 插件 `Config`，按从 agent session 的 `agentPreset` 投影解析出的 intent 索引；默认值中不硬编码任何特定部署的提供商。intent 名称即字典键；事件中的 `chainIntent` 来自它，而非常量。若不存在匹配的链，插件在挂载时记录一次日志并无操作。无效配置在挂载时失败，并指明链键。

### 挂载为可选

该插件未挂载到任何已发布的 bundle 或 profile 中。不存在与部署无关的默认链 — 硬编码的提供商默认值已按设计移除 — 而始终挂载但无链的插件会在每次组合中记录挂载时警告，同时仓库策略将可选能力排除在已发布默认值之外。需要跨提供商恢复的组合应显式挂载 `@deepseek-ai/dsh-llm-fallback` 并提供 `chains` 配置；挂载行位于包 README 中。

## 考虑过的替代方案

**在 llm-retry 中增加提供商迭代。** 拒绝：违反提供商拥有的重试策略；混淆了重试语义与路由语义；llm-retry 无法访问其他提供商的配置。

**在 model-routing（实验性）中增加回退。** 拒绝：model-routing 基于价格/可用性在请求前选择；回退是失败后的恢复动作。触发条件不同，配置也不同。

**在提供商配置中按模型回退。** 拒绝：将提供商配置耦合到其他提供商；无中央链管理；无会话级可见性。

**修改核心 RequestErrorAction 以包含 'fallback'。** 拒绝：向核心类型添加叶子插件的动作；两个现有 waterfall 已能表达所需的一切。

## 影响

每次尝试都是完整请求并会计费；多提供商回合的 token 计量与 UI 展示不在范围内。辅助调用（`session-title`、compaction）绕过 `step()`，不会触发回退。回退后，响应的提供商在会话剩余时间内保持路由 — 这被记录为决策，而非意外。无中流提供商切换 — 每次尝试都是完整请求。集成很微妙 — 在 `agent/request-error` 中先调用 `next()` 正是让 llm-retry 先运行的原因 — 而它依赖的上游 waterfall API 是稳定的。链外提供商，或 preset 无匹配链的会话，行为与功能引入前完全一致。

## 测试

[tests/loader-composition.spec.ts](../../../../packages/llm/llm-fallback/tests/loader-composition.spec.ts) 通过真实 Loader（映射工作区模块）从 `cordis.yml` 挂载插件，固定无默认导出的函数插件表面，并通过导出的 Config schema 接受或拒绝链配置。[tests/fallback.spec.ts](../../../../packages/llm/llm-fallback/tests/fallback.spec.ts) 在脚本化适配器上驱动真实 agent 循环：主提供商耗尽其重试预算且线上序列为 `['a', 'a', 'b']`，`llm/fallback` 事件携带带 `ignorable` 标记的过渡载荷，回退提供商从全新重试预算开始，负向控制固定链耗尽的循环卫士（回归时会循环）、两步链仅前进一次、无匹配链的提供商与 intent 保持功能引入前的终态路径，以及挂载时拒绝空链或重复 `(provider, model)` 对。[tests/config.spec.ts](../../../../packages/llm/llm-fallback/tests/config.spec.ts) 覆盖配置验证：链 id 生成、空 steps/provider/model 拒绝、指明链的重复对拒绝，以及导出 schema 与解析后配置的一致性。
