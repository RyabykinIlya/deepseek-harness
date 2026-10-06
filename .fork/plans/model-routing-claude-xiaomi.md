# Доработки Model Routing: Claude-proxy, ротация ключей, Xiaomi Token Plan

## Правки по итогам валидации (2026-10-06)

Проверено по коду, не по описанию. Ниже — что подтвердилось, что нет, и как меняется
конструкция. Разделы плана, вышедшие за границы, помечены по месту ссылкой сюда.

### Границы работы

| Часть | Статус | Куда ушло |
|---|---|---|
| Часть 1, маршрут `claude-proxy` (включая A.1.a и A.1.b) | **Отложено** | [../model-routing-claude-proxy/DECISIONS.md](../model-routing-claude-proxy/DECISIONS.md) |
| Часть 2, таксономия ошибок | В работе | [../model-routing-claude-proxy/TASKS.md](../model-routing-claude-proxy/TASKS.md) |
| Часть 2, ротация ключей | **Не отгружается** | см. ниже, «О потребителе ротации» |
| Часть 3, сравнение цены подписки Xiaomi | **Отложено** | [../model-routing-claude-proxy/STATUS.md](../model-routing-claude-proxy/STATUS.md) |
| Часть 4, пункт 5 (`KEY_QUOTA` в `rerouteCodes`) | В работе | — |
| Часть 4, пункты 1–4 и 6 (обобщение «эндпоинт → источник») | **Отложено** вместе с частью 3 | — |

### Что подтвердилось

Дефект классификации реален. `isQuotaExceededError`
(`packages/llm/llm/src/error.ts:97`) требует «usage limit» **перед**
«exceeded/exhausted/reached», а строка прокси — «This API key **reached its usage
limit**». Предикат возвращает false, сообщение уходит в ветку `/\b429\b|rate.?limit/`
в `classifyPiAiError` (`packages/llm/llm-pi-ai/src/stream.ts:45`) и получает
`RATE_LIMIT`. `RATE_LIMIT` стоит и в `retryableCodes`
(`packages/llm/llm/src/retry-policy.ts:18`), и в `rerouteCodes`
(`packages/experimental/model-routing/src/config.ts:321`) — исчерпанный дохлый ключ
ретраится впустую. Диагноз плана в разделе «Текущее поведение (неправильное для этой
ошибки)» верен.

### Что в плане неверно

**Место ротации указано неправильно.** План (часть 2, пункт 3) говорит «в резолве
ключа (`resolveApiKey` → `profileOptions`)». Оба места не подходят, и по одной причине:

- `resolveApiKey` (`packages/llm/llm-pi-ai/src/index.ts:219`) вызывается **один раз**
  на запрос, в `streamWithSnapshot` **до** отправки
  (`packages/llm/llm-pi-ai/src/adapter.ts:385`). Он не может узнать об отказе — отказа
  ещё нет.
- `profileOptions` (`adapter.ts:429`) — это чистая функция сборки аргументов для
  `streamSimple`, вызывается ровно один раз на уже разрешённом ключе.

Ротация — это цикл «отправить → увидеть `KEY_QUOTA` → взять следующий ключ → отправить
снова». Такого цикла в адаптере нет: `streamWithSnapshot` — асинхронный генератор,
который делает одну отправку и один проход по чанкам (`adapter.ts:428–460`).

### Ограничение, которое делает ротацию неверифицируемой

Ключевое: ошибка приходит **внутри** потока. `toStreamChunks` кладёт код отказа в
`failure.code` finish-чанка (`stream.ts:125`), а `streamWithSnapshot` отдаёт чанки
потребителю по одному (`adapter.ts:449`). Отсюда два следствия:

1. **Ротация в адаптере видна наружу.** Потоковый протокол не различает «одна отправка
   внутри адаптера» и «одна попытка агента». Повторная отправка внутри
   `streamWithSnapshot` — это второй вызов провайдера, который потребитель увидит как
   часть одного вызова, а `llm-retry` (`packages/llm/llm-retry/src/index.ts:194`,
   обработчик `agent/request-error`) работает со стороны агента и в этот цикл не
   заглядывает. Требование плана «ротация не должна выглядеть как отдельный видимый
   attempt» из места, куда план её кладёт, **невыполнимо**.
2. **Отказ приходит до контента только для этой ошибки.** Для `KEY_QUOTA` провайдер
   отказывает в начале (`429`), контент не начинал идти — ротация безопасна. Но
   гарантировать это общей конструкцией нельзя: если код отказа придёт после
   `block-start`/`text-delta`, часть ответа уже у потребителя, и повтор её задвоит.

