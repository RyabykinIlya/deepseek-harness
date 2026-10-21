---
kind: upgrade-guide
description: "`free: prefer` tier 的免费端点现在只服务受委派的会话；独立会话需要新的 `freeForSoloSessions` 键才能继续使用它们。"
---

# `prefer` tier 的免费端点只服务受委派的会话

[English](guide.md) | 中文

## 变更

在 v0.2.1-rc.2 中，`@deepseek-ai/dsh-experimental-model-routing` 按是否受委派决定免费端点的准入。此前，顶层会话总是被准入，而 subagent 除非 `freeForSubagents` 为 true，否则不使用免费端点。现在，subagent 与 Thread——header origin 为 `subagent`、产出由编排者审阅的会话——在 `freeForSubagents` 为 true 时被准入；独立会话只有在新键 `freeForSoloSessions` 为 true 时才被准入。两个键默认均为 false。`free` 模式为 `only` 的 tier 不受这两个键约束：选择该 tier 本身就是对免费模型的明确请求，因此它继续服务选择它的每一个会话。共享每日预算（`freeMinRemaining`）与按模型的 `RATE_LIMIT` bench 保持不变。

tier 使用 `free: 'off'` 的部署不受影响。带有 `free: prefer` tier 的部署受影响：其独立会话不再落在免费端点上，转而排序该 tier 的付费端点；`freeForSubagents: true` 则让 subagent 与 Thread 继续可用免费模型。

## 迁移

1. 检查 model-routing profile patch 中的 tier 行。若某个 `free: prefer` tier 的免费端点应继续服务独立会话，在 `freeForSubagents` 旁加上路由级键：

   ```yaml
   freeForSoloSessions: true
   ```

2. 确认现在的分工：设 `freeForSubagents: true` 且不设 `freeForSoloSessions`，在独立会话中发一条消息，再向一个 subagent 或 Thread 发一条。独立会话的 `model-routing/decision` 事件以 `allowFree: false` 排序一个付费端点；受委派的会话则可以记录免费模型。
3. 在模型选择器中选择 `free: only` tier 的会话无需任何一个键即可继续获得免费端点；选中该 tier 并确认该轮完成即可验证。
