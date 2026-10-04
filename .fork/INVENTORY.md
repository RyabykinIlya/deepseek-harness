# Инвентарь локального слоя

Перемерено 2026-10-04. **Апстрим ушёл вперёд:** ветка стоит на релизе `0.2.0-rc.2`, а `origin/master` — уже `0.2.1-alpha.1`, это 266 коммитов и 4190 изменённых файлов сверху.

Хеши коммитов здесь намеренно не записаны: они меняются при каждом ребейзе и мерж-форварде, а эта папка существует ровно для того, чтобы такие операции были рутиной. Коммиты называются по теме, актуальные хеши берутся командами из конца файла.

## Локальные коммиты

Четыре коммита поверх точки расхождения:

```
wip: checkpoint of the uncommitted feature work on feat/threads-projects   304 файла, +29880 / −531
feat(threads): Projects — worktree-isolated background Threads             178 файлов, +26453 / −55
feat(subagent): let a continuable provider choose the child's cwd           39 файлов,   +864 / −57
chore(llm-pi-ai): upgrade @earendil-works/pi-ai to 0.99.2                    9 файлов,    +63 / −42
```

Итого: **444 файла, +57191 / −616**.

Первый коммит — архив незакоммиченной работы на 304 файла. **Оставляем как есть:** откатывать из него ничего не нужно, поэтому разложение истории по фичам не планируется и в приоритетах не стоит.

## Новые пакеты — 15, конфликтов не дают

| Фича | Пакеты |
|---|---|
| Model routing | `experimental/model-routing`, `experimental/client-ui-model-routing`, `experimental/model-routing-profile` |
| Threads / Projects | `experimental/threads`, `threads-preset`, `threads-profile`, `tool-threads`, `client-ui-threads`, `project-memory`, `subagent/subagent-thread-worktree`, `subagent/worktree-manager`, `client/ui-settings-threads` |
| Web search | `web/web-search-brave`, `web/web-search-duckduckgo`, `web/web-search-tavily` |

Команда перезамера ниже сейчас покажет 17: `experimental/schedule-bundle` и `runtime-diagnostics/invariants` существуют в точке расхождения, но отсутствуют в нынешнем `origin/master`. Это не наши пакеты — апстрим их переименовал или убрал в `0.2.1-alpha.1`, и при мерже это придётся разобрать отдельно.

## Поверхность конфликтов

Здесь два разных числа, и путать их дорого.

**132 изменённых апстримных файла** — это сколько файлов трогает ветка. Число, которое надо уменьшать отчуждением.

**72 файла пересекаются с тем, что апстрим изменил в `0.2.1-alpha.1`** — это сколько файлов реально встретится в конфликте при ближайшем мерже. Из них 29 перегенерируются, то есть **43 требуют глаз**, и только шесть из них содержат код:

```
packages/core/session/src/index.ts
packages/core/session/src/types.ts
packages/subagent/subagent/src/index.ts
packages/extensions/cordis-client-runner/src/client/slot-catalog.ts
packages/extensions/tool-cordis/src/api-catalog.ts
scripts/check-workspace-constraints.ts
```

Остальные 37 — README и их китайские пары, `docs/subsystems/*`, три `tsconfig.*.json`, `pnpm-workspace.yaml`, генераторы `gen-*.ts` и `verify-package-readme-model-experience.ts`, три заметки в `.agents/notes/implemented`.

Вывод, который стоит записать: **мерж сейчас дешевле, чем кажется по числу 132.** Он дорожает с каждым апстримным релизом, который ветка пропускает.

### Разбор 132 файлов по цене

#### A. Перегенерируемое — 37 файлов, цена нулевая

Каталоги `docs/config-catalog`, `tool-catalog`, `persistence-catalog`, `module-graph`, `capability-seams`, `event-producer-consumer`, `persistence-schema.json`, `persistence-changes/`, все `.i18n.yaml`, `pnpm-lock.yaml`, `THIRD_PARTY_NOTICES.md`, `scripts/*.baseline.json`, `scripts/*.manifest.json`, `core/session/src/known-event-types.ts`.

Конфликтуют почти всегда, но содержимое выводится из кода. Правильное обращение — не мержить, а перегенерировать ([MERGE-RUNBOOK.md](MERGE-RUNBOOK.md)).

**`snapshots/` в этот список не входит, хотя раньше входил.** Это была ошибка с риском потери данных: из 212 сценариев корпуса **137 записаны вручную** (`recording: authored`), потому что писались без ключа. `test:snapshot:record` их не восстановит — он требует ключа и живой модели. Ветка правит десять файлов в `snapshots/session/threads-project-worktree` и два в `web-search-endpoint-guidance`, плюс добавляет весь `threads-project-worktree-tiers`; всё это пишется руками и мержится как обычный код.

#### B. Точки регистрации — около 10 файлов, цена низкая

`tsconfig.base.json`, `tsconfig.host.json`, `tsconfig.client.json`, `pnpm-workspace.yaml`, `bundle/base/cordis.patch.yml`, `bundle/web-app/cordis.patch.yml` и их `package.json`, `scripts/check-workspace-constraints.ts`, `scripts/gen-*.ts`, `lefthook.yml`.

По одной-две строки на пакет. Конфликтуют тривиально — вернуть строку. Исчезают полностью, только если пакет уедет из воркспейса в отдельный репозиторий.

#### C. Правки апстримных пакетов — около 84 файлов, цена высокая

Вот это настоящая боль. По фичам:

| Что | Апстримные пакеты | Файлов |
|---|---|---|
| Threads: continuable subagent | `subagent/subagent` | 14 |
| Model routing | `llm/llm-pi-ai` | 10 |
| UI воркспейса | `client/ui-workspace` | 8 |
| Web search | `client/ui-settings-web-search` | 7 |
| Session | `core/session` | 7 |
| Web search | `web/web`, `web/web-fetch-http` | 6 |
| Threads: allowedModels | `subagent/tool-subagent` | 4 |
| Тест-инфраструктура | `test-support/session-snapshot`, `test-support/client-runtime` | 5 |
| Документация подсистем | `docs/subsystems/*` | 10 |
| Прочее | `extensions/tool-cordis`, `extensions/cordis-client-runner`, `preset/agent-preset`, `experimental/webworker-runtime`, `apps/cli/composition.md` | ~5 |

## Как перезамерить

```sh
git fetch origin

# насколько отстали от апстрима
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
git diff --name-only $mb..origin/master | sort > /tmp/theirs.txt
comm -12 /tmp/ours.txt /tmp/theirs.txt | tee /tmp/both.txt | wc -l
```

Перезамерять после каждого мержа апстрима и после каждой заметной фичи. Без `git fetch` сравнение идёт со старым апстримом, и число пересечений выходит заниженным — именно это и произошло с прошлым замером.
