---
description: "把一个 Project Session 的后台 Thread 投影为持久的状态读模型，从 Thread 提供方的生命周期写入仅日志 Thread 事件，并归档 Thread。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-threads

[English](README.md) | 中文

## 概述

`dsh-experimental-threads` 是 Threads 特性的领域层：一个 Project Session 为其后台 Thread 记录的、仅存在于日志中的 `thread/*` 会话事件，把这些事件折叠成持久状态读模型的 `threads` Session 投影，从 Thread 提供方的 `subagent/start` 与 `subagent/end` 写入这些事件的监听器，实时存活性，以及 `threads.archive` Remote 方法。它不贡献任何面向模型的工具，也不启动任何 agent。它以实验性名称发布，不承诺稳定性。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当一个 Project Session 拥有若干后台 Thread、而它们的状态必须能在一处读取、且不必去询问任何单个 Thread 的转录时，把本包加入组合。与持久会话存储一起挂载：

```yaml
# smallest threads setup — durable storage plus the domain package
- name: '@deepseek-ai/dsh-session-persistence-jsonl'
- name: '@deepseek-ai/dsh-experimental-threads'
```

### 何时选择它

当一个会话需要一个完整、可重放的值来描述它派生的后台工作时，选择它——即一份 Thread 列表，连同它们的分支、worktree 和最后已知的结果。当你需要某个 Thread 的转录时（本层刻意从不携带转录）、当状态必须反映实时 agent 注册表而不是持久日志所记录的内容时、或当需求是每个 Thread 的文件系统隔离时，请不要选择它——这里不会创建任何 worktree。

<a id="status-rows"></a>
### 状态行

`threads` 为每个 Thread 发布一行。每个字段都是持久事实；存活性不属于该行。

| 字段 | 含义 |
|---|---|
| `threadId` | 持久的 Thread 身份（子 Session id） |
| `label` | 该 Thread 在派生时被赋予的任务 |
| `stopReason` | 上一轮已结束轮次的结果（`completed`、`aborted`、`error`、`max-tokens`、`refusal`）；第一轮结束前不存在 |
| `branch` | `dsh/<thread-short>`，游离 worktree 时不存在 |
| `worktree` | 该 Thread 工作目录的绝对路径 |
| `baseSha` | 创建 worktree 时所处的提交 |
| `commitsAhead` | 截至上次结算，worktree HEAD 相对 `baseSha` 领先的提交数 |
| `uncommitted` | 截至上次结算，worktree 中未提交的条目数 |
| `note` | 该 Thread 收尾消息的有界开头 |

会话级的 `interrupted` 原因到达该行时是 `aborted`。

<a id="liveness"></a>
### 存活性

当该 Thread 的 Agent 已注册且驱动器处于活动状态时，`ctx.threads.isRunning(threadId)` 为真。它每次调用都从运行时计算，且从不持久化，因此随进程一起死掉的 Thread 在重启后读作未运行。客户端从自己的会话列表推导同一个标志；它不应等待 `thread/status` 事件才知道某一轮已经开始。

<a id="reading-threads"></a>
### 读取 Thread 状态

通过服务读取：

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ThreadsService } from '@deepseek-ai/dsh-experimental-threads'

declare const ctx: Context
declare const session: Session

// host: whole durable state, and the client-visible rows
const state = ctx.threads.stateOf(session)
const rows = ctx.threads.viewOf(session)
```

直接通过注册表读取：

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import type { ThreadsService } from '@deepseek-ai/dsh-experimental-threads'

declare const ctx: Context
declare const session: Session

// the client wire value, at one consistent cut
const { values } = ctx.sessionProjections.snapshot(session, ['threads'])
```

浏览器包从 `./client` 子路径取走这些类型；该子路径只重新导出 `ThreadStatusRow`、`ThreadStopReason` 与 `ThreadId`。之所以要有它，是因为 `src/types.ts` 还携带 `@deepseek-ai/dsh-typert-protocol` 与 `@deepseek-ai/dsh-session-projection/types` 的仅 Host `declare module` 增补；客户端若直接导入那个模块，就会把二者拖进一个 `node_modules` 两者皆无的浏览器构建。`threads` Remote 命名空间另有一条路径：生成的 `./remote` 贡献。

<a id="publishing-threads"></a>
### Thread 事件

`subagent/start` 与 `subagent/end` 上的监听器自己写入这些事件；其他任何一方都不需要追加它们。它只响应 `info.provider` 等于 `providerName` 配置的运行，并且需要 `sessionProjections` 注册表，以便跳过 Project 已持有的 Thread。

| 边沿 | 追加到 Project Session 的事件 |
|---|---|
| 某 Thread 的第一次 `subagent/start` | `thread/created { threadId, label, worktree, branch, baseSha }`；`label` 是子代理冻结的创建标签，`worktree` 是它的 cwd，`branch` 与 `baseSha` 在该服务已加载时来自 `ctx.worktrees.get` |
| `subagent/end` | `thread/status { threadId, stopReason, note }`，在创建已完成时不交出控制权地追加 |
| `subagent/end` 之后不久 | 来自 `ctx.worktrees.status` 的 `thread/status { threadId, commitsAhead, uncommitted }`，尽力而为 |

