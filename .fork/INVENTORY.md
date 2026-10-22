# Инвентарь локального слоя

Перемерено 2026-10-10. **Апстрим подтянут:** ветка стоит на `origin/master` текущего релиза (`0.2.1-alpha.2`), мерж сделан 2026-10-10, ожидающего апстрима нет — `git rev-list --count HEAD..origin/master` равен нулю.

> **Числа ниже устарели — перемерить перед следующим решением.** Замер 2026-10-22 (без `git fetch`, из этого чекаута) показывает **29** локальных пакетов против записанных 17, а список пакетов в разделе ниже называет 17. Причина расхождения не в ошибке записи, а в том, что чекаут с 2026-10-10 ушёл вперёд (появились `plugin-market*`, `llm-fallback`, `web-deepseek-api`, `harness-dev-context`, `cua*`, `ui-secret-mask` и прочее), а пин в этом файле — апстримный релиз `0.2.1-alpha.2`, от которого считался прежний замер. Пока `git fetch origin` не сделан, ни поверхность, ни число новых пакетов не перемеряемы достоверно; руками числа не правлю.
>
> Важное для `origin` в этом чекауте: remote `origin` — **собственный GitHub форка** (`RyabykinIlya/deepseek-harness`), апстримного remote'а нет вовсе. Поэтому `origin/master` здесь означает мастер форка, и `git diff origin/master HEAD` всегда пуст; сравнивать с апстримом можно только по явному значению пина из конца файла.

Отсюда два следствия, которые надо держать в голове при чтении:

- Цифра «сколько реально встретится в конфликте» сейчас **не измерима**: она считается как пересечение нашей поверхности с тем, что апстрим изменил ПОСЛЕ точки расхождения, а точка расхождения и есть `origin/master`. Число появится снова после следующего `git fetch origin`, когда апстрим уедет вперёд.
- Всё, что измерено ниже, — это **наша поверхность**: сколько апстримных файлов ветка трогает. Она и есть то, что отчуждение должно уменьшать.

Хеши коммитов здесь намеренно не записаны: они меняются при каждом ребейзе и мерж-форварде, а эта папка существует ровно для того, чтобы такие операции были рутиной. Коммиты называются по теме, актуальные хеши берутся командами из конца файла.

## Локальные коммиты

**74 коммита** поверх точки расхождения, **602 файла, +80763 / −818**. Из них 440 файлов добавлено, **162 изменено**.

Прежние записи этого файла считали четыре коммита и 444 файла (до мержа апстрима), затем 30 коммитов и 157 изменённых файлов (замер 2026-10-07), затем 45 коммитов и 608 файлов (замер 2026-10-09), затем 53 коммита и 181 изменённый файл (замер 2026-10-10 после мержа `0.2.1-alpha.2`).

Замер **2026-10-11** сделан после первой волны сокращения поверхности: **181 → 162**. Что дало убыль:

| Работа | Файлов | Что именно |
|---|---|---|
| T1, `repository` → опциональная capability | −15 | четыре апстримных провайдера и одиннадцать их тестов перестали быть нашими; `packages/bundle/headless/tests/headless.spec.ts` вернулся к апстримным байтам |
| T2, строки монтажа — в свои бандлы | −5 | четыре файла `packages/bundle/{base,web-app}` и `apps/cli/composition.md` стали апстрим-идентичными |
| T10, `piAiDispatch` остался литералом | 0 | манифест `llm-pi-ai/package.json` не стал нашим файлом |
| Baseline `no-unknown-casts` | +1 | `--prune` приводит инвентарь к нашему дереву |

Итог: **`packages/bundle/` теперь побайтово апстримный целиком.** Это самый горячий апстримный каталог базы, и он больше не наш.

Убыль посчитана как «сколько апстримных файлов ветка перестала трогать». Ноль в таблице у T10 — не отсутствие работы: генераторы перестали перечислять наши пакеты, но манифест `llm-pi-ai` намеренно оставлен апстримным, поэтому поверхность не выросла и не упала.

Первый по времени коммит — архив незакоммиченной работы на 304 файла. **Оставляем как есть:** откатывать оттуда ничего не нужно, поэтому разложение истории по фичам не планируется и в приоритетах не стоит.

## Локальные плагины и рукописный каталог — форк-онли, замер не меняют

Замерено 2026-10-22 против пина апстрима `0.2.1-alpha.2` — переменная `UPSTREAM` из конца файла:

```sh
for p in .fork .local-plugins PLUGINS.md; do
  git cat-file -e $UPSTREAM:$p 2>/dev/null && echo "$p: upstream" || echo "$p: fork-only"
done
```

Все три пути в апстриме **отсутствуют целиком**. Практические следствия:

- **`.local-plugins/` конфликтов не даёт никогда** — это новые файлы. Новый плагин `@local/tg-notify` (добавлен 2026-10-22: `package.json`, `index.js`, `cordis.patch.yml`, `icon.svg`, `README.md`, плюс несобираемый `.verify.mjs`) относится сюда же, поверхность не трогает.
- **`PLUGINS.md` — рукописный каталог форка**, а не апстримный документ (создан коммитом «add local plugins and the fork plugin catalog» 2026-10-05). Строка о `@local/tg-notify` в нём тоже бесплатна. Это важно потому, что раньше он ошибочно читался как апстримный файл: `git cat-file -e origin/master:PLUGINS.md` здесь отвечает «есть», но `origin` в этом чекауте — собственный GitHub форка, а не апстрим.

## Новые пакеты — 17, конфликтов не дают

| Фича | Пакеты |
|---|---|
| Model routing | `experimental/model-routing`, `experimental/client-ui-model-routing`, `experimental/model-routing-profile` |
| Threads / Projects | `experimental/threads`, `threads-preset`, `threads-profile`, `tool-threads`, `client-ui-threads`, `project-memory`, `client-ui-project-memory`, `subagent/subagent-thread-worktree`, `subagent/worktree-manager`, `client/ui-settings-threads` |
| Web search | `web/web-search-brave`, `web/web-search-duckduckgo`, `web/web-search-tavily`, `web/web-search-profile` |

Список перемерен командой из конца файла: ровно эти 17 каталогов отсутствуют в `origin/master`. `web-search-profile` добавлен 2026-10-11 (T2) — свой бандл вместо строк в апстримных. `experimental/schedule-bundle` из прежнего замера в списке больше не значится — пакет есть и в апстриме, и у нас, то есть это не наш новый пакет. Прежняя запись о `runtime-diagnostics/invariants` тоже снята: такого каталога в дереве нет.

**Каталог `packages/experimental/` у нас общий с апстримом, и это главный источник путаницы.** Пакет, лежащий там, не апстримный: `project-memory` и `client-ui-project-memory` отсутствуют в `origin/master` целиком. Проверять принадлежность нужно командой ниже, а не названием каталога.

**Свой бандл — не только монтаж строк.** Вынос строки из апстримного бандла делает её пакет недостижимым ни для одного шипнутого профиля, и `verify-product-use` требует записи в `scripts/product-package-policy.ts` (категория `optional`). Так сделано для `subagent-thread-worktree`, `worktree-manager`, трёх `web-search-*`, `web-search-profile` и `client-ui-settings-threads`. Любая задача, уносящая строку из бандла, платит эту цену.


Новый пакет добавил три апстримных точки регистрации — `tsconfig.base.json`, `tsconfig.client.json`, `scripts/verify-package-readme-model-experience.ts` (категория B, по одной строке, цена нулевая) — и потребовал перегенерации четырёх артефактов, из которых `slot-catalog.ts` и `api-catalog.ts` стоят в списке файлов, где нужен глаз. Плюс строка `ui-project-memory` в `experimental/threads-profile/cordis.patch.yml`, но это наш файл: конфликтовать не с чем.

## Поверхность конфликтов

**162 изменённых апстримных файла** — это сколько файлов трогает ветка. История замера: 132 (2026-10-04), 157 (2026-10-07), 188 (2026-10-09), 181 (2026-10-10), **162 (2026-10-11)**. Число, которое надо уменьшать отчуждением.

Рост с 132 до 188 дали четыре работы: прямые источники и `userAgentOverride` в `llm-pi-ai`, ротация ключей и код `CLIENT_GATE` в `llm/llm` и `llm-pi-ai`, фича «Restore продолжает диалог в форке» в `client/ui-chat` и выбор репозитория Thread'ом в `subagent/*`, `workflow/workflow-ptc` и `sdk/server` (тест-фикстуры и каталоги того же изменения). Уменьшение 188 → 181 дал мерж `0.2.1-alpha.2`: апстрим свёл continuable-панель в один `manager.ts`, и наши правки теперь живут в нём, а не в двух упразднённых файлах `continuation.ts`/`continuation-activation.ts`; встречный рост дали порт `tool-subagent` (`repository`, `backgroundMode`, `allowedModels`) и `llm-pi-ai` поверх переписанного адаптера.

Уменьшение 181 → 162 дала первая волна отчуждения (T1, T2, T10, baseline) — разбор в разделе «Локальные коммиты» выше.

Мерж `0.2.1-alpha.2` стоил 66 конфликтных файлов (предсказание `git merge-tree`), 52 после снятия генерируемого шагом 1; структурные — ядро `subagent`, `tool-subagent`, `llm-pi-ai/src/adapter.ts`, `client/ui-chat` — разобраны вручную с переносом правок, а не выбором одной стороны.

Разбор по цене (замер 2026-10-11):

| Категория | Файлов | Что это |
|---|---|---|
| **A. Перегенерируемое** | 14 | 8 сгенерированных `docs/*`, 4 `.i18n.yaml` под `docs/`, `pnpm-lock.yaml`, `THIRD_PARTY_NOTICES.md`, `no-unknown-casts.baseline.json`, `known-event-types.ts`, `tool-cordis/src/api-catalog.ts` |
| **B. Точки регистрации** | 13 | `tsconfig.*.json` (3), `lefthook.yml`, `scripts/*` (7), и прочие скрипты |
| **C. Правки апстримных пакетов** | 122 | настоящая цена мержа, таблица ниже |
| Документация подсистем и заметки | 10 | `docs/subsystems/*` (8) и два перевода заметки в `.agents/notes/implemented/feature/` |
| Снапшоты | 3 | `snapshots/session/headless.snapshot.ts`, два в `web-search-endpoint-guidance` |

#### A. Перегенерируемое — 14 файлов, цена нулевая

Сгенерированные `docs/capability-seams.md`, `docs/event-producer-consumer.md` и `.zh.md`, `docs/persistence-catalog.md` и `.zh.md` с `.i18n.yaml`, `docs/persistence-schema.json`, `docs/tool-catalog.md`, `pnpm-lock.yaml`, `THIRD_PARTY_NOTICES.md`, `scripts/no-unknown-casts.baseline.json`, `packages/core/session/src/known-event-types.ts`, `packages/extensions/tool-cordis/src/api-catalog.ts`.

Конфликтуют почти всегда, но содержимое выводится из кода. Правильное обращение — не мержить, а перегенерировать ([MERGE-RUNBOOK.md](MERGE-RUNBOOK.md)).

**`snapshots/` в этот список не входит, хотя раньше входил.** Это была ошибка с риском потери данных: из 212 сценариев корпуса **137 записаны вручную** (`recording: authored`), потому что писались без ключа. `test:snapshot:record` их не восстановит — он требует ключа и живой модели. Ветка правит десять файлов в `snapshots/session/threads-project-worktree` и два в `web-search-endpoint-guidance`, плюс добавляет весь `threads-project-worktree-tiers`; всё это пишется руками и мержится как обычный код.

**Два файла из «A» требуют не просто `git checkout`, а шага 3, и порядок там важен.** `known-event-types.ts` возвращается из наших же объявлений `SessionEventMap` (см. [DECISIONS.md](DECISIONS.md)) — это нормально и ожидаемо. `no-unknown-casts.baseline.json` требует `--prune`, причём **после** того, как сняты все свои приведения: гейт проверяет добавленные раньше устаревших и на добавленных падает, не дойдя до устаревших.

#### B. Точки регистрации — 13 файлов, цена низкая

`tsconfig.base.json`, `tsconfig.host.json`, `tsconfig.client.json`, `pnpm-workspace.yaml`, `scripts/gen-cordis-catalog.ts`, `scripts/gen-doc-graphs.ts`, `scripts/gen-persistence-catalog.ts`, `scripts/gen-tool-catalog.ts`, `scripts/type-equiv.manifest.json`, `scripts/verify-package-readme-model-experience.ts`, `scripts/check-workspace-constraints.ts`, `scripts/product-package-policy.ts`, `lefthook.yml`.

По одной-две строки на пакет. Конфликтуют тривиально — вернуть строку.

Два из них стоят дороже прочих и оба — про **списки наших пакетов, живущие в апстримных скриптах**:

- `scripts/gen-tool-catalog.ts` и `scripts/gen-doc-graphs.ts` больше не перечисляют наши пакеты — вклад читается из поля `dsh.catalog` в манифестах (T10, [DECISIONS.md](DECISIONS.md)). В остатке обоих скриптов нет ни одного имени нашего пакета, кроме литеральной роли `piAiDispatch`.
- `scripts/product-package-policy.ts` растёт на запись за каждый пакет, чью строку мы уносим из апстримного бандла (`verify-product-use` иначе падает с «no product runtime use»).

#### C. Правки апстримных пакетов — 122 файла, цена высокая

Вот это настоящая боль. По фичам (замер 2026-10-11):

