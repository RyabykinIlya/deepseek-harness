# Гейт `verify-plugin-entry-exports`: подготовка форк-пакетов (rc.2)

Замер и классификация сделаны 2026-11-12 в worktree Thread'а на ветке `dsh/thread-385e3a9e-f41d-4108-aaaa-b67c7f2ac7e9`, до мержа, чтением `git show dsh-v0.2.2-rc.2:...`. Сам гейт в этом дереве не прогоняется: он появляется только в rc.2 и строит `TypeScriptProject` по агрегатам `tsconfig.host.json`/`tsconfig.client.json` собранного дерева. Всё ниже — статический разбор исходников по правилам гейта, а не его запуск.

Гейт (`scripts/verify-plugin-entry-exports.ts`, id `plugin-entry-exports` в `hygiene`) проверяет каждый `packages/*/*/src/index.ts`: function-плагин (есть runtime-экспорт `apply`) обязан экспортировать только `name`, `inject`, `Config`, `apply`; service-плагин (default — конструируемый неабстрактный класс) — только default и другие имена того же класса; оба могут добавлять классы, чьи конструкторы строят наследников Cordis `Service` или корневого `Error`. Всё остальное — нарушение. `export *` приносит все runtime-имена цели; type-only экспорты не считаются; цель, которая не резолвится, репортится под своим именем или как `*`. Устоявшийся долг — `scripts/plugin-entry-existing-exports.ts`: строка, добавленная после введения гейта, — исключение, требующее подтверждения владельца домена ([заголовок файла](../../scripts/plugin-entry-existing-exports.ts) rc.2). Для форк-онли пакетов владелец — форк.

Базовый список rc.2 не содержит ни одного форк-пакета — сразу после мержа гейт падает.

## 1. Классификация всех 18 форк-пакетов

| Пакет (`packages/…`) | npm-имя | Тип entry | Нарушения | Решение |
|---|---|---|---|---|
| `experimental/threads` | `@deepseek-ai/dsh-experimental-threads` | service (`export default ThreadsService`, `extends TypertRemoteService` → `Service`) | 8: `ThreadId`, `applyThreadsEvent`, `emptyThreadsState`, `isThreadEvent`, `threadsProjectionDefinition`, `threadsProjectionView`, `threadNote`, `threadStopReason` | debt: `ThreadId`; остальные 7 удалить из entry |
| `experimental/threads-preset` | `@deepseek-ai/dsh-experimental-threads-preset` | service (`export default class ThreadsPreset`, без `extends`) | 22 | debt: все 22 |
| `experimental/tool-threads` | `@deepseek-ai/dsh-experimental-threads-tool` | function (`name`/`inject`/`Config`/`apply`) | 0 (единственный лишний экспорт — type-only блок) | ничего |
| `experimental/threads-profile` | `@deepseek-ai/dsh-experimental-threads-profile` | не плагин (`export {}`) | — | не проверяется |
| `experimental/model-routing` | `@deepseek-ai/dsh-experimental-model-routing` | service (`default ModelRoutingService` `extends TypertRemoteService`) | 48 | debt: все 48 |
| `experimental/model-routing-profile` | `@deepseek-ai/dsh-experimental-model-routing-profile` | не плагин (`export {}`) | — | не проверяется |
| `experimental/project-memory` | `@deepseek-ai/dsh-experimental-project-memory` | service (`default ProjectMemoryService`) | 1: `projectMemoryDomain` | удалить реэкспорт (`ProjectMemoryError` проходит как наследник `Error`) |
| `experimental/client-ui-threads` | `@deepseek-ai/dsh-experimental-client-ui-threads` | function (только `apply`) | 0 | ничего |
| `experimental/client-ui-model-routing` | `@deepseek-ai/dsh-experimental-client-ui-model-routing` | function (только `apply`) | 0 | ничего |
| `experimental/client-ui-project-memory` | `@deepseek-ai/dsh-experimental-client-ui-project-memory` | function (только `apply`) | 0 | ничего |
| `subagent/subagent-thread-worktree` | `@deepseek-ai/dsh-subagent-thread-worktree` | function | 1: `ThreadWorktreeProvider` | debt: 1 |
| `subagent/worktree-manager` | `@deepseek-ai/dsh-worktree-manager` | service (`default WorktreeService` `extends Service`) | 11 | debt: все 11 |
| `web/web-search-brave` | `@deepseek-ai/dsh-web-search-brave` | function | 11 | debt: все 11 |
| `web/web-search-duckduckgo` | `@deepseek-ai/dsh-web-search-duckduckgo` | function | 6 | debt: все 6 |
| `web/web-search-tavily` | `@deepseek-ai/dsh-web-search-tavily` | function | 12 | debt: все 12 |
| `web/web-search-profile` | `@deepseek-ai/dsh-web-search-profile` | не плагин (`export {}`) | — | не проверяется |
| `llm/llm-fallback` | `@deepseek-ai/dsh-llm-fallback` | function (реэкспорт четвёрки из `./index-plugin.ts`) | 2: `FallbackChainId`, `resolveFallbackConfig` | удалить оба реэкспорта |
| `client/ui-settings-threads` | `@deepseek-ai/dsh-client-ui-settings-threads` | function (только `apply`) | 0 | ничего |

