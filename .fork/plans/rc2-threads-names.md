# rc.2: именованные сабагенты против Threads — решение A1

Статус: **решение принято, механика для мержа.** Дерево ещё до мержа (пин `dsh-v0.2.2-rc.1`), все цитаты из rc.2 получены `git show dsh-v0.2.2-rc.2:<path>` против текущего HEAD. Окно — [upstream-0.2.2-rc.2.md](upstream-0.2.2-rc.2.md), гайд — `docs/upgrade-guide/v0.2.2-alpha.3/subagent-names` из тега rc.2.

## 0. Что именно приехало (по исходникам rc.2, не по гайду)

- **Адресация по имени.** `packages/subagent/subagent/src/names.ts`: `NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/u`, корень — `lead`, полный путь — `reviewer/checker`. `agentAddress(path ?? undefined, id)` отдаёт `lead`, путь или Session id: **id остаётся легальным адресом всегда** (`resolveName` в `subagent/src/index.ts:331` — «Any other text that is not a name in the tree is returned as a Session id»).
- **`send_message`/`interrupt_agent` берут `agent`, не `agent_id`.** `tool-subagent-control/src/index.ts` (rc.2): `parameters: { agent: … }`, «The name of another agent in your subagent tree, as shown by list_agents». Старый `agent_id` не проходит валидацию аргументов.
- **`list_agents` — новый словарь.** `tool-subagent-control/src/list-agents.ts` (rc.2): параметры `{}` (параметр `scope` исчез), строки `{name, status, description?}`, текст `<name> [<status>] — <description>`, первая строка — сам корень `lead [running] — root agent`. Плюс новый инструмент `wait_agent` (`wait-agent.ts`), регистрируемый тем же плагином безусловно.
- **`subagent` принимает `name` и возвращает `{kind:'activation', name}`.** `tool-subagent/src/index.ts` (rc.2): параметр `name` («Omitted names default to agent-1, agent-2…»), receipt `started subagent ${value.name}`, `presentationMeta: { kind, name }`. Результат — единственный объект, не `oneOf` из трёх.
- **Каталог пишет payload v3.** `subagent/src/catalog.ts` (rc.2): `SUBAGENT_CATALOG_VERSION = 3`, событие несёт обязательное `name`; у форка сейчас `SUBAGENT_CATALOG_VERSION = 0` (`catalog.ts:21`). Старые релизы каталог v3 не читают (persistence acknowledgement `2026-11-02-subagent-catalog-names`).
- **`SubagentRunInfo` получил `parentSessionId`.** `subagent/src/types.ts` (rc.2): «Durable direct creator, independent of the live subagent tree root», заполняется в `manager.ts:932` как `activation.ancestors.at(-1)`.
- **Сопутствующее окну** (гайды `v0.2.1-rc.2/subagent-service-methods`, `…/subagent-user-controls`): сняты `ctx.subagents.listChildren`/`drainChildren`/`list`; `@deepseek-ai/dsh-subagent/internal` (включая `markAdjacentAgentSendMessageTool`) **удалён как точка входа** — файла `subagent/src/internal.ts` в rc.2 нет; `SubagentInterruptAuthority` user-вариант — `{ kind: 'user' }` без `parentSessionId`; Remote `interruptByParent(child, parent, mode)` → `interruptByUser(child)`; `SubagentPromptRequest` теряет `parentSessionId` и `mode`.
- **Пресеты апстрима гасят `interrupt_agent`.** `bundle/base/cordis.patch.yml:389`, `bundle/web-app/presets/{standard,ptc}.patch.yml` — `tool-subagent-control` с `config: { interrupt: false }`. У самого плагина дефолт остался `true` (`Config` — `z.boolean().default(true)`).

## 1. Что ломается: полный перечень файлов форка

Классы: **(a)** модель-видимый текст стал неверным/самопротиворечивым; **(b)** код не компилируется или ведёт себя иначе; **(c)** authored-снапшот расходится с ожидаемым выводом; **(d)** тест.

