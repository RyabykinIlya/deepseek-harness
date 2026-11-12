# MCP session-recovery против dsh-v0.2.2-rc.2

Разбор зоны 3 окна `rc.1 → rc.2` ([upstream-0.2.2-rc.2.md](upstream-0.2.2-rc.2.md), п. 2): `packages/mcp/mcp-client` переписан (`connection.ts` 476 строк churn, новые `generation.ts`, `status.ts`, `probe.ts`, `credentials.ts`, `deadline.ts`, `diagnostic.ts`, `templates.ts`, `types.ts`, плюс новый пакет `mcp/mcp-manager`), замеренные конфликты — 5 ханков в `connection.ts`, 2 в `tools.ts`. Всё ниже прочитано в дереве тега `dsh-v0.2.2-rc.2` до мержа.

## 1. Вердикт: апстрим НЕ закрыл протухшую сессию

Протухшая streamable-HTTP-сессия (HTTP 404 + `Session not found` на `tools/call`, без закрытия транспорта) в rc.2 **не восстанавливается сама**. Три звена пути проверены по коду.

**Ошибку вызова никто не распознаёт.** `src/tools.ts:152`, обёртка `call` внутри `syncTools` — единственный catch на tool-call:

```ts
      call: async (args, execution) => {
        try {
          const result = await client.callTool(…)
          if (result.isError !== true || opts.redact === undefined) return result
          return { isError: true, content: [{ type: 'text', text: opts.redact(…) }] }
        } catch (error) {
          if (opts.redact === undefined) throw error
          throw new Error(opts.redact(describeError(error)))
        }
      },
```

Ветка только редактирует секреты и пробрасывает дальше. `git grep -n -i "404\|sessionId\|expired\|SdkHttpError" dsh-v0.2.2-rc.2 -- packages/mcp/*/src` — пусто: ни распознавания, ни повтора нигде в пакетах `mcp/*`.

**Реконнект вооружается только закрытием транспорта.** `src/connection.ts:292`:

```ts
    client.onclose = () => {
      if (record.connectedAt !== undefined) lost(record, 'connection closed')
    }
```

`onclose` — единственный сигнал: `git grep -n "onerror\|onclose" dsh-v0.2.2-rc.2 -- packages/mcp/*/src` даёт ровно две строки (`connection.ts:292`, `generation.ts:45`), обработчика `onerror` супервизор не ставит. А 404 на `tools/call` закрытия не производит: в SDK 2.2.0 (пин `@modelcontextprotocol/client: "2.2.0"` одинаков в обоих тегах) `StreamableHTTPClientTransport._send` на `!response.ok` бросает `SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, 'Error POSTing to endpoint: …', { status, statusText, text })` и зовёт `this.onerror?.(error)`; `Protocol._onerror` только пробрасывает в `onerror`, `_onclose` не вызывается, `_sessionId` не сбрасывается (сброс есть лишь в `terminateSession()`). Сохранённый `mcp-session-id` продолжает уходить в каждом запросе (`headers.set("mcp-session-id", this._sessionId)`).

**Liveness-пингов в rc.2 нет.** Коммит `2425fa4f84` «feat(mcp-client): liveness health pings on established connections» в теге присутствует, но `6719b28294` «feat(mcp): let plugins register servers and manage them over Remote» их снял — своим же текстом: «Remove health checks, the `${env:NAME}` template scheme …». Проверка дерева: `git grep -c "healthCheck" dsh-v0.2.2-rc.2` — ноль совпадений; `armHealthPing`/`armHealthCheck`/`config.healthCheckIntervalMs` в дереве отсутствуют. Единственный `ping` в `packages/mcp` — заглушка в моке `tests/status.spec.ts:29`, её никто не зовёт. То есть **ждать, что пинг уронит генерацию с забытой сессией, нельзя: периодического пинга не существует**, и вопрос «сколько бы ждал tool-call» не имеет значения — ждать было бы бесконечно.

Итог для tool-call: первый 404 возвращается модели как ошибка инструмента, генерация остаётся «connected» (`status.update({ state: 'connected', … })` на `connection.ts:327` больше не меняется), и **каждый следующий вызов этого сервера падает так же до перезагрузки плагина или рестарта Host'а**. Ровно тот отказ, ради которого правка писалась. Правку переносим.

## 2. Куда правка ложится в rc.2 — по файлам

Старых точек вставки нет: `closeClient`, `settleFailedGeneration`, `generationDown`, `waitForClose`, `let client: Client | undefined` — всё это было в `rc.1`, в rc.2 счётчик каждого равен нулю; в `tools.ts` исчез `registrationFailure`, появились `opts.signal`, `redact`, `eligible`. Зато новая структура делает правку **меньше**, чем она была.

Владелец жизненного цикла генерации — два уровня:

- `src/generation.ts`, класс `McpGeneration`: один транспорт + своя отмена (`readonly lifetime = new AbortController()`), учёт незавершённой работы (`run(operation, timeoutMs?)`), подтверждённое закрытие (`close()` → `finish()`, где первым делом `this.lifetime.abort(new McpLocalError('MCP connection closed'))`).
- `src/connection.ts`, супервизор: запись `type Generation = { wire: McpGeneration; connectedAt?: number }` (строка 136), `current`, `isCurrent(record)` (149), `close(record)` (169), `enqueueSync(record)` (181), `scheduleReconnect(error, connectedAt?)` (198), **`lost(record, error)` (228)**, `connectGeneration()` (282), `dispose()` (386).

Ключ к упрощению — `lost`:

```ts
  function lost(record: Generation, error: string): void {
    if (!isCurrent(record)) return
    current = undefined
    settling = close(record).then((confirmed) => {
      readiness.resolve({ error: new Error(error) })
      if (confirmed) scheduleReconnect(error, record.connectedAt)
    })
  }
```

Он уже делает всё, что форк собирал руками: снимает владение, закрывает генерацию, вооружает обычный backoff. Поэтому `closeClient`/`settleFailedGeneration`/`waitForClose` при переносе **не воспроизводятся** — `recoverSession` сводится к «`lost(record, …)` + парковка до следующей синхронизированной генерации».

### 2.1. `src/tools.ts`

1. В `ToolBridgeOptions` (строки 28–40, рядом с `signal` и `redact`) — опциональное поле. Тип `ToolBridgeOptions` — обычный интерфейс, препятствий нет:

   ```ts
     /** Восстановление сессии, которую сервер забыл; omission — повтора нет. */
     recoverSession?: () => Promise<McpGeneration | undefined>
   ```

   Возвращать **генерацию, а не `Client`** — это отличие от rc.1 и обязательное: в rc.2 повтор обязан идти с сигналом живой генерации (см. п. 2.3).
2. `isExpiredSessionError(error)` — переносится без изменений (`error instanceof SdkHttpError && error.status === 404 && /session not found/i.test(error.message)`), импорт `SdkHttpError` добавляется к существующему `{ specTypeSchemas, type Client, type ImageContent }`. Экспорт нужен тесту.
3. Повтор — в catch обёртки `call` (`tools.ts:152`), **до** редактирования секретов, иначе 404 уже превращён в `new Error(redact(...))` и распознавание не сработает:

   ```ts
        } catch (error) {
          if (opts.recoverSession !== undefined && isExpiredSessionError(error)) {
            const next = await opts.recoverSession()
            if (next !== undefined) {
              return await next.run(signal => next.client.callTool(message, {
                signal: AbortSignal.any([execution.signal, signal]),
                timeout: opts.toolCallTimeoutMs, toolDefinition: tool,
              }))
            }
          }
          if (opts.redact === undefined) throw error
          throw new Error(opts.redact(describeError(error)))
        }
   ```

   Один повтор: второй 404 — другая неисправность и обязан дойти до вызывающего. Правка только в `syncTools`; **в `createMcpToolDefinition` её вносить нельзя** — эта функция публичная и её же зовут `experimental/computer-use-cua-driver-native` и `experimental/browser-use-stagehand-native`, у которых MCP-сессии нет вовсе.

### 2.2. `src/connection.ts`

1. Константа `SESSION_RECOVERY_TIMEOUT_MS = 10_000` — рядом с `DEFAULT_MAX_INSTRUCTION_BYTES` (55).
2. Набор ожидающих и его разрешение — те же `nextClientWaiters` / `resolveNextClientWaiters(next)`, но параметр теперь `Generation | undefined`.
3. `recoverSession(record)` вместо `recoverSession(failed)`: хук собирается в `enqueueSync` с замыканием на `record`, поэтому сверки идентичности клиента (`isCurrent(failed)` в rc.1) не нужно:

   ```ts
   async function recoverSession(record: Generation): Promise<Generation | undefined> {
     if (!isCurrent(record)) return current      // замена уже в полёте или на месте
     ctx.logger.warn(`${label}: server rejected the MCP session — reconnecting to establish a new one`)
     const next = waitForNextGeneration(SESSION_RECOVERY_TIMEOUT_MS)
     lost(record, 'server rejected the MCP session')
     return await next
   }
   ```

   Парковка создаётся до `lost`, потому что `lost` синхронно снимает владение.
4. Проброс — в объект опций `syncTools` внутри `enqueueSync` (`connection.ts:186`), где уже собираются `serverName`, `toolCallTimeoutMs`, `signal`, условный `redact`: `recoverSession: () => recoverSession(record)`.
5. Точки разрешения парковки (в rc.1 их было две, в rc.2 — пять, потому что терминальные состояния стали явными):
   - успех — после `record.connectedAt = Date.now()` / `status.update({ state: 'connected', … })` (`connection.ts:326–327`): `resolveNextClientWaiters(record)`;
   - `dispose()` (386) — `resolveNextClientWaiters(undefined)`;
   - `scheduleReconnect`, ветка `gave-up` (210–215) и ветка `!policy.enabled` (200–207) — `undefined` сразу, без ожидания 10 с;
   - `connectGeneration`, ветка `MissingTemplateValue` → `waiting-credentials` (336–339) — тоже `undefined`: восстановления не будет, пока не починят credential;
   - `close(record)` с `closureFailure` (`state: 'failed'`, `reason: 'unclosed-generation'`, 173–177) — `undefined`: замена заблокирована до рестарта Host'а.

### 2.3. Что в rc.2 новое и обязано попасть в перенос

- **Сигнал генерации.** `syncTools` получает `signal` генерации, и `callTool` зовётся с `AbortSignal.any([execution.signal, opts.signal])` (`tools.ts:156`). `McpGeneration.close()` первым делом делает `lifetime.abort(...)`, то есть к моменту повтора `opts.signal` уже прерван. Поэтому повтор обязан идти через `next.run(signal => …)` новой генерации, а хук — возвращать `McpGeneration`, а не `Client`. В rc.1 этой ловушки не было, и дословный перенос дал бы повтор, падающий по отмене.
- **Зарегистрированные определения инструментов** замыкаются на клиента и сигнал своей генерации; повтор обязан идти по возвращённому объекту, а не по `client` из замыкания.
- **Дублирования с `generation.ts`/`deadline.ts` нет**, но часть механики снимается:
  - `McpGeneration.run()` — учёт работы **внутри одной** генерации, межгенерационной парковки не даёт; набор ожидающих остаётся нужен.
  - `settling`/`syncChain` — хвосты цепочек, они разрешаются и при закрытии; «пришла синхронизированная генерация» из них не выводится, ждать их вместо парковки нельзя.
  - Рукописный `setTimeout` + `unref` в `waitForNextClient` **заменяется на `withDeadline(promise, SESSION_RECOVERY_TIMEOUT_MS, …)` из `src/deadline.ts`** (он уже делает `unref` и обёртку non-Error). Так как `withDeadline` отклоняет, а нам нужен `undefined`, перехват его `McpLocalError` даёт прежнюю семантику «не дождались — пробрасываем исходный 404».
- **Конфиг не добавляется.** `healthCheckIntervalMs`/`healthCheckTimeoutMs` апстрим снял осознанно (`6719b28294`); возвращать их как «альтернативное лечение» нельзя — это откат апстримного решения, а не перенос нашей правки.
- **Тест** `tests/session-recovery.spec.ts` переписывается: в `opts()` больше нет `registrationFailure`, появились обязательный `signal` и `eligible`-аргумент `syncTools`; мок клиента должен отдавать `McpGeneration`-подобный объект с `run()` и `client`. `executeModelToolFixture` и `@deepseek-ai/dsh-tool-testkit` в rc.2 на месте (`packages/test-support/tool-testkit/src/index.ts:76`, devDependency в `mcp-client/package.json`), фикстура остаётся прежней.
- **README пакета** (`src`-карта в «Source map» и абзац «Startup, updates, and reconnection») — наша строка про восстановление сессии добавляется туда же, где апстрим описывает реконнект.

## 3. Контрибуция в апстрим: ветку переписывать

`origin/fix/mcp-session-recovery-404` = один коммит `c8e38bf08d` «fix(mcp-client): recover a dropped streamable-HTTP session» (`connection.ts` +72, `tools.ts` +48, тест +137). Содержимое идентично тому, что на `master` форка: `git diff origin/fix/mcp-session-recovery-404 HEAD -- packages/mcp/mcp-client/src/{connection,tools}.ts` показывает только чужую правку `resources/list` (капability-гейт), самой session-recovery не касающуюся; `git merge-base --is-ancestor origin/fix/mcp-session-recovery-404 HEAD` — ветка уже влита в `master` форка.

Применимость к rc.2 проверена, а не оценена: патч `c8e38bf08d` (только `src/`) против файлов из тега —

```
checking file packages/mcp/mcp-client/src/connection.ts
Hunk #1 succeeded at 54 with fuzz 2 (offset 1 line).
Hunk #2 FAILED at 139.  Hunk #3 FAILED at 216.  Hunk #4 FAILED at 348.  Hunk #5 FAILED at 396.
checking file packages/mcp/mcp-client/src/tools.ts
Hunk #2 FAILED at 30.   Hunk #3 FAILED at 135.
```

Прошёл только ханк с константой. **Решение: ветка переписывается заново, текущая не предлагается.** Два независимых основания:

1. Код не ложится: исчезли все якоря (`closeClient`, `settleFailedGeneration`, `generationDown`, `registrationFailure`), изменилась сигнатура `syncTools`, появился сигнал генерации — переписывать нужно и правку, и тест (п. 2).
2. Ветка стоит не на апстримной истории: её база — точка расхождения форка (`687f282e86`, релиз `0.2.1-rc.2`), и в ней 100+ форковых коммитов (`788730dd30` «chore: classify llm-fallback…» — форк-онли). Как PR она не предъявляема в любом случае: нужна новая ветка от апстримного `master`.

Цель переписывания — **апстримный `master`, а не `rc.2`**: апстрим уже на 166 коммитов дальше тега (замер в [upstream-0.2.2-rc.2.md](upstream-0.2.2-rc.2.md), п. 1), и `connection.ts` — файл, который в этом окне переписывали дважды.

Исход по [MERGE-RUNBOOK.md](../MERGE-RUNBOOK.md) («Что делать с правками ядра») до того, как PR существует, — **исход 3, держать локально**; причина уже записана в [alienation-backlog.md](alienation-backlog.md) §3 («session-recovery MCP … восстановление сессии в рамках одного tool-call, фейл вместо стоянки», разблокирует «конфигурируемая политика восстановления в апстримном клиенте»). Запись §1.9 остаётся в силе: 2 M + 1 A, зона не выгружается. Разблокирующий шов апстрим в этом окне **не** привёз: политика восстановления не конфигурируется, хука на ошибку tool-call нет.

## 4. `mcp-manager`: для живого профиля ничего не меняется

Плоские строки `@deepseek-ai/dsh-mcp-client` в rc.2 работают как раньше — менеджер их не вытесняет.

- `mcp-client` остаётся самостоятельным плагином: `src/index.ts` в rc.2 экспортирует `name = 'mcp-client'`, `inject = ['tools']`, `Config`, `apply(ctx, config)`; схема `Config` (строки 161–190) по-прежнему принимает `transport`, `serverName`, `url`, `headers`, `command`, `args` — ровно то, что стоит в двух наших строках.
- Менеджер — **потребитель** `mcp-client`, а не замена: `packages/mcp/mcp-manager/README.md`, раздел «When to choose it»: «Keep plain `dsh-mcp-client` rows instead when a deployment pins its servers in the composition, or when a server belongs to one agent preset rather than the whole Host; the manager governs the global plane only». Наши строки пинятся композицией профиля — это ровно описанный случай.
- Миграция не требуется и апстримом не объявлена: среди 45 новых upgrade-гайдов окна **нет ни одного про MCP** (`git diff --name-only rc.1 rc.2 -- docs/upgrade-guide | grep -i mcp` — пусто).

Что приходит само и на что смотреть при вырезке:

- В `packages/bundle/web-app/cordis.patch.yml:153` появилась строка `- id: mcp-manager / name: '@deepseek-ai/dsh-mcp-manager' / inject: [credentials]`. Наш профиль `web` монтирует `@deepseek-ai/dsh-web-app`, значит менеджер приедет в живой профиль автоматически, с пустым `config.servers` (дефолт `z.dict(ServerEntrySchema).default({})`).
- Пустой менеджер серверов не поднимает, конфликта имён нет. Коллизия возможна только если кто-то заведёт в его `servers` ключ `siebel-research` или `jira`: `serverName` резервируется через `activeServerNames` в области регистрации, и дети менеджера монтируются под его fiber'ом в том же корне — второй инстанс с тем же именем упадёт на загрузке с внятной ошибкой («already in use by another mcp-client instance»). Два наших ключа заняты строками профиля, в `servers` менеджера их не добавлять.
- Апстримный тест `apps/cli/tests/profile-mcp.spec.ts` требует, чтобы в **shipped-профилях** не было ни одной строки `@deepseek-ai/dsh-mcp-client` (`expect(rows.filter(row => row.name === '@deepseek-ai/dsh-mcp-client')).toEqual([])`). Проверяются только шаблоны из `PROFILE_TEMPLATES`; пользовательский `~/.dsh/profiles/web/cordis.patch.yml` в выборку не входит, наши `insert`-строки гейт не ломают. Но свои строки `mcp-client` нельзя заводить в **наших бандл-пакетах** (`threads-profile`, `model-routing-profile`, `web-search-profile`) — сейчас их там нет (`grep` по `packages/*/*/cordis.patch.yml` пуст).

Профиль править не нужно. Обе строки в `~/.dsh/profiles/web/cordis.patch.yml` — `mcp-siebel-research` (строка 578) и `mcp-jira-search` (строка 596) — остаются как есть.

Переезд в менеджер возможен как добровольный (даёт `restart`/`probe`/статус над Remote и правку из Settings), но это замена `insert`-строк на патч строки `mcp-manager`, а не требование окна:

```yaml
# НЕ обязательно для rc.2; альтернатива двум insert-строкам
- id: mcp-manager
  config:
    servers:
      siebel-research:
        transport: streamable-http
        url: https://siebel-research-mcp.k8s.dev002.local/mcp
        headers:
          X-Omni-User: ryabykinia@sibur.ru
      jira:
        transport: stdio
        command: /home/ilya/Sibur/atlas/credit-limit-atlas-local-build/tools/jira_mcp.sh
```

Цена варианта: патч заменяет `servers` целиком, инстансы начинают жить под fiber'ом менеджера (общий `restart`, общая остановка), а имена `siebel-research`/`jira` переходят под валидацию менеджера. Выгоды для текущего использования нет — оставляем плоские строки.

## 5. Чего в этом дереве проверить нельзя

- **Не запускалось ничего**: ни `pnpm install`, ни сборка, ни тесты, ни типы. Утверждения п. 2 о компиляции (например, что `recoverSession` типизируется как поле `ToolBridgeOptions`) — чтение типов, а не вывод компилятора.
- **Живой отказ не воспроизводился.** Поведение SDK 2.2.0 (404 бросает `SdkHttpError`, уходит в `onerror`, транспорт не закрывается, `_sessionId` не сбрасывается) прочитано в `node_modules/.pnpm/@modelcontextprotocol+client@2.2.0/.../dist/index.mjs` основного чекаута; версия пина совпадает с обоими тегами, но текст тела ответа реального сервера (`Session not found`) в rc.2-дереве заново не наблюдался — регулярка `isExpiredSessionError` остаётся привязанной к наблюдению октября.
- **Апстримный `master` не смотрели**: в этом worktree есть только теги `dsh-v0.2.2-rc.1`/`rc.2` и ветки форка, `upstream/master` не зарегистрирован. Закрыл ли апстрим эту дыру в 166 коммитах после тега — **не проверено**; перед переписыванием PR это первый вопрос.
- **Поведение после мержа не измерено**: что 10 с остаются разумной границей при новых бюджетах rc.2 (`startupTimeoutMs`, `closeTimeoutMs` = 5 с, `reconnect.initialDelayMs` = 500 мс) — расчёт по значениям дефолтов, не замер.
- **Живой профиль не перезапускался** под rc.2: утверждение «две строки продолжают работать» выведено из схемы `Config` и теста композиции, а не из поднятого Host'а.
- Не проверялось, нужна ли нашей правке запись в `scripts/plugin-entry-existing-exports.ts` (новый гейт `verify-plugin-entry-exports`): `isExpiredSessionError` экспортируется из `src/tools.ts`, а не из entry пакета, но взаимодействие гейта с апстримным `mcp-client` в дереве не прогонялось.
