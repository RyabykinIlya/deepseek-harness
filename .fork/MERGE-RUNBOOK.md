# Обновление ядра из апстрима

Процедура на каждое подтягивание `origin/master`. Смысл в порядке шагов: генерируемое перегенерируется **после** мержа кода, а не мержится вместе с ним.

Сколько работы предстоит прямо сейчас — в [INVENTORY.md](INVENTORY.md): там измерено не только сколько файлов трогает ветка, но и сколько из них реально пересекается с ожидающим апстримом.

## 0. Перед началом: заморозка и worktree

Работа идёт **не в рабочем чекауте**, а в отдельном worktree: чекаут обслуживает живую сессию, и правка дерева под работающим процессом уже приводила к поломкам при обновлении. Где и почему так — в [ADR-0003](adr/0003-merge-in-worktree-with-fast-forward-cutover.md).

```sh
git fetch origin
git log --oneline HEAD..origin/master | wc -l   # сколько приехало

# Рабочее дерево должно быть чистым: worktree ветвится от коммита и не наследует
# незакоммиченное, иначе своя работа молча останется за бортом.
git status --porcelain          # ожидается пустой вывод

git rev-parse HEAD              # записать: это точка отката
git worktree add .worktrees/merge-<дата> -b merge/<дата>
cd .worktrees/merge-<дата>
```

Шаги 1–5 ниже выполняются **внутри worktree**. Путь чекаута при этом не меняется, поэтому абсолютные `link:`-пути профиля и рабочие каталоги Thread'ов переживают обновление без правок.

Вырезка — отдельная операция, после всех проверок:

```sh
# в основном чекауте, при остановленном dsh
git merge --ff-only merge/<дата>
pnpm install && pnpm run build
```

Откат — `git reset --hard <точка отката>`, затем `pnpm install && pnpm run build`.

## 1. Выкинуть генерируемое из своей ветки

Это ключевой шаг, который убирает примерно 38 конфликтов из 132. Берём апстримную версию всего, что выводится из кода:

```sh
git checkout origin/master -- \
  docs/config-catalog.md docs/config-catalog.zh.md \
  docs/tool-catalog.md docs/tool-catalog.zh.md \
  docs/persistence-catalog.md docs/persistence-catalog.zh.md \
  docs/persistence-schema.json \
  docs/module-graph.md docs/module-graph.zh.md \
  docs/capability-seams.md docs/capability-seams.zh.md \
  docs/event-producer-consumer.md docs/event-producer-consumer.zh.md \
  apps/cli/composition.md \
  THIRD_PARTY_NOTICES.md pnpm-lock.yaml \
  scripts/no-unknown-casts.baseline.json \
  packages/core/session/src/known-event-types.ts \
  packages/extensions/tool-cordis/src/api-catalog.ts
```

`apps/cli/composition.md` и `packages/extensions/tool-cordis/src/api-catalog.ts` — тоже генераты (`gen-doc-graphs` и `gen-cordis-catalog`): их содержимое выводится из кода, поэтому свои строки в них не правятся, а возвращаются шагом 3.

`.i18n.yaml` файлы перезаписываются своим гейтом, их тоже берём от апстрима.

**`snapshots/` сюда не входит и никогда не должен войти.** Из 212 сценариев корпуса 137 записаны вручную (`recording: authored`), потому что писались без ключа; `test:snapshot:record` их не восстановит. Снапшоты мержатся как обычный код, построчно.

## 2. Мерж

```sh
git merge origin/master
```

Конфликты теперь только в категориях B и C инвентаря. Разбор:

- **Точки регистрации** (`tsconfig.*.json`, `pnpm-workspace.yaml`, `bundle/*/cordis.patch.yml`, `scripts/gen-*.ts`, `scripts/check-workspace-constraints.ts`) — взять апстримную версию и вернуть свои строки. Список своих строк виден так:
  ```sh
  git diff origin/master -- tsconfig.host.json
  ```
