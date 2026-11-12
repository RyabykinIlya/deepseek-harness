# Коды отказов LLM в реестре dsh-v0.2.2-rc.2 — спецификация адаптации

Подготовлено 2026-11-12 до мержа, по `git show dsh-v0.2.2-rc.2:…`. Окно замерено в [upstream-0.2.2-rc.2.md](upstream-0.2.2-rc.2.md) (п. 3 таблицы, строка 8; п. 3, гайд `llm-error-builtin-codes`). Здесь — только зона кодов отказов: что вписать в реестр, что перевести на `LlmError.fromFailure`, почему конфиг живого профиля продолжает грузиться и как это проверить. Мерж выполняет [MERGE-RUNBOOK.md](../MERGE-RUNBOOK.md); сама правка `error.ts` конфликтует, поэтому раздел 5 описывает результат против версии rc.2, а не против текущей форк-версии.

## 1. Что изменил апстрим — замер по источнику

- `packages/llm/llm/src/error.ts` (rc.2, стр. 17–64): `LLM_FAILURE_CODES` — закрытый реестр, `as const satisfies Readonly<Record<string, { readonly retryChoice?: true }>>`. Ключи — встроенные коды; записи с `{ retryChoice: true }`: `EMPTY_RESPONSE`, `MALFORMED_RESPONSE`, `QUOTA`, `RATE_LIMIT`, `SERVER`, `STREAM_CLOSED`, `TIMEOUT`, `TRANSPORT`.
- Там же (стр. 73): `export type BuiltinLlmFailureCode = keyof typeof LLM_FAILURE_CODES | \`HTTP_${number}\``.
- `packages/llm/llm/src/index.ts` (rc.2, стр. 100): `export class LlmError extends HarnessError`, конструктор — `code: BuiltinLlmFailureCode` вместо `string`; для прочих кодов — `static fromFailure(failure: LlmFailure, options?: ErrorOptions)`, который прокидывает код через `failure.code as BuiltinLlmFailureCode` с рантайм-валидацией непустой строки в конструкторе (комментарий на месте: «the built-in type constrains only codes raised here»). `LlmFailure.code` в `types.ts` остался `string` — рантайм-поведение не изменилось.
- `packages/llm/llm/src/error.ts` (rc.2, стр. 76–79): `RETRY_CODE_CHOICES` — производная от записей с `retryChoice`, в порядке объявления. Потребители по `git grep RETRY_CODE_CHOICES dsh-v0.2.2-rc.2 -- packages/`: только `retry-policy.ts` и тест `llm/tests/retry-policy.spec.ts` (тест с 119-й строки фиксирует и состав choices, и допуск посторонних строк).
- `packages/llm/llm/src/retry-policy.ts` (rc.2, стр. 19–25, 94–96): ветка `retryableCodes` нормальной политики —

  ```ts
  // The constant branches publish the built-in choices to settings forms; the
  // string branch admits codes that other providers raise.
  retryableCodes: z.array(z.union([...RETRY_CODE_CHOICES.map(code => z.const(code)), z.string().min(1)]))
    .min(1).default([...DEFAULT_RETRYABLE_CODES]),
  ```

  Константные ветки — только витрина настроек; строковая ветка принимает любой непустой код. `resolveRetryPolicy` (стр. 176–184) дальше проверяет то же самое: `typeof code !== 'string' || code.length === 0`.
- UI Models (`packages/client/ui-settings-models`): `RetryPolicyEditor.tsx` строит чекбоксы из константных веток схемы (`choicesOf`, стр. 70–75 — только ветки `const` попадают в список выбора); код вне choices показывается «verbatim» и вводится через поле **Custom error code**. README (стр. 58): «A third-party code is typed into **Custom error code** and added with **Add** or Enter…». Код, попавший в реестр без `retryChoice`, в чекбоксах **не появится** — и до UI дойдёт только как вербатим-строка унаследованного/сохранённого значения.

Гайд `docs/upgrade-guide/v0.2.2-alpha.2/llm-error-builtin-codes/guide.md` — консистентен с источником; миграция: встроенный код — в реестр, сторонний — через `LlmError.fromFailure({ message, code, ...facts }, { cause })`.

Класс `HarnessError` в rc.2 переехал в новый пакет `@deepseek-ai/dsh-error` (`packages/util/error`), `error.ts` его реэкспортирует. Форк `error.ts` правит, но `HarnessError` в правки не трогает — конфликтных ханков по нему нет.

