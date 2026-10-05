# План публикации плагина «OpenRouter Spend»

План для текущего состояния плагина в `.local-plugins/openrouter-spend/`. Он описывает, что нужно сделать, чтобы другие люди могли установить плагин через `dsh plugin add` из npm или из GitHub.

## 1. Что уже есть

| Файл | Назначение |
| --- | --- |
| `package.json` | Манифест бандла: `dsh.bundle.patch`, `dsh.client`, `exports`, `files`. Сейчас `name: "@local/openrouter-spend"`, `"private": true`, нет `description`, `license`, `repository`, `author`, `keywords`, `engines`. |
| `cordis.patch.yml` | Вставляет строку `id: openrouter-spend` с `name: '@local/openrouter-spend'` и `config`. |
| `index.js` | Host-половина: `apply(ctx, config)`, `inject: ['credentials','webServer','connection']`, два маршрута `/openrouter-spend/summary` и `/openrouter-spend/credential`, собственный `resolveConfig` без экспортируемого `Config`. |
| `client.js` | Браузерная половина: `window.__ModuleLoader__.load({ id: '@local/openrouter-spend', … })`, чипы в `conversation.composer.dock` и секция в `settings.section`, локальная копия словаря `en`/`zh` внутри фабрики. |
| `locale/en.json`, `locale/zh.json` | Только `meta.title` / `meta.description` плюс дублирующий словарь — эти файлы читает Plugin Manager и инвентарь, словарь для рантайма берётся из `client.js`. |
| `icon.svg` | Оригинальная иконка 428 байт, валидна для публикации. |

Технически плагин уже соответствует формату бандла: обычный ESM JavaScript без сборки и без зависимостей, в том числе без импортов пакетов `@deepseek-ai/*`. Именно это делает установку из GitHub возможной без `prepare`-скрипта и без разрешения пользователя на build-скрипты.

Чего пока нет: `README.md`, `LICENSE`, `CHANGELOG.md`, `SECURITY.md`, `.gitignore`, публичного имени пакета, git-репозитория и готовности манифеста к публикации.

## 2. Решения, которые нужно принять до начала

1. **Имя пакета.** `@local/openrouter-spend` — служебный scope, его публиковать нельзя. Варианты: `dsh-openrouter-spend` (без scope, как в примере из документации) или `@<ваш-аккаунт>/dsh-openrouter-spend` (свой scope на npm, создаётся один раз). Имя должно совпадать с именем GitHub-репозитория.
2. **Лицензия.** Для публикации по умолчанию подходит MIT; Apache-2.0 добавляет явное упоминание патентных прав. Убедитесь, что выбранная лицензия совместима с MIT-лицензией самого харнесса, из которого этот плагин вырос.
3. **Первый номер версии.** Рекомендую `0.1.0`, а не `1.0.0`: имена маршрутов `/openrouter-spend/*`, поля `config` (`credentialRef`, `apiBase`, `refreshSeconds`, `historyDays`, `timeoutMs`) и структура ответа ещё не заморожены, а в semver после `1.0.0` их изменение — ломающее. Если публикуете как `1.0.0`, сразу считайте эти поля публичным API.
4. **Владелец репозитория.** Личный аккаунт GitHub и npm или организация — от этого зависят ссылки в `package.json` и в workflow публикации.
5. **Где живут исходники.** Постоянный каталог репозитория: `/Users/user/dev/dsh-openrouter-spend` (git-remote `RyabykinIlya/dsh-openrouter-spend`). Временная копия `.fork/` удалена после переноса.

## 3. Этап 1 — подготовка пакета

### 3.1 Новое имя во всех трёх местах

Имя пакета встречается в трёх файлах, и рассинхрон ломает загрузку бандла: `package.json` → `name`, `cordis.patch.yml` → `name:` строки плагина, `client.js` → `id` в `window.__ModuleLoader__.load`. `export const name` в `index.js` — это id строки загрузчика, а не имя пакета, его можно оставить как `openrouter-spend`.

```sh
cd ~/dev/dsh-openrouter-spend
# заменить @local/openrouter-spend на новое имя в package.json, cordis.patch.yml, client.js
grep -rn '@local/openrouter-spend' .
```

### 3.2 Манифест для публикации

В `package.json` удалить `"private": true` и добавить:

- `description` — одно предложение о том, что делает плагин (это же значение показывается в Plugin Manager).
- `license` — SPDX-значение, совпадающее с файлом `LICENSE`.
- `author`, `maintainers`, `contributors`.
- `repository` — `{ "type": "git", "url": "git+https://github.com/<владелец>/<имя>.git" }`, плюс `homepage` и `bugs.url` на репозиторий.
- `keywords` — как минимум `dsh`, `dsh-plugin`, `cordis`, `openrouter`, `spend`; ключевое слово `dsh` отвечает за поиск в npm.
- `engines` — `{ "node": ">=22.19" }`, в соответствии с диапазоном движка харнесса.
- `publishConfig` — `{ "access": "public", "registry": "https://registry.npmjs.org/" }`, чтобы публикация из CI не требовала флагов.
- `sideEffects: false` не указывать: `index.js` регистрирует маршруты при импорте, а дерево модулей не собирается.
- `scripts` — только `test`, если решите добавить проверки; **не добавляйте `prepare`**: он заставил бы каждого пользователя разрешать build-скрипт при установке из GitHub, а сборки здесь нет.

Поле `files` уже корректно (`index.js`, `client.js`, `cordis.patch.yml`, `locale/*.json`, `icon.svg`); `README.md` и `LICENSE` npm включает в архив автоматически, но их стоит перечислить явно, чтобы не зависеть от этого поведения.

Проверка свободного имени и итогового архива:

```sh
npm view dsh-openrouter-spend version        # 404 — имя свободно
npm pack --dry-run                           # список файлов, которые уедут в tarball
npm publish --dry-run                        # полный прогон публикации без отправки
```

### 3.3 Требования к хосту и место в настройках

Зависимостей npm у плагина нет и добавлять их не нужно: host-половина получает `credentials`, `webServer` и `connection` декларативным `inject` (это in-box сервисы харнесса, а не модули), а клиентская половина не подключает ни одного пакета харнесса — `dsh.client.inject` задаёт только порядок активации. В профиле без этих сервисов, например headless CLI, плагин не активируется вместо ошибки. Привязка к харнессу существует на уровне контрактов: имена слотов, опции регистрации, токены темы и `locale` — pre-stable API, поэтому таблица совместимости из раздела 7 обязательна.

Размещение UI соответствует дереву слотов: `settings.section` — штатное место целой страницы настроек (`settings.general.item` предназначен для одиночной настройки без своей страницы, а `settings.plugins.tab` — для страниц внутри раздела Plugins про сам бандл). В карточке Plugins плагин появится сам за счёт `meta.title`/`meta.description` в `locale/*.json` и иконки. Опционально: экспортировать `Config` из `index.js` вместо приватного `resolveConfig`, чтобы Plugin Manager показывал схему и пользователь мог переопределять значения в своём слое патча.

### 3.4 Документы репозитория

- `README.md`: что показывает плагин (чип у поля ввода с сегодняшними расходами и панель с диапазонами «сегодня / 7 дней / 30 дней», разбивкой по моделям и по API-ключам, балансом предоплаченных кредитов); требования (Harness с сервисами `credentials`, `webServer`, `connection` и веб-клиентом); установка из npm и из GitHub; настройка ключа; таблица `config` с диапазонами значений; раздел о безопасности; лицензия.
- Установка из npm: `dsh plugin --profile <профиль> add dsh-openrouter-spend`.
- Установка из GitHub: `dsh plugin --profile <профиль> add github:<владелец>/<имя>` — для этого пакета разрешение build-скриптов не нужно, потому что он не требует сборки; в README это стоит сказать явно, так как документация харнесса предупреждает об обратном для исходников на TypeScript.
- Ключ: плагину нужен **Management API key** OpenRouter (в интерфейсе: Settings → API keys → Management), потому что аналитика берётся из `POST /api/v1/analytics/query` и `GET /api/v1/credits`. Обычный API-ключ модели эти методы не отдаёт.
- `LICENSE` (MIT, текст целиком), `CHANGELOG.md` (по Keep a Changelog, начиная с `0.1.0`), `SECURITY.md` (куда сообщать об уязвимостях), `.gitignore` (`node_modules`, `*.tgz`, `.DS_Store`).
- Дисклеймер: плагин неофициальный, не связан с OpenRouter и DeepSeek; «OpenRouter» — чужой товарный знак, поэтому в иконке и логотипе остаётся собственная графика, а не логотип OpenRouter.

