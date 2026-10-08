# Что написано в форке

Инвентарь авторского кода: что здесь наше, где оно физически лежит и что с ним произошло. Пишется для того, чтобы любой — я в первую очередь — мог ответить на вопрос «это наше или апстримное» и «где оно сейчас», не перебирая `git diff`.

**Правило, из которого файл существует.** Авторский код не обязан оставаться в форке, но обязан быть здесь записан: новая фича появляется здесь в день первого коммита, а уход наружу — в день переноса. Дыра в этом файле стоила реальной путаницы: плагин `dsh-openrouter-spend` ушёл из форка в отдельный публичный репозиторий, а след остался только в `.local-plugins/`, где лежала уже устаревшая копия.

## 1. Фичи, живущие в форке

Четыре фичи, каждая — набор новых пакетов плюс, где необходимо, правки апстримных. Отчуждение и конфликтная поверхность каждой — в [INVENTORY.md](INVENTORY.md), обоснование — в [DECISIONS.md](DECISIONS.md).

| Фича | Новые пакеты | Связана с ядром |
|---|---|---|
| **Projects / Threads** — фоновые агенты, у каждого свой git-worktree | `experimental/threads`, `experimental/threads-preset`, `experimental/threads-profile`, `experimental/tool-threads`, `experimental/client-ui-threads`, `experimental/project-memory`, `experimental/client-ui-project-memory`, `subagent/worktree-manager`, `subagent/subagent-thread-worktree`, `client/ui-settings-threads` | `subagent/subagent` (14 файлов), `subagent/tool-subagent` (5), `core/session` (типы событий и `AppendOptions.ignorable`) |
| **Model routing** — тиры моделей вместо ручного выбора, ранжирование endpoint'ов OpenRouter по цене следующего хода, плюс прямые источники (`extraSources`) и ротация ключей на `KEY_QUOTA` | `experimental/model-routing`, `experimental/model-routing-profile`, `experimental/client-ui-model-routing` | `llm/llm-pi-ai` (16 файлов: четыре новых файла чтения OpenRouter, dispatch, каталог, `apiKeys`/ротация, `userAgentOverride`), `llm/llm` (код `KEY_QUOTA`) |
| **Web-поиск** — три новых провайдера и доверенные адреса для fake-ip прокси | `web/web-search-brave`, `web/web-search-tavily`, `web/web-search-duckduckgo` | `web/web` (списки известных id провайдеров), `web/web-fetch-http` (`trustedProxyAddressRanges`), `client/ui-settings-web-search` (7) |
| **Restore** — форк диалога от сообщения вместо запрещённого усечения лога | — | `client/ui-chat` (13 файлов), `client/product-analytics`, `extensions/cordis-client-runner` (слот) |

Прочее, что не фича, а обвязка: `client/ui-workspace` (8) — представление дерева и строк, `bundle/base` и `bundle/web-app` — строки бандлов, `test-support/session-snapshot` и `test-support/client-runtime` — поддержка новых событий и Remote в тестах, `extensions/cordis-client-runner` и `extensions/tool-cordis` — по одной регистрации нового слота и Remote.

## 2. Код, ушедший из форка

| Что | Где живёт сейчас | Состояние |
|---|---|---|
| **`dsh-openrouter-spend`** — плагин «сколько аккаунт OpenRouter реально списал»: аналитика OpenRouter вместо оценки по токенам, чип под композером и страница настроек с графиком, разбивкой по моделям и API-ключам и остатком баланса | Отдельный git-репозиторий `~/dev/dsh-openrouter-spend` (remote `RyabykinIlya/dsh-openrouter-spend`, ветка `main`), **версия 0.3.2**, теги `v0.1.0`…`v0.3.2` | Опубликован. Ставится `dsh plugin add dsh-openrouter-spend` или с GitHub; сборки нет, поэтому `prepare`-скрипт не нужен и разрешение build-скрипта не запрашивается |

Подробности — в его собственном README и CHANGELOG. В форке он остаётся исходником, а не зависимостью: форк его не подключает и поддерживает как отдельный продукт.

**Локальные копии.** В `.local-plugins/` лежат две копии того же плагина: `openrouter-spend/` (с `ru.json` и `PUBLISHING.md`) и `dsh-openrouter-spend/` (без `ru.json`); код у них разный, обе объявляют `@local/openrouter-spend@1.0.0`. Свежая — `openrouter-spend/`: в неё вошла правка «RUB по курсу ЦБ» (коммит `45eaced7d0`, 2026-10-06), и это единственный путь `ru.json`. Копии не являются источником истины: это рабочий код для чекаута, а публикуемое дерево живёт в `~/dev/dsh-openrouter-spend` (0.3.2). **Каталог `.local-plugins/` отслеживается git с 2026-10-05** (коммит `6c4f7290d3` добавил его вместе с `PLUGINS.md`), так что любая правка в нём попадает в историю форка.

## 3. Локальные плагины форка

Не публикуются и живут только в этом чекауте, в `.local-plugins/` — обычный ESM без сборки и без зависимостей. **Каталог отслеживается git с 2026-10-05** (коммит `6c4f7290d3`), вместе с рукописным каталогом `PLUGINS.md` в корне.

| Плагин | Что делает |
|---|---|
| `@local/browser-use-playwright` | Обёртка без кода: включает `dsh-experimental-browser-use-playwright-mcp` в режиме `launch` с `headless: true` — свой headless Chromium на сессию через Playwright MCP |
| `@local/openrouter-spend` (каталог `openrouter-spend/`) | Локальная копия `dsh-openrouter-spend` для этого чекаута, **самая свежая из двух**: содержит `ru.json` и правку «RUB по курсу ЦБ» |
| `@local/openrouter-spend` (каталог `dsh-openrouter-spend/`) | Вторая копия того же плагина без `ru.json`; отличий между копиями не минус, а просто два состояния одного кода, и решить, какая из них канон, — отдельная мелкая задача |

## 4. Слой сопровождения

`.fork/` сам — рабочая документация, план отчуждения по каждой фиче, runbook мержа и Claude Code hook, запрещающий правку чужих деревьев. К авторам кода не относится, но к форку относится: при переносе чего-либо наружу сюда обязано попасть решение, а не только код.

## Как поддерживать

При первом коммите авторского кода — строка в разделе 1 или 3. При переносе наружу — раздел 2 со ссылкой на репозиторий, тег и состояние, плюс удаление устаревшей копии, если она осталась. Числа пересчитываются командой из [INVENTORY.md](INVENTORY.md); хеши коммитов здесь не пишутся, коммиты называются по теме.