«Форк-файл» = файл, изменённый/добавленный форком против rc.1 (`git diff --name-only dsh-v0.2.2-rc.1 HEAD`), либо authored-снапшот. Апстримные файлы, которые форк не трогал (весь `packages/subagent/*` кроме перечисленных правок форка), в мерж не входят в эту таблицу — их перезапишет апстрим, а переносы форк-швов в них уже учтены в [upstream-0.2.2-rc.2.md](upstream-0.2.2-rc.2.md) п.1 таблицы (строка 1).

| Файл | Класс | Что не так после мержа | Требуемая правка |
|---|---|---|---|
| `packages/experimental/threads-preset/src/threads-contract.ts:153` | **a** | «The `subagent` call … returns a Thread id» — rc.2-инструмент возвращает имя сабагента и подписывает receipt `started subagent <name>`; координатор, ждущий «Thread id», получит не то, что обещано | Переписать предложение под выбранный дизайн (см. §3): для D1 — «returns a Thread id (the agent name or Session id it reports)»; для D2 — «returns the Thread's name» |
| `packages/experimental/threads-preset/src/threads-contract.ts:160` | **a** | «Use `send_message` to give a running Thread more instructions and `interrupt_agent` to stop it» — верно по смыслу, но адресный аргумент поменялся; текст не называет аргумент, так что сам по себе не врёт | Поправить только если добавляем имя в контракт (D2); при D1 оставить |
| `packages/experimental/threads/src/lifecycle.ts:97` | **b→упрощение** | Родитель достаётся через `child.session.header.parentSession` и `ctx.get('agents')`; rc.2 несёт `info.parentSessionId` готовым (§2) | Заменить резолв на `info.parentSessionId` (или оставить как есть — работает и в rc.2, см. §2) |
| `packages/experimental/threads/src/index.ts:321` | **b** | `subagents.interrupt(SessionId(threadId), { kind: 'user', parentSessionId: project.id })` — в rc.2 user-вариант authority `{ kind: 'user' }`, поле `parentSessionId` не компилируется | `subagents.interrupt(SessionId(threadId), { kind: 'user' })` |
| `packages/experimental/client-ui-threads/src/client/mount.ts:173` | **b** | `ctx.remote.subagents.interruptByParent(threadSessionId(threadId), owner, 'continuable')` — Remote-метод переименован в `interruptByUser(child)` | `ctx.remote.subagents.interruptByUser(threadSessionId(threadId))` |
| `packages/experimental/client-ui-threads/tests/browser-plugin.client.spec.ts` (3 места: 182, 369, 479, 564) | **d** | Мок и ожидания вызывают `interruptByParent` с тремя аргументами | Переименовать метод и сократить ожидаемые `args` до `['thread-1']` |
| `packages/experimental/threads/tests/lifecycle.spec.ts:140-149` | **d** | `ctx.subagents.prompt({ requestId, parentSessionId, childSessionId, mode: 'continuable', … })` — в rc.2 у `SubagentPromptRequest` нет `parentSessionId` и `mode` | Убрать оба поля из вызова |
| `packages/experimental/threads-preset/src/project-preset.ts:249-262` | **b** | Конфиг строки делегации: `backgroundMode: 'continuable'`, `allowedModels` — в rc.2 у `tool-subagent` этих Config-полей нет (гайд-конфиг rc.2: `provider, toolName, modelSelection, modelDiscovery, agentOptions, agentPreset, allowedAgentPresets, maxDepth`); вилка остаётся несовместимой, пока не перенесён форк-шов (это работа мержа, окно №4 в [upstream-0.2.2-rc.2.md](upstream-0.2.2-rc.2.md), не A1) | Переносится мержем (задача B): вернуть `backgroundMode`, `allowedModels`, `repository`, `isolatesContinuableCwd` в rc.2-код. A1 фиксирует только: **новый параметр `name` в rc.2 не запрещать** и result-шейп инструмента сменить на `{kind:'activation', name}` |
| `packages/experimental/threads-preset/src/project-preset.ts:295-300` | **a/d** | Строка `tool-subagent-control` монтируется без config → в rc.2 `interrupt` по-прежнему `true` (дефолт плагина), т.е. у координатора `interrupt_agent` остаётся, контракт не врёт. Но апстрим-паттерн этого окна — явный `interrupt` (см. §5) | Явная строка `config: { interrupt: true }` (решение §5) |
| `packages/experimental/threads-preset/tests/project-preset.spec.ts:421,476` | **d** | Ожидает `interrupt_agent` в списке инструментов координатора — остаётся верным только пока `interrupt: true`; прогон упадёт, если последовать апстрим-дефолту молча | Дополнить тест проверкой, что конфиг строки несёт `interrupt: true` (чтобы будущий рефактор дефолтов не снял инструмент молча) |
| `packages/experimental/threads-preset/tests/project-preset.spec.ts:523,529` | **d** | Пинует дословно два предложения контракта, которые меняются при любом исходе §3 | Обновить пины вместе с `threads-contract.ts` |
| `packages/experimental/threads-preset/tests/shipped-standard.spec.ts:50,70` | **d** | Читает `bundle/web-app/presets/standard.patch.yml`; после мержа в этой строке появится `config: { interrupt: false }`, а `coordinatorPreset` обязан **перезаписать** её своей строкой с `interrupt: true`, иначе координатор потеряет `interrupt_agent` из-за `containsRow(kept, THREAD_CONTROL_ROW_ID)` | Тест должен закрепить: базовая строка с `interrupt:false` НЕ выживает в координаторе (заменяется на нашу), worker — наследует как есть |
| `packages/experimental/threads-profile/tests/profile.spec.ts:322` | **d** | `expect(after.tools).toEqual(expect.arrayContaining([… 'interrupt_agent']))` для обычной сессии на `standard` — после мержа base/web-пресеты гасят interrupt, ordinary-сессия его не увидит | Убрать `interrupt_agent` из ожиданий ordinary-набора (координаторский набор в :339 остаётся) |
| `packages/experimental/threads-profile/tests/profile.spec.ts:148-152` (STANDARD_PLUGINS) и `project-preset.spec.ts:74-82` (BASE_ROWS), `real-composition.spec.ts:135` | **d** | Тестовые базовые пресеты объявляют `tool-subagent-control` без config и `tool-subagent` с `backgroundMode: continuable`; после мержа первый начнёт регистрировать ещё и `wait_agent` (безусловно), а конфиг второго надо синхронизировать с перенесённым швом | Обновить стенды: учесть `wait_agent` в списках (он не мешает `arrayContaining`), оставить config как после переноса шва |
| `packages/experimental/threads-profile/tests/real-composition.spec.ts:356` и `project-preset.spec.ts:179`, `profile.spec.ts:295` | **d** | `/started subagent (\S+)/` вытаскивает id из receipt; при D1+`name` не задан → receipt несёт `agent-N`, а не Session id → `ctx.agents.get(...)` вернёт undefined и тест упадёт | Либо парсить `presentationMeta`/результат JSON (недоступно в text-фасаде), либо передавать `name` в аргументах делегации и разрешать child через `ctx.agents`/`threadIdText` из проекции (в real-composition уже берётся из `ctx.threads.viewOf`), либо после переноса шва оставить receipt несущим id для thread-провайдера — см. §3, решение D1 |
| `packages/experimental/hooks-claude-code/src/index.ts:361` | **a** | `agent_id: info.id` в CC-payload SubagentStart — поле `info.id` остаётся (Session id), но имя в CC-хуки не попадает; не ломается, лишь теряет новое | Опционально: добавить `info` → имя нельзя (его в `SubagentRunInfo` нет); оставить как есть, задокументировать |
| `snapshots/session/threads-project-worktree/*` | **c** | См. §4 | См. §4 |
| `snapshots/session/threads-project-worktree-tiers/*` | **c** | См. §4 | См. §4 |
| `packages/experimental/threads/README.md:46`, `tool-threads/README.md:94,102,218`, `threads-preset/README.md:86,89,138`, `threads-profile/README.md:102` (+ `.zh.md` пары, `.i18n.yaml`) | **a** | Проза описывает «returns a Thread id»/`subagentId`-словарь и «send_message, interrupt_agent, and list_agents» без упоминания нового словаря имён; при D2 также «Thread identity is the Session identity» в client-ui-threads README:198 | Обновить вместе с кодом; объём зависит от §3 |