Итог: **10 пакетов падают**, 122 нарушенных runtime-экспорта; 112 остаются как debt (8 строк списка), 10 удаляются из entry. Три профиля-бандла гейт не проверяет по своим правилам («Other entries are not checked: libraries, a default export that is not a class…»).

## 2. Откуда нарушения и кто их потребляет

Проверка потребителей — `grep` по `packages/`, `apps/`, `.local-plugins/`; `.local-plugins/` не ссылается ни на один форк-пакет. «Потребитель» ниже = статический импорт значения из entry чужого пакета; импорт из `../src/…` внутри своего пакета правилом разрешён и потребителем не считается.

- **threads** — `ThreadId` (brand-функция + тип, `src/types.ts`): потребители — тесты трёх соседних пакетов (`tool-threads/tests/{threads-tools,library,tier}.spec.ts`, `threads-preset/tests/{tier-preset,project-preset}.spec.ts`, `threads-profile/tests/{profile,real-composition}.spec.ts`, 7 файлов). Продакшен-потребителей нет. Остальные 7 (`applyThreadsEvent`, `emptyThreadsState`, `isThreadEvent`, `threadsProjectionDefinition`, `threadsProjectionView`, `threadNote`, `threadStopReason`) не импортирует нигде: свои тесты берут их из `../src/projection.ts`, `../src/lifecycle.ts`, кроме `tests/lifecycle.spec.ts:27` (`threadNote` из entry). Аналог `SessionId` из `dsh-session`, который апстрим сам держит в debt-списке, — прецедент для brand-функции на entry service-плагина.
- **threads-preset** — 22 имени: 11 из `project-preset.ts` (id строк, `coordinatorPreset`/`workerPreset`), 7 из `threads-contract.ts`, 4 своих (`Config`, `threadAgentOptions`, `threadAgentOptionsOf`, `readBaseRows`). Чужие потребители — только `threads-profile/tests/profile.spec.ts:25` (`THREADS_CONTEXT_NAME`, `THREAD_WORKER_CONTEXT_NAME`); `real-composition.spec.ts` берёт namespace (`import * as`) для строки Loader'а. Форма повторяет `@deepseek-ai/dsh-agent-preset-registry` апстрима, у которого в debt `agentPresetProjectionDefinition`, `auditRows`, `entryListProblem`, `leakedServices`.
- **model-routing** — 48 имён (`export *` из `types.ts` пуст, все его экспорты type-only; считаются значения из `config/family/quantization/select/diagnostics/projection/effort/boundary/replay/judge/adapter/endpoints-cache/key-info/credentials/endpoint` + `service.ts`). Чужие потребители — `model-routing-profile/tests/profile.spec.ts:18` (`Config`, `readSettings`, `validateSettings`); `tool-threads/src/tier.ts` и `tool-threads/tests/tier.spec.ts` берут только типы. Форма повторяет `@deepseek-ai/dsh-llm` апстрима (в debt ~70 имён, включая `LlmAdapter`, `LLM_FAILURE_CODES`). `TiersAdapter` не проходит как класс: наследует абстрактный `LlmAdapter` из `dsh-llm`, не `Service`/`Error`.
- **project-memory** — `projectMemoryDomain` (объект `defineDomain`, не класс): потребитель только свой `tests/defaults.spec.ts:6`.
- **subagent-thread-worktree** — `ThreadWorktreeProvider` объявлен прямо в `src/index.ts:101` (`implements SubagentProvider` — интерфейс, не базовый класс); потребитель только свой тест.
- **worktree-manager** — 11: три из `export * from './states.ts'` (`TERMINAL_WORKTREE_STATES`, `ACTIVE_WORKTREE_STATES`, `isWorktreeBasePolicy`), два из `git.ts` (`resolveRepoTopLevel`, `runGit`), пять из `registry.ts` (`WorktreeRegistry`, `REGISTRY_FILE_NAME`, `REGISTRY_LOCK_NAME`, `isLegalTransition`, `isWorktreeState`), свой `threadSlug`; `export * from './types.ts'` пуст (только типы), `WorktreeError` проходит (наследник `HarnessError` → `Error`). Продакшен-потребитель: `subagent-thread-worktree/src/index.ts:42` импортирует `resolveRepoTopLevel`, `threadSlug`, `WorktreeError`. Остальные девять берут только свои тесты из `../src/index.ts` (5 spec-файлов).
- **web-search-brave / duckduckgo / tavily** — классы провайдеров (`implements WebSearchProvider`, не наследование) и константы: во всех трёх пакетах внешних потребителей нет вообще; формы зеркалят `@deepseek-ai/dsh-web-search-deepseek` апстрима, у которого в debt 8 имён, включая `DeepSeekSearchProvider` и `WEB_SEARCH_DEEPSEEK_SETTINGS_NAMESPACE`.

