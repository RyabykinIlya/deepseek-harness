# tg_bro_bot → DeepSeek Harness — рабочий заказ на ветку

Документ рассчитан на то, что его читает агент, запущенный в каталоге `/Users/user/dev/assistant`, и выполняет миграцию ядра `tg_bro_bot` на DeepSeek Harness. Всё, что нужно для старта, — в этом файле: пути, факты об окружении, контракты SDK, готовый патч профиля, шаги с проверками и границы.

Анализ бота сделан 2026-10-08 тремя обходами (ingress/egress, ядро, инструменты); факты проверены на месте, ссылки на файлы даны как `путь:строка`.

## Как этим пользоваться

Задача для новой сессии (скопировать целиком):

> Работаем в `/Users/user/dev/assistant/tg_bro_bot`. Создай ветку `dsh-harness` от `main` и выполни миграцию ядра бота на DeepSeek Harness по плану `/Users/user/deepseek-harness/.fork/plans/tg-bro-bot-harness.md`. Иди по разделу «Шаги» сверху вниз, на каждом шаге выполняй его проверку и отмечай чекбокс в файле плана. Разделы «Границы и чего не делать», «Критерии приёмки» и «Окружение (проверено)» — обязательные к прочтению. Открытые вопросы не блокируют работу: бери дефолт из раздела «Открытые вопросы и дефолты», продолжай и отметь отклонения в конце файла.

Первым шагом агент обязан прочитать этот файл целиком и раздел «Окружение (проверено)» — там числа и версии, которые он не должен переоткрывать заново.

## Что делаем

Ядро бота — цикл моделей, инструменты, история, режимы исследования — заменяется на DeepSeek Harness (DSH). Бот остаётся транспортом Telegram: приём апдейтов, пре-обработка медиа, доставка ответа и форматирование не меняются. Агент получает те же данные и отвечает так же, статусы транслируются из событий сессии DSH.

Три слоя бота и их судьба:

| Слой | Что в нём | Судьба |
|---|---|---|
| Ingress | telebot long polling, `need_response`, debounce 3 с, approval-гейт, пре-обработка фото/документов/голоса, префикс группы `[имя время]` | остаётся как есть |
| Ядро | `dialog_manager.Dialog`, `get_llm_answer`, цикл `execute_research`, `tools_registry`, `sub_agent`, research-режим | **заменяется DSH** |
| Egress | `fix_tg_markdown`, `sendRichMessage` (лимит 32 768), HTML-файл-фолбэк, фото с caption, футер «X.XXр.» | остаётся как есть |

Аудит-подсистема (`app/audit_entrypoint.py`, отдельный процесс, свой токен, свой SQLite) в область работ не входит.

## Репозитории и пути

| Что | Путь |
|---|---|
| Бот | `/Users/user/dev/assistant/tg_bro_bot` (ветка `main`, venv в `venv/`) |
| Родительский каталог сессии | `/Users/user/dev/assistant` (там же `tg_assistant`, `bro_bot_browser`) |
| Форк DSH (рабочая сборка) | `/Users/user/deepseek-harness` |
| Python SDK форка | `/Users/user/deepseek-harness/python/sdk` (пакет `deepseek-harness-sdk`) |
| Рантайм-колесо | `/Users/user/deepseek-harness/python/sdk-runtime` (пакет `deepseek-harness-runtime-bin`) |
| Этот план | `/Users/user/deepseek-harness/.fork/plans/tg-bro-bot-harness.md` |

Ветка: `dsh-harness` от `main`. Коммиты — по одному на шаг, сообщения по теме шага. `main` не трогать.

## Окружение (проверено 2026-10-08/09)