Не форк-поверхность, но задевает форк (для полноты, мерж заботится): `packages/subagent/tool-subagent-control/src/{index,list-agents}.ts` — форк менял `markAdjacentAgentSendMessageTool` (импорт из удалённого `@deepseek-ai/dsh-subagent/internal`); в rc.2 маркер не нужен — guidance для ребёнка пишет сам control-плагин через `systemPrompt.context('subagent:identity')`, а менеджер кладёт `withResultDeliveryGuidance` безусловно. `packages/subagent/subagent/src/{continuation-messages,manager,types,child-agent}.ts` — форк-правки (`isolatedCwd`, `handles`, `repository`, `isolatesContinuableCwd`, `presetOverride`) переносятся на rc.2-структуру (`startLocalNamed`, `ancestry`, `path`).

## 2. `SubagentRunInfo` и lifecycle-мост

**Да, всего хватает, и появился более надёжный источник родителя.**

Сейчас (`threads/src/lifecycle.ts:93-101`):
```ts
const child = registered(info.id)
const parentId = child?.session.header.parentSession
const parent = parentId === undefined ? undefined : registered(parentId)
if (child === undefined || parent === undefined) { warn…; return }
```
Родитель выводится из **живого** `Agent` ребёнка; пока ребёнок не зарегистрирован (external, гонка старта) или header не несёт `parentSession`, мост пишет warning и теряет `thread/created`. Провайдер `thread` всегда локальный и header пишет (`childSessionMeta` кладёт `parentSession: parentHeader.id` — проверено в rc.1 и rc.2 `child-agent.ts:146`), так что на практике пусто не бывает.

