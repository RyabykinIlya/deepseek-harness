---
description: "Rank OpenRouter endpoints by blended price and fold model-routing decisions into a per-session projection."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-model-routing

[English](README.md) | 中文

## 概述

`dsh-experimental-model-routing` 是 `tiers` 模型路由的纯决策层：tier 配置 schema 及其校验器、选出最便宜且合格的 OpenRouter 提供方的 endpoint 过滤器与价格排序、记录一次决策选中了什么的 `modelRouting` Session 投影，以及该路由及其各界面共用的事件与 Remote 词汇。它本身不分发任何请求。它以实验性名称发布，不承诺稳定性。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

通过 `model-routing` 组合包挂载本包；该组合包还会加载为 `tiers` LLM 路由服务的适配器以及浏览器侧的设置页。只有当调用方已经持有 tier 配置、并需要同样的排序或同样的投影状态时，本包单独使用才有价值。

### 何时选择它

当某个 tier 的模型必须按*下一次 agent 轮次*的成本、而不是按逐 token 标价来排序时，或者当 Session 日志必须能回答它的上一次路由决策选中了哪个模型、哪个提供方、哪种量化时，选择它。当排序必须仅凭一份记录下来的列表即可复现时，请不要选择它：这里的价格全部实时读自 OpenRouter 的 `/endpoints`，本包自己从不缓存它们。

<a id="tiers"></a>
### tier

tier 是一组命名的可互换模型，外加每个服务于其中某个模型的 endpoint 都必须通过的过滤器：`minQuantization`、`unknownQuantization`、`free`，以及该 tier 公布的 `contextWindow`。`input`（默认 `[text]`）声明该 tier 对外公布哪些模态，而决策会依据 OpenRouter 模型目录按模型强制执行它：一个到达该路由时携带图片的请求，只会落到目录条目在 `architecture.input_modalities` 中声明了 `image` 的模型上；任何未如此声明的模型——包括目录根本没有列出的模型——其每一个 endpoint 都会以 `modality` 被拒绝，因为沉默不等于能力。

因此，在声明了 `image` 的 tier 中放入一个纯文本模型是安全的：它只是不会被用于图片请求。但它无法服务于一个已经读过图片的 Session，因为该图片会留在该 Session 的历史中，并在之后的每一次请求里被重放。

当该 tier 中没有任何候选模型被证明接受图片输入时，决策会以 `MODEL_ROUTING_NO_ENDPOINT` 失败，其消息按原因统计被拒绝的 endpoint，其中包含 `modality=<n>`。目录读不出来会让每一个候选项都得到这一结果，并有一行警告说明原因是目录不可读。文本请求从不为模态读取目录，也不受该过滤器影响。

`validateSettings` 会拒绝该路由无法据以行动的 settings 值，包括不是路由模型 id 的 tier 名称、缺少 `author/` 的模型 id、落在 effort 列表之外的默认 effort、以及一对次序颠倒的 judge 阈值；它用一条消息指出第一个无法服务的字段。

<a id="extra-sources"></a>
### 额外来源

一个 tier 的候选并不只有 OpenRouter endpoint。`extraSources`（默认 `[]`）列出同一个 tier 参与排序的非 OpenRouter 来源：每一项声明派发其模型的 pi-ai 路由（`route`）、该路由服务的模型 id——可以是它自己的名字（`models`），也可以是一份从规范 id 到该路由自身 id 的 `modelMap`——以及排序所混合的逐 token 价格（`price`）。于是 OpenRouter 上的 `xiaomi/mimo-v2.6-pro` 与直连路由上的 `mimo-v2.6-pro` 是同一个模型的两个来源，由混合价格在它们之间裁决。