Общее правило: ротация допустима **только пока не отдан ни один контентный чанк**.
Это и есть настоящее ограничение конструкции, и в плане его нет.

### О потребителе ротации

Прокси отложен, поэтому сегодня **ни один** настроенный маршрут не объявляет больше
одного ключа. Правило репозитория (`packages/CLAUDE.md`) требует у абстракции текущего
владельца и потребности. Плюс конструкция выше не проверяема на нынешних данных.

**Решение: ротация не отгружается.** Отгружаются:

- таксономия (`KEY_QUOTA` и предикат) — чинит реальный дефект независимо от ротации;
- поле `apiKeys` в схеме — аддитивно, одиночный `apiKeyEnv` продолжает работать;
- `KEY_QUOTA` в `rerouteCodes` — одна строка.

Ротация остаётся разобранной здесь и в
[../model-routing-claude-proxy/TASKS.md](../model-routing-claude-proxy/TASKS.md) и
возвращается в работу вместе с настоящим маршрутом, объявляющим несколько ключей — тогда
у неё появится и потребитель, и способ проверить её живьём.

Если ротацию всё же понадобится сделать раньше, верная конструкция такая: цикл живёт
между «получен код отказа» и «первый контентный чанк ушёл», то есть внутри
`streamWithSnapshot`, а состояние кулдауна — на уровне `apply` (`index.ts:185`), рядом с
`auth`, переживая перестройку снимка в `profiles()` (`index.ts:199`) и снимаясь вместе с
fiber через `ctx.effect`.

### Проверка премисы (выполнено запуском, 2026-10-06)

Премиса подтвердилась. Предикаты вызваны на реальных строках, а не прочитаны:

- `isKeyQuotaExceededError` на строке прокси → `true`; `isQuotaExceededError` на ней же → `false`;
- `mapStopReason` на том же сообщении даёт `{"code":"KEY_QUOTA"}` (`packages/llm/llm-pi-ai/src/stream.ts:46`);
- на старом дереве (до правки) тот же вход давал `RATE_LIMIT`;
- `RATE_LIMIT` присутствует и в `DEFAULT_RETRYABLE_CODES` (`packages/llm/llm/src/retry-policy.ts:18`), и в дефолте `rerouteCodes` (`packages/experimental/model-routing/src/config.ts:321`).

Дефект классификации реален, и отгруженная правка его закрывает. Тесты классификации идут: 178 passed (`packages/llm/llm/tests/service.spec.ts`, `packages/llm/llm-pi-ai/tests/convert.spec.ts`).

### Что в разделе выше («Что в плане неверно») поправлено

Раздел верен по существу и неточен в двух местах.

**Адрес `resolveApiKey` назван неточно.** Функция объявлена в `packages/llm/llm-pi-ai/src/index.ts:219`, а `:223` — это строка чтения `profile.apiKeyEnv` внутри неё. Обе ссылки указывают на одно место, но `:219` — объявление.

**Причина невыполнимости «невидимой попытки» названа не полностью.** Кроме того, что повтор увидят снаружи, адаптер отдельно и намеренно запрещает SDK-ретраи: `maxRetries: 0` с комментарием «The agent recovery layer owns visible attempts; one adapter call is one SDK attempt» (`adapter.ts:149–157`). То есть запрет на невидимый повтор — не следствие конструкции, а записанное решение. Ротация обязана его не нарушать.

### Что ротация на самом деле требует (ответ на вопрос 1–3)

**Вопрос 1, где живёт цикл.** Не в `resolveApiKey` и не в `profileOptions`, а в `streamWithSnapshot` (`adapter.ts:366`): единственная отправка сегодня — строка `:428` (`snapshot.models.streamSimple`), а `resolveApiKey` вызывается один раз на строке `:385`, до неё. Верная конструкция — цикл по ключам, объемлющий **и** разрешение ключа, **и** отправку (`:385`–`:449`). `resolveApiKey` меняет подпись на приём индекса ключа, `profileOptions` получает ключ как и сейчас — единственное изменение там в том, что `requestHeaders(profile.headers)` (`:436`) должно пересобираться на каждую попытку, потому что ключ приезжает в `apiKey`, а не в заголовках.

**Вопрос 2, виден ли код до утечки контента.** Сегодня — нет: код лежит в `failure.code` finish-чанка (`stream.ts:128`), а генератор уже отдал `usage` и все контентные чанки потребителю по одному (`adapter.ts:449`). Но это лечится тривиально и уже сделано в соседнем пакете: `model-routing` берёт чанки через `iterator.next()` в буфер, крутится, пока приходит `usage`, и только потом решает (`packages/experimental/model-routing/src/adapter.ts:988–996` с комментарием на `:982–986`). Ротации нужен тот же буфер, но с другим условием выхода: копить, пока не пришёл первый **контентный** чанк, а не первый не-`usage`.