| Что | Апстримные пакеты | Файлов |
|---|---|---|
| Model routing, маршрут `claude-proxy`, ключи (`KEY_QUOTA`, `CLIENT_GATE`) | `llm/llm-pi-ai` (13), `llm/llm` (7) | 20 |
| Restore: форк диалога от сообщения | `client/ui-chat` | 15 |
| Threads: continuable subagent, шов `cwd`/`agentPreset`/`handles` | `subagent/subagent` | 14 |
| Threads: `allowedModels`, `repository`, `backgroundMode` | `subagent/tool-subagent` (9) и пять провайдеров `subagent/subagent-*` (5) | 14 |
| Session | `core/session` (7), `session/*` (4) | 11 |
| Web search | `client/ui-settings-web-search` (7), `web/web` (2) | 9 |
| UI воркспейса | `client/ui-workspace` | 8 |
| Multi-repo: тест-фикстуры и каталоги | `workflow/*` (7), `sdk/server` (2) | 8 |
| Web fetch — доверенные адреса для fake-ip прокси | `web/web-fetch-http` | 7 |
| Тест-инфраструктура | `test-support/session-snapshot`, `test-support/client-runtime` | 5 |
| Прочее | `.gitignore`, `client/product-analytics`, `client/ui-workflow-run`, `experimental/tool-ralph`, README групп `experimental`, `subagent` и `web` (5 файлов с i18n) | 11 |

**`bundle/*` из этой таблицы исчез:** после T2 `packages/bundle/` побайтово апстримный целиком.

Строка про `web-fetch-http` — отдельный кастом форка, а не часть web-search: в `trustedProxyAddressRanges` оператор объявляет CIDR-блоки (LAN и fake-ip пул transparent-proxy), адреса внутри которых guard принимает как допустимые назначения. Решение с причинами — [DECISIONS.md](DECISIONS.md), раздел «Web fetch». Конфиг-точка фичи — теперь наш бандл `packages/web/web-search-profile/cordis.patch.yml` (была `bundle/base/cordis.patch.yml` до T2), дефолт `trustedProxyAddressRanges: [198.18.0.0/15]`.

Строка про `ui-chat` — фича «Restore»: форкает сессию префиксом до сообщения и возвращает текст в композер, вместо запрещённого усечения append-only лога. Разобрано 2026-10-11: слот `conversation.chat.node` ключуется по `ChatNodeKind`, и переиспользование ключа `user` заменяет рендерер, поэтому фича может уехать в свой пакет без нового слота. Решение — [DECISIONS.md](DECISIONS.md), раздел «`client/ui-chat`».

Строка про выбор репозитория — работа по [ADR-0001](adr/0001-thread-v-multi-repo-workspace.md): capability `repository` в шве подагентов, а `subagent-thread-worktree` выбирает репозиторий в multi-repo workspace. `workflow/*` и `sdk/server` в списке из-за тест-фикстур и каталогов того же изменения. После T1 поле `repository` стало опциональным, поэтому провайдеры больше не пишут `repository: false`, и часть этих файлов из поверхности ушла (см. «Локальные коммиты»).

## Как перезамерить

```sh
git fetch origin

# Точка расхождения. В основном чекауте это origin/master, но ИЗ WORKTREE Thread'а
# `origin` — локальный клон форка, поэтому origin/master там равен мастеру форка:
# сравнение с самим собой даёт пустой дифф. Для замеров внутри worktree брать
# точку расхождения явным SHA — апстримный релиз 0.2.1-alpha.2:
UPSTREAM=d743267388641bc76f17c45ce8b4c231aed1d32c   # == origin/master основного чекаута
mb=$UPSTREAM

# насколько отстали от апстрима (сейчас 0 — апстрим подтянут)
git rev-list --count $mb..origin/master

# локальные коммиты и объём
git log --oneline $mb..HEAD
git diff --shortstat $mb...HEAD

# новые пакеты (конфликтов не дают)
for d in packages/*/*/; do [ -f "$d/package.json" ] && \
  { git cat-file -e $mb:${d}package.json 2>/dev/null || echo "$d"; }; done

# поверхность: сколько трогаем мы (две точки — сравнение деревьев, не истории)
git diff --name-status $mb HEAD | awk '$1=="M"{print $2}' | sort > /tmp/ours.txt
wc -l < /tmp/ours.txt
cut -d/ -f1-3 /tmp/ours.txt | sort | uniq -c | sort -rn

# поверхность: сколько реально встретится в мерже
# (пока $mb == origin/master, это пересечение пусто по построению)
git diff --name-only $mb..origin/master | sort > /tmp/theirs.txt
comm -12 /tmp/ours.txt /tmp/theirs.txt | tee /tmp/both.txt | wc -l
```

Перезамерять после каждого мержа апстрима и после каждой заметной фичи. Без `git fetch` сравнение идёт со старым апстримом, и число пересечений выходит заниженным — именно это и произошло с прошлым замером.
