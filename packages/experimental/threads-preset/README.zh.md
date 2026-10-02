---
description: "组合 Project 与其 Thread：一个带 Thread 工具与契约的协调者预设，以及 Thread 自身所组成的 worker 预设。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-threads-preset

[English](README.md) | 中文

## 概述

**Project** 是一个普通的 Session，其 agent 由本包的 `project` 预设组合而成——没有新的会话类型，也没有持久化改动。注册表把预设 id 写入 `SessionHeader.agentPreset`，客户端正是据此识别一个 Project。`project` 是协调者：一份说明如何把目标拆分成 Thread 并整合结果的契约、改指向 worktree 隔离的 `thread` 后端的 `subagent`、有界的 `thread_status` 与 `thread_diff` 读取、记忆工具，以及接管工具。`project-thread` 是每个 Thread 子代理所组成的 worker 预设，没有 Thread 工具，也没有 `thread` 委派。Host 部分就是[组合包](../threads-profile/README.zh.md)。

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

把本行挂在[Threads 组合包](../threads-profile/README.zh.md)旁边，后者提供两个预设所需的 Host 配置行，并把 `childAgentPreset` 指向 worker id：

```yaml
- insert:
    - id: threads-preset
      name: '@deepseek-ai/dsh-experimental-threads-preset'
      config:
        id: project
        workerId: project-thread
        provider: thread
        basePreset: standard
```

客户端随后为该会话选择 `project`，而 Thread 子代理因为提供方的要求由 `project-thread` 组合而成：