- Python бота: `venv/bin/python` = 3.10.16 (pyenv), SDK требует `>=3.10` — подходит. Системный `python3` — 3.13, использовать не обязательно.
- `telebot` и `requests` в venv импортируются; `mcp` в `requirements.txt` есть (`mcp==2.1.1`), но в venv **не установлен** — поставить перед этапом 2.
- Node: v22.23.3 (SDK-рантайм из репозитория требует 22.19+ или 24+ — подходит).
- `dsh` в PATH нет; собранный CLI форка работает: `node /Users/user/deepseek-harness/apps/cli/lib/bin.js --version` → `0.2.1-alpha.1`.
- Сборка форка актуальна: `dsh --profile sdk --dump-default-config` с явным `DSH_HOME` отрабатывает. Если `apps/cli/lib/bin.js` отсутствует или устарел — `pnpm run build` в `/Users/user/deepseek-harness`.
- `~/.dsh` существует (домашний каталог форка) — **бот обязан использовать свой `DSH_HOME`**, чужой не подхватывать.
- Python SDK в venv бота **не установлен** (проверено импортом).
- Конфиг бота: `.env` в корне (ключи: `TG_BOT_TOKEN`, `RYABYKIN_API_URL`, `YANDEX_*`, `OPENROUTER_KEY`, `ADMIN_CHAT_ID`, `PROXY_URL`, `ELASTICSEARCH_URL`, `TELEGRAPH_AT`, `GPTUNNEL_*`). `run_dev.sh` делает `set -a; source .env; set +a` и запускает `app/entrypoint.py`.
- `RYABYKIN_API_URL` — приватный хост, схема http, порт 8000. Учитывать это, если понадобится ходить в него изнутри рантайма DSH (web-fetch туда не пустит — он отвергает непубличные адреса; MCP-сервер ходит обычным `requests` и ограничения не знает).
- Тесты и стиль бота: каталог `tests/` содержит только `README.md` — автотестов в репозитории нет; `app/test_migration.py`, на который ссылается README и локальный хук `.pre-commit-config.yaml`, отсутствует. `pre-commit` в venv не установлен, `flake8` тоже; `black` есть (`venv/bin/black`). Практический минимум перед коммитом: `./venv/bin/black --line-length=100` по изменённым файлам и запуск спайка/проверок шага. Если понадобится `pre-commit`, ставить его отдельно и помнить, что локальный хук упадёт на отсутствующем файле — это состояние репозитория, а не следствие правок.

## Установка SDK — два пути

**A. Форк (рекомендуется для разработки.** Даёт плагины форка — model routing, web-search провайдеры — и живую сборку.)

```sh
cd /Users/user/dev/assistant/tg_bro_bot
./venv/bin/pip install --no-deps -e /Users/user/deepseek-harness/python/sdk
./venv/bin/pip install "pydantic>=2.12,<3"
./venv/bin/pip install "mcp==2.1.1"
```

`--no-deps` нужен потому, что зависимость `deepseek-harness-runtime-bin==0.0.0.dev0` живёт только как локальный путь (`python/sdk/pyproject.toml`, раздел `[tool.uv.sources]`), из индекса она не ставится.

Запуск рантайма — обёрткой, потому что `dsh_bin` принимает **один** исполняемый путь, а CLI форка это `node .../bin.js`:

```sh
#!/usr/bin/env bash
# scripts/dsh-dev.sh — запуск CLI форка как одного исполняемого файла для SDK
exec node /Users/user/deepseek-harness/apps/cli/lib/bin.js "$@"
```

```sh
chmod +x scripts/dsh-dev.sh
DSH_HOME=$PWD/.dsh-home ./scripts/dsh-dev.sh --profile sdk --dump-default-config >/dev/null
```

**B. Колесо из PyPI** (`pip install deepseek-harness-sdk`) — для поставки без Node и без форка. Тогда `dsh_bin` не задаётся, SDK находит встроенный рантайм сам. Для ветки миграции брать путь A, путь B проверить один раз как контрольную точку этапа 5.

`DSH_HOME` — обязательно свой, например `/Users/user/dev/assistant/tg_bro_bot/.dsh-home` (добавить в `.gitignore`). SDK никогда не берёт `~/.dsh` молча и падает, если `dsh_home` не задан и `DSH_HOME` пуст.

## Контракты SDK (точные)

Конструктор (`python/sdk/src/deepseek_harness/api.py:57`, поля — `DeepSeekHarnessConfig`, там же `:14`):

