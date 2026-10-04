# Agent Note: 为运行时选择的插件值使用 volatile 配置

Status: implemented

[English](2026-10-03-volatile-config-for-runtime-selected-providers.md) | 中文

## Problem

web 访问接缝负责挑选由哪个已注册提供方服务搜索或抓取。`packages/web/web/src/index.ts` 中的 `WebRuntime` 曾在构造函数里一次性捕获该选择：

```ts ignore-check
class WebRuntime extends Service {
  private readonly searchProviderId: string | undefined

  constructor(ctx: Context, config: WebRuntimeConfig = {}) {
    super(ctx, 'web')
    this.searchProviderId = config.searchProvider ?? process.env.DSH_WEB_SEARCH_PROVIDER
  }
}
```

此后每次调用都读这个快照。包内没有任何对设置变更的订阅——也不存在可订阅的事件——因此更换提供方的唯一方式是改 composition 并重启进程。`web_search` 在任何没有 DeepSeek 密钥的部署里都会失败，而 composition 又硬选了 `searchProvider: deepseek-official`，导致根本够不到替代项：`resolveProvider` 在配置的 id 未注册或不可用时会抛错，且从不回退（`packages/web/web/src/index.ts`）。

把这件事做成可在设置页调整，看起来是 UI 任务。并不是，而且第一次尝试失败的原因值得留存。

客户端设置层通过 `ctx.configForms.get(<namespace>)` 读取插件配置，Web Search 页面已经用它编辑 `web-search-deepseek`。把同一套机制绑到 `web` namespace 上，得到的却是一个永久失效的控件：作用域一直报 `unavailable`，组件不挂载，每次保存都被拒绝。原因不在于漏接了哪一步。`SettingsForms.describe()` 只投影 **volatile** 字段（`packages/settings/settings/src/index.ts`，经由 `packages/settings/settings/src/schema.ts` 的 `volatileForm`），而 `validatePaths()` 对其余字段抛出 `Config field "searchProvider" is not volatile`。`WebRuntime.Config` 声明的是 `searchProvider: z.string()`，于是 `volatileForm()` 返回 `undefined`，`web` 条目被整个从 `describe()` 中剔除。这个接缝根本没有设置表单——不是一个会说谎的表单，而是没有。

写入路径本身是 `ConfigEditor.edit()` → `reconcileProfilePatches()` → `Include` → `Entry.update()`（`vendor/loader/src/config/entry.ts`）。这个入口决定改动的命运：**仅含 volatile 的**差异会被就地提交，通过改写运行中 fiber 的引用完成，并且**不会**调用 `fiber.update()`——插件根本不会被重建。其他任何差异都会调用 `fiber.update()` → `restart()`，插件**会**被重建。

## Decision

`WebRuntime.Config` 把两个选择字段标记为 volatile，运行时改为在使用时解析，而不再保存快照。

```ts ignore-check
interface WebRuntimeConfig {
  readonly searchProvider?: Volatile<WebSearchProviderId | undefined>
  readonly fetchProvider?: Volatile<WebFetchProviderId | undefined>
}
```

这两半不是可选关系，第二半由第一半强制推出。volatile 提交不会重建运行时，因此构造函数里取的 `readonly` 快照会永远停留在旧值：设置文档和 UI 都报告新提供方，实际服务却仍是旧的。volatile 负责让值可编辑；在使用时解析才让这次编辑真正生效。

schema 上的 `z<WebRuntimeConfig>` 注解是被刻意去掉的。Schemastery 把 volatile 字段的类型定为其**存储**类型，因此在 schema 里钉住访问器类型是一种谎言；树中其他所有 volatile 插件都已经不写它。

id 以数据而非 schema 约束的形式发布：

```ts
export const WEB_SEARCH_PROVIDER_IDS = ['brave', 'deepseek-official', 'duckduckgo', 'exa', 'perplexity', 'tavily'] as const
export type WebSearchProviderId = typeof WEB_SEARCH_PROVIDER_IDS[number] | (string & {})
export const WEB_FETCH_PROVIDER_IDS = ['http'] as const
```

