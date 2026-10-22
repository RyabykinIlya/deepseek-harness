# @local/tg-notify

Короткие Telegram-уведомления о работе DeepSeek Harness. Host-side плагин без
зависимостей и без клиентской половины: слушает события харнесса и шлёт по
одному `sendMessage` в Bot API на каждое уведомление (никакого polling — токен
можно спокойно использовать и в других отправителях).

## Что приходит

| Событие | Сообщение | Условие |
| --- | --- | --- |
| Агент вернулся в idle | `✅ DSH: задача завершена` + длительность + заголовок сессии + выдержка финального ответа | ход ≥ `minRunSeconds` (30 с), склейка `idleDebounceMs` (8 с); goal-автопродолжения не спамят — пинг один, когда агент реально закончил |
| Ожидание одобрения | `⏸ DSH: нужно одобрение` + инструмент + причина | сразу (`approval/asked`) |
| Вопрос агенту | `❓ DSH: агент ждёт ответа` + текст вопросов | сразу (вызов `ask_user_question`) |
| Фоновая джоба | `🔔/💥/🛑 DSH: фоновая задача …` + label + длительность | джоба шла ≥ `minJobMs` (60 с) |
| Цель | `🏁 цель достигнута` / `⛔ цель заблокирована` | фазы `complete`/`blocked` |
| Сабагент | `🤖 сабагент завершён` | по умолчанию **выключено** (`notifySubagents: true`), обычно это шум |
| Старт DSH | `🚀 нотификатор подключён` | `notifyStartup` (проверка связки) |

Иконка в «задача завершена» отражает причину конца хода: `❌` ошибка, `⛔`
блокировка, `✂️` лимит токенов, `🛑` прерывание.

## Настройка (env, без правки конфигов)

Ключи читаются через `ctx.credentials` в порядке харнесса: managed store →
`process.env` → `<cwd>/.env` → `$DSH_HOME/.env`. Для этой машины:

```sh
cd ~/my-harness-dotfiles
bin/dotfiles secret set TG_NOTIFY_BOT_TOKEN   # токен от @BotFather
bin/dotfiles secret set TG_NOTIFY_CHAT_ID     # личный chat id
# опционально:
bin/dotfiles secret set TG_NOTIFY_THREAD_ID   # топик в группе/форуме
bin/dotfiles secret set TG_NOTIFY_PROXY       # http(s)-прокси только для Telegram
bin/dotfiles secret set TG_NOTIFY_LEVEL       # all (default) | approval-only
bin/dotfiles secret set TG_NOTIFY_ENABLED     # '0'/'false'/'no'/'off' — выключить
```

Значения не пишутся в трекаемые файлы; рендер в `~/.dsh/.env` делает
`bin/dotfiles secret set` сам. После — рестарт `dsh web` и `/tg-test` в чате
харнесса.

## Конфиг (cordis.patch.yml, опционально)

Все поля — в `resolveConfig` (`index.js`): `token`/`chatId`/`threadId`
(литералы, env предпочтительнее), `apiBase`, `proxy`, `level`, `timeoutMs`
(8000), `maxChars` (3800), `minRunSeconds` (30), `idleDebounceMs` (8000),
`minJobMs` (60000), `ratePerMinute` (12), `enabled`, `notifyOnIdle/Approval/
Question/Job/Goal`, `notifySubagents` (false), `notifyStartup` (true) и имена
env-ключей (`tokenEnv` и т.д.). Config в patch-слое заменяет объект целиком.

## Гигиена

- `parse_mode=HTML`, экранирование с побайтовым усечением (`fit`), сообщение
  всегда ≤ 4096 по построению (бюджет тела = `maxChars` − резерв заголовка).
- Таймаут `timeoutMs`, один ретрай (429 — с `retry_after` от Telegram;
  дубль при потере ответа — осознанный at-least-once).
- Отправки fire-and-forget: любая ошибка — только строчка в лог, ход агента
  не затрагивается.
- Rate limit `ratePerMinute` сообщений в минуту, но **одобрения и вопросы
  лимитом не отбрасываются** — именно они и есть смысл плагина; лимит
  считается только после того, как цель (токен/чат) реально разрешилась.
- Токен маскируется (`<bot-token>`) в любом тексте, уходящем в лог или в
  ответ команды: битый токен иначе всплывает в ошибке разбора URL.
- Прокси: `TG_NOTIFY_PROXY` поднимает собственный CONNECT-туннель только для
  Telegram (поддержаны `http://`/`https://`, в том числе с `user:pass@` —
  уходит `Proxy-Authorization: Basic`); без него — обычный `fetch`, который
  наследует глобальную прокси-политику харнесса (`https_proxy` из
  launch-окружения).
- Стартовое сообщение отправляется один раз на процесс: hot reload плагина его
  не повторяет.

## Сборка/установка

Не требуется: plain ESM, собирается и живёт в `.local-plugins/tg-notify`.
Подключение — профильная зависимость `link:` + bundle (см.
`~/my-harness-dotfiles/homes/dsh/package.json`).