- **Правки апстримных пакетов** (категория C) — читать оба варианта. Если апстрим переписал функцию, которую мы правили, своя правка переносится заново. Это та работа, которую план отчуждения должен убрать.

## 3. Перегенерировать

```sh
pnpm install
pnpm run gen-persistence-catalog
pnpm run gen-tool-catalog
pnpm run gen-cordis-catalog
pnpm run gen-doc-graphs
pnpm run gen-third-party-notices
pnpm run verify-translation-pairing --all --write
pnpm run verify-no-unknown-casts --prune
```

Если генератор падает — это настоящая ошибка в коде, а не шум мержа. Разбирать до конца, не обходить.

`packages/extensions/tool-cordis/src/api-catalog.ts` перегенерируется тем же `gen-cordis-catalog` (в его шапке указан `gen-cordis-api` — это совместимый вход в ту же реализацию), так что отдельной команды ему не нужно.

`scripts/no-unknown-casts.baseline.json` — сюда же, и по той же причине: шаг 1 берёт апстримную копию (иначе свои 17 снятых приведений читаются как новые), а `--prune` приводит инвентарь к нашему дереву. Без этого `pnpm run hygiene` красный на устаревших записях — тех приведениях, которые форк снял. Прогонять `--prune` **после** того, как сняты все свои приведения: гейт проверяет добавленные раньше устаревших и на добавленных падает, не дойдя до устаревших.

## 4. Проверить

Минимум, который ловит разъехавшееся после мержа:

```sh
pnpm run typecheck
pnpm run lint
pnpm run test
```

Затем точечно по затронутым плагинам, например:

```sh
pnpm vitest run packages/experimental/model-routing packages/experimental/client-ui-model-routing
```

И обязательно — запуск приложения. Типы и тесты не ловят класс ошибок вида «читает сервис, не объявленный в своей области»: `TestRemote` в тестах подменяет его обычным свойством объекта, а в приложении это падает. Один из двух дефектов 2026-10-04 был именно такой.

```sh
pnpm dsh web --no-open --port 3099
```

Открыть, проверить консоль на ошибки, открыть существующую сессию и создать новую.

## Сколько ждать

Замерено на этой машине 2026-10-04. Полезно знать заранее, чтобы не убивать гейт, решив что он завис:

| Гейт | Время |
|---|---|
| `verify-package-readme-summaries` | ~3 с |
| `verify-concrete-terms`, `verify-doc-budgets` | ~10 с |
| `verify-package-readme-model-experience` | ~36 с |
| `verify-repository-references` | ~50 с |
| `verify-type-equiv` | ~200 с |
| `verify-md-links` | ~310 с |
| `verify-translation-pairing` (по всему корпусу) | ~420 с |
| `test:docs` (агрегат из 21 гейта) | **больше 540 с**, на этой машине упирался в таймаут |

Отсюда практика: точечные гейты по затронутым файлам гоняются локально, агрегат `test:docs` оставляется CI. Для одной пары документов достаточно `pnpm run verify-translation-pairing <путь к .md>` — это секунды вместо семи минут.

## 5. Обновить замеры

```sh
# числа для .fork/INVENTORY.md — команды лежат в его конце
```

Если поверхность конфликтов выросла — записать, из-за чего. Если уменьшилась — тоже, чтобы было видно, что отчуждение движется.

## Что делать с правками ядра

Каждая правка апстримного пакета должна иметь исход. Три допустимых:

1. **В апстрим.** Отдельный маленький PR. Подходит для самодостаточного шва (например, `ctx.piAiDispatch` — 84 строки).
2. **Вендорить.** Перенести в свой пакет. Подходит, если код не обязан жить в ядре (например, разбор списка endpoint'ов OpenRouter).
3. **Держать локально.** Допустимо, но причина записывается в `plans/`, иначе через три мержа никто не вспомнит, зачем эта правка.

Правка без одного из трёх исходов — это та, которая и создаёт боль при каждом обновлении. Исход каждой нынешней правки записан в [plans/](plans/), а причина, по которой она вообще появилась, — в [DECISIONS.md](DECISIONS.md).