## 3. Готовый блок для `scripts/plugin-entry-existing-exports.ts`

8 строк, алфавитные позиции по npm-имени, имена внутри строки — в байтовом порядке существующих записей (CAPS, затем `Capitalized`, затем `lowercase`). Владелец домена — форк: пакеты форк-онли, апстрим их не увидит; подтверждение исключения — это решение самого форка, причина — «entry сложились до введения гейта, чистка отложена до отдельной задачи» (см. пометки о кандидатах на чистку).

```ts
  '@deepseek-ai/dsh-experimental-model-routing': [
    'Config', 'DEFAULT_TRUSTED_UNKNOWN_PROVIDERS', 'DecisionResponseSchema', 'DiagnosticsFile', 'EFFORT_ORDER',
    'EndpointsCache', 'FamilyCache', 'KeyInfo', 'MODEL_ROUTING_NO_ENDPOINT_CODE', 'MODEL_ROUTING_UNAVAILABLE_CODE',
    'QUANTIZATIONS', 'QUANTIZATION_RANK', 'TiersAdapter', 'applyModelRoutingEvent', 'askJudge', 'baseSlugOf',
    'blendedPrice', 'boundaryOf', 'candidateOf', 'candidatesOf', 'cheapestRejectedOf', 'defaultMix',
    'diagnosticsLine', 'emptyModelRoutingState', 'judgeQuestions', 'judgeState', 'mapEffort', 'mixFromUsage',
    'modelRoutingProjectionDefinition', 'modelRoutingView', 'policyFor', 'quantizationRank',
    'quantizationsAtOrAbove', 'rankEndpoints', 'rankWithRelaxation', 'readRoutedReplay', 'readSettings',
    'rejectionOf', 'resolveApiKeyRef', 'resolveKey', 'resolveModelFamily', 'routingDirectOf', 'routingEndpointOf',
    'routingSourceOf', 'tierFromVerdict', 'unwrapHistory', 'validateSettings', 'wrapReplay',
  ],
```

позиция: между `@deepseek-ai/dsh-experimental-inspector` и `@deepseek-ai/dsh-experimental-ptc-runtime-python`.

```ts
  '@deepseek-ai/dsh-experimental-threads': ['ThreadId'],
  '@deepseek-ai/dsh-experimental-threads-preset': [
    'COORDINATOR_REPLACED_ROW_IDS', 'PROJECT_PRESET_ID', 'PROJECT_PRESET_ROW_NAMES', 'PROJECT_THREAD_PRESET_ID',
    'THREADS_CONTEXT_NAME', 'THREADS_CONTEXT_ORDER', 'THREADS_CONTRACT_CONTEXT', 'THREAD_WORKER_CONTEXT_NAME',
    'THREAD_WORKER_CONTRACT_CONTEXT', 'THREAD_CONTRACT_ROW_ID', 'THREAD_CONTROL_ROW_ID', 'THREAD_DELEGATION_ROW_ID',
    'THREAD_PROVIDER', 'THREAD_STATUS_ROW_ID', 'Config', 'coordinatorContract', 'coordinatorPreset', 'readBaseRows',
    'threadAgentOptions', 'threadAgentOptionsOf', 'workerContract', 'workerPreset',
  ],
```

