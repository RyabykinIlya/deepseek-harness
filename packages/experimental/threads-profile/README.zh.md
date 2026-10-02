---
description: "用一个实验性组合包启用基于 worktree 隔离的后台 Thread、它的状态工具与 Web 名单，且不改变任何普通会话。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-threads-profile

[English](README.md) | 中文

## 概述

把 Threads 特性作为一个整体安装：worktree 服务、`threads` Session 投影、基于 worktree 隔离的 continuable-subagent 后端、Web 的 Thread 名单，以及两个 agent 预设。本层只插入配置行，因此普通预设与未安装本组合包时表现一致；与 Agent Teams 组合包不同，它不随 dsh 安装出厂分发。

`project` 是协调者：`thread` 提供方上的 `subagent`、`thread_status` 与 `thread_diff`、记忆工具、接管工具，以及协调者契约。`project-thread` 是每个 Thread 子代理所组成的预设，没有 Thread 工具，也没有 `thread` 委派；本层把 `childAgentPreset` 指向它。

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

### 安装到 profile

把本包添加到已组合 agent 平面的 profile，然后运行一个要求 agent 协调后台工作的任务：

```sh
dsh plugin --profile web add @deepseek-ai/dsh-experimental-threads-profile
dsh --profile web "Plan the auth-test fix and the docs drift as a Project, then tell me how each Thread ended."
```

profile 必须已经包含本层所扩展的 agent 平面：`@deepseek-ai/dsh-web-app` 组合了 agent 预设注册表与 `standard` 预设，而本组合包的 `threads-preset` 行把 `standard` 声明为它的 `basePreset`。若 profile 的工具是全局行而非预设行，则不设置 `basePreset`。执行 `dsh plugin --profile <name> remove @deepseek-ai/dsh-experimental-threads-profile` 移除本包时，bundle 也会从 profile 的有序层列表中移除。

插件页通过组合包的 `package.json.icon` 声明读取其[图标](icon.svg)，组合包禁用时也会显示。

### 获得的功能

本层插入六行，除此之外不做任何改动：

| 配置行 | 包 | 职责 |
|---|---|---|
| `worktree-manager` | `@deepseek-ai/dsh-worktree-manager` | 在 `dshHomePath('worktrees')` 下为每个 Thread 维护一个 git worktree，并由 `pruneOnStart` 做对账 |
| `threads` | `@deepseek-ai/dsh-experimental-threads` | 仅日志的 `thread/*` 事件与持久的 `threads` Session 投影 |
| `subagent-thread-worktree` | `@deepseek-ai/dsh-subagent-thread-worktree` | `thread` continuable 提供方：每个子代理一个分支与 worktree，且都由 `project-thread` 组合 |
| `ui-threads` | `@deepseek-ai/dsh-experimental-client-ui-threads` | Web 的 Thread 名单与可寻址的 Thread 会话资源 |
| `project-memory` | `@deepseek-ai/dsh-experimental-project-memory` | `memory_read` 与 `memory_write` 工具背后的 Project 记忆服务，预设会挂载这两个工具 |
| `threads-preset` | `@deepseek-ai/dsh-experimental-threads-preset` | `project` 协调者预设与 `project-thread` worker 预设 |

普通会话的工具列表与其 `subagent` 提供方保持不变：base 的 `subagent` 行仍使用自己的提供方，且任何 Thread 工具或契约都不会到达未选择这两个预设的会话。Project 会话获得协调者组合；Thread 子代理获得 worker 组合。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

本包的运行时内容就是 [`cordis.patch.yml`](cordis.patch.yml)。它在 base 层与 Web 层之后应用，只插入上述六行，不打任何补丁。有两个行 id 通过配置耦合：`subagent-thread-worktree` 以 `thread` 注册提供方并要求 `childAgentPreset: project-thread`，而 `threads-preset` 在 `project` 协调者 id 旁声明该 worker id，因此两者必须一起修改。

UI 插件的 Host 入口是惰性的；只有 Web Client loader 会挂载其浏览器入口，因此 headless profile 不需要 Web 服务器。`ui-threads` 不携带配置：客户端行的配置永远不会到达浏览器，名单匹配的是本包自身的默认值 `project`。

