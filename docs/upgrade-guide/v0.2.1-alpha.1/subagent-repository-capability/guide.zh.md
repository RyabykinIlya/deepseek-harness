---
kind: upgrade-guide
description: "The exported SubagentCapabilities interface gains a required repository flag, so a provider that omits it no longer type-checks."
---

# SubagentCapabilities 现在要求 repository 能力标志

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-subagent` 导出的 `SubagentCapabilities` 新增必填标志 `repository: boolean`，与 `agentOptions`、`outputSchema`、`depthLimit`、`toolFilter`、`persona` 并列。在本仓库之外实现 `SubagentProvider` 的提供方，若其 capabilities 声明缺少该字段，将无法通过类型检查。该标志表示提供方是否为每个子 agent 选择仓库：只有声明 `true` 的提供方，委派工具才暴露可选的 `repository` 参数；声明 `false` 时，携带该参数的调用会被拒绝。`SubagentStartRequest` 与 `ContinuableCreateRequest` 同时新增可选的 `repository?: string`，从不传递仓库的调用方无需任何改动。本仓库自带的每个提供方都已声明该标志。

## 迁移

1. 在你维护的每个提供方中，向其 `capabilities` 对象添加 `repository: true` 或 `repository: false`。只有当提供方会把委派来的 `repository` 解析为子 agent 的工作树时才声明 `true`；所有子 agent 都在同一处工作时声明 `false`。
2. 确认提供方能够编译：`pnpm run typecheck`
3. 确认挂载该提供方的组合仍能启动子 agent，并确认对声明 `false` 的提供方传递仓库名的委派会失败，错误为 `repository is not available for provider "<provider>", which does not select a repository per subagent; omit the parameter`。