schema 仍是 `z.string()`。Schemastery 的字面量联合会在 `resolveProvider` 运行之前就于 `resolveConfig` 中拒绝未知 id，那样真正能指出问题的 `WEB_PROVIDER_CONFIGURED_MISSING` 就永远不可能出现。`(string & {})` 的加宽是仓库既有惯例（`packages/skill/skill/src/index.ts`），它带来编辑器补全而不拒绝任何输入。

客户端那一半在 `packages/client/ui-settings-web-search`。该页面此前被硬接到单一 namespace（`WEB_SEARCH_NS = 'web-search-deepseek'`），因此无论选哪个提供方，输入的密钥都会落到 `DEEPSEEK_API_KEY`。现在它为每个已挂载的提供方渲染一个块，各自写入自己的凭据引用，此外为 `web` namespace 提供**一个**提供方选择器。选择器是单个页面项而不是每块一个，因为 `searchProvider` 是一个全局值；把同一个选项重复三次属于缺陷。未设置时它提供 *Automatic*——发出 `unset`，把选择权交回接缝的自动选择，而不是写入空 id；遇到未知的已配置值时，把它作为额外的选项原样呈现，而不是改写它。

有一条值得写明、否则很容易被想当然地弄错的推论：**已提供的设置 namespace 不是插件已挂载的信号。** `web-search-duckduckgo`、`web-search-exa` 和 `web-search-perplexity` 没有声明任何 volatile 字段，因此它们和曾经的 `web` 一样被排除在 `describe()` 之外。客户端无法获知挂载状态，这正是选择器的选项列表是静态的原因。

## Alternatives considered

**给 `searchProvider` 用 Schemastery 字面量联合。** 否决：它会把清晰的运行时错误变成不透明的 schema 拒绝，而现有 YAML 中的未知 id 会让插件直接无法加载。

**订阅设置变更事件。** 没有这种事件。volatile 路径才是仓库真正提供的机制，而且其他所有 web 提供方都已在使用：`web-search-deepseek`、`web-search-brave`、`web-search-tavily` 把每个字段都标记为 volatile，并按调用读取 `config.x.get()`。

**保留字段非 volatile 并重载插件。** 这本会让既有的 `readonly` 捕获变得正确，因为非 volatile 差异上的 `Entry.update()` 会重启 fiber。否决原因是它把一次设置保存变成一次服务重启，而 `ctx.web` 的所有其他消费者都能看到这件事。

**用已提供的 namespace 推导选择器选项。** 否决：如上所述，已提供 ≠ 已挂载，这个过滤会隐藏 `duckduckgo`，而它正是默认 composition 里的选择。

**保留 composition 的 `searchProvider` 作为唯一控制、不加任何 UI。** 否决：挑选提供方需要改 YAML，而这正是本次要消除的失败模式——并且那里的错误选择是隐形的，因为被地理屏蔽或缺少凭据的提供方返回的是空结果而不是错误。

## Consequences

现在可以在设置页选择提供方，密钥也写入该提供方自己的凭据引用，三者不再互相覆盖。代价是给未来任何"运行时选择的插件值"附加了第二项义务：该值必须声明为 volatile **并且**在使用时重新读取；只做前一半的人会交付一个能保存、却不生效的设置。

静态选项列表需要在新增提供方时扩展——一个数组项，不需要改 schema，也不需要改消费方。若作者忘了，故障是良性的：该 id 仍会到达 `resolveProvider`，并在 `WEB_PROVIDER_CONFIGURED_MISSING` 中被点名。

选择器会提供默认未挂载的包的 id。选中它们会得到同样清晰的错误，而不是静默地行为异常；我们认为这好过把两个已发布的提供方藏到 YAML 编辑之后。

反应性是通过真实路径验证的，而非通过代理：`packages/web/web/tests/web.spec.ts` 挂载真实的 Loader，注册额外提供方，然后驱动 `entry.update({ config: { searchProvider: … } })`——也就是 `SettingsForms.write` 所做的事——并断言下一次 `ctx.web.search()` 派发到新提供方，同时 `entry.fiber` 与 `Volatile` 引用仍是同一批对象。身份断言落在 fiber 上而不是 `ctx.web` 上，因为 `Service` 携带 tracker，`ctx.web` 是可追踪的 Proxy。该测试通过把构造函数改回快照方式验证了非空转：所有实时选择用例会失败，恢复后再次通过。