**Вопрос 3, достижима ли «невидимая попытка».** Достижима, но не там, где её ставит план, и не бесплатно. Условие ровно одно: **ни один контентный чанк не отдан наружу**, пока не принято решение о ротации. Значит цикл обязан буферизовать `block-start` / `text-delta` / `reasoning-delta` / `tool-call-delta` / `block-end` до первого из них, и на `KEY_QUOTA` с непустым буфером — не ротировать, а отдавать отказ как есть. Формулировка плана «ротация допустима, пока не отдан ни один контентный чанк» верна, но её недостаточно: нужен ещё механизм, который этот момент **удерживает**. Без буфера «невидимость» — лозунг.

### Вопрос 4, где живёт состояние

Владелец — замыкание `apply` (`packages/llm/llm-pi-ai/src/index.ts:185`), рядом с `auth` (`:247`), а не снимок и не модульная переменная. Три требования и как они выполняются:

- **Переживает перестройку снимка в `profiles()`** (`index.ts:195`): замыкание `apply` живёт дольше любого снимка, снимок пересобирается при смене `config.providers`, состояние — нет.
- **Не течёт через перерегистрацию маршрута**: `profiles()` вызывается многократно (`:207`, `:284`, `:304`, `:336`), но состояние читается только из замыкания, а маршрут — это ключ внутри него, поэтому перерегистрация маршрута не воскрешает старый курсор.
- **Снимается вместе с fiber**: замыкание умирает с `apply`. Отдельный `ctx.effect` на снятие здесь не нужен и не должен появляться: в состояние не регистрируется ни один контрибьютор, а правило `packages/CLAUDE.md` «Registry contributions prove disposal» требует HMR-теста от регистраций, не от обычных полей замыкания. Если появится таймер кулдауна — он идёт через `ctx.setTimeout` (или `ctx.effect` с `clearTimeout`), иначе таймер переживёт fiber.

Структура: `Map<provider, { order: CredentialRef[]; exhaustedAt: Map<CredentialRef, number>; cooldownMs: number }>`.

### Вопрос 5, обоснование при отсутствии потребителя

Позиция: **отложить**. Проверено — в живом профиле (`~/.dsh/profiles/web/cordis.patch.yml:18`) объявлен один маршрут с одним рефом на маршрут (`apiKeyEnv: OPENROUTER_API_KEY`). `packages/CLAUDE.md` требует «current owner and need» у абстракции, состояния и опции. Ротация сегодня — код без вызывающего.

Аргумент против отгрузки не только дисциплинарный. Конструкция выше непроверяема на нынешних данных: чтобы увидеть `KEY_QUOTA` от первого ключа и успех от второго, тесту нужен мок-провайдер, отвечающий по ключу, то есть фикстура, изображающая маршрут с двумя ключами, которого в развёртывании нет. Тест будет проверять мок, а не потребность.

Что меняется при появлении потребителя: маршрут объявляет `apiKeys`, и ротация становится проверяемой живьём. Только тогда — см. «Верная конструкция» ниже.

### Две отложенные развилки: проверить, не переоткрывая

**`KEY_QUOTA` не в `rerouteCodes`.** Согласен, но обоснование в TASKS.md («прямого маршрута нет») сформулировано неточно. Гейт — `pin.endpoint !== undefined` на `adapter.ts:1000` и `:1012`, и `endpoint` заполняется только для OpenRouter-эндпоинта (`:633`, `:676`). У прямого pi-ai маршрута его нет — верно. Но из этого следует не «рероут не сработает», а «рероут сработает не туда»: при `maxReroutes: 2` (`config.ts:319`) исчерпание всех ключей прямого маршрута после добавления кода уводило бы запрос на **другую модель**, а не на другой ключ. Для per-key лимита это неверное восстановление: ключ исчерпан, а модель менять незачем. Дефолт менять не следует — и не из-за отсутствия эффекта, а из-за неверного эффекта, который появится вместе с потребителем. Возвращается вместе с ротацией и с явным решением, что делать после исчерпания списка.

**Откат `apiKeys`.** Согласен целиком. Довод в TASKS.md проверен по коду: `resolveApiKey` читает ровно `profile.apiKeyEnv` (`index.ts:223`), и профиль только с `apiKeys` оставил бы её `undefined`, что на `index.ts:227` означает возврат `undefined` — то есть откат на нативное обнаружение pi-ai и запрос чужим ключом. Это ровно тот сценарий, ради которого в `resolveApiKey` стоит отдельный комментарий. Схема без читателя, молча меняющая аутентификацию, хуже её отсутствия. Держать откат.

