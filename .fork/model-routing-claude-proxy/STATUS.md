# Model Routing: Claude-proxy, ротация ключей, Xiaomi

Рабочая папка по плану `../plans/model-routing-claude-xiaomi.md`. Все записи по этой
работе живут здесь: что делаем, что решено, что сделано.

**Начинать читать отсюда.** Решения — в [DECISIONS.md](DECISIONS.md), план-источник —
в [../plans/model-routing-claude-xiaomi.md](../plans/model-routing-claude-xiaomi.md).

## Границы работы (обновлены 2026-10-06, вечер)

**Скоуп расширен владельцем.** Пункты, ранее помеченные «отложено»/«не делаем»,
возвращаются в работу. Отказы в [DECISIONS.md](DECISIONS.md) были решением
агента-исполнителя, не ограничением задачи; владелец это отменил.

Целевой сценарий Auto: **Claude (пул ключей, ротация) → при исчерпании/отказе →
Xiaomi против OpenRouter, что дешевле**, с прежним определением `pro`/`flash`.

### Текущее состояние (проверено по коду)

| Часть плана | Статус | Комментарий |
|---|---|---|
| **B. Пул ключей и ротация** | **Готово** (коммит `74caa55c7c`) | `KEY_QUOTA`, `apiKeys`, `keyCooldownMs`, ротация с буфером — всё в коде |
| **A. Маршрут `claude-proxy`** | **В работу** | Разблокировано владельцем; нужен UA-гейт |
| **C. Xiaomi Token Plan + сравнение цены** | **В работу** | Цена **по-корзинная** (1:1 был ошибкой); веса кредитов известны, см. план |
| **D. Обобщение «эндпоинт → источник»** | **В работу** | Самый объёмный кусок: `extraSources`, `Pin` с маршрутом, диспатч |
| **B5, `KEY_QUOTA` в `rerouteCodes`** | **В работу** | Дефолт в `config.ts:321` не содержит `KEY_QUOTA`, хотя message коммита это утверждает — расхождение, чиним |

### Расхождение коммита `74caa55c7c`

Message утверждает, что `KEY_QUOTA` попал в `rerouteCodes`. Код это не подтверждает:
дефолт `packages/experimental/model-routing/src/config.ts:321` прежний, пакет
`model-routing` не импортирует `KEY_QUOTA`. Закрывается вместе с B5.

### Статус после реализации (проверено по коду, 2026-10-06)

Всё ниже лежит в рабочем дереве (не закоммичено), тесты зелёные: `vitest run
packages/experimental/model-routing packages/llm/llm-pi-ai` — 35 файлов / 665 тестов,
`npx tsc --build tsconfig.json` — exit 0.

| Кусок | Где | Статус |
|---|---|---|
| `KEY_QUOTA`, `apiKeys`, `keyCooldownMs`, ротация ключей с буфером | `packages/llm/llm-pi-ai`, `packages/llm/llm` | **Готово** (коммит `74caa55c7c`) |
| `userAgentOverride` (подмена `user-agent` на маршруте, opt-in) | `packages/llm/llm-pi-ai/src/{config,adapter,discovery}.ts` | **Готово** |
| Маршрут `claude-proxy` (конфиг + модели) | README `llm-pi-ai`, схема профиля | **Готово** |
| `extraSources` + `modelMap` + цена (подписочная `usdPerToken` / по-корзинная) | `packages/experimental/model-routing/src/{config,types,select,endpoint}.ts` | **Готово** |
| Диспатч по источнику (`provider: pin.source.kind`), рероут-гейт для прямых | `packages/experimental/model-routing/src/adapter.ts` | **Готово** |
| **B5** — `KEY_QUOTA` в `rerouteCodes` | `packages/experimental/model-routing/src/config.ts:422` | **Готово** |
| Целевой сценарий (claude-proxy → KEY_QUOTA → дешевший xiaomi/openrouter) | тесты `model-routing/tests/adapter.spec.ts` | **Готово** |

### Цена Xiaomi — исправлена 2026-10-06 (1:1 был ошибкой)

