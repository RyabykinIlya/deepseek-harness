---
description: "ctx.web 的 Brave Search 提供方：部署方如何挂载需要凭据的 Brave 搜索，实现逐次搜索解析令牌与以证据为准的可用性判定。"
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-brave

[English](README.md) | 中文

## 概述

有了 `dsh-web-search-brave`，harness 可以通过 Brave Search 搜索 web，获得带可移植 snippet 与页面时间字符串的厂商原生结果。当部署持有 Brave 订阅令牌、并希望使用专用检索端点而非一次模型回合时选择它。Brave 不返回生成答案，因此结果不携带 `content`——只产出可引用的来源。每次请求只用一个请求头携带凭据，提供方对象上不保存任何密钥。缺少令牌会让调用以结构化错误失败；响应中可选字段缺失时搜索仍能正常解析。面向模型的 `web_search` 工具位于 `dsh-tool-web`。

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

在已加载 web 服务的组合中挂载本提供方；它以 `brave` 搜索提供方身份注册，因此当它是唯一可用的搜索后端时，`ctx.web.search()` 会自动解析到它——也可以用 `searchProvider: brave` 固定。

### 何时选择

当部署持有 Brave Search 订阅令牌，并希望使用 Brave 索引、获得每项结果的描述 snippet 与页面时间字符串，且按请求计费而非按模型 token 计费时，选择此后端。没有令牌时不要选择：此时提供方不可用，每次搜索都会以结构化错误失败。

### 最小配置

加载 web 服务与本提供方。令牌在挂载了 `ctx.credentials` 时从该服务解析，否则从进程环境解析；其余设置都有安全默认值。

```yaml
- name: '@deepseek-ai/dsh-web'
- name: '@deepseek-ai/dsh-web-search-brave'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `apiKey` | （未设置） | 字面量形式的 Brave 订阅令牌；优先使用 `apiKeyEnv`，避免密钥进入配置文件。非空字面量优先于 `apiKeyEnv` |
| `apiKeyEnv` | `BRAVE_API_KEY` | 每次搜索通过 `ctx.credentials` 解析的凭据引用；缺少该服务时从进程环境解析。本包只保存引用，不保存取值 |
| `baseURL` | `https://api.search.brave.com` | Brave API 基址；追加 `/res/v1/web/search`。无法解析时提供方不可用 |
| `maxResults` | `8` | 请求未携带 `maxResults` 时作为 Brave `count` 发送的结果数，必须为正整数；与 `web_search` 工具使用的同一上限 |
| `timeoutMs` | `15000` | 请求超时，必须为正整数；这是本提供方自己的截止时间，与调用方的取消信号合并 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-search-brave)是每个受支持字段及其 JSDoc 的穷尽式真源。

<a id="authentication"></a>
### 鉴权

每次搜索只通过一个请求头发送解析出的令牌，即 `X-Subscription-Token`，而不是 `Authorization`。非空字面量 `apiKey` 优先；否则 `apiKeyEnv` 逐次搜索通过 `ctx.credentials` 解析，因此在设置页面中存入或轮换的令牌无需重启即可到达下一次搜索。没有凭据服务时，启动环境就是整个凭据平面，其中的空值不算令牌。没有解析到令牌时以 `WEB_PROVIDER_CREDENTIAL_MISSING` 失败，并指明引用名与可以存入令牌的位置。

### 可用性以证据为准

`available()` 是同步判定，而凭据存储不是，因此本包记录凭据平面最近一次报告的结果，而不是假定令牌存在。当配置了字面量 `apiKey`，或当前小节引用的凭据被观测为已配置时，提供方可用。插件在加载时探测一次，并在每次涉及该引用的 `credentials/reference-updated` 事件后再次探测；一条观测只对它所描述的引用有效，因此重命名 `apiKeyEnv` 会使旧观测失效。解析到令牌的搜索同样会记录它。在这些观测到达之前，提供方报告不可用，而不是声称持有一个从未见过的令牌——这与 DeepSeek 提供方形成刻意的对比，后者只要存在解析函数就报告可用。