В rc.2 `SubagentRunInfo` несёт `parentSessionId` — «Durable direct creator, independent of the live subagent tree root» (`types.ts`, заполняется `manager.ts:932` из `activation.ancestors.at(-1)`). Это ровно то, что мост достаёт обходом, и это durability-факт, не производное живого реестра.

**Правка:** заменить резолв на `registered(info.parentSessionId)` и оставить `registered(info.id)` только для ребёнка (label и cwd читаются из его Session). Формально `info.id` в rc.2 остаётся Session id ребёнка — `ThreadId(info.id)` менять не нужно. Ветка «child === undefined» сжимается до «нет родителя в реестре» — тот же warn-путь, меньше зависимостей. Это упрощение, не обязательное для компиляции: старый путь в rc.2 тоже работает (`header.parentSession` сохранён). Мост обязан по-прежнему отфильтровать чужого провайдера (`info.provider !== options.providerName → return`) — этого поля изменение не касается.

Тесты: `threads/tests/lifecycle-edges.spec.ts:238` собирает `SubagentRunInfo` руками — после мержа интерфейс требует `parentSessionId`, фикстуре добавить поле (`PROJECT` уже есть в этом файле).

## 3. Решение: получают ли Thread'ы имена

**Рекомендация — D1: сохранить Session-id-адресацию, имена не включать. Чинить только текст и снапшоты.**

Соображения по каждому пункту ТЗ:

- **Сколько поверхности режет каждый вариант.**
  - D1: правки = 2 предложения в `threads-contract.ts` + снапшоты (§4) + переносы §1. `tool-threads` (`thread_id` повсюду), `threads` проекция (`threadId = SessionId`), `client-ui-threads` («Thread identity is the Session identity», `threadSessionId(threadId)`, `openSession`), `ui-settings-threads`, worktree-manager (`branchTemplate: dsh/thread-{{id}}`), `threads/README.md:46` «Durable Thread identity (the child Session id)» — **не трогаются**. Это ~10 файлов текста против ~30 файлов кода.
  - D2 (именовать Thread'ы slug'ом лейбла): нужно (i) принять `name` в координаторском контракте и slug'ифицировать `description` (нейминг-правила `isAgentName` — 1–32 `[a-z0-9-]`, модель часто даёт лейблы вне алфавита → нужна молотилка с коллизиями, а коллизии резервируются sibling'ами на стороне runtime'а, который мы не контролируем); (ii) пробросить имя в `thread/created` событие и проекцию (новое поле с `ignorable`-политикой — persistence-change с schema); (iii) научить `thread_status`/`thread_diff`/`thread_tier` принимать имя или выдавать его рядом с id; (iv) обновить client-ui (roster, token-usage, thread-chat адрес), где идентичность — Session id по построению; (v) модель должна **сама** придумать валидное имя при старте Thread'а — контракт обязан требовать параметр `name`, а `slug(label)` не входит в `NAME_PATTERN` автоматически. Это переделка половины фичи ради словаря.