позиция: между `@deepseek-ai/dsh-experimental-ptc-runtime-python` и `@deepseek-ai/dsh-experimental-worktree`.

```ts
  '@deepseek-ai/dsh-subagent-thread-worktree': ['ThreadWorktreeProvider'],
```

позиция: между `@deepseek-ai/dsh-subagent` и `@deepseek-ai/dsh-system-prompt`.

```ts
  '@deepseek-ai/dsh-web-search-brave': [
    'BRAVE_DEFAULT_BASE_URL', 'BRAVE_DEFAULT_MAX_RESULTS', 'BRAVE_DEFAULT_TIMEOUT_MS', 'BRAVE_MAX_COUNT',
    'BRAVE_PROVIDER_ID', 'BraveSearchProvider', 'WEB_SEARCH_BRAVE_SETTINGS_NAMESPACE', 'apiErrorMessage',
    'mapBraveResponse', 'mapBraveResult', 'searchEndpoint',
  ],
  '@deepseek-ai/dsh-web-search-duckduckgo': [
    'DUCKDUCKGO_DEFAULT_ENDPOINT', 'DUCKDUCKGO_DEFAULT_MAX_RESPONSE_BYTES', 'DUCKDUCKGO_DEFAULT_TIMEOUT_MS',
    'DUCKDUCKGO_DEFAULT_USER_AGENT', 'DUCKDUCKGO_PROVIDER_ID', 'DuckDuckGoSearchProvider',
  ],
  '@deepseek-ai/dsh-web-search-tavily': [
    'TAVILY_DEFAULT_ENDPOINT', 'TAVILY_DEFAULT_MAX_CONTENT_CHARS', 'TAVILY_DEFAULT_MAX_RESULTS',
    'TAVILY_DEFAULT_TIMEOUT_MS', 'TAVILY_PROVIDER_ID', 'TAVILY_SETTINGS_NAMESPACE', 'TavilySearchProvider',
    'WEB_SEARCH_TAVILY_SETTINGS_NAMESPACE', 'boundContent', 'mapTavilyResponse', 'mapTavilyResult',
    'tavilyErrorDetail',
  ],
```

позиция: единым блоком строка `brave` встаёт между `@deepseek-ai/dsh-web-fetch-http` и `@deepseek-ai/dsh-web-search-deepseek`, а `duckduckgo` и `tavily` — между существующей строкой `@deepseek-ai/dsh-web-search-deepseek` и `@deepseek-ai/dsh-webhook`; итоговый порядок `brave` < `deepseek` < `duckduckgo` < `tavily` < `webhook`.

```ts
  '@deepseek-ai/dsh-worktree-manager': [
    'ACTIVE_WORKTREE_STATES', 'REGISTRY_FILE_NAME', 'REGISTRY_LOCK_NAME', 'TERMINAL_WORKTREE_STATES',
    'WorktreeRegistry', 'isLegalTransition', 'isWorktreeBasePolicy', 'isWorktreeState', 'resolveRepoTopLevel',
    'runGit', 'threadSlug',
  ],
```

позиция: после `@deepseek-ai/dsh-workspace` — конец объекта.

Строка списка обязана перечислять ровно то, что гейт репортит: имя, которого entry больше не экспортирует, гейт отвергает («lists X, which … no longer exports»), пропущенное имя — тоже. Поэтому debt-блок и удаления из §4 едут одним изменением после мержа.

## 4. Удаления из entry (не debt)

