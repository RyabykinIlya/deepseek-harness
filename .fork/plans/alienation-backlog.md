# План отчуждения: ranked backlog выгрузки фич из апстримных файлов

Дата среза: **2026-11-04**. База замеров — пин апстрима `dsh-v0.2.2-alpha.2` (тег релиза alpha.2) плюс локальные коммиты линейки форка. Статус мёржа `rc.1`: мёрж идёт в параллельном Thread по `.fork/plans/upstream-0.2.2-rc.1-review.md` (окно апстрима: 466 коммитов, апстрим принял 2315 файлов). Этот документ — план после мёржа: спецификации читаются против текущего бейза и снабжены командой повторной верификации после слияния, чтобы точки, которые апстрим перепишет (готовитель заголовков, счётчик изображений, vendor Cordis 4.1.0), не инвалидировали план молча.

Цель — первый класс: форк должен трогать как можно меньше апстримных файлов, потому что каждый апстримный файл — будущий конфликт. Если одного пакета хватает способа обойтись расширением без правки апстримного файла, то сначала поиск, а не правка. Типовая постановка: вынести строку в бандл-профиль, регистрировать рендерер через существующий слот, объявлять контракт через `declare module`, либо держать пакет целиком своим. Как именно изготовить такой пакет — смотреть примеры «model-routing-profile», «web-search-profile» и шаблон в §4. Процедура conflict-first мёржа — [MERGE-RUNBOOK](../MERGE-RUNBOOK.md). Методика «три исхода на каждую правку апстримного файла»: убрать, вынести, сжать до шва — [merge-surface.md](merge-surface.md).

Проверка на хеши: коммитные хеши здесь не пишут — они уплывают при каждом мердж-форварде; вместо них коммиты именуются по теме. Числа датированы и привязаны к способу замера. Трудность (размеры `S`/`M`/`L`) — оценка. Снапшоты `snapshots/` никогда не перегенерируются: 137 записей с `recording: authored` восстанавливаются только вручную (требование ключа), поэтому любой план, который их переписывает, — не решен.

## 0. Сводная поверхность и способ замера

Поверхность — это пересечение ветки форка с апстримом: все файлы, которые ветка трогает поверх пина. Полный замер ниже получено командой:

```sh
git diff --name-status dsh-v0.2.2-alpha.2 HEAD | awk -F'\t' '$1=="M"{print $2}' | sort > /tmp/ours.txt
wc -l < /tmp/ours.txt        # 191 на срезе 2026-11-04
cut -d/ -f1-3 /tmp/ours.txt | sort | uniq -c | sort -rn | head -25
```

| Категория | Файлов (M) | Состав |
|---|---|---|
| A. Генерируемое | ~20 | `docs/*`, `.i18n.yaml`, `pnpm-lock.yaml`, `THIRD_PARTY_NOTICES.md`, `known-event-types.ts`, `slot-catalog.ts`, `api-catalog.ts`, `guest-source.ts`, `packages.md` |
| B. Точки регистрации | ~20 | `tsconfig.*.json` (3), `lefthook.yml`, `scripts/*` (8…10), `pnpm-workspace.yaml` |
| C. Правки апстримных пакетов | **145** | `src .ts/.tsx` **61**, апстримные тесты **46**, README **32**, прочее **6** |
| Прочее, не `packages/` | ~46 | `.agents/notes`, `docs/subsystems/*`, `.gitignore`, снапшоты (3) |
| **Итого M** | **191** | — |
| Добавленные внутри апстримных пакетов | **20** | невидимы в счёте M; теряются после апстримной реорганизации каталога |

