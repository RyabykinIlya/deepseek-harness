---
description: "ctx.web 的免密钥 DuckDuckGo 搜索提供方：部署如何在没有任何 API 密钥的情况下获得可用的 web 搜索，以及这要付出什么代价。"
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-duckduckgo

[English](README.md) | 中文

## 概述

有了 `dsh-web-search-duckduckgo`，harness 无需 API 密钥、无需账号、无需任何凭据即可搜索 web。当部署必须让 `web_search` 可用、却没有任何 DeepSeek、Exa 或 Perplexity 密钥时选择它。该提供方把查询 POST 到 DuckDuckGo 的公开 HTML 端点，并把渲染出的结果块映射为可移植的来源。DuckDuckGo 会限流自动化客户端：它的反机器人系统会以 HTTP 202 质询页回应部分请求，而该情况会解析为空结果集而非失败，因此被限流的搜索返回零来源而不是错误。结果不携带 `content`——端点不生成答案——也不携带发布日期，因为页面没有渲染可靠的日期。面向模型的 `web_search` 工具位于 `dsh-tool-web`。

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

在已加载 web 服务的组合中挂载本提供方；它以 `duckduckgo` 搜索提供方身份注册，因此当它是唯一可用的搜索后端时，`ctx.web.search()` 会自动解析到它——也可以用 `searchProvider: duckduckgo` 固定。

### 何时选择

当不存在搜索凭据、但搜索仍必须可用时，选择此后端。只有当提供方自身的配置不可用时，它才不可用——每次搜索调用都会以结构化错误失败：端点无法解析、`userAgent` 为空白，或 `timeoutMs`、`maxResponseBytes`、`numResults` 不是正数。它是对一个没有任何兼容性承诺的页面的抓取适配器，因此能持有真实 API 密钥的部署仍应优先选择提供方。

### 最小配置

加载 web 服务与本提供方；无需提供密钥，每个字段都有可用默认值。

```yaml
- name: '@deepseek-ai/dsh-web'
- name: '@deepseek-ai/dsh-web-search-duckduckgo'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `endpoint` | `https://html.duckduckgo.com/html/` | 以 `application/x-www-form-urlencoded` POST 查询的 HTML 端点；无法解析时提供方不可用 |
| `userAgent` | Chrome `User-Agent` | 随每次请求发送。DuckDuckGo 会以空的质询页回应一切不像浏览器的请求 |
| `numResults` | （未设置） | 请求不含 `maxResults` 时使用的默认结果数；必须是正整数 |
| `timeoutMs` | `15000` | 请求超时；超时以 `WEB_PROVIDER_ERROR` 失败，而不是取消 |
| `maxResponseBytes` | `1048576` | 本提供方读取响应体的字节上限 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-search-duckduckgo)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 搜索返回什么

每个渲染出的结果块映射为一个 `WebSearchSource`：`result__a` 锚点的 `href` 作为 `url`，其标题在剥离 DuckDuckGo 的 `<b>` 强调并解码 HTML 实体后作为 `title`，紧随其后的 `result__snippet` 锚点作为 `snippet`。没有渲染 snippet 的块仍产出一个不带 snippet 的来源；不是绝对 `http(s)` URL 的目标会被丢弃而不是猜测。重复目标会被丢弃。该端点没有服务端结果数控制，因此请求的 `maxResults`——或已配置的 `numResults` 默认值——在此处生效，裁剪时设置 `truncated`；服务在返回路径上会再次强制执行同一上限。

### 失败与恢复

传输失败、非 2xx 响应或失败的响应体读取会以 `WebError` `WEB_PROVIDER_ERROR` 呈现；调用方自身的取消以 `WEB_ABORTED` 呈现；本提供方自身的时限则以点明超时的 `WEB_PROVIDER_ERROR` 呈现。反机器人质询页不属于以上任何一种：DuckDuckGo 以 HTTP 202 回应，它是 2xx 响应且响应体中没有结果锚点，因此调用以 `sources: []` 解析成功。HTTP 重定向会在访问 `Location` 指向的目标之前被拒绝。调用方根据错误码进行分流；面向模型的 `web_search` 工具会在自己的错误包装层内把失败呈现给模型。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释提供方背后的设计决策；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

该提供方是一个公开 HTML 页面之上的薄适配器，遵循三条刻意规则：

- **质询页是空结果，而不是失败。** DuckDuckGo 的反机器人应答是渲染不出结果的 2xx 响应，因此提供方把它解析为零来源。若改以报错呈现，每次被限流的搜索看起来都像集成坏了，并把部署推向对限流重试，而不是退避。
- **绝不虚构字段。** 缺失的标题或 snippet 会被省略，而不是从 URL 推导；完全不输出发布日期，因为页面没有渲染出可信的日期。
- **限制读取量。** 响应体在字节上限内读取，因此质询页或超大文档无法让进程内存无限增长。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置 schema、常量默认值、提供方注册 |
| [`src/provider.ts`](src/provider.ts) | `DuckDuckGoSearchProvider`：请求分发、响应体上限、中止分类、结果映射 |
| [`src/types.ts`](src/types.ts) | 协议词汇：一个结果块被解析成的 `DuckDuckGoResultLink` 片段 |
| — | 不发布运行时不不变配套入口；除所属 seam 强制执行的约定外，本包没有独立的事件序列或可变数据关系。 |

