---
description: "Project 的 Host 侧共享记忆，以及让 Project 协调者与其 Thread 把决定集中保存的 memory_read 与 memory_write 工具。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-project-memory

[English](README.md) | 中文

## 概述

为一个 Project 保管简短的共享事实——决策、已达成一致的约束、日期、联系人、惯例——使 Project 协调者与每个 Thread 都能读取和编辑它们，尽管每个 Thread 的沙箱只允许在自己的 worktree 内写入。模型通过 `memory_read` 与 `memory_write` 触达这些条目，用户则通过客户端面板触达。条目在重启后依然存在，一个 Project 最多持有 `maxEntries` 条；而不属于共享知识的内容——文件内容、日志、临时进度——应放进 worktree 或 Thread 的对话记录。

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

Host 服务只需挂载一次；工具插件挂载到每个需要访问记忆的 preset（Project 协调者 preset 与 Thread 工作者 preset）：

```yaml
- id: project-memory
  name: '@deepseek-ai/dsh-experimental-project-memory'
  config:
    maxEntries: 200
- id: project-memory-tools
  name: '@deepseek-ai/dsh-experimental-project-memory/tools'
  config:
    maxReadBytes: 8192
```

服务依赖 `storageDomain` 与 `sessions`。两个上限是 live 字段：Threads profile 在插件页上的 Project 记忆页面可以编辑它们，下一次写入会直接读到新值，无需重启。其余字段属于启动期组合 —— 哪些 preset 是协调者、向上追溯多少层 —— 在组合 Profile 时决定。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxEntries` | `200` | 每个 Project 保留的条目数；超出后添加失败，直到删除一条。可在线编辑（1 至 10000） |
| `maxEntryChars` | `2000` | 条目文本的最大长度，按 Unicode 码点计。可在线编辑（1 至 100000） |
| `projectPresets` | `['project']` | 其 Session 为 Project 协调者的 agent preset id |
| `maxLineageDepth` | `4` | 查找 Project 时向上追溯的父级跳数 |

工具配置项均为可选：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxReadBytes` | `8192` | 对完整 `memory_read` 结果（含截断行）的 UTF-8 字节上限（256 至 1000000） |
| `defaultLimit` | `20` | 模型省略 `limit` 时返回的条目数 |
| `maxLimit` | `100` | 模型可请求的最大 `limit` |

生成的[配置目录](../../../docs/config-catalog.zh.md)是所有可接受字段的完整来源。

### 何时选择

当 Project 的多个 Thread 需要超出单个 Thread 生命周期的决定、约定的约束、日期、联系人或惯例时选用。文件内容、日志或进度记录不应放入其中；它们属于 worktree 或 Thread 的转录。

### Project 解析

当调用方 Session 的 `agentPreset` 在 `projectPresets` 中时，Project id 就是该 Session 自己的 id。否则服务沿 `parentSession` 逐级查找，最多 `maxLineageDepth` 跳，每个祖先先读存活的 Session，再读已持久化的 header（未加载 `sessionPersistence` 服务时只读存活的 Session），因此 Thread 以及 Thread 启动的辅助 agent 都能访问所属 Project 的记忆。谱系中没有 Project 的 Session 会收到 `This session is not part of a Project, so it has no shared memory. Keep notes in your own reply instead.`

### 条目

条目包含 id、Project id、去除首尾空白的文本、最后写入者的角色（`coordinator`、`thread` 或 `user`）与 Session，以及创建和更新时间。调用方是 Project Session 时 `memory_write` 记录为 `coordinator`，否则为 `thread`。写入是串行的，因此并发写入下条目上限依然成立。

### Remote 方法

`list`、`add`、`update` 与 `delete` 让客户端面板以 `user` 身份显示和编辑记忆（是 `delete` 而非 `remove`：客户端 Remote 命名空间代理把 `remove` 保留给自己的描述符卸载方法）。被拒绝的请求以 Remote 错误码 `project-memory/refused` 失败，稳定的原因在 `details.reason` 中。

### 成功与失败是什么样子

每次拒绝都是面向模型的错误，指明原因和下一步操作：文本为空、文本超限（附带其长度）、Project 已满、未知 id（调用 `memory_read`）、不属于任何 Project 的会话，以及工具插件在没有 Host 服务时挂载所导致的服务缺失。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

### 设计理念

- **Host 存储，而非文件。** Thread 沙箱无法写入 worktree 之外，而 Project worktree 中的文件会随 git 流转。
- **执行时解析。** 工具插件只注入 `tools`；`projectMemory` 在工具运行时通过 `ctx.get` 读取，因此 schema 保持稳定，服务缺失时给出可操作的信息。
- **约束完整结果。** `memory_read` 会整条丢弃条目，直到渲染文本（含截断行）符合 `maxReadBytes`。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `ProjectMemoryService`：增删改查、限额、Project 解析、Remote 方法、`Config` |
| [`src/storage.ts`](src/storage.ts) | `project_memory` 存储域与条目校验 |
| [`src/errors.ts`](src/errors.ts) | `ProjectMemoryError` |
| [`src/types.ts`](src/types.ts) | 条目、id 与请求类型 |
| [`src/tools.ts`](src/tools.ts) | `memory_read` 与 `memory_write`（导出路径 `./tools`） |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Storage domain 包](../../storage/storage-domain/README.zh.md) — 本服务所依托的存储域约定。
- `@deepseek-ai/dsh-experimental-threads` — Project Session 的 Thread 事件与投影。
- [生成的工具目录](../../../docs/tool-catalog.zh.md) — 面向模型的 schema。

-----

<a id="model-experience"></a>
## 模型体验

### 工具 schema

#### 模型看到什么

两个工具，其确切 schema 见[生成的工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-experimental-project-memory)。`memory_read` 接受可选的 `query` 与 `limit`；其描述告诉模型在开始任务时读取记忆。`memory_write` 接受 `action`（`add`、`update`、`remove`）、`id` 与 `text`；其描述说明哪些内容属于记忆（决定、约束、日期、联系人、惯例），哪些不属于（文件内容、日志、临时进度）。

#### Token 影响

在挂载工具插件的任何 Agent 中，每次请求都有固定的 schema 开销。

#### KV Cache 影响

前缀稳定。schema 与描述在运行时不变；配置的限额在加载时固化。

### 读取结果

#### 模型看到什么

每条记录一行，最新的在前：`<id> [<author>, <ISO time>] <text>`。无匹配时为 `(no memory entries)`。当 `limit` 或字节上限截掉条目时，最后一行为 `(showing <n> of <total> matching entries; narrow with query or raise limit to see more)`。

#### Token 影响

随返回的条目增长，受 `limit` 与整段文本的 `maxReadBytes` 限制。

#### KV Cache 影响

仅追加；每个结果位于可复用的请求前缀之后。结果作为普通工具结果记入日志，因此恢复的 Session 会重放它们。

### 写入结果

#### 模型看到什么

`added <id>`、`updated <id>` 或 `removed <id>`；错误信息附带纠正操作。

#### Token 影响

每次调用一行简短文本。

#### KV Cache 影响

仅追加；结果位于可复用的请求前缀之后。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制是本包当前的约束，而非任务待办列表。

- **谱系需要已存储的祖先** — Project 解析读取存活的 Session 和已持久化的 header；父 Session 既未加载也未存储（或未加载 `sessionPersistence` 服务且父 Session 未加载）的 Thread 会收到要求用户重新打开 Project 的错误。
- **无游标** — `memory_read` 从最新条目开始截取一页；更早的条目需通过 `query` 缩小范围来读取。
- **无条目级访问控制** — Project 的任何 Thread 都可编辑或删除任何条目；仅记录最后写入者的角色。
- **未生成 Typert 导出** — Remote 方法尚未接入 `./typert` 导出或客户端面板。
- **无稳定性承诺的实验原型** — 孵化期间名称、限额与结果文本都可能变化。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景 — 点击展开</summary>

从仓库根目录运行测试：

```bash
pnpm vitest run packages/experimental/project-memory
```

`tests/harness.ts` 在内存存储后端之上挂载真实服务，并通过 `ctx.tools.execute` 驱动工具。测试固定了限额（恰好、超出、多字节）、模拟重启后的持久化、含深度上限的 Project 解析、字节上限（极小、恰好、多字节）、Remote 拒绝，以及插件重载时的工具释放。

</details>

**运行时不变式：** 不发布伴生入口。条目存放在 `project_memory` storage domain 中，由该 domain 持有权威表；本服务既不缓存也不保留第二份副本，因此条目上限、文本长度上限与归属检查，都会在可能出错的那次调用里直接读取该 domain 自己的行。
