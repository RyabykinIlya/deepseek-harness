---
description: "Settings page of the Project memory caps on the dsh web client's Plugins page: how many entries a Project keeps and how long each one may be."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-project-memory

[English](README.md) | 中文

## 概述

`dsh-experimental-client-ui-project-memory` 是 Project 记忆上限的浏览器端一半：它在插件页注册“Project 记忆”设置页面，由人来决定每个 Project 保留多少条记忆、单条记忆最长可以有多长。在不提供 `project-memory` 命名空间的 Host 上它什么都不显示。它以实验名称发布，不作稳定性承诺。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

与 `@deepseek-ai/dsh-experimental-project-memory` 一起挂载；后者提供该页面编辑的 `project-memory` 设置命名空间。`cordis.patch.yml` 中的 Threads profile bundle 会同时挂载两者。

### 何时选择它

当部署中的 Project 共享记忆超出了默认上限、需要由人放宽时选择它。默认上限够用时不要选择：只有 Host 提供该命名空间时页面才会出现，而从未触达的上限不需要任何控件。

<a id="page"></a>
### 设置页

页面编辑该命名空间中的两个 volatile 上限 `maxEntries` 与 `maxEntryChars`，并把它们暂存为一次带修订号校验的保存。Host 会在下一次写入时读取两者，因此放宽上限在下一次 `memory_write` 就生效，而不必等到重启。Host 行中的其余字段 —— 协调者 preset id 与追溯深度 —— 属于启动期组合，这里不予提供：第一次编辑就会把它们固化进 profile 行。

小数草稿会在保存前被拒绝，因为 Host 强制执行的任何边界都用不上它。可接受区间仍由 Host 判定，因此越界的值表现为一次被拒绝的保存，而不是一个会悄悄夹取到边界的控件。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>Implementation internals — click to expand</summary>

可观察的行为已在 [使用本包](#use-this-package) 中完整说明。

### 源码地图

| 文件 | 作用 |
|---|---|
| `src/index.ts` | Host 入口；不贡献任何行为 |
| `src/client/index.ts` | 语言字典与设置页面挂载点 |
| `src/client/ProjectMemoryCard.tsx` | 设置卡片 |
| `src/client/project-memory-card-controller.ts` | 覆盖两个上限的暂存表单 |
| `src/client/locales.ts` | 英文与中文文案 |

### 条件注册

页面通过 `configForms.whileServed(['project-memory'], …)` 注册，因此没有 Project 记忆 Host 插件的组合永远不会渲染出空卡片。

</details>

-----

<a id="model-experience"></a>
## 模型体验

无 —— 这是一个浏览器端设置界面，不注册任何模型界面。

#### KV Cache 影响

无；本包既不组装也不发送 provider 请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制是当前包的约束，而不是待办清单。

- **不预览条目。** 页面编辑的是边界，不是条目本身。读取和编辑条目属于 Project 记忆面板的职责。
- **不支持按 Project 覆盖。** 两个上限都是部署级的，因此“一个大方宽松、其余严格”的部署无法在此表达。
- **实验原型，不作稳定性承诺** —— 命名空间、文案与卡片字段集合都可能在其孵化期间变化。

<a id="dev-note"></a>
### 开发备注

无。
