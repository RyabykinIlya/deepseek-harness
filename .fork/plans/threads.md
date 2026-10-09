# Threads / Projects — план отчуждения

Фоновые Thread'ы с изоляцией по git-клону, Project-координатор, память проекта, библиотека.

## Состояние

**Работает** (проверено в приложении 2026-10-07: события `thread/created` в логах сессий, Thread коммитит в своём клоне и сливается в `master`). Оба снапшот-сценария проходят keyless; полный прогон пакетов фичи — 101 файл, 1725 тестов зелёные (2026-10-07). Сценарий «Project → два Thread'а → слияние» одним проходом под записью не проходился.

Десять новых пакетов: `experimental/threads`, `threads-preset`, `threads-profile`, `tool-threads`, `client-ui-threads`, `project-memory`, `client-ui-project-memory`, `subagent/subagent-thread-worktree`, `subagent/worktree-manager`, `client/ui-settings-threads`. Изоляция Thread'а — самодостаточный клон вместо linked worktree (решение D9, [threads-self-contained-worktrees.md](threads-self-contained-worktrees.md)); выбор репозитория в multi-repo workspace — [ADR-0001](../adr/0001-thread-v-multi-repo-workspace.md).

## Соответствие модели Anthropic

Сверено с [claude.com/blog/projects-redesigned](https://claude.com/blog/projects-redesigned) 2026-10-04. Механика воспроизведена целиком, местами глубже оригинала.

| Их концепт | Здесь | Оценка |
|---|---|---|
| Projects have threads + a coordinator | пресеты `project` и `project-thread`, два контракта | полностью, роли разведены строже |
| Thread = own branch and copy of the repo | самодостаточный клон (`git clone --local`) плюс ветка `dsh/thread-<slug>` | полностью; у них облачная сессия, здесь локальный клон |
| Supervise from main chat, or open a thread | ростер в шапке плюс чат Thread'а в главной области или в правой панели | полностью |
| Redirect mid-flight | `send_message` и `interrupt_agent` в контракте координатора | полностью |
| Conflicts = ordinary merge conflict | `git merge --no-ff` в контракте, `thread_diff` считает пересечения | глубже: пересечения видны **до** слияния |
| Shared project memory | `project-memory`, `memory_read` и `memory_write` у обеих ролей; потолки правятся в настройках (`client-ui-project-memory`) | полностью |
| Library | `library_list` и панель: вложения, `present`, изменённые файлы | полностью |
| Project-specific usage visibility | `ProjectTokenUsage` агрегирует Project и его Thread'ы | частично: токены есть, денег нет |
| Своя модель для координатора и для Thread'ов | `presetRoutes`, `allowedModels`, `thread_tier` | полностью, точнее их формулировки |
| Tune check-in cadence и готовность плодить Thread'ы | `CheckInPolicy`, `SpawnPolicy`, `MergePolicy` | полностью, но правятся текстом, см. ниже |
| Threads subdivide via subagents, loops, workflows | subagents есть (`maxDepth`); `dsh-goal`, `dsh-schedule`, `dsh-workflow` в зависимостях отсутствуют | частично |
| Цель плюс репозиторий → предложенный первый план работ | **нет**: «New Project» открывает пустую сессию с пресетом | главный пробел |
| Local execution | уже локально | впереди |

Вывод: не хватает входной воронки. Момент создания Project — это то место, где фича себя продаёт, и сейчас он пустой. Правок ядра для этого не требуется: нужен диалог (цель и каталог), запись цели через `memory_write` и первый ход координатора с готовым промптом. Пакет `dsh-goal` в репозитории есть и не задействован.

## Чем связан с ядром

Самый связанный из трёх плагинов — и единственный, где правки ядра являются настоящими фичами, а не обходом.

| Апстримный пакет | Файлов | Что это |
|---|---|---|
| `subagent/subagent` | 17 | выбор cwd у continuable-провайдера и capability `repository` |
| `subagent/tool-subagent` | 6 | `allowedModels` и параметр `repository` для дочерних агентов |
| `subagent/subagent-*` (шесть провайдеров) | 12 | `repository: false` в объявлении capability |
| `client/ui-workspace` | 8 | UI воркспейса |
| `core/session` | 5 | `package.json`, `README`, `src/index.ts`, `src/types.ts` |
| `workflow/workflow-ptc` (+ `tool-workflow`, `tool-ralph`), `sdk/server` | 9 | тест-фикстуры и каталоги выбора репозитория |
| `test-support/session-snapshot`, `client-runtime` | 5 | тест-инфраструктура |
| `docs/subsystems/*` | 10 | документация подсистем |

Из них с ожидающим апстримом (`0.2.1-alpha.1`) реально пересекаются немногие: `core/session/src/index.ts`, `core/session/src/types.ts`, `subagent/subagent/src/index.ts` и READMEs. Разбор — в [../INVENTORY.md](../INVENTORY.md).

### Правка `subagent/subagent` — кандидат в апстрим, не на вендоринг

«Continuable-провайдер выбирает cwd ребёнка» — это расширение общего шва подагентов, а не частность Threads. Любой провайдер, запускающий ребёнка в другом каталоге, упирается в то же ограничение. Вендоринг 17 файлов живого кода подагентов означает форк подсистемы. То же про `allowedModels` и `repository` в `tool-subagent`.

### Правки `core/session` — разобрать по одной

```sh
git diff origin/master...HEAD --stat -- packages/core/session
git diff origin/master...HEAD -- packages/core/session/src/types.ts
```

### Правки `client/ui-workspace` — выяснить, чьи они

Восемь файлов UI, включая `.module.css` и тесты. Неясно, относятся ли они к Threads вообще или это отдельная правка UI, уехавшая в тот же коммит.

## Что доделать в самой фиче

- **SDK-сценарий для Threads** (T8.5, переформулирован) — приоритет 5 в [../STATUS.md](../STATUS.md#приоритеты). Прежняя формулировка «вписать `thread/*` в ожидаемые выходы SDK» опиралась на неверную посылку: снапшоты SDK — проекция реального прогона, а не список событий, поэтому вписывание вручную фабриковало бы вывод. Нужен новый записанный сценарий, композирующий `threads-profile` под профилем `sdk`; расширение `SessionEventMap` ревью в апстриме не блокирует — см. [../DECISIONS.md](../DECISIONS.md).
- ~~**`tool-threads/README.md`** доделать до четырёх инструментов~~ **Сделано 2026-10-04** (приоритет 8 в [../STATUS.md](../STATUS.md#приоритеты)).
- **Настройки правятся текстом.** `ThreadsCard` просит напечатать `milestones | each-thread | quiet` и ругается на опечатку; для трёх закрытых перечислений это должен быть выпадающий список. Плюс «применится при следующем старте harness» — дорого для трёх политик.
- **Деньги в `ProjectTokenUsage`.** Цена за токен есть в решении маршрута, токены есть в проекции; перемножение закрывает «project-specific usage visibility», которое сейчас только в токенах.
- **GIF на изменения GUI** (T7.6): скилл `record-browser-gif` требует его на каждый PR с видимым изменением интерфейса.

## Шаги отчуждения

- [ ] Новый SDK-сценарий для Threads (T8.5; upstream-PR не блокирует — см. [../DECISIONS.md](../DECISIONS.md))
- [ ] Разобрать правки `core/session` по одной: содержательное / генерируемое / документация
- [ ] Выяснить, относятся ли правки `ui-workspace` к Threads
- [ ] Решить по `subagent/subagent` и `tool-subagent`: отправлять в апстрим или держать локально с записанной причиной
- [ ] Заменить `workspace:*` на semver-рэнджи в десяти манифестах
- [ ] Проверить установку на чистый профиль
- [ ] Проверить критерии 3 и 4 готовности ([../DECISIONS.md](../DECISIONS.md#критерии-готовности)): обычные сессии не затронуты, бандл снимается без порчи сессий

## Замечание

Этот плагин стоит отчуждать **последним**. Он самый большой, самый связанный, и его правки ядра — настоящие фичи, которые имеет смысл двигать в апстрим, а не вытаскивать наружу. Шаблон отчуждения дешевле отработать на web-search, потом на model routing, и только потом браться здесь.
