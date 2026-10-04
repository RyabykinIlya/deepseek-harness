---
description: "有界的 thread_status、thread_diff 与 library_list 工具，让 Project 模型看到后台 Thread 在做什么、检查各自提交了什么，并列出其 Library，适用于挂载 Threads 领域的组合。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-threads-tool

[English](README.md) | 中文

## 概述

本包添加四个模型工具，其中三个始终存在。`thread_status` 列出调用方 Project 的后台 Thread，包含状态、分支、计数与简短的收尾说明；`thread_diff` 展示某个 Thread 在其分支上提交了什么；`library_list` 列出调用方 Project 的 Library：聊天中发送的附件、Project 或其 Thread 展示（present）过的文件，以及各 Thread 变更过的文件；`thread_tier` 把某个 Thread 切换到另一个模型层级，仅在装载 `@deepseek-ai/dsh-experimental-model-routing` 时才注册——没有它就没有层级可指。三者都只读取调用方 Project 会话自己的数据（`thread_status` 与 `thread_diff` 通过 `threads` 投影，`library_list` 通过 Library 读模型），在适用处活跃性取自运行时，并对完整渲染结果按字节设限，同时说明省略了什么。这里没有无界模式；正是这个上限让本包独立存在，而不是复用 `list_agents`。本包以实验性名称公开发布，但不提供稳定性保证。

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

在 Project 智能体会启动后台 Thread 的组合中，把它与 `@deepseek-ai/dsh-experimental-threads` 和 `@deepseek-ai/dsh-worktree-manager` 一起挂载：

```yaml
- id: threads-tool
  name: '@deepseek-ai/dsh-experimental-threads-tool'
  config:
    maxResultBytes: 8192
```

所有设置均为可选：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `defaultLimit` | `20` | 模型省略 `limit` 时 `thread_status` 返回的行数（上限 100） |
| `maxLimit` | `100` | 模型可请求的最大 `limit`（上限 100） |
| `maxResultBytes` | `8192` | 任一工具完整渲染结果（含页脚）的 UTF-8 字节上限（1024 至 32768） |
| `maxCommits` | `30` | `thread_diff` 列出的提交数（上限 100） |
| `maxFiles` | `100` | `thread_diff` 列出的变更文件数（上限 500） |
| `maxPatchBytes` | `16384` | `thread_diff` 读取的单个文件补丁字节数（256 至 65536） |
| `maxOverviewThreads` | `20` | `thread_diff` 概览读取的 Thread 数，每个都产生 git 调用（上限 100） |
| `maxPairChecks` | `50` | 概览对存在重叠的 Thread 对执行合并检查的次数（上限 200） |

每个值在代码中都会被夹到其上限，因此任何配置都无法重建无界列表。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-threads-tool)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 何时选择

当模型必须概览各后台 Thread 的未完成工作，并在合并前审阅某个 Thread 的结果时，选择本包。当子项是可继续（continuable）subagent 时请不要选择：`list_agents` 与 `send_message` 已经描述了它们。

### 模型能做什么

`thread_status` 接收两个可选参数：

| 参数 | 类型 | 含义 |
|---|---|---|
| `status` | `running`、`idle`、`completed`、`aborted`、`error`、`max-tokens`、`refusal` | 精确状态过滤；省略表示全部状态 |
| `limit` | 1–100 的整数 | 返回的行数；默认取 `defaultLimit` |

它按创建顺序为每个 Thread 渲染一行；分支、计数与 note 仅在已知时出现：

```
<threadId> [<state>] <label> | branch <branch> | <n> commits ahead, <m> uncommitted | note: <closing message start>
```

当 limit 或字节上限丢弃了某些行时，最后一行会指出：

```
(3 of 5 threads omitted; filter by state or raise limit)
```

不拥有任何 Thread 的 Project 渲染为 `(no threads)`。