### Верная конструкция ротации, когда потребитель появится

Пошагово, с адресами:

1. **Цикл** — в `streamWithSnapshot` (`adapter.ts:366`), вокруг разрешения ключа и отправки. Порядок ключей — из конфигурации маршрута, не из порядка в `Map`.
2. **Разрешение ключа** — `resolveApiKey(provider, profile, keyRef)` вместо текущей сигнатуры `:219`; ошибка `MISSING_CREDENTIAL` на одном из ключей не должна валить весь маршрут, но обязана быть видна в логе.
3. **Отправка** — `adapter.ts:428`, `profileOptions` получает ключ попытки; заголовки пересобираются на попытку (`:436`).
4. **Буфер** — копить чанки до первого контентного (`block-start` или любой `*-delta`). Весь буфер — это `usage` и, возможно, ничего больше.
5. **Решение** — `failure.code === 'KEY_QUOTA'` при пустом контентном буфере: пометить ключ исчерпанным до `now() + cooldownMs`, взять следующий живой, повторить с шага 2. Буфер отбрасывается вместе с попыткой.
6. **Исчерпание** — все ключи мертвы: отдать `KEY_QUOTA` наружу, с текстом, называющим маршрут и число испробованных ключей. Не подменять на `QUOTA`.
7. **Контентные чанки** — как только отдан первый, ротация прекращается навсегда для этой операции; последующий `KEY_QUOTA` уходит наружу без буферизации.
8. **`maxRetries: 0`** (`adapter.ts:156`) остаётся. Ротация — это не ретрай попытки, а выбор ключа для попытки; видимая попытка по-прежнему одна.
9. **Конфигурация** — `keyCooldownMs` в профиле со схемой (`config.ts`), без `DEFAULT_*`-константы по AGENTS.md; misconfiguration — fail loud при загрузке.
10. **Тесты** — юнит на порядок и кулдаун (без сети), и REAL-composition тест через Loader с мок-провайдером, отвечающим по ключу.

### Что осталось нерешённым и почему не угадано

- **Форма списка ключей** (`apiKeys: CredentialRef[]` против одного рефа на пул): от этого зависит и `resolveApiKey`, и схема. Оба варианта работают; выбор за развёртыванием, а не за кодом. Не угадываю.
- **Значение `keyCooldownMs` по умолчанию**: неизвестно, когда платформа прокси возвращает лимит ключу. Оставляю без дефолта — поле обязательное при включённой ротации.
- **Поведение `MISSING_CREDENTIAL` на одном ключе из списка**: не решено, валить ли маршрут целиком или пропускать ключ. Требует решения владельца; в плане не зафиксировано.

---

Задача для реализации в репозитории `deepseek-harness`. Две цели:

1. **Claude-proxy** — модели `claude-sonnet-5`, `claude-opus-4-8` и др. через `https://claude.blogmin.ru/api/llm` попадают в маршрут `tiers` (Model Routing) с **ротацией нескольких API-ключей**: при ошибке «у этого ключа исчерпан лимит» пробуем следующий ключ. → **Отложено**, см. «Правки по итогам валидации (2026-10-06)».
2. **Xiaomi Token Plan** — маршрут через `https://token-plan-sgp.xiaomimimo.com` с **приоритетом над OpenRouter, когда подписка выгоднее**: сравниваем эффективную цену подписки с per-token ценами OpenRouter и выбираем дешёвый источник. Ротация ключей — та же механика. → **Сравнение цены отложено**, см. там же.

---

## Часть 0. Разведка (проверено экспериментально, 2026-10-05)

### 0.1 Claude-proxy `claude.blogmin.ru`

| Факт | Значение |
|---|---|
| Anthropic-совместимый endpoint | `POST https://claude.blogmin.ru/api/llm/v1/messages` |
| OpenAI-совместимый endpoint | `POST https://claude.blogmin.ru/api/llm/chat/completions` |
| Список моделей | `GET https://claude.blogmin.ru/api/llm/v1/models` (без клиентской проверки) |
| Модели | `claude-opus-4-8`, `claude-opus-4-7`, `claude-sonnet-5`, `claude-sonnet-4-6`, `claude-haiku-4-5` |
| Порядок проверок | ключ (401) → клиент (400) → upstream/модель (200/503) |

**Гейт «только официальный клиент»** — проверка одного заголовка: `user-agent` должен соответствовать `^claude-cli/\d+\.\d+\.\d+` (регистрозависимо; `claude-cli/1.2.3.4` проходит, `claude-cli/1.2`, `claude-cli`, `claude-code/*`, `CLAUDE-CLI/*` — нет). Больше ничего не требуется: `x-app`, `anthropic-beta`, `x-stainless-*`, `x-claude-code-session-id` не проверяются. Ответ при несоответствии — 400 с текстом «Сейчас поддерживается только официальный клиент Claude Code…».