### 请求与映射流程

`search()` 以 `redirect: 'error'` 把查询作为表单字段 POST 到 `endpoint`，因此重定向会在不接触目标的情况下使请求失败。响应体通过受字节上限约束的流读取器读入，随后按文档顺序定位 `result__a` 锚点；每个块的 snippet 是紧随其后、下一个标题之前的 `result__snippet` 锚点，因此没有渲染 snippet 的块绝不会借用邻居的文本。标题与 snippet 会先被归约为纯文本——标签变空格，随后解码实体，最后折叠空白——再进行映射。由调用方信号引起的中止变为 `WEB_ABORTED`；由本提供方自身时限引起的中止，以及其余所有失败，都变为 `WEB_PROVIDER_ERROR`。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从共享词汇逐步进入服务、面向模型的工具与设计依据。

- [web 子系统](../../../docs/subsystems/web.zh.md)——穷尽式的搜索请求／结果词汇与错误码。
- [web 包映射](../README.zh.md)——搜索与抓取提供方家族及各角色。
- [dsh-web](../web/README.zh.md)——本提供方注册进入的 web 服务。
- [dsh-tool-web](../tool-web/README.zh.md)——渲染本提供方来源的面向模型 `web_search` 工具。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-search-duckduckgo)——每个受支持配置字段及其源声明。
- [web 能力 seam 决策](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.zh.md)——搜索与抓取为何共用一项提供方选择服务。

-----

<a id="model-experience"></a>
## 模型体验

### 间接的对话工具结果

#### 模型看到什么

经由 `dsh-tool-web`，对话模型看到本提供方经 `maxResults` 限制的 URL、标题与 snippet，可作为引用来源。DuckDuckGo 不生成答案，因此不会向上下文注入提供方自己的叙述。搜索失败时，会在消费方的错误包装层内保留本提供方的原样消息——`DuckDuckGo search aborted`、`DuckDuckGo search timed out after <ms>ms`、`DuckDuckGo search request failed: <error>` 或 `DuckDuckGo search failed (HTTP <status>)`。被限流的搜索会以「调用成功但没有来源」的形式抵达模型，而不是以错误的形式。

#### Token 影响

对对话 token 的直接影响为零：本包不注册提示词段、不注册工具 schema、不产生 Session 事件。结果 token 随模型实际读取的来源数量增长，而 seam 会在结果进入工具结果之前应用请求的 `maxResults`。

#### KV Cache 影响

仅追加。新出现的搜索结果沿用可复用的请求前缀，不会使既有 KV Cache 条目失效；该前缀由 `dsh-tool-web` 负责。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明提供方在哪些情况下不合适。它们是当前包约束。

- **限流是静默的**——反机器人质询页会解析为 `sources: []`，因此被限流的部署无法区分「没有结果」与「被拦截」。只有 `WEB_PROVIDER_ERROR` 会作为失败浮现。
- **该端点没有兼容性承诺**——它是一个没有 API 契约、没有限流文档、没有服务等级的公开 HTML 页面。本包解析的正是它的标记，因此一次未公告的改版会损失结果而不是报错。
- **默认 `userAgent` 是浏览器身份**——这是仓库中唯一一处请求不以产品身份出现的地方，因为端点对其他任何身份都不返回结果。反对这一做法的部署可以显式设置 `userAgent`，并接受空结果。
- **只公开 `endpoint`／`userAgent`／`numResults`／`timeoutMs`／`maxResponseBytes`**——端点自身的参数（`kl` 区域、`df` 日期过滤条件、超时、安全搜索）等待提供方无关的服务字段（见 [seam Agent Note](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.zh.md)）。
- **中止分类按信号状态区分调用方与时限**——不设置调用方信号的自定义中止原因会被报告为 `WEB_PROVIDER_ERROR`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放问题与尚未决定的探索方向。它明确不具权威性——已交付的行为、限制与既定理由以上文和相关 Agent Note 为准。

#### 未来：跨免密钥端点的回退

撰写时，DuckDuckGo 是唯一标记可用的免密钥来源；其余无需密钥即可触达的替代方案要么不可达、要么被地域屏蔽、要么返回不了可用内容。需要冗余的部署要么接入第二个免密钥来源，要么持有真实密钥，而本包刻意只负责其中一个。

#### 未来：区分被限流的搜索与空结果

把两者都解析为 `sources: []` 让工具调用保持成功，但也把失败对模型隐藏了。要把它浮现出来需要 seam 上新增一个字段，因此它与端点自身的参数一样，等待同一套提供方无关的请求／结果词汇。

</details>
