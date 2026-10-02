---
description: "面向后台 Thread 的 git worktree 管理器：创建、持久化意图记录、显式删除与启动对账。"
kind: "package-reference"
---

# @deepseek-ai/dsh-worktree-manager

[English](README.md) | 中文

## 概述

为每个后台 Thread 分配独立的 git worktree，使 Thread 的提交、索引区与工作文件都不会影响项目主检出（checkout）。创建失败时会响亮地抛出带类型的错误，而不会把 Thread 悄悄塞回父级目录；持久化意图记录与 `git worktree add` 之间发生的崩溃，会在下次启动时修复。没有任何自动删除：移除只能由显式调用触发，它保留分支，并在你确认之前拒绝移除脏 worktree。你可以读取某个 Thread 的提交、改动文件与合并预测，而不移动任何 ref。

## 目录

- [使用本包](#use-this-package)
- [实现原理](#understand-the-implementation)
- [错误](#errors)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发者说明](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

以宿主服务方式加载；它注册 `ctx.worktrees`，并在加载时一次性校验配置。

```yaml
- name: '@deepseek-ai/dsh-worktree-manager'
  config:
    worktreeRoot: /Users/you/.dsh/worktrees
    maxWorktreesPerRepo: 32
    adoptionGraceMs: 600000
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `worktreeRoot` | `~/.dsh/worktrees` | 保存意图日志与全部受管 worktree 的绝对目录，不得位于任何已注册 checkout 之内。 |
| `repoRootResolution` | `explicit` | `spec.repoRoot` 为空时的来源：`explicit`（调用方必须显式给出）或 `parent-cwd`（宿主进程启动时所在的 checkout）。 |
| `pruneOnStart` | `true` | 服务加载时执行对账清理。 |
| `maxWorktreesPerRepo` | `32` | 每个仓库处于活动（非终态）的 worktree 上限，整数 ≥ 1。超出时抛出 `WORKTREE_LIMIT_REACHED`，其消息列出现有 Thread id；删除其中一个即可释放名额。运行中 Thread 的并发由 `dsh-subagent` 的 `maxActiveSubagents` 单独限制。 |
| `adoptionGraceMs` | `600000` | 记录至少存在这么久之后，缺失会话才会使其成为孤儿；覆盖 worktree 创建与会话发布之间的时间窗。 |
| `lockTimeoutMs` | `10000` | 等待同一 `worktreeRoot` 上各进程共享的注册表锁的最长时间；超时则以 `WORKTREE_REGISTRY_LOCKED` 失败。 |
| `lockRetryIntervalMs` | `50` | 两次加锁尝试之间的间隔，整数 ≥ 1。 |
| `lockStaleMs` | `30000` | 持锁方停止刷新（进程崩溃）超过该时长后，锁可被接管，整数 ≥ 5000。 |

<a id="use-this-package/session-existence"></a>
### 告诉服务哪些 Thread 仍有会话

本服务不了解会话——会话持久化归 continuation 管理器所有——因此它绝不猜测。挂载后立刻赋值探针：

```ts
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { WorktreeService } from '@deepseek-ai/dsh-worktree-manager'

declare const ctx: Context

ctx.worktrees.sessionExists = async (threadId: string) => (await ctx.sessionPersistence.stat(brandString<SessionId>(threadId))) !== undefined
```

`dsh-subagent-thread-worktree` 会自行安装该探针，并在自身被销毁时移除。

没有探针时，`reconcile()` 仍会修复"worktree 已不在磁盘上"的记录，但绝不会仅凭会话维度把某条记录判为孤儿。

<a id="understand-the-implementation"></a>
## 实现原理

### 意图先于副作用落盘

`create()` 在启动 `git worktree add` **之前**先向 `worktrees.jsonl` 追加一行 `reserved`，只在 add 成功后才写 `ready`，并在 `finally` 中用 `git worktree remove --force` 回滚失败或被中止的 add。这个顺序就是整个设计的核心：意图写入与 add 之间发生崩溃时，会留下一条可检测的记录，而不是一个无人能归属的隐形目录。

该 sidecar 是只追加的 JSONL，每次操作追加一行，内存中折叠（同一 `threadId` 以最后一行为准）。因此状态是*推导*出来的，绝不存在可能与日志不一致的第二台状态机。末行被截断（崩溃中断追加的常见痕迹）会被跳过；中间出现格式错误的行则响亮拒绝，而不是静默丢弃记录。

### 状态机

```text
reserved ──git worktree add ok──▶ ready ──explicit remove──▶ removing ──▶ removed
   │                               │                              ▲
   │ add failed / signal.abort    │ reconcile: no session          │ reconcile sweep
   ▼                               ▼                              │
rolled-back ──────────────────── orphaned ────────────────────────┘
```

状态迁移是幂等的（重复断言当前状态不写入任何内容），并由显式的边表守卫；不在表中的迁移会抛出 `WORKTREE_STATE_ILLEGAL`。终态唯一的出边是 `removed → reserved` / `rolled-back → reserved`，即有文档的**重启边**：worktree 已被完整删除的 Thread 可以再次创建。

### 分支是什么，以及删除会删掉什么

分支（默认 `dsh/thread-<slug>`；worktree 目录使用同一个 `threadSlug(threadId)` 命名，完整 `threadId` 保存在记录中）是从 Thread 派生的便捷句柄，绝不是身份标识。删除以 `(threadId, path)` 为键，因此 **`remove()` 删除 worktree 但保留分支**——删掉分支可能让 Thread 的提交变成不可达。也正因如此，重启的 Thread 对自己此前拥有的分支豁免 `WORKTREE_BRANCH_EXISTS` 检查，并用 `git worktree add <path> <branch>` 重建，使其早期提交得以保留。其他任何已存在的分支——别的 Thread 的，或你自己的——仍然会被拒绝。

### 对账

`reconcile()` 依据两条互相独立的规则清理记录，且绝不触碰它并不拥有的 worktree：

1. 路径已不在磁盘上的 `reserved`/`ready` 记录（add 中途崩溃）；
2. 依据 `sessionExists` 判定已无持久化会话、且记录早于 `adoptionGraceMs` 的 `reserved`/`ready` 记录。本进程中仍在创建的 worktree 绝不会被清理。

清理在启动时和每次 `create()` 之前运行，因此被遗弃的 worktree 不会占用上限名额。每条孤儿记录都会被标记为 `orphaned`，用 `git worktree remove --force` 删除，并收敛到 `removed`——若磁盘上从未有过任何内容则收敛到 `rolled-back`。删除失败会留下 `removing` 墓碑，供后续清理收尾。

### 记录的基线与变更

`create()` 把 `baseRef` 解析为提交并作为 `baseSha` 存入日志（更早写入的记录没有该字段，回退到 `baseRef`）。`get(threadId)` 返回任意状态下的最新记录。`status()` 增加 `commitsAhead`（`git rev-list --count baseSha..HEAD`）。`changes(record, { maxCommits, maxFiles })` 返回最新在前的提交、`baseSha..HEAD` 已提交的文件（含二进制识别）、总数以及未提交数量。`filePatch(record, path, maxBytes)` 返回单个仓库相对路径的已提交 diff，按字节在字符边界截断；绝对路径与 `..` 路径会被拒绝。所有列表与补丁都有上限。 `mergeCheck(record, { target }, maxConflicts)` 用 `git merge-tree --write-tree` 预测把 worktree 的 HEAD 合并进 `target`（在主检出中解析）是否冲突，列出至多 `maxConflicts` 个冲突路径并给出总数；不移动任何引用或工作树，git 低于 2.38 时返回 `{ supported: false }`。

### 多进程共用同一根目录

每次状态转换以及 `create()` 中“上限检查加预留”都在注册表目录的 `proper-lockfile` 咨询锁下执行：持锁后先折叠其他进程追加的日志行，再校验转换，随后用单次 `O_APPEND` 写入追加一行，因此跨进程的检查与预留是原子的。另一个进程仍在添加的、早于 `adoptionGraceMs` 的 `reserved` 记录不会被清理。

### Git 调用

每次调用都通过 `execFile` 传**参数数组**且不经 shell，因此 Thread id 或 ref 永远不可能变成 shell 语法。非零退出码是供服务分类的数据；只有连 `git` 都无法启动时才 reject（`GIT_SPAWN_FAILED`）。

<a id="errors"></a>
## 错误

所有失败都是携带稳定 `code` 的 `WorktreeError`（一种 `HarnessError`）。请按 `code` 路由，绝不解析 `message`。这些 code 延续既有的 `SubagentError` 词表，而不是另起一套。

| Code | 触发条件 |
|---|---|
| `NOT_A_GIT_REPO` | `repoRoot` 不在 git work tree 内（或在 `explicit` 解析下为相对路径/空值）。 |
| `WORKTREE_CREATE_FAILED` | `git worktree add` 因其他 code 未覆盖的原因失败，或 spec 携带了不可用的分支/Thread id。 |
| `WORKTREE_BRANCH_EXISTS` | 该 Thread 的分支已存在，且不是它自己上一次运行留下的。 |
| `WORKTREE_PATH_IN_USE` | 目标 worktree 路径已被占用。 |
| `GIT_SPAWN_FAILED` | 无法启动 `git` 可执行文件。 |
| `REMOVE_DIRTY_WITHOUT_FORCE` | 未加 `force` 就删除了脏 worktree。 |
| `WORKTREE_LIMIT_REACHED` | 该仓库已有 `maxWorktreesPerRepo` 个活动 worktree；消息列出它们的 Thread id。 |
| `WORKTREE_ORPHANED` | 持久化记录声称存在某个已消失的 worktree；记录被判为孤儿，而不是被静默重建。 |
| `WORKTREE_NOT_FOUND` | `status()`（或 `remove()`）指向的 Thread 在磁盘上没有 worktree。绝不会报告为 `clean: true`。 |
| `WORKTREE_SUBDIRECTORY_MISSING` | Thread provider 发现父会话的子目录在新 worktree 中不存在。 |
| `WORKTREE_STATE_ILLEGAL` | 内部状态机守卫拒绝了某次迁移。 |
| `WORKTREE_OPERATION_FAILED` | `list`/`remove`/`status` 的 git 调用因其他原因失败。 |
| `WORKTREE_REGISTRY_LOCKED` | 无法在 `lockTimeoutMs` 内获得共享注册表锁，或锁在状态转换途中丢失。 |

`WORKTREE_NOT_FOUND`、`WORKTREE_SUBDIRECTORY_MISSING`、`WORKTREE_STATE_ILLEGAL`、`WORKTREE_OPERATION_FAILED` 是对设计表的补充：SBFT 第 A8 行要求一个带类型的"未找到"且不得是 `clean: true`，而守卫与通用失败码能避免这些情况被误报成 `WORKTREE_CREATE_FAILED`。

取消 `create()` 会以平台的 `AbortError`（来自 `AbortSignal`）reject，且发生在保留的意图已被回滚之后——取消不是 worktree 故障，因此不获得 worktree 错误码。

<a id="model-experience"></a>
## 模型体验

### Thread 工作树事实

#### 模型看到什么

看不到直接内容：本包不注册任何面向模型的工具、提示词段落或消息。Project 模型通过有界的 `thread_status` 与 `thread_diff` 工具触达自己那些 Thread 的工作树，这两个工具读取本服务的 `get`、`status` 与 `changes`，并自行渲染结果。

#### Token 影响

本包不产生任何影响。模型读到的行文本与补丁文本由 `@deepseek-ai/dsh-experimental-threads-tool` 生成；这里没有任何内容会进入请求。

#### KV 缓存影响

这里没有任何内容进入模型请求，因此 provider 的缓存复用不受影响。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

- **未建模 detached worktree。** `WorktreeSpec.branch` 是可选的，但省略它会得到默认派生分支，而不是 detached 检出；设计把 `branchMode` 的决策交给了 Thread provider 包。
- **读取未被设防。** worktree 隔离的是*写入*与 git 状态；Thread 仍可通过共享 object store 读取整个仓库。本包不尝试实现读取设防。
- **`maxWorktreesPerRepo` 按仓库计**，与 `list(repoRoot)` 保持一致，而非全进程全局计数。
- **隔离只覆盖写入。** 读取、网络与共享的 git object store 均未隔离；`/tmp` 是共享的；Thread 仍可执行 `git push`。
- **多进程共用同一 `worktreeRoot` 受锁保护。** 锁依赖本地文件系统的目录原子创建；网络文件系统上不保证。
- **启动清理看不到会话存在性**，因为探针无法经 YAML 传入。探针安装之后，每次 `create()` 之前的清理即可依据会话判断。
- **注册本包需要生成的 tsconfig 别名。** `tsconfig.base.json` 带有生成的 `@deepseek-ai/dsh-*` 包别名；新增本包后请运行 `pnpm run gen-tsconfig-paths`。

<a id="dev-note"></a>
### 开发备注

- 源码布局：`src/index.ts`（服务）、`src/registry.ts`（持久化意图日志与状态机）、`src/git.ts`（git 子进程表面）、`src/error.ts`（类型化失败）、`src/types.ts`（公共数据结构）、`src/states.ts`（状态集合）。
- 测试为每个用例构建真实的临时 git 仓库（`mkdtemp` + `git init` + 一次提交），并把每条断言都从 git 本身读回——`git worktree list --porcelain`、`git branch --list`、`git status --porcelain`——而不是相信服务自己的账本。它们覆盖 SBFT 第 A1–A9 行，以及配置守卫与状态机各条边。
- `SBFT A6`（add 进行中途中止）通过安装一个会 `sleep` 的 `post-checkout` 钩子变成确定性用例，从而保证 abort 确实落在 `git worktree add` 执行期间，而不是与它赛跑。

**运行时不变式：** 不发布伴生入口。sidecar 日志是本服务持有的唯一状态：每次转换都在咨询锁下对照刚折叠出的日志校验，因此非法边会从本该写入它的那次 append 本身抛出；而分支、提交与工作树事实在调用时直接从 `git` 读出，而不是取自某个维护中的投影。