- **Даёт ли `list_agents` свести агента к Thread'у.** В rc.2 — да, но слабее, чем сейчас: строка — `{name, status, description?}`, где `description` = label делегации, а `name` = `agent-N` (имя не задано → автонумерация, `names.ts: reserve`). НИ `name`, ни `description` не несут Session id, и каталог v3 отдаёт имя, а не id. Поэтому при D1 координатор, читавший раньше из `list_agents` id ребёнка, больше не может напрямую сопоставить строку `list_agents` строке `thread_status` — идентичность дают только `subagent`-receipt (`started subagent <name>`… тоже имя!) и notice «Background subagent <имя> finished». **Это главный реальный минус D1**, и он закрывается тем, что у Threads и не было контракта на `list_agents` как источник id: контракт координатора (`threads-contract.ts:153-160`) говорит брать Thread id из результата `subagent` («returns a Thread id») и из `thread_status`, а steering идёт по значению, которое вернул `subagent`. Значит D1 требует, чтобы receipt `subagent` для `thread`-провайдера продолжал нести **Session id**, а не имя — это форк-шов в `tool-subagent`, уже существующий в другой части (форк переписал result-шейп под `handles`), и его надо сохранить при переносе на rc.2: результат `{kind:'continuable', subagentId, handles}` НЕ заменяется на `{kind:'activation', name}` для thread-провайдера. Альтернатива внутри D1 — принять `agent-N` имена и научить контракт говорить «адресуй Thread тем, что вернул `subagent`» — но тогда receipt обязан нести имя, а сведение к `thread_id` теряется совсем. Поэтому D1 фиксирует: **id в receipt, id в `agent`** (`resolveName` принимает id как fallback по построению).
- **Каталог payload v3.** В обеих схемах форк после мержа пишет v3 (rc.2-менеджер пишет `SUBAGENT_CATALOG_VERSION` сам, `establishCatalogChild(parent, child, descriptor, name)` — имя обязательно). Отказаться от v3 нельзя без форка менеджера. Последствие: сессии, созданные на rc.2-форке, **не открываются релизами до rc.2** — включая откат на текущий пин форка. На D1/D2 выбор не влияет; он влияет только на то, пишем ли мы в `name` осмысленное значение (`agent-N` при D1, slug при D2). Отдельно: обе authored-фикстуры несут `subagent/catalog` `version: 0` — после мержа живой прогон напишет v3 с `name`, фикстуры правятся руками (§4).
- **Что видит модель.** При D1: `subagent` → «started subagent <uuid>» + `worktree:`/`branch:` строки (handles — форк-шов), `thread_status`/`thread_diff`/`thread_tier` на `thread_id=<uuid>`, `send_message({agent: "<uuid>"})`, `list_agents` показывает `agent-N` строки, полезные разве что для дерева. Разночтение «в одном инструменте uuid, в другом agent-N» неприятно, но инструменты не пересекаются: контракт направляет каждую задачу своему инструменту. При D2 словарь единый, но платит переделкой идентичности всей фичи.

**Что заставит пересмотреть решение:** (1) апстрим перестанет принимать Session id в `agent` (пока `resolveName` возвращает `brandString<SessionId>(name)` для любого одиночного токена — безопасно; если встроют строгий lookup по именам с отказом для неизвестных — D1 умирает); (2) форк захочет показывать моделью имена в `thread_status` (UX-запрос, не блокер); (3) upstream-снапшоты/гейты начнут требовать единый result-шейп `subagent` (`{kind:'activation',name}`) без провайдерных расширений — тогда receipt с id придётся менять и D1 съедет к «адресуй Thread именем из receipt».

## 4. Снапшоты: точные правки

Оба каталога `recording: authored` → `test:snapshot:record` их не трогает (пропускает), `refresh`-режим (`DSH_SNAPSHOT=refresh pnpm run test:snapshot -t threads-project-worktree`) **может** их переписать: `headless.snapshot.ts:1286-1288` скипает authored только в `record`, refresh идёт по всем; но refresh требует сборки (`lib/`) и живого прогона — на предмержевом дереве бессмысленно. Правки ниже — руками, по образцу уже проделанного 2026-10-06 (STATUS.md:434).