### 搜索返回什么

每项 Brave web 结果映射为 `WebSearchSource`：`url`、`title`、`description` 作为 `snippet`、`page_age` 作为 `publishedAt`；缺失或为空的可选字段被省略而不是补默认值，没有可用 URL 的条目被丢弃。重复 URL 会被丢弃（保留首个）。Brave 对无匹配的查询返回空的 `web.results`，在没有 web 垂直结果时省略 `web`；两者都解析为 `sources: []` 而不是失败。请求的 `maxResults` 优先于配置的默认 `maxResults`，并作为 `count` 发送，且被限制在 Brave 文档给出的 1–20 区间内——最终上限由服务强制执行：截断并标记。Brave 不返回生成答案，因此结果不携带 `content`。

### 失败与恢复

提供方失败——HTTP 错误、网络失败、超时、无法解析的响应体——以 `WebError` `WEB_PROVIDER_ERROR` 呈现；调用方取消以 `WEB_ABORTED` 呈现；缺少令牌以 `WEB_PROVIDER_CREDENTIAL_MISSING` 呈现。非 2xx 响应会把 HTTP 状态、Brave 的 `error.detail` 与 Brave 的 `error.code` 一并带入消息：鉴权失败以 HTTP 422 加 `SUBSCRIPTION_TOKEN_INVALID` 到达，本包原样报告 Brave 的说法，而不是重新归类状态码。HTTP 重定向会在访问 `Location` 指向的目标之前被拒绝。分发之后的失败会指明解析出的端点，并声明只有用户可以更改它。调用方根据错误码进行分流；面向模型的 `web_search` 工具会在自己的错误包装层内把失败呈现给模型。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释提供方背后的设计决策；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

该提供方是 Brave web 端点之上的薄适配器，遵循三条刻意的规则：

- **不虚构事实。** 来源的 `snippet` 只来自 Brave 的 `description`，`publishedAt` 只来自 `page_age`；不用其他字段合成任何内容，没有 URL 的条目宁可直接丢弃也不引用。
- **防御式解析。** 实际返回中 `web`、`web.results` 以及每个结果字段都可能是可选的：Brave 未返回的垂直结果、不是数组的 `results` 字段、缺失的 `description`，都会解析为空的或缩减后的来源集合，而不是失败的搜索。
- **诚实的可用性。** 只有确实能观测到密钥时才选中提供方。当同类提供方无法查询其异步凭据存储并假定密钥存在时，本包改为记录观测结果，并在观测到达之前如实报告。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置 schema、设置命名空间、凭据观测、提供方注册 |
| [`src/provider.ts`](src/provider.ts) | `BraveSearchProvider`：请求分发、截止时间合并、中止分类、结果与错误映射 |
| [`src/types.ts`](src/types.ts) | Brave 协议类型：`BraveSearchResponse`、`BraveWebResult`、`BraveErrorResponse` |
| — | 不发布运行时不变量配套入口；除所属 seam 强制执行的约定外，本包没有独立的事件序列或可变数据关系。 |

### 请求与映射流程

每次搜索都会把当前 Config 的取值捕获为提供方选项——端点、结果上限、超时、凭据引用——为该快照解析一次令牌，然后在合并了调用方取消与本提供方自身截止时间的信号下分发 `GET {baseURL}/res/v1/web/search?q=<query>&count=<count>`，并带上 `redirect: 'error'`，因此重定向会在不接触目标的情况下使请求失败，挂起的请求也不会超过 `timeoutMs`。解析出的 `web.results[]` 逐项映射、按 URL 去重，服务在返回路径上应用最终的 `maxResults` 上限。中止按形状分类：调用方已中止的信号无论携带什么都算 `WEB_ABORTED`；没有调用方取消时的 `TimeoutError` 是本提供方的截止时间；无法解释的 `AbortError` 是取消而不是提供方故障。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从共享词汇逐步进入服务、面向模型的工具与设计依据。