**Ловушки:**

- Неизвестная модель маскируется под `503 overloaded_error` («Сервис временно недоступен»), а не 404. `claude-haiku-4-5` в одном тесте не ответил за 60 с — возможна нестабильность.
- Ошибка исчерпания ключа: `429` с текстом `API Error: Request rejected (429) · 🛑 This API key reached its usage limit. Raise the limit on this key or use a different one.` — это **per-key** лимит (ключей несколько, при исчерпании нужна ротация), не путать с rate limit.

### 0.2 Xiaomi Token Plan `token-plan-sgp.xiaomimimo.com`

| Факт | Значение |
|---|---|
| OpenAI-совместимый base URL | `https://token-plan-sgp.xiaomimimo.com/v1` |
| Anthropic-совместимый base URL | `https://token-plan-sgp.xiaomimimo.com/anthropic` (соответствует `/anthropic/v1/messages`; `GET .../anthropic/v1/models` — 404, каталог моделей только на `/v1/models`) |
| Модели | `mimo-v2.6-pro`, `mimo-v2.6-flash`, `mimo-v2.5-pro`, `mimo-v2.5`, `mimo-v2.5-asr`, `mimo-v2.5-tts`, `mimo-v2.5-tts-voiceclone`, `mimo-v2.5-tts-voicedesign` (TTS/ASR в Model Routing не нужны) |
| План | 11 млрд кредитов, $16; скидка 20% в не-пик: 9:00–17:00 PDT |
| Auth | `Authorization: Bearer <token>` (OpenAI-путь) или `x-api-key` (Anthropic-путь) |
| Поведение исчерпания | `429 {"code":"429","message":"quota exhausted","type":"limitation"}` — per-account; клиентской UA-проверки нет |
| Тестовый токен | работает: `GET /v1/models` → 200; генерация → 429 «quota exhausted» (на токене нет денег — ожидаемо) |

**Экономика подписки** (из сессии `session-b20d1488-0e6f-4dc6-a9c6-f6f29df2d709`):
эффективная ставка = $16 / 11e9 кредитов ≈ **$1.45e-6 за кредит**.
Замер за сутки на OpenRouter для `xiaomi/mimo-v2.6-pro`: 113.18M токенов (89% cache-read) обошлись в $5.96; на подписке те же токены — ~$0.16 (≈36× дешевле). Разбивка фактурации OpenRouter для этой модели: uncached input ≈ $0.43/1M, output ≈ $0.87/1M, cache-read ≈ $0.0036/1M.
**Важно:** план считает *кредиты*, а не токены; правило конверсии кредитов (вес input/output/cache по моделям) нужно уточнить у платформы — см. «Открытые вопросы».

---

## Часть 1. Доработка A — провайдерский маршрут `claude-proxy` в `llm-pi-ai`

Конфигурация профиля (добавить в `cordis.patch.yml`, секция `llm-pi-ai.providers`):

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      claude-proxy:
        api: anthropic-messages
        baseURL: https://claude.blogmin.ru/api/llm
        apiKeyEnv: CLAUDE_PROXY_API_KEY        # см. доработку B — станет списком ключей
        defaultContextWindow: 200000
        defaultMaxTokens: 32768
        models:
          - { id: claude-sonnet-5,   name: "Claude Sonnet 5",   contextWindow: 200000, maxTokens: 32768, input: [text, image] }
          - { id: claude-opus-4-8,   name: "Claude Opus 4.8",   contextWindow: 200000, maxTokens: 32768, input: [text, image] }
          - { id: claude-opus-4-7,   name: "Claude Opus 4.7",   contextWindow: 200000, maxTokens: 32768, input: [text, image] }
          - { id: claude-sonnet-4-6, name: "Claude Sonnet 4.6", contextWindow: 200000, maxTokens: 32768, input: [text, image] }
          - { id: claude-haiku-4-5,  name: "Claude Haiku 4.5",  contextWindow: 200000, maxTokens: 32768, input: [text, image] }