`modelMap` 的值可以追加 `@` 与一个 JSON 价格对象来声明该候选自己的价格。按 token 统一费率计价的方案填 `usdPerToken`；按 token 类型加权的方案分别填各桶（`promptUsdPerToken`、`completionUsdPerToken`、`cacheReadUsdPerToken`）——按信用度加权的订阅正是这样定价的，Xiaomi MiMo Token Plan 对缓存命中、缓存未命中与输出 token 分别计信用度，因此其来源填三个桶，例如 `mimo-v2.6-pro@{"promptUsdPerToken":4.363636e-7,"completionUsdPerToken":8.727273e-7,"cacheReadUsdPerToken":3.636364e-9}`。没有追加对象时用该来源的 `price`；两者都没有的来源按 `unpriced` 参与排序，绝不会被当成免费。`modelMap` 的 `@` 写法只在这一处被读取，因此它只有一个含义。

直连来源不声明 status、uptime 与 quantization，所以这些过滤器对它是中性的：缺失的测量值不得成为拒绝理由，否则任何直连来源都无法进入排序。能力过滤器仍然生效。`tools` 是路由必须声明的一项——来源上的 `tools`（默认 `true`）——而 `context` 与按模型的 `modality` 规则的约束力与 endpoint 完全相同。`@deepseek-ai/dsh-llm-pi-ai` 未配置的路由所对应的来源从不参与排序：决策会把它报告为不可派发，而不是把请求钉在一条无人服务的路由上。

被选中的直连来源以它自己的路由作为 `provider` 派发，并且不带 OpenRouter 的 `provider` 块：pi-ai 会拒绝把该块加在不讲 `openai-completions` 的模型上。`model-routing/decision` 事件记录获胜来源的种类（`source: { kind, tag }`，`kind` 为 `openrouter` 或路由键），对声明了价格的直连来源还记录其混合价格所依据的逐 token 价格，因此决策日志能说明某个来源为何胜出。

<a id="snapshots"></a>
### 快照

不带版本的模型 id 不是滚动别名。`deepseek/deepseek-v4-pro` 指的是该家族的 **0423** 版本，而 `deepseek/deepseek-v4-pro-0813` 指的是同一家族的八月版本，因此一个列出前者的 tier 会一直停留在它上面，直到有人去改配置。`snapshotPolicy` 就是这两种立场之间的开关：

- `pinned`（默认）按配置中书写的 id 决策，这正是让一个部署的成本与行为可由该配置本身复现的东西。
- `latest` 在决策前把每个 id 前移到它所属家族的最新快照，并且是从 OpenRouter 的目录而非模型的显示名读取家族归属的：OpenRouter 为每个条目声明该 id 究竟是哪个带日期的版本，而共享这个带日期身份的条目就是该家族。于是一个列出 `deepseek/deepseek-v4-pro` 的 tier 会自行跟随新版本。

在 `latest` 下，一个指名这些 id 本身的请求同样会被解析，因为模型选择器提供的正是各 tier 列出的 id，在那里选择 `deepseek/deepseek-v4-pro` 指的是 pro 这个模型，而不是它的某一个版本。同一个 tier 的两个配置 id 可能解析到同一个版本，而只有该版本参与排序。每次移动在日志中报告一次——`"deepseek/deepseek-v4-pro" now resolves to "deepseek/deepseek-v4-pro-0813"`——而每个 `model-routing/decision` 事件都记录真正作答的版本。目录读不出来不算路由失败：该 tier 按其配置 id 决策，并由日志说明目录不可用。

解析出的版本只有在内部路由能够调度它时才会被采用。OpenRouter 会在其目录中发布一个版本，早于被固定版本的 `pi-ai` 依赖得知它；而对一个内部路由从未听说过的 id 的请求，会在每一轮都以 `UNKNOWN_MODEL` 失败——这是一个没有任何 reroute 会覆盖的错误，因为该版本的每一个 endpoint 都同样未知。解析出的版本尚不可调度的 tier 会停留在其配置所指名的 id 上，日志报告的是它够不到的那个版本，而不是它做不出的那次移动。

OpenRouter 自己的 `~author/slug-latest` 别名不能替代这一点。它们在 chat-completions 路径上会重定向，但 `/endpoints` 对它们返回空列表，因此指名它们的 tier 没有任何可排序的东西。