被恢复的 Thread 会开启新的驻留 epoch 并再次发出 `subagent/start`；监听器在投影中找到该 Thread，因此不会再追加第二个 `thread/created`。所有事件都携带 `ignorable: true`，并且绝不并入模型可见的表面。监听器内部的失败会记录为警告，绝不传播到 subagent 运行时。

<a id="archive"></a>
### 归档 Thread

```ts
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { ThreadsService, ThreadId } from '@deepseek-ai/dsh-experimental-threads'

declare const ctx: Context
declare const projectAgent: Agent
declare const threadId: ThreadId

// client: ctx.remote.threads.archive(projectSessionId, threadId, { force })
await ctx.threads.archive(projectAgent, threadId, { force: false })
```

`archive` 先确认该 Thread 位于 Project 的 `threads` 投影中，未设 `force` 时拒绝脏 worktree，以 Project 的用户权威中断正在运行的 Thread 并最多等待 `archiveStopTimeoutMs`，通过 `ctx.worktrees.remove` 移除 worktree，最后追加 `thread/removed`。该 Thread 的分支与 Session 都保留。失败是 `RemoteError`：`threads/not-found { threadId }`、`threads/worktree-dirty { threadId }`（未改变任何东西）、以及 `threads/stop-timeout { threadId }`（worktree 原样保留）。没有 worktrees 服务时，`archive` 抛错。

`library`（`ctx.remote.threads.library({ projectId })`）是针对 Project Session 的读模型，不存储任何内容。它返回三个有界分区，每个都是 `{ items, total, truncated }`：用户在 Project 聊天中发送的图片与文件（`attachmentId`、名称、媒体类型、字节数）；Project 及其 Thread 用 `present` 声明的文件（`path`、`description`、呈现方的 `sessionId` 与 `threadId`、定位 present-open 路由的 `seq` 与 `index`、时间）；以及每个 Thread 的已变更文件——存活 worktree 取自 `ctx.worktrees.changes`，已归档且仍可获取时取自该 Thread 最近一次 `workspace/changes` 摘要，否则省略。Thread 的 Session 先从存活 Session 读取，再从 `ctx.sessionPersistence` 读取。未知 id 或 preset 不在 `projectPresets` 中时，以 `threads/project-not-found { projectId, reason }` 失败。present-open 按呈现方 Session 的工作区根校验路径，因此工作区之外的 worktree 文件可能被拒绝。

<a id="configuration"></a>
### 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `providerName` | `thread` | 其子代理即 Thread 的 subagent 提供方名 |
| `noteMaxBytes` | `600` | `note` 的最大 UTF-8 字节数（含省略号）；文本先折叠空白，再按码点截断 |
| `archiveStopTimeoutMs` | `30000` | `archive` 等待正在运行的 Thread 停止的时长 |
| `projectPresets` | `['project']` | `library` 接受为 Project 的 Session 所用的 agent preset |
| `libraryMaxAttachments` | `200` | `library` 列出的附件数 |
| `libraryMaxPresented` | `200` | `library` 列出的已呈现文件数 |
| `libraryMaxThreads` | `50` | `library` 读取日志与 worktree 的最新 Thread 数 |
| `libraryMaxFiles` | `100` | `library` 为每个 Thread 列出的变更文件数 |

-----


<a id="understand-the-implementation"></a>
## 理解实现

### 设计理念

这个单元是一个折叠，而不是一次查询。它从不读取实时 agent 注册表、其他会话的日志或文件系统，因此从已存日志进行的冷读能精确复现实时驱动所产生的值。这正是 `note` 可信的原因：它是提供方持久记录的文本，而不是渲染时猜出来的值。

对于 `thread/*` 领域之外的任何事件，`apply` 返回**同一个状态引用**。不变的引用正是抑制所有下游工作的机制，因此这条规则是承重的，而不是一项优化。

### 源码地图

<a id="source-map"></a>

| 路径 | 职责 |
|---|---|
| [`src/types.ts`](src/types.ts) | `ThreadId`、客户端行、remote 错误码，以及 `SessionEventMap` / `SessionProjectionMap` 的合并 |
| [`src/projection.ts`](src/projection.ts) | `ThreadState`、纯折叠、Zod schema 与 `threadsProjectionDefinition` |
| [`src/lifecycle.ts`](src/lifecycle.ts) | 追加 `thread/*` 事件的 `subagent/start` / `subagent/end` 监听器 |
| [`src/note.ts`](src/note.ts) | `threadNote`：有界的单行 note |
| [`src/index.ts`](src/index.ts) | `ThreadsService`：注册、`isRunning` 与 `archive` Remote 方法 |
| [`src/client.ts`](src/client.ts) | `./client` 子路径：客户端安全的 `ThreadStatusRow`、`ThreadStopReason` 与 `ThreadId` 类型，不含仅 Host 的模块增补 |