- `experimental/threads/src/index.ts` — снять блоки 37–46 (реэкспорты `applyThreadsEvent`/`emptyThreadsState`/`isThreadEvent`/`threadsProjectionDefinition`/`threadsProjectionView`, `threadNote`, `threadStopReason`); `export type * from './types.ts'`, `export { ThreadId }` и type-only блок остаются. Правка импорта: `tests/lifecycle.spec.ts:27` — `threadNote` из `../src/note.ts`.
- `experimental/project-memory/src/index.ts:31` — снять `export { projectMemoryDomain }`; `tests/defaults.spec.ts:6` → `from '../src/storage.ts'`.
- `llm/llm-fallback/src/index.ts` — снять строки 22–25 (`FallbackChainId`, `resolveFallbackConfig`); собственные тесты уже импортируют из `../src/brand.ts` и `../src/config.ts`, правок не требует.

Переносов в новые сабpath-модули план не требует: у каждого оставленного в debt имени либо есть реальный потребитель (threads `ThreadId`, worktree-manager `resolveRepoTopLevel`/`threadSlug`), либо перенос обошёлся бы дороже строки списка без выигрыша в контракте. Альтернатива «перенести `ThreadId` в уже существующий сабpath `./types`» отклонена: 7 файлов-потребителей править, плюс рукописная строка в `tsconfig.base.json` (место будущего мерж-конфликта), при том что апстрим держит `SessionId` в debt, а не в сабpath.

## 5. Где debt скрывает проблему, а не фиксирует факт

- `subagent-thread-worktree`: `ThreadWorktreeProvider` живёт в `src/index.ts` только ради собственного теста — настоящий рефакторинг (вынести класс в `src/provider.ts`, тест перевести на относительный импорт) отложен debt-строкой. Кандидат на чистку №1.
- `model-routing` и `threads-preset`: из 48 и 22 имён потребителя имеют 3 и 2 соответственно; остальное — реэкспорт внутренностей, которые апстрим в аналогичных пакетах тоже держит в debt. Чистка сводится к снятию лишних реэкспортов и строк одновременно (правило «removing an export also removes its line»), не к переносу API.
- `worktree-manager`: 9 из 11 имён не нужны никому вне пакета, но их берут 5 своих spec-файлов из entry — обнуление требует ~7 правок; debt честнее и дешевле перед imminent-мержем.

## 6. Соседние гейты `hygiene`: что изменилось в окне

`git diff dsh-v0.2.2-rc.1 dsh-v0.2.2-rc.2 -- scripts/verify-*.ts`:

| Гейт | Изменение | Риск для форка |
|---|---|---|
| `plugin-entry-exports` | новый (см. выше) | 10 пакетов, закрыто этим планом |
| `plugin-record-callers` | в `isAdmittedCaller` добавлен `scripts/plugin-entry-existing-exports.ts` (сам файл списка вызывает `appendPluginRecord` в комментарии-заголовке) | нет: единственные форк-пакеты с `appendPluginRecord` лежат в `packages/experimental/` (уже исключены префиксом); вне experimental ни один форк-пакет функцию не упоминает |
| `client-packages`, `optional-dependency-imports`, `locale-metadata`, `no-bare-dispatcher`, `client-ui-i18n`, `client-route-resolution`, `no-top-level-await` | дифф пуст — правила не менялись | нет |

Вне `hygiene` в этом же окне менялись `verify-application-entrypoints`, `verify-package-readme-*`, `verify-type-equiv`, `verify-upgrade-guides` (агрегаты doc-sync/type-equivalence) — по условиям задачи не разбирались, форк-пакеты могут найтись там отдельно.

## 7. Что не проверено в этом дереве

1. Сам прогон гейта — невозможен до мержа: нужен rc.2-скрипт и `TypeScriptProject` по face-агрегатам; классификация §1 выведена из исходников по правилам шапки гейта.
2. Разрешение value/type через связанный `Program` (`verbatimModuleSyntax` выключен): здесь оно выведено из синтаксиса экспортов. Ошибка классификации одного имени проявится первой строкой diagnostics гейта и закрывается добавлением/снятием имени в списке.
3. Форматирование вставленного блока (lint/oxlint/prettier) — tree rc.1 инструментария rc.2 не содержит.
4. Поведение `unloadedEntries` для форк-пакетов на client-face (host-классифицирует первым; падение возможно только если entry не компилирует ни один face — у форк-пакетов host-агрегат заведомо их компилирует).
5. Гейты вне `hygiene`, меняющиеся в окне (§6, последняя строка) — отдельный заход.