- [web 子系统](../../../docs/subsystems/web.zh.md)——穷尽式的搜索请求／结果词汇与错误码。
- [web 包映射](../README.zh.md)——提供方家族与各角色。
- [dsh-web](../web/README.zh.md)——本提供方注册进入的 web 服务。
- [dsh-tool-web](../tool-web/README.zh.md)——渲染本提供方来源的面向模型 `web_search` 工具。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-search-brave)——每个受支持配置字段及其源声明。
- [web 能力 seam 决策](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.zh.md)——搜索与抓取为何共用一项提供方选择服务。

-----

<a id="model-experience"></a>
## 模型体验

### 对话工具结果（间接）

#### 模型看到什么

通过 `dsh-tool-web`，对话模型把本提供方经 `maxResults` 限制的 URL、标题、`description` snippet 与 `page_age` 字符串当作可引用来源看到。Brave 不生成答案，因此没有任何提供方文本进入上下文。搜索失败时，本提供方的原样消息会在消费方的错误包装层内呈现——`Brave search aborted`、`Brave search timed out after <timeoutMs>ms`、`Brave search request failed: <error>`、`Brave search credential resolution failed: <error>`、`Brave Search returned an unprocessable response body: <error>` 或 `Brave search has no API key for "<reference>"`——每个 HTTP 失败还会附带 Brave 被请求的端点，以及只有用户才能更改它的指示。

#### Token 影响

不产生直接的对话 token：本包不注册提示词片段、不注册工具 schema，也不注册 Session 事件。结果 token 随模型阅读的来源数量增长，而 seam 会在结果进入工具结果之前应用请求的 `maxResults`。

#### KV Cache 影响

仅追加。新的搜索结果跟在可复用的请求前缀之后，不会使既有 KV Cache 条目失效；该前缀由 `dsh-tool-web` 拥有。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明提供方在哪些情况下不可用或不完整。它们是当前包约束。

- **可用性要等首次观测**——挂载了凭据服务时，在加载时探测落定之前发起的搜索会以不可用被拒绝，即使令牌已存放。这是不声称持有未见过的令牌所付出的代价；探测在加载后一个 tick 内落定，之后每次变更都会刷新。
- **无法读取的凭据存储报告不可用**——失败的 `describe` 不构成令牌存在的证据，因此提供方保持不被选中，而不是猜测。下一次探测或下一次存入变更会给出结论。
- **成功形态来自 Brave 文档，而非观察到的响应**——本包在没有订阅令牌的情况下编写并测试。失败信封（HTTP 422、`SUBSCRIPTION_TOKEN_INVALID`）是实际观察到的；成功的响应没有，因此解析器接受缺失的 `web`、缺失的 `results` 与缺失的结果字段，而不依赖它们的存在。
- **只请求 `web` 垂直结果**——Brave 的新闻、图片等其他垂直结果既不请求也不映射，`safesearch`、国家、时效与偏移等控制项在 seam 具备提供方无关字段之前保持不公开。
- **不配合的凭据解析器会被等待**——永不落定的凭据后端会让那一次搜索越过取消继续挂起；seam 自身的协作式预算仍会结束外层工具调用。
- **引用名不符合凭据语法的小节会在搜索时失败**——凭据语法由凭据 seam 拥有，因此无效的 `apiKeyEnv` 抛出它自己的 `TypeError` 而不是 `WebError`，与 DeepSeek 提供方一致。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放问题与尚未决定的探索方向。它明确不具权威性——已交付的行为、限制与既定理由以上文和相关 Agent Note 为准。

#### 开放问题：一次真实的端到端确认

编写本包时没有可用的 Brave 订阅令牌，因此没有从该端点观察到成功的响应。发布前应做一次真实搜索，确认文档所述的信封，以及 Brave 是否会向本产品支持的每个区域返回结果；区域性限制会表现为空的 `web.results` 集合而不是错误。

#### 未来：更宽的 Brave 控制面

国家、时效、safesearch 与偏移控制在协议上存在，但仍未公开。公开它们需要先有提供方无关的 seam 字段，让提供方家族以一个协调一致的控制项、而非厂商专有参数的方式新增。

</details>
