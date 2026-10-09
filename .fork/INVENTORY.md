# Инвентарь локального слоя

Перемерено 2026-10-09. **Апстрим подтянут:** ветка стоит на `origin/master` текущего релиза (`0.2.1-alpha.1`), мерж сделан 2026-10-04, ожидающего апстрима нет — `git rev-list --count HEAD..origin/master` равен нулю.

Отсюда два следствия, которые надо держать в голове при чтении:

- Цифра «сколько реально встретится в конфликте» сейчас **не измерима**: она считается как пересечение нашей поверхности с тем, что апстрим изменил ПОСЛЕ точки расхождения, а точка расхождения и есть `origin/master`. Число появится снова после следующего `git fetch origin`, когда апстрим уедет вперёд.
- Всё, что измерено ниже, — это **наша поверхность**: сколько апстримных файлов ветка трогает. Она и есть то, что отчуждение должно уменьшать.

Хеши коммитов здесь намеренно не записаны: они меняются при каждом ребейзе и мерж-форварде, а эта папка существует ровно для того, чтобы такие операции были рутиной. Коммиты называются по теме, актуальные хеши берутся командами из конца файла.

## Локальные коммиты

**45 коммитов** поверх точки расхождения, **608 файлов, +79671 / −786**. Из них 419 файлов добавлено, 188 изменено, один переименован.

Прежние записи этого файла считали четыре коммита и 444 файла (до мержа апстрима), затем 30 коммитов и 157 изменённых файлов (замер 2026-10-07). После того замера к ветке добавились выбор репозитория Thread'ом в multi-repo workspace ([ADR-0001](adr/0001-thread-v-multi-repo-workspace.md)), код `CLIENT_GATE` с ротацией ключей, порог отказов `excludeAfterFailures` с узлом model-switch и слой ADR в `.fork/`.

Первый по времени коммит — архив незакоммиченной работы на 304 файла. **Оставляем как есть:** откатывать оттуда ничего не нужно, поэтому разложение истории по фичам не планируется и в приоритетах не стоит.

## Новые пакеты — 16, конфликтов не дают

| Фича | Пакеты |
|---|---|
| Model routing | `experimental/model-routing`, `experimental/client-ui-model-routing`, `experimental/model-routing-profile` |
| Threads / Projects | `experimental/threads`, `threads-preset`, `threads-profile`, `tool-threads`, `client-ui-threads`, `project-memory`, `client-ui-project-memory`, `subagent/subagent-thread-worktree`, `subagent/worktree-manager`, `client/ui-settings-threads` |
| Web search | `web/web-search-brave`, `web/web-search-duckduckgo`, `web/web-search-tavily` |

Список перемерен командой из конца файла: ровно эти 16 каталогов отсутствуют в `origin/master`. `experimental/schedule-bundle` из прежнего замера в списке больше не значится — пакет есть и в апстриме, и у нас, то есть это не наш новый пакет. Прежняя запись о `runtime-diagnostics/invariants` тоже снята: такого каталога в дереве нет.

**Каталог `packages/experimental/` у нас общий с апстримом, и это главный источник путаницы.** Пакет, лежащий там, не апстримный: `project-memory` и `client-ui-project-memory` отсутствуют в `origin/master` целиком. Проверять принадлежность нужно командой ниже, а не названием каталога.

Новый пакет добавил три апстримных точки регистрации — `tsconfig.base.json`, `tsconfig.client.json`, `scripts/verify-package-readme-model-experience.ts` (категория B, по одной строке, цена нулевая) — и потребовал перегенерации четырёх артефактов, из которых `slot-catalog.ts` и `api-catalog.ts` стоят в списке файлов, где нужен глаз. Плюс строка `ui-project-memory` в `experimental/threads-profile/cordis.patch.yml`, но это наш файл: конфликтовать не с чем.

## Поверхность конфликтов