同一份缓存的目录读取还会声明每个版本接受哪些输入，而模态过滤器读取的是决策真正参与排序的那个版本：在 `latest` 下，决定一个 tier 能否服务图片请求的是最新快照的声明，因此一个新版本去掉了图片输入的家族，会停止服务图片请求，直到配置固定到一个接受图片的版本。

<a id="ranking"></a>
### 排序

`rankEndpoints` 按每 token 的**混合**价格对候选排序，公式为 `cached · cacheRead + fresh · prompt + output · completion`，因为一次 agent 轮绝大多数是缓存输入，而那些仅按 prompt 看起来最便宜的提供方，往往根本没有公布任何 cache-read 折扣。`preferModel` 把某个模型的 endpoint 排在其他所有模型的 endpoint 之前，同时在该组内部保持价格顺序不变，这正是防止某个失败的提供方在对话中途把一场会话改路由到另一个模型的原因。`rankWithRelaxation` 在正是那个在线率下限导致列表变空时，会在没有该下限的情况下重跑一次，并回报 `relaxedUptime`，让决策日志能说明这一点。

`extraSources` 的候选项按同一公式、由其声明的价格参与排序；直连来源按 `route:id` 而不是仅按其路由 id 被排除：同一条路由可以以同一个 id 服务多个模型的候选，只有这一对才能说明失败的是哪一个。

模态过滤器是唯一按模型而不是按 endpoint 决定的拒绝原因：当请求携带图片时，目录未证明其接受图片的候选模型，其每个 endpoint 都会以 `modality` 被拒绝，而这些 endpoint 仍全部计入 `considered`。放宽不覆盖它——`rankWithRelaxation` 只丢弃在线率下限——因此没有任何可接受图片的候选的 tier 会直接失败，而不会在去掉该要求后重试。

<a id="diagnostics"></a>
### 诊断

每次决策会被记录两次。Session 日志中的 `model-routing/decision` 事件携带读者一眼所需的小型形态：模型与 endpoint、混合价格、据以计算该价格的 token 配比以及该配比是测量自会话还是取自配置、生效中的过滤器、每个拒绝原因淘汰了多少 endpoint，以及每个原因淘汰掉的最便宜的 endpoint。最后这个字段正是仅凭日志就能回答「排在首位的并非最便宜的——更便宜那个去了哪里」的东西。

完整的候选表写入 `diagnosticsPath` 指名的文件：每次决策一行 JSON，包含排序走过的每一个 endpoint 的价格、它的 OpenRouter 折扣、它的各项测量值，以及它的名次或它的拒绝原因。数周前做出的价格决策因此可以对着当时的数据复核，而不是对着一份已经变动的目录。`diagnosticsPath` 为空——即默认值——则完全不写文件。

每一行以 UTF-8 字节为单位、含元数据在内，被限制在 `diagnosticsMaxBytes`（默认 256 KiB）以内：候选按排序次序保留，放不下的就直接缺席，用 `considered` 对照 `candidates.length` 即可看出。若预算连一条记录都放不下，则什么都不写并在每次决策时说明，而不是留下一份悄然残缺的历史。该文件只追加、从不轮转；保留策略由部署自己负责。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