## 2. Решение по реестру

### 2.1 `KEY_QUOTA` — в реестр, без `retryChoice`

`KEY_QUOTA_EXCEEDED_CODE` (`error.ts`, форк-строка 41) и `isKeyQuotaExceededError` (форк-строки 137–197) — провайдер-нейтральный код, поднимаемый встроенным адаптером `llm-pi-ai`: `classifyPiAiError` возвращает его из `stream.ts:46`, `adapter.ts:576` бросает его как `new LlmError(…, KEY_QUOTA_EXCEEDED_CODE)` при исчерпании пула ключей. Ровно под это определение подходит и заголовок реестра («Every failure code the built-in providers and the LLM runtime raise»), и пункт 8 окна (апстрим-плана): без записи не скомпилируется.

Запись — `{}` без `retryChoice`. Что флаг реально делает: единственный потребитель `RETRY_CODE_CHOICES` — строка 95 `retry-policy.ts`, константные ветки схемы, из которых UI строит чекбоксы; флаг ничего не делает больше. Собственное JSDoc реестра фиксирует: «being a choice does not make a code retried by default» (то же — в доке `EMPTY_RESPONSE_CODE` и в тесте `retry-policy.spec.ts`: choices содержит `STREAM_CLOSED`, дефолт — нет). Код попадает в дефолтный набор ретрая только через `DEFAULT_RETRYABLE_CODES` — прямой список в `retry-policy.ts:19–25`.

`KEY_QUOTA` ретраить по умолчанию нельзя и в чекбоксах показывать не нужно: per-key потолок сам не рассасывается (в отличие от `RATE_LIMIT`), ретрай того же запроса по тому же маршруту бессмыслен — разблокирует ротация ключей в `adapter.ts` или попадание кода в `retryableCodes` конкретного деплоя. Ровно поэтому живой профиль перечисляет коды явно, а не полагается на дефолт. Строковая ветка схемы и сравнение `policy.retryableCodes.includes(failure.code)` в `llm-retry/src/index.ts:288` тип-агностичны: добавление записи ничего не ломает и ничего не включает.

### 2.2 `CLIENT_GATE` — в реестр, без `retryChoice`

`CLIENT_GATE_REJECTED_CODE` (форк-строка 54, предикат 57–85) — тот же случай: провайдер-нейтральный код встроенного адаптера, классифицируется в `stream.ts:52`. Потребитель — рерутинг `model-routing` (тест `adapter.spec.ts:2111`: «falls back to the next source when the route rejects this client»), который маршрутизирует по строке `failure.code`, а не по membership в реестре. Без записи не скомпилируется `classifyPiAiError` (тип возврата в rc.2 — `BuiltinLlmFailureCode`).

`{}` без `retryChoice`: гейт следует за клиентом, а не за маршрутом — повторная попытка того же маршрута не проходит никогда, ожидать её политикой ретрая нельзя; лечение — рерутинг, который в форке уже есть.

### 2.3 Открытые коды форка — НЕ в реестр

`OPENROUTER_CATALOG_MALFORMED` и соседние (`openrouter-catalog.ts:46,49,52`; `openrouter-endpoints.ts:66,69,72,75`) и `MODEL_ROUTING_*` (`model-routing/src/adapter.ts:65–91`) в реестр не вносятся. Основания:

- JSDoc реестра объявляет скоуп — встроенные провайдеры и рантайм `llm`; эти коды бросает плагин форка, `llm` их не поднимает. Вносить чужой код в реестр ядра — та же инверсия зависимости, которую [model-routing.md](model-routing.md) снимает для `piAiDispatch`.
- Реестр — глобальная витрина чекбоксов ретрая для **всех** провайдеров: запись `MODEL_ROUTING_SUBSCRIPTION_LIMIT` появилась бы в форме ретрая каждого провайдера, где ничего этот код не поднимает. Код деплоймент-специфичен и перечисляется в конфиге деплоя — строковой веткой, что и происходит.
- У апстрима для сторонних кодов есть штатный путь — `LlmError.fromFailure` (шаг 1 миграции гайда); дешевле следовать ему, чем расширять поверхность ядра.

## 3. Полная таблица вызовов `new LlmError(` в плагинах форка

