# Agent Note: Provider 为 continuable child 选择工作目录

Status: implemented

[English](2026-10-02-continuable-child-cwd-seam.md) | 中文

## Problem

continuable child 无法拥有属于自己的工作目录。`packages/subagent/subagent/src/child-agent.ts` 中的 `childSessionMeta` 无条件写入 `cwd: parentHeader.cwd`，因此每个 child Session 都继承委派它的 parent 的 cwd；而 `packages/subagent/subagent/src/continuation-messages.ts` 中的 `withContinuableReturnGuidance` 追加了一句只在这种情形下才成立的文本——「The parent shares your workspace but does not automatically receive your transcript, tool output, or reasoning.」。provider 对一个 continuable child 的全部参与就是 `prepareContinuable`，而它返回的 `ContinuableCreateSpec` 只携带可选的父级历史种子。

逼出这个问题的用途是实验性的 Projects 与 Threads 特性：Project Session 把工作委派给后台 Thread，而每个 Thread 应当在属于自己的 `git worktree`、属于自己的分支上运行，使并行的 child 永不共享同一个 checkout。harness 已经具备该机制所需要的部分。`SandboxPolicyService.resolve` 计算 `workspaceRoot: resolveWorkspaceRoot(session?.header.cwd ?? this.workspaceRoot)`（`packages/sandbox/sandbox-policy/src/index.ts`），因此 Session 的 header cwd **就是**它的写入边界。把一个 worktree 路径作为 child Session 的 cwd 交出去，就把这个 child 的写入限制在该 worktree 内，不需要新的沙箱模式、新的进程边界，也不需要新的强制机制。缺的是一个让 provider 把这件事说出来的办法。

这项能力必须落在 subagent 包里而不是 Threads 内部，因为被泛化的并不是 worktree。任何 continuable provider 都可能希望自己的 child 待在 parent checkout 之外的地方——构建目录、副本、按测试隔离的夹具——而其中持久的那一半是 continuation manager 的属性，因为只有它负责恢复 child。若只允许会创建 worktree 的包来提供这个能力，那就会把一个特性塞进接缝里。

## Decision

`ContinuableCreateSpec` 新增 `readonly cwd?: string`（`packages/subagent/subagent/src/types.ts`）。缺省表示 child 继承 parent 的 cwd，这是每个已有 provider 依赖的默认行为；给出则表示 child 在那里物化。管理器在取得 child 锁之前校验它——`assertProviderCwd` 调用 `assertUsableCwd('subagent', \`provider "${provider}" cwd\`, cwd)`，正是 out-of-process 一次性路径早已使用的那个辅助函数，并把任何失败包装成 `SubagentError(..., 'INVALID_PROVIDER_CWD')`。该值必须是绝对路径，且指向一个进程可以进入的既有目录（`statSync().isDirectory()` 加一次 `X_OK` 访问检查）；相对路径、普通文件和不存在的目录都以同一个 code 失败，且失败发生在任何 child 存在之前。

`childSessionMeta` 新增第四个参数 `overrides: ChildMetaOverrides = {}`，与它原本解析的三个值并列携带 provider 给出的 `cwd` 与 `agentPreset`，并用 `overrides.cwd ?? parentHeader.cwd` 解析出 child 的 `meta.cwd`。当 provider 与 parent 都没有给出时，`cwd` 会像以前一样从元数据中省略。parent 不再隐式胜出：parent 没有 cwd、provider 也没给出 cwd 的 child，其元数据里根本没有 `cwd` 这个键，而不是一个空字符串。

`SubagentContinuationManager.startContinuable` 把两个值都穿进该元数据作为 child 的 `create.meta`，`ctx.agents.create()` 据此生成 child 的 session header——于是 `header.cwd` 与 `header.agentPreset` 都是持久的，lineage、descriptor 与委派深度随它们一同记录。冷恢复不重新推导其中任何一项：`coldResume` 折叠 descriptor，并以不带 `create` 块的方式调用 `activations.materialize`，这走的是 `ctx.agents.resume()`，加载持久化的 Session。provider 不会被咨询，隔离因此能挺过进程重启。这是[Continuable subagents](../feature/2026-07-28-continuable-subagent-conversations.zh.md)钉下的那条「provider 无关的冷恢复」，从「用哪种组合」扩展到「用哪个目录」。

