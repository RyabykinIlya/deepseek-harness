---
description: "项目会话后台线程集合的会话头部控件，基于活跃度 / stopReason 两条正交状态轴，逐行提供停止、归档与复制分支操作，并提供把某个线程作为完整对话打开的寻址聊天。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-threads

[English](README.md) | 中文

## 概述

在一个头部控件里展示项目会话的后台线程，并把其中任意一个作为对话打开——可以打开到主工作区，也可以作为侧边栏页签。每一行并列显示读自会话存储的活跃度与上一轮已结束回合的 `stopReason`，并自带「停止」「归档」与「复制分支名」。归档在移除带未提交修改的工作区之前会先询问。在项目里，该集合是一个控件而不只是一份报表：它在第一个线程存在之前就已经在列，并能打开项目的共享记忆供编辑。边栏底部的「新建项目」操作会开启一个这样的会话。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在已经投影项目会话线程的 Web 组合中加入本包：

```yaml
- name: '@deepseek-ai/dsh-experimental-client-ui-threads'
```

它需要宿主侧注册 `threads` 投影，这由线程领域包完成：

```yaml
# the Threads domain seam that publishes `threads`
- name: '@deepseek-ai/dsh-experimental-threads'
```

### 何时选用

当用户需要看到某个项目会话正在跑哪些后台工作、需要停止或归档其中某个线程、并且要阅读某个线程的对话时，选用本包。当你需要线程工作区的磁盘内容，或者需要在模型自行判断之前就创建线程时，不要选用——「新建线程」一行只把指令放进输入框，真正的创建由模型调用 `subagent` 完成。

### 配置

| Key | Type | Default | Meaning |
|---|---|---|---|
| `projectAgentPresets` | `string[]` | `['project']` | 视为项目的智能体预设标识列表。第一项也是「新建项目」操作所组合的预设。 |

本包不导入项目预设包：部署通过插件配置指明预设标识，浏览器半边的一切判断都由该列表推导而来。默认值指明的是随包发布的 `project` 预设，因为客户端行的配置从不投递到浏览器，只有 schema 默认值能抵达它；指明它就使该特性开箱即用。

<a id="what-the-control-shows"></a>
### 控件展示什么

在项目之外，投影至少显示出一个线程之前触发器不出现；在项目之内，触发器始终在列，没有任何东西时显示零。存在运行中的线程时，文案是运行数量，否则是总数：

| 触发器 | 含义 |
|---|---|
| `2 个线程运行中` | 两个线程处于活跃状态，集合中可能还有更多 |
| `3 个线程` | 存在三个线程，且当前没有活跃的 |

每一行携带线程的标签、一行持久化工作事实的副标题，以及两条状态轴：

| 状态轴 | 来源 | 展示形式 |
|---|---|---|
| 活跃度 | `sessions.byId[threadId].running` | 有轮次进行时显示转圈动画，否则显示暗色圆点 |
| 终态 | `stopReason` | 每种终态各有独立图标与文案；有轮次进行时不显示 |

五种终态一一对应——`completed`（对勾）、`aborted`（暂停竖条）、`error`（感叹号）、`max-tokens`（截断横条）、`refusal`（带斜杠的圆圈）——后三者共用色调，但不共用文案，也不共用图标。会话不活跃且没有 `stopReason` 的行属于「未运行/已结束」：它不带终态标签，也绝不会被呈现为失败。

副标题把持久行里记载的内容拼接起来，并跳过为空的那些：分支名、线程已有提交时的「领先 N 个提交」，以及工作区存在未提交修改时的「M 个未提交」。线程收尾说明的开头单独占其下一行，按行宽截断，完整文本作为悬停提示。

<a id="row-actions"></a>
### 行操作

每一行仍然是一个 `role="option"`：点击、Enter 或空格会在主对话中打开该线程，而行尾的按钮只对线程执行操作、不会打开它。这些按钮是行内真正的按钮，因此自身可获焦点、自身响应 Enter，而 ArrowUp/ArrowDown 仍能从其中任意一个继续遍历集合的漫游焦点。

| 操作 | 显示条件 | 调用的接口 |
|---|---|---|
| 停止 | 线程处于活跃状态 | `ctx.remote.subagents.interruptByParent(threadId, projectSessionId, 'continuable')` |
| 归档 | 始终 | `ctx.remote.threads.archive(projectSessionId, threadId, { force })` |
| 复制分支名 | 线程有分支 | 共享的剪贴板助手 |
| 在侧边栏打开 | 始终 | 同一个线程作为右侧边栏聊天页签 |

