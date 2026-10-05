---
description: "The tiers model route, its settings page, and the composer chip in one experimental bundle."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-model-routing-profile

[English](README.md) | 中文

## 概述

`dsh-experimental-model-routing-profile` 是 `tiers` 模型路由的可安装组合包：它插入注册该路由与 `modelRouting` 服务的 Host 插件，以及渲染 composer 芯片与设置页的浏览器包。它不携带任何配置，因此该路由保持休眠：模型列表为空、没有决策、没有花费，直到有人指名自己愿意付费的 tier。它以实验性名称发布，不承诺稳定性。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

通过 Host 的插件管理器安装该组合包，插件页的安装操作调用的正是它：`ctx.pluginManager.installBundle('/abs/path/to/packages/experimental/model-routing-profile')`。本仓库没有 `dsh plugin install-bundle` 这个 CLI 动词；安装是一个 Host 服务方法，而不是一条命令，因此 headless 安装走的是同一个服务。

只安装该组合包本身不会改变任何可观察的行为。在 `model-routing` 命名空间列出一个 tier 之前，该路由不公布任何模型，设置页也没有任何可编辑的内容。

<a id="configure"></a>
### 配置 tier

这些 tier 位于 `model-routing` settings 命名空间中，在 profile patch 里写作该组合包自身那一行的 `config:`。patch 行的 `config:` 是**整体替换**该行的配置对象，而不是合入，所以该行需要的每个键都必须在这段里出现。

```yaml
- id: model-routing
  name: '@deepseek-ai/dsh-experimental-model-routing'
  config:
    tiers:
      - { name: pro, label: Pro, models: [deepseek/deepseek-v4-pro, z-ai/glm-5.3], contextWindow: 1000000, maxTokens: 32768, input: [text], minQuantization: fp8, unknownQuantization: reject, free: 'off' }
      - { name: flash, label: Flash, models: [deepseek/deepseek-v4-flash, z-ai/glm-5.3-flash, stealth/space-bunny-alpha], contextWindow: 1000000, maxTokens: 32768, input: [text], minQuantization: fp8, unknownQuantization: trusted, free: prefer }
    # Providers this deployment trusts without a published quantization.
    trustedUnknownProviders: [stealth]
    judgeModel: typesafe/jev-1.13
    presetRoutes:
      - { preset: project, model: pro }
- id: threads-preset
  config:
    id: project
    workerId: project-thread
    provider: thread
    basePreset: standard
    workerMaxDepth: 2
    checkIn: milestones
    spawn: ask
    mergePolicy: ask
    tools:
      defaultLimit: 20
      maxLimit: 100
    threadProvider: tiers
    threadModel: flash
    threadReasoningEffort: high
    threadMaxTokens: 32768
    threadModels:
      - { provider: tiers, model: flash }
      - { provider: tiers, model: pro }
    tierContract: tiers
```

第二行属于另一个组合包 `dsh-experimental-threads-preset`。它的 patch id 是 `threads-preset` —— 即该组合包插入的行 id，而不是其 `config.id` 所带的 `project` 预设 id；指向 `project` 的 patch 匹配不到任何行，加载器会警告并跳过。因为 `config:` 是整体替换，该行除四个路由键外还要重写 `dsh-experimental-threads-profile` 随包发出的预设键。只安装本组合包会让这一块保持惰性；把两者都安装，才会让 Project 协调者以 `tiers/pro` 启动。

`input` 声明每个 tier 对外公布什么，而决策会依据 OpenRouter 模型目录按模型强制执行它。因此上文的 `input: [text]` 只服务文本请求。要服务图片，请在 tier 上声明 `image`，并列出目录中证明接受图片输入的模型；声明了 `image` 却没有这样模型的 tier，会让图片请求以 `MODEL_ROUTING_NO_ENDPOINT` 失败。

<a id="credential"></a>
### 存储 OpenRouter 凭据

该路由用 `apiKeyRef` 指名的凭据读取 Decisions API 与免费额度 endpoint（默认为 `OPENROUTER_API_KEY`）。通过凭据服务存储它，Web 的模型页会写入它；也可以在 Host 启动前把它导出。没有它时该路由仍然服务请求，只有 judge 与免费额度计数器回退到各自的默认值。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

可观察行为已在 [使用本包](#use-this-package) 中完整覆盖。

### patch 文档

`cordis.patch.yml` 恰好插入两个顶层行，并且不重指向任何东西：Host 路由与浏览器半侧。已经自带一个 `model-routing` 行的部署会在加载时得到重复 id 失败，这正是有意为之的响亮结果：两个路由插件不能同时拥有 `tiers`。

### 组合包为何不携带配置

一份 tier 列表是一次花钱的决定。该路由的设计目标是安装它不花任何代价：没有 tier 就没有公布的模型、没有做出的决策，也没有经它分发的请求。把一份默认 tier 列表放进组合包，会让每位安装者的第一次 OpenRouter 请求都变成付费请求，而且由写这个组合包的人替他选定。

</details>

-----

<a id="model-experience"></a>
## 模型体验

无，本组合包只插入 model-routing 的各行，不注册任何属于自己的模型面。

#### KV Cache 影响

无；本组合包不携带任何配置，也不分发任何东西。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 尚未编写一个在本组合包的各行与一条 `openrouter` 路由之上启动真实 Loader 的验证流程；组合包测试覆盖的是 patch 文档与配置片段，而不是一次真实组合。它属于计划 §18 中的手工验收。
- 本组合包不安装 `llm-pi-ai`，因此缺少它的 profile 会挂载该路由，随后以 `NO_ADAPTER` 拒绝每一个请求。Web profile 已经自带它；headless profile 必须显式添加。
- `judgeModel` 固定为 `typesafe/jev-1.13`。更新的 decisions model 会把校准过的阈值移出它们的校准区间，因此升级它是一次有意为之的动作，而不是随别名更新的默认值。

<a id="dev-note"></a>
### 开发备注

无。
