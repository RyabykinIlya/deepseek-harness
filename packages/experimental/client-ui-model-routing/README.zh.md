---
description: "Composer chip, settings page, and Thread roster entry for the tiers model route on the dsh web client."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-model-routing

[English](README.md) | 中文

## 概述

`dsh-experimental-client-ui-model-routing` 是 `tiers` 模型路由的浏览器半侧：它挂载 `modelRouting` Remote 命名空间，注册指名当前 tier 与作出回答的模型的 composer 芯片，并在插件页上注册「模型路由」设置页，由人在那里决定哪些模型属于哪个 tier，并查看各自的成本。在不服务 `model-routing` 命名空间的 Host 上，它什么都不显示。它以实验性名称发布，不承诺稳定性。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

把本包与 `@deepseek-ai/dsh-experimental-model-routing` 一起挂载：后者提供该页所编辑的 `model-routing` settings 命名空间，以及该页据以报价的 `modelRouting` Remote。`cordis.patch.yml` 中的组合包把两者一并挂载。

### 何时选择它

当某个部署运行 `tiers` 路由、而用户需要查看或修改某个 tier 可以选择哪些模型时，选择它。当部署是手工为每个 Session 选定一个模型时，请不要选择它：没有路由插件就没有 tier，此时芯片、该页与名单列都会正确地什么都不渲染。

<a id="chip"></a>
### composer 芯片

该芯片读取一个投影并显示 `<tier> · <model>`，其中模型去掉了 `author/` 前缀；tier 本身已经说明这是哪一家的 tier。提供方、量化以及产生该决策的边界放在悬停提示里，因为它们是用户在某一轮出错时才会去读的内容，而不是用户在编写下一轮时读的内容。

<a id="page"></a>
### 设置页

该页先暂存一份草稿，再把它作为一次带修订栅栏的 mutation 写入，正是这一点阻止两位编辑者把两份只应用了一半的 tier 列表交错在一起。价格按 tier 通过 `modelRouting.quote` 读取，且从不存储：价格是实时事实，存下来的价格在到达时就已经陈旧。一个选项卡条在各 tier 之间切换，一次只编辑一个，因为一份同时读成好几个独立表单的 tier 列表，就意味着好几个独立的错误。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

可观察行为已在 [使用本包](#use-this-package) 中完整覆盖。

### 源码地图

| 文件 | 职责 |
|---|---|
| `src/index.ts` | Host 入口；不贡献任何内容 |
| `src/client/index.ts` | Remote 挂载、芯片席位、设置页席位 |
| `src/client/ModelRoutingChip.tsx` | composer 芯片 |
| `src/client/ModelRoutingCard.tsx` | 设置卡片 |
| `src/client/model-routing-card-controller.ts` | 暂存的草稿、目录合并与报价 |
| `src/client/locales.ts` | 英文与中文文案 |

### 条件注册

两个界面都通过 `whileServed([…])` 或一个限定范围的 `slots.inject` 注册，因此没有路由 Host 插件的组合永远不会渲染出空壳。该 Remote 命名空间在这里挂载，而不是由随包发布的 Remote 汇总挂载，从而让这个实验性包留在产品的 `dsh-api-remotes` 组合包之外。

### 投影读取

该芯片通过会话标准的 `useProjection` 席位读取 `modelRouting` Session 投影。Thread 名单则防御性地从 Session 列表的 projection map 中读取同一个值，见 `dsh-experimental-client-ui-threads` 中的 `thread-model.ts`；这样做是因为那个 map 没有类型，而没有该插件的 Host 根本没有这一块。

</details>

-----

<a id="model-experience"></a>
## 模型体验

无，本包是一个浏览器侧的设置界面与 composer 芯片，不注册任何模型面。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 本页不提供新增或删除 tier 的操作。tier 是一项策略，不是会话级别的个人偏好，重塑这项策略本身仍是配置文件层面的决定；成员、过滤器、标签、上下文窗口、输出上限，以及路由级的 judge 与缓存设置，都是可编辑的。
- 该页对每份草稿中的每个 tier 都做一次实时读取以报价。因此一个含多个模型的 tier，在每次编辑时都要为每个模型付出一次 endpoint 读取；下一步是一个带防抖的共享价格缓存。

<a id="dev-note"></a>
### 开发备注

无。