Изменённых внутри `packages/` файлов — **145**: из них чисто `src`-код **61** — это содержательная цена мёржа. **46** апстримных тестов меняются вслед за кодом: убираешь правку кода — уходят и её тесты. Это значит, что цена зоны = код + тесты. Например, T7a снимает сразу ~11–15 файлов из `llm/llm-pi-ai`: 4 добавленных исходника чтения OpenRouter + 3 добавленных теста и фикстура OpenRouter + поля/адаптер/конфиг/мапстеры тестов, которые эти тесты накрывают. [merge-surface.md#вынаследованная-таблица](merge-surface.md#главное-правило)

Категория `C` по зонам в нашем срезе (M+A, внутри апстримных пакетов, включая добавленные): `llm/llm-pi-ai` **25**, `client/ui-chat` **16**, `client/ui-workspace` **15**, `subagent/subagent` **16** (14 M + 2 A), `subagent/tool-subagent` **12** (11 M + 1 A), `client/ui-settings-web-search` **13** (7 M + 6 A), `core/session` **8** (7 M + 1 A), `llm/llm` **8** (7 M + 1 A), `workflow/workflow-ptc` **6** M + `workflow/tool-workflow` **1** тест, `sdk/server` **2** теста, `test-support/{session-snapshot,client-runtime}` **5** (3+2 M), `web/web` **2** M, `web/web-search-*` — ноль (наши пакеты).

Три огромные зоны дают основную цену: `llm/llm-pi-ai` 25, `client/ui-chat` 16, `client/ui-workspace` 15. Историческое участие в конфликтах: мёрж `0.2.1-rc.2` — 52 структурно-конфликтовых файла, апстрим в тектовых конфликтах; в `rc.1`-окне апстрим пересекает много сотен файлов, но пересечение с форком — **80 файлов** (`comm -12 ours theirs | wc -l` из INVENTORY-методики; из них 27 — текстовые маркеры, 21 генерируемое/тривиальное). Тремя крупнейшими зонами совместно — **56** файлов поверхности-одно-в-одно (llm-pi-ai 7, ui-chat 10, ui-workspace 12 в `rc.1`-окне). Док уровня «27 маркеров» — из плана мёрж-Thread'а: файл `.fork/plans/upstream-0.2.2-rc.1-review.md` появится в этой ветке после слияния мёрж-ветки.

## 1. Специфика выгрузки по зонам

Формат на каждую зону: задетые апстримные файлы → доступный сегодня механизм → целевой пакет на нашей стороне (расширение какого существующего vs новый) → счёт файлов, которые пропадают из апстрима (M+A) → собственный (knock-on) эффект на тесты → труд/риск → критерии приёмки (grep/тесты). Все целевые пакеты, которые мы предлагаем открыть, обязаны иметь `dsh.bundle.patch` или `dsh.catalog` в своём манифесте (пример работы — `model-routing-profile` и `web-search-profile`): одностранична в §4.

### 1.1. Model routing: `llm/llm-pi-ai` + `llm/llm` + `llm/llm-retry` (T7a/T7b/T7c)

Текущие апстримные файлы (M+A=**25** в `llm/llm-pi-ai`, здесь знак «A» — добавлено внутри апстримного пакета):

| Файл | M/A | Зачем правка|
|---|---|---|
| `README.{i18n.yaml,md,zh.md}` | M×3 | README-пары |
| `src/adapter.ts` | M | `claude-proxy`, ротация ключей, `userAgentOverride`, `metadataUserId`, `withRouting`, `dispatch()` |
| `src/catalog.ts` | M | `modelRouting` в каталоге |
| `src/config.ts` | M | `apiKeys`, `keyCooldownMs`, `userAgentOverride`, `metadataUserId` маршрутов |
| `src/discovery.ts` | M | открытый каталог |
| `src/dispatch.ts` | A | `ctx.piAiDispatch`-сервис (84 строки) |
| `src/index.ts` | M | прошивка `dispatch`/`piAiDispatch` (`ctx.on('internal/config')`, `ctx.effect`) |
| `src/openrouter-catalog.ts` | A | чтение `GET /models` (`canonical_slug`) |
| `src/openrouter-endpoints.ts` | A | чтение endpoint-листа |
| `src/openrouter-http.ts` | A | общий GET, таймаут, потолок байт, коды ошибок |
| `src/replay.ts`, `src/stream.ts` | M×2 | реплей вывода |
| Тесты `adapter/catalog/config/convert/discovery/dynamic-config` | M×6 | покрывают правку кода |
| Тесты `dispatch/openrouter-catalog/openrouter-endpoints`, фикстура | A×4 | покрывают добавленные файлы |
| `tests/mock-server.ts` | M | мокует пининг OpenRouter |

Плюс `packages/llm/llm` (M+A=**8**): `src/assembler.ts` (дегенеративное схлопывание повтора текста, `collapseDegenerateRepetition`), `src/error.ts` (коды `KEY_QUOTA`, `CLIENT_GATE`, распознавание текста ошибки), `src/index.ts` (экспорт `collapseDegenerateRepetition`), `README`×3, `tests/collapse.spec.ts` A, `tests/service.spec.ts` M.

Плюс `packages/llm/llm-retry` (M=**4**): `src/index.ts` (сервис `ctx.llmRetryControl` + `wake(sessionId)`), `README`×3, тестов нет — самодостаточное приобретение, апстрим не трогал зону ни разу.

#### Механизм выгрузки (проверен в дереве)

- **T7a.** Подпакет внутри `packages/experimental/model-routing` (существующий пакет): файл `openrouter-*.ts` + тесты + `tests/fixtures/...` переезжают целиком. `dispatch.ts` при этом может остаться до T7c, потому что `registerAdapter` — шов, объявленный апстримом в `dsh-llm` [DECISIONS](../DECISIONS.md) (проверено 2026-11-04), значит ротация ключей может жить своим адаптером. После T7a из апстрима уходит 8 добавленных файлов (4 src + 3 теста + фикстура) и ~3 изменённых (остаток — до 8–9 M).

- **T7b.** Данный инструмент станет «готовителем заголовка» через штатный механизм `ctx.on('llm-pi-ai/request-headers')` — waterfall для замены `user-agent`: upstream ввёл `prepareHeaders` + waterfall + request-header context (коммит «allow plugins to prepare pi-ai request headers»); поэтому UA-override можно вынести в слушатель в `model-routing` с вызовом `next()`. Атрибуция (`attributionHeaders()`) применяется поверх плагинов, поэтому её держат конфиг-полем адаптера. T7b — частичная выгрузка: 0 файлов standalone, но снимает ~30 строк оверрайдов из ротации и готовит почву T7c.

- **T7c.** Адаптер ротации+маршрутов: наш собственный `LlmAdapter` через `ctx.llm.registerAdapter` (`registerAdapter` all-or-nothing, бросает `DUPLICATE_ADAPTER`, если маршрут занят, — маршруты надо СНИМАТЬ из конфига `llm-pi-ai`, не перекрывать). После T7a/T7b `llm-pi-ai` форк-проход сокращается до `config.ts` (наши маршруты+поля), `adapter.ts` (обёртка ротации), `index.ts` (регистрация `dispatch` ~90 строк). Пограничный чек: `AdapterRegistrationHandle.replace(providers)` — штатный способ менять набор маршрутов живьём. Целевой пакет — `packages/experimental/model-routing` (расширение) или новый пакет `packages/llm/model-routing-pi-ai-adapter` (если общность отдельной сущности нужна).

- **`llm/llm` и `llm/llm-retry`** выгрузка не имеет тривиального механизма: `collapseDegenerateRepetition` — durable log semantics (нельзя конфигурируемый порог, иначе миграционная верификация разъедется), и `KEY_QUOTA/CLIENT_GATE` определяются в `src/error.ts` и потребляются адаптером и диспетчером. `llm-retry.wake` — один файл (+92) за ноль конфликтов; держать `(c)`. Сжатие до шва возможно, только если апстрим даст публично вызываемое распознавание своих кодов ошибок (см. §3).

**Файлов исчезает из апстрима:** T7a −8 (A) и −3…6 M → `llm-pi-ai` M-поверхность 17→~9 после T7a, затем полное −~15 M из пакета после T7c (суммарно **на 25 файлов экономится ~19–21** с учётом README = апстримный вид `llm-pi-ai` полностью; если ограничиться T7a/T7b — экономия чуть меньше). T7b standalone — 0 файлов, ~30 строк. `llm/llm` и `llm-retry` — 0 (не выгрузятся).

**Knock-on на тесты:** апстримный тест-сюит `llm-pi-ai` (adapter/config/discovery/моку-сервер) уменьшится пропорционально: T7a выносит 4 тестовых файла из предыдущего перечисления (+tests/openrouter-*.spec ×2 + фикстура + dispatch). Сегодняшние 46 upstream-тестов М-файлов C-категории (по срезу) станут меньше на 3 тестовых узла в `llm-pi-ai` (adapter/catalog/config тестовые переписываются поверх вывезенной ротации) после T7c.

**Труд (оценка):** T7a — **M** (1–2 дня: перенос трёх клиентов, правка mock-server и фикстуры), T7b — **S** (полдня), T7c — **L** (2–3 дня плюс перевод профиля `claude-proxy` и `xiaomi-token-plan-sgp` на свой адаптер и живые пробы).

**Риск:** смена поведения профилей (`attributionHeaders()`, пиннинг маршрута, живые пробы). Апстрим в окне `rc.1` открыл шов `prepareHeaders` с waterfall для плагинов — готовый канал для трансформаций заголовков; `internal/config`-прошивка в `llm-pi-ai/src/index.ts` могла смениться — шаг 2 T7c перепроверяется после мёржа.

**Приёмка T7a:** `pnpm vitest run packages/experimental/model-routing packages/llm/llm-pi-ai` зелёный; `git diff origin/master -- packages/llm/llm-pi-ai` без наших добавленных файлов (кроме dispatch-остатка, он идёт после T7c); `ReplayProvider` по-прежнему через `ctx.piAiDispatch`. **Приёмка T7c:** `git diff dsh-v0.2.2-rc.1 -- packages/llm/llm-pi-ai` пуст; маршрут `claude-proxy` работает с двумя ключами и уходит на 2-й на `KEY_QUOTA`; `metadataUserId` уходит в теле; в запросе есть `attributionHeaders()`, как требует контракт `LlmAdapter`. **Re-verify после мёржа:** `git diff origin/master -- packages/llm/llm-pi-ai | wc -l` перед каждым шагом T7a/b/c.
### 1.2. `client/ui-chat` — строка пользовательского сообщения (T6)

Задетые файлы (M=**15**, замер 2026-11-04): `apply.ts` (+67/−8: `forkFrom`, `restoreAt`), `contract/slots.ts` (+15: `restoreAt` в `ChatNodeOwnerProps`), `chat/MessageIconActions.tsx` (+19/−5: проп `onRestore`), `chat/MessageItem.tsx`, `chat/ChatView.tsx`, `chat/ChatFlow.tsx`, `chat/ChatNodeSeat.tsx`, `conversation-nodes/message.ts`, `locale.ts`, README×3, тесты×4 (`apply-inject`, `chat-branch-tails`, `chat-view`, `process-groups`). Правка протянула проп `onRestore` через всю цепочку рендера — слота для действий над пользовательским сообщением в апстриме нет.

**Механизм (проверен 2026-10-10, повторить после мёржа):** апстримный слот `conversation.chat.node` — `kind: 'keyed'`, ключ = `ChatNodeKind`; «Registering an already-occupied key replaces that occupant». Строка пользовательского сообщения — ключ `user`; рисует её `MessageItem.tsx`, из пакета не экспортируется. `forkAt` в `ChatNodeOwnerProps` есть в апстриме, нашим был только `restoreAt`. Прецедент регистрации своего рендерера — `packages/experimental/client-ui-model-routing`.

**Исходы:** (1) свой клиентский пакет регистрирует `{ name: 'conversation.chat.node', key: 'user' }` и рисует строку сам, «Restore» зовёт публичные `ctx.sessions.fork` и `conversation.input.requestDraftInitialization` — апстримный дифф **0 файлов**, но мы владеем презентацией строки (вложения, ссылки, редактирование, скиллы) и обязаны её догонять; (2) признать форк `ui-chat` — 15 файлов навсегда. Исход 1 помечен в каталоге слотов как `shadows-shipped-ui`.

**Целевой пакет:** новый `packages/experimental/client-ui-chat-user-row` (шаблон §4) при исходе 1. **Файлов исчезает:** исход 1 — до 15; исход 2 — 0. **Knock-on:** 4 апстримных тестовых файла уходят при исходе 1.

**Труд (оценка):** исход 1 — **L** (день плюс обязательная живая проверка паритета строки); исход 2 — 0. Решение за владельцем — [merge-surface.md#t6](merge-surface.md). **Риск:** копия строки отстаёт от апстримной; это цена, записанная в каталоге слотов, а не скрытая.

**Приёмка (исход 1):** «Restore» работает (форк от сообщения, текст в композер, аналитическое событие); вложения, ссылки, редактирование и «fork from here» ведут себя как в апстриме; `git diff <база> -- packages/client/ui-chat` пуст. **Re-verify после мёржа:** `git diff --name-status <пост-мёрж-база> HEAD -- packages/client/ui-chat | wc -l`; `grep -n "keyed" packages/client/ui-chat/src/client/contract/slots.ts` — слот по-прежнему `keyed` по `ChatNodeKind`.

### 1.3. `client/ui-workspace` — вложение Thread'ов под строкой Project

Задетые файлы (M=**15**): `tree.ts` (+113, ядро правки), `rows/Rows.tsx` + `Rows.module.css`, `rows/WorkspaceBrowser.tsx` + `.module.css`, `client/index.ts`, `contract/slots.ts`, `locales.ts`, README×3, тесты×4 (`apply`, `rows`, `tree`, `workspace-browser`).

**Механизм:** слота для дочерних строк под строкой сессии в каталоге нет (проверено 2026-10-10: все 92 ключа каталога просмотрены). `sidebar.workspaces` — слот `single`, занят `WorkspaceBrowser`; переиспользование ключа означало бы переписывание всей области браузера. Механика «ключ + замена рендерера» в репозитории принята (`conversation.chat.node`), но аналогичного ключевого слота у дерева сессий нет.

**Исход: принять форк** (рекомендация [merge-surface.md](merge-surface.md), вопрос владельца №3) и записать причину в `DECISIONS.md`. **Файлов исчезает: 0. Труд:** —. **Knock-on:** тесты остаются нашими.

**Приёмка:** вложенные Thread'ы видны под строкой Project; фолды/раскрытие работают. **Re-verify после мёржа:** `git diff --name-status <пост-мёрж-база> HEAD -- packages/client/ui-workspace | wc -l` — 15; просмотреть апстримный дифф зоны на предмет появления слота для дочерних строк (появился — вопрос переоткрывается).

### 1.4. `subagent/*` — continuable-проводка и рабочие деревья (T13 — переименование `ctx.worktrees`)

Задетые файлы: `packages/subagent/subagent` — **14 M + 2 A** (`src/{child-agent,continuation-messages,control-types,control,index,manager,out-of-process,types}.ts`, README×3, тесты×4 M + `continuation-provider-spec.spec.ts` A + фикстура `preset-tool.js` A); `tool-subagent` — **11 M + 1 A** (`src/index.ts` +511: `allowedModels`, `backgroundMode`, `repository`, `preset-selection.ts`, `package.json`, `tsconfig.json`, README×3, тесты×5 M + `allowed-models.spec.ts` A). Плюс наши новые пакеты внутри апстримного каталога `packages/subagent/`: `subagent-thread-worktree` (7 файлов A) и `worktree-manager` (13 файлов A, сервис `ctx.worktrees`).

**T13 — приоритет P0, делается до завершения мёржа.** Оба наших пакета и ключ сервиса `ctx.worktrees` сидят в каталоге, по которому проходит окно `rc.1` (2315 файлов); коллизия имени сервиса или каталога в этом окне — самый дорогой возможный конфликт плана. Шаги: выбрать имя, не пересекающееся с апстримным (сервис `ctx.threadWorktrees` или пакет `packages/experimental/thread-worktrees`), переименовать пакет/ключ, поправить `dsh.catalog.service.after` в `packages/experimental/threads/package.json` (сейчас `after: "worktree-manager"`), профильные бандлы и README-трио. **Труд (оценка):** **M** (полдня–день, механический переезд).

**Приёмка:** `grep -rn "ctx.worktrees" packages .fork --include=*.ts --include=*.yml | wc -l` — ноль в апстримных пакетах; `pnpm vitest run packages/experimental/threads packages/subagent/worktree-manager` зелёный. **Re-verify после мёржа:** тот же grep против пост-мёрж-базы — если апстрим завёл свой `worktrees`, переименование уже покрыло его.

**Continuable-проводка (`continuation-messages.ts`, `control.ts`, `manager.ts`, `child-agent.ts`) — не выгружается:** это сквозная механика делегирования; выгрузка означала бы копирование `manager.ts` целиком (см. §3). Фичи `allowedModels`/`backgroundMode`/`repository` в `tool-subagent` — осознанный форк продукта ([merge-surface.md, «Что не уедет никогда»](merge-surface.md)); их тесты идут следом. **Файлов исчезает: 0.**

### 1.5. `core/session` — `appendIgnorable` (T9, разобрано)

Задетые файлы (M+A=**8**): `src/index.ts` (+21/−15), `src/types.ts` (+13), `src/known-event-types.ts` (+5, **генерируемый**), `package.json`, README×3, тест `tests/append-ignorable.spec.ts` A (+94).

**Разбор (по дереву 2026-11-04):** `known-event-types.ts` генерируется `scripts/gen-persistence-catalog.ts` из наших же объявлений `SessionEventMap` (`model-routing/*`, `thread/*`) — поверхность от него **0**; шаг «снять пять строк» отменён 2026-10-10. `index.ts`/`types.ts` — настоящий шов ядра: `append()` принял `AppendOptions` с `{ ignorable: true }` — маркер конверта, позволяющий читателю, не знающему `type`, пропустить событие вместо отказа от лога. Это нужно любому плагину с лог-only событиями — апстримная форма шва, а не частность model routing. Альтернатива (`PluginRecordMap` + `appendPluginRecord()`) — крупная переделка журнала, фолдов и снапшотов, в план не входит.

**Исход: держать** (§3). **Файлов исчезает: 0. Труд:** разбор потрачен; далее — перечитывать диффы при мёржах (пара часов).

**Приёмка/Re-verify после мёржа:** `pnpm run verify-persistence-catalog` зелёный; `git diff --name-status <пост-мёрж-база> HEAD -- packages/core/session | wc -l` — 8; события `model-routing/*` и `thread/*` пишутся с `ignorable: true`; снапшоты Threads проходят.

### 1.6. `client/ui-settings-web-search` + `web/web` — своя карточка выбора провайдера (T5)

Задетые файлы: `ui-settings-web-search` **7 M + 6 A** (добавлены `WebSearchSelectionCard.tsx`/`.module.css`, `web-search-selection-controller.ts`, тесты `provider-fields`, `selection-card`, `selection.controller`; изменены `client/index.ts` +85, `web-search-card-controller.ts` +227, `WebSearchCard.tsx` +61, `locales.ts` +56, тесты `apply`/`card`/`controller`) плюс `packages/web/web` **2 M** (`src/index.ts` — `WEB_SEARCH_PROVIDER_IDS`, `tests/web.spec.ts`). Итого зона **15 M+A** — крупнейшая решаемая после `llm-pi-ai`.

**Механизм (проверен, прецедент наш):** `packages/experimental/client-ui-model-routing` регистрирует свою карточку в слот `plugins.item` и не трогает чужой контроллер; цикл «по карточке на провайдера» уже написан в нашем `index.ts` (`ctx.configForms.whileServed([provider.namespace], …)`). Шаги из [merge-surface.md#t5](merge-surface.md): перенести селектор, его контроллер и локали в свой пакет; вернуть апстримные `WebSearchCard.tsx`, `web-search-card-controller.ts`, `locales.ts`, `client/index.ts`; каждый провайдер регистрирует свою карточку своей строкой; судьба `WEB_SEARCH_PROVIDER_IDS` — по [web-search.md](web-search.md) список нужен только выпадашке: если её рисует наш селектор, список снимается.

**Целевой пакет:** новый `packages/experimental/client-ui-web-search-selection` (шаблон §4); профильная часть остаётся в `web-search-profile`. **Файлов исчезает: ~15** (13 + 2). **Knock-on:** 6 тестовых файлов переезжают в наш пакет; апстримные `card`/`controller` тесты возвращаются к апстримному виду.

**Труд (оценка):** **M** (день). **Риск:** поведение выпадашки провайдеров; локали остаются двуязычными в нашем пакете.

**Приёмка:** `git diff <база> -- packages/client/ui-settings-web-search` пуст; в живом профиле три провайдера выбираются мышью; `WEB_PROVIDER_CONFIGURED_MISSING` по-прежнему сообщает о неизвестном id. **Re-verify после мёржа:** пересчитать дифф зоны; убедиться, что апстрим не завёл собственный селектор провайдеров (тогда задача упрощается до переноса).

### 1.7. `web/web` fetch — `trustedProxyAddressRanges` (T8 — снято)

**Статус: закрыто апстримом (2026-10-28).** Апстрим в `dsh-v0.2.2-alpha.2` сам снял запрет на непубличные адреса (`HttpFetchProvider` без валидатора адресов) — ровно сценарий, ради которого писалось поле. Наш код из апстримного пакета ушёл мержем, хвост (`web-search-profile` больше не переопределяет удалённый ключ) убран в том же окне. **Файлов исчезает: 0 — уже ушло −7.** Запись сохранена, потому что объясняет, почему в зоне нечего делать: `packages/web/web-fetch-http` — наш новый пакет (16 файлов A), а не правка апстрима. **Re-verify после мёржа:** `git diff --name-status <пост-мёрж-база> HEAD -- packages/web | grep -v 'web-fetch-http\|web-search-' | wc -l` — только `web/web` (2 файла до T5).

### 1.8. `test-support/*`, `workflow/*`, `sdk/server` — фикстуры наших фич

Задетые файлы (M=**12** суммарно): `test-support/session-snapshot` — `src/index.ts`, `src/normalize.ts`, `tests/normalize.spec.ts`; `test-support/client-runtime` — `src/remote.ts`, `tests/remote.client.spec.ts`; `workflow/workflow-ptc` — `src/guest-source.ts` A (**генерируемый**, категория A) + тесты×5 M; `workflow/tool-workflow` — `tests/tool-workflow.spec.ts`; `sdk/server` — тесты×2 (`built-scope-carrier.e2e.ts`, `server.spec.ts`).

**Механизм:** это тест-харнесс наших снапшотов и каталогов выбора репозитория — правки следуют за фичами и уходят только вместе с ними ([merge-surface.md, «Что не уедет никогда»](merge-surface.md)). Отдельная выгрузка не оправдана: 5 файлов, текстовых конфликтов пока ноль. Нормализационные правила для наших событий в `normalize.ts` — кандидат на перенос в пакет-владелец фичи, но только по триггеру: апстримный конфликт на этом файле или рост счётчика ниже. **Файлов исчезает: 0 (триггерная задача). Труд:** — до триггера; **S** после (перенос правил нормализации).

**Re-verify после мёржа:** `git diff --name-status <пост-мёрж-база> HEAD -- packages/test-support | wc -l` — 5; при росте — открывать перенос правил.

### 1.9. Прочие зоны: `mcp-client`, `llm/llm`, `llm-retry`, обвязка `subagent`

- **`mcp/mcp-client` — 2 M + 1 A**: `src/connection.ts` (+`recoverSession`, +`SESSION_RECOVERY_TIMEOUT_MS` = 10 с), `src/tools.ts`, тест `session-recovery.spec.ts` A. Восстановление протухшей сессии внутри одного tool-call, фейл вместо стоянки. Держим (§3): правка поведения апстримного клиента в его же методах, выгрузке не подлежит.
- **`llm/llm` — 4 M + 1 A**: `assembler.ts` (`collapseDegenerateRepetition`), `error.ts` (`KEY_QUOTA`, `CLIENT_GATE`), `index.ts` (экспорт), `tests/collapse.spec.ts` A, `tests/service.spec.ts` M. Схлопывание вырожденного повтора — семантика durable-лога, порог не конфигурируется. Держим (§3).
- **`llm/llm-retry` — 4 M**: `src/index.ts` (+92: `ctx.llmRetryControl` + `wake(sessionId)`), README×3, своих тестов нет. Один файл, ноль исторических конфликтов — держим (§3).
- **`packages/subagent/README.{md,zh.md}`** и `subagent-acp`/`subagent-dsh-sdk`/`subagent-spawn-in-process`/`subagent-fork-in-process` (4 M + 2 тестовых M) — проводка continuable и новых опций через остальные входы `subagent`; идут вместе с §1.4, отдельной задачи нет.
- **`packages/llm/llm-fallback` — 16 файлов A** — наш новый пакет внутри апстримного каталога `packages/llm/`. Риск только каталоговый (апстрим может завести свой `llm-fallback`); наблюдать, не переезжать превентивно.

## 2. Ranked backlog

Ранг = (файлов из апстрима × частота конфликтов зоны) / труд. Частота — из окна `rc.1` (пересечение с форком 80 файлов, [merge-surface.md](merge-surface.md)) и истории мёржа `0.2.1-rc.2`. Труд — оценка.

| № | Задача | Файлов из апстрима | Почему в этом ранге | Труд |
|---|---|---|---|---|
| 1 | **T13. Переименование `ctx.worktrees`** (§1.4) | 0 (устраняет коллизию 20 файлов A + ключа сервиса в окне мёржа) | P0-блокер: единственная задача, которую надо закрыть **до** завершения мёржа `rc.1` | M |
| 2 | **T5. Своя карточка Web Search** (§1.6) | ~15 | крупнейшая решаемая зона, механизм готов и прецедентирован | M |
| 3 | **T7b. UA/заголовки через `prepareHeaders`** (§1.1) | 0 standalone, ~30 строк из `adapter.ts` | шов свежий в `rc.1` — делать, пока дифф мал; разблокирует №7 | S |
| 4 | **T7a. Клиенты OpenRouter в `model-routing`** (§1.1) | ~11 (8 A + 3 M) | решено в DECISIONS, исполняется локально, без апстримных зависимостей | M |
| 5 | **T6. Свой рендерер строки `user`** (§1.2) | до 15 (исход 1) / 0 (исход 2) | большой выигрыш, большой труд + обязательная живая проверка паритета; решение владельца | L / 0 |
| 6 | **test-support: правила нормализации** (§1.8) | 5 (триггерная) | маленькая, дешёвая, чинит потенциальный конфликт в `normalize.ts` | S |
| 7 | **T7c. Свой `LlmAdapter` маршрутов** (§1.1) | ~11–14 (остаток `llm-pi-ai`) | завершает уход из `llm-pi-ai`, но требует перевода профиля и живых проб | L |
| 8 | **T11. Заметки и docs в `.fork`** | ~15–25 из зоны `.agents`+`docs` | дешёвое сокращение невидимой поверхности | S |
| 9 | **T4. Алиасы `tsconfig.base.json`** | принять (0) | 12 строк вне генерируемой зоны; конфликт тривиальный, переименование пакетов дороже | — |
| 10 | **T12. Снапшоты** | принять (0) | 137 сценариев `recording: authored` не перегенерировать; мержить построчно | — |

**Суммарный потенциал сокращения: 51–56 файлов M+A** из 211 (191 M + 20 A, срез 2026-11-04): T5 ~15 + T7a ~11 + T7c ~12–14 + test-support ~5 = 43–45 безусловных, плюс T6 до 15 при исходе 1 → 51–56 (часть `llm-pi-ai` остаётся до полного T7c). Исполнение — по факту: каждая задача отдельным коммитом, поверхность перемеряется до и после ([merge-surface.md, «Как принимать работу»](merge-surface.md)).

**Диспозиция задач merge-surface.md на срез 2026-11-04:**

| Задача | Статус | Комментарий |
|---|---|---|
| T1 `repository` опциональна | исполнено | 181 → 166 файлов (2026-10-10) |
| T2/T3 генерируемые списки | исполнено | переехали в шаг 1 ранбука; `api-catalog.ts`, `composition.md` — наши, не мержить руками |
| T5 карточка Web Search | в силе | §1.6, ранг 2 |
| T6 рендерер строки | в силе, ждёт владельца | §1.2, ранг 5; исход 1 vs 2 |
| T7a/b/c уход из `llm-pi-ai` | в силе, разбита | §1.1; порядок b→a→c; шов `prepareHeaders` упростил b |
| T8 fetch-провайдер | **снята** | закрыта апстримом 2026-10-28, §1.7 |
| T9 `core/session` | разобрана | `known-event-types` генерируемый (0); `appendIgnorable` — шов ядра, держим, §1.5 |
| T10 `dsh.catalog` | исполнено | поле живёт в `packages/experimental/threads/package.json`, проверено в дереве 2026-11-04 |
| T11 docs/notes → `.fork` | в силе | §4 и ранг 8 |
| T12 снапшоты | принять | ранг 10 |
| T4 алиасы tsconfig | принять | ранг 9 |
| **T13 `ctx.worktrees`** | **новая, P0** | введена этим планом, §1.4 |

## 3. Что держим у себя в апстримных файлах (must stay)

Правки, которые **не** выгружаются — швы ядра, семантика лога или осознанный форк продукта. Для каждой указан шов, разблокирующий выгрузку, если он когда-нибудь появится:

| Правка | Файлы | Почему держим | Шов апстрима, который разблокировал бы |
|---|---|---|---|
| `llmRetryControl` + `wake(sessionId)` | `llm-retry/src/index.ts` (+92) | управление повтором снаружи плагина; ноль конфликтов | не нужен — цена владения ниже цены шва |
| continuable-проводка subagent | `subagent/src/{control,manager,child-agent,continuation-messages}.ts` | сквозная механика делегирования; копирование = форк менеджера | апстримный хук между `manager` и child-agent (появления не ждём) |
| форк браузера `ui-workspace` | 15 файлов (§1.3) | слота для дочерних строк нет; замена = переписывание браузера | ключевой слот дерева сессий в каталоге слотов |
| `collapseDegenerateRepetition` + коды `KEY_QUOTA`/`CLIENT_GATE` | `llm/src/{assembler,error,index}.ts` | семантика durable-лога; порог не конфигурируется | публично вызываемое распознавание кодов ошибок из `dsh-llm` |
| `appendIgnorable` (`AppendOptions`) | `core/session/src/{index,types}.ts` | шов ядра для любых лог-only событий плагинов | альтернативный `appendPluginRecord()`-механизм (крупная переделка) |
| session-recovery MCP | `mcp-client/src/{connection,tools}.ts` | восстановление сессии в рамках одного tool-call, фейл вместо стоянки | конфигурируемая политика восстановления в апстримном клиенте |
| `withRouting` + `claude-proxy` + `dispatch()` | `llm-pi-ai/src/{adapter,config,index,catalog,discovery,replay,stream}.ts` | держится до T7c; после T7a/T7b остаток сжимается до регистрации dispatch | полный T7c (свой адаптер) — тогда всё уходит |

## 4. Гигиена точек регистрации (быстрые выигрыши)

Точки регистрации — файлы категории B: они почти всегда мержатся механически, но именно они ломают сборку при конфликте. Проверено в дереве 2026-11-04:

- **Шаблон манифеста fork-пакета.** Каждый наш пакет несёт `dsh.bundle.patch` (прецеденты: `packages/experimental/model-routing-profile/package.json`, `packages/web/web-search-profile/package.json`) и, если регистрирует сервис/инструмент, `dsh.catalog.service` с `key`, `title`, `after`, `consumers`, `note` (прецедент: `packages/experimental/threads/package.json`). Тогда `gen-tool-catalog` и `gen-doc-graphs` собирают списки обходом воркспейса — правки самих скриптов не растут (T10 исполнено). Новый пакет из §1.2/§1.6 заводится по этому шаблону сразу.
- **`scripts/catalog-declarations.ts`** (наш, A) — вынесенные декларации каталога. Держать его единственным местом, куда добавляются наши записи; не размазывать по генераторам.
- **`tsconfig.base.json`** — 12 наших строк вне генерируемой зоны (292, 325–340): это конвенция апстрима для экспериментальных имён (`dsh-experimental-*`, `dsh-client-ui-*`), T4 — принять. `tsconfig.client.json`/`tsconfig.host.json` — проверить, что наши добавления тоже вне генерируемой зоны, иначе переехать в генерируемую часть.
- **`lefthook.yml`** — каждый наш гейт подключается одной добавленной строкой хука; при мёрже конфликт решается взятием обеих сторон. Не переписывать чужие блоки.
- **`scripts/product-package-policy.ts`, `check-workspace-constraints.ts`, `verify-package-readme-model-experience.ts`, `type-equiv.manifest.json`, `rescope-vendor.ts`** — наши добавления в гейтах и манифестах; держать их аддитивными (новая ветка проверки, новая строка манифеста), не инлайнить в апстримные функции.
- **Быстрые выигрыши (S каждый):** (1) README-трио (`README.md`, `README.zh.md`, `README.i18n.yaml`) есть у каждого fork-пакета — иначе гейт README-парности падает и порождает правку чужого скрипта; (2) всё, что гейты хотели бы сканировать, но что принадлежит только форку, живёт в `.fork/` — гейты её не сканируют; (3) при заведении нового пакета сразу вписать его строкой вида соседей в управляемую зону воркспейса.

## 5. Повторная верификация после мёржа `rc.1`

База для всех диффов ниже — пост-мёрж-пин (тег `dsh-v0.2.2-rc.1` или явный SHA из мёрж-ветки); из worktree `origin/master` — это мастер форка, сравнение с ним не годится:

```sh
# 0. полная поверхность до/после каждой задачи
UPSTREAM=<пин-после-мёржа>
git diff --name-status $UPSTREAM HEAD | awk -F'\t' '$1=="M"{print $2}' | sort > /tmp/ours.txt
wc -l < /tmp/ours.txt   # стартовая точка: 191 на 2026-11-04

# 1. зонные счётчики (ожидания до исполнения плана)
for z in llm/llm-pi-ai llm/llm llm/llm-retry client/ui-chat client/ui-workspace \
         client/ui-settings-web-search subagent core/session mcp/mcp-client \
         test-support web/web workflow sdk/server; do
  printf '%-32s' "$z"; git diff --name-status $UPSTREAM HEAD -- "packages/$z" | wc -l
done

# 2. швы, от которых зависят спецификации
grep -rn 'DUPLICATE_ADAPTER\|registerAdapter' packages/llm/llm/src/index.ts | head
grep -rn 'prepareHeaders\|request-headers' packages/llm/llm-pi-ai/src | head      # жив ли шов T7b
grep -n 'keyed' packages/client/ui-chat/src/client/contract/slots.ts               # слот T6
head -3 packages/core/session/src/known-event-types.ts                             # GENERATED-шапка
grep -rn 'ctx.worktrees' packages --include=*.ts | grep -v worktree-manager | grep -v thread-worktree  # коллизия T13

# 3. гейты
pnpm run verify-persistence-catalog && pnpm run gen-tool-catalog --check \
  && pnpm run gen-doc-graphs --check && pnpm run verify-cordis-api && pnpm run doc-sync
```


Если шов `prepareHeaders` не пережил мёрж — T7b перепроектируется до T7c (приоритеты №3/№7 меняются местами). Если в `slots.ts` `ui-chat` или `ui-workspace` появился новый ключевой слот — вопросы T6 и §1.3 переоткрываются с новым механизмом.

## 6. Непроверенное (честный остаток)

- **Коллизия `ctx.worktrees` со стороны апстрима** — список файлов окна `rc.1` в этой ветке отсутствует (файл мёрж-Thread'а не смёржен); P0-ранг основан на факте, что наши пакеты сидят в апстримном каталоге `packages/subagent/`. Проверяется пунктом 2 §5 сразу после мёржа.
- **Живой путь `prepareHeaders`/request-header waterfall в `llm-pi-ai`** — взят из заметок мёрж-разбора, в дереве этого бейза не исполнялся; проверяется тем же пунктом 2 §5.
- **Паритет копии строки `user` (T6, исход 1)** — требует живого приложения (вложения, ссылки, редактирование, скиллы); документами не решается.
- **Состав зоны `.agents` + `docs` (~81 строк diff на срез)** — не разложена на «наши фичи» vs «окно апстрима»; разложение даёт `comm` из §5 и уточняет ранг 8.

*Все числа датированы 2026-11-04 и привязаны к командам замера выше; труд — оценка. Коммитные хеши в документе не пишутся — только имена задач и теги.*