可观察行为已在 [使用本包](#use-this-package) 中完整覆盖。

### 源码地图

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 纯模块的再导出；W4 用插件替换它 |
| `src/config.ts` | tier schema、`readSettings`、`validateSettings`、W0 信任列表 |
| `src/types.ts` | Session 事件、投影状态与视图、`ctx.modelRouting`、报价类型 |
| `src/family.ts` | 依据 `canonical_slug`，一个配置 id 指的是家族中的哪个版本 |
| `src/family-cache.ts` | 整个目录的缓存，以及在读取失败后仍然存在的过期读数 |
| `src/quantization.ts` | 精度等级与 `quantizations` 过滤列表 |
| `src/select.ts` | endpoint 与按模型的拒绝原因、混合价格、排序、在线率放宽 |
| `src/diagnostics.ts` | 一次决策的候选表，以及追加写入的有界 JSONL 文件 |
| `src/projection.ts` | `modelRouting` 投影及其协议视图 |

### 折叠的身份性

`applyModelRoutingEvent` 对每一个它不拥有的事件，以及对那些只是重述它已经掌握的事实的事件（两次 `compaction/end`、两次 `model/selection`），都返回同一个状态引用。注册表按状态身份缓存视图，因此流式会话否则会在每个 token 上重建 composer 芯片。

### 量化等级

`QUANTIZATION_RANK` 按精度给格式分组，而不是给出精确次序：`int4`、`fp4`、`mxfp4` 与 `nvfp4` 同处等级 2，`int8`、`fp8` 与 `mxfp8` 同处等级 4。tier 指名的是一个下限而不是某种格式，因此它不必知道这些名字。`unknown` 根本没有等级：是否接纳它是另一个决定，即 `unknownQuantization`，它的 `'trusted'` 模式会查询 `trustedUnknownProviders`。

</details>

-----

<a id="model-experience"></a>
## 模型体验

无，本包是一个 LLM 路由适配器，不注册任何面向模型的工具。

#### KV Cache 影响

无；本包自己不分发任何东西。消费其排序的路由是 `dsh-experimental-model-routing` 自身的适配器，它为每个 Session 固定一个上游提供方，正是为了确保提供方在轮次之间不发生变化。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 默认的 `trustedUnknownProviders` 列表来自一次对官方作者模型的 30 模型调研（W0 报告）。只提供第三方模型的提供方从未被测量过，因此这类模型上的 `unknown` 只有在其 Host 已经因为别的原因被信任时才会被接纳。
- 排序读取的是实时的 endpoint 列表。从读取到发起请求之间，最便宜的提供方可能失败；适配器的处理方式是在 `failure` 边界重新决策，而不是在这里重新读取。候选连续失败 `excludeAfterFailures` 次（默认 5）后会被停用 `excludeAfterFailureMs`；该候选下一次成功会清零计数，停用期满同样会清零——因此一次偶发失败不会挤走一直在应答的路由，冷却结束归来的路由也不会继续背着当初停用它的那一段计数。请求会重试当前固定的候选，直到计数达到阈值才换人，所以 `maxReroutes` 限制的是候选之间的切换次数，而不是对同一个候选的尝试次数。内容已经开始流式输出之后才到达的失败同样会停用该候选，即使这一次尝试无法重放，重新决策也不会再落到它上面。
- `minQuantization` 是下限而不是证明：一个在受信 Host 上声明 `unknown` 的提供方根本没有声明任何格式，而本包采信该 Host 的说法（计划 §3.2）。
- 在 `snapshotPolicy: 'latest'` 下 tier 会跟随自己的家族，因此一次新发布会改变没有人编辑过的配置背后的模型与价格。目录最多每 `catalogTtlMs` 读取一次，移动会在日志中报告一次并记录进每一次决策，但没有任何东西事先征求同意。必须先批准版本变化的部署应当使用 `pinned`。
- 家族来自目录的 `canonical_slug`，因此只以不带日期的 id 发布的模型——包括所有 OpenRouter 的 `~别名`——没有家族，也永远不会移动。
- 诊断文件只追加、从不轮转。每一行有界，文件本身无界：启用它的部署自行负责其保留策略。
- 直连来源自己声明价格与 `tools` 能力；没有任何东西测量它的 status、uptime 或 quantization，因此这些过滤器对它保持中性。若部署需要其中某一项产生约束，应当把它写进来源的配置，而不是期待测量值出现。
- 只要失败发生在第一个内容分片之前，默认就会 reroute；`noRerouteCodes` 列出的是任何候选都无法服务的例外：`CONTEXT_WINDOW_EXCEEDED`（属于模型窗口，补救办法是压缩）、`IMAGE_OFFLOAD_REQUIRED`（所有路由共享的图片预算）与 `ABORTED`（请求已取消）。因此，分类法从未见过的提供方拒绝默认也会 reroute，代价是对一个处处无效的请求最多多花 `maxReroutes` 次切换到其他候选。

<a id="dev-note"></a>
### 开发备注

无。