```python
from deepseek_harness import DeepSeekHarness

harness = DeepSeekHarness(
    provider="deepseek-official",       # id провайдера в композиции профиля
    model="deepseek-v4-flash",          # id модели у этого провайдера
    reasoning_effort=None,              # опционально, adapter-owned
    max_tokens=None,                    # опционально, положительное целое
    cwd="/abs/agent/workspace",         # рабочий каталог агента (в meta сессии)
    runtime_cwd="/abs/bot",             # cwd самого подпроцесса (опционально)
    dsh_home="/abs/.dsh-home",          # обязателен
    profile="sdk",
    patches=("/abs/bot.patch.yml",),    # опционально, по порядку после профиля
    dsh_bin="/abs/scripts/dsh-dev.sh",  # только для пути A
    env={"DSH_PERMISSION_MODE": "danger-full-access"},
    initialize_timeout_seconds=30.0,
    request_timeout_seconds=None,
    shutdown_timeout_seconds=1.0,
    base_url=None, api_key=None,        # переопределяют DEEPSEEK_BASE_URL / DEEPSEEK_API_KEY
)
```

Один ход:

```python
result = harness.run(
    blocks,                      # str или list[dict] контент-блоков
    session_id="tg:<chat_id>:<thread_id>",
    on_notification=callback,    # вызывается на каждое уведомление, в потоке читателя
)
result.session_id     # str
result.final_response # последний закоммиченный текст ассистента за интервал
result.finish_reason  # 'completed' | 'max-tokens' | 'error' | None
result.events         # события корневой сессии
result.notifications  # всё, что пришло за интервал
```

Контент-блоки: `{"type": "text", "text": "..."}` и `{"type": "image", "data": "<base64>", "mimeType": "image/png"}` (допустимы png/jpeg/webp/gif). Больше никаких типов вложений SDK не принимает — **документы передаются текстом** (как сейчас) либо файлом в workspace с путём в промпте.

Уведомления (`packages/sdk/protocol/src/types.ts`): `session.event` (payload `{sessionId, event}` — полное событие журнала сессии), `session.status` (`{sessionId, status: 'running'|'idle'}`), `subagent.started`, `subagent.finished`. Сервер шлёт события **всех** сессий рантайма — фильтровать по `sessionId`.

Фоновое прослушивание без активного `run()` (для due-напоминаний и внешних доставок):

```python
with harness.client.subscribe_session_notifications(session_id) as sub:
    notification = sub.next()      # блокирует; также поддерживает итерацию
```

Важные свойства, определяющие архитектуру:

- `provider`/`model` фиксируются в `initialize` **на процесс** — per-chat выбор модели через SDK невозможен без пула рантаймов или плагина.
- Отмены (`cancel`) и закрытия сессии в протоколе нет: бросить ход можно только закрыв рантайм, что убивает все чаты.
- Запросы сервер→клиент не реализованы, поэтому `ask_user_question` без своего answerer'а вернёт ошибку «нет ответчика».
- `run()` синхронный и блокирует поток до `idle`; клиент потокобезопасен (запись под локом, ожидание — в своей очереди), поэтому чаты обслуживаются потоками.
- Токеновых дельт наружу нет: `assistant/message` приходит закоммиченным, внутри лежит поток с таймингами.

## Патч профиля для бота

Профиль `sdk` = `dsh-base` + `dsh-sdk-app`, в нём **нет** композиции пресетов, поэтому строки, которые в web-профиле приходят из пресета `standard`, нужно вставить самим. Файл — `$DSH_HOME/profiles/sdk/cordis.patch.yml` (постоянный) либо отдельный патч, передаваемый в `patches=(...)`.