Номера строк — по HEAD форка (до мержа); после мержа в `llm-pi-ai/src/stream.ts` и `adapter.ts` апстримные дельты (`LEADING_HTTP_STATUS`, prefix-binding) сдвинут строки, но каждый site ищется по литералу кода. Проверка состава: `grep -rn "new LlmError(" packages/llm/llm-pi-ai/src packages/experimental/model-routing/src`.

Код встроенный, если входит в ключи `LLM_FAILURE_CODES` rc.2 либо имеет вид `HTTP_<число>`. 11 посторонних кодов: `OPENROUTER_CATALOG_MALFORMED`, `OPENROUTER_CATALOG_HTTP`, `OPENROUTER_CATALOG_UNREACHABLE`, `OPENROUTER_ENDPOINTS_MALFORMED`, `OPENROUTER_ENDPOINTS_HTTP`, `OPENROUTER_ENDPOINTS_UNREACHABLE`, `OPENROUTER_MODEL_ID_INVALID`, `MODEL_ROUTING_UNAVAILABLE`, `MODEL_ROUTING_NO_ENDPOINT`, `MODEL_ROUTING_SUBSCRIPTION_LIMIT`, `MODEL_ROUTING_UNKNOWN_MODEL`.

### packages/experimental/model-routing/src/adapter.ts

| Строка | Код | Вердикт |
|---|---|---|
| 416 | `UNKNOWN_MODEL` | компилируется как есть |
| 565 | `UNKNOWN_MODEL` | компилируется как есть |
| 573 | `NO_ADAPTER` | компилируется как есть |
| 690 | `INVALID_CONFIG` | компилируется как есть |
| 819 | `MODEL_ROUTING_SUBSCRIPTION_LIMIT` | **`fromFailure`** |
| 842 | `INVALID_CONFIG` | компилируется как есть |
| 850 | `MODEL_ROUTING_UNAVAILABLE` | **`fromFailure`** |
| 859 | `INVALID_CONFIG` | компилируется как есть |
| 877 | `MODEL_ROUTING_NO_ENDPOINT` | **`fromFailure`** |
| 882 | `MODEL_ROUTING_NO_ENDPOINT` | **`fromFailure`** |
| 1049 | `MODEL_ROUTING_UNKNOWN_MODEL` | **`fromFailure`** |
| 1127 | `MODEL_ROUTING_UNKNOWN_MODEL` | **`fromFailure`** |

### packages/llm/llm-pi-ai/src

