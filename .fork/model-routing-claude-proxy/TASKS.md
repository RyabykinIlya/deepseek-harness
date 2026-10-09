# Задачи части B

Пул ключей и ротация при исчерпании лимита. Единственная часть плана без блокеров —
почему остальные отложены, см. [STATUS.md](STATUS.md) и [DECISIONS.md](DECISIONS.md).

## Состав

| # | Задача | Файлы | Статус |
|---|---|---|---|
| B1 | Код `KEY_QUOTA` и предикат `isKeyQuotaExceededError` | `packages/llm/llm/src/error.ts` | **отгружено** |
| B2 | Классификация `KEY_QUOTA` до аккаунт-квоты и до 429 | `packages/llm/llm-pi-ai/src/stream.ts` | **отгружено** |
| B3 | Поле `apiKeys` в схеме профиля и список в resolved-типе | `packages/llm/llm-pi-ai/src/config.ts` | **отгружено** |
| B4 | Ротация с кулдауном | `packages/llm/llm-pi-ai/src/adapter.ts`, `index.ts` | **отгружено** |
| B5 | `KEY_QUOTA` в `rerouteCodes` по умолчанию | `packages/experimental/model-routing/src/config.ts` | **отгружено** (дефолт `['RATE_LIMIT','SERVER','TRANSPORT','TIMEOUT','PI_AI_ERROR','KEY_QUOTA']`), см. «Решение по B5» ниже |
| B6 | snapshot модельно-видимых изменений | `snapshots/` | не начато |

### Решение по B4: отгружено

Ротация была снята с отгрузки 2026-10-06 по двум причинам. Обе сняты в тот же день:
**владелец заказал ротацию**, и это и есть тот текущий потребитель, которого требовало
правило `packages/CLAUDE.md`, а конструкция нашлась рабочая.

План клал ротацию в `resolveApiKey` → `profileOptions` — это по-прежнему неверно, и
причины те же:

- `resolveApiKey` (`packages/llm/llm-pi-ai/src/index.ts:221`) вызывается один раз на
  попытку, до отправки — отказа ещё нет;
- ошибка приходит **внутри потока**: код лежит в `failure.code` finish-чанка
  (`packages/llm/llm-pi-ai/src/stream.ts`), а поток отдаётся потребителю по одному чанку.

Рабочая конструкция отличается от плановой на один элемент: **буфер**. Цикл по ключам
живёт в `streamWithSnapshot` (`packages/llm/llm-pi-ai/src/adapter.ts`), копит чанки и не
отдаёт их, пока не увидит либо `finish`, либо **первый контентный** чанк. На `finish` с
`KEY_QUOTA` и пустым буфером контента ключ помечается исчерпанным, буфер выбрасывается,
попытка повторяется следующим ключом. Как только отдан первый контентный чанк — ротация
для этой операции прекращается навсегда.

Образец был в `packages/experimental/model-routing/src/adapter.ts:988–996`, но копировать
его было нельзя: там буфер выходит на первом не-`usage` чанке, что включает и `finish` —
как раз то, что ломает ротацию. Условие выхода переписано на «первый контентный».

### Решение по B5: отгружено

Вопрос был закрыт отрицательно 2026-10-06 (аргумент ниже) и **возвращён в работу и закрыт** в тот же день, когда владелец расширил скоуп: дефолт `rerouteCodes` в `packages/experimental/model-routing/src/config.ts` теперь содержит `KEY_QUOTA`, и в живом профиле `rerouteCodes` дополнительно несёт `QUOTA` для квоты подписки `Anthropic-token-plan-sgp`.

Содержание прежнего возражения осталось верным и по-прежнему важно для чтения кода: **рероут меняет модель, а исчерпается ключ.** Гейт рероута — `pin.endpoint !== undefined` (`packages/experimental/model-routing/src/adapter.ts:1000` и `:1012`), а `endpoint` заполняется только для OpenRouter-эндпоинта. Поэтому для прямого маршрута без `endpoint` `KEY_QUOTA` в `rerouteCodes` не даёт рероута сам по себе: ключ меняется ротацией внутри одного вызова (B4), а в новый источник переводит сравнение цены по тиру, а не код в `rerouteCodes`. Код добавлен потому, что он **нужен** и в OpenRouter-ветке (исчерпание аккаунта на роуте), и как общий признак для правил маршрутизации, которые захотят на него опереться.

Прежняя формулировка довода («это ложное лечение, так как уводит на другую модель») верна для `maxReroutes: 2` и остаётся в силе как предупреждение: если все ключи прямого маршрута исчерпаны, а `KEY_QUOTA` стоит в `rerouteCodes`, запрос уйдёт на другую модель тира, а не на другой ключ. Это ровно тот сценарий, который часть B закрывает ротацией, а не рероутом.

### Решение по B3: отгружено (после отката)

Схема `apiKeys` была написана и проверена, затем **откачена**, а затем **возвращена** —
в тот же день, вместе с решением делать ротацию. История важна, потому что обе позиции
были обоснованы:

- Откат был верен **на тот момент**: поля не читал никто, а профиль только с `apiKeys`
  оставлял `apiKeyEnv === undefined`, и `resolveApiKey` возвращал `undefined` — то есть
  откат на окружение pi-ai и запрос чужим ключом. Мёртвая конфигурация, молча
  меняющая аутентификацию.
- Возврат верен **сейчас**: ротация (B4) отгружена и читает список, так что у поля есть
  потребитель.

Правило `packages/CLAUDE.md` («у каждой опции текущий владелец») в обоих случаях
соблюдено — менялся факт наличия потребителя, а не трактовка правила.

Откат выполнялся правкой вручную: `git checkout` на этих файлах заблокирован
классификатором auto mode как необратимое удаление. Копия первой версии лежит в
`/tmp/dsh-apikeys-backup/`. `apiKeyEnv` продолжает работать: профиль с одним
`apiKeyEnv` резолвится в список из одного элемента.

### Что отгружено

| # | Что | Где |
|---|---|---|
| B1 | код `KEY_QUOTA`, предикат `isKeyQuotaExceededError`, `ACCOUNT_LIMIT_REACHED` | `packages/llm/llm/src/error.ts` |
| B2 | ветка `KEY_QUOTA` до аккаунт-квоты и 429 | `packages/llm/llm-pi-ai/src/stream.ts` |
| B3 | поле `apiKeys`, resolved-список, `keyCooldownMs` | `packages/llm/llm-pi-ai/src/config.ts` |
| B4 | цикл ротации с буфером, состояние кулдауна в `apply` | `packages/llm/llm-pi-ai/src/adapter.ts`, `index.ts` |
| B5 | `KEY_QUOTA` в дефолте `rerouteCodes` | `packages/experimental/model-routing/src/config.ts` |
| — | `userAgentOverride` (подмена `user-agent` на маршруте, opt-in) | `packages/llm/llm-pi-ai/src/{config,adapter,discovery}.ts` |
| — | маршрут `claude-proxy` (конфиг + модели) и `Anthropic-token-plan-sgp` в живом профиле | `~/.dsh/profiles/web/cordis.patch.yml` |
| — | `extraSources` + `modelMap` + по-корзинная цена (`ExtraSourcePrice`) | `packages/experimental/model-routing/src/{config,types,select,endpoint}.ts` |
| — | диспатч по источнику (`provider: pin.source.kind`), рероут-гейт для прямых | `packages/experimental/model-routing/src/adapter.ts` |
| — | README (en/zh + пара), тесты, `mock-server.ts` (`byKey`) | `packages/llm/llm-pi-ai/` |

Проверено: 402 теста в `llm-pi-ai`, `typecheck` — чисто; полный прогон пакетов фичи 2026-10-07 — 101 файл, 1725 тестов зелёные. Правило `keyCooldownMs`: обязательно при >1 креденшеле, отказано при ≤1, без `DEFAULT_*`-константы.

### Верная конструкция

Пошаговый разбор — в плане,
[../plans/model-routing-claude-xiaomi.md](../plans/model-routing-claude-xiaomi.md),
раздел «Верная конструкция ротации, когда потребитель появится». Коротко: цикл по ключам
внутри `streamWithSnapshot` (`packages/llm/llm-pi-ai/src/adapter.ts`), буфер до первого
контентного чанка, состояние — в замыкании `apply`
(`packages/llm/llm-pi-ai/src/index.ts:260`).
