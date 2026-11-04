# Cross-provider LLM fallback — план реализации

Восстановление фичи «если провайдер умер — переключиться на следующего» после ревью коммита `446c99e2e3`.

## Состояние: не работает

Фича не работает вообще, и это не мелкая поломка — неверно выбран шов интеграции. Пакет `packages/llm/llm-fallback` собран, проходит `typecheck` и имеет 8 тестов на резолюцию конфига, то есть выглядит готовым. В рантайме он не подключён никуда и переключить провайдера не может.

Причины, проверенные по коду:

- **Мутация `this.options` ничего не меняет.** `packages/core/agent-loop/src/agent.ts:524-540` присваивает `this.options.provider/model`, но `prepareRequest` берёт конфиг из уже залогированного заголовка, когда `requestHeaderLogged === true` (`agent.ts:600-601`), а флаг выставляется в `buildRequest` до отправки (`agent.ts:659`). На первом же шаге он `true`, поэтому запрос уходит тому же провайдеру.
- **Бесконечный цикл.** `llm-retry` на исчерпанном бюджете делегирует `next()`, `llm-fallback` на том же `provider` возвращает тот же `{ kind: 'fallback', ... }`, `continue` крутит `while (true)` в `step()` (`agent.ts:409`). Каждая итерация дописывает `assistant/attempt` и `llm/fallback` — журнал сессии растёт безгранично, каждая попытка тарифицируется.
- **Расширение core-типа ради leaf-плагина.** `RequestErrorAction` в `packages/core/agent/src/runtime-types.ts:122` знал только `{ kind: 'retry' }`. Добавлять в него чужое действие не нужно: всё, что требуется, выражается существующими двумя waterfall'ами.
- **Инверсия зависимости в графе пакетов.** `agent-loop/src/agent.ts:28` типизированно импортирует `@deepseek-ai/dsh-llm-fallback`, не объявив её в `packages/core/agent-loop/package.json`, при этом `llm-fallback` dev-зависит от `agent-loop`. Ядро loop не должно знать про leaf-плагин.
- **Пакет не смонтирован.** Ни один `cordis.yml`/профиль/бандл его не подключает.
- **Мёртвый код.** Проекция `llmFallback` (`index-plugin.ts:31,71-80`) всегда `null` и никем не читается; `LlmFallbackRouter`, `streamWithFallback`, `resolveChain`, `ResolvedFallbackResult`, `FallbackExecutionState` экспортированы без потребителей; `inject: ['agents','llm']` не используется (нужен только `sessionProjections`).
- **Неверный тип события.** `types.ts:17-38` объявляет `'llm/fallback'(this: never, ...)`. Такого в репозитории нет: события Session — это только merge в `SessionEventMap` (`llm-retry/src/types.ts:6-13`), а cordis-события живут в `Events` с `@mode`. `this: never` делает событие неэмитируемым.
- **Хардкод деплоймент-специфичных значений.** `config.ts:64-91` содержит `Anthropic/Anthropic-chat`, `claude-proxy/claude-opus-5`, `Anthropic-coder` в `DEFAULT_*` при пустой `Config = z.object({})`. Это ровно тот случай, который `packages/AGENTS.md` запрещает: различающееся по деплойментам должно быть валидируемым полем конфига.
- **Нет README/i18n/locale.** У соседей (`llm-retry`) есть `README.md`, `README.zh.md`, `README.i18n.yaml`, `locale/`.
- **Воскресшее дерево `docs/adr/`.** `7c400e9c02` схлопнул `docs/adr/` и `docs/rfc/` в `.agents/notes/{proposed,implemented,rejected}/`. Коммит вернул `docs/adr/` обратно.
- **Persisted-тип без acknowledgement.** Новый `llm/fallback` в `SessionEventMap` требует записи в `docs/persistence-changes/` и снапшота схемы в том же изменении.

## Целевой дизайн

Провайдер переключается **двумя существующими waterfall'ами**, без правок core:

| Шов | Роль |
|---|---|
| `agent/request-error` | Зафиксировать «следующая попытка идёт по шагу N+1» и вернуть `{ kind: 'retry' }`, чтобы loop перезапустил шаг на той же durable истории |
| `agent/request` | Следующий `prepareRequest` забирает отложенный шаг и возвращает `LlmCallConfig` с другим `provider`/`model` |