**188 изменённых апстримных файлов** — это сколько файлов трогает ветка (132 на замере 2026-10-04, 157 на 2026-10-07). Число, которое надо уменьшать отчуждением.

Рост с 132 до 188 дали четыре работы: прямые источники и `userAgentOverride` в `llm-pi-ai`, ротация ключей и код `CLIENT_GATE` в `llm/llm` и `llm-pi-ai`, фича «Restore продолжает диалог в форке» в `client/ui-chat` и выбор репозитория Thread'ом в `subagent/*`, `workflow/workflow-ptc` и `sdk/server` (тест-фикстуры и каталоги того же изменения).

Разбор по цене:

| Категория | Файлов | Что это |
|---|---|---|
| **A. Перегенерируемое** | 33 | каталоги `docs/*`, `.i18n.yaml`, `pnpm-lock.yaml`, `THIRD_PARTY_NOTICES.md`, `scripts/*.baseline.json`, `known-event-types.ts` |
| **B. Точки регистрации** | 12 | `tsconfig.*.json`, `pnpm-workspace.yaml`, `scripts/gen-*.ts`, `lefthook.yml`, `scripts/type-equiv.manifest.json` |
| **C. Правки апстримных пакетов** | 128 | настоящая цена мержа, таблица ниже |
| Документация подсистем и заметки | 10 | `docs/subsystems/*`, `docs/persistence-changes/historical-formats/*`, `.agents/notes/implemented/*` |
| Снапшоты | 3 | `snapshots/session/headless.snapshot.ts`, `snapshots/session/web-search-endpoint-guidance/*` |
| Прочее | 2 | `.gitignore`, `apps/cli/composition.md` |

#### A. Перегенерируемое — 33 файла, цена нулевая

Каталоги `docs/config-catalog`, `tool-catalog`, `persistence-catalog`, `module-graph`, `capability-seams`, `event-producer-consumer`, `persistence-schema.json`, `docs/persistence-changes/historical-formats/README*`, все `.i18n.yaml`, `pnpm-lock.yaml`, `THIRD_PARTY_NOTICES.md`, `scripts/*.baseline.json`, `core/session/src/known-event-types.ts`.

Конфликтуют почти всегда, но содержимое выводится из кода. Правильное обращение — не мержить, а перегенерировать ([MERGE-RUNBOOK.md](MERGE-RUNBOOK.md)).

**`snapshots/` в этот список не входит, хотя раньше входил.** Это была ошибка с риском потери данных: из 212 сценариев корпуса **137 записаны вручную** (`recording: authored`), потому что писались без ключа. `test:snapshot:record` их не восстановит — он требует ключа и живой модели. Ветка правит десять файлов в `snapshots/session/threads-project-worktree` и два в `web-search-endpoint-guidance`, плюс добавляет весь `threads-project-worktree-tiers`; всё это пишется руками и мержится как обычный код.

#### B. Точки регистрации — 12 файлов, цена низкая

`tsconfig.base.json`, `tsconfig.host.json`, `tsconfig.client.json`, `pnpm-workspace.yaml`, `scripts/check-workspace-constraints.ts`, `scripts/gen-cordis-catalog.ts`, `scripts/gen-doc-graphs.ts`, `scripts/gen-persistence-catalog.ts`, `scripts/gen-tool-catalog.ts`, `scripts/type-equiv.manifest.json`, `scripts/verify-package-readme-model-experience.ts`, `lefthook.yml`.

По одной-две строки на пакет. Конфликтуют тривиально — вернуть строку. Исчезают полностью, только если пакет уедет из воркспейса в отдельный репозиторий.

#### C. Правки апстримных пакетов — 128 файлов, цена высокая

Вот это настоящая боль. По фичам:

| Что | Апстримные пакеты | Файлов |
|---|---|---|
| Model routing, маршрут `claude-proxy`, ключи (`KEY_QUOTA`, `CLIENT_GATE`) | `llm/llm-pi-ai` (16), `llm/llm` (4) | 20 |
| Threads: continuable subagent и выбор репозитория | `subagent/subagent` | 17 |
| Restore: форк диалога от сообщения | `client/ui-chat` | 14 |
| Threads: `allowedModels` и параметр `repository` | `subagent/tool-subagent` (6), шесть провайдеров `subagent/subagent-*` (12) | 18 |
| UI воркспейса | `client/ui-workspace` | 8 |
| Web search | `client/ui-settings-web-search` (7), `web/web` (2) | 9 |
| Multi-repo: тест-фикстуры и каталоги | `workflow/workflow-ptc` (5), `workflow/tool-workflow`, `workflow/tool-ralph`, `sdk/server` (2) | 9 |
| Web fetch — доверенные адреса для fake-ip прокси | `web/web-fetch-http` | 6 |
| Session | `core/session` | 5 |
| Тест-инфраструктура | `test-support/session-snapshot`, `test-support/client-runtime` | 5 |
| Bundle-строки | `bundle/base`, `bundle/web-app` | 4 |
| Прочее | `extensions/tool-cordis`, `extensions/cordis-client-runner`, `preset/agent-preset`, `experimental/webworker-runtime`, `subagent/subagent-in-process-driver`, `client/product-analytics`, `client/ui-workflow-run` и README групп `experimental`, `subagent`, `web` | 13 |

Строка про `web-fetch-http` — отдельный кастом форка, а не часть web-search: в `trustedProxyAddressRanges` оператор объявляет CIDR-блоки (LAN и fake-ip пул transparent-proxy), адреса внутри которых guard принимает как допустимые назначения. Решение с причинами — [DECISIONS.md](DECISIONS.md), раздел «Web fetch». Конфиг-точка фичи — `bundle/base/cordis.patch.yml`, дефолт `trustedProxyAddressRanges: [198.18.0.0/15]`; этот файл уже перечислен в категории B.

Строка про `ui-chat` — фича, которой в прежнем замере не было: «Restore» форкает сессию префиксом до сообщения и возвращает текст в композер, вместо запрещённого усечения append-only лога. Её решение — заметка `.agents/notes/implemented/architecture/2026-10-04-restore-conversation-forks-a-prefix.md`.

Строка про выбор репозитория — работа по [ADR-0001](adr/0001-thread-v-multi-repo-workspace.md): capability `repository` в шве подагентов, шесть провайдеров декларируют `repository: false`, а `subagent-thread-worktree` выбирает репозиторий в multi-repo workspace. `workflow/workflow-ptc` и `sdk/server` в списке из-за тест-фикстур и каталогов того же изменения.

## Как перезамерить

```sh
git fetch origin

# насколько отстали от апстрима (сейчас 0 — апстрим подтянут)
mb=$(git merge-base origin/master HEAD)
git rev-list --count $mb..origin/master

# локальные коммиты и объём
git log --oneline $mb..HEAD
git diff --shortstat $mb...HEAD

# новые пакеты (конфликтов не дают)
for d in packages/*/*/; do [ -f "$d/package.json" ] && \
  { git cat-file -e origin/master:${d}package.json 2>/dev/null || echo "$d"; }; done

# поверхность: сколько трогаем мы
git diff --name-status $mb...HEAD | awk '$1=="M"{print $2}' | sort > /tmp/ours.txt
wc -l < /tmp/ours.txt
cut -d/ -f1-3 /tmp/ours.txt | sort | uniq -c | sort -rn

# поверхность: сколько реально встретится в мерже
# (пока $mb == origin/master, это пересечение пусто по построению)
git diff --name-only $mb..origin/master | sort > /tmp/theirs.txt
comm -12 /tmp/ours.txt /tmp/theirs.txt | tee /tmp/both.txt | wc -l
```

Перезамерять после каждого мержа апстрима и после каждой заметной фичи. Без `git fetch` сравнение идёт со старым апстримом, и число пересечений выходит заниженным — именно это и произошло с прошлым замером.