Коэффициент «1 кредит = 1 токен» **неверен**. По
[Token Plan](https://mimo.mi.com/docs/en-US/price/token-plan) кредит — вес токена по
корзине: pro 2.5/300/600, flash 2/100/200 за cache-hit/cache-miss/output. 1 кредит =
$16/11e9 = $1.454545e-9. Цена подписки **по-корзинна** (`promptUsdPerToken` /
`completionUsdPerToken` / `cacheReadUsdPerToken`), плоская `usdPerToken` для Xiaomi
неприменима. Пересчитанные $/токен — в плане, раздел «Актуальная цена Xiaomi».

**Следствие для сравнения с OpenRouter** (замер по фикстуре `deepseek-v4-pro`, микс
0.9 кэш / 0.08 вход / 0.02 выход):

| Источник | Blended $/токен |
|---|---|
| Xiaomi `mimo-v2.6-pro` (подписка, по-корзинно) | ~5.56e-8 |
| Самый дешёвый OpenRouter endpoint (`streamlake/fp8`) | ~4.07e-8 |

То есть на кэш-тяжёлом миксе **подписка Xiaomi не дешевле** самого дешёвого
OpenRouter-эндпоинта (~×0.73), а не «в 36 раз дешевле». Это согласуется с пересчётом
сессии `session-b20d1488` («паритет, а не 36×»). Поэтому «xiaomi/openrouter — что дешевле»
— **реально решает** и не схлопывается в «всегда xiaomi»; исход зависит от тира, доли
кэша в ходе и того, какой OpenRouter-эндпоинт доступен. Ранжирование по `blendedPrice`
на по-корзинных ценах это и считает.

Тесты, проверяющие механику (диспатч/ранжирование/цитату), используют синтетические
источники с ценой-заглушкой, чтобы не выдавать утверждение об экономике за факт;
реальные цены Xiaomi живут в плане и README. Все 665 тестов зелёные, typecheck чист.

### ФАКТ: relay `/v1/models` ВРЁТ (2026-10-07)

Список моделей `GET https://claude.blogmin.ru/api/llm/v1/models` **неполный и вводит в
заблуждение**: он отдаёт `claude-opus-4-8, claude-opus-4-7, claude-sonnet-5,
claude-sonnet-4-6, claude-haiku-4-5`, но **не отдаёт `claude-opus-5`** — при этом
живой запрос `POST /v1/messages` с `model: claude-opus-5` отвечает штатно
(`"model":"claude-opus-5"`, проверено 2026-10-07). Владелец подтвердил: реально
работают `claude-opus-5` и `claude-sonnet-5`; каталогу эндпоинта доверять нельзя,
состав моделей подтверждается только запросом.

Следствие для конфига: провайдер `claude-proxy` объявляет модельный список вручную
(это поддержано `models:` в профиле), и его правка не опирается на `/v1/models`.

### Настройка: что сделать, чтобы всё это заработало

Это единственное, что осталось — код готов. Три слоя конфигурации, каждый в своём
месте. Все пути относительно профиля `web` (`~/.dsh/profiles/web/`).

#### Слой 1 — маршруты провайдеров (`llm-pi-ai`): YAML **или** UI (volatile)

Файл: `cordis.patch.yml`, секция `- id: llm-pi-ai` → `config.providers`. Поле
`providers` — **`Volatile`** (`config.ts:279`), поэтому его можно править и в YAML, и в
UI (Settings → namespace `llm-pi-ai` → путь `providers/<имя>`), и оно применяется без
рестарта (реагирует на `loader/volatile-update`). Именно здесь живут ключи,
`userAgentOverride` и модели. Единственное, что требует перезапуска, — сама установка
плагина/строки профиля, не значения полей.

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      openrouter:
        apiKeyEnv: OPENROUTER_API_KEY
      claude-proxy:
        displayName: Claude Proxy
        api: anthropic-messages
        baseURL: https://claude.blogmin.ru/api/llm
        apiKeys:                      # пул ключей, ротация по KEY_QUOTA
          - CLAUDE_PROXY_KEY_A
          - CLAUDE_PROXY_KEY_B
        keyCooldownMs: 600000          # обязателен при >1 ключе (секретов нет дефолта)
        userAgentOverride: claude-cli/2.1.289   # прохождение гейта прокси
        models:
          - { id: claude-opus-4-8 }
          - { id: claude-opus-4-7 }
          - { id: claude-sonnet-5 }
          - { id: claude-sonnet-4-6 }
          - { id: claude-haiku-4-5 }
      xiaomi-plan:
        displayName: Xiaomi Token Plan
        api: openai-completions
        baseURL: https://token-plan-sgp.xiaomimimo.com/v1
        apiKeys: [XIAOMI_PLAN_API_KEY]
        models:
          - { id: mimo-v2.6-pro,   name: "MiMo v2.6 Pro" }
          - { id: mimo-v2.6-flash, name: "MiMo v2.6 Flash" }
```

Где взять значения:
- **`apiKeys` / `apiKeyEnv`** — имена креденшелов. Кладутся либо в `.env` той же папки
  (`CLAUDE_PROXY_KEY_A=...`), либо через credentials service (web → Settings → Models).
  Ротация работает именно со списком `apiKeys`; `apiKeyEnv` — одиночный случай.
- **`userAgentOverride`** — `claude-cli/X.Y.Z`, где `X.Y.Z` — трёхчастный номер. Прокси
  пускает только `^claude-cli/\d+\.\d+\.\d+`; значение `claude-cli/2.1.289` подходит.
  Актуальную версию снять с локального `claude --version` (см. обсуждение ранее), но для
  гейта важна только форма, не свежесть.
- **`keyCooldownMs`** — насколько исчерпанный ключ выпадает из ротации (мс). Обязателен,
  т.к. ключей >1; численного дефолта нет (это deployment-факт).

Значения полей применяются без рестарта (volatile); перезапуск нужен только при первой
установке строки профиля.

#### Слой 2 — ранжирование и источники (`model-routing`), volatile (и YAML, и UI)

Файл: тот же `cordis.patch.yml`, секция `- id: model-routing` → `config.tiers`. Но
`tiers` (и `extraSources` внутри) — **`Volatile`**, редактируется и в YAML, и в UI:
Settings → namespace `model-routing` → путь `tiers`. Применяется без рестарта.

Вот здесь задаётся сравнение цены. Каждый tier получает `extraSources` — прямые
источники рядом с OpenRouter-эндпоинтами, отсортированные по blended-цене:

```yaml
- id: model-routing
  name: '@deepseek-ai/dsh-experimental-model-routing'
  config:
    tiers:
      - name: pro
        label: Pro
        models: [ deepseek/deepseek-v4-pro, xiaomi/mimo-v2.6-pro, ... ]  # как сейчас
        # ... остальные поля тира без изменений ...
        extraSources:
          # Xiaomi: кредитно-весовая подписка -> ТРИ корзины, НЕ плоская usdPerToken
          - route: xiaomi-plan
            modelMap:
              xiaomi/mimo-v2.6-pro: 'mimo-v2.6-pro@{"promptUsdPerToken":4.363636e-7,"completionUsdPerToken":8.727273e-7,"cacheReadUsdPerToken":3.636364e-9}'
              xiaomi/mimo-v2.6-flash: 'mimo-v2.6-flash@{"promptUsdPerToken":1.454545e-7,"completionUsdPerToken":2.909091e-7,"cacheReadUsdPerToken":2.909091e-9}'
            tools: true
          # Claude: цена неизвестна (ключи с лимитом). Если нужен приоритет — задай цену
          # или положись на порядок/сценарий; см. вопрос про приоритет Claude ниже.
          - route: claude-proxy
            models: [ claude-sonnet-5, claude-opus-4-8, claude-opus-4-7, claude-sonnet-4-6, claude-haiku-4-5 ]
            tools: true
```

Форма цены (`ExtraSourcePrice`, см. `config.ts`):
| Поле | Что это |
|---|---|
| `promptUsdPerToken` | $ за токен cache-**miss** входа (у Xiaomi = кредиты miss) |
| `completionUsdPerToken` | $ за output-токен |
| `cacheReadUsdPerToken` | $ за cache-**hit** токен |
| `usdPerToken` | плоская ставка на всё — **только для реально плоских тарифов**, не для Xiaomi |

Значения `promptUsdPerToken` = (кредиты за токен) × ($16 / 11e9). Полная таблица
кредитных весов — в плане, раздел «Актуальная цена Xiaomi». **Не** подставляй сюда
плоское `1.45e-9` — это старая ошибка 1:1, она сделает Xiaomi ложно-дешёвым.

#### Слой 3 — ключи/секреты (`.env` или credentials)

Рядом с `cordis.patch.yml` (или через Settings → Models → credentials):
```
CLAUDE_PROXY_KEY_A=sk-klod-...
CLAUDE_PROXY_KEY_B=sk-klod-...
XIAOMI_PLAN_API_KEY=tp-...
```

#### Проверка (сквозной прогон)

После всех трёх слоёв (и однократного перезапуска, если строка профиля ставилась впервые):
Auto-сессия → первым идёт `claude-proxy`, пока у
пула есть живой ключ; на `KEY_QUOTA` (оба ключа исчерпаны) рероут → дальше `xiaomi-plan`
против OpenRouter-эндпоинтов того же тира, кто дешевле по blended-цене. Лог решений
(`diagnosticsPath`) показывает победителя и цены, по которым считал.

#### Что нужно решить до настройки (блокирует слой 2)

- **Приоритет Claude.** Цена прокси-ключей неизвестна — они с лимитом, не per-token. Без
  цены `claude-proxy` попадает в `unpriced` и не выигрывает ранжирование. Нужно одно:
  (а) задать цену Claude в `price` (консервативно дёшево, чтобы всегда шёл первым), либо
  (б) правило «claude всегда предпочтительнее до исчерпания» — это уже не цена, а
  отдельная настройка, её в коде сейчас нет. Выбери, и я допишу.

### Оговорки, зафиксированные исполнителями

- Пустое `userAgentOverride: ''` принимается как есть (Fetch-легально); newline/не-ASCII —
  fail loud. Задокументировано в JSDoc.
- При равной blended-цене прямой источник без измеренных данных идёт **последним**
  (отсутствие измерения не должно бить измеренное); при полном равенстве — конфигурационный
  порядок. Задокументировано в README и JSDoc.
- OpenRouter-пути (`openrouter-http.ts`/`openrouter-endpoints.ts`) не тронуты — у них нет
  контекста профиля, подмена туда не проводится.

### Что делается и в каком порядке

1. **Маршрут `claude-proxy` + UA-гейт** (разблокирует «Claude первой»).
2. **B5** — `KEY_QUOTA` в `rerouteCodes`, срабатывание по исчерпании **всего пула**
   (не одного ключа).
3. **Обобщение источников в `tiers`** — кандидаты за пределами OpenRouter.
4. **`subscription`-блок и потировое сравнение цены** — Xiaomi против самой дешёвой
   модели тира.
5. Сквозной прогон: Auto → Claude → оба ключа исчерпаны → Xiaomi/OpenRouter по цене.



| Часть плана | Статус | Что это значит |
|---|---|---|
| **A. Провайдерский маршрут `claude-proxy`** | **Отложено** | Конфигурация не пишется. Причина — [DECISIONS.md](DECISIONS.md#почему-маршрут-claude-proxy-отложен) |
| **B. Пул ключей и ротация при исчерпании** | **В работе** | Основная часть. Провайдер-нейтральная: работает на любом маршруте pi-ai |
| **C. Xiaomi Token Plan** | **Отложено как есть** | Сравнение цены подписки с OpenRouter не делаем. Записано отдельно, см. ниже |
| **D. Встройка в Model Routing** | Частично | Из плана берём только `KEY_QUOTA` в `rerouteCodes`; обобщение «эндпоинт → источник» отложено вместе с C |

### Что именно отложено в C

Сравнение эффективной цены подписки Xiaomi с per-token ценами OpenRouter **не делаем**.
Вместе с ним отложены обобщение кандидата «эндпоинт → источник» и блок `subscription`
в конфигурации маршрута: без сравнения цены им нечего ранжировать. Маршрут
`xiaomi-plan` как таковой — отдельная задача, не эта.

Подписка Xiaomi остаётся рабочей как есть; ничего в её текущем поведении не меняется.
Числа по ней (эффективная ставка `$1.45e-6/кредит`, замер 113.18M токенов за $5.96
против ~$0.16 на подписке) живут в плане-источнике, в разделе «Часть 0.2». В
[../MEASUREMENTS.md](../MEASUREMENTS.md) их нет — при возобновлении части C их надо
оттуда перенести.

## Что делаем сейчас

**Часть B**, и только те её пункты, что не зависят от ротации. Диагноз плана подтверждён
по коду 2026-10-06:

- `isQuotaExceededError` (`packages/llm/llm/src/error.ts:97`) требует «usage limit»
  **перед** «exceeded/exhausted/reached». Фраза прокси — «This API key **reached its
  usage limit**» — под этот паттерн не подходит и падает в `RATE_LIMIT` по «429».
- `RATE_LIMIT` входит и в `retryableCodes` (`retry-policy.ts:18`), и в `rerouteCodes`
  Model Routing: один исчерпанный ключ ретраится впустую.

Полная выкладка валидации — в
[../plans/model-routing-claude-xiaomi.md](../plans/model-routing-claude-xiaomi.md),
раздел «Правки по итогам валидации (2026-10-06)».

## Вторая валидация (2026-10-06, Opus)

Проход проверки плана на Opus подтвердил премису запуском предикатов (не чтением) и
поправил три вещи, которые первая валидация и записи этой папки сформулировали неточно:

1. **Адрес `resolveApiKey`.** Объявлена в `packages/llm/llm-pi-ai/src/index.ts:219`;
   `:223` — строка чтения `profile.apiKeyEnv` внутри неё.
2. **Причина, по которой ротация в адаптере не может быть невидимой.** Кроме видимости
   снаружи, адаптер намеренно запрещает SDK-ретраи: `maxRetries: 0` с комментарием
   «The agent recovery layer owns visible attempts; one adapter call is one SDK attempt»
   (`packages/llm/llm-pi-ai/src/adapter.ts:156`). Это записанное решение, и ротация обязана
   его не нарушать, а не обходить.
3. **Довод по B5 был неверен.** Не «эффекта нет», а «эффект неверный»: при
   `maxReroutes: 2` рероут увёл бы запрос на другую **модель**, хотя исчерпан **ключ**.
   Исправлено в [TASKS.md](TASKS.md#решение-по-b5-не-делаем).

Механизм ротации, который первая валидация считала невыполнимым, оказался выполнимым —
и **отгружен** 2026-10-06 после того, как владелец заказал ротацию (это и есть потребитель).
Готового решения в кодовой базе не было:
`packages/experimental/model-routing/src/adapter.ts:988–996` копит только `usage`-чанки и
выходит на первом не-`usage`, то есть контент не буферизует вовсе — там это верно,
потому что рероут допустим и после начала контента. Ротация использует тот же приём с
обратным условием выхода: копить, пока не пришёл первый **контентный** чанк.

**Отгружено:**

| Файл | Что |
|---|---|
| `packages/llm/llm/src/error.ts` | код `KEY_QUOTA`, предикат `isKeyQuotaExceededError`, `ACCOUNT_LIMIT_REACHED` в `isQuotaExceededError` |
| `packages/llm/llm-pi-ai/src/stream.ts` | ветка `KEY_QUOTA` перед аккаунт-квотой и 429 |
| `packages/llm/llm-pi-ai/src/config.ts` | поле `apiKeys`, resolved-список креденшелов, `keyCooldownMs` |
| `packages/llm/llm-pi-ai/src/adapter.ts`, `index.ts` | цикл ротации с буфером; состояние кулдауна в замыкании `apply` |
| `packages/llm/llm/README.md` + `README.zh.md` + `.i18n.yaml` | `KEY_QUOTA` в описании кодов |
| `packages/llm/llm-pi-ai/README.md` + `README.zh.md` + `.i18n.yaml` | `apiKeys`, `keyCooldownMs`, поведение ротации |
| тесты: `service.spec.ts`, `convert.spec.ts`, `config.spec.ts`, `adapter.spec.ts`, `mock-server.ts` | классификация, схема, ротация; мок умеет отвечать по ключу (`byKey`) |

Проверено независимо: 402 теста в `llm-pi-ai` (было 389 до правки), `typecheck` — чисто.
Правило `keyCooldownMs`: обязательно при >1 креденшеле, отказано при ≤1, без
`DEFAULT_*`-константы (`AGENTS.md`). `maxRetries: 0` не тронут — ротация это выбор ключа
для одной попытки, а не ретрай.

**Не отгружено, с разбором:**

- **B5, `KEY_QUOTA` в `rerouteCodes`** — [TASKS.md](TASKS.md#решение-по-b5-не-делаем).
  Рероут срабатывает только при `pin.endpoint !== undefined`, у прямого маршрута его нет.
- **Порядок источников в tier** — [SOURCE-ORDER-RESEARCH.md](SOURCE-ORDER-RESEARCH.md).
  Разведка: обобщение на три шва, упирается в диспатч; плюс скрытый блокер с `tools`,
  которого нет в плане.

Задачи внутри B — в [TASKS.md](TASKS.md).

## Открытые вопросы

Унаследованы из плана-источника, здесь только те, что блокируют часть B:

1. **Форма списка ключей.** План предлагает `apiKeys: string[]` рядом с одиночным
   `apiKeyEnv`. Пока не решено, слать ли несколько рефов или один реф на пул.
2. **TTL кулдауна.** План требует конфигурируемое `keyCooldownMs`. Дефолт не выбран.
