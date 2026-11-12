# Порядок выполнения мержа dsh-v0.2.2-rc.2

Сводка шести разведок (A1–A6) в один порядок для исполнителя мержа (тред B). Каждая ссылка ведёт на полную спецификацию; здесь — только решения и очерёдность. База — `master` `7e52f3f8fc`, target — тег `dsh-v0.2.2-rc.2`. Ранбук — [MERGE-RUNBOOK.md](../MERGE-RUNBOOK.md), замеры окна — [upstream-0.2.2-rc.2.md](upstream-0.2.2-rc.2.md).

## Решения разведок, одно место

| # | Тема | Решение | Спецификация |
|---|---|---|---|
| A1 | Threads ↔ именованные сабагенты | **D1**: Session-id-адресация остаётся; правятся 2 предложения контракта, оба authored-снапшота, переносы API (`interruptByUser`, `{kind:'user'}`, `SubagentPromptRequest`). Инвариант: receipt `subagent` у thread-провайдера несёт Session id + handles; параметр `name` из schema НЕ вырезаем. `interrupt_agent` координатору сохраняем — `rewriteRows` обязан заменить базовую строку control на свою с `interrupt: true` (иначе после мержа координатор теряет interrupt молча). | [rc2-threads-names.md](rc2-threads-names.md) |
| A2 | Карточка web-search | **A′**: карточка выбора и вся поддержка в `ui-settings-web-search` удаляется (−13 файлов), `packages/web/web` — целиком (−2). Настройки провайдеров (ключ/baseURL/лимиты Brave, Tavily) — новый fork-only пакет, карточки регистрируются в `plugins.row.config` (ключ `@deepseek-ai/dsh-web-search-profile#web-search-brave`/`#web-search-tavily`, прецедент — forge `…#worktree`). Комментарий `web-search-profile` переписать: `exa`/`perplexity` удалены, дефолт — `deepseek-search-api`. | [rc2-web-search.md](rc2-web-search.md) |
| A3 | MCP session recovery | rc.2 и `upstream/master` дыру не закрыли (проверено). Перенос на новые швы: хук `recoverSession` в `ToolBridgeOptions` возвращает `McpGeneration`, повтор через `next.run(...)` (не через клиент — `close()` абортит lifetime); парковка через `withDeadline`; `lost(record, …)` заменяет три снятые функции. Ветку контрибуции переписать заново от апстримного master (из 8 ханков прошёл 2). Плоские строки `mcp-client` в профиле не трогать; в `servers` менеджера ключи `siebel-research`/`jira` не дублировать. | [rc2-mcp-session-recovery.md](rc2-mcp-session-recovery.md) |
| A4 | Коды отказов LLM | `KEY_QUOTA` и `CLIENT_GATE` — в `LLM_FAILURE_CODES` (по строке, по алфавиту реестра), оба **без** `retryChoice`. `MODEL_ROUTING_*` (4) и `OPENROUTER_*` (7) — в реестр НЕ вносить; 13 сайтов `new LlmError` на `LlmError.fromFailure` (таблица file:line в спеке). Живой профиль грузится: строковая ветка union на месте (`retry-policy.ts:95`). | [rc2-llm-failure-codes.md](rc2-llm-failure-codes.md) |
| A5 | Гейт `verify-plugin-entry-exports` | 10 пакетов из 18 падают (122 экспорта): 112 — в 8 долг-строк `scripts/plugin-entry-existing-exports.ts` (позиции сортировки проверены; web-search НЕ одним блоком — `dsh-web-search-deepseek` сортируется между brave и duckduckgo), 10 экспортов удалить из entry (`threadNote`-импорт в `threads/tests/lifecycle.spec.ts:27` перевести на `../src/note.ts`). Долг-строки и удаления — одним коммитом. | [rc2-plugin-entry-exports.md](rc2-plugin-entry-exports.md) |
| A6 | `AppendOptions` в core/session | **B**: шов остаётся. Мерж в `core/session`: взять rc.2 целиком во всех 7 файлах, удалить `tests/append-ignorable.spec.ts`, вернуть 5 вставок шва (1 `types.ts` + 4 `index.ts`) из `git diff dsh-v0.2.2-rc.2 HEAD -- …`, затем `gen-persistence-catalog`. | [rc2-session-append.md](rc2-session-append.md) |

## Порядок исполнения (тред B)

1. **Подготовка** (ранбук 0): worktree `merge-<date>` от `7e52f3f8fc`; проверить чистоту; тег уже в локальном репо.
2. **Шаг 1 ранбука** — сброс генерируемого к rc.2. Список путей — из `gen-*`/`verify-*` пар; не включать `snapshots/`.
3. **Мерж** (`git merge dsh-v0.2.2-rc.2`) — разбор 58 файлов по категориям ранбука. Спецификации определяют подход в конфликтных зонах: `ui-settings-web-search` — брать апстрим (карточка сносится по A2), `core/session` — брать rc.2 + 5 вставок (A6), `llm` — rc.2 `error.ts` + 2 строки реестра + предикаты (A4), `mcp-client` — rc.2 + перенос по A3, `tool-subagent`/`subagent` — rc.2 + форк-швы (`allowedModels`, `backgroundMode`, `repository`, `handles`, D1-инвариант из A1), `ui-chat`/`ui-workspace` — апстрим + вернуть `restoreAt`/Thread-гнездо, scripts/tsconfig — апстрим + свои строки.
4. **A5-коммит**: долг-строки + удаления экспортов — до первого прогона `hygiene`.
5. **Перегенерация** (ранбук 3): `pnpm install`, все генераторы с гейтами, `verify-no-unknown-casts --prune`, парность — только затронутые.
6. **Снапшоты по A1 §4** руками, затем `DSH_SNAPSHOT=refresh pnpm run test:snapshot -t threads-project-worktree` — вывод принять как эталон.
7. **Проверка** (ранбук 4): typecheck, lint, test; точечно по пакетам из конфликтов; живой smoke на изолированном `DSH_HOME`.
8. Обновить замеры [INVENTORY.md](../INVENTORY.md) / [MEASUREMENTS.md](../MEASUREMENTS.md). Вырезка — за пользователем (ранбук 5).

## Хвосты для вырезки (не для B)

- `~/.dsh/profiles/web/cordis.patch.yml`: блок `web-fetch-http: trustedProxyAddressRanges` — поле не существует ни в одном дереве, снять (A2).
- Node ≥24.9 для живого хоста — на машине 22.19 (в nvm есть 24.22.2).
- `hooks-claude-code` и прочие пины профиля — по гайду `plugin-update-method`.
