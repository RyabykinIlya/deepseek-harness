# Карточка Web Search против rc.2 — решение

Решение по задаче [merge-surface.md#t5](merge-surface.md) в свете того, что апстрим привёз в `dsh-v0.2.2-rc.2`. Замеры окна — [upstream-0.2.2-rc.2.md](upstream-0.2.2-rc.2.md), история пакетов форка — [web-search.md](web-search.md), [../INVENTORY.md](../INVENTORY.md).

Всё ниже прочитано в исходниках обеих сторон (`git show dsh-v0.2.2-rc.2:<path>`, `git diff dsh-v0.2.2-rc.1 HEAD -- <path>`), не в гайдах.

## 1. Что rc.2 реально умеет

**Два меню по capability, список берётся у Хоста.** `web-search-card-controller.ts:357` (`options()`) строит пункты меню из `this.providers?.[capability]`, а это ответ `ctx.remote.web.listProviders()` (строка 493). Апстримные провайдеры поднимаются вперёд фиксированным порядком `MENU_ORDER` (62), **остальные идут в порядке регистрации Хоста**:

```ts
const ordered = [
  ...first.flatMap(id => registered.filter(info => info.id === id)),
  ...registered.filter(info => !first.includes(info.id)),
]
```

**Плагинные провайдеры в меню есть.** `WebSearchCard.tsx:45` (`providerLabel`) для id вне `PROVIDER_LABELS` берёт `option.title ?? option.id`; `web/web/src/index.ts:246` (`providerInfo`) отдаёт `{id, title?, description?}` каждого зарегистрированного провайдера, и `listProviders()` (152) не фильтрует по `available()`. То есть `brave`, `tavily`, `duckduckgo` **выбираются мышью в rc.2 без единой правки апстримного кода** — достаточно того, что их пакеты смонтированы. README апстрима утверждает то же прямо: «A menu lists every provider the Host registers, including providers that plugins register, so a newly installed provider needs no change to this page» (`client/ui-settings-web-search/README.md`, раздел «Use this package»).

**Выбранный, но не зарегистрированный id не теряется.** `options()` (371) добавляет его отдельным пунктом с `missing: true`, карточка рисует его как `providerMissing` = `'{id} (not loaded)'`. Это ровно то поведение, ради которого наша карточка держала ветку `pinned`.

**Своих настроек провайдера на странице нет и шва для них нет.** `searchKind()` (380) возвращает `'plugin'` для любого id, кроме `deepseek-search-api`/`deepseek-official`, а карточка на `kind === 'plugin'` рисует одну строку текста: `hint={... search.kind === 'plugin' ? t('pluginProviderHint') : undefined}` (`WebSearchCard.tsx:78`), где `pluginProviderHint` = `'Configure this provider in its own plugin settings.'` Панель настроек (`styles.panel`) показывается только при `kind === 'deepseek'`/`'legacy'`. Слота, куда пакет провайдера мог бы вложить свои поля, страница не объявляет: единственная её регистрация — собственная строка в `plugins.item` (`index.ts:72`), `children` у неё нет.

Итог: **выбор провайдера rc.2 закрывает полностью, ввод ключа провайдера — не закрывает вовсе и перенаправляет в «настройки самого плагина»**.

## 2. Возможности: карточка форка против страницы rc.2

| # | Что умеет форк | Где это в коде форка | rc.2 | Вердикт |
|---|---|---|---|---|
| 1 | Выпадашка выбора `web.searchProvider` с 6 id | `WebSearchSelectionCard.tsx:69`, `WEB_SEARCH_SELECTABLE_IDS` | меню Search из `listProviders()`, апстримные вперёд, остальные в порядке регистрации | **покрыто лучше**: список живой, а не хардкод; `exa`/`perplexity` в нашем списке — мёртвые id |
| 2 | Пункт «Автоматически» = сброс поля | `WebSearchSelectionCard.tsx:68` + пустой draft как clear (контроллер, JSDoc 88–90) | `providerAuto`, но **только когда деплой не задал провайдера** (`auto: base?.searchProvider === undefined`, контроллер 455) | **покрыто иначе**: при заданном в композиции провайдере rc.2 не показывает «Авто», зато выбор значения, равного композиции, сам чистит override (`select()`, 608) |
| 3 | Незнакомый закреплённый id показывается как есть | `WebSearchSelectionCard.tsx:56` (`pinned`) | `missing: true` + `providerMissing` | **покрыто** |
| 4 | Выбор fetch-провайдера | — (нет; форк правил только `searchProvider`) | меню Fetch, своё поле `fetchProvider` | **rc.2 умеет больше** |
| 5 | Описание провайдера под меню | — | `description` из `listProviders()` через `ctx.locale.resolveText` (`WebSearchCard.tsx:64`) | **rc.2 умеет больше** (нашим провайдерам нужно объявить `title`/`description`, см. §5) |
| 6 | Отдельная карточка настроек **на каждого** провайдера, поля объявлены провайдером | `web-search-card-controller.ts:94` (`WEB_SEARCH_PROVIDERS`: namespace, `defaultApiKeyRef`, `sectionFields`), `index.ts:88` — цикл `whileServed([provider.namespace])` | **нет**: один гибридный блок на `web-search-deepseek` + `web-deepseek-api`; для чужого провайдера только `pluginProviderHint` | **не покрыто** |
| 7 | Ввод API-ключа провайдера через credentials-домен по его `apiKeyEnv` (`BRAVE_API_KEY`, `TAVILY_API_KEY`) | `web-search-card-controller.ts` (`API_KEY_FIELD`, `writeKey`), `WebSearchCard.tsx:41` | **нет**: `legacyApiKey` жёстко адресует `web-search-deepseek.apiKeyEnv` (контроллер 397 `ref()`), показывается только при `searchKind()==='legacy'` | **не покрыто — единственная реальная потеря** |
| 8 | Правка `baseURL`/`maxResults`/`numResults`/`timeoutMs`/`maxContentChars` провайдера мышью | `sectionFields` каждого спека | нет (те же `pluginProviderHint`) | **не покрыто** (значения правятся в `cordis.patch.yml`; все поля `.volatile()`, то есть технически доступны формам) |
| 9 | Уникальные id контролов с префиксом провайдера | `WebSearchCard.tsx:41` (`plugin-config-web-search-${state.providerId}-…`) | один блок на странице, коллизий нет | **неприменимо** |
| 10 | Billing Search/Fetch, «Overridden by» для YAML-полей, retry чтения списка, `count` 1–50 | — | `billing()` (473), `advancedOverride`, `ReadFailure`, парсер `count` | **rc.2 умеет больше** |

Как **сегодня** вводится ключ каждого провайдера форка (проверено в исходниках):
- `brave` → `web-search-brave.apiKeyEnv` (default `BRAVE_API_KEY`, `web-search-brave/src/index.ts:50`), читается через `ctx.credentials.resolve` с фоллбэком на launch-environment (`resolveOptions`, `ambientApiKey`);
- `tavily` → `web-search-tavily.apiKeyEnv` (default `TAVILY_API_KEY`, `index.ts:61`), тот же механизм;
- `duckduckgo` → ключа нет вовсе (`Config` без `apiKey`/`apiKeyEnv`), поэтому в наших карточках его и нет;
- ввод мышью идёт через нашу `WebSearchCard` → `remote.credentials.set(ref, value)`, то есть в управляемый стор `~/.dsh/.credentials.yaml`.

**Живой профиль ключ мышью не вводил.** `~/.dsh/.credentials.yaml` содержит только `records:` (один `payload.secret`), секция `refs:` пуста; `TAVILY_API_KEY` лежит в `~/.dsh/.env`. То есть рабочая конфигурация опирается на `.env`-слой `credentials-local`, а не на запись из UI.

## 3. `packages/web/web/src/index.ts` — консументов не осталось

Правка форка (`git diff dsh-v0.2.2-rc.1 HEAD -- packages/web/web/src/index.ts`) добавляет `WEB_SEARCH_PROVIDER_IDS`, `WEB_FETCH_PROVIDER_IDS`, `WebSearchProviderId`, `WebFetchProviderId` — 30 строк.

Полный `grep` по дереву даёт **ровно двух потребителей**, и ни один не является кодом:

- `packages/web/web/tests/web.spec.ts:349` — тест, который проверяет сам список (и ожидает в нём `exa`, `perplexity`);
- упоминания в `.fork/*.md`.

`packages/client/ui-settings-web-search` список **не импортирует вообще**: `WebSearchProviderId` там свой, объявленный локально (`web-search-card-controller.ts:30`), а `WEB_SEARCH_SELECTABLE_IDS` — третий независимый список (`web-search-selection-controller.ts:50`, с комментарием «Deliberately NOT the same set»). То есть правка ядра не кормила даже нашу собственную выпадашку.

rc.2 свой список строит из `listProviders()` и ни в одном файле не ссылается на константы такого рода. Остальная часть правки форка в `tests/web.spec.ts` — три кейса live-selection через настоящий Loader (`mountLoadedWeb`), и они написаны на провайдерах `exa`/`perplexity`, пакетов которых в rc.2 нет; эквивалент апстрима — `describe('live provider selection')` (rc.2, `web.spec.ts:375`) через `liveConfig`, плюс `WEB_PROVIDER_CONFIGURED_MISSING` уже покрыт `web.spec.ts:156`.

**Вывод: `packages/web/web` уходит из поверхности форка целиком — оба файла.** Констант не жалко: тип `WebSearchProviderId = … | (string & {})` ничего не принуждал, а `WebRuntime.Config` — просто `z.string().volatile()` (rc.2 `index.ts:88`), любой id проходит схему и падает на выборе.

## 4. Решение: **(A) удалить карточку форка, с одной поправкой (A′)**

Голый вариант (A) неприемлем: после удаления ключ Brave и Tavily нельзя будет ввести **нигде в UI** (§5). Поэтому принимается **A′ = (A) + своя карточка на провайдера в своём пакете, через `plugins.row.config`**.

### Что уходит из поверхности

Апстримный пакет `packages/client/ui-settings-web-search` возвращается к байтам rc.2 — **13 файлов** (7 M + 6 A):

```
M src/client/WebSearchCard.tsx
M src/client/index.ts
M src/client/locales.ts
M src/client/web-search-card-controller.ts
M tests/apply.client.spec.ts
M tests/card.client.spec.tsx
M tests/controller.client.spec.ts
A src/client/WebSearchSelectionCard.tsx            → удаляется
A src/client/WebSearchSelectionCard.module.css     → удаляется
A src/client/web-search-selection-controller.ts    → удаляется
A tests/provider-fields.client.spec.tsx            → удаляется
A tests/selection-card.client.spec.tsx             → удаляется
A tests/selection.controller.client.spec.ts        → удаляется
```

Плюс `packages/web/web` — **2 файла** (`src/index.ts`, `tests/web.spec.ts`), §3.

**Итого −15 файлов из пересечения**, из них 7 — те самые «второй по тяжести конфликт окна» (`web-search-card-controller.ts` 15 ханков, `controller.client.spec.ts` 11, `locales.ts` 10, `card.client.spec.tsx` 8, `index.ts` 4, `WebSearchCard.tsx` 3, `apply.client.spec.ts` 3 — 54 ханка исчезают, а не переносятся).

### Что добавляется

Новый форк-онли пакет (конфликтов не даёт никогда):

```
packages/client/ui-settings-web-search-providers/   (имя рабочее)
  package.json  tsconfig.json  tsdown.config.ts
  README.md  README.zh.md  README.i18n.yaml
  src/index.ts                         (пустой host-apply)
  src/client/index.ts                  (apply: цикл по провайдерам)
  src/client/ProviderCard.tsx
  src/client/provider-card-controller.ts
  src/client/locales.ts
  src/css-modules.d.ts
  tests/…
```

Код переносится почти целиком: `WEB_SEARCH_PROVIDERS` (спеки namespace/ключ/поля), `WebSearchCardController` в нашей версии и `WebSearchCard` в нашей версии уже параметризованы провайдером — переезжают как есть, минус локали `providerExa`/`providerPerplexity` и минус всё, что относилось к `WebSearchSelectionCard` (она не нужна: §2, строки 1–3).

Цена регистрации (уже знакомая — ровно так живёт наш `client/ui-settings-threads`): строка в `tsconfig.client.json` (файл и так в поверхности по другим причинам), строка `insert` + зависимость в **нашем** `web-search-profile`, запись `optional` в `scripts/product-package-policy.ts` (файл уже в поверхности), регенерация `extensions/cordis-client-runner/src/client/slot-catalog.ts` (генерируемый; rc.2 его тоже меняет — снимается шагом 1 ранбука).

**Чистое изменение поверхности: −15 файлов** (новый пакет в неё не входит, апстримных правок ради него нет).

### Почему не (B) порт

Переписать пришлось бы всё: у rc.2 один `WebSearchCardController` на три namespace с `WebProviderSectionState`/`WebBillingState`/`advancedOverride`/sequence-fenced чтениями `listProviders` и `credentials.describe`, и `searchKind()` жёстко делит мир на `deepseek | legacy | plugin | none`. Вставить туда «ещё N провайдеров со своими полями» — это добавить четвёртый kind, расширить `MENU_ORDER`, развести ключи по namespace'ам и переписать `ref()`/`dropStaleKeyDraft()` c одного `web-search-deepseek` на N. То есть повторный переписывание апстримного контроллера — та же работа, что привела к 54 ханкам сейчас, и она повторится в следующем окне. Выигрыша по возможностям у (B) против (A′) нет: §2 показывает, что всё уникальное форка (строки 6–8) находится **внутри блока одного провайдера**, а не в меню.

### Почему не (C) «оставить только селектор»

Селектор — единственное, что rc.2 покрывает полностью и лучше (§2, строки 1–5). Любой вариант «в середине» оставляет в апстримных файлах правку ради того, что уже работает без неё.

### Что теряет пользователь

| Вариант | Что теряется в UI |
|---|---|
| (A′) — принято | Ничего из того, что сегодня работает мышью, **если** новый пакет смонтирован. Исчезает хардкод `exa`/`perplexity` (их пакетов в rc.2 нет). Появляется выбор fetch-провайдера и описания провайдеров |
| (A) голый | Ключи Brave/Tavily и их `baseURL`/лимиты нельзя задать мышью нигде; остаётся правка `cordis.patch.yml` + `~/.dsh/.env`. Для **живого** профиля это не регресс (ключ и так в `.env`), для «чистого профиля» из приоритета 10 — регресс |
| (B) | Ничего, но ханки остаются и повторятся |

### Что нужно живому профилю, чтобы не сломаться

`~/.dsh/profiles/web/cordis.patch.yml:221` — `searchProvider: tavily`, `fetchProvider: http`.

- **Строку менять не нужно.** rc.2 `WebRuntime.Config.searchProvider` — `z.string().volatile()`; `tavily` зарегистрирован пакетом `web-search-tavily` из бандла `web-search-profile`, который профиль держит через `link:`. Смена апстримного дефолта на `deepseek-search-api` касается только `bundle/base`, а наш `web` -override лежит выше.
- **`TAVILY_API_KEY` продолжает резолвиться** из `~/.dsh/.env` (слой `credentials-local`), независимо от судьбы карточки.
- **Блок `web-fetch-http` в профиле (`trustedProxyAddressRanges`) надо убрать.** В дереве форка этого ключа уже нет (`grep` по `web-fetch-http/src` = 0; `Config` rc.2 = `maxResponseBytes`/`maxBodyChars`/`timeoutMs`/`maxRedirects`/`userAgent`), то есть после вырезки профиль задаёт поле, которого не существует. Это хвост снятой правки, а не следствие решения по карточке — но проверяется в том же smoke-прогоне.
- После вырезки: `web-search-profile` + новый пакет карточек должны быть в зависимостях профиля (сейчас там только `web-search-profile`).

## 5. Где вводится ключ провайдера после изменения

Проверено в rc.2: **штатного места для ключа Brave/Tavily там нет**.

- Страница `web search and fetch` пишет только `web-search-deepseek.apiKeyEnv` (`web-search-card-controller.ts:397`, `keyShown()` = `searchKind()==='legacy'`).
- Схемо-генерируемых форм в Web-клиенте нет: `autoGenerate` из `settings/describe` в rc.2 читает **никто** (`grep` по `packages/client` даёт только `api/settings-controller/src/index.ts:51`), а README `settings/settings` говорит прямо: «no shipped client does so yet».
- `remote.credentials.set` в rc.2 вызывают ровно два места: `ui-settings-models/src/client/operations.ts:79` (только для LLM-маршрутов) и сама web-search-карточка. Общего редактора credential-ссылок в UI нет.
- `WEB_SEARCH_BRAVE_SETTINGS_NAMESPACE` / `WEB_SEARCH_TAVILY_SETTINGS_NAMESPACE` — это **только строка-константа** namespace'а (`web-search-brave/src/index.ts:57`, `web-search-tavily/src/index.ts:58`); «зарегистрировать поля» им нечем: пакеты не объявляют `dsh.client`, в `exports` нет `./client`, браузерной половины у них не существует. Namespace живёт в settings-плане как Config плагина (все поля `.volatile()`), и без чьей-то карточки он не рисуется нигде.

Поэтому **(A) как написано неприемлемо** и заменяется на **A′**: поля провайдера переносятся в собственный пакет карточек форка, который регистрируется в слот `plugins.row.config` (ключ `<имя пакета бандла>#<row id>`, rc.2 `config-ledger.ts:35`), а не в `plugins.item`.

Механика проверена на апстримном прецеденте `experimental/client-ui-forge`: `mount.ts:414` регистрирует `plugins.row.config` с `key = '@deepseek-ai/dsh-experimental-forge-bundle#worktree'`, где `worktree` — id строки из `forge-bundle/cordis.patch.yml`. Строки берутся именно из `insert`-записей патча бандла (`boot/plugin-manager/src/index.ts:1199`), поэтому наши ключи получаются сразу:

```
@deepseek-ai/dsh-web-search-profile#web-search-brave
@deepseek-ai/dsh-web-search-profile#web-search-tavily
```

Такая карточка даёт **Configure** на строке провайдера внутри страницы бандла `web-search-profile` — ровно там, куда указывает апстримный `pluginProviderHint` («в настройках самого плагина»). Альтернатива — остаться в `plugins.item` (как сейчас, и как делает наш `ui-settings-threads`): тогда карточки лежат в «Built-in plugin settings» рядом с апстримной. Оба варианта не требуют ни одной апстримной правки; `plugins.row.config` точнее по смыслу, `plugins.item` — ближе к текущему виду. Выбор оставлен задаче порта.

**Приёмка §5:** в живом профиле на странице Plugins → бандл `web-search-profile` → строка `web-search-tavily` → **Configure** открывает карточку с полем ключа; ввод и Save дают `refs: TAVILY_API_KEY` в `~/.dsh/.credentials.yaml`; `Web search provider` в апстримной карточке показывает `tavily` выбранным.

## 6. Текст комментария для `web-search-profile/cordis.patch.yml`

Правится только блок `- id: web` (остальной файл корректен: `web-fetch-http` там уже не переопределяется). Готово к вставке:

```yaml
- id: web
  config:
    # Keyless by default: the DeepSeek search routes need a credential that a
    # self-hosted deployment usually does not have, and the selector pins
    # whatever is named here — a configured id has no fallback. Point this at
    # `brave` or `tavily` once that provider's key is configured, or at
    # `deepseek-search-api` (the Search API, the shipped default of
    # `@deepseek-ai/dsh-base`) or `deepseek-official` (legacy Messages search)
    # with a DeepSeek credential. The ids `exa` and `perplexity` are gone:
    # their packages were removed in dsh-v0.2.2-rc.2.
    searchProvider: duckduckgo
    fetchProvider: http
```

Причины правки: дефолт `bundle/base` стал `deepseek-search-api` (rc.2 `bundle/base/cordis.patch.yml:487`), пакеты `web/web-search-exa` и `web/web-search-perplexity` удалены, а `deepseek-official` в rc.2 — это именно legacy-Messages-маршрут (`PROVIDER_IDS.legacySearch`, `web/web/README.md` раздел «Provider selection»).

## 7. Чего в этом дереве проверить нельзя

- **Живой вид страницы rc.2** — ни одного прогона: мерж не сделан, `pnpm install`/`build` запрещены. Что `brave`/`tavily` действительно появляются в меню — вывод из `options()` + `listProviders()` + README, а не наблюдение.
- **`plugins.row.config` с ключами `web-search-profile#…`** — механика выведена из прецедента `client-ui-forge` и `declaredRows()`; что `plugin-manager` увидит именно наши строки (они объявлены через `- insert:` в нашем патче — условие выполняется) и что **Configure** появится, не наблюдалось.
- **Что новый пакет карточек собирается и грузится** — `tsdown`, `dsh.client`-манифест, `verify-client-packages`, `verify-plugin-entry-exports` (новый гейт окна, [upstream-0.2.2-rc.2.md §3](upstream-0.2.2-rc.2.md)) не прогонялись.
- **Запись ключа через `remote.credentials.set` после переноса** — не проверялась; сегодня `refs:` в `~/.dsh/.credentials.yaml` пуст, то есть этот путь в живом профиле не использовался ни разу, и регресс по нему был бы незаметен до первой попытки.
- **`title`/`description` наших провайдеров.** rc.2 расширил `WebSearchProvider` полями `title?`/`description?` (`web/web/src/types.ts:123`, 129), а `BraveSearchProvider`/`TavilySearchProvider`/`DuckDuckGoSearchProvider` объявляют только `readonly id`. Компилируется (поля опциональные), но в меню они будут показаны по id (`brave`, `tavily`, `duckduckgo`) и без описания. Объявить их — отдельная мелкая задача порта, она не проверялась.
- **Снапшоты.** Изменится ли что-то в `snapshots/session/web-search-endpoint-guidance` (rc.2 его правит, authored) из-за удаления карточки — не проверялось; карточка клиентская, в модельный вывод не входит, но утверждение не подтверждено прогоном.
- **Полнота `grep` по консументам `WEB_SEARCH_PROVIDER_IDS`** — искалось по `packages apps scripts docs .fork`; сгенерированные `lib/`, `website/` и каталоги вне дерева не просматривались.