```yaml
# Ядро поведения: персона и рабочий каталог.
- id: system-prompt
  config:
    personaPrefix: >-
      You are a Telegram assistant powered by the {{model}} model.
      Answer in the user's language, keep the chat style of the conversation.
    personaSuffix: Your working directory is {{cwd}}.

# Инструменты, которых нет в base (в web-профиле их даёт пресет standard).
- insert:
    - id: tool-schedule
      name: '@deepseek-ai/dsh-tool-schedule'
    - id: tool-ask-user
      name: '@deepseek-ai/dsh-tool-ask-user'
    - id: tool-present
      name: '@deepseek-ai/dsh-tool-present'

# Мост к тулам бота: свой MCP-сервер (см. следующий раздел).
- insert:
    - id: mcp-bot-backend
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: botbackend
        transport: stdio
        command: /Users/user/dev/assistant/tg_bro_bot/venv/bin/python
        args: ['/Users/user/dev/assistant/tg_bro_bot/app/mcp_backend_server.py']
        env:
          RYABYKIN_API_URL: !!js process.env.RYABYKIN_API_URL
          OPENROUTER_KEY: !!js process.env.OPENROUTER_KEY

# Провайдеры под то, что уже есть у бота.
- id: llm-pi-ai
  config:
    providers:
      openrouter:
        apiKeyEnv: OPENROUTER_KEY
```

Свойства патча, которые важно помнить: патч **заменяет конфиг строки целиком**, а не сливает ключи (поэтому персона задаётся `personaPrefix` и `personaSuffix` сразу), и `insert` добавляет новые строки. Имя инструмента из MCP видно модели как `mcp__botbackend__<имя>`. Stdio-мост перед запуском ребёнка вычищает переменные окружения, похожие на креденшлы, и все `DSH_*`, поэтому секреты нужно либо перечислить в `config.env` (как выше), либо пусть сервер сам читает `.env` бота — второй вариант предпочтителен.

Права на время отладки: `DSH_PERMISSION_MODE=danger-full-access` в `env` рантайма = песочница без ограничений и политика `never` (`packages/bundle/base/cordis.patch.yml:232,248`). Это ровно то поведение, что у бота сегодня (approval-гейта на инструменты нет). Для поставки решить отдельно: `workspace-write` + `ask` без ответчика в SDK означает отказ на эскалациях, то есть часть работы агента встанет.

## MCP-сервер ботовых тулов

Один stdio-сервер на всё, что специфично для бота и живёт в его backend'е. Скелет `app/mcp_backend_server.py`:

```python
"""MCP-сервер, отдающий модели тулы бота поверх его Django-backend."""
from mcp.server.fastmcp import FastMCP

from api_requests import request_chat_messages  # существующие обёртки бота
# ... остальные функции backend-тулов

mcp = FastMCP("botbackend")


@mcp.tool()
def search_chat_history(query: str, chat_id: str | None = None,
                        date_from: str | None = None, date_to: str | None = None,
                        top_k: int = 10) -> str:
    """Семантический поиск по истории телеграм-чатов пользователя."""
    # вызов существующей функции бота, возврат строки
    ...


if __name__ == "__main__":
    mcp.run(transport="stdio")   # stdout принадлежит протоколу: логировать в stderr
```

Правила сервера: логи исключительно в stderr (stdout занят протоколом), тяжёлые зависимости не тянуть, имена и описания тулов писать с точки зрения модели. Импорт `FastMCP` сверить с установленной версией: `./venv/bin/python -c "from mcp.server.fastmcp import FastMCP; print('ok')"`; если в 2.1.1 он лежит иначе (например, `from mcp.server import FastMCP`), подстроить импорт — идея та же.

Что заводить в сервер на этом этапе (по убыванию ценности): `search_chat_history`, `memory_list/read/write/delete`, `get_messages_by_date`, `fuzzy_search_messages`, `fuzzy_search_mail`, встречи (`search_meetings`, `list_meetings`, `get_meeting_detail`, `get_meeting_transcription`), `hookah_*`, `generate_image`. Админские тулы (`find_chats`, `find_person_chats`) включать тем же способом, но проверять, что гейт по `ADMIN_CHAT_ID` сохраняется на стороне сервера, а не на стороне модели.

Тулы, которые в DSH уже есть и переносить не нужно: `bash`/`run_code` вместо `execute_code`, `web_search` вместо `general_search`, `web_fetch` вместо `get_webpage_content`, `schedule_*` вместо `create_reminder`/`schedule_*`, таск-лист, `read`/`write`/`edit` для файлов, subagents вместо `sub_agent`.

## Соответствие тулов