### 扩展而非修改

两张类型表都是声明合并的，因此本包在不编辑 `dsh-session` 或 `dsh-session-projection` 的前提下新增键：

```ts
import type { ThreadId, ThreadStopReason } from '@deepseek-ai/dsh-experimental-threads'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'thread/created': { threadId: ThreadId; label: string; worktree?: string; branch?: string; baseSha?: string }
    'thread/status': { threadId: ThreadId; stopReason?: ThreadStopReason; note?: string; commitsAhead?: number; uncommitted?: number }
    'thread/removed': { threadId: ThreadId }
  }
}
```

### 状态上报的合并

`thread/status` 是部分更新：事件中缺失的字段保持其值。唯一的例外是携带 `stopReason` 的上报：它结束一轮，因此会用自己的 note（或没有 note）替换先前的 `note`，note 绝不比它所属的那一轮活得更久。

### 折叠的总完备性

一条针对本日志从未创建过的 Thread 的 `thread/status`，以及一条针对未知 Thread 的 `thread/removed`，都会被忽略并返回同一引用。折叠从不在重放中途抛错，因为 `restore` 期间的一次抛错会让冷读完全没有值。

### 注册与能力缺失

该单元通过 `ctx.inject(['sessionProjections'], …)` 安装，因此注册随注入的 fiber 进行。没有该注册表的无头组合不受影响；卸载本插件会让该键从后续的驱动与快照中消失——客户端把这读作能力缺失，而不是数据损坏。

### 持久性

宿主状态是纯 JSON（持久缓存的前提），并与 session 一起做检查点。`stateVersion` 为 `2`；每当序列化的状态字段或折叠语义发生变化时都要递增它，从而让来自更旧单元的持久 `(sessionId, key, ver, seq, val)` 行被丢弃并重新折叠，而不是被向前套用到垃圾数据上。以*不同*的 `stateVersion` 再次注册同一个键会抛错，这是跨插件的单版本约束；以相同版本再次注册则计为一次共享。

## Model Experience

### Thread lifecycle events

#### What the model sees

什么也没有。`thread/created`、`thread/status` 与 `thread/removed` 都是仅日志的，并以 `ignorable: true` 追加：它们为客户端被记录与折叠，而请求组装绝不把它们并入模型可见的表面。Project 的模型是从 subagent 运行时作为普通消息发出的结算通知得知某个 Thread 已结算的。

#### Token effect

零直接影响：本包不注册任何提示词段落、工具 schema 或消息。

#### KV Cache effect

这里没有任何内容进入模型请求，因此 provider 的缓存复用不受影响。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **存活性不在日志里。** 崩溃之后日志仍显示最后结算的结果；`isRunning` 只对当前进程中已注册的 Agent 给出答案。
- **不能重命名 label。** `label` 由 `thread/created` 设置，不能通过 `thread/status` 更改；重命名需要 status 事件上的一个 `label` 字段，或一个专用事件。
- **没有转录，Thread 之间也没有顺序保证。** 各行保持持久的创建顺序；没有按最近使用的排序。
- **worktree 事实是结算时的快照。** `commitsAhead` 与 `uncommitted` 在 `subagent/end` 之后读取一次；Project 继续编辑 worktree 后它们会过时，而当时未注册的 Project 拿不到这次上报。
- **已归档的 Thread 可能再次出现。** 它的 session 被保留，因此恢复它会再次发出 `subagent/start` 并追加新的 `thread/created`。
- **写入方需要投影注册表。** 没有 `sessionProjections` 服务（或本插件已卸载）时，完全不会追加任何 `thread/*` 事件：投影是判断某个 Project 是否已持有该 Thread 的唯一依据。想要这些事件的组合必须加载该注册表。
- **Remote 方法需要挂载 `api-remotes`。** 本包导出 `./remote` 与 `./types`；只有当 `api-remotes` 组合导入它们时，客户端才会看到 `ctx.remote.threads`。

-----


<a id="dev-note"></a>
### 开发备注

从仓库根目录运行测试套件：

```bash
pnpm vitest run packages/experimental/threads
```

`tests/fold.spec.ts` 直接驱动纯折叠；`tests/registry.spec.ts` 通过真实的 `ctx.sessionProjections` 注册表驱动它，包括检查点/尾部恢复与 `stateVersion` 守卫；`tests/plugin.spec.ts` 覆盖注册与能力缺失；`tests/lifecycle.spec.ts` 用假的 worktree 服务驱动真实的 continuable-subagent 路径，覆盖 emitter、note 边界、恢复幂等、插件卸载、存活性与归档。

**运行时不变式：** 不发布伴生入口。折叠是全函数，每一行都只由已提交的事件前缀推导；而抄进事件里的每个事实——worktree 路径、分支、基线提交、领先提交数与未提交数——都在追加该事件时读一次，此后再不复核，因此本包没有可与来源日志发生偏移的第二份观测。