```

Разрешение URL у pi-ai: запросы идут на `{baseURL}/v1/messages`, каталог — на `{root}/v1/models` (см. `listingUrl` в `packages/llm/llm-pi-ai/src/discovery.ts:114`), поэтому `baseURL` без хвостового `/v1` — корректное значение; проверить стык на моке.

### A.1 Проблема `user-agent` (обязательный пункт)

Атрибуция harness'а **выигрывает** у заголовков профиля: `requestHeaders()` в `packages/llm/llm-pi-ai/src/adapter.ts:224` вырезает `user-agent` из профиля и подставляет `deepseek-harness/<ver> (+url)` (`packages/llm/llm/src/attribution.ts`). Proxy такой запрос отклоняет (400). Варианты:

- **A.1.a Локальный relay (рекомендуется, без правки кода).** Маленький процесс на loopback, который переписывает `user-agent` на `claude-cli/2.1.289` и проксирует на `claude.blogmin.ru`. `baseURL` профиля указывает на relay. Минус: внешний процесс, нужно поддерживать живым.
- **A.1.b Per-profile override в коде.** Добавить в `PiAiProviderProfile` узкое поле (например `userAgentOverride`), разрешённое только для явно объявленных маршрутов, с тестом на отказ для остальных. Ломает инвариант «атрибуцию нельзя подавить» (`attribution.ts:38`) — требуется явное исключение, JSDoc-контракт и, возможно, upgrade guide. Спуфить `claude-cli` — сознательное узкое исключение для этого класса прокси, документировать честно.
- Не рассматривать: глобальное подавление атрибуции, правка `APP_IDENTITY` по умолчанию.

## Часть 2. Доработка B — пул ключей и ротация при исчерпании лимита

Симптом: `429 · 🛑 This API key reached its usage limit. Raise the limit on this key or use a different one.` Несколько ключей (у Claude-proxy; у Xiaomi — аналогично), при исчерпании одного — следующий.

**Текущее поведение (неправильное для этой ошибки):**

- Классификация ошибок pi-ai: `classifyPiAiError` в `packages/llm/llm-pi-ai/src/stream.ts:41`. Регэксп `isQuotaExceededError` (`packages/llm/llm/src/error.ts:97`) **не ловит** фразу «reached its usage limit» (паттерн требует «usage limit exceeded/exhausted/reached» в этом порядке), из-за чего ошибка попадает в `RATE_LIMIT` (по «429»).
- `RATE_LIMIT` входит и в `retryableCodes` по умолчанию (`packages/llm/llm/src/retry-policy.ts`), и в `rerouteCodes` Model Routing (`packages/experimental/model-routing/src/config.ts:320`) — то есть один и тот же исчерпанный ключ ретраится впустую. У Xiaomi-ошибки «quota exhausted» классификация уже корректна (`QUOTA`), но ротации нет нигде: `apiKeyEnv` — один реф (`packages/llm/llm-pi-ai/src/config.ts:94`), разрешается в `resolveApiKey` (`packages/llm/llm-pi-ai/src/index.ts:219`).

**Что сделать:**

1. **Таксономия ошибок.** Расширить `isQuotaExceededError` (или завести отдельный предикат) паттернами `reached its usage limit`, `This API key reached its usage limit`. Ввести код `KEY_QUOTA` (per-key лимит, ротируемый) рядом с существующим `QUOTA` (per-account, не ротируемый — на нём падать с понятной ошибкой). Классифицировать **до** ветки `429 → RATE_LIMIT` в `classifyPiAiError` (порядок проверок уже правильный, нужен паттерн).
2. **Список ключей в профиле.** `apiKeyEnv: string` → поддержать `apiKeys: string[]` (список credential-ref; обратная совместимость: одиночный `apiKeyEnv` продолжает работать). Схема — `packages/llm/llm-pi-ai/src/config.ts` (`profile`).
3. **Ротация в пределах одного вызова.** В резолве ключа (`resolveApiKey` → `profileOptions`, `packages/llm/llm-pi-ai/src/adapter.ts:385`): состояние маршрута — курсор + карта «исчерпанных» ключей с TTL/коулдауном (конфиг `keyCooldownMs`, без хардкода по AGENTS.md). На `KEY_QUOTA` пометить ключ, повторить запрос следующим живым ключом; все исчерпаны — пробросить `KEY_QUOTA` наружу (пусть Model Routing уводит на другой источник, см. Часть 4). Ротация **не** должна выглядеть как отдельный видимый attempt (агент-ретраи владеют видимыми попытками).
4. **Хранение состояния.** Минимум — состояние в памяти процесса с TTL. TTL и число ключей — конфигурируемые поля, не константы.
5. **Тесты:** юнит на классификацию ошибки (текст прокси и текст Xiaomi), юнит на ротацию (первый ключ → KEY_QUOTA → второй успешно; все исчерпаны → KEY_QUOTA наружу; кулдаун возвращает ключ в пул), REAL-composition тест с мок-сервером (в `packages/test-support/llm-mock-server` уже есть инфраструктура).

## Часть 3. Доработка C — маршрут `xiaomi-plan` и сравнение стоимости

### C.1 Маршрут

Профиль `llm-pi-ai`:

```yaml
      xiaomi-plan:
        api: openai-completions          # или anthropic-messages на /anthropic — выбрать один и зафиксировать
        baseURL: https://token-plan-sgp.xiaomimimo.com/v1
        apiKeyEnv: XIAOMI_PLAN_API_KEY   # станет списком, см. доработку B
        models:
          - { id: mimo-v2.6-pro,   name: "MiMo v2.6 Pro",   contextWindow: 262144, maxTokens: 32768, input: [text] }
          - { id: mimo-v2.6-flash, name: "MiMo v2.6 Flash", contextWindow: 262144, maxTokens: 32768, input: [text] }