| Бот | DSH | Примечание |
|---|---|---|
| `general_search` (Yandex XML + синтез) | `web_search` | в форке есть провайдеры brave/duckduckgo/tavily; RU-сегмент проверить на живых запросах |
| `get_webpage_content` | `web_fetch` | не ходит на непубличные адреса — приватный backend сюда не пустить |
| `execute_code` | `bash` / `run_code` | своя песочница бота умирает |
| `memory_*` | MCP → backend | данные и команда `/memory` сохраняются |
| `create_reminder`, `schedule_*` | `schedule_create`… | due-напоминание приходит follow-up'ом в сессию → `session.event` → бот шлёт в чат |
| `search_chat_history`, встречи, почта, заказы, hookah | MCP → backend | один сервер на всё |
| VkusVill MCP | штатный `mcp-client` (streamable-http) | `tools/mcp_proxy.py` больше не нужен |
| `generate_image`, telegraph | MCP → backend | в DSH image-gen из коробки нет |
| `sub_agent` + `agent_registry` | subagents DSH | поведение «внутренние тулы не видны основной модели» нативное |
| research-режим | цикл DSH с `web_search` + subagents | лимиты и «last chance» — решать отдельно (см. открытые вопросы) |
| Devil's Advocate + `ask_user_question` | `ask_user_question` + свой answerer | без answerer'а не работает; на первом этапе режим выключить |
| `/compact` | компакция DSH | семантика другая: сжатие на месте вместо нового треда |
| `/stopresearch`, `/cancel` | — | в протоколе нет отмены |

## Паритет входных данных

| Вход | Сегодня | В DSH |
|---|---|---|
| Текст и caption | `get_user_message`, префикс `[имя время]` для групп | текст user-сообщения; префикс остаётся бот-стороной |
| Фото | vision-модель → JSON-описание → текст | нативный image-блок (base64); описание оставить фолбэком для не-vision моделей |
| Документ | `docs_analysis` → извлечённый текст | так же текстом (SDK других вложений не принимает) |
| Голос и video note | STT (WhisperX → Yandex) → текст | остаётся бот-стороной, в DSH идёт текст |
| Пиннед-сообщения | в каждый контекст | блоком в начало промпта |
| System prompt чата | `Dialog.prompt` + `config["prompt"]` из backend | на первом этапе — блок `<chat_context>` в промпте; позже форк-плагин через `ctx.systemPrompt` |
| Тред | `current_thread_id` в Django | отдельный `session_id` |
| История | Django backend | источник истины — лог DSH; параллельно писать текст в backend, пока от него зависят RAG и админ-тулы |

## Трансляция статуса

Бот не стримит токены, ответ уходит целиком, и DSH тоже не отдаёт дельты наружу — паритет честный. Статусы берём из событий:

| Событие DSH | Действие бота |
|---|---|
| `session.status: running` | цикл `send_chat_action(chat_id, "typing")` каждые ~5 с до `idle` (сегодня typing шлётся один раз перед запросом) |
| `session.event`, тип `tool/call`, имя `web_search` | правка статус-сообщения: «ищу в интернет: <query из аргументов>» |
| `session.event`, тип `tool/call`, прочие тулы | правка: случайная фраза из `detalization_text_array` (`app/utils.py:821`) |
| `session.event`, тип `tool/result` | обновить счётчик запросов в статусе («с N запросами в интернет») |
| `session.event`, `assistant/message` с tool_calls | «формирую финальный ответ...» |
| `session.status: idle` | финальный ответ через существующий egress; статус-сообщение удалить |
| `session.event`, `turn/end` с ошибкой | «что-то пошло не так, попробуй ещё раз» |
| `subagent.started` / `subagent.finished` | опционально: «делегировал подзадачу…» |
| due-напоминание | сообщение в чат без ввода пользователя |

Статус-сообщение создаётся по `running` и правится по каждому `tool/call`. Массив фраз остаётся бот-стороной.

## Форма кода: что где лежит

Новый модуль `app/harness_bridge.py` — единственная точка стыка. Контракт:

```python
def run_chat(
    chat_id: str,
    thread_id: str | None,
    blocks: list[dict],                       # текст + картинки
    on_event: Callable[[str, dict], None],    # статусные события наружу
) -> RunOutcome: ...
```

