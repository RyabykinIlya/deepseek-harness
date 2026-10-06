---
description: "Worktree-isolated continuable subagent backend: every Thread child runs in its own self-contained clone."
kind: "package-reference"
---

# @deepseek-ai/dsh-subagent-thread-worktree

[English](README.md) | 中文

## 概述

当需要让某个 agent 的每个 continuable 子代理都隔离在自己的自包含克隆中时，使用本包。该后端在创建子代理的过程中创建这个克隆，把它的绝对路径作为子代理持久化的 `cwd` 返回，并在创建被中止时负责回滚该克隆。由于会话的 `cwd` 同时也是其沙箱写入根目录，这个克隆正是约束子代理写入范围的东西。本包自身不是 worktree 管理器：git 操作、持久化的意图记录与启动时对账都由它依赖的 `@deepseek-ai/dsh-worktree-manager` 负责。

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

先挂载 worktree 管理器，再挂载本后端，最后挂载一个指向它的委派工具。provider 以你选择的名称注册，而委派工具的 `provider` 字段选择的正是这个名字：

```yaml
- name: '@deepseek-ai/dsh-worktree-manager'
  config:
    worktreeRoot: ~/.dsh/worktrees
    pruneOnStart: true
- name: '@deepseek-ai/dsh-subagent'
- name: '@deepseek-ai/dsh-subagent-thread-worktree'
  config:
    providerName: thread
    branchPerThread: true
    branchTemplate: dsh/thread-{{id}}
    baseRef: head
    childAgentPreset: project-thread
- name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: thread
    backgroundMode: continuable
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `providerName` | `thread` | 在 `ctx.subagents` 上的注册名；委派工具按它选择 |
| `branchPerThread` | `true` | 为每个子代理建立独立分支；`false` 则创建 detached worktree |
| `branchTemplate` | `dsh/thread-{{id}}` | 分支名；`{{id}}` 为子代理的 `threadSlug`，与 worktree 目录名使用同一个 slug |
| `baseRef` | `head` | `head` 在父会话已提交的 `HEAD` 处创建 worktree；`head-with-uncommitted` 还会用 `git stash create` 捕获已跟踪的未提交改动（工作区干净时回退到 `HEAD`）。不包含未跟踪文件。 |
| `childAgentPreset` | 未设置 | 作为 `ContinuableCreateSpec.agentPreset` 返回的 agent preset id；未设置表示子代理继承父级的 preset |

孤儿宽限期（`adoptionGraceMs`）与每仓库上限（`maxWorktreesPerRepo`）是拥有记录时间戳的 [worktree 管理器](../worktree-manager/README.zh.md)的字段。

### Thread 得到什么

每个 continuable 子代理都会获得一个 worktree，从父会话的仓库按配置的 `baseRef` 检出。子代理的 `cwd` 是 worktree 路径加上父级 cwd 相对仓库顶层的路径，因此位于 `packages/app` 的父级会得到 `<worktree>/packages/app` 中的子代理。若该目录不在基点提交中，worktree 会被移除，创建以 `WORKTREE_SUBDIRECTORY_MISSING` 失败。该 `cwd`沙箱据此推导可写根目录，因此子代理无法写到自己的树之外。子代理不从父级继承历史，这正是它的上下文窗口保持独立的原因。

### 创建失败时

所有失败都是响亮且带类型的；本包绝不退化为一个未隔离的子代理。没有 `cwd` 的父会话、不是 git 工作树的仓库、已存在的分支、被占用的 worktree 路径，都会在创建期间或之前各自拒绝。如果调用方的信号在 worktree 已存在之后中止，provider 会在向上抛出之前把它移除——continuation manager 无法代劳，因为它对从未被发布的子代理不持有任何句柄。

<a id="understand-the-implementation"></a>
## 理解实现

provider 对一个 continuable 子代理的全部参与就是 `prepareContinuable`：它通过 `ctx.worktrees` 创建 worktree、返回 `{ cwd }`，并为自己的失败提供补偿。身份预留、组合、提示投递、冷恢复、所有权与释放全都属于 continuation manager，因此本包自身不承载任何生命周期。

one-shot 的 `start` 路径继承自共享的 in-process 驱动，**并不**提供隔离：one-shot 子代理必然与父级共享工作目录。隔离是 continuable Thread 独有的属性，而本后端的 one-shot 委派并不是获得 worktree 的受支持方式。

回滚分为三部分。provider 自己调用内部的失败或中止，由内联移除 worktree 处理。整个进程崩溃的情形由 worktree 管理器处理：它在改动 git 之前持久化一条 `reserved` 意图记录，并在下次启动时对账清理孤立的记录。`prepareContinuable` 返回之后 continuation manager 内部的失败（准入拒绝、重复 id、物化错误）会留下没有会话的 worktree；provider 把 `worktrees.sessionExists` 安装为 `ctx.sessionPersistence.stat`，管理器的清理会在记录早于 `adoptionGraceMs` 后移除这样的 worktree。清理在启动时和每次创建之前运行。没有会话持久化服务时，探针报告“存在”并只记录一次日志，因此不会凭猜测清理。

<a id="further-exploration"></a>
## 进一步探索

当包级契约不够用时，请阅读以下页面：

- [Worktree 管理器](../worktree-manager/README.zh.md) — 本 provider 所依赖的 git 操作、持久化意图记录与对账机制。
- [Threads 领域投影](../../experimental/threads/README.zh.md) — 仅写日志的 `thread/*` 事件，以及本后端子代理所上报的双轴状态读取模型。
- [Subagent 子系统](../../../docs/subsystems/subagent.zh.md) — provider、continuable 子代理、activation 与授权规则。
- [dsh-tool-subagent](../tool-subagent/README.zh.md) — 选择本后端的模型侧委派工具。

<a id="model-experience"></a>
## 模型体验

### 启动一个 Thread

#### 模型看到什么

模型看不到本包带来的任何新工具。它使用配置为指向本 provider 的普通委派工具；工具的 `run_in_background` 与 `backgroundMode: continuable` 设置决定调用是否立即返回子代理 id。选择哪个后端并不会改变工具的描述与 schema。

#### Token 影响

本包本身不产生 schema 开销。continuable Thread 的各个回合只在该子代理自己的会话内消耗 token。

#### KV 缓存影响

仅追加；provider 不改变任何模型可见的前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **one-shot 委派不受隔离。** 通过 one-shot 路径启动的子代理共享父级检出目录。请使用 `backgroundMode: continuable`。
- **不做回合并。** 分支为子代理创建后就地保留；没有任何东西把它合并回父级检出目录，也没有任何东西在子代理停止时删除它。
- **移除需要 worktree 管理器。** 在正常运行期间本包从不移除 worktree；移除是对管理器的显式调用。
- **未提交改动需要 `baseRef: head-with-uncommitted`。** 使用默认值时，子代理看不到父级检出目录中的改动；即便启用它，未跟踪文件也不会被复制。
- **隔离只覆盖写入。** 读取与网络未被隔离；object store 是子代理自己的，位于其目录内部，只有 `/tmp` 是共享的。`git push` 指向其克隆的 `origin`，即父仓库的路径，位于子代理沙箱根之外，因此沙箱会拒绝它，worker 契约在任何会话中都禁止 push。
- **一个 DSH 进程一个 `worktreeRoot`。** 多个进程共用同一根目录尚未做协调。

<a id="dev-note"></a>
### 开发备注

- 源码布局：`src/index.ts` 包含 provider、其 config schema，以及 `prepareContinuable` 的补偿路径。
- 测试既用一个会记录调用的 `WorktreeService` 替身驱动 provider，也针对真实服务与临时 git 仓库驱动（子目录 cwd、`head-with-uncommitted`、孤儿清理）。替身直接断言两种补偿情形：已中止的信号根本不会到达 `create`；创建之后才中止的信号会在拒绝向上传播之前触发 `remove(record, { force: true })`。

**运行时不变式：** 不发布伴生入口。Thread 的身份、组装、提示词投递、冷恢复、所有权与释放都属于 continuation manager，worktree 记录自身的状态机与孤儿清理属于 worktree manager；本包只贡献一次调用——创建工作树、返回 `cwd`，并在这次调用失败时移除自己创建的东西——因此它没有可供比较的独立观测。
