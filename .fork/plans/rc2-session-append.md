# A6: `AppendOptions`/`ignorable` в `core/session` против rc.2

Замерено 2026-11-12 в worktree-чекауте до мержа (пин `dsh-v0.2.2-rc.1` = `66491b05e3`, target `dsh-v0.2.2-rc.2` = `ddac96760b`). Вопрос из [upstream-0.2.2-rc.2.md, п. 5 таблицы](upstream-0.2.2-rc.2.md): снимается ли форк-правка `AppendOptions`/`{ignorable:true}` апстримом.

**Вывод коротко: не снимается.** Апстрим не привёз ни эквивалента вызова `session.append(type, data, {ignorable:true})`, ни разрешения писать ignorable-события из релизных пакетов. Его механизм (`appendPluginRecord`) — другой шов: только `plugin:`-неймспейс, только `packages/experimental/`, только best-effort при миграции формата. Рекомендация — **B: держать правку**, причина перезаписана (см. §2 и §4). Мёрж-конфликт при этом минимален: 2 ханка в `packages/core/session/src/index.ts`, оба решаются стороной апстрима, после чего шов возвращается пятью точечными вставками — одна в `src/types.ts`, четыре в `src/index.ts` (§5).

## 1. Механизм апстрима не новый в окне

- `appendPluginRecord`/`pluginRecordOf` **байт-в-байт одинаковы в rc.1 и rc.2**: `git diff rc.1 rc.2 -- packages/core/session/src/index.ts` не содержит их строк, doc-комментарий «Only production source under `packages/experimental/` may call this function…» идентичен.
- В дереве форка на момент появления `AppendOptions` их **не было**: `git show 37521fe337:packages/core/session/src/index.ts | grep appendPluginRecord` → 0 (`37521fe337`, 2026-10-02, «feat(subagent): let a continuable provider choose the child's cwd» — коммит, вводящий `AppendOptions`). Апстримный коммит `75542dd10a` «feat(session): let experimental packages append plugin records» датирован 2026-10-04; в дерево форка механизм приехал мержом alpha.2 2026-10-28. Форк выбирал шов до того, как увидел альтернативу.
- Окно rc.1→rc.2 по этой зоне не меняет механику, только обвязку: `verify-plugin-record-callers.ts` (+13 строк — в список допущенных файлов вошёл `scripts/plugin-entry-existing-exports.ts`), `experimental-package-policy.ts` (+63 — функция `experimentalPackageRecordNamespace`, производящая owner-неймспейс из npm-имени), README `core/session` переформулировал правило имени (`plugin:<owner>/<record>`, owner = имя после снятия префикса `@deepseek-ai/dsh-experimental-`). Гейт включён в общий прогон: `scripts/run-gates.ts:421`.

### Сравнение механизмов

| Аспект | Форк: `append(type, data, {ignorable:true})` | Апстрим rc.1=rc.2: `appendPluginRecord(session, type, data)` |
|---|---|---|
| Где живёт API | метод `Session.append`; правка ядра (2 файла + тест) | свободная функция `@deepseek-ai/dsh-session`; ядро не правится |
| Неймспейс типа | любой ключ `SessionEventMap` (`model-routing/decision`, `thread/created`) | только `plugin:<owner>/<record>`; грамматика `PluginRecordType` (`types.ts:537`), owner выводится из npm-имени (`plugin:model-routing/…`, `plugin:threads/…`) |
| Объявление | `declare module … { interface SessionEventMap }` → имя попадает в генерируемый `KNOWN_SESSION_EVENT_TYPES` и `docs/persistence-catalog` | `declare module '@deepseek-ai/dsh-session/types' { interface PluginRecordMap }` → попадает в `docs/experimental-persistence-catalog`; имя в `SessionEventMap` в `plugin:`-неймспейсе генератор каталога отвергает |
| Кому можно писать | любой пакет | только `packages/experimental/` production-код; гейт `verify-plugin-record-callers` («A release package declares its events in SessionEventMap instead of writing plugin records»), каталог-коллектор дополнительно требует experimental-владельца |
| Возврат | `SessionEvent<T>` — типизированный payload + `seq`/`time` | `SessionSeq` — только номер; payload читается через `pluginRecordOf(event)` → `PluginRecord { type, seq, time, data: unknown }`, owner валидирует сам (`data: unknown` «carries whatever JSON an earlier build of its owner wrote») |
| Чтение | фолд по `event.type` со сужением payload через `SessionEventMap` | `pluginRecordOf` + собственная валидация payload владельцем |
| Конверт | `ignorable: true` | тот же `ignorable: true` — маркер один на оба механизма |
| Миграция формата | rc.2 переименовывает неизвестные ignorable-события только при переходе V3→V4 (`namespaceV3OpaqueEvent`, `session-format-v3-to-v4/src/extension-identities.ts:75`) | тот же край, плюс каталог experimental ведёт записи как best-effort: «a Session format migration retains records on a best-effort basis» |
| Равноформатное чтение лога с неизвестным типом | skip по маркеру (`validateStoredEvents`) | то же самое — отличие только в писателе и типизации, не в читателе |

Гайд окна о `append` один — `v0.2.2-rc.1/session-append-overloads` (массивная перегрузка + `SessionEventInput`), про ignorable/plugin-record он не говорит: апстрим не считает, что в этом окне что-то изменилось для писателей ignorable-событий.

## 2. Записанная причина

Причина **записана** — в трёх местах, все о выборе механизма для наших событий, не о правке ядра как таковой:

- [alienation-backlog.md §1.5](alienation-backlog.md): «`index.ts`/`types.ts` — настоящий шов ядра… Это нужно любому плагину с лог-only событиями — апстримная форма шва, а не частность model routing. Альтернатива (`PluginRecordMap` + `appendPluginRecord()`) — крупная переделка журнала, фолдов и снапшотов, в план не входит».
- там же §3, таблица «не выгружаются»: «шов ядра для любых лог-only событий плагинов | альтернативный `appendPluginRecord()`-механизм (крупная переделка)».
- [DECISIONS.md](../DECISIONS.md): «Убрать эти имена из выпущенного словаря можно только сменой механизма — объявлять в `PluginRecordMap` под неймспейсом `plugin:` и писать через `appendPluginRecord()`. Это крупная переделка журнала, фолдов и снапшотов».

Хронология уточняет картину: `AppendOptions` добавлен 2026-10-02, `appendPluginRecord` появился в апстриме 2026-10-04 и приехал в дерево форка 2026-10-28; формулировка «альтернативы нет/дорого» писалась уже после знакомства (§1.5 датирован разбором 2026-11-04), так что причина осознанная, а не слепая.

Перепроверка этой причины по дереву даёт два уточнения:

1. **«Крупная переделка журнала, фолдов и снапшотов» устарела — для `experimental/*` она не подтверждается.** Ядро `appendPluginRecord` не расширяет: `#appendRecord` — ~20 строк рядом с `append` (`src/index.ts:929`), конверт, сидинг и `adoptSessionEvent` не тронуты, а событие на диске то же, что пишет наш шов — неизвестное ignorable-событие. Тяжесть альтернативы лежит не в ядре, а в наших пакетах: переименование семи типов, перенос объявлений из `SessionEventMap` в `PluginRecordMap`, переход читателей с сужения payload на `pluginRecordOf` + валидацию, правка снапшотов `threads-project-worktree{,-tiers}` (3 ignorable-строки в каждом) и переиздание persistence-ack'ов. Это заметная, но перечислимая работа, а не «крупная переделка журнала».
2. **Для `llm/fallback` причина верна и остаётся решающей** — см. §4.

Формулировки в `alienation-backlog.md` §1.5/§3 и `DECISIONS.md` поэтому читаются как устаревший замер; настоящий документ — их замена (правка самих документов — отдельный шаг, не часть этой задачи).

## 3. Сайты вызова и цена миграции каждого

Все вызовы `append(..., { ignorable: true })` в форке: продакшн 8, тесты 10, ожидания конверта в тестах ещё 3 (все проверены `grep`-ом по `packages/`, нижеперечисленные пути полны).

Продакшн:

| Сайт | Миграция в `appendPluginRecord` |
|---|---|
| `experimental/model-routing/src/adapter.ts:945` — `session.append('model-routing/decision', payload, { ignorable: true })` | тип → `plugin:model-routing/decision`; объявить в `PluginRecordMap` (owner `@deepseek-ai/dsh-experimental-model-routing`); читатель `projection.ts` (и клиент `client-ui-model-routing/src/client/model-switch.ts`) переходит с сужения `SessionEventMap` на `pluginRecordOf` + валидацию payload |
| `experimental/model-routing/src/service.ts:181` — `tier-override` | `plugin:model-routing/tier-override` + то же для читателя (Thread roster) |
| `experimental/model-routing/src/service.ts:195` — `openrouter-fallback` | `plugin:model-routing/openrouter-fallback` + читатель композер-чипа |
| `experimental/threads/src/index.ts:190` — `thread/removed` | `plugin:threads/removed` (owner `@deepseek-ai/dsh-experimental-threads`) + читатель `threads`-проекции |
| `experimental/threads/src/lifecycle.ts:90` — `thread/created` | `plugin:threads/created`; payload несёт `ThreadId`/`cwd`/`branch`/`baseSha` — структура уходит в `data: unknown`, валидация на читателе |
| `experimental/threads/src/lifecycle.ts:129` — `thread/status` | `plugin:threads/status`; **частичное слияние полей** («a field absent from the event is left untouched» — [2026-10-02-threads-events](../../docs/persistence-changes/2026-10-02-threads-events.md)) больше не описывается типом `SessionEventMap` — контракт свёртки переписывается вручную |
| `experimental/threads/src/lifecycle.ts:152` — `thread/status` | второй вызов того же типа |
| `llm/llm-fallback/src/index-plugin.ts:180` — `llm/fallback` | **миграция невозможна как есть**: owner `@deepseek-ai/dsh-llm-fallback` не experimental → запись отвергается и коллектором каталога, и гейтом; миграция потребовала бы переноса пакета под `packages/experimental/` и правки записи «optional» в `scripts/product-package-policy.ts` — отдельное решение, не механика мержа |

Тесты: `experimental/tool-threads/tests/threads-tools.spec.ts:70,79`, `tool-threads/tests/library.spec.ts:89`, `tool-threads/tests/tier.spec.ts:57`, `model-routing/tests/plugin.spec.ts:106`, `threads/tests/library.spec.ts:98,240,264,285,312` — каждый меняет одну строку вызова; ожидания конверта `threads/tests/lifecycle.spec.ts:292`, `model-routing/tests/projection.spec.ts:25`, `threads/tests/lifecycle-edges.spec.ts:286` переписываются на `pluginRecordOf` или на новые имена; `llm-fallback/tests/fallback.spec.ts` читает по старому типу (`events(agent, 'llm/fallback')`, `expectTypeOf<SessionEventMap['llm/fallback']>` — строка 42) и миграции не требует. Документальные упоминания `ignorable: true` в JSDoc: `model-routing/src/types.ts`, `threads/src/types.ts`, `llm-fallback/src/types.ts`.

Цена миграции в целом: 18 строк вызовов, 7 имён, 2 проекции + 2 клиента, 2 снапшота, переиздание шести форк-ack'ов (в двух из них — `2026-10-05-model-routing-decision-diagnostics`, `2026-10-19-model-routing-failure-fields` — корень `event:model-routing/decision` остаётся, меняется payload-схема) и **обратная совместимость уже записанных логов**: события с типами `thread/created`, `model-routing/decision`, … остаются известными, пока объявления не сняты из `SessionEventMap`; держать оба множества имён — постоянный двойной путь в читателях. Инструмента переименования типов внутри одной версии формата rc.2 не имеет, самописный ренеймер выпущенных логов противоречит [правилу о неизменности committed generations](../../docs/cookbook/reviewing-persistence-type-changes.md).

## 4. Рекомендация: B — держать правку, причина перезаписана

По трём осям из задания:

- **Поверхность.** A убрала бы из поверхности `packages/core/session` все 7 файлов (6 M + 1 A: `src/index.ts`, `src/types.ts`, `src/known-event-types.ts`, `package.json`, `README.md`, `README.zh.md`, `tests/append-ignorable.spec.ts`) — 8-е, `README.i18n.yaml`, форк уже не трогает. Но это максимум при **полном** отказе от `AppendOptions`, а полный отказ невозможен: `llm/fallback` обязан остаться объявленным событием релизного пакета. Усечённый вариант A («мигрируют только `experimental/*`, ядро остаётся ради `llm/fallback`») не убирает **ни одного файла** — тот же `src/index.ts`/`src/types.ts` остаются в диффе — и прибавляет стоимость §3 ради нулевого выигрыша в этом окне.
- **Риск для логов.** Форк уже имеет записанные Project-логи с `thread/*` и `model-routing/*` (снапшоты `threads-project-worktree{,-tiers}` несут 3 ignorable-строки каждый; живой профиль `~/.dsh/profiles/web` монтирует оба бандла). A переписывает имена типов при живых логах без механизма миграции — риск не оправдан: никакой другой выгоды, кроме поверхности ядра, A не даёт (см. предыдущий пункт).
- **Гейт.** Ограничение callers'ов (`packages/experimental/` + тесты) делает A невозможной для `llm/fallback` без переноса пакета или правки политики — и это не случайность, а заявленный апстримом контракт: «Experimental packages may rely on that; a release package must declare its events instead» (шапка `verify-plugin-record-callers.ts`). Наше событие — ровно «release package declares its event».

Статус причины по ранбуку («Держать локально» требует записанной причины): причина записана и здесь обновлена — правка держится потому, что (а) `llm/fallback` — событие релизного пакета, для которого `SessionEventMap`+`ignorable` — единственный разрешённый апстримом механизм; (б) миграция шести остальных типов при живых логах без инструмента переименования не оправдана. С `appendPluginRecord` правка не дублируется: он решает другую задачу (best-effort-записи experimental-пакетов) и продолжает работать в форке как есть.

Шов, который разблокировал бы выгрузку (заменяет устаревшую строку §3 alienation-backlog): **апстримный PR с `AppendOptions`** — правка C-вида. Самодостаточный шов: rest-кортеж `append` для не-surface типов + интерфейс в `types.ts` + абзац README; конверт-маркер `ignorable?: true` уже апстримный, читательская сторона уже апстримная. Пока PR не принят, стоимость владения — 2 конфликтующих ханка в `src/index.ts` на окно, оба решаются взятием апстрима с последующим возвращением пяти вставок (§5). C как действие **этого** мержа отвергнуто: PR не примется мгновенно, а без него C = B с лишним ожиданием.

## 5. Инструкция мержу

Мёрж-дерево (`git merge-tree 66491b05e3 HEAD dsh-v0.2.2-rc.2`, git 2.34, без `--write-tree`): **конфликтные ханки только в `packages/core/session/src/index.ts`, их 2; остальные шесть файлов пакета автосливаются**, но автослив оставляет в них смесь сторон — поэтому в шаге 1 все шесть берутся из апстрима целиком. Инструкция:

1. `git checkout dsh-v0.2.2-rc.2 -- packages/core/session/src/index.ts packages/core/session/src/types.ts packages/core/session/src/known-event-types.ts packages/core/session/package.json packages/core/session/README.md packages/core/session/README.zh.md` — оба конфликтных ханка `src/index.ts` (`import type {…AppendOptions…}` и хвост `append` с `[opts?: AppendOptions]`) разрешаются апстримной стороной; `src/types.ts` после автослива содержит апстримный `SessionEventInput` рядом с нашим `AppendOptions`, `README*` — оба абзаца подряд, поэтому автослив для них не используется.
2. `git rm packages/core/session/tests/append-ignorable.spec.ts` — тест проверял форк-опцию; маркерные контракты (skip/refuse неизвестного типа, приём маркера при сидинге, roundtrip) покрыты апстримом: `session-persistence/tests/storage-contract.spec.ts:144`, `core/session/tests/session.spec.ts:1249`, `core/session/tests/plugin-records.spec.ts`.
3. Проверить, что в `package.json` `core/session` не осталось двух форк-devDeps (`@deepseek-ai/dsh-session-persistence{,-jsonl}`) — они уезжают вместе с тестом.
4. **Вызовы не трогать.** После шага 1 третий аргумент `{ ignorable: true }` у не-surface типов перестаёт компилироваться (rest-кортеж снова `[]`) — это ожидаемое промежуточное состояние; править вызовы не нужно, их разблокирует шаг 5.
5. Вернуть шов пятью вставками поверх апстримной версии: интерфейс `AppendOptions` в `src/types.ts` после `SurfaceOp`; `AppendOptions` в строку импорта типов `src/index.ts`; расширение rest-кортежа `append` до `: [opts?: AppendOptions]`; абзац про `AppendOptions` в JSDoc `@param opts`; три строки тела (`appendOpts`, `ignorable`, `...ignorable ? { ignorable: true } : {}` в конверте). Точная цель — `git diff dsh-v0.2.2-rc.2 HEAD -- packages/core/session/src/index.ts packages/core/session/src/types.ts`, применить против апстримной версии. После шага 5 дифф `src/index.ts` против rc.2 — четыре блока (импорт, JSDoc-абзац, rest-кортеж, тело), `src/types.ts` — один, а не наш полный дифф против rc.1.
6. `pnpm run gen-persistence-catalog` — вернёт наши восемь строк в `known-event-types.ts` (`llm/fallback`, `model-routing/*`×3, `thread/*`×3); апстримная строка окна `team/mode` остаётся. Прецедент: `2094e7ae9f` → `15ea3235f7`.
7. Гейты после мержа: `verify-plugin-record-callers` (наш код гейт не задевает), `verify-persistence-catalog`, `verify-persistence-changes`, снапшоты Threads.

Шаги 1–3 — «take upstream», шаг 5 — «then do X»: X = вернуть шов пятью вставками поверх апстримной версии тех же двух файлов. Это и есть ответ на вопрос из [upstream-0.2.2-rc.2.md п. 5](upstream-0.2.2-rc.2.md) «снимается ли»: правка ядра не снимается, но её мерж-цена — пять целевых вставок поверх апстримного файла, без ручной сверки нашего диффа против rc.1.

## 6. Что не верифицировано в этом дереве

- **Сборка и тесты не запускались** (запрещены задачей): «после мержа всё компилируется» — вывод из чтения кода, не из `typecheck`/`vitest`. В частности, шаг 5 инструкции не прогонялся как код.
- **Мёрж-дерево посчитано `git merge-tree` без `--write-tree`** (git 2.34): число и расположение конфликтов — по текстовому выводу; поведение настоящего `git merge` (rename detection, renormalize) может отличаться в деталях.
- **Живые логи не открывались**: вывод «форк-логи с `thread/*` читаются сборкой rc.2» следует из кода `session-persistence`/`session-format-catalog` (и подтверждён тестом апстрима `storage-contract.spec.ts`), но не проверен на реальном JSONL профиля `~/.dsh/profiles/web`.
- **Вне-чекout потребители** (dsh-openrouter-spend, tg-бот, чужие reader'ы форк-логов) не анализировались: если кто-то снаружи читает Project-логи и различает типы `thread/*`/`model-routing/*`, рекомендация A была бы для него дополнительным риском; факт таких reader'ов не установлен.
- **Окно дальше rc.2** (`dsh-v0.2.2-rc.2..upstream/master`, 166 коммитов) не смотрено: если апстрим продвинет `AppendOptions`-подобный шов или изменит gate'ы, разбор надо переоткрыть при следующем окне.