| Файл:строка | Код | Вердикт |
|---|---|---|
| adapter.ts:288 | `UNSUPPORTED_REASONING_EFFORT` | компилируется как есть |
| adapter.ts:366 | `REQUEST_HEADERS` | компилируется как есть |
| adapter.ts:413 | `NO_ADAPTER` | компилируется как есть |
| adapter.ts:423 | `INVALID_CONFIG` | компилируется как есть |
| adapter.ts:426 | `UNKNOWN_MODEL` | компилируется как есть |
| adapter.ts:525 | `UNSUPPORTED_OPTION` | компилируется как есть |
| adapter.ts:576 | `KEY_QUOTA` | компилируется **при внесении записи в реестр** (раздел 2.1); без неё — не компилируется |
| adapter.ts:687 | `INVALID_CONFIG` | компилируется как есть |
| adapter.ts:695 | `UNSUPPORTED_CONTENT` | компилируется как есть |
| adapter.ts:699 | `UNSUPPORTED_CONTENT` | компилируется как есть |
| adapter.ts:752 | `TIMEOUT` | компилируется как есть |
| adapter.ts:755 | `ABORTED` | компилируется как есть |
| auth.ts:115 | `NO_CREDENTIAL_STORE` | компилируется как есть |
| auth.ts:165 | `UNSTORABLE_PROVIDER_ID` | компилируется как есть |
| context.ts:53 | `UNSUPPORTED_CONTENT` | компилируется как есть |
| context.ts:56 | `UNSUPPORTED_CONTENT` | компилируется как есть |
| context.ts:62 | `UNSUPPORTED_CONTENT` | компилируется как есть |
| context.ts:182 | `INVALID_REQUEST` | компилируется как есть |
| context.ts:190 | `UNSUPPORTED_CONTENT` | компилируется как есть |
| context.ts:259 | `UNSUPPORTED_CONTENT` | компилируется как есть |
| context.ts:377 | `IMAGE_OFFLOAD_REQUIRED` | компилируется как есть |
| discovery.ts:132 | `DISCOVERY_FAILED` | компилируется как есть |
| discovery.ts:191 | `DISCOVERY_FAILED` | компилируется как есть |
| discovery.ts:243 | `INVALID_CREDENTIAL` | компилируется как есть |
| discovery.ts:295 | `DISCOVERY_FAILED` | компилируется как есть |
| discovery.ts:309 | `DISCOVERY_UNSUPPORTED` | компилируется как есть |
| discovery.ts:345 | `ABORTED` | компилируется как есть |
| discovery.ts:347 | `DISCOVERY_FAILED` | компилируется как есть |
| discovery.ts:350 | `DISCOVERY_FAILED` | компилируется как есть |
| discovery.ts:363 | `ABORTED` | компилируется как есть |
| discovery.ts:371 | `DISCOVERY_FAILED` | компилируется как есть |
| index.ts:264 | `MISSING_CREDENTIAL` | компилируется как есть |
| openrouter-catalog.ts:122 | `OPENROUTER_CATALOG_MALFORMED` | **`fromFailure`** |
| openrouter-endpoints.ts:161 | `OPENROUTER_MODEL_ID_INVALID` | **`fromFailure`** |
| openrouter-endpoints.ts:312 | `OPENROUTER_ENDPOINTS_MALFORMED` | **`fromFailure`** |
| openrouter-http.ts:73 | `codes.malformed` (`OPENROUTER_*_MALFORMED`) | **`fromFailure`** |
| openrouter-http.ts:109 | `ABORTED` | компилируется как есть |
| openrouter-http.ts:112 | `TIMEOUT` | компилируется как есть |
| openrouter-http.ts:118 | `codes.unreachable` (`OPENROUTER_*_UNREACHABLE`) | **`fromFailure`** |
| openrouter-http.ts:157 | `codes.http` (`OPENROUTER_*_HTTP`) | **`fromFailure`** |
| openrouter-http.ts:169 | `ABORTED` | компилируется как есть |
| openrouter-http.ts:176 | `codes.malformed` | **`fromFailure`** |
| replay.ts:113 | `INVALID_REPLAY_STATE` | компилируется как есть |
| replay.ts:175 | `UNSUPPORTED_CONTENT` | компилируется как есть |
| stream.ts:225 | `MALFORMED_RESPONSE` | компилируется как есть |
| stream.ts:250 | `STREAM_CLOSED` | компилируется как есть |

Итог: **58 сайтов, правки требуют 13** (6 в model-routing + 7 в llm-pi-ai). Остальные 45 компилируются как есть при выполнении раздела 5.1; `HTTP_${number}` не использует ни один сайт. Другие форк-пакеты с `new LlmError(` (`llm-deepseek*`, `compaction-basic`, `agent-loop`, `test-support/llm-replay`) форком не правились и встроенных кодов не выходят за — их rc.2 мигрировал сам.

## 4. `retryableCodes` живого профиля — грузится, блокера нет

`~/.dsh/profiles/web/cordis.patch.yml:270–276` (`retryPolicy` плагина `model-routing`) перечисляет `MODEL_ROUTING_SUBSCRIPTION_LIMIT` шестым элементом рядом с пятью встроенными. Цепочка приемки в rc.2:

1. Схема: `retry-policy.ts:95` — union кончается `z.string().min(1)`; строка выше — комментарий апстрима «the string branch admits codes that other providers raise». Решающая строка: `retryableCodes: z.array(z.union([...RETRY_CODE_CHOICES.map(code => z.const(code)), z.string().min(1)]))`.
2. Собственный тест апстрима (`llm/tests/retry-policy.spec.ts`, «publishes the retry choices through the serialized schema and still admits other codes»): `restored({ mode: 'normal', retryableCodes: ['SERVER', 'Overloaded_529'] })` проходит, отбрасывается только пустая строка.
3. `resolveRetryPolicy` (стр. 176–184) не знает реестра: только непустые уникальные строки.
4. Ретрай: `llm-retry/src/index.ts:288` — `!policy.retryableCodes.includes(failure.code)`, сравнение строк.

