# Обновление ядра до dsh-v0.2.2-rc.2

Подготовка замерена 2026-11-12 в основном чекауте, до мержа. Процедура — [MERGE-RUNBOOK.md](../MERGE-RUNBOOK.md); здесь только то, что относится к этому окну.

Пин форка — `dsh-v0.2.2-rc.1` (`66491b05e3`, он же точка расхождения, проверено `git merge-base`). Target — тег `dsh-v0.2.2-rc.2` (`ddac96760b`, prerelease, опубликован 2026-11-11). Апстрим уже уехал дальше тега: `dsh-v0.2.2-rc.2..upstream/master` — 166 коммитов, их в это окно не берём.

## 1. Что приехало

| Замер | Значение | Команда |
|---|---|---|
| Коммитов апстрима | 1568 (fix 355, test 234, feat 147, refactor 118, docs 114) | `git log --format='%s' rc.1..rc.2` |
| Дифф | 4645 файлов, +160844 / −58399 | `git diff --shortstat rc.1 rc.2` |
| По верхнему уровню | packages 2713, snapshots 732, apps 411, docs 335, .agents 301, scripts 109 | `git diff --name-only … \| cut -d/ -f1` |
| Новых апстримных пакетов | 10 | `comm -13` по `packages/*/*/package.json` |
| Удалённых апстримных пакетов | 9 | то же, `comm -23` |
| `SESSION_FORMAT_VERSION` | **4 → 4, миграций сессий нет** | `grep` в `core/session/src/types.ts` обеих сторон |
| Vendor | **не менялся** (cordis 4.1.0 с обеих сторон; правка только в `vendor/README.md`) | `git diff --stat … -- vendor/` |
| Новых upgrade-гайдов | 45 новых `guide.md` + 2 изменённых | `git diff --name-status … -- docs/upgrade-guide` |

Новые пакеты: `team/agent-team`, `team/tool-agent-team`, `client/ui-agent-team` (переезд `experimental/agent-team*` в стабильную группу), `document/office-kit`, `document/tool-office` (вместо `office-to-pdf`), `mcp/mcp-manager`, `experimental/terminal-panel`, `client/ui-account-notifications`, `util/error`, `util/ripgrep`.

Удалены: `api/account-controller`, `credentials/deepseek-account-platform`, `document/office-to-pdf`, `experimental/agent-team`, `experimental/agent-team-profile`, `experimental/client-ui-agent-team`, `experimental/tool-agent-team`, `web/web-search-exa`, `web/web-search-perplexity`. **Ни один из них форк не правил** (`git diff --name-only rc.1 HEAD -- <путь>` пуст у всех девяти), то есть delete/modify-конфликтов нет: `comm -12` нашей поверхности с удалёнными файлами пуст.

Инструментарий: zod `^4.4.3` → `4.6.6` (точный пин), stagehand 4.4.0, libreoffice-kit 0.1.5 → 0.2.3, новый гейт `verify-plugin-entry-exports` в `hygiene`. Node остаётся `>=24.9` — на машине 22.19, в nvm есть 24.22.2 (задача из прошлой вырезки не закрыта).

## 2. Цена мержа — замерено, не оценено

```sh
B=$(git merge-base HEAD dsh-v0.2.2-rc.2)
git merge-tree $B HEAD dsh-v0.2.2-rc.2    # git 2.34, без --write-tree
```

| Замер | Значение |
|---|---|
| Наша поверхность (изменённые апстримные файлы против rc.1) | **181** (было 170 на 2026-11-04) |
| Апстримная дельта | 4645 файлов |
| Пересечение | **133 файла** |
| Из них с текстовыми маркерами | **58 файлов / 236 ханков** |
| Из них снимается шагом 1 (генерируемое, `.zh.md`, `.i18n.yaml`, lock, baseline) | 32 |
| Точки регистрации (категория B) | 13 |
| Настоящий разбор (категория C) | 89 файлов в пересечении, из них с маркерами ~20 |

Структурные разборы, по убыванию апстримного churn'а в файле:

| # | Зона | Что сделал апстрим | Что нужно перенести |
|---|---|---|---|
| 1 | `subagent/subagent` (`manager.ts` 1146 строк churn, `index.ts`, `types.ts`, `control*`, `continuation-messages.ts`) | именованные сабагенты (`names.ts`, catalog payload v3), sibling-messages, `parentSessionId` в `SubagentRunInfo`, снятие `drainChildren`/`listChildren`/`list` | наш continuable-шов: `cwd`, `handles`, `repository` в `SubagentCapabilities`/`ContinuableCreate*` (в rc.2 их нет) |
| 2 | `client/ui-settings-web-search` (6 файлов, 587+970 строк churn) | страница переписана на два меню по capability, список берётся из `web/listProviders`, billing-режимы Search/Fetch | **возможность отчуждения:** наша `WebSearchSelectionCard` + `web/web`-список `WEB_SEARCH_PROVIDER_IDS` апстримом перекрыты, и в списке остались удалённые `exa`/`perplexity` |
| 3 | `mcp/mcp-client` (`connection.ts` 476, плюс новые `generation.ts`, `status.ts`, `probe.ts`, `credentials.ts`, `mcp-manager`) | супервизор разобран на модули, статус/проба/liveness-пинги, динамическая регистрация серверов | наш `recoverSession` + `isExpiredSessionError` (404 Session not found) переложить на новую структуру; сверить, не закрыто ли апстримом |
| 4 | `subagent/tool-subagent` (`src/index.ts`, `model-selection.ts`, тесты) | параметр `name`, новый текст описаний, `requestedAgentOptions(configured, request, enabled, policy, parentOptions)`, результат `{kind:'activation', name}` | наши `allowedModels`, `backgroundMode`, `repository`, двухвариантный output-schema |
| 5 | `core/session` (`src/index.ts`, `types.ts`) | `append([...])`-перегрузка, `SessionEventInput`, `currentBatchPublication`, **свой `ignorable` + `appendPluginRecord`/`pluginRecordOf`** | наш `AppendOptions`/`{ignorable:true}` — скорее всего **снимается**: апстрим привёз тот же механизм; проверить, переводится ли наш `plugin:`-неймспейс на `appendPluginRecord` |
| 6 | `client/ui-chat` (`ChatView.tsx` 516, тесты 341) | `consumeOlder`/`historyLoadStatus`/`historyWasPartial`, fence-рендереры по языку, `markdown-labels` | наш `restoreAt` сквозь `slots.ts` → `ChatView` → ниже |
| 7 | `client/ui-workspace` (`Rows.tsx`, `WorkspaceBrowser.tsx`) | меню через фабрику `contextMenu.button`, `onCreate(workspaceId)`, `ProjectRowActions` вместо `ProjectRowAccess` | Thread-гнездо и `sidebar.workspaces.thread.row.action` |
| 8 | `llm/llm` + `llm/llm-pi-ai` (`stream.ts`, `adapter.ts`) | `LLM_FAILURE_CODES` как реестр, `BuiltinLlmFailureCode` в конструкторе `LlmError`, `RETRY_CODE_CHOICES`, привязка thinking к префиксу (`prefix-binding.ts`) | наши `KEY_QUOTA`, `CLIENT_GATE`, `isKeyQuotaExceededError`, `isClientGateRejectedError` — теперь обязаны войти в реестр, иначе не скомпилируются (гайд `llm-error-builtin-codes`) |
| 9 | `scripts/*` (13 файлов) | импорты `agent-team`/`office`/`terminal-panel` в `gen-tool-catalog`, снятие строк `exa`/`perplexity` из `product-package-policy` | наш `catalog-declarations.ts` (форк-онли), рукописные алиасы `tsconfig.base.json`, наши записи policy |
| 10 | снапшоты | `headless.snapshot.ts`, `web-search-endpoint-guidance` (authored — мержится построчно) | наши `threads-project-worktree{,-tiers}` (authored) перезаписать руками: `agent_id` → `agent`, receipts `started subagent <name>`, строки `list_agents` |

## 3. Внешние поверхности: что из 45 гайдов касается нас

Прочитаны целиком; остальные — апстрим-внутренние (cua, forge, schedule, desktop, office, LiveShare).