child 的初始任务文本跟随解析出的值。`withContinuableReturnGuidance(parentId, prompt, isolatedCwd?)` 现在把 child 的 cwd 作为第三个参数，调用点传入 `childHeader.cwd !== parent.session.header.cwd ? childHeader.cwd : undefined`——比较的对象是**已物化的 child** 的 header，而不是 provider 声称了什么，因此一个给出 parent 自身 cwd 的 provider 会拿到共享工作区那句，因为那时这句话确实成立。在隔离情形下，child 会被告知 `You work in your own separate checkout at "<path>". The parent does not see files you change there until it inspects that checkout, and it does not automatically receive your transcript, tool output, or reasoning. State in the message what changed, where, and how you verified it.`。共享工作区分支与改动前的字符串逐字节相同：前后都是 405 字节，这是把 `HEAD` 版本的 `withContinuableReturnGuidance` 与当前版本并排运行得到的（隔离变体为 578 字节）。树中没有任何快照带有该字符串。指引只在 child 的工具注册表暴露 `send_message` 时追加，这一点没有变化。

`ContinuableCreateSpec` 还新增 `readonly agentPreset?: string`，让 provider 指明 child 由哪个 preset 组合而成；缺省表示 child 加入 parent 已组合的 preset，即原有行为。它在物化之前由 `assertProviderPreset` 校验：要求存在 `agentPresets` 注册表、`presets.resolve(id)` 成功、且解析结果不带 `broken`；任一失败都是 `SubagentError(..., 'UNKNOWN_AGENT_PRESET')`。随后 `applyContinuableChildComposition` 在该 preset 与 parent 已组合的 preset 不同时把它挂载到 child 的作用域上，否则退回 `composeFrom`，并且它取的是 `child.session.header.agentPreset`——因此全新创建与冷恢复都以同一个 preset 组合，两个决定都不经过 provider。

provider 带 code 的拒绝如今能完好地到达 Remote 调用方。`packages/subagent/subagent/src/control.ts` 中的 `providerRejection` 把任何不是 `SubagentError`、且带有字符串 `code` 的 `Error` 映射为 `subagent/provider-rejected`，details 为 `{ code, message }`；`rejectPrompt` 在退回 `gateway/internal` 之前先问它，并且该辅助函数从包入口导出，供那些启动 continuable child 的 Remote 表面使用。`HarnessError` 的子类是普通情形——worktree provider 的 `WorktreeError('NOT_A_GIT_REPO')` 就是——而 subagent 包并不枚举 provider 的错误 code，因为它并不定义这些 code。包自身的 `SubagentError` code 保持已有的 admission 映射；非 `Error` 的抛出值或没有字符串 `code` 的错误仍然是 `gateway/internal`。

## What a relocated child is not confined from

这隔离的是写入与 git 状态。它不是安全边界，也根本不是隔离；接缝自身的文档用的就是同样的措辞。

- **没有读取围栏。** `git worktree` 与 parent 仓库共享对象库；worktree 增加的是自己的 `HEAD`、index 与 refs，而不是自己的对象。处在 worktree 中的 child 可以读到 parent 仓库持有的每一个对象，包括 parent 那种「每个 child 一个分支」的策略本想隔开的分支与 reflog 条目。沙箱词汇本身也从未声称读取隔离：`SandboxMode` 只覆盖 FILE 效应（`packages/sandbox/sandbox-policy/README.zh.md`，以及[沙箱决定](../feature/2026-07-06-sandbox.zh.md)）。
- **网络是敞开的。** 这次改动没有触及出口流量，而沙箱词汇明确不声称网络或进程可见性。
- **临时存储不是 per-child 的。** `workspace-write` 在 workspace root 之外还授予后端自己的 temp root，而这些 root 不是 worktree。worktree 的默认位置在 parent checkout 之外（worktree-manager 默认 `worktreeRoot` 下的 `~/.dsh/worktrees`），这正是写入限制成立的原因，但它对共享的 temp 路径毫无作用。
- **`git push` 依然可行。** child 的沙箱与 parent 运行在同一个 `workspace-write` 模式下；没有任何东西禁止 push，而 worktree 是一个一等的 git 客户端。这里的隔离是由 provider 契约维持的约定，而不是 harness 装上的屏障。

## Alternatives considered

**让 provider 通过 `ContinuableCreateRequest` 把 cwd 传下来，而不是返回它。** request 是管理器对 provider 的调用；spec 是 provider 的回答。每个 continuable provider 已经完整收到 `request.parent`，本来就带着 parent 的 cwd，让管理器再下发一份没有用处；而由管理器给出的值只可能是管理器已经知道的值。

