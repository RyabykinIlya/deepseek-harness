---
description: "ctx.web 的 Tavily 搜索提供方：部署方如何挂载 Tavily web 搜索，并让设置页写入凭据。"
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-tavily

[English](README.md) | 中文

## 概述

有了 `dsh-web-search-tavily`，harness 可以通过 Tavily 搜索 web，获得页面抽取文本且已被限制为 snippet 长度的结果。当部署持有 Tavily API 密钥、并希望密钥由 Web 设置页写入而非在 shell 中导出时选择它。除非显式请求，否则 Tavily 不返回答案，而本提供方从不请求，因此只有在响应恰好带来答案时结果才会携带 `content`。面向模型的 `web_search` 工具位于 `dsh-tool-web`。

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

在已加载 web 服务的组合中挂载本提供方；它以 `tavily` 搜索提供方身份注册，因此当它是唯一可用的搜索后端时，`ctx.web.search()` 会自动解析到它——也可以用 `searchProvider: tavily` 固定。

### 何时选择

当部署持有 Tavily API 密钥，并希望结果自带页面抽取文本、且已被限制长度以免单个冗长页面塞满模型上下文时，选择此后端。当没有密钥可以解析、或端点无法解析时，提供方不可用——seam 会报 `WEB_PROVIDER_CONFIGURED_UNAVAILABLE` 或 `WEB_PROVIDER_UNAVAILABLE`，而不是发出注定失败的请求。

### 最小配置

加载 web 服务与本提供方；密钥优先通过 credentials 服务解析，并回退到启动环境中的 `$TAVILY_API_KEY`，其余设置都有安全默认值。

```yaml
- name: '@deepseek-ai/dsh-web'
- name: '@deepseek-ai/dsh-web-search-tavily'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `apiKey` | （未设置） | 字面量 Tavily API 密钥；建议用 `apiKeyEnv`，避免密钥进入配置文件 |
| `apiKeyEnv` | `TAVILY_API_KEY` | 每次搜索解析一次的凭据引用；超出引用语法的名称会让提供方不可用 |
| `baseURL` | `https://api.tavily.com/search` | 完整搜索端点，**包含路径**——不会向其追加任何路径。无法解析时提供方不可用 |
| `numResults` | `5` | 搜索未自带 `maxResults` 时请求的结果数；必须是正整数 |
| `timeoutMs` | `15000` | 请求超时，同时作用于凭据解析、请求分发与响应体读取 |
| `maxContentChars` | `2000` | 单条结果 snippet 的字符上限；必须是正整数 |

生成的[配置目录](../../../docs/config-catalog.zh.md)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 密钥如何写入

本提供方的设置节以命名空间 `web-search-tavily` 提供，Web 设置页为该提供方登记的也是这个名字。该页面通过 credentials 服务写入密钥——字面量不会随任何响应下发——因此部署无需在启动环境中放置 `TAVILY_API_KEY`。

`available()` 的依据是一次真正完成的凭据解析，而不是某个解析器的存在：没有密钥可发时提供方报告自身不可用，一旦有密钥解析成功即变为可用。启动环境是同步读取的，因此导出密钥的组合在挂载瞬间即可使用。

### 搜索返回什么

每项 Tavily 结果映射为 `WebSearchSource`：`url`、存在时的 `title`，以及作为 `snippet` 的页面抽取文本——后者被裁剪到 `maxContentChars`，切在词边界上并以 `…` 结尾，使被限制的 snippet 读起来像片段而非全文。结果保持 Tavily 自身的顺序；没有 URL 的来源被丢弃，重复的 URL 在首次之后被丢弃。Tavily 的相关性 `score` 不做映射——seam 没有承载它的字段，按它重新排序会是本提供方的猜测，而不是 Tavily 的排序。请求的 `maxResults` 优先于已配置的默认 `numResults`，并作为成本与延迟优化发送；最终上限由服务强制执行：截断并标记。

### 失败与恢复

提供方失败——HTTP 错误、网络失败、响应体无法解析——以 `WebError` `WEB_PROVIDER_ERROR` 呈现；中止请求以 `WEB_ABORTED` 呈现。HTTP 重定向会在访问 `Location` 指向的目标之前被拒绝，并以 `WEB_PROVIDER_ERROR` 呈现。HTTP 401 会带上 Tavily 自己的消息，本端点把它放在 `detail.error` 而不是顶层 `error`；该消息随后指出需要修复的凭据引用，而非端点。调用方根据错误码进行分流；面向模型的 `web_search` 工具会在自己的错误包装层内把失败呈现给模型。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释提供方背后的设计决策；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

该提供方是 Tavily API 之上的薄适配器，遵循三条刻意的规则：

- **限制厂商为读者写下的内容。** Tavily 的 `content` 是整页抽取文本；在成为 `snippet` 之前会被裁剪到 `maxContentChars` 并加上省略号，因此单个冗长页面无法主导上下文。
- **不映射 seam 承载不了的东西。** `WebSearchSource` 没有 `score` 字段，因此直接丢弃，而不是把它塞进标题或 snippet。
- **绝不宣传不存在的密钥。** 可用性来自一次已完成的解析，因此 seam 会拒绝分发，而不是花一次往返去发一个只会被拒绝的请求。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置 schema、凭据解析、可用性判定、提供方注册 |
| [`src/provider.ts`](src/provider.ts) | `TavilySearchProvider`：请求分发、中止分类、结果映射 |
| [`src/types.ts`](src/types.ts) | Tavily 协议类型：`TavilySearchRequest`、`TavilySearchResponse`、`TavilyResult`、`TavilyError` |
| — | 不发布运行时不变量配套入口；除所属 seam 强制执行的约定外，本包没有独立的事件序列或可变数据关系。 |