`thread_diff` 接收可选的 `thread_id` 与可选的仓库相对路径 `path`（`path` 需要 `thread_id`）。不带 `path` 时渲染合并命令、基线与头部提交、按新到旧排列的提交，以及带行数的已提交文件。带 `path` 时渲染该文件已提交的补丁；补丁被截断时以标记结尾，标记中给出读取其余部分的 `git -C` 命令。工作树路径在摘要中出现一次（未提交计数指向它），并出现在截断标记中。

不带 `thread_id` 时，`thread_diff` 渲染一份概览，供合并多个 Thread 之前阅读：每个 Thread 的提交数、文件数与未提交数；被两个及以上 Thread 修改的已提交路径；合并到 Project 检出 `HEAD` 以及重叠 Thread 之间的合并预测（`git merge-tree --write-tree`，需 git 2.38+，更旧的 git 仍会给出重叠）；带原因的跳过 Thread；以及合并顺序：无重叠且无预测冲突的 Thread 在前，其余按重叠数从少到多。仅含已提交的工作；概览按 `maxResultBytes` 截断并带省略行。

### 状态与活跃性

`running` 来自运行时（`ctx.threads.isRunning`），绝不来自日志。否则状态为最后一个已结束回合的结果：`completed`、`aborted`、`error`、`max-tokens` 或 `refusal`。`idle` 表示未在运行且尚未记录任何结果。

### 成功与失败是什么样子

能力缺失会明确失败，而不是被读成一个空的 Project。若 Threads 领域或其投影注册表缺失，调用返回指出所需包名的错误结果；`thread_diff` 在 `@deepseek-ai/dsh-worktree-manager` 缺失时同样指明。调用方投影之外的 `thread_id` 以 `unknown thread id; call thread_status` 失败。已归档或缺失的工作树会失败，并给出可用 `git log` 检查的分支。越界的 `limit` 或不安全的 `path` 在读取任何内容之前被拒绝。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

本节解释适配器背后的设计决策；可观察行为见[使用本包](#use-this-package)。

### 设计理念

该适配器建立在三项承诺之上：

- **一个调用方，一个分页。** 行来自 `ctx.threads.viewOf(exec.agent.session)`。第二个 Project 的 Thread 无法触达，因为会话是从调用 Agent 推导出来的，而不是取自参数，并且 `thread_diff` 只接受该投影中存在的 id。
- **在知道完整值的地方设限。** 行、提交与文件数量有上限，自由文本按条缩短，字节上限施加在完整渲染文本上：整行、整个提交或整个文件会被丢弃，直到包含页脚的文本放得下；补丁在 UTF-8 码点边界处截断，并为其标题与标记留出空间。
- **缺失是错误。** 工具把能力缺失变成失败，绝不返回空列表。

### 注册形态

`inject` 只有 `['tools']`。`ctx.threads` 与 `ctx.worktrees` 在执行时通过 `ctx.get` 读取，因此 schema 保持稳定，服务缺失时给出可操作的信息，而不是未知工具错误。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置、两个工具的注册、服务访问、路径校验 |
| [`src/status.ts`](src/status.ts) | `thread_status` 的条目、状态解析、渲染与字节适配 |
| [`src/diff.ts`](src/diff.ts) | `thread_diff` 的摘要与补丁渲染及字节适配 |
| [`src/overview.ts`](src/overview.ts) | `thread_diff` 概览的采集、合并预测、合并顺序、渲染与字节裁剪 |
| [`src/text.ts`](src/text.ts) | UTF-8 长度、截断与单行化辅助函数 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从模型工具一路下到它所读取的服务。

- `@deepseek-ai/dsh-experimental-threads`——`threads` 投影、`ThreadStatusRow` 与 `isRunning`。
- `@deepseek-ai/dsh-worktree-manager`——`thread_diff` 背后的 `get`、`changes` 与 `filePatch` 读取。
- `@deepseek-ai/dsh-subagent-thread-worktree`——为每个 Thread 创建工作树的提供方。
- [生成的工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-experimental-threads-tool)——模型侧 schema。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-threads-tool)——每个受支持的配置字段。