**把 child 的 cwd 作为能力交给 provider，或让 provider 自己创建 Agent。** 管理器通过自己的 activation-owner 作用域调用 `ctx.agents.create()`，正是为了让该作用域在结构上拥有每一个 handle，这让 child 优先的拆卸顺序与「至多一个 Activation」的不变量得以表达。若由 provider 自行创建或迁移 Agent，它就持有一个管理器并不拥有的 handle，冷恢复还必须向它讨回 child——正是[Continuable subagents](../feature/2026-07-28-continuable-subagent-conversations.zh.md)在把 provider 参与压缩为一个方法时否决掉的那种耦合。cwd 是数据，而这条接缝收的正是数据。

**加一个 `worktree` 字段，或把 worktree 逻辑放进 subagent 包。** 那样接缝就会背上 git 依赖与 Threads 形状的词汇，而想要一个普通目录的 provider 将无路可走。worktree 机制留在 `packages/subagent/worktree-manager` 与 `packages/subagent/subagent-thread-worktree`；接缝只接受一个路径。

**接受任意字符串，留到首次使用时校验。** 管理器握着最早的可判定点，在 child 锁与 `ctx.agents.create()` 之前。放到后面校验会留下一份持久的 Session、一段需要回滚的 Activation，对 worktree provider 而言还会留下一个它必须清理的目录。测试通过断言「被拒绝的 cwd 之后 `ctx.agents.list()` 仍只有 parent」来钉住这次早期失败。

**除 header 之外，把 cwd 也记进 subagent descriptor。** header 已经持久化了它，而冷恢复正是读 header 来组合。多存一份就多出一个必须保持一致的事实，还会把 worktree 路径塞进一个折叠规则本应与提供方无关的 descriptor。

**总是发隔离措辞，或总是发共享工作区措辞。** 前者会告诉一个与 parent 共享 checkout 的 child 说它在一个并不在的地方；后者会告诉一个被隔离的 child 说 parent 已经能看到它的文件，而这恰恰是这次改动要制止的具体谎言。按已物化的 header 分支能让两段文本都为真，并让默认情形逐字节不变。

**在 subagent 包里枚举 provider 的错误 code。** 把 `NOT_A_GIT_REPO` 映射成自己的 `subagent/` code，等于让本包成为一份它并不定义的词汇的所有者，而每一个新的 provider code 都会变成这里的一次改动。`provider-rejected` 携带 `{ code, message }` 并把路由留给调用方，其理由与本包为自己的失败抛出 `SubagentError`、却不重新映射它们完全一样。

**也给一次性的 `SubagentStartRequest` 加一个 cwd。** 一次性路径属于 provider：由 in-process driver 组合那个 child，而 `dsh-subagent-thread-worktree` 的文档说明它的一次性 `start` 与 parent 共享 cwd，因此未被隔离。树中没有任何东西要求一次性迁移，而对只有 provider 才能兑现的值做服务层校验，是一个没有使用者的校验。

## Consequences

任何 continuable provider 现在都能安置自己的 child，而且安置结果是持久的：child Session 的 header 记录它，lineage 与 descriptor 与它同行，冷恢复无需再问 provider。这个值就是一个普通的绝对路径，因此同一条接缝既服务于 worktree，也服务于构建目录或夹具。

两种新的「child 存在之前」的失败模式加入了 continuable 启动可能不返回 id 就失败的方式之列：`INVALID_PROVIDER_CWD` 与 `UNKNOWN_AGENT_PRESET`。两者都很响亮，且都作为 provider 的声明被拒绝来报告，而不是作为 child 创建失败来报告，因为两者都是 provider 声明被驳回。

指引这句话如今是解析结果状态的函数，而不是常量。返回与 parent 相同 cwd 的 provider 会产出完全不变的文本，因此已有 child 不会看到任何差别；迁移了 child 的 provider 会得到要求写明「改了什么、在哪里、如何验证」的措辞，因为 parent 看不到那些文件。

`providerRejection` 是导出的，不是自动生效的。subagent 包自身的 Remote 表面只有 `subagent.prompt` 与 `subagent.interruptByParent`；`startContinuable` 不在其中，因此 `prepareContinuable` 的拒绝要到达调用方，必须经过发起该 child 的那个特性自己的 Remote 表面，而那个表面必须调用 `providerRejection`（或 `rejectPrompt`），否则错误仍会被压平成 `gateway/internal`。树中目前还没有任何地方调用它。

否定性保证正是读者最不能搞错的部分：被迁移的 child 在它的写入、以及它能改动的 git 状态上被限制，此外一无所限。若某个 provider 把这件事向用户描述为隔离、或描述为沙箱，那就是夸大了。