| 文件 | 职责 |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | 在 base 层与 Web 层之上的有序插入 |
| [`src/index.ts`](src/index.ts) | 空模块入口；patch 本身就是运行时内容 |
| — | 不发布运行时不变式伴随模块；本包只携带一份静态 profile patch。worktree 服务、投影、提供方、两个预设与 UI 包各自持有其可变关系。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [实验性包](../README.zh.md) — 孵化状态与发布策略。
- [Threads 预设](../threads-preset/README.zh.md) — 本层挂载的两个组合与契约文本。
- [Threads 服务](../threads/README.zh.md) — 仅日志事件与持久的状态读模型。
- [Threads 工具](../tool-threads/README.zh.md) — 模型可见的有界 `thread_status` 与 `thread_diff` 界面。
- [Worktree 管理器](../../subagent/worktree-manager/README.zh.md) — `ctx.worktrees` 背后的持久 worktree 生命周期。
- [Thread 提供方](../../subagent/subagent-thread-worktree/README.zh.md) — 隔离每个子代理的 continuable 后端。
- [Base 组合包](../../bundle/base/README.zh.md) — 本 patch 所扩展的 profile 层。

-----

<a id="model-experience"></a>
## 模型体验

### 组合方式，而非新工具

#### 模型看到的内容

本组合包不添加自己的 prompt 文本。模型看到的内容由它所处会话的预设决定：Project 读取协调者契约并被提供 `subagent`、`thread_status`、`thread_diff`、`send_message` 与 `interrupt_agent`；Thread 读取 worker 契约并被提供普通工具，其中包括绑定出厂 `spawn` 提供方、用于在自己的 worktree 内启动帮手的 `subagent`；普通会话被提供的与安装本组合包之前完全一致。委派描述、`thread_status` 的 schema 与两份契约文本都属于[预设包](../threads-preset/README.zh.md)与工具包。

#### Token 影响

普通会话不增加任何内容。Project 承担协调者契约与 `thread_status` / `thread_diff` 的 schema；Thread 承担 worker 契约。一次状态调用至多花费所配置 `maxLimit` 行的有界页面。

#### KV Cache 影响

安装本组合包不会改变普通会话的前缀，这正是本组合包不会使既有会话缓存失效的原因。只要契约配置、提供方名称与工具 schema 不变，Project 或 Thread 的前缀就保持稳定。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **仅限主动启用** — 本包不在启动器的可选组合包列表中，出厂的 CLI、Web、SDK、ACP 与 Python profile 都不会启用它；需按名字安装。
- **依赖 Web agent 平面** — 出厂状态值把 `standard` 声明为 `basePreset`，并使用 `thread` 提供方 id。若 profile 以全局方式组合工具，则 `basePreset` 留空；若 profile 改了 worker id，必须同时重写提供方的 `childAgentPreset`。
- **worker 预设会出现在名单中** — 预设注册表没有隐藏标记，因此人工可以选择 `project-thread`。它被排在最后并按角色命名，但选择它会得到一个带 worker 契约、没有 Thread 工具的会话。
- **需要帮手的 Thread 需要深度上限** — 本层设置 `workerMaxDepth: 2`，因为 Host 默认值 1 会拒绝 Thread 自己启动的 subagent。
- **状态是最后记录的值** — `running` 由运行时实时计算，而状态行汇报的结果是最后一条 `thread/status` 事件记录的内容；未汇报就死亡的 Thread 会按最后已知状态呈现。
- **已完成的 Thread 不会被合并** — worktree 与分支在 Thread 结束后仍然存在；审阅与合并它们是协调者的 git 工作，本组合包不会自动化。
- **`ui-threads` 需要 Web 客户端** — headless profile 会挂载该行（其 Host 入口是惰性的），但名单只出现在 Web Client loader 挂载浏览器入口的地方。
- **需要 base profile** — 本 patch 命名的行 id 与服务由 base 层与 Web 层提供；它不是独立的 profile。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作说明 — 点击展开</summary>

本组合包不发布运行时不变式伴随模块：它是一份静态 profile patch，其中命名的每一行都自己持有其关系。profile 测试套件用脚本化模型，通过真实 Loader 启动 base 的 agent 平面行与本组合包插入的行，并断言普通会话的工具集合与 `subagent` 提供方在有无本组合包时完全一致。

从仓库根目录运行测试：

```bash
pnpm vitest run packages/experimental/threads-profile
```

</details>