Вывод: `MODEL_ROUTING_SUBSCRIPTION_LIMIT` вне реестра сохраняет работоспособность и загрузку конфига; в UI Models он будет показан вербатимом («plus any inherited or stored code outside them, shown verbatim»), без чекбокса. Блокеров нет.

## 5. Правки по файлам

### 5.1 `packages/llm/llm/src/error.ts` — конфликтный файл; описано против версии rc.2

Файл брать из rc.2 целиком (реестр, `BuiltinLlmFailureCode`, `RETRY_CODE_CHOICES`, все `satisfies`, реэкспорт `HarnessError` из `@deepseek-ai/dsh-error`) и вернуть в него форк-добавления тремя вставками. Ханки конфликтуют с апстримной переписью заголовка и реестра — построчный автомерж здесь не годится.

**Вставка 1 — после `ACCOUNT_QUOTA_EXCEEDED_CODE` (rc.2-строка 88), перед `EMPTY_RESPONSE_CODE` (rc.2-строка 90)** — константы в стиле апстрима, с `satisfies` (в текущей форк-версии его нет, потому что `BuiltinLlmFailureCode` в rc.1 ещё не существовал):

```ts
/**
 * Canonical provider-neutral code for a request rejected because one supplied
 * API key reached its own usage ceiling. Distinct from `QUOTA` because the
 * remedy differs: rotating to another key unblocks the request, while an
 * exhausted `QUOTA` (account balance, credits, billing plan) stays blocked for
 * every key on the account. Also distinct from `RATE_LIMIT`, which clears on
 * its own — a per-key ceiling does not, so retrying the same key is pointless.
 */
export const KEY_QUOTA_EXCEEDED_CODE = 'KEY_QUOTA' satisfies BuiltinLlmFailureCode

/**
 * Canonical provider-neutral code for a gateway that rejected the client's
 * identity rather than the request. Gateways reselling a first-party client
 * (for example Claude Code relays) fingerprint requests and answer a client
 * that does not look like their expected one with a 400 naming the client —
 * "client anomaly", "use the standard Claude Code client" — while the request
 * itself is servable by any other route. Distinct from `INVALID_REQUEST`
 * because the remedy differs: reroute to another route instead of failing
 * the turn, and distinct from every quota code because the rejection does not
 * clear with time, keys, or balance — it follows the client.
 */
export const CLIENT_GATE_REJECTED_CODE = 'CLIENT_GATE' satisfies BuiltinLlmFailureCode
```

**Вставка 2 — после `isContextWindowExceededError` (rc.2-строка 140–146)** — регулярки и предикаты из текущей форк-версии без изменений: `CLIENT_GATE_REJECTION` + `isClientGateRejectedError`, затем `ACCOUNT_LIMIT_REACHED`, `KEY_REACHED_ITS_LIMIT`, `KEY_LIMIT_REACHED`, `KEY_EXHAUSTED` + `isKeyQuotaExceededError` (текст — как в `git show HEAD:packages/llm/llm/src/error.ts`, строки 57–197).

**Вставка 3 — тело `isQuotaExceededError` заменить форк-версией** (lookbehind `(?<!key[\s_-]+)usage[\s_-]+limit` и альтернатива `|| ACCOUNT_LIMIT_REACHED.test(detail)`), включая её расширенный JSDoc про дизъюнктность с `isKeyQuotaExceededError`.

В реестр `LLM_FAILURE_CODES` добавить ровно две строки, по алфавиту между `CLIENT_UPGRADE_REQUIRED` (rc.2-строка 23) и `CONTEXT_WINDOW_EXCEEDED`:

```ts
  CLIENT_GATE: {},
```

и между `INVALID_RESPONSE` (rc.2-строка 46) и `MALFORMED_RESPONSE` (строка 47) — реестр держит алфавитный порядок:

```ts
  KEY_QUOTA: {},
```

Обе — без `retryChoice` (раздел 2). Остальные ключи и все апстримные записи не трогать.

### 5.2 `packages/llm/llm-pi-ai/src/openrouter-http.ts` — 4 сайта

Коды листингов живут в объекте `codes: OpenRouterReadCodes` — они остаются строками, меняется только конструктор. Механическая замена на каждом сайте (73, 118, 157, 176):

```ts
// было
new LlmError(<message>, codes.malformed)
// стало
LlmError.fromFailure({ message: <message>, code: codes.malformed })
```

