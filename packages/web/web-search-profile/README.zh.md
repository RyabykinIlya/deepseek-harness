---
description: "无密钥的搜索默认值、两个带密钥的搜索提供者，以及透明代理抓取范围，合成一个 profile 层。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-web-search-profile

[English](README.md) | 中文

## 概述

`dsh-web-search-profile` 是一个可安装的组合包，承载没有 DeepSeek 凭据的部署所需的 web 搜索与抓取行：它把 `web` 行改指到无密钥的 `duckduckgo` 提供者，挂载 Brave 与 Tavily 两个提供者供已存有密钥的部署使用，并声明透明代理主机抓取所需的 `198.18.0.0/15` 范围。profile 在 `@deepseek-ai/dsh-base` 之后列出它，后者提供它改写的每一行。默认不挂载任何内容，因此在 profile 指名它之前该层是惰性的。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 安装到 profile

该组合包是一个 workspace 包，因此 profile 像添加任何其他组合包一样添加它：

```sh
dsh plugin --profile web add @deepseek-ai/dsh-web-search-profile
```

在本仓库中，profile 从检出目录而非注册表解析它，因此源码启动的 profile 改为链接该包目录：

```json
{
  "dependencies": {
    "@deepseek-ai/dsh-web-search-profile": "link:/abs/path/to/packages/web/web-search-profile"
  }
}
```

把该组合包加入 `dsh.profile.bundles` 时，位置要在 `@deepseek-ai/dsh-base` **之后**。组合包层按列表顺序应用，后一层按行取胜，因此这里的 `web` 改写胜过 base 层的 `deepseek-official` 默认值。用 `dsh plugin --profile <name> remove @deepseek-ai/dsh-web-search-profile` 移除它即可恢复 base 组合。

### 得到什么

该层改写 base 附带的两行，并插入三个提供者行：

| 行 | 作用 |
|---|---|
| `web` | 把 `searchProvider` 改指到 `duckduckgo`，保留 `fetchProvider: http` |
| `web-search-duckduckgo` | 挂载 `web` 行所选的无密钥搜索提供者 |
| `web-search-brave` | 挂载 Brave 提供者；仅当 `searchProvider` 指名 `brave` 时才被选中 |
| `web-search-tavily` | 挂载 Tavily 提供者；仅当 `searchProvider` 指名 `tavily` 时才被选中 |
| `web-fetch-http` | 为 fake-IP 透明代理主机声明 `trustedProxyAddressRanges: [198.18.0.0/15]` |

`web-search-deepseek` 行仍由 base 层挂载并配置，因此日后存有 `DEEPSEEK_API_KEY` 的部署可以把 `searchProvider` 指回 `deepseek-official`，而无需改动本组合包。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

可观察行为已在[使用本包](#use-this-package)中完整覆盖。

### patch 文档

`cordis.patch.yml` 含三个条目：`web` 改写、一个承载三个提供者行的 `insert` 列表，以及 `web-fetch-http` 改写。两个改写都只针对 base 层插入的行，自身不指名任何插件；提供者行是本组合包唯一加载的行，每一行都从该组合包自己的 `dependencies` 解析。

patch 是**整体替换**目标行的 `config`，而不是合入，因此 `web` 改写在改动的提供者旁重申 `fetchProvider: http`，`web-fetch-http` 改写则给出完整的范围列表。需要更宽列表的 profile（LAN 主机、loopback）在自己的 `cordis.patch.yml` 中改写同一行，那个文件在所有组合包层之后应用。

按 id 改写的条目要求目标行已经存在。若 profile 列出本组合包却没有 `@deepseek-ai/dsh-base`，两个改写都会得到「补丁被跳过」的警告，只挂载三个 insert 行。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [Web 子系统](../../../docs/subsystems/web.zh.md) —— 搜索/抓取的请求与结果、提供者可用性，以及公网地址校验。
- [`web-fetch-http`](../web-fetch-http/README.zh.md) —— 读取 `trustedProxyAddressRanges` 的守卫。
- [`packages/bundle/base`](../../bundle/base/README.zh.md) —— 提供本组合包所改写行的那一层。
- [打包并安装插件](../../../docs/user/develop/basic/publish.zh.md) —— 本组合包依赖的层顺序与 patch 语义。

-----

<a id="model-experience"></a>
## 模型体验

间接地，经由 `web` 行所选的搜索提供者，以及 `dsh-tool-web` 所拥有的 `web_search` / `web_fetch` 工具。

#### KV Cache effect

无。本组合包不贡献任何提示文本，也没有自己的工具 schema；由哪个提供者作答改变的是工具结果，不是请求前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 本组合包不携带凭据。选择 `brave` 或 `tavily` 的部署通过 Web Search 设置页存入密钥，选择 `deepseek-official` 的部署存入 `DEEPSEEK_API_KEY`；在此之前被配置的提供者虽已注册但不可用，搜索以 `WEB_PROVIDER_CONFIGURED_UNAVAILABLE` 失败，而不是回退到已挂载的无密钥提供者。
- `trustedProxyAddressRanges` 只声明范围；本组合包无法检测主机是否真的位于透明代理之后，因此 DNS 正常解析的部署必须改写该行以去掉这个范围。
- 尚未编写在真实 Loader 中把本组合包与 `@deepseek-ai/dsh-base` 一起启动的验证；组合包测试覆盖的是 patch 文档，不是真实的组合。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

无。

</details>
