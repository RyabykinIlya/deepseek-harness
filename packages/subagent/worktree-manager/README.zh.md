---
description: "面向后台 Thread 的 git worktree 管理器：创建、持久化意图记录、显式删除与启动对账。"
kind: "package-reference"
---

# @deepseek-ai/dsh-worktree-manager

[English](README.md) | 中文

## 概述

为每个后台 Thread 分配独立的自包含本地克隆，使 Thread 的提交、索引区与工作文件都不会影响项目主检出（checkout）。创建失败时会响亮地抛出带类型的错误，而不会把 Thread 悄悄塞回父级目录；持久化意图记录与创建克隆之间发生的崩溃，会在下次启动时修复。没有任何自动删除：移除只能由显式调用触发，它先把分支导入父仓库再删除目录，并在你确认之前拒绝移除脏 worktree。你可以读取某个 Thread 的提交、改动文件与合并预测，而不移动任何 ref。

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
    base: head-with-uncommitted
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `worktreeRoot` | `~/.dsh/worktrees` | 保存意图日志与全部受管 worktree 的绝对目录，不得位于任何已注册 checkout 之内。 |
| `repoRootResolution` | `explicit` | `spec.repoRoot` 为空时的来源：`explicit`（调用方必须显式给出）或 `parent-cwd`（宿主进程启动时所在的 checkout）。 |
| `base` | `head` | 新 Thread 的 worktree 从何处创建：`head`（已提交的 `HEAD`）或 `head-with-uncommitted`（再加上父 checkout 已被跟踪的未提交改动）。spec 上的 `base` 可逐次覆盖它。见[基座策略](#understand-the-implementation/the-base-policy)。 |
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

<a id="understand-the-implementation/the-base-policy"></a>
### 基座策略

`create()` 用 `spec.base`（缺省时回落到配置的 `base`）决定 Thread 从哪个提交开始。默认值是 **`head`**，与本策略出现之前本包的行为完全一致：把 `baseRef` 解析为提交，仅此而已。

**`head`** —— 已提交的状态。在协调者改到一半时派生出的 Thread **看不到**那处改动，这正是干净基座的用意：两个 Thread 源自同一提交，不会因对方没做过的改动而冲突。

**`head-with-uncommitted`** —— 该提交**再加上父 checkout 已被跟踪的未提交改动**，用 `git stash create` 捕获为一个提交对象。因此在协调者改到一半时启动的 Thread 能看到进行中的工作，之后的合并也不会在父方从未提交过的那些行上冲突。该提交落在 Thread 自己的分支上，所以它是 Thread 的**起点**：`status()` 报告 `commitsAhead: 0`，`changes()` 在 Thread 自己提交之前不报告任何提交。

有三条性质需要直说，因为读者无法从 git 自己的文档推出来：

- **父工作树绝不会被改动。** `git stash create` 只向对象库添加条目 —— 引用命名空间里什么都不会留下，没有文件被移动，`git stash list` 仍为空。`git stash push`/`pop` 则会掏空父工作树，并与同一 checkout 中的其他 agent 发生竞态，正因如此才没有采用。
- **未跟踪的文件**不**包含在内。** 不加 `-u` 时 git 无法在 stash 中表示它们，而这里刻意不传 `-u`。已暂存的新文件**会**包含在内，因为它属于索引的一部分。
- **工作树干净不是失败。** 此时 `git stash create` 以 0 退出且输出为空；已提交的基座就是全部事实，Thread 就从它创建。而 `git stash create` **失败**是另一回事，会让整个 create 以 `WORKTREE_CREATE_FAILED` 失败 —— 悄悄回退到 `HEAD` 会把一个没人要求的基座交给 Thread，并让冲突重新出现。

两种策略下 `baseRef` 都会被解析和校验，因此不可用的基座在任一策略下都会被拒绝。在 `head-with-uncommitted` 下，它表示快照所依据的 ref，也是工作树干净时的回退目标；`WorktreeRecord.baseSha` 始终是真正使用的提交，`WorktreeRecord.base` 记录产生它的策略。

**重启**的 Thread 绝不重新快照。它作为一个全新的克隆重建，检出在移除时已导入父仓库的那条分支上，因此分支保留自己的历史；重新快照父 checkout 会记录下一个不再是该 Thread 工作的祖先的基座，使 `changes`/`filePatch` 拿它去和该 Thread 从未有过的提交做差异对比。取而代之的是继承上一条血脉的 `baseSha` —— 以及产生它的策略 —— 于是恢复的 Thread 仍然从它真正出发的地方度量。

### 意图先于副作用落盘

`create()` 在创建克隆**之前**先向 `worktrees.jsonl` 追加一行 `reserved`，只在克隆及其检出成功后才写 `ready`，并在 `finally` 中删除创建失败或被中止的半成品克隆。这个顺序就是整个设计的核心：意图写入与克隆之间发生崩溃时，会留下一条可检测的记录，而不是一个无人能归属的隐形目录。

该 sidecar 是只追加的 JSONL，每次操作追加一行，内存中折叠（同一 `threadId` 以最后一行为准）。因此状态是*推导*出来的，绝不存在可能与日志不一致的第二台状态机。末行被截断（崩溃中断追加的常见痕迹）会被跳过；中间出现格式错误的行则响亮拒绝，而不是静默丢弃记录。

### 状态机

```text
reserved ──clone + checkout ok──▶ ready ──explicit remove──▶ removing ──▶ removed
   │                               │                              ▲
   │ create failed / signal.abort  │ reconcile: no session        │ reconcile sweep
   ▼                               ▼                              │
rolled-back ──────────────────── orphaned ────────────────────────┘
```

状态迁移是幂等的（重复断言当前状态不写入任何内容），并由显式的边表守卫；不在表中的迁移会抛出 `WORKTREE_STATE_ILLEGAL`。终态唯一的出边是 `removed → reserved` / `rolled-back → reserved`，即有文档的**重启边**：worktree 已被完整删除的 Thread 可以再次创建。

### 分支是什么，以及删除会删掉什么

分支（默认 `dsh/thread-<slug>`；worktree 目录使用同一个 `threadSlug(threadId)` 命名，完整 `threadId` 保存在记录中）是从 Thread 派生的便捷句柄，绝不是身份标识。删除以 `(threadId, path)` 为键：**`remove()` 删除 worktree 目录，并在记录带有分支时先把它导入父仓库**——删掉分支可能让 Thread 的提交变成不可达。集成时把该分支从 Thread 的目录中取出，fetch 进执行合并的检出目录：`git fetch <worktree> <branch>`，然后 `git merge --no-ff <branch>`。也正因如此，重启的 Thread 对自己此前拥有的分支豁免 `WORKTREE_BRANCH_EXISTS` 检查，并作为一个全新的克隆重建、检出在那条分支上，使其早期提交得以保留。其他任何已存在的分支——别的 Thread 的，或你自己的——仍然会被拒绝。

### 对账

`reconcile()` 依据两条互相独立的规则清理记录，且绝不触碰它并不拥有的 worktree：

1. 路径已不在磁盘上的 `reserved`/`ready` 记录（创建中途崩溃）；
2. 依据 `sessionExists` 判定已无持久化会话、且记录早于 `adoptionGraceMs` 的 `reserved`/`ready` 记录。本进程中仍在创建的 worktree 绝不会被清理。

清理在启动时和每次 `create()` 之前运行，因此被遗弃的 worktree 不会占用上限名额。每条孤儿记录都会被标记为 `orphaned`，其目录被删除——带有分支时先导入父仓库——并收敛到 `removed`；若磁盘上从未有过任何内容则收敛到 `rolled-back`。删除失败会留下 `removing` 墓碑，供后续清理收尾。

### 记录的基线与变更

`create()` 按基座策略解析出提交，作为 `baseSha` 存入日志，并连同产生它的策略一起存为 `base`（更早写入的记录两者都没有，回退到 `baseRef`）。`get(threadId)` 返回任意状态下的最新记录。`status()` 增加 `commitsAhead`（`git rev-list --count baseSha..HEAD`）。`changes(record, { maxCommits, maxFiles })` 返回最新在前的提交、`baseSha..HEAD` 已提交的文件（含二进制识别）、总数以及未提交数量。`filePatch(record, path, maxBytes)` 返回单个仓库相对路径的已提交 diff，按字节在字符边界截断；绝对路径与 `..` 路径会被拒绝。所有列表与补丁都有上限。 `mergeCheck(record, { target }, maxConflicts)` 用 `git merge-tree --write-tree` 预测把 worktree 的 HEAD 合并进 `target` 是否冲突，列出至多 `maxConflicts` 个冲突路径并给出总数；不移动任何引用或工作树，git 低于 2.38 时返回 `{ supported: false }`。目标先在主检出中解析，失败时改由持有该分支的另一个 Thread 的克隆来解析；worktree 自己的克隆缺少该提交时，会先把它 fetch 进来再让 `merge-tree` 比较两者。

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
| `WORKTREE_CREATE_FAILED` | 克隆或检出步骤因其他 code 未覆盖的原因失败，或 spec 携带了不可用的分支/Thread id。 |
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

- **省略 `branch` 不等于 detached 检出。** `WorktreeSpec.branch` 是可选的，但没有它的 spec 会得到默认派生分支；detached 检出需要 `WorktreeSpec.detached`（两者互斥），设计把 `branchMode` 的决策交给了 Thread provider 包。
- **读取未被设防。** worktree 隔离的是*写入*与 git 状态：Thread 的仓库是自包含的，object store 就在 Thread 目录内部。读取本身仍然开放，因此 Thread 仍能读取整个仓库。本包不尝试实现读取设防。
- **`maxWorktreesPerRepo` 按仓库计**，与 `list(repoRoot)` 保持一致，而非全进程全局计数。
- **隔离只覆盖写入。** 读取与网络未被隔离，`/tmp` 是共享的。Thread 的 `git push` 指向其克隆的 `origin`，即父仓库的路径，位于 Thread 沙箱根之外，因此沙箱会拒绝它；worker 契约在任何会话中都禁止 push。
- **多进程共用同一 `worktreeRoot` 受锁保护。** 锁依赖本地文件系统的目录原子创建；网络文件系统上不保证。
- **启动清理看不到会话存在性**，因为探针无法经 YAML 传入。探针安装之后，每次 `create()` 之前的清理即可依据会话判断。
- **注册本包需要生成的 tsconfig 别名。** `tsconfig.base.json` 带有生成的 `@deepseek-ai/dsh-*` 包别名；新增本包后请运行 `pnpm run gen-tsconfig-paths`。

<a id="dev-note"></a>
### 开发备注

- 源码布局：`src/index.ts`（服务）、`src/registry.ts`（持久化意图日志与状态机）、`src/git.ts`（git 子进程表面）、`src/error.ts`（类型化失败）、`src/types.ts`（公共数据结构）、`src/states.ts`（状态集合）。
- 基座策略的测试会真实地构造一个未干净的父 checkout，并从磁盘上读回所创建 worktree 里的文件；因此 `git stash create` 与 `git stash push`/`pop` 的区别是靠它对父 checkout **没有**做什么来证明的（`git status --porcelain` 不变、`git stash list` 为空），而不是靠一个被 mock 的返回值。
- 测试为每个用例构建真实的临时 git 仓库（`mkdtemp` + `git init` + 一次提交），把每个 worktree 创建为本地克隆，并把每条断言都从 git 本身读回——`git rev-parse --git-dir` 解析到 worktree 自己的目录内、`git branch --list`、`git status --porcelain`——而不是相信服务自己的账本。它们覆盖 SBFT 第 A1–A9 行，以及配置守卫与状态机各条边。
- `SBFT A6`（创建过程中中止）通过一个会 `sleep` 的 `post-checkout` 钩子变成确定性用例，该钩子经 `core.hooksPath` 下发——克隆不会复制父仓库的钩子——从而保证 abort 确实落在克隆检出进行期间，而不是与它赛跑。

**运行时不变式：** 不发布伴生入口。sidecar 日志是本服务持有的唯一状态：每次转换都在咨询锁下对照刚折叠出的日志校验，因此非法边会从本该写入它的那次 append 本身抛出；而分支、提交与工作树事实在调用时直接从 `git` 读出，而不是取自某个维护中的投影。
