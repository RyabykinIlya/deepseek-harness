---
description: "dsh Web 客户端插件页上的 Threads 预设设置页：Project 的汇报与确认节奏，以及每个 Thread 使用的模型。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-threads

[English](README.md) | 中文

## 概述

在侧栏打开**插件**，在官方分组里选择 **线程**，即可设置 Project 如何汇报与确认自己的工作，以及每个 Thread 使用哪个模型。页面暂存输入、只在保存时写入，标明用户覆盖过的值，并允许把它重置回部署默认值。页面只在 Host 服务 `threads-preset` 命名空间期间存在。

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

官方分组里的 **线程**卡片打开这一页。它编辑一条 Host 行的七个字段：

- **进度汇报**——Project 汇报 Thread 进展的节奏：`milestones`、`each-thread` 或 `quiet`。
- **启动 Thread 前需确认**与**合并前需确认**——Project 是否等待你：`ask` 或 `auto`。
- **Thread 模型**——每个 Thread 使用的提供方、模型、推理强度与输出 token 上限。

点击**保存**之前不会写入任何内容；离开页面即丢弃草稿，清空字段并保存等于重置，填了不是 Host 行声明的值的文本则保存被阻止，并在字段下说明原因。

四个 **Thread 模型**字段作为一个整体读写。Host 行只设置了其中一部分时会拒绝加载，因此页面会阻止留下半填状态的保存，并在标题下说明原因，无论这组字段是只填了一半还是只清空了一半。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

宿主半侧是一个空的 `apply`，只为让本包占一条 Loader 行，客户端模块系统据此送出浏览器半侧。浏览器半侧通过 `ctx.configForms.get` 绑定 `threads-preset` 命名空间，用 `ui-primitives` 的共享 `SettingsFormModel` 在 `ThreadsCardController` 里维护暂存表单，并通过 `ctx.configForms.whileServed` 把 `ThreadsCard` 注册进插件页的 `plugins.item` slot。页面文案在本包的 `settings.threads` 字典里。

`ui-primitives` 只提供文本控件而没有下拉选择，因此每个固定取值字段都是一个文本控件，其解析器只接受 Host 行 union 声明的字面量；其余内容都属于无效草稿，共享表单本来就会拒绝保存。哪些取值存在由 Host 行说了算。

四个 Thread 模型字段的"全有或全无"规则跨越多个字段，因此不属于任何单个 `SettingsFieldSpec`。卡片自己求值：它维护一份很小的镜像，记录每个已暂存字段的意图——暂存清空会让控件继续显示组合层的值，而保存会为它写入一个 unset，只有卡片能把这种情形与 Host 已持有的值区分开。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [ui-plugin-manager](../ui-plugin-manager/README.zh.md)——插件页以及本页注册进去的 `plugins.item` slot。
- [ui-settings](../ui-settings/README.zh.md)——本页依赖的设置 scope 与"命名空间被服务期间"的监视。
- [ui-primitives](../ui-primitives/README.zh.md)——本页渲染的设置表单模型与字段。
- [threads-preset](../../experimental/threads-preset/README.zh.md)——Threads 预设，以及本页编辑其 volatile 字段的那条 Host 行。

-----

<a id="model-experience"></a>
## 模型体验

无，本包是浏览器侧的设置界面，不注册任何模型面。

#### KV 缓存影响

无；本包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **保存的改动在下次启动时生效**——Host 行的 volatile 引用会更新，但两个预设在插件激活时只注册一次，因此 Project 会话仍按注册时的那套节奏与模型运行。页面在 Thread 模型标题下写明了这一点，而不是暗示正在运行的 Project 已经改变。
- **这里不能编辑工具预算**——`tools` 以数字字典的形式承载 `thread_status` / `thread_diff` 的上限，而共享表单模型每个控件只暂存一个顶层字段名，因此绑定到 `tools.defaultLimit` 的控件会写入 Host 不服务的路径。它仍然只能通过编辑 `cordis.yml` 更改。
- **这里不能编辑 worktree 各行**——`worktree-manager` 与 `subagent-thread-worktree` 是各自拥有 volatile 契约的独立 Host 命名空间，由另一个伴生包负责。
- **这里不能编辑预设标识**——`id`、`workerId`、`name`、`description`、`order`、`provider`、`basePreset` 和 `workerMaxDepth` 属于启动组合而非用户偏好；承载它们的设置 section 会在首次编辑时把它们钉进 profile 行。
- **运行时不变量：**不发布伴生。本页没有自己拥有的关系：它显示的内容派生自设置镜像，它写入的内容由 Host 校验。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

本页暂存的字段名是在这里写死的，而不是导入的：客户端包不得依赖宿主包，因此这里读不到它们所镜像的 schema。二者由 `packages/experimental/threads-preset/tests/config-volatility.spec.ts` 保持同步——该用例在 Host 行上断言哪些字段是 volatile，也就是 `SettingsForms` 用来投影和写入的同一个 `meta.volatile` 判据；控制器的用例则使用以本页自身 `ThreadsSettings` 标注类型的 section 作为 fixture，并写出本页所编辑行的每一个字段。

</details>
