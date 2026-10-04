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

-----

<a id="use-this-package"></a>
## 使用本包

通过 `model-routing` 组合包挂载本包；该组合包还会加载为 `tiers` LLM 路由服务的适配器以及浏览器侧的设置页。只有当调用方已经持有 tier 配置、并需要同样的排序或同样的投影状态时，本包单独使用才有价值。

### 何时选择它

当某个 tier 的模型必须按*下一次 agent 轮次*的成本、而不是按逐 token 标价来排序时，或者当 Session 日志必须能回答它的上一次路由决策选中了哪个模型、哪个提供方、哪种量化时，选择它。当排序必须仅凭一份记录下来的列表即可复现时，请不要选择它：这里的价格全部实时读自 OpenRouter 的 `/endpoints`，本包自己从不缓存它们。

<a id="tiers"></a>
### tier

tier 是一组命名的可互换模型，外加每个服务于其中某个模型的 endpoint 都必须通过的过滤器：`minQuantization`、`unknownQuantization`、`free`，以及该 tier 公布的 `contextWindow`。`validateSettings` 会拒绝该路由无法据以行动的 settings 值，包括不是路由模型 id 的 tier 名称、缺少 `author/` 的模型 id、落在 effort 列表之外的默认 effort、以及一对次序颠倒的 judge 阈值；它用一条消息指出第一个无法服务的字段。

<a id="ranking"></a>
### 排序

`rankEndpoints` 按每 token 的**混合**价格对候选排序，公式为 `cached · cacheRead + fresh · prompt + output · completion`，因为一次 agent 轮绝大多数是缓存输入，而那些仅按 prompt 看起来最便宜的提供方，往往根本没有公布任何 cache-read 折扣。`preferModel` 把某个模型的 endpoint 排在其他所有模型的 endpoint 之前，同时在该组内部保持价格顺序不变，这正是防止某个失败的提供方在对话中途把一场会话改路由到另一个模型的原因。`rankWithRelaxation` 在正是那个在线率下限导致列表变空时，会在没有该下限的情况下重跑一次，并回报 `relaxedUptime`，让决策日志能说明这一点。

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
| `src/quantization.ts` | 精度等级与 `quantizations` 过滤列表 |
| `src/select.ts` | endpoint 拒绝原因、混合价格、排序、在线率放宽 |
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
- 排序读取的是实时的 endpoint 列表。从读取到发起请求之间，最便宜的提供方可能失败；适配器的处理方式是在 `failure` 边界重新决策，而不是在这里重新读取。
- `minQuantization` 是下限而不是证明：一个在受信 Host 上声明 `unknown` 的提供方根本没有声明任何格式，而本包采信该 Host 的说法（计划 §3.2）。

-----

<a id="dev-note"></a>
## 开发备注

无。
