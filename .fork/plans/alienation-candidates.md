# Кандидаты на отчуждение — после мержа rc.1

Директива окна мержа 2026-11-04: отчуждать дёшево и с сохранением поведения прямо в merge-ветке; крупное — записывать сюда с оценкой, чтобы делать после мержа без повторного вывода. Сделанное в этом окне — в [DECISIONS.md](../DECISIONS.md#переименование-ctxworktrees--ctxthreadworktrees-2026-11-04).

## Сделано в окне мержа rc.1

| Что | Файлы, снятые с поверхности | Куда уехало |
|---|---|---|
| `ctx.worktrees` → `ctx.threadWorktrees` | строка декларации в `worktree-manager/src/index.ts` перестала предсказуемо конфликтовать; `provide('worktrees')`-дубли тестов больше не colliding-ключ | наш сервис, имя теперь уникально против апстрима |
| `SessionNode.threads` опционален | тесты `ui-workspace` (30+ конструкций узла) и `tree.ts` вернулись к апстримной форме | тип форка совместим с апстримными литералами |
| `userAgentOverride` на водопаде `prepareHeaders` | `adapter.ts` llm-pi-ai: наша правка живёт на апстримном seam, а не параллельной функцией | строк не убавилось, но правка теперь следует за апстримным рефакторингом, а не против него |

## Кандидаты (не делаем в окне мержа)

| Кандидат | Апстримные файлы | Оценка | Куда отчуждать |
|---|---|---|---|
| **Restore** (`restoreAt` в ui-chat) | `contract/slots.ts`, `ChatView/ChatFlow/ChatNodeSeat`, `apply.ts`, ~6 тестов | ~1 день: свой client-плагин с seat'ом + inject-хендл; slot-ключ не нужен новый (перерисовка по `ChatNodeKind` уже допускает пакет-владелец) | `packages/client/ui-chat-restore/` |
| **Thread-гнездо в сайдбаре** (`ThreadNodeItem`, seat, лимиты разворота) | `Rows.tsx`, `WorkspaceBrowser.tsx`, `index.ts`, тесты (~14 файлов) | 2–3 дня: самый толстый кусок поверхности; нужен `slots.inject` на декларацию браузера и перенос расширения дерева в свой пакет с проекцией строк | `packages/client/ui-workspace-threads/` |
| **Прямые источники + ротация ключей в llm-pi-ai** (`dispatch`, `apiKeys`/`keyCooldownMs`, `metadataUserId`, `userAgentOverride`) | `adapter.ts`, `config.ts`, `discovery.ts`, `types.ts`, `index.ts` (~16 файлов с тестами) | 3–5 дней: вариант «свой адаптер поверх `registerAdapter`» уже выбран (см. DECISIONS), но конфиг-схема и discovery-профиль всё ещё в апстримных файлах; отчуждение = свой пакет конфига + свой discovery, адаптер уже наш | `packages/llm/pi-ai-dispatch/` (план уже есть: [model-routing.md](model-routing.md)) |
| **Web-search селектор в настройках** (`WEB_SEARCH_PROVIDER_IDS`) | `ui-settings-web-search` (7 файлов) | полдня: апстрим регистрация принимает любой id; осталась только выпадашка — перевести на свой settings-плагин поверх общего слота | в `packages/web/web-search-profile/` |
| **`tool-subagent` capability-строки** (`allowedModels`, `backgroundMode`, `repository` в манифесте capability) | `tool-subagent/src/index.ts` + типы (~10 файлов) | 1–2 дня: после опционального `repository` остались только добавки; вынести в собственный tool-обёрточный пакет, который декорирует апстримный | в forks-стек Threads |
| **Тестовые дубли `session-snapshot`/`client-runtime`** | по 2–3 файла | часы: форк-хелперы в `test-support` перенести в `packages/experimental/*`-testkit | рядом с потребителями |

Порядок по соотношению цена/выигрыш: селектор web-search → тестовые дубли → Restore → `tool-subagent` → llm-pi-ai-конфиг → Thread-гнездо.

## Не отчуждаем (записано, чтобы не пересматривать)

- `.gitignore`, `lefthook.yml`, `tsconfig.*.json`, `scripts/*` — точки регистрации категории B, цена строки; отчуждать нечего.
- Сгенерированное и `.zh.md`/`.i18n.yaml` — перегенерируется, не поверхность в смысле правок.