```

(`contextWindow`/`maxTokens` — консервативные заглушки, уточнить по докам платформы; TTS/ASR-модели в маршрут не включать.)

### C.2 Модель цены подписки (новая конфигурация, не хардкод)

В конфигурацию маршрута/источника добавить блок подписки (deployment-owned, валидируемый схемой):

```yaml
subscription:
  creditsUsd: 16            # $ за пакет
  credits: 11000000000      # кредитов в пакете
  creditToTokenRatio: 1     # НЕИЗВЕСТНО — см. открытые вопросы; поле обязательно, значение уточнить
  offPeakDiscount: 0.2
  offPeakWindow: "09:00-17:00 America/Los_Angeles"
```

Эффективная blended-цена подписки (тот же формат, что `blendedPrice` в `packages/experimental/model-routing/src/select.ts:180`):
`effectiveUsdPerToken = creditsUsd / (credits * creditToTokenRatio) * (1 - offPeakDiscount ? вне пика : 0)`.
В отличие от OpenRouter-цен, подписка не различает cache/fresh/output — одна ставка на токен; для blended-сравнения подставлять её во все три компоненты микса (`mixCached/mixFresh/mixOutput`).

### C.3 Учёт кредитов и fallback

- Считать израсходованные кредиты по `usage` чанкам потока (проекция `tokenUsage` уже есть: см. `usage()` в `packages/experimental/model-routing/src/service.ts:96`); при исчерпании пакета источник `xiaomi-plan` исключается из ранжирования до обновления (конфиг `creditsRefresh`, или сбрасывать по календарному окну платформы — уточнить).
- Ошибки `429 quota exhausted` (per-account `QUOTA`) → исключить источник с `excludeAfterFailureMs` и перейти на OpenRouter-эндпоинты того же семейства моделей.

### C.4 Сопоставление моделей

`xiaomi/mimo-v2.6-pro` (OpenRouter id, уже в tier `pro`) и `mimo-v2.6-pro` (прямой маршрут) — одна и та же модель. Нужна карта соответствия, чтобы сравнение шло «та же модель, другой источник». Предложение: в tier-конфиге разрешить источник с явным `modelMap` (см. Часть 4), а не молча сопоставлять по хвосту id.

## Часть 4. Встройка в Model Routing (`tiers`)

Сейчас пакет `packages/experimental/model-routing` жёстко OpenRouter-центричен: кандидаты — эндпоинты `fetchOpenRouterEndpoints` (`service.ts:78`), ранжирование по blended-цене (`select.ts`), диспатч — `innerRoute: 'openrouter'` + `openRouterRouting`-блок (`adapter.ts:990`).

**Что сделать (минимально достаточное):**

1. **Обобщить «эндпоинт» на «источник».** Кандидат = либо OpenRouter-эндпоинт (как сейчас: tag, quantization, uptime, цены), либо прямой источник (`claude-proxy` / `xiaomi-plan`) с фиксированной эффективной blended-ценой из C.2 и явным провайдерским маршрутом. Общий интерфейс для фильтров и ранжирования в `select.ts`; для прямых источников фильтры quantization/uptime нейтральны (не отбрасывать по отсутствию данных — иначе они никогда не пройдут).
2. **Типы источников в tier-конфиге** (`config.ts`): `models: string[]` остаётся списком OpenRouter-id; добавить `extraSources: [{ route, models|modelMap, price? }]` (маршрут pi-ai + сопоставление id). В `Pin`/`RoutingEndpoint` нести признак источника (`types.ts`).
3. **Диспатч по источнику.** В `attempt()`/`dispatch` (`adapter.ts:960-1005`) отправлять через `innerRoute` источника (для прямых — `provider: 'claude-proxy' | 'xiaomi-plan'`, без `openRouterRouting`-блока); `innerEfforts`/`innerCanDispatch` (`service.ts:111`) запрашивать у соответствующего маршрута, а не только у `config.innerRoute`.
4. **Правило приоритета Xiaomi.** Сравнение blended-цен кандидатов уже есть — при корректной эффективной цене подписки `xiaomi-plan` просто выиграет ранжирование, когда дешевле; **дополнительно** ввести опциональный `preferRoute` в tier (маршрут, который при равной цене предпочитается) — иначе подписка может проиграть по долле цента из-за шума округления. Когда подписка дороже OpenRouter (вне пакета кредитов или невыгодный миксе) — источник проигрывает сам, правило остаётся общим.
5. **Ротация ключей источника** — доработка B работает ниже уровня маршрута: Model Routing видит либо успех, либо финальный `KEY_QUOTA`/`QUOTA`, на который действует существующая механика `rerouteCodes`/`excludeAfterFailureMs`/`preferModel` (`adapter.ts:238,898`). `KEY_QUOTA` добавить в `rerouteCodes` по умолчанию рядом с `RATE_LIMIT`.
6. **Диагностика.** В `RoutingDiagnosticsRecord`/кандидаты (`diagnostics.ts`, `types.ts`) добавить поле источника (`openrouter | claude-proxy | xiaomi-plan`) и effective-цену подписки — лог решений (`diagnosticsPath`) должен показывать, почему выбрана подписка.

## Часть 5. Итоговая конфигурация профиля (скелет)

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml (существующий блок llm-pi-ai расширяется)
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      openrouter: { apiKeyEnv: OPENROUTER_API_KEY }
      claude-proxy: { ... Часть 1 ... }
      xiaomi-plan:  { ... Часть 3 ... }
- id: model-routing
  name: '@deepseek-ai/dsh-experimental-model-routing'
  config:
    tiers:
      - name: pro
        models: [ deepseek/deepseek-v4-pro, xiaomi/mimo-v2.6-pro, ... ]   # как сейчас
        extraSources:                                                      # новое
          - { route: xiaomi-plan,  modelMap: { xiaomi/mimo-v2.6-pro: mimo-v2.6-pro } }
          - { route: claude-proxy, models: [ claude-sonnet-5, claude-opus-4-8 ] }
        preferRoute: xiaomi-plan
```