`RunOutcome` несёт `text`, `finish_reason`, `usage`, `cost_rub`. Внутри — ленивый синглтон `DeepSeekHarness`, свой `DSH_HOME`, запуск хода в рабочем потоке бота. Статусы во время хода берутся из `on_notification` самого `run()` (события `session.status` и `session.event`); отдельная фоновая подписка `harness.client.subscribe_session_notifications(...)` нужна только для того, что приходит вне хода — прежде всего due-напоминаний из `schedule_*`. Маппинг сессий — `session_id = f"tg:{chat_id}:{thread_id or 'main'}"`.

`response_to_user` (`app/entrypoint.py:95`) сохраняет форму, но вместо `get_llm_answer` + `execute_research` вызывает `run_chat` и получает готовый `text`; дальше идёт тот же путь: футер стоимости, `convert_text`, `fix_tg_markdown`, `send_rich_message` либо фото, либо HTML-файл.

Флаг включения — на чат, чтобы старый и новый путь жили рядом: `config["use_harness"]` из backend (или список чатов в env на время отладки). Пока флаг выключен, работает старое ядро; выключение — `git revert` одного коммита.

## Шаги

### 0. Спайк (полдня)

- [ ] Ветка `dsh-harness`, `.dsh-home` в `.gitignore`, обёртка `scripts/dsh-dev.sh`, SDK установлен (путь A), `mcp==2.1.1` установлен.
- [ ] Скрипт-спайк `scripts/harness_spike.py`: один ход `harness.run()` с текстом и картинкой, печать `final_response`, `finish_reason` и списка событий.
- [ ] Прогнать 10 реплик из реальной истории бота: те же промпты через старое ядро и через харнесс, сравнить ответы глазами.
- [ ] Записать в план наблюдения: где ответы разошлись и почему (персона, длина, стиль, инструменты).

**Проверка:** спайк отвечает, картинка доходит, `finish_reason == 'completed'`, разбор 10 реплик записан. Если ответы расходятся по персоне — править `personaPrefix`/`personaSuffix` до перехода к шагу 1.

### 1. Мост (день)

- [ ] `app/harness_bridge.py` с контрактом выше; ленивый синглтон, свой `DSH_HOME`, `DSH_PERMISSION_MODE=danger-full-access` через `env`.
- [ ] `response_to_user` за флагом `config["use_harness"]`: харнесс → `run_chat` → существующий egress.
- [ ] Статусы: typing-цикл по `session.status`, статус-сообщение по `tool/call`/`tool/result`, закрытие по `idle`.
- [ ] Футер стоимости из `usage` события `assistant/message` × старые `cost_rules`.

**Проверка:** в одном чате с флагом диалог идёт end-to-end; статусы видны; при выключенном флаге поведение не изменилось ни на сообщение. Прогнать `./venv/bin/black --line-length=100` по изменённым файлам.

### 2. Инструменты (1–2 дня)

- [ ] `app/mcp_backend_server.py` со списком из раздела про MCP; проверка вручную через `mcp` клиента.
- [ ] Строка `mcp-bot-backend` в патче профиля; провайдеры `llm-pi-ai` под то, что нужно боту.
- [ ] VkusVill — штатным `mcp-client` (streamable-http) вместо `tools/mcp_proxy.py`.
- [ ] Включить `tool-schedule` и `tool-ask-user` в патче.

**Проверка:** модель вызывает `mcp__botbackend__search_chat_history` и получает осмысленный ответ; напоминание, созданное через `schedule_create`, доходит сообщением в чат; `web_search` отвечает.

### 3. Медиа (полдня)

- [ ] Фото — нативным image-блоком; `image_analysis` остаётся фолбэком для моделей без зрения.
- [ ] Документы — как сейчас (текст), либо файл в workspace с путём в промпте.
- [ ] Голос — без изменений (STT до отправки).

**Проверка:** фото в чате → модель описывает содержимое без вызова vision-тула; документ `.pdf`/`.docx` → ответ по содержимому; голосовое → ответ по расшифровке.

### 4. Режимы и команды (день)

- [ ] `/refreshcontext` → новый `session_id` (старая сессия остаётся на диске).
- [ ] `/compact` → компакция DSH (или новая сессия с саммари — решить по факту).
- [ ] `/stopresearch` → мягкая остановка в рамках возможностей SDK (см. открытые вопросы).
- [ ] Devil's Advocate — либо answerer-плагин, либо режим выключен с явным сообщением пользователю.

**Проверка:** команды отрабатывают; при выключенном DA попытка его включить сообщает, что режим недоступен.

### 5. Переключение (день)

- [ ] Двойной прогон на двух-трёх живых чатах (день работы каждого), разбор расхождений.
- [ ] Включить флаг по умолчанию для всех чатов.
- [ ] Контрольная точка на пути B (`pip install deepseek-harness-sdk` из PyPI в отдельном venv) — убедиться, что поставка без форка тоже работает.
- [ ] Удалить старое ядро вместе с тестами и мёртвым кодом.

**Проверка:** чат работает сутки на харнессе; расход и ответы приемлемы; удаление старого ядра не сломало ingress/egress (сравнить выдачу на трёх репликах).

## Критерии приёмки

1. Диалог в личке и в группе идёт end-to-end через DSH; ответы по формату неотличимы от текущих (MarkdownV2, Rich Message, футер стоимости, HTML-файл для длинных).
2. Приём совпадает: текст, caption, префикс группы, форварды, reply-триггер, debounce, approval-гейт, реакции — как раньше.
3. Медиа: фото, документ, голос — обрабатываются, ответ осмысленный.
4. Статусы: typing во время хода, статус-сообщение с активностью, финальный ответ вместо него.
5. Инструменты: не меньше пяти ботовых тулов доступны модели через MCP и реально работают (проверено вызовами).
6. История переживает перезапуск бота и рантайма; `/refreshcontext` начинает чистую сессию.
7. Аудит-подсистема и egress не тронуты.

## Границы и чего не делать

- **Не трогать** `app/audit*`, `app/audit/`, egress-форматирование (`fix_tg_markdown`, `convert_text`, `send_rich_message`, `markdown_to_html`), ingress-разбор апдейтов, approval-гейт, `process_urls`.
- **Не менять** `.env` и не коммитить секреты; новые ключи — только в `.env.example`.
- **Не удалять** старое ядро до шага 5; до этого оно рабочее за флагом.
- **Не ходить** в `~/.dsh`: у бота свой `DSH_HOME`.
- **Не менять** `/Users/user/deepseek-harness` без нужды — это чужой checkout; если правка всё же нужна (например, баг в SDK), фиксировать её отдельно и сообщать в конце.
- Соблюдать стиль бота: black с `--line-length=100`, один trailing newline, аккуратные коммиты.

## Открытые вопросы и дефолты

Если агент упрётся в любой из них — берёт дефолт, продолжает и записывает отклонение.

1. **Per-chat system prompt.** `Dialog.prompt` собирается под каждый чат (дата, память, профиль, `config["prompt"]`), а SDK не даёт задать system prompt на сессию. *Дефолт:* блок `<chat_context>…</chat_context>` в начало промпта; пер-чатная секция через форк-плагин — отдельная задача.
2. **Отмена хода.** В протоколе SDK нет `cancel`. *Дефолт:* `/stopresearch` ставит флаг «игнорировать результат» и сообщает пользователю, что остановка не мгновенная; настоящая отмена — отдельная задача (форк-правка протокола или ACP).
3. **Per-chat модель.** `initialize` фиксирует пару провайдер/модель на процесс. *Дефолт:* одна модель на бота из env (`DSH_PROVIDER`, `DSH_MODEL`); `/listmodels` и per-chat выбор модели на первом этапе не переводятся.
4. **`/compact`.** *Дефолт:* компакция DSH; команда бота остаётся как есть до этапа 4, затем решается по факту.
5. **История.** *Дефолт:* текст пользователя и ассистента по-прежнему пишется в backend (RAG, админ-тулы, `/pin`), источник истины для диалога — лог DSH.
6. **Research-инварианты.** Лимит 10 интернет-запросов и «last chance» в DSH не воспроизводятся. *Дефолт:* принять нативное поведение, следить за расходом.
7. **`ask_user_question`.** Без answerer'а тул падает. *Дефолт:* DA-режим выключен, `tool-ask-user` в патче включён для будущего answerer'а.
8. **Approval при поставке.** `danger-full-access` удобен в отладке, но небезопасен. *Дефолт:* в ветке использовать его; решение для поставки записать в план, не менять молча.