то же для `codes.unreachable` и `codes.http`; второй аргумент с `{ cause: error }` у сайтов 118 и 176 остаётся вторым параметром `fromFailure`. Сайты 109, 112, 169 (`ABORTED`, `TIMEOUT`) — без правок. JSDoc заголовков (`@throws LlmError with a stable code…`) не меняется.

### 5.3 `packages/llm/llm-pi-ai/src/openrouter-catalog.ts` — 1 сайт

Строка 122, замыкание `malformed`:

```ts
const malformed = (detail: string): LlmError =>
  LlmError.fromFailure({ message: `llm-pi-ai: ${detail} in the OpenRouter model catalog`, code: MALFORMED_CATALOG_CODE })
```

### 5.4 `packages/llm/llm-pi-ai/src/openrouter-endpoints.ts` — 2 сайта

- Строка 161 (`splitModelId`):

  ```ts
  throw LlmError.fromFailure({
    message: 'llm-pi-ai: OpenRouter publishes endpoints per an author/slug model id, but this one is'
      + ` ${JSON.stringify(model)}`,
    code: INVALID_MODEL_ID_CODE,
  })
  ```

- Строка 312 (замыкание `malformed` в `parseOpenRouterEndpoints`):

  ```ts
  const malformed = (detail: string): LlmError =>
    LlmError.fromFailure({ message: `llm-pi-ai: ${detail} in the endpoint listing for "${model}"`, code: MALFORMED_ENDPOINTS_CODE })
  ```

### 5.5 `packages/experimental/model-routing/src/adapter.ts` — 6 сайтов

Пять прямых замен (850, 877, 882, 1049, 1127) — по образцу:

```ts
// было (850)
throw new LlmError(
  `model-routing: no endpoint list could be read for tier "${tier.name}": ${reasons}`,
  MODEL_ROUTING_UNAVAILABLE_CODE,
)
// стало
throw LlmError.fromFailure({
  message: `model-routing: no endpoint list could be read for tier "${tier.name}": ${reasons}`,
  code: MODEL_ROUTING_UNAVAILABLE_CODE,
})
```

то же с `MODEL_ROUTING_NO_ENDPOINT_CODE` (877, 882 — у каждого своё сообщение) и `MODEL_ROUTING_UNKNOWN_MODEL_CODE` (1049, 1127).

Сайт 819 — единственный с провайдер-фактом, `providerRetryAfterMs` уходит в failure-объект:

```ts
const retryAfterMs = this.earliestRetryMs(key, extraSources)
throw LlmError.fromFailure({
  message: `model-routing: tier "${tier.name}" is served only by exhausted subscriptions and this Session does`
    + ` not fall back to OpenRouter; try again in ${String(retryAfterMs)}ms`,
  code: MODEL_ROUTING_SUBSCRIPTION_LIMIT_CODE,
  ...retryAfterMs > 0 ? { providerRetryAfterMs: retryAfterMs } : {},
})
```

`fromFailure` разворачивает failure в options конструктора, так что `providerRetryAfterMs` и рантайм-валидация сохраняются. Комментарий «/* v8 ignore next -- every call site already validated… */» и вся JSDoc-обвязка кодов (строки 63–93) не меняются.

### 5.6 Тесты — только там, где конструктор получает посторонний код