```ts
import type { AgentSetup } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { PROJECT_PRESET_ID } from '@deepseek-ai/dsh-experimental-threads-preset'

declare const ctx: Context
declare const sessionId: SessionId
declare const mount: AgentSetup

await ctx.agents.create({ sessionId, meta: { agentPreset: PROJECT_PRESET_ID }, setup: mount })
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `id` | `project` | 写入 `SessionHeader.agentPreset` 的协调者预设 id |
| `name` | `Project` | 协调者的名单显示名 |
| `description` | 见源码 | 协调者的名单显示描述 |
| `order` | `20` | 协调者在名单中的排序位置 |
| `workerId` | `project-thread` | worker 预设 id；`thread` 提供方的 `childAgentPreset` 必须与之一致 |
| `workerName` | `Project Thread (internal)` | worker 的名单显示名 |
| `workerDescription` | 见源码 | worker 的名单显示描述 |
| `workerOrder` | `1000` | worker 的排序位置，排在所有供人选择的预设之后 |
| `provider` | `thread` | 协调者 `subagent` 行所指向的 subagent 提供方 |
| `basePreset` | 未设置 | 两个预设共同扩展的已注册预设，例如 `standard` |
| `workerMaxDepth` | 未设置 | Thread 继承的 `subagent` 行的委派深度上限；Host 默认值 1 会拒绝 Thread 启动的帮手 |
| `checkIn` | `milestones` | 协调者契约：`milestones`、`each-thread` 或 `quiet` |
| `spawn` | `ask` | 协调者契约：`ask` 或 `auto` |
| `mergePolicy` | `ask` | 协调者契约：`ask` 或 `auto` |
| `tools` | `{ defaultLimit: 20, maxLimit: 100 }` | `thread_status` / `thread_diff` 行的配置；由该插件校验每个键 |
| `threadProvider`、`threadModel`、`threadReasoningEffort`、`threadMaxTokens` | 未设置 | 每个 Thread 的模型选项；四项必须同时设置 |

`basePreset` 的存在是因为 Web 的 agent 平面在 host 组合中禁用了自己的工具行，改为按预设挂载。若部署的工具是全局行，则省略它，此时每个 Threads 预设只贡献自己的配置行。

### 两个预设挂载的内容

| 配置行 id | 包 | 职责 |
|---|---|---|
| `thread-contract` | 本包的 `./threads-contract` 子路径 | 协调者为 `threads:contract`，worker 为 `threads:worker-contract` |
| `tool-subagent` | `@deepseek-ai/dsh-tool-subagent` | 普通委派工具，改指向 `thread` 提供方并采用 continuable 后台模式 |
| `tool-threads` | `@deepseek-ai/dsh-experimental-threads-tool` | `thread_status` 与 `thread_diff`，Thread 状态的有界读取 |
| `tool-subagent-control` | `@deepseek-ai/dsh-tool-subagent-control` | `send_message` 与 `interrupt_agent`，运行中 Thread 的唯一把手 |
| `project-memory-tools` | `@deepseek-ai/dsh-experimental-project-memory/tools` | Project 记忆上的 `memory_read` 与 `memory_write`，两个预设都挂载 |

协调者保留 base 配置行中未被它替换的那些：`tool-subagent`（改指向）、`tool-subagent-fork`（fork 子代理会运行在 Project 检出目录里、没有 worktree）与 `tool-subagent-list-agents`（`thread_status` 是它的有界替代）。只有当 base 配置行本身不含 `tool-subagent-control` 时，协调者才自己挂载它。worker 原样保留每一条 base 配置行，因此它的 `subagent` 仍绑定出厂的 `spawn` 提供方。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 声明行：读取 base 配置行、注册两个预设并持有其 disposer |
| [`src/project-preset.ts`](src/project-preset.ts) | 两个预设的配置行组装、预设 id 与发布后的行模块说明符 |
| [`src/threads-contract.ts`](src/threads-contract.ts) | 契约文本、其句子变体，以及 runtime-context 行 |
| [`tests/project-preset.spec.ts`](tests/project-preset.spec.ts) | 通过真实名单挂载两个预设，并读取某个 agent 的 scope |

决定设计的几个性质：

- **每一行只贡献工具或 prompt，绝不贡献服务。** 把服务发布到 root realm 的预设会挂载失败，而 Project 消费的服务——`tools`、`subagents`、`systemPrompt`、`sessionProjections`——都位于 Host 平面。
- **契约是 runtime context，而不是 system-prompt section**，理由与 `SUBAGENT_DELEGATION_CONTEXT` 相同：部署的 system prompt 在 Project 与它启动的 Thread 之间保持一致，而这些是阅读者所处情境的事实。`PromptContext` 还会被 scope 遮蔽，因此选择其他预设的会话永远看不到契约。
- **契约文本只是该行 `Config` 的纯函数**，与具体会话无关，因此组装出的前缀在多个回合与重启之间保持稳定。
- **`basePreset` 通过 `agentPresets.readDocument` 读取**，并用 `entryListSchema` 解析，因此 `!!js` 条件（例如 `disabled: !!js process.platform === 'win32'`）会原样进入两个预设，而不会被折叠成读取进程的真值。

声明的配置行写的是它们**发布后**的包说明符，这也正是 profile 解析的内容。在从 `src` 运行时，`row()` 改为按路径把同一份代码交给 Loader，因为 Loader 通过 Node 的 ESM 解析器导入配置行，裸说明符永远不会解析到包的 `src`，而工作树中的实验性包没有 `lib/`。`PROJECT_PRESET_ROW_NAMES` 是发布后的身份，测试套件会连同已挂载的行一起断言它。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [实验性包](../README.zh.md) — 孵化状态与发布策略。
- [Threads 组合包](../threads-profile/README.zh.md) — 两个预设所消费的 Host 配置行。
- [Threads 服务](../threads/README.zh.md) — 仅日志事件与持久的状态读模型。
- [Threads 工具](../tool-threads/README.zh.md) — 有界的 `thread_status` 与 `thread_diff` 界面。
- [Agent 预设](../../preset/agent-preset/README.zh.md) — 编写预设所依据的声明契约。
- [System prompt 组装](../../../docs/subsystems/system-prompt.zh.md) — section 与 runtime-context 的排序规则。

-----

<a id="model-experience"></a>
## 模型体验

### 两份契约

#### 模型看到的内容

Project 看到一个名为 `threads:contract` 的 runtime context。它说明：Project 负责协调工作；Thread 是在自己的 git worktree 和分支上工作的后台 agent，其改动只有经过合并才会进入检出目录；模型应重述目标、提出拆分方案，并用 `subagent` 工具启动 Thread，该调用是异步的，返回的是 id 而不是工作结果；Thread 完成时会自行回报，因此模型不得循环轮询；`thread_status` 有界且可能省略部分 Thread；`thread_diff` 用于审阅已完成的 Thread；整合方式是 `git merge --no-ff <branch>`，需解决冲突并运行测试，当多个 Thread 改了同一批文件时应先提出合并顺序；已合并 Thread 的归档由用户在界面上完成。Thread 看到的是一个名为 `threads:worker-contract` 的 runtime context。它说明：模型是 Project 的 Thread，负责一项被委派的任务；它的检出目录与分支属于自己；每个完成的步骤都要提交；除非被要求，不推送、不改动其他分支；完成后用 `send_message` 给父代理发送自包含的总结：改了什么、如何验证、剩余风险，以及来自 `git branch --show-current` 的分支名。该行的 `Config` 提供三种句子变体：汇报节奏（`milestones`、`each-thread`、`quiet`）、启动 Thread 前是否等待批准（`ask`、`auto`），以及合并前是否询问（`ask`、`auto`）；每个变体都是替换进契约的固定句子，其余文本完全相同。委派描述、schema 以及 `thread_status` 的 schema 属于这两个预设挂载的行，而不属于本包。

#### Token 影响

协调者契约约 2 kB prompt 文本，每个 Project 会话添加一次，且只对 Project 会话添加。worker 契约不到 0.8 kB，每个 Thread 添加一次。选择其他预设的会话不承担任何开销。

#### KV Cache 影响

每份契约在给定部署配置下都是静态字符串，因此 Project 或 Thread 组装出的前缀在多个回合与重启之间保持稳定。变体属于部署选择：改动其中一个只会让此后组合的会话重新建立一次前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **不是 profile** — 两个预设声明的行并非由自己提供。若 Host 平面上没有 [Threads 组合包](../threads-profile/README.zh.md)，`subagent` 根本不会出现在面向模型的工具列表中，因为没有匹配提供方的委派工具不会被注册。
- **worker 预设会出现在名单中** — 预设注册表没有隐藏标记，因此 `project-thread` 会与所有可人工选择的预设一同列出。它被排在最后（1000）并命名为“Project Thread (internal)”以降低干扰，但用户仍可选择它，从而得到一个带 worker 契约、没有 Thread 工具的会话。
- **没有新的会话类型** — Project 只是一种预设选择；呈现不同 Project 界面的客户端依据的是 `SessionHeader.agentPreset`。持久化格式中没有任何东西区分 Project。
- **名单可由用户编辑** — profile 可以用另一个 id 插入同一组合，此时该会话在本命名下就不是 Project。请匹配 id，而不是包名。若 profile 改了 worker id，必须同时重写提供方的 `childAgentPreset`，否则 Thread 会退回为继承父级预设。
- **隔离由后端保证，而非预设** — 两个预设只向模型陈述 worktree 规则并挂载工具；worktree 本身由 `@deepseek-ai/dsh-subagent-thread-worktree` 创建与回滚。
- **已完成的 Thread 不会被合并** — worktree 与分支在 Thread 结束后仍然存在，把改动搬回 Project 检出目录仍是模型手动执行的 git 步骤。
- **`basePreset` 只在加载时读取一次** — 之后编辑 base 预设不会传播到已挂载的 Threads 预设；需重新加载该行才能生效。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作说明 — 点击展开</summary>

`threads:contract` 的 order 是字面量 `130`，而不是 `getContextOrder()` 中的名字。`dsh-system-prompt` 拥有那张中央表及其生成目录，孵化中的包在其中新增键会让它的发布与一次核心分配耦合；该字面量位于同一区间（sandbox 110、approval 115、subagent delegation 120），测试套件会断言它始终高于最后一个已分配的位置。

从仓库根目录运行测试：

```bash
pnpm vitest run packages/experimental/threads-preset
```

</details>

**运行时不变式：** 不发布伴生入口。本包既不提供服务也不发出事件：它在加载时读取一次基础行，注册两个 preset，并且只持有它们的 disposer，因此挂载行所建立的每一条可变关系，都由 subagent 注册表、工具注册表或会话投影注册表持有。