Эталон для правок — фактически записанные rc.2-сценарии, прежде всего `snapshots/sdk/subagent-continuable/` из тега rc.2: каталог v3 там выглядит как `{"version":3,"childId":"{{session:2}}","childCreatedAt":1789000001000,"mode":"continuable","label":"Reply with CHILD_OK","name":"agent-1"}`, receipt — `started subagent agent-1`, notice — `Background subagent agent-1 finished and will do no further work unless you send it more.`

Список правок (по исходникам §0 и rc.2-фикстурам):

1. **`tool-schemas.expected.json` + `tool-schemas.1.expected.json` (оба каталога, одинаково):**
   - `send_message`: свойства `agent_id` → `agent`; описание параметра → `"The name of another agent in your subagent tree, as shown by list_agents."`; описание инструмента → `"Send a message to an agent. A working agent receives it at its next step; an idle agent starts a new turn with it. Returns delivery confirmation."` (хвост «, not the agent's answer» ушёл); `required: ["agent","message"]`.
   - `interrupt_agent` (есть в ОБОИХ файлах — и координатора, и worker'а, т.к. worker наследует базовую строку control): описание → `"Ask a subagent to stop its current work. This call returns without waiting for it to stop. You can continue a local subagent's conversation later with send_message. External executions stop permanently and cannot receive follow-ups. Subagents it started will keep running."`; свойства → `agent` с описанием `"The name of an agent created under you: your direct child or a deeper descendant."`; `required: ["agent"]`.
   - `list_agents`: описание → полный rc.2-текст («List your entire subagent tree: the root agent and all reachable continuable descendants, including yourself. Rows carry names, descriptions, and status. A descendant's name is its path from the root, such as reviewer/checker. You can message any other agent in the subagent tree. running means it is working; inactive means no turn is executing; it does not indicate task completion, success, or failure. corrupt, unsupported, or unavailable means this row's own descendants could not be read; the row itself is still a member you can message. While you remain active, you will be notified when a direct child finishes; there is no need to keep checking its status. Use send_message to continue the conversation.»); `parameters.properties` → `{}` (параметр `scope` удаляется), `required` отсутствует.
   - добавить **`wait_agent`** (регистрируется control-плагином безусловно): описание `"Wait for input at your next step, including agent messages, completion notifications, and user steering. Returns immediately if new input is pending. \`timedOut: false\` means new input is pending. Pending input is delivered to the model after code execution finishes."`, параметр `timeout_ms` (`"Wait duration in milliseconds, from 10000 through 3600000. Defaults to 30000."`).
   - `subagent` (обе роли): добавится параметр `name` — `"Optional short name for the subagent, unique among the subagents you create: lower-case letters, digits, and hyphens, starting with a letter, at most 32 characters; lead is reserved for the root agent. Omitted names default to agent-1, agent-2, and so on."` (rc.2 объявляет его всегда; при D1 НЕ вырезаем — вырезание ещё один шов, модель не обязана его задавать). Остальное (`run_in_background`, `repository`, `cwd`, описания) — по факту переноса шва; обязательные инварианты: описание про асинхронность и возврат Thread id, параметр `run_in_background` с текстом «Always runs in the background; omit this parameter. `false` is refused…» (координаторский, провайдер `thread`), `repository` с текущим текстом.
2. **`system-prompt.expected.md` + `system-prompt.1.expected.md` (оба каталога):**
   - Строка 30 обоих файлов: `Start independent subagent delegations together in one assistant message and continue useful work while they run.` → rc.2-текст секции `tool:subagent`: `Start independent delegations with \`subagent\` together in one assistant message and continue useful work while they run. When only waiting for their results remains, end your turn instead of sleeping or polling; the next result starts a new turn. Collect the subagent results required to complete the task before giving the user a final answer.` (за ним отдельным абзацем `Bash, formatters, code generators, and scripts can overwrite concurrent edits…`). Имя инструмента в первой строке — фактически видимый набор (`subagent` один: `subagent_fork` из координатора выброшен). Сайдкар несёт собранный промпт, а identity-контекст печатается В runtime-context сообщении, не в промпте (проверено по rc.2-фикстуре `subagent-continuable`: child-промпт identity-строк НЕ содержит) — **промпт-сайдкар больше ничем не меняется**.
3. **`session.v4.jsonl` (оба каталога):**
   - Событие `subagent/catalog`: `{"version":0,…}` → `{"version":3,"childId":"{{session:2}}","childCreatedAt":1791043552650,"mode":"continuable","label":"greeting","name":"agent-1"}` (в фикстурах этого репо `childCreatedAt` остаётся числом — так записано сейчас и в rc.2-фикстурах).
   - Receipt `call_spawn_1` — при D1 остаётся `started subagent {{session:2}}\nworktree: {{cwd:1}}\nbranch: dsh/thread-{{session:2}}` (форк-шейп с handles). **Это место, где решение D1 материализуется: receipt не трогаем.** Если перенос шва всё же принимает rc.2-шейп — тогда `started subagent agent-1` и D1 съезжает к «адресуй Thread именем из receipt» (см. §3).
   - Notice о завершении (два вхождения: `agent/inbox/spliced` и `user/message`): в rc.2 `settlementSummary` берёт `childName = agentAddress(path, childId)`; у ребёнка с автонумерацией `agent-1` текст станет «Background subagent agent-1 finished and will do no further work unless you send it more.», при этом `senderSessionId` остаётся `"{{session:2}}"`. Заменить `{{session:2}}` → `agent-1` **только в тексте блока `summary`**, не в `senderSessionId` и не в `boundContextSummary`.
   - `thread/created`/`thread/status`/`thread_status`-результаты: не меняются (идентичность Thread — Session id).
   - runtime-context снапшот родителя (строка 10): в `sections` добавится `subagent:identity` с текстом корня:
     ```
     You are the root agent. Your name is "lead".

     To message other agents, use send_message({ agent: "<agent-name>", message: "..." }).
     Use list_agents({}) to find your collaborator agents and their names.
     ```
     (проверено по rc.2-фикстуре `subagent-continuable/session.v4.jsonl`: родитель — корень дерева.)
4. **`session.1.v4.jsonl` (оба каталога):**
   - `subagent/descriptor` — версия 3 сохранена и в rc.2 (`SUBAGENT_DESCRIPTOR_VERSION = 3`), поля те же: **не меняется**.
   - Делегационный текст `withContinuableReturnGuidance` (строки 6 и 11): `send_message({ agent_id: "{{session:1}}", …})` → `send_message({ agent: "{{session:1}}", …})`. rc.2 сам кладёт другой текст (`withResultDeliveryGuidance`, без адреса родителя) — форк-шов isolatedCwd-варианта обязан сохраниться при переносе (фича R1); правка минимальна — имя аргумента, остальной текст шва как есть.
   - runtime-context снапшот ребёнка (строка 12): в `sections` добавится `subagent:identity` с текстом:
     ```
     You are a subagent delegated by agent "lead".
     Your name is "agent-1".
     The root agent of your collaboration tree is "lead".

     To message other agents, use send_message({ agent: "<agent-name>", message: "..." }).
     Use list_agents({}) to find your collaborator agents and their names.
     ```
     (имя родителя здесь `agentAddress(path, parent)` = `lead`, т.к. родитель — корень). Depth-контекст `tool:subagent:depth` у ребёнка НЕ появится: rc.2 пишет его только при `depth >= maxDepth`, а у нас `workerMaxDepth: 2` при depth ребёнка 1.
5. **`cordis.snapshot.yml` / `cordis.yml` / `snapshot.yml`:** не меняются — состав не зависит от словаря адресации. Строка `tool-subagent-control` внутри снапшот-пресета `standard` остаётся без config: `interrupt` по умолчанию `true`, координаторский `interrupt_agent` выживает и без правки §5 (§5 нужна для ЖИВОГО web-профиля, где base-строка после мержа несёт `interrupt: false`).

## 5. `interrupt_agent` в пресете Project

**Решение: прерывание для координатора сохраняем.** Основания:

- Контракт координатора обещает: `threads-contract.ts:160` — «Use `send_message` to give a running Thread more instructions and `interrupt_agent` to stop it» — и этот текст пинуют тесты (`project-preset.spec.ts:529`).
- `project-preset.spec.ts:421` требует `interrupt_agent` в наборе координатора; `:476` — то же для композиции без базового пресета.
- Живой сценарий: остановить Thread обязан и координатор (модель), и пользователь (`threads.stop` → `interrupt(kind:'user')`); терять модельный путь нет причины.
- Апстрим гасит interrupt в base/web-пресетах не из-за запрета, а из политики «ordinary-сессия не должна ломать чужую работу» (гайд `v0.2.2-rc.1/subagent-interrupt-default`). У координатора прямо противоположная роль.

**Механика.** Дефолт плагина — `true` (`tool-subagent-control` rc.2: `Config.interrupt = z.boolean().default(true)`, `apply`: `const interrupt = config.interrupt !== false`), так что пустой config формально работает. Но после мержа путь `containsRow(kept, THREAD_CONTROL_ROW_ID)` начнёт находить базовую строку (в `standard.patch.yml` и base-бандле она теперь с `interrupt: false`), координатор **унаследует выключенный interrupt**, а своя строка вообще не смонтируется. Поэтому в `coordinatorPreset` строка должна стать явной:

```ts
…hasControl
  ? []
  : [{
    id: THREAD_CONTROL_ROW_ID,
    name: row(PROJECT_PRESET_ROW_NAMES[THREAD_CONTROL_ROW_ID], '../../../subagent/tool-subagent-control/src/index.ts'),
    config: { interrupt: true },
  }],
```

и — главное — `rewriteRows` обязан **заменять** унаследованную базовую строку `tool-subagent-control` на свою (сейчас она не входит в `COORDINATOR_REPLACED_ROW_IDS`, база проходит насквозь со своим `interrupt: false`). Точнее: добавить в `rewriteRows` ветку `entry.id === THREAD_CONTROL_ROW_ID → [контрольная строка координатора с interrupt:true]`, сохранив позицию в группе, а `hasControl`-append оставить для композиций без базовой строки. Тест `shipped-standard.spec.ts` закрепляет ровно это (см. §1).

Строка конфига для пресета-декларации (`threads-profile/cordis.patch.yml` и снапшотных `cordis*.yml`) не нужна: `interrupt: true` задаётся билдером пресета, не YAML.

## 6. Чего не удалось проверить в этом предмержевом дереве

- **Компиляция и тесты rc.2-состава.** Дерево стоит на rc.1; `pnpm install`/`build` запрещены задачей, `node_modules` отсутствует. Все выводы о типах — из чтения исходников rc.2, не из `tsc`.
- **Фактический текст, который соберёт перенесённый форк-шов** (`tool-subagent` с `backgroundMode`/`handles`/`repository` поверх rc.2-каркаса): формулировки описания `subagent` и receipt для `thread`-провайдера — продукт задачи B (перенос шва), здесь зафиксированы только инварианты (receipt несёт Session id при D1).
- **Refresh-прогон снапшотов** (`DSH_SNAPSHOT=refresh`) не выполнялся: требует `lib/` и запуска `dsh`-CLI; правки §4 выписаны по исходникам, а не сверены с фактическим выводом раннера. Рекомендация мержу: после переноса шва выполнить refresh и принять его вывод как эталон, наши правки использовать как ожидаемую форму.
- **Точный текст `subagent:identity` в снапшоте** — имя автонумерации (`agent-1`) выведено из `SiblingNameReservations.reserve` без аргумента; живой прогон может пронумеровать иначе, если compose-порядок детей другой (в сценарии один ребёнок — безопасно).
- **Поведение `resolveName` на «похожем на id» имени** — проверено чтением (`includes('/')` → строгий отказ, иначе id-fallback), но не прогоном.
- **`hooks-claude-code`** (`agent_id: info.id`) собирается из `SubagentRunInfo`, чей Session id в rc.2 сохранён — тип ломаться не должен, но прогон пакета не делался.
- **Влияние на `packages/extensions/tool-cordis/src/api-catalog.ts`** (генерируемый каталог API упоминает `drainChildren`/`listChildren`): перегенерация — шаг 3 ранбука, здесь не проверялось.