### 请求与映射流程

`search()` 先快照一份设置节，在由调用方信号与配置超时共同构成的截止信号下解析密钥，然后以 `redirect: 'error'` 与 `Authorization: Bearer` 请求头，把 `{"query", "max_results"}` POST 到该端点，因此重定向会在不接触目标的情况下使请求失败。解析后的 `results[]` 逐项映射，没有 URL 的条目被丢弃，服务在返回路径上应用最终的 `maxResults` 上限。调用方要求的中止变为 `WEB_ABORTED`；本提供方自己的截止信号，以及报告同一情况的传输层超时，变为 `WEB_PROVIDER_ERROR`；其余失败同样是 `WEB_PROVIDER_ERROR`。

### 哪些经过观察，哪些没有

请求形状——`POST`、绝对的 `/search` 路径、`Authorization: Bearer`、由 `query` 与 `max_results` 组成的 JSON 请求体——以及把消息放在 `detail.error` 的 HTTP 401 响应体，均已对真实端点确认。成功响应信封（包括 `content`、`answer`、`score` 以及可能缺失或为空的 `results`）来自 Tavily 的公开文档；本包从未与该 API 完成过一次成功搜索，因为手上没有可用于交换的密钥。`tests/` 下的用例全程 mock `fetch`，不访问任何网络。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从共享词汇逐步进入服务、面向模型的工具与设计依据。

- [web 子系统](../../../docs/subsystems/web.zh.md)——穷尽式的搜索请求／结果词汇与错误码。
- [web 包映射](../README.zh.md)——本家族与各角色。
- [dsh-web](../web/README.zh.md)——本提供方注册进入的 web 服务。
- [dsh-tool-web](../tool-web/README.zh.md)——渲染本提供方来源的面向模型 `web_search` 工具。
- [生成配置目录](../../../docs/config-catalog.zh.md)——每个受支持配置字段及其源声明。
- [web 能力 seam 决策](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.zh.md)——搜索与抓取为何共用一项提供方选择服务。

-----

<a id="model-experience"></a>
## 模型体验

### 间接：进入对话工具结果

#### 模型看到什么

通过 `dsh-tool-web`，对话模型按 Tavily 自身的排序看到去重后的 URL、标题与受长度限制的 snippet。一个被 `maxContentChars` 裁剪过的 snippet 以 `…` 结尾，因此模型能看出自己拿到的文本是片段而非整页。本提供方的原样错误消息包括 `Tavily search aborted`、`Tavily search timed out after <ms>`、`Tavily search credential resolution failed: <error>`、`Tavily search request failed: <error>` 和 `Tavily returned an unprocessable response body: <error>`。HTTP 401 会附上 Tavily 自己的消息——从 `detail.error` 读出，那才是该端点真正放置消息的位置——随后是指引用户为所命名的引用存入可用密钥的说明，而绝不建议更换端点。缺失或为空的 `results` 会以一次没有来源的成功调用抵达模型，而不是以错误抵达。错误包装层由消费方拥有。

#### Token 影响

注册本身不产生任何对话 token。结果 token 随返回的来源及其受长度限制的 snippet 增长——正是这个上限阻止单个冗长页面主导它们——随后服务再强制执行请求的来源上限。

#### KV Cache 影响

仅追加；新可见内容跟在可复用的请求前缀之后，不会使既有 KV Cache 条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明提供方在哪些情况下不合适。它们是当前包约束。

- **没有 URL 的来源会被丢弃**——模型无从引用，因此返回的来源可能少于请求数量。
- **snippet 只被裁剪，绝不被摘要**——省略号标记了裁剪点，但 `maxContentChars` 之后的文本就是不存在。
- **只公开 `baseURL`／`numResults`／`timeoutMs`／`maxContentChars`**——Tavily 的其他控制项（搜索深度、topic、时间范围、域名过滤、include-answer、raw content）等待提供方无关的服务字段（见 [seam Agent Note](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.zh.md)）。
- **存入的密钥对 `available()` 的可见性是异步的**——credentials seam 在 promise 中作答，因此设置页写入密钥后，提供方可能短暂地仍报告自身不可用，直到该答案落定；启动环境与字面量密钥两条路径是同步的，从不等待。
- **中止分类依据信号形状**——只有已触发的截止信号、已触发的调用方信号，或传输层 `TimeoutError` 才被视为取消；无人请求的中止会呈现为该阶段的普通失败，而不是被谎称为超时。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放问题与尚未决定的探索方向。它明确不具权威性——已交付的行为、限制与既定理由以上文和相关 Agent Note 为准。

#### 未来：更宽的 Tavily 控制面

Tavily 的 topic、时间范围、域名过滤、搜索深度与 raw content 控制项仍未公开。公开它们需要先有提供方无关的服务字段，让家族以一个协调一致的控制项、而非厂商专有参数的方式新增。

#### 开放：针对真实 API 的端到端校验

关于本包请求与错误处理的每一条陈述都由 mock 测试加上那一次观察到的 HTTP 401 证明。真实搜索从未完成过，因此本包据以编码的成功信封来自文档而非观察。第一个拿到多余密钥的人应当确认它；若信封不同，先修正 `src/types.ts`，再改其他任何地方。

</details>
