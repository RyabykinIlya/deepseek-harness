# Agent Note: 输入模态依据目录按模型强制执行

Status: implemented

[English](2026-10-05-per-model-input-modality-enforcement.md) | 中文

## 问题

tier 的 `input` 字段声明该 tier 对外公布哪些模态，而路由把这一声明作为它服务的每个模型的 `inputModalities` 上报。该声明是部署对 tier 的陈述，而不是关于 tier 所列每一个模型的证据：一个声明 `image` 却列出纯文本模型的 tier，描述的是其候选并不具备的能力，真实的图片于是到达一个会拒绝它的模型。拒绝会以提供方错误的形式出现，而这一轮已经付过费；又因为进入持久历史的图片会在之后每一次请求中被重放，该 Session 会重复这一错误。

关于一个模型接受什么的证据就在快照策略已经读取的 OpenRouter 模型目录里：每个条目都声明 `architecture.input_modalities`。由此产生两个问题。该能力属于 tier 的声明，还是属于决策选中的模型；以及每次决策都读取目录的代价，是否超过这份声明本身的价值。

## 决策

### 目录声明能力

`FamilyCache.modalities()` 读取与 `FamilyCache.resolve()` 相同的整份目录缓存（`src/family-cache.ts`），因此一次既解析家族又查询模态的决策只读取一次而不是两次。`parseOpenRouterCatalog` 把每个条目的 `architecture.input_modalities` 复制到 `inputModalities`（`packages/llm/llm-pi-ai/src/openrouter-catalog.ts`），缓存则把精确的模型 id 映射到该列表。

### 没有声明的模型不是候选

`rankEndpoints` 在应用逐 endpoint 过滤器之前，先为该模型询问 `modelRejectionOf`（`src/select.ts`）。当请求要求 `image` 时，目录条目未列出 `image` 的模型会被拒绝，该模型的每一个 endpoint 都计入 `modality` 这一原因。目录根本没有列出的模型也按同样方式处理，因为沉默不等于能力。每个被拒绝的 endpoint 仍会累加 `considered`，而既有的 `MODEL_ROUTING_NO_ENDPOINT` 消息会在其他拒绝计数旁边报告 `modality=<n>`。

目录读不出来时，没有任何模型被证明接受图片输入，因此图片请求会以同一个错误码与同样的计数失败，并额外有一行警告说明原因是目录不可读。对文本请求而言，目录不可读不算路由失败，因为文本请求从不为模态读取目录。

### 要求来自请求历史

`requiredInputOf` 会扫描请求的每一条消息以查找图片内容（`src/adapter.ts`）。进入持久 Session 历史的图片会在之后每一次请求中被重放，因此一张图片会让整个 Session 与图片绑定，而不只是引入它的那一次请求。只有携带图片的请求才会为模态读取目录；文本请求的排序不可能依赖模态，也不会为此付出读取代价。

### 无法服务该请求的 pin 会被丢弃，由该 tier 重新决策

`tierForInput` 向目录查询被 pin 的模型，当该模型未被证明接受所需模态时返回该 pin 所属的 tier（`src/adapter.ts`）。适配器随后丢弃该 pin，并以该 tier 为目标，因此新的决策在同一组过滤器下对同一个 tier 的模型排序。记录下来的 boundary 是 `start`，因为该请求是在没有可用 pin 的情况下进入决策的。`RoutingBoundary` 保持它的五个成员——`start`、`selection-change`、`compaction`、`idle` 与 `failure`（`src/types.ts`）——因为模态这一情形正是 `start` 已经指名的未 pin 情形。

## 考虑过的替代方案

- **依据 tier 的 `input` 声明在 tier 层面过滤** — 否决，因为该声明正是待检验的主张。逐 tier 的规则无法表达该 tier 所列的哪个模型接受图片，而且会保留“声明 `image` 却列出纯文本模型”这一错误本身。
- **按模型配置可接受的模态** — 否决，因为部署要为自己列出的每个模型重述一项目录事实，而 `snapshotPolicy: 'latest'` 会把 tier 的 id 移到静态列表无法跟随的版本上。
- **当 pin 无法服务该请求时改路由到另一个 tier** — 否决，因为 tier 是部署的成本与质量契约。模态收窄的是该 tier 内哪个模型可以作答；为一张图片重新询问 judge 会因内容变化而改变该契约，并重新给该 Session 定价。
- **给 `RoutingBoundary` 增加一个 `modality` 成员** — 否决，因为该联合类型指名的是相对某个 pin 为何作出决策。模态这一情形是在没有可用 pin 时作出决策，而 `start` 已经记录了这一情形；新增成员会让每个读取方枚举一个它与 `start` 无法区分的情形。
- **目录读不出来时仍然分发图片** — 否决，因为没有模型被证明接受它。替代结果是一次无法重放的请求在轮次中途被提供方拒绝，而这正是该过滤器要防止的结果。

## 测试

`tests/select.spec.ts` 覆盖 `modality` 拒绝、它在 `considered` 下的计数、未列出与无模态条目的情形，以及纯文本请求下排序保持不变。`tests/adapter.spec.ts` 覆盖只从目录声明过的模型服务图片请求、图片到达后在该 pin 所属 tier 内重新决策、以及在没有任何模型被证明接受图片时以 `modality=` 计数拒绝图片请求（含目录不可读的警告）。`tests/family-cache.spec.ts` 覆盖 `FamilyCache.modalities()` 背后的共享缓存读取。

## 后果

- 声明 `image` 的 tier 只从目录证明接受图片输入的模型中服务图片请求，当一个都没有时以 `MODEL_ROUTING_NO_ENDPOINT` 明确失败。
- 向该 tier 添加纯文本模型是安全的，因为该模型只是不会被图片请求选中。它永远无法服务于一个读过图片的 Session，因为该图片会留在该 Session 的历史中。
- 路由公布 tier 所声明的，并强制执行目录所声明的，因此 `auto` 继续上报各 tier `input` 声明的交集，只有当每个 tier 都声明时才声明 `image`。
- 文本请求不付出目录读取，也不经过新过滤器；与图片绑定的 Session 会在它原本所在的 tier 内重新决策。