`threads` 与 `projectMemory` 命名空间由本包自己用各领域包生成的贡献挂载，因此随包发布的 Remote 汇总（`dsh-api-remotes`）永远不会依赖实验性包；两个命名空间随插件一同撤回，第二个挂载失败时会先撤回第一个。

停止走的是父地址通道，而不是项目自身正在进行的轮次，因此项目本身不必处于运行状态，停止也能抵达它的线程。被拒绝的停止会以警告提示条上报，该行保持不变。

归档具有破坏性——它会删除线程的 git 工作区——因此当工作区存在未提交修改时会先行询问。宿主会以 `threads/worktree-dirty` 拒绝这类归档；该行随后打开一个确认框，点名该线程并说明这些未提交修改无法恢复，「仍然归档」按钮会保持禁用，直到勾选确认复选框。只有此时才会以 `force: true` 重试同一次调用。其他失败与成功都会以提示条上报。

提示条与确认框由头部席位渲染，而不是渲染在线程集合菜单内部，因为归档最后一个线程会让控件消失：该次归档的通知必须比发起它的菜单更长寿。

<a id="opening-a-thread"></a>
### 打开一个线程

点击行会在主工作区对话中打开。行尾的「在侧边栏打开」按钮会把同一个线程作为右侧边栏的聊天页签打开，用户因此可以在线程运行期间继续阅读项目会话。

两条路径都落在同一条已被验证的通道上：`dsh-resource://threadchat/session/<threadId>?parent=<sessionId>` 地址、在地址生命周期内持有线程会话引用的资源提供者，以及在 `SessionProvider` 下以 `variant: 'embedded'` 渲染的共享 `conversation.content` 工厂。本包不含任何对话渲染器。

<a id="starting-a-thread"></a>
### 开启一个线程

在项目中，菜单的列表下方始终带着「新建线程」一行。它只把一段准备好的指令放进该会话的输入框，并不发送：用户编辑并发送后，由模型自行判断这个请求是否需要一个后台线程，并调用 `subagent`。这样工具选择权留在模型手里，不需要新增任何宿主接口，也意味着半句没写完的指令绝不会凭空产生工作。

这一行是按钮而不是列表项——`role="listbox"` 只接纳 `option` 与 `group`——并且加入同一套漫游焦点遍历，因此集合为空时 ArrowDown 也能抵达它，那时它就是唯一的一行。

<a id="starting-a-project"></a>
### 开启一个项目

边栏底部的「新建项目」按钮会在会话更新时间最新的那个工作区里创建一个空会话，并以项目身份打开它。

这个席位是刻意选定的。`conversation.hero.agentPreset` 是智能体预设选择器已经占用的单占用席位，`sidebar.panellist` 的条目指向一个主面板而不是执行动作，而会话「…」菜单中的一行会暗示它作用于该会话而不是新建一个。边栏底部在任何宽度的边栏里都紧邻设置，且位于会话列表之外，因此这个操作读作应用级操作，是新建一行而不是修改一行。

创建分三步、且顺序固定：`ctx.sessions.create({ workspaceId })`，然后在会话仍为空时 `ctx.remote.agentPresets.select(sessionId, preset)`，最后才是打开。创建本身不带预设——客户端无法指定——而组合方式的选择与智能体预设选择器暂存选择的方式相同，都发生在第一个轮次之前。只有选择成功之后才会打开会话，因此项目的第一个轮次绝不会跑在默认组合之下。失败会以警告提示条上报并说明原因：没有配置预设、没有可创建的工作区、创建被拒绝、部署没有该预设，或者会话已开始因而被锁定。创建成功但预设被拒的会话会刻意留给用户，而不是被静默删除。

<a id="thread-header"></a>
### 线程头部

在主对话中打开的线程会在会话头部区域得到一个紧凑的头部，作为右侧边栏标签页打开的线程则在其对话上方得到同样的头部。它显示标签、活跃状态、上一次结果和分支，右侧是「停止」（线程运行时）和「归档」。两处都复用集合的操作代码，因此未提交修改的确认、提示条与进行中保护的行为一致；项目就是该线程会话的父会话。

<a id="project-memory"></a>
### 项目记忆

在项目里，集合底部在「新建线程」旁多了一行「记忆」。它在同一个弹层里取代线程列表，显示该项目的条目，按时间从新到旧，每条带作者（协调者、线程或你）和时间。底部的表单用于添加条目；每条都可以编辑和删除。每次改动之后都会重新读取。文本为空或过长等拒绝会连同宿主给出的消息就地显示，列表保持原样。没有条目时视图会如实说明。离开线程列表会固定弹层，悬停移出不会关闭该视图；Escape 关闭它，下次打开从线程列表开始。

-----

<a id="understand-the-implementation"></a>
## 理解实现

### 设计取向

两条状态轴是承重的决定。领域层明确指出活跃度与 `stopReason` 正交，把它们合并成单一枚举将不得不虚构运行时根本不会产生的状态。因此 `ThreadStatus` 把 `liveness` 与 `outcome` 放在各自独立的字段里，行也渲染为两个独立元素。本包中没有任何位置产出合并后的状态字符串，所以没有组件可能无意间虚构出这种状态。

活跃度也不是持久数据，因此不能来自行本身：`roster.ts` 先把目录投影与 `threads` 投影合并为持久行，再由 `withLiveness` 最后附加会话存储的 `running`。线上 `ThreadStatusRow` 根本没有 `running` 字段，这正是过期的持久值永远不会被当作当前状态渲染的原因。

### 源码索引

| Path | Role |
|---|---|
| [`src/client/ThreadStatus.tsx`](src/client/ThreadStatus.tsx) | 拆成独立取值的两条状态轴，以及每种 `stopReason` 的图标 |
| [`src/client/ThreadsHeaderAction.tsx`](src/client/ThreadsHeaderAction.tsx) | 头部控件、线程集合、行操作、反馈界面，以及照搬的下拉交互 |
| [`src/client/ThreadActions.tsx`](src/client/ThreadActions.tsx) | 「停止」「归档」「复制分支名」及其提示条与未提交归档确认，由集合和线程头部共用 |
| [`src/client/ThreadChatHeader.tsx`](src/client/ThreadChatHeader.tsx) | 侧边栏对话上方和会话头部区域里的线程头部 |
| [`src/client/MemoryPanel.tsx`](src/client/MemoryPanel.tsx) | 记忆视图：列表、添加、编辑、删除、就地显示拒绝 |
| [`src/client/memory-types.ts`](src/client/memory-types.ts) | 从 `projectMemory` Remote 读取的记忆条目与标识类型 |
| [`src/client/useThreadRoster.ts`](src/client/useThreadRoster.ts) | 一个项目合并后的线程行与加载状态，供两处界面使用 |
| [`src/client/mount.ts`](src/client/mount.ts) | 挂载 `threads` 与 `projectMemory` Remote 命名空间，然后注册全部贡献 |
| [`src/client/roster.ts`](src/client/roster.ts) | 目录行与 `threads` 行合并后再附加活跃度 |
| [`src/client/actions.ts`](src/client/actions.ts) | Remote 调用与行之间共享的操作结果类型 |
| [`src/client/project.ts`](src/client/project.ts) | 哪个会话是项目、新建项目时组合哪个预设，以及在哪个工作区创建 |
| [`src/client/project/NewProjectFooterAction.tsx`](src/client/project/NewProjectFooterAction.tsx) | `sidebar.footer.action` 上开启项目的按钮 |
| [`src/client/config.ts`](src/client/config.ts) | `projectAgentPresets`，唯一由部署配置的事实 |
| [`src/client/thread-chat/index.tsx`](src/client/thread-chat/index.tsx) | 线程聊天地址、资源提供者、边栏页签与内嵌对话 |
| [`src/client/locales.ts`](src/client/locales.ts) | `threads` 字典（zh 是键集的唯一事实来源） |

### 下拉交互沿用目录的交互

悬停打开、点击固定、离开时的宽限期、外部指针关闭、Escape 归还焦点，都直接复用 `SubagentHeaderLineage` 的交互而不是另造一套：悬停 150 毫秒打开，离开 120 毫秒宽限，以及同样的 `focusAt` 环绕式键盘处理。线程集合是扁平的，因此其行使用 `role="listbox"` 内的 `role="option"`，而不是目录的树角色；键盘处理、环绕行为和漫游焦点均未改变。获得焦点的行内按钮在该遍历中归属于它所在的行，因此从「归档」按钮按 ArrowDown 会移到下一个线程，而不是该行的其他按钮。

### 线程身份即会话身份

线程的持久身份就是运行它的会话的身份——工作区提供者在为线程准备隔离检出时记录的是 `threadId: request.sessionId`。`threadSessionId()` 是断言这一事实的唯一位置，因此将来把两者分开的提供者只需改动一行，而不必改动每个调用点。也正因如此，停止与归档才能用它们各自的 Remote 调用所需的两个身份来指名一个线程。

### 可见性需要证据