## Риски

- **Паритет ответов держится на промпте.** Система DSH («You are a coding agent powered by …») отличается от ботовой; шаг 0 обязателен именно поэтому.
- **Один рантайм — общая судьба.** Падение процесса DSH останавливает все чаты до перезапуска (сессии переживают, SDK переспавнивает при следующем `run()`).
- **Стоимость меняет источник.** Футер считается из usage-событий, а не из ответов провайдера — на первых шагах возможны расхождения.
- **Секреты в MCP.** Stdio-мост вычищает переменные, похожие на креденшлы; секрет, не переданный явно, до сервера не дойдёт.
- **Приватный backend.** `web_fetch` в него не пустит; всё, что ходит в backend, должно идти через MCP-сервер.

## Приложение: проверенные факты

Форк DSH (пути от `/Users/user/deepseek-harness`):

- `python/sdk/src/deepseek_harness/api.py` — `DeepSeekHarness`, `Session.run`, `RunResult`; `:58` конструктор, `:139` `Session.run`.
- `python/sdk/src/deepseek_harness/client.py` — `HarnessClient`; `:71` `start()` (env копируется из родителя и дополняется), `:133` `initialize`, `:458` `_default_launch_args` (сборка argv: профиль и патчи).
- `python/sdk/src/deepseek_harness/models.py` — `Notification(method, payload)`.
- `python/sdk/pyproject.toml` — `requires-python >=3.10`, зависимости `pydantic>=2.12,<3` и `deepseek-harness-runtime-bin==0.0.0.dev0` (локальный путь).
- `packages/sdk/protocol/src/types.ts` — четыре уведомления и три метода протокола.
- `packages/bundle/base/cordis.patch.yml` — базовые тулы и `:232`/`:248` режим песочницы и политика approval.
- `packages/bundle/web-app/presets/standard.patch.yml` — строки пресета (`tool-schedule`, `tool-ask-user`, `tool-present`, `tool-web`), которые в `sdk`-профиле нужно вставлять самим.
- `packages/mcp/mcp-client/README.md` — поля строки MCP-клиента и правила stdio (`command`, `args`, `env`, `cwd`).
- `python/sdk-runtime/README.md` — что кладёт в колесо рантайма и как Python-обёртка запускает встроенный `dsh`.

Бот (пути от `/Users/user/dev/assistant/tg_bro_bot`):

- `app/entrypoint.py:95` — `response_to_user` (точка стыка), `:625` — `execute_research` (заменяемый цикл), `:933` — `infinity_polling`.
- `app/handlers/bot_handlers.py:33` — `DEBOUNCE_SECONDS = 3`, `:51` — `_debounce_fire` (там же typing), `:335` — `handle_message`.
- `app/dialog_manager.py` — `DialogManager`, `Dialog.prompt`, загрузка истории из backend, `:942` — `_save_message_to_db`.
- `app/get_llm_answer.py:21` — `get_llm_answer` (диспетчер провайдеров).
- `app/tools_registry.py:32` — `ToolDefinition`; `app/tools/base_tools.py`, `app/tools/hookah_tools.py`, `app/tools/mcp_proxy.py` — источники тулов.
- `app/utils.py:821` — `detalization_text_array` (фразы статуса), `:372` — `fix_tg_markdown`, `:621` — `markdown_to_html`.
- `app/instances.py:81` — `RICH_MESSAGE_MAX_LENGTH = 32768`, `:84` — `send_rich_message`.
- `app/handlers/bot_commands.py` — команды; `app/handlers/bot_callbacks.py` — колбэки.
- `docs/THREADS.md` — самописные треды; `docs/NATIVE_TOPICS.md` — спекуляция про нативные топики, в коде её нет.