-----

<a id="model-experience"></a>
## 模型体验

### 工具 schema

#### 模型看到什么

两个工具 `thread_status` 与 `thread_diff`；其 schema 与描述见[生成的工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-experimental-threads-tool)。描述告诉模型：Thread 完成时会自行回报，输出有界并说明省略了什么，Thread 的工作在模型合并之前一直留在它的分支上。

#### Token 影响

在每个能够触达这些工具的 Agent 请求上都有固定 schema 成本。它们是全局注册，因此挂载本包的组合会在每个会话中支付该成本，包括不拥有任何 Thread 的子会话。

#### KV Cache 影响

前缀稳定。schema 与描述在运行时不变；只有配置的上限在加载时被固化。

### 状态结果

#### 模型看到什么

每个返回的 Thread 一行：id、状态、label，以及已知时的分支、领先提交数与未提交数、收尾说明的开头。不拥有任何 Thread 的 Project 得到 `(no threads)`。被缩短的分页会追加 `(<n> of <total> threads omitted; filter by state or raise limit)`。

#### Token 影响

随返回的分页增长，受 `limit` 以及对整段文本施加的 `maxResultBytes`（默认 8192 字节）约束。每行的 label 上限 160 字节，note 上限 320 字节。

#### KV Cache 影响

仅追加；每个结果都跟在可复用的请求前缀之后，不会使已有 KV 缓存条目失效。

### Diff 结果

#### 模型看到什么

摘要展示合并命令、基线与头部提交、至多 `maxCommits` 条提交标题，以及至多 `maxFiles` 个带行数的已提交文件，截断时每个列表后附省略数量。`path` 形式展示单个文件已提交的补丁，按 `maxPatchBytes` 与 `maxResultBytes` 截断并带显式标记。

#### Token 影响

随返回的提交、文件或补丁增长，受对整段文本施加的 `maxResultBytes` 约束。

#### KV Cache 影响

仅追加；每个结果都跟在可复用的请求前缀之后，不会使已有 KV 缓存条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明这些工具无法告诉 Project 模型什么。它们是当前包约束。

- **没有游标**——`limit` 与字节上限从头截取一页，截断之后的行只能通过 `status` 收窄来触达。
- **仅按创建顺序**——最新的 Thread 排在最后，可能落在被截断的分页之外。
- **仅限已提交的工作**——`thread_diff` 补丁展示 `baseSha..HEAD`；未提交文件只计数，Thread 必须先提交，Project 才能合并。
- **计数是最近一次上报的值**——`thread_status` 中的 `commitsAhead` 与 `uncommitted` 是最后一次状态事件记录的值，而不是调用时从 git 读取的；`thread_diff` 则实时读取 git。
- **实验原型，无稳定性承诺**——孵化期间工具名、状态词表与结果文本可自由变更。
- **没有出厂组合挂载它**——部署需显式选择加入。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

从仓库根目录运行该套件：

```bash
pnpm vitest run packages/experimental/tool-threads
```

`tests/threads-tools.spec.ts` 会把真实的 `thread/*` 事件追加到真实 Agent 所拥有的会话中，提供一个假的工作树服务，并通过 `ctx.tools.execute` 驱动两个工具。它固化了渲染文本、先过滤后截断的顺序、极小、恰好与多字节的字节上限、补丁截断、能力缺失失败以及拆除。

`status` 枚举是渲染用词表，而不是行上的字段。如果给 `@deepseek-ai/dsh-experimental-threads` 增加新的 `ThreadStopReason`，也要把它加到 `src/status.ts` 的 `THREAD_STATES`。

</details>

**运行时不变式：** 不发布伴生入口。每次调用都从本包没有保留的东西开始渲染：`threads` 行、live 注册表的回答与 git 读取都属于各自的服务，且两次调用之间不留任何值，因此可供检查的关系只有同一次调用刚算出来的那些。