在投影尚未读取、读取仍在进行且没有任何行、或会话根本没有线程时，控件都不渲染——这与子智能体目录遵循同一条规则。读取失败是唯一的例外：控件会出现，并带上报错与重试入口。项目是另一个例外，与其说是证据规则的例外，不如说它本身就是另一种证据：项目里，会话自身的组合方式就是证据，因此该集合在 `threads` 读取落地之前就已出现，并在读取最终为空时继续留在列上。

### 项目身份是一种组合方式，而不是一个标志

线上任何地方都没有给会话打上“项目”标记。这条规则是对智能体预设注册表已经发布的 `agentPreset` 会话投影执行 `isProjectSession(preset, projectAgentPresets)`——与预设标签读取的是同一个值——因此识别一个项目只需一次投影读取，不需要任何新的宿主接口。预设本身从不被导入：部署通过插件配置指明其标识，默认值指明的就是随包发布的那个。

-----

<a id="model-experience"></a>
## 模型体验

### Thread 集合与对话

#### 模型看到什么

什么都看不到。本包渲染的是浏览器一侧：它注册 slot，并挂载 `threads` 与 `projectMemory` Remote 命名空间，不贡献任何工具、提示词段落或消息。Project 模型通过 `thread_status` 与 `thread_diff` 读到同样的持久行；「新建线程」一行只是准备好一条由用户发送的指令，因此由模型判断一个请求是否需要后台 Thread。

#### Token 影响

本包为零。准备好的指令就是输入框里的普通用户文本，Thread 对话复用共享的对话渲染器，因此这里没有任何内容会进入模型请求。

#### KV 缓存影响

这里没有任何内容进入模型请求，因此 provider 的缓存复用不受影响。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **自身不创建线程。** 「新建线程」一行只准备指令，创建由模型调用 `subagent` 完成。这里没有任何直接开启线程的宿主 RPC；除非部署需要一个不经用户编辑就产生工作的按钮，否则也不需要。
- **停止要等线程自身结算。** 宿主一接受中断就会立即确认；该行会一直保留转圈动画，直到线程的会话报告它已停止。
- **归档是移除线程的唯一方式。** 没有单独的删除操作；被其他客户端归档的线程会在下一次投影读取时直接从集合中消失。
- **不能改名。** `label` 在 `thread/created` 时固定，该集合只渲染已记录的值，从不编辑。
- **一个线程对应一个会话。** `threadSessionId()` 假定线程即会话。若某个提供者在会话目录之外保存线程，则需要额外的解析步骤。
- **除创建顺序外无其他排序。** 行沿用投影的持久创建顺序，没有按最近活跃度或活动量排序。
- **一个部署只有一个项目预设。** `projectAgentPresets` 可以识别多个预设，但「新建项目」操作始终组合第一个。
- **新建项目需要已有会话来选定工作区。** 完全没有工作区时，该按钮会如实上报，而不是弹出目录选择；创建工作是工作区浏览器的职责。
- **仅有记忆。** 资料库视图尚未纳入本包；记忆视图以用户身份编辑条目，宿主会把作者标记为 `user`。

<a id="dev-note"></a>
### 开发备注

在仓库根目录运行测试套件：

```bash
pnpm vitest run packages/client/ui-threads
```

`tests/threads-header-action.client.spec.tsx` 覆盖由投影驱动的行、每种 `stopReason` 各自的图标与文案、读自会话存储的活跃度、键盘遍历与关闭规则、打开线程、行操作（停止、含脏工作区确认与其强制重试的归档、复制分支名，以及每种失败对应的提示条），以及项目身份带来的全部行为——始终可见、空列表文案，以及「新建线程」一行准备出的指令；`tests/roster.client.spec.ts` 覆盖目录投影、合并与活跃度附加；`tests/project-identity.client.spec.ts` 覆盖身份规则、其配置与工作区选择；`tests/new-project-footer-action.client.spec.tsx` 覆盖该按钮的工作区解析、激活、失败文案与防重复进入；`tests/thread-chat.client.spec.tsx` 覆盖地址往返、资源提供者的生命周期与内嵌对话；`tests/browser-plugin.client.spec.ts` 覆盖插槽注册、其绑定的导航行为，以及各操作所发出 Remote 调用的确切形态。 `tests/thread-chat-header.client.spec.tsx` 覆盖线程头部及其共用的操作；`tests/memory-panel.client.spec.tsx` 覆盖记忆视图；`tests/index.client.spec.ts` 覆盖包入口。

**运行时不变式：** 不发布伴生入口。本包展示的每个值都投影自 Host 持有的状态——`threads` 行、读自 Session 存储的存活性标志，以及 `projectMemory` Remote 背后的条目——因此它在运行期持有的只是一组随插件卸载而解绑的 slot 注册与 Remote 命名空间注册。
