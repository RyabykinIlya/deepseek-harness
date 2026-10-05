---
kind: upgrade-guide
description: "The Project memory entry length cap rises from 500 to 2000 characters, and both memory caps become editable on the Plugins page under Project memory."
---

# Project 记忆上限放宽，并可在设置中编辑

[English](guide.md) | 中文

## 变更

在 v0.2.1-alpha.1 中，`@deepseek-ai/dsh-experimental-project-memory` 把 `maxEntryChars` 的默认值从 500 提升到 2000 个 Unicode 码点，因此携带 501 至 2000 个字符的 `memory_write` 现在会成功，而不再报 `The memory text is N characters; the limit is 500.`。两个记忆上限 —— `maxEntryChars` 与 `maxEntries` —— 同时成为 volatile Config 字段，`@deepseek-ai/dsh-experimental-client-ui-project-memory` 会在插件页注册“Project 记忆”页面来编辑它们。Host 在下一次写入时读取每个上限，因此保存后的改动无需重启即可生效。该行的其余字段（`projectPresets`、`maxLineageDepth`）仍属启动期组合，在那里不可编辑。使用 Threads profile bundle 的运维者会受影响；已在自己 profile 行中固定 `maxEntryChars` 的部署不受影响。

## 迁移

1. 若部署需要维持原来的边界，请在 profile 行中显式设置，而不是依赖默认值：

   ```yaml
   - id: project-memory
     name: '@deepseek-ai/dsh-experimental-project-memory'
     config:
       maxEntryChars: 500
   ```

2. 要得到该页面，请在 Host 行旁边挂载 `@deepseek-ai/dsh-experimental-client-ui-project-memory`。Threads profile bundle 已同时提供这两行；自定义组合需自行添加客户端行。
3. 打开 插件 → Project 记忆，调高**每条记忆的字符数**并保存。确认下一次同样长度的 `memory_write` 成功；拒绝消息会写出 Host 当时正在强制执行的限制值。