- `packages/llm/llm-pi-ai/tests/adapter.spec.ts:1139`: `expect(new LlmError('x', 'X')).toBeInstanceOf(Error)` → `expect(LlmError.fromFailure({ message: 'x', code: 'X' })).toBeInstanceOf(Error)` — ровно то, что апстрим сделал в своей копии (rc.2, стр. 1081). Остальные конструкторы файла (`MISSING_CREDENTIAL`, `INVALID_CREDENTIAL`) — встроенные.
- `packages/llm/llm/tests/service.spec.ts` — файл конфликтует: апстрим в rc.2 уже перевёл свои три конструктора на `fromFailure` (rc.2-строки 435, 474, 1593 — `RESULT_GETTER_FAILED`, `BOUNDARY_FAILED`, `CUSTOM_CODE`), те же три строки есть в форк-добавлениях (текущие 493, 532, 1651). При сведении взять апстримские версии этих строк; блок рантайм-отказов конструктора (`new LlmError('busy', 1 as never)`, форк-строка 1664; rc.2-строка 1606) совпадает и правок не требует. Форк-тесты предикатов (стр. 149–205) не требуют правок: они вызывают `isKeyQuotaExceededError`/`isClientGateRejectedError`, а не конструктор.
- `packages/experimental/model-routing/tests/adapter.spec.ts` — все четыре конструктора компилируются после раздела 5.1: `TIMEOUT` (702, 724, 2219) встроенный, `KEY_QUOTA` (2364) — новая запись реестра. Правок нет; это же — регрессионное доказательство записи `KEY_QUOTA`.
- `packages/llm/llm-fallback/tests/fallback.spec.ts` — все конструкторы (`SERVER`, `AUTH`) встроенные, правок нет; прогон — регрессия.
- Апстрим-тесты `llm/tests/retry-policy.spec.ts` (тест с 119-й строки) не правятся: с прежним набором choices (`KEY_QUOTA`/`CLIENT_GATE` без `retryChoice`) утверждения `expect(choices).toEqual([...RETRY_CODE_CHOICES])` остаются верными.

## 6. Проверка (команды для исполнителя мержа)

```sh
# 1. Типы: единственный механический арбитр «каждый конструктор получает встроенный код».
pnpm run typecheck

# 2. Реестр, choices, допуск посторонних строк в схеме (в т.ч. утверждение про STREAM_CLOSED).
pnpm run test packages/llm/llm/tests/retry-policy.spec.ts packages/llm/llm/tests/service.spec.ts

# 3. Классификатор и потребители: KEY_QUOTA/CLIENT_GATE в stream.ts, KEY_QUOTA-исчерпание пула в adapter.ts,
#    коды листингов OpenRouter после перевода на fromFailure.
pnpm run test packages/llm/llm-pi-ai/tests/convert.spec.ts packages/llm/llm-pi-ai/tests/adapter.spec.ts \
  packages/llm/llm-pi-ai/tests/openrouter-catalog.spec.ts packages/llm/llm-pi-ai/tests/openrouter-endpoints.spec.ts

# 4. Рерутинг по CLIENT_GATE, bench по KEY_QUOTA, MODEL_ROUTING_SUBSCRIPTION_LIMIT + retryableCodes деплоя.
pnpm run test packages/experimental/model-routing/tests/adapter.spec.ts

# 5. Регрессия фолбэка (конструкторы только со встроенными кодами).
pnpm run test packages/llm/llm-fallback/tests/fallback.spec.ts
```

Полнота п. 2–5 механически: `grep -rn "new LlmError(" packages/llm/llm-pi-ai/src packages/experimental/model-routing/src` — после правок 45 совпадений, и у каждого второй аргумент — ключ `LLM_FAILURE_CODES` либо `HTTP_…`; плюс `pnpm run typecheck`. Полную сборку и `hygiene` исполняет ранбук после `pnpm install`; здесь они не прогонялись.

## 7. Что не проверено в этом дереве

- **Типы и тесты не запускались** (правило окна: без `pnpm install`/build до мержа). Все вердикты раздела 3 — статический разбор против источников rc.2; арбитр — `pnpm run typecheck` из раздела 6.
- **Результат слияния `packages/llm/llm/src/error.ts` не смоделирован**: обе стороны переписали одни и те же зоны (шапка с `HarnessError`, реестр, область `isQuotaExceededError`), `git merge-tree` не прогонялся; раздел 5.1 описывает целевой файл, но hunk-выравнивание останется на исполнителе.
- **Послемержные номера строк** `llm-pi-ai/src/stream.ts` и `adapter.ts` неизвестны: апстримные дельты (`LEADING_HTTP_STATUS`, prefix-binding, сдвиги от вставок) изменят нумерацию; таблица 3 привязана к HEAD форка и ищется по литералам кода.
- **Рантайм-приемка схемой `HTTP_503`-строк** (`z.const` против литерала `HTTP_${number}`) не воспроизводилась локально — покрыто апстримным тестом rc.2, не нашим.
- **Гейт `verify-plugin-entry-exports`** на entry плагинов форка (18 экспортов model-routing и пр.) — отдельный пункт окна, здесь не замерялся.
- **Загрузка живого профиля** проверена по исходникам rc.2 (раздел 4), не прогоном лоадера на `~/.dsh/profiles/web/cordis.patch.yml`.