- **`v0.2.2-alpha.3/subagent-names` — главный.** `send_message({agent_id})` → `{agent}`, `interrupt_agent` то же, `list_agents` возвращает `{name,status,description?}`, `subagent` принимает `name` и отдаёт `{kind:'activation',name}`, каталог пишет payload **v3** (старые релизы такие сессии не откроют). Бьёт по контракту Threads: текст `threads-contract.ts` обещает «возвращает Thread id», координатор сводит Thread ↔ сабагент по `SessionId`, а модель теперь адресует по имени. Нужно решение: оставить id-адресацию (имя как alias — id продолжает работать) или назвать Thread'ы.
- **`v0.2.2-rc.1/subagent-interrupt-default`** — база и web-пресеты ставят `interrupt: false`; наш `threads-preset` монтирует свою строку `tool-subagent-control` без config, значит у Project'а `interrupt_agent` остаётся. Проверить тесты/снапшоты пресетов, не ловить это постфактум.
- **`v0.2.1-rc.2/subagent-service-methods`** — сняты `drainChildren`/`listChildren`/`list` у `ctx.subagents`. В форке их нет (grep пуст), единственный вызов — `startActivation` в тесте `threads/lifecycle.spec.ts`.
- **`v0.2.2-rc.1/session-append-overloads`** — обёртки над `Session.append` должны держать обе перегрузки. У нас обёрток нет, но ровно этот файл и конфликтует (п. 5 таблицы).
- **`v0.2.2-alpha.2/llm-error-builtin-codes`** — `new LlmError(msg, code)` принимает только встроенный код. Наши `KEY_QUOTA`/`CLIENT_GATE` и `MODEL_ROUTING_SUBSCRIPTION_LIMIT` (model-routing) ломаются на типах; лечение — вписать в `LLM_FAILURE_CODES` (наша правка `llm/src/error.ts` уже там живёт) либо `LlmError.fromFailure`.
- **`v0.2.2-alpha.2/web-search-default-provider` + `v0.2.2-rc.1/web-search-billing` + `v0.2.2-alpha.2/web-search-credential-modes`** — дефолт Search стал `deepseek-search-api`, `exa`/`perplexity` удалены как пакеты и как id. Наш `web-search-profile` ставит `searchProvider: duckduckgo` и в комментарии предлагает `exa`/`perplexity` — текст и список `WEB_SEARCH_PROVIDER_IDS` правятся. Живой профиль стоит на `tavily` — он не затронут.
- **`v0.2.2-rc.1/archive-worktrees`** — апстримный `experimental/worktree` чистит свои чекауты при архивации сессии. Наш сервис переименован в `ctx.threadWorktrees` ещё в rc.1-мерже, свои worktree Thread'ов апстрим не сметает (у них нет его `plugin:worktree/created`), но утверждение надо проверить на живом прогоне.
- **`v0.2.2-rc.1/plugin-update-method`, `v0.2.2-alpha.2/desktop-stable-channel`, `v0.2.2-rc.1/runtime-context-reminders`** — читать при вырезке: первый влияет на пины плагинов профиля, третий меняет текст runtime-контекста (снапшоты).
- Новый гейт **`verify-plugin-entry-exports`**: entry плагина экспортирует только то, что грузит Loader. Базовый список `scripts/plugin-entry-existing-exports.ts` **не содержит ни одного форк-пакета**, а наши entry экспортируют лишнее — `experimental/threads` (5 имён + default-класс), `model-routing` (18), `project-memory`, `worktree-manager`, `threads-preset`, `web-search-brave`/`tavily`, `subagent-thread-worktree`, `llm-fallback`. Гейт входит в `hygiene` ⇒ упадёт сразу после мержа. Нужно либо вписать наши пакеты в этот список (это «debt», а не исключение), либо почистить entry.

## 4. Состояние чекаута перед заморозкой

- **Дерево грязное:** 10 файлов (`guard/repeat-tool-reminder` — fuzzy-порог/блокировка + README-пары, `bundle/base/cordis.patch.yml` — новые ключи строки, `model-routing{,-profile}` тесты) и `.tmp-analysis/`. Апстрим в это же окно правил и `repeat-tool-reminder/src/index.ts`, и `cordis.patch.yml` (45 строк) — работу надо закоммитить до мержа, иначе `--ff-only` и клон Thread'а её не увидят.
- `.worktrees/merge-20261028` — остаток прошлого окна, уже влит в master (`merge-base --is-ancestor` = YES), снимается.
- Worktree-слотов занято 14 из 32 — места хватает.
- Профиль `~/.dsh/profiles/web`: все восемь бандлов через `link:` в этот чекаут плюс `dsh-openrouter-spend` (peer-пинов на dsh не держит, пострадать не может) и `hooks-claude-code` из чекаута. Строка `web` стоит на `tavily`/`http`.

## 5. Как ведём работу

Шаги 1–4 ранбука — в изолированном чекауте (worktree или клон Thread'а), основной чекаут не трогается. Шаг 5 (вырезка, `merge --ff-only` + `pnpm install && build` + перезапуск) — вручную из обычного терминала, не из сессии агента.

Разведка и адаптационные решения распараллеливаются (разные файлы, только чтение и запись в `.fork/plans/`), сам мерж — один последовательный проход, потому что конфликты глобальны и `pnpm install` один на дерево.
