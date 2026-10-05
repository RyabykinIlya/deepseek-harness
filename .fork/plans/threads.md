# Threads / Projects — план отчуждения

Фоновые Thread'ы с изоляцией по git-worktree, Project-координатор, память проекта, библиотека.

## Состояние

**Собирается.** Оба снапшот-сценария проходят keyless, 563 теста host-пакетов и 458 тестов клиентских пакетов зелёные (проверено 2026-10-04). В запущенном приложении сценарий «Project → два Thread'а → слияние» не проходился.

Девять новых пакетов: `experimental/threads`, `threads-preset`, `threads-profile`, `tool-threads`, `client-ui-threads`, `project-memory`, `subagent/subagent-thread-worktree`, `subagent/worktree-manager`, `client/ui-settings-threads`. 2026-10-05 добавлен десятый — `experimental/client-ui-project-memory`, карточка настроек памяти Project.

## Соответствие модели Anthropic

Сверено с [claude.com/blog/projects-redesigned](https://claude.com/blog/projects-redesigned) 2026-10-04. Механика воспроизведена целиком, местами глубже оригинала.

| Их концепт | Здесь | Оценка |
|---|---|---|
| Projects have threads + a coordinator | пресеты `project` и `project-thread`, два контракта | полностью, роли разведены строже |
| Thread = own branch and copy of the repo | git worktree плюс ветка `dsh/thread-<slug>` | полностью; у них облачная сессия, здесь локальный worktree |
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
| `subagent/subagent` | 14 | выбор cwd у continuable-провайдера |
| `subagent/tool-subagent` | 4 | `allowedModels` для дочерних агентов |
| `client/ui-workspace` | 8 | UI воркспейса |
| `core/session` | 7 | `package.json`, `README`, `src/index.ts`, `src/types.ts` |
| `test-support/session-snapshot`, `client-runtime` | 5 | тест-инфраструктура |
| `docs/subsystems/*` | 10 | документация подсистем |

Из них с ожидающим апстримом (`0.2.1-alpha.1`) реально пересекаются немногие: `core/session/src/index.ts`, `core/session/src/types.ts`, `subagent/subagent/src/index.ts` и READMEs. Разбор — в [../INVENTORY.md](../INVENTORY.md).

### Правка `subagent/subagent` — кандидат в апстрим, не на вендоринг

«Continuable-провайдер выбирает cwd ребёнка» — это расширение общего шва подагентов, а не частность Threads. Любой провайдер, запускающий ребёнка в другом каталоге, упирается в то же ограничение. Вендоринг 14 файлов живого кода подагентов означает форк подсистемы. То же про `allowedModels` в `tool-subagent`.

### Правки `core/session` — разобрать по одной

```sh
git diff origin/master...HEAD --stat -- packages/core/session
git diff origin/master...HEAD -- packages/core/session/src/types.ts
```

### Правки `client/ui-workspace` — выяснить, чьи они

Восемь файлов UI, включая `.module.css` и тесты. Неясно, относятся ли они к Threads вообще или это отдельная правка UI, уехавшая в тот же коммит.

## Что доделать в самой фиче

- **Ожидаемые выходы обоих SDK** для `thread/created`, `thread/status`, `thread/removed` — приоритет 5 в [../STATUS.md](../STATUS.md#приоритеты). Проверено поиском: ни `snapshots/sdk/`, ни `scripts/snapshots/python-sdk-single-exe/` этих событий не знают. Без них изменение `SessionEventMap` не пройдёт ревью в апстриме.
- **`tool-threads/README.md`** доделать до четырёх инструментов, список расхождений — в [../STATUS.md](../STATUS.md#открытые-баги).
- **Настройки правятся текстом.** `ThreadsCard` просит напечатать `milestones | each-thread | quiet` и ругается на опечатку; для трёх закрытых перечислений это должен быть выпадающий список. Плюс «применится при следующем старте harness» — дорого для трёх политик.
- **Деньги в `ProjectTokenUsage`.** Цена за токен есть в решении маршрута, токены есть в проекции; перемножение закрывает «project-specific usage visibility», которое сейчас только в токенах.
- **GIF на изменения GUI** (T7.6): скилл `record-browser-gif` требует его на каждый PR с видимым изменением интерфейса.

## Шаги отчуждения

- [ ] Ожидаемые выходы обоих SDK (блокирует upstream-PR)
- [ ] Разобрать правки `core/session` по одной: содержательное / генерируемое / документация
- [ ] Выяснить, относятся ли правки `ui-workspace` к Threads
- [ ] Решить по `subagent/subagent` и `tool-subagent`: отправлять в апстрим или держать локально с записанной причиной
- [ ] Заменить `workspace:*` на semver-рэнджи в девяти манифестах
- [ ] Проверить установку на чистый профиль
- [ ] Проверить критерии 3 и 4 готовности ([../DECISIONS.md](../DECISIONS.md#критерии-готовности)): обычные сессии не затронуты, бандл снимается без порчи сессий

## Замечание

Этот плагин стоит отчуждать **последним**. Он самый большой, самый связанный, и его правки ядра — настоящие фичи, которые имеет смысл двигать в апстрим, а не вытаскивать наружу. Шаблон отчуждения дешевле отработать на web-search, потом на model routing, и только потом браться здесь.