### 3.5 Локализация

Текущие `locale/en.json` и `locale/zh.json` содержат `meta` плюс дублирующий словарь, который рантайм всё равно берёт из `client.js`. Стоит решить одно из двух: убрать дубликат из JSON и оставить только `meta`, либо перевести весь словарь в JSON и загружать его в `client.js`. Второй вариант правильнее по контракту локализации, но требует поддержать асинхронную загрузку словаря в фабрике.

Дополнительно: пользователь русскоязычный — стоит добавить `ru`, иначе подпись в настройках останется китайской. Значения для всех языков должны быть в одном файле рядом, иначе одна копия разъедется с другой.

### 3.6 Локальная проверка до публикации

```sh
cd ~/dev/dsh-openrouter-spend
node --check index.js && node --check client.js   # синтаксис
npm pack --dry-run                               # состав архива
```

Затем в текущем профиле: убрать старый `@local/openrouter-spend` и поставить новый пакет из каталога (`dsh plugin --profile <профиль> add ./`), убедиться в `application: applied`, в появлении чипа у поля ввода и секции в настройках, и в том, что цифры совпадают с кабинетом OpenRouter.

## 4. Этап 2 — GitHub

```sh
cd ~/dev/dsh-openrouter-spend
git init -b main
git add .
git commit -m "OpenRouter spend: initial public release"
gh repo create dsh-openrouter-spend --public --source=. --remote=origin --push
```

Оформление:

- Описание репозитория и тема, если применимо.
- Бейджи в `README.md`: лицензия, последний релиз.
- `CONTRIBUTING.md` на две строки: как запустить локально и что нужно приложить к изменению (обновление `locale/*.json` вместе с кодом).
- `.github/workflows/ci.yml`: на каждый push и PR — проверка синтаксиса `node --check` для `index.js` и `client.js`, `npm pack --dry-run`, проверка JSON локалей и YAML патча, проверка совпадения имени пакета в трёх файлах.
- `.github/ISSUE_TEMPLATE/` — баг и запрос возможности, с напоминанием не публиковать API-ключи в issue.
- `.github/dependabot.yml` не нужен: у пакета нет зависимостей.

Теги: `v0.1.0` на первом коммите релиза, далее `v<semver>` на каждом релизе. Имя тега совпадает с тем, что Plugin Manager и документация предлагают для установки из GitHub (`github:<владелец>/<имя>#v0.1.0`).

## 5. Этап 3 — публикация в npm

Подготовка аккаунта (один раз):

```sh
npm login                       # или вход токеном, если аккаунт на npm уже есть
npm whoami                      # убедиться, что вошли тем аккаунтом, которому принадлежит scope
npm access list collab
```

Два варианта публикации:

1. **Локально.** `npm publish --provenance` — provenance требует npm ≥ 9.5 и публичного репозитория с тегом. Токен: automation-токен из npm, созданный после включения двухфакторной аутентификации; хранить только в `~/.npmrc`, файл с токеном в репозиторий не попадает.
2. **Из GitHub Actions (предпочтительно).** Workflow `publish.yml` по событиюpush тегов `v*`: `permissions: id-token: write`, `contents: read`, затем `npm publish --provenance --access public` с `NODE_AUTH_TOKEN` из секрета репозитория. Плюсы: provenance подписывается автоматически, публикация повторяема, релиз привязан к тегу. Обязательное условие: в `package.json` поле `publishConfig.provenance` не выключено и в `settings.json` workflow включено «Read and write permissions».

Порядок для `0.1.0`: сначала коммит и тег `v0.1.0`, затем публикация в npm под тем же номером версии. Расхождение номеров тега и версии ломает соответствие `github:` и npm-ссылок в README.

Проверка после публикации:

```sh
npm view dsh-openrouter-spend          # версия, описание, поле dsh в манифесте
npm view dsh-openrouter-spend dsh --json
npm dist-tag ls dsh-openrouter-spend
```

Поле `dsh` в опубликованном манифесте обязательно: Plugin Manager читает его через `pnpm view`, чтобы понять, что пакет — бандл, и показать его в инвентаре.

## 6. Этап 4 — проверка установки «как у другого человека»

Чистая проверка на чистом профиле, где плагин раньше не стоял:

```sh
dsh plugin --profile smoke add dsh-openrouter-spend@0.1.0
dsh --profile smoke --dump-config | grep -A5 'dsh-openrouter-spend'   # слой бандла присутствует
dsh --profile smoke                                                   # запуск профиля
```

Во время проверки нужно подтвердить:

- Бандл действительно установился как бандл, а не как обычная зависимость (в выводе `dsh plugin` нет предупреждения об отсутствии `dsh.bundle`).
- В веб-клиенте появились чип у поля ввода и секция в настройках, с правильным заголовком и иконкой из `locale/*.json` и `icon.svg`.
- Подстановка ключа работает через `credentials`: чип переходит из состояния «нет ключа» в реальные цифры, а очистка ключа возвращает исходное состояние.
- Недоступность OpenRouter даёт состояние «устаревшие данные» с текстом ошибки, а не пустую панель.
- После `dsh plugin --profile smoke remove dsh-openrouter-spend` профиль возвращается к исходному состоянию.

Отдельно проверить установку из GitHub: `dsh plugin --profile smoke add github:<владелец>/<имя>#v0.1.0` не должна требовать разрешения build-скриптов. Если требует — в манифесте появился `prepare`, который не нужен.

Тестовый профиль `smoke` после проверки удалить.

## 7. Этап 5 — после первой публикации

- Релиз на GitHub: `gh release create v0.1.0` с notes из `CHANGELOG.md`.
- Объявление: описание в README, которое можно скопировать в пост, плюс строка в сообществе (Discord/Reddit харнесса, если такие площадки используются), с пометкой о том, что нужен management-ключ OpenRouter.
- Дальше каждое изменение проходит путь «правка → `npm version <patch|minor>` → коммит → тег `vX.Y.Z` → публикация в npm».
- Держать в README таблицу совместимости: версия плагина и версия харнесса, на которой она проверена. Сейчас такой версии у плагина нет — добавьте строку с проверенной версией при первом релизе.

## 8. Чек-лист перед первой публикацией

- [ ] Имя пакета совпадает в `package.json`, `cordis.patch.yml` и `client.js`
- [ ] `"private": true` удалено, `publishConfig.access` = `public`
- [ ] Есть `description`, `license`, `repository`, `homepage`, `bugs`, `keywords`, `engines`
- [ ] `npm view <имя>` показывает свободное имя
- [ ] `npm pack --dry-run` перечисляет только `index.js`, `client.js`, `cordis.patch.yml`, `locale/*.json`, `icon.svg`, `package.json`, `README.md`, `LICENSE`
- [ ] `node --check` проходит для `index.js` и `client.js`
- [ ] `README.md` описывает установку из npm и из GitHub, требование management-ключа и таблицу `config`
- [ ] `LICENSE` и `CHANGELOG.md` добавлены, `LICENSE` совпадает с полем `license`
- [ ] Нет ключей, токенов и личных данных в git-истории и в архиве пакета
- [ ] `git init`, коммит, публичный репозиторий, тег `v0.1.0`
- [ ] Опубликовано в npm с provenance, `npm view` показывает версию и поле `dsh`
- [ ] Установка с нуля в чистом профиле проверена, GitHub-установка проверена
- [ ] Дисклеймер о стороннем происхождении есть в README

## 9. Известные риски

- **Секрет в репозитории.** Плагин принимает management-ключ через маршрут `/openrouter-spend/credential` и хранит его в `credentials`, а не в своих файлах. Перед коммитом проверьте, что в исходниках нет захардкоженного значения и что `credentials.describe` возвращает только метаданные (`configured`, `writable`, `source`), а не значение ключа.
- **Публичный маршрут без аутентификации.** `/openrouter-spend/summary` отдаёт расходы любому, кто может обратиться к локальному порту: защита опирается на проверку доверия соединения (`ctx.connection.requestRejection`). Это стоит описать в README явно, потому что при удалённом развёртывании с обратным прокси поведение меняется.
- **Стабильность API OpenRouter.** Плагин опирается на `POST /api/v1/analytics/query` и `GET /api/v1/credits`. Эти методы требуют management-ключа и могут измениться; в `README` стоит сослаться на документацию OpenRouter и заложить для этого патч-версии.
- **Совместимость со слотами.** Плагин регистрируется в `conversation.composer.dock` и `settings.section`. Если Harness переименует слот, плагин перестанет загружаться; поэтому диапазон версий харнесса в README нужно держать узким и обновлять вместе с проверками.