`prepareRequest` вызывает `llm.prepareCall(proposedConfig)`, поэтому возврат другого `provider` реально резолвит другой адаптер. Prior art: `packages/experimental/model-routing/src/service.ts:279` переписывает конфиг ровно на этом шве.

Порядок слушателей: `llm-retry` (`agent/request-error`) маунтится раньше, `llm-fallback` вызывает `next()` первым — так каждый провайдер сначала исчерпывает **свой** бюджет, и только потом цепочка двигается дальше. Бюджет нового провайдера независим: ключ состояния ретраев — пара `(provider, policyKey)` (`llm-retry/src/index.ts:79`).

Терминация: индекс шага цепочки растёт монотонно и никогда не пере-матчится на упавшем провайдере. Нет следующего шага — `retry` не возвращается, ошибка терминальна.

Состояние прогресса — in-memory `Map` по `(turn, step)`, сбрасывается на `step/start` и `turn/end`. Durable часть — только уже существующее событие `llm/fallback`.

## Фазы и задачи

Задачи самодостаточны: их можно раздать тредам. Таблица конфликтов — в конце.

### Фаза 1 — откат сломанной интеграции (блокирует всё)

- [ ] **T1.1 Откатить правки core.**
  `git revert` не нужен целиком — снимите только правки ядра:
  - `packages/core/agent-loop/src/agent.ts` — убрать импорт `FallbackChainId` (стр. 28) и блок `if (action?.kind === 'fallback')` (стр. 524-540).
  - `packages/core/agent/src/runtime-types.ts` — вернуть `export type RequestErrorAction = { kind: 'retry' } | undefined`.
  - `packages/core/agent-loop/tsconfig.json` — убрать reference на `../../llm/llm-fallback`.
  - `packages/core/agent-loop/package.json` — убедиться, что зависимости нет и не появилось.

  Приёмка: `grep -rn "llm-fallback" packages/core/` пуст; `git diff` по core показывает только удаления.

### Фаза 2 — типы и контракт события

- [ ] **T2.1 Переписать объявление события.**
  `packages/llm/llm-fallback/src/types.ts`: удалить cordis-блок `declare module '@deepseek-ai/cordis' { interface Events { 'llm/fallback'(this: never, ...) } }` целиком. Оставить только `declare module '@deepseek-ai/dsh-session/types' { interface SessionEventMap { 'llm/fallback': LlmFallbackEventData } }` и вынести payload в именованный `export type LlmFallbackEventData` — по образцу `LlmRetryEventData` (`packages/llm/llm-retry/src/types.ts:16`).

  Поля: `turn`, `step`, `provider`, `model`, `chainId`, `chainIntent`, `attempt` (номер попытки в цепочке, 1-based), `from: { provider, model }`, `failure: LlmFailure`. JSDoc — с `@param payload` не нужно (это не cordis-событие), но каждое поле — с описанием контракта.

  Приёмка: `pnpm run build:artifacts --scope typecheck` зелёный; `grep "this: never" packages/llm/llm-fallback` пуст.

- [ ] **T2.2 Ackowledge persistence-типа.**
  Добавить запись в `docs/persistence-changes/` по `docs/cookbook/reviewing-persistence-type-changes.md`: `.md`, `.zh.md`, `.i18n.yaml`, обновлённый `.schema.json`. Событие помечается `{ ignorable: true }` при записи, потому что потеря `llm/fallback` не влияет на реконструкцию (это лог попыток, не сообщение) — обосновать в тексте ackowledgement.

  Приёмка: `pnpm run test:docs` зелёный.

### Фаза 3 — конфигурация вместо хардкода

- [ ] **T3.1 Схема конфига с цепочками.**
  `packages/llm/llm-fallback/src/config.ts`: удалить `DEFAULT_FALLBACK_CONFIG` с конкретными провайдерами. Ввести `Config`-схему schemastery с полем `chains: z.dict(chainSchema)` и валидацией: непустой `steps`, непустые `provider`/`model`, уникальные `(provider, model)` внутри цепочки. Резолв — один раз при `apply()`, не на каждый сбой.

  Имя intent'а — ключ словаря; `intent` в событии берётся из него, а не хардкодится.

  Приёмка: конфиг с пустыми `steps` падает на загрузке с внятным сообщением, называющим цепочку; тест на это.