## Часть 6. Требования к реализации (по AGENTS.md репозитория)

- Новые поведения — через конфигурационные поля со схемой (`Config`), без `DEFAULT_*`-констант; misconfiguration — fail loud при загрузке.
- Юнит-тесты + REAL-composition тест (загрузка `cordis.yml` через Loader с мок-сервером провайдера; см. `packages/test-support/llm-mock-server`), тест disposal при HMR-перезагрузке регистрируемых компонентов.
- Всё, что видит модель, — воспроизводимо из лога сессии: новые поля решений в событии `model-routing/decision` (`types.ts`, `projection.ts`) с `ignorable: true`, где уместно.
- Изменение поверхности конфигурации (новые ключи в `cordis.patch.yml`) — проверить, нужен ли upgrade guide (`dsh-create-upgrade-guide`); README пакетов `llm-pi-ai` и `model-routing` обновить вместе с кодом.
- UI-строки (если затронут Settings/Models) — через локали (`verify-client-ui-i18n`).
- Прогнать `pnpm run test`, `typecheck`, `lint`, doc-sync для затронутых поверхностей; snapshot-тест на модельно-видимые изменения.

## Открытые вопросы (уточнить до старта)

1. **Кредиты Xiaomi ≠ токены?** Как платформа конвертирует кредиты в фактуруцию по моделям/типам токенов (input/output/cache)? Без этого эффективная цена подписки — оценка. Поле `creditToTokenRatio` в C.2 обязательно как раз из-за этого.
2. **Окно/сброс кредитов** — 11 млрд в месяц? на аккаунт навсегда? когда обновляется лимит ключа у Claude-proxy (текст ошибки «Raise the limit» намекает на пользовательский лимит на ключ)?
3. **Anthropic-протокол Xiaomi** — `GET /anthropic/v1/models` отдаёт 404; если выбирать `anthropic-messages` ради cache_control, каталог моделей придётся объявлять вручную (уже поддержано `models:` в профиле). Какой протокол фиксируем как основной?
4. **Хранение ключей** — несколько ключей Claude-proxy сейчас в `.env` (`CLAUDE_PROXY_API_KEY`); заводить `CLAUDE_PROXY_API_KEY_2..N` там же или в credentials service (web Models page)? От этого зависит форма `apiKeys`.
5. **Приоритет Claude-proxy** — с какой ценой сравнивать прокси (ключи с лимитами, цена неизвестна)? Вариант: фиксированная конфигурируемая цена или правило «claude-proxy всегда предпочтительнее для tier pro/flash». Решение влияет на ранжирование.
6. **A.1 (user-agent)** — принимаем локальный relay или правку кода с узким исключением атрибуции?