- [ ] **T3.2 Выбор цепочки для сессии.**
  Интент определяется по `agent.session` (пресет/тир), а не константой. Если подходящей цепочки нет — плагин бездействует и логирует это один раз при монтировании, а не молча.

  Приёмка: сессия без совпадающей цепочки не ломается и не даёт fallback.

### Фаза 4 — слушатели

- [ ] **T4.1 `agent/request-error`: фиксация перехода.**
  Слушатель вызывает `next()` первым (даёт `llm-retry` исчерпать бюджет и вернуть `{ kind: 'retry' }` — если вернул, немедленно прокинуть дальше). Иначе: найти шаг в цепочке по `payload.provider` **и** `payload.model`, вычислить следующий, записать в pending-map под `(turn, step)`, вернуть `{ kind: 'retry' }`. Нет следующего шага — вернуть `next()` результат без изменений, ошибка терминальна.

  Матчинг строго по паре: иначе цепочка с одним провайдером и разными моделями разрешится в неверный индекс.

  Приёмка: тест на двух мок-адаптерах — первый падает, второй отвечает; в логе `request/header` с `reason: 'change'` и новым `provider`.

- [ ] **T4.2 `agent/request`: подмена конфига.**
  Слушатель вызывает `next()`, забирает pending-запись для `(turn, step)`, удаляет её и возвращает `{ ...proposed, provider, model }` следующего шага. Нет записи — вернуть `proposed` без изменений.

  Приёмка: одна запись consumed ровно один раз; повторный `agent/request` на том же шаге не переиспользует переход.

- [ ] **T4.3 Сброс состояния и диспоуз.**
  Слушатели `step/start` и `turn/end` чистят pending-map. `ctx.effect` снимает все три слушателя и очищает map. Регистрация проекции — только если она реально нужна; иначе удалить (см. T5.1).

  Приёмка: HMR/reload тест — после dispose слушатели не срабатывают.

- [ ] **T4.4 Границы и защита от зацикливания.**
  Явный предел: длина цепочки. Дополнительно — не более одной подмены на `(turn, step)`, повторный `request-error` на том же шаге не двигает цепочку второй раз, если предыдущая подмена не была потреблена (значит, `agent/request` не сработал — это баг, а не повод крутиться).

  Приёмка: negative control — цепочка из одного шага даёт терминальную ошибку, а не цикл; тест падает по таймауту, если защита убрана.

### Фаза 5 — убрать мёртвый код

- [ ] **T5.1 Удалить неиспользуемое.**
  `LlmFallbackRouter`, `streamWithFallback`, `resolveChain`, `ResolvedFallbackResult`, `FallbackExecutionState`, `FallbackAttemptId` и проекция `llmFallback` — у каждого нет потребителя. Парную спекулятивную обобщённость `packages/AGENTS.md` прямо запрещает («require a current owner and need»).
  `inject` сократить до реально используемого (`sessionProjections`).

  Приёмка: `grep` по каждому удалённому имени пуст вне пакета.

- [ ] **T5.2 Почистить зависимости.**
  `packages/llm/llm-fallback/package.json`: убрать `dsh-agent-loop`, `agent-loop-testkit`, `llm-deepseek`, `llm-pi-ai` из dev — они не используются.

  Приёмка: `pnpm run hygiene` зелёный.

### Фаза 6 — документация

- [ ] **T6.1 README пакета.**
  `README.md` + `README.zh.md` + `README.i18n.yaml` по канону `packages/AGENTS.md` (раздел Model Experience). Описать: как выбирается цепочка, порядок с `llm-retry`, что происходит при исчерпании, сколько стоит каждая попытка, что событие non-surface.

- [ ] **T6.2 Locale.**
  Либо добавить `locale/*.json` для видимых строк, либо убрать `locale` из `files`/`exports`, если строк нет. Сейчас объявлено, но пусто.

- [ ] **T6.3 Заметка вместо ADR.**
  Удалить `docs/adr/` (файл и `README.md`). Решение записать в `.agents/notes/proposed/feature/<YYYY-MM-DD>-cross-provider-llm-fallback.md` + `.zh.md` + `.i18n.yaml`, `Status: proposed`, по образцу соседей.

  Приёмка: `ls docs/adr` → нет каталога; заметка проходит `verify-archived-agent-notes` и doc-гейты.

### Фаза 7 — тесты

- [ ] **T7.1 Real-composition loader-тест.**
  Boot test-only `cordis.yml` через Loader, как требует `packages/AGENTS.md` («Product-visible plugins require a non-unit REAL-composition test»). Проверить: плагин монтируется, `name`/`inject`/`Config` named-export'ом, без default-export.

- [ ] **T7.2 Поведенческий тест переключения.**
  Два мок-адаптера: `a` всегда падает с retryable-кодом, `b` отвечает. Проверить в журнале: `llm/fallback` с `from`/`to`, `request/header` с `reason: 'change'` и `provider: 'b'`, финальный `assistant/message` от `b`. Проверить, что `a` получил ровно свой бюджет попыток, а `b` начал с чистого.

- [ ] **T7.3 Negative controls.**
  - Цепочка кончается → терминальная ошибка, не цикл.
  - Провайдер вне цепочек → поведение как до фичи.
  - Невалидный конфиг → падение на монтировании.

- [ ] **T7.4 Убрать `any` из тестов.**
  `tests/config.spec.ts:12` — `Map<string, any>` и `: any`. Заменить типизированной сигнатурой. Добавить тест на резолв конфига из `Config` (T3.1), а не на хардкод-дефолты.

  Приёмка: `pnpm run lint` не содержит новых исключений; `scripts/no-unknown-casts.baseline.json` не растёт.

### Фаза 8 — подключение

- [ ] **T8.1 Смонтировать в профиле.**
  Добавить строку в соответствующий `cordis.yml`/бандл, чтобы фича была достижима. Если сознательно не включается по умолчанию — оформить как opt-in с явной строкой и записать это в заметке.

  Приёмка: `px dsh --profile headless "..."` показывает смонтированный плагин; snapshot-тест профиля обновлён.

## Конфликты по файлам

Задачи ниже **нельзя** вести параллельно — общие файлы.

| Файл | Задачи |
|---|---|
| `packages/llm/llm-fallback/src/types.ts` | T2.1, T5.1 |
| `packages/llm/llm-fallback/src/config.ts` | T3.1, T3.2 |
| `packages/llm/llm-fallback/src/index-plugin.ts` | T4.1, T4.2, T4.3, T4.4, T5.1 |
| `packages/llm/llm-fallback/package.json` | T5.2, T6.2 |
| `packages/core/agent-loop/*`, `packages/core/agent/*` | только T1.1 |

Безопасно параллелятся: T1.1 ∥ T6.3; T2.2 ∥ T3.1; T6.1 ∥ T7.x после T4.

## Порядок запуска тредов

1. **Тред A** — T1.1 (откат). Остальное ждёт: пока core не чист, остальные правки конфликтуют.
2. **Тред B** — T2.1 → T3.1 → T4.1 → T4.2 → T4.3 → T4.4 → T5.1 (одна цепочка, общие файлы).
3. **Тред C** — T2.2 ∥ T6.3 ∥ T5.2 (независимые файлы) — можно параллельно с B.
4. **Тред D** — T7.1…T7.4 после T4.4; T6.1 ∥ T6.2 после T5.2.
5. **Тред E** — T8.1 после A и B.

## Открытые решения

- **Восстанавливать ли исходный маршрут после успешного fallback?** Сейчас заголовок запроса пишет провайдера, который ответил, и следующие шаги пойдут по нему. Это, вероятно, желаемое поведение, но оно должно быть решением, а не побочным эффектом; альтернатива — возврат к исходному маршруту на `turn/start`.
- **Нужен ли fallback для вспомогательных вызовов** (`purpose: 'session-title' | 'compaction'`)? Они идут не через `step()`, и текущий дизайн их не покрывает.
- **Что с `usage`/токен-метрингом** при нескольких попытках: списывается каждая, UI должен это показывать — или отдельная задача, или явный non-goal.

## Вне скоупа

Новые провайдеры, изменение политик `llm-retry`, UI-строки, mid-stream переключение (каждая попытка — целый запрос).
