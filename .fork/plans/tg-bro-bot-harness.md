# tg_bro_bot → DeepSeek Harness — замена ядра

Заменить харнесс телеграм-бота (`~/dev/assistant/tg_bro_bot`) на DeepSeek Harness: бот остаётся транспортом Telegram (вход, доставка, команды), всё между ними — цикл, инструменты, история, режимы — переезжает в DSH. Агент получает те же данные и отвечает так же, статусы транслируются из событий сессии.

Исследование кода бота 2026-10-08: три обхода (ingress/egress, ядро, инструменты), ниже — только то, что влияет на план.

## Состояние

**Не начато.** Это план, не работа. Перед стартом — спайк (этап 0) на одном чате.

## Три слоя бота сегодня

| Слой | Что делает | Судьба |
|---|---|---|
| Ingress | telebot long polling, `need_response` (реплай/упоминание/личка), debounce 3 с, approval-гейт чата, медиа-пре-обработка (фото → vision-описание через `image_analysis.py`, документы → текст через `docs_analysis.py`, голос → STT `stt.py`), префикс группы `[имя время]`, форварды | **остаётся** |
| Ядро | `dialog_manager.Dialog` (история из Django-backend, обрезка по chars/5, system prompt из `config["prompt"]`), `get_llm_answer` (5 провайдеров), цикл `execute_research` (provider-native tool_calls), `tools_registry` (~30 тулов), `sub_agent` (свои субагенты), research-режим | **заменяется DSH** |
| Egress | `fix_tg_markdown`, `sendRichMessage` (32 768), HTML-файл-фолбэк, фото с caption, футер «X.XXр.», research-статус-сообщения с правками | **остаётся** |

Аудит-подсистема (`audit_entrypoint.py`, отдельный процесс, свой токен) — вне области, не трогаем.

## Целевая архитектура

Бот поднимает рантайм через Python SDK (`pip install deepseek-harness-sdk`, спавнит `dsh --profile sdk` сам, без Node.js). Один `DeepSeekHarness` на процесс бота; клиент потокобезопасен (write-lock на записи, ожидание ответа — по своей очереди), так что чаты работают параллельно в потоках telebot.

```
Telegram ← telebot (ingress/egress, команды, debounce, approval)
              │ content blocks (текст, image, STT-текст)
              ▼
        DeepSeekHarness.run(prompt, session_id="tg:<chat>:<thread>")
              │ stdio JSON-RPC
              ▼
        dsh --profile sdk (base: инструменты, песочница, компакция,
                           web_search, subagents, MCP-клиент)
              + свои MCP-серверы для ботовых backend-тулов
              + форк-плагины (model routing, web-search) по желанию
```

Маппинг сессий: `session_id = "tg:<chat_id>:<thread_id>"` (треды бота → отдельные сессии DSH; `/refreshcontext` создаёт новый id, `/threads` продолжает старый). История переживает перезапуски в `<DSH_HOME>/sessions`, ботовый in-memory кэш диалогов умирает.

### Паритет входных данных

Что бот сегодня извлекает и куда это идёт в DSH:

| Вход | Сегодня в боте | В DSH |
|---|---|---|
| Текст / caption | `get_user_message`, префикс `[имя время]` для групп | текст user-сообщения, префикс остаётся бот-стороной (дословный паритет) |
| Фото | vision-модель → JSON-описание → текст | нативный image-block (SDK принимает base64, png/jpeg/webp/gif) — данные те же, но полнее; описание можно оставить фолбэком для не-vision моделей |
| Документ | `docs_analysis` → извлечённый текст | текст как сейчас; либо файл в workspace + путь (тогда агент читает сам) — выбор за этапом 3 |
| Голос / video note | STT (WhisperX → Yandex) → текст | **остаётся бот-стороной**, в DSH идёт текст |
| Пиннед-сообщения | добавляются в каждый контекст | вставка блоком в каждый prompt (в DSH аналога «видно во всех тредах» нет) |
| System prompt чата | `Dialog.prompt` (дата, память, профиль, режим, `config["prompt"]`) | см. «Открытые вопросы» — пер-чатная секция prompt'а |
| Тред | `current_thread_id` в Django | отдельный `session_id` |
| История | Django backend (`/telegram/messages/`) | источник истины — лог DSH; **dual-write** в backend по завершении хода, пока от него зависят RAG (`search_chat_history`), админ-тулы и `/pin` |

### Паритет ответа

Egress не трогаем: `run()` вернул `final_response` → существующий путь `response_to_user` (Markdown-фикс, Rich Message, HTML-фолбэк, футер стоимости). Форматирование и доставка байт-в-байт те же.

Футер стоимости считаем из `usage` в событии `assistant/message` × ботовые `cost_rules` (сами провайдерные расчёты бота `llm/openrouter.py:getOpenRouterCost` уходят вместе с ядром).

## Соответствие возможностей

| Бот | DSH | Комментарий |
|---|---|---|
| `general_search` (Yandex XML + синтез) | `web_search` (в форке уже brave/duckduckgo/tavily) | RU-сегмент: либо форк-провайдер Яндекса (см. [DECISIONS.md](../DECISIONS.md#web-search) — решение не принято), либо MCP-инструмент поверх старого `gen_search` |
| `get_webpage_content` (newspaper3k) | `web_fetch` | штатно |
| `execute_code` (свой песочник) | `bash` / `run_code` в песочнице DSH | своя песочница умирает |
| `memory_*` (backend `/telegram/memory/*`) | MCP memory ([гид](../../docs/user/guide/mcp-memory.md)) либо свой MCP поверх тех же endpoint'ов | второе сохраняет текущие данные и `/memory` |
| `create_reminder`, `schedule_*` (backend) | `schedule_create`… (`dsh-schedule`) | due-напоминание приходит follow-up'ом в сессию → `session.event` → бот шлёт в чат |
| `search_chat_history`, встречи, почта, заказы, hookah | **свой MCP-сервер** (Python, stdio) поверх backend API | один сервер на все ботовые тулы; DSH подключает `mcp-client` строкой в профиле |
| VkusVill MCP | штатный `mcp-client` (streamable-http) | `tools/mcp_proxy.py` умирает |
| `generate_image`, telegraph | в MCP-сервер или ботовые команды `/image` | в DSH image-gen из коробки нет |
| `sub_agent` + `agent_registry` (тулы-агенты) | DSH subagents / MCP | хуковые тулы уже прятаны от основной модели (`hide_tool`) — в DSH это нативное поведение subagent |
| research-режим (fan-out запросов, лимит 10, «last chance») | обычный цикл DSH с `web_search` + subagents | `enable_research/allow_tools` из конфига чата уходят; при желании — маска тулов через `ctx.tools.restrict` форк-плагином |
| Devil's Advocate + `ask_user_question` | `dsh-tool-ask-user` + **свой answerer-плагин** | см. «Открытые вопросы» — по SDK нет канала «вопрос → клиент» |
| `/compact` (саммари → новый тред) | авто-компакция DSH + `/compact` | семантика другая: DSH сжимает историю на месте; ботовую можно эмулировать новой сессией с саммари |
| `/stopresearch`, `/cancel` | — | в SDK-протоколе нет cancel, см. «Открытые вопросы» |
| research-статусы («уточняю детали», «делаю N запрос в интернет») | `session.event` `tool/call` / `tool/result` | см. следующий раздел |
| Пустой ответ → fallback-модель ×3 | `llm-retry` + (в форке) судья model routing | частично нативно |

## Трансляция статуса

Бот не стримит токены (ни одного `stream=True` в `app/`), ответ уходит целиком — попаритетно DSH, где по SDK тоже нет токеновых дельт наружу (`assistant/message` приходит закоммиченным, с вложенным stream'ом с таймингами). Статусы идут по событиям:

| Событие DSH | Действие бота |
|---|---|
| `session.status: running` | запустить цикл `send_chat_action(chat_id, "typing")` каждые ~5 с до `idle` (сейчас typing шлётся один раз перед запросом) |
| `session.event` `tool/call` `web_search` | отредактировать статус-сообщение: «ищу в интернет: query» (как `general_search_handler` сегодня) |
| `session.event` `tool/call` другой тул | отредактировать: фраза из `detalization_text_array` («уточняю детали», «шевелю извилинами»…), аргументы — по желанию |
| `session.event` `tool/result` | обновить счётчик запросов в статусе («с N запросами в интернет») |
| `session.event` `assistant/message` с tool_calls | «формирую финальный ответ...» |
| `session.status: idle` | финальный ответ через существующий egress; статус-сообщение удалить/заменить (как сейчас) |
| `session.event` `turn/end` c error-причиной | «что-то пошло не так, попробуй ещё раз» |
| `subagent.started` / `subagent.finished` | опционально: «делегировал подзадачу…» — нового поведения раньше не было |
| due-напоминание (`schedule`) | сообщение в чат без ввода пользователя |

Статус-сообщение исследование создаётся по `running` (не по первому тулу — раньше research начинался с первого tool_call), правится по каждому `tool/call`, закрывается по `idle`. Массив случайных фраз остаётся бот-стороной.

## Что остаётся в боте

- telebot polling, `need_response`, debounce 3 с, approval-гейт (`approve_`-кнопка), реакции 👀/👍/👎;
- медиа-пре-обработка: STT (голос), `docs_analysis` (документы), опционально vision-описание как фолбэк;
- весь egress: `fix_tg_markdown`, `sendRichMessage`, HTML-файл, фото, футер стоимости;
- команды и клавиатуры: `/config`, `/listmodels`, `/pin`, `/threads`, `/memory`, `/send`, `/list_tasks` — маппинг на DSH-действия и backend;
- dual-write истории в Django (RAG/админ-поиск), треды и память в backend до переезда;
- аудит — без изменений.

Умирает вместе с ядром: `dialog_manager` (кроме подгрузки конфига чата), `get_llm_answer`, `llm/*`, `execute_research`/`execute_tools`/`handle_tool_results`, `tools_registry`, `ai_tools`, `agents/*`, `prompts/agentic.py` (мёртвый код).

## Этапы

- [ ] **0. Спайк.** Один чат, текст без медиа, `DeepSeekHarness.run()`, ответ через текущий egress. Критерий: ответ не хуже текущего на 10 репликах из реальной истории (два прогона: старое ядро vs DSH, глазами).
- [ ] **1. Мост.** Флаг `config["use_harness"]` на чат. Сессии по chat+thread, typing-цикл и статус-сообщения по `session.status`/`tool/call`, футер стоимости из `usage`. Старое ядро остаётся под флагом.
- [ ] **2. Инструменты.** Один MCP-сервер (Python) на backend-тулы: память, расписания, `search_chat_history`, заказы, hookah. Нативные `web_search`/`web_fetch`/`bash` вместо `general_search`/`get_webpage_content`/`execute_code`. VkusVill — штатным `mcp-client`.
- [ ] **3. Медиа.** Фото нативными image-block'ами, документы по выбранной схеме, голос как раньше (текст).
- [ ] **4. Режимы и команды.** `/refreshcontext` → новый session id, `/compact` → выбранная семантика, `/stopresearch` → решение по cancel (ниже), DA-режим → answerer-плагин либо отказ.
- [ ] **5. Переключение.** Dual-run на паре чатов → включение по умолчанию → удаление старого ядра.

## Открытые вопросы

1. **Per-chat system prompt.** `Dialog.prompt` (дата, `<chat_memory>`, профиль, `User System Prompt:` из backend) собирается под каждый чат. Варианты: (а) форк-плагин — свой пакет, на `session/created` маппит session id на чат и вкладывает секцию через `ctx.systemPrompt` (scoped-вклады штатно поддерживаются); (б) склеивать в начало первого prompt'а; (в) пер-чатный workspace с `AGENTS.md`. (а) чистый по правилам форка (новый пакет), но требует конфиг чата внутри рантайма — например, sidecar-файл, который бот пишет при старте чата.
2. **Cancel.** В SDK-протоколе нет ни cancel, ни session-close ([protocol](../../packages/sdk/protocol/README.md#known-limitations-and-deferred-work)) — бросить рантайм значит убить все чаты. `/stopresearch` и `/cancel` пока не работают. Варианты: форк-правка протокола (метода есть в ядре — `agent.cancel`, не проброшена на провод; правка ложится на три апстримных файла: protocol/server/python-client), либо переезд на ACP (там cancel есть, но Python-клиента нет — писать свой).
3. **Ответ на `ask_user_question`.** Сервер→клиент запросы в SDK не реализованы («dead capability»). Для DA-режима нужен форк-плагин с answerer'ом: кладёт вопрос наружу (например, файл в `<DSH_HOME>/questions/`) и ждёт ответный файл — бот следит и отвечает через телеграм-кнопки. Реализуемо новым пакетом без правок ядра, но это отдельная работа.
4. **Per-chat модель.** SDK фиксирует `provider`/`model` в `initialize` на весь процесс (`InitializeParams`), а бот даёт модель из backend на каждый чат (`/listmodels`). Варианты: (а) пул рантаймов по (provider, model) — без правок протокола, цена — память и несколько JSON-RPC соединений; (б) единая модель + model routing форка (`ctx.piAiDispatch` уже перехватывает выбор на уровне запроса, per-session pin делается форк-плагином); (в) согласиться на одну модель. `temperature` в SDK-хендшейке тоже нет — только через профиль-конфиг.
5. **Dual-write истории.** Пока backend кормит RAG и админ-тулы — пишем туда по завершении хода. Когда-нибудь можно переезжать на `session-query`, но это отдельное решение.
6. **Research-инварианты.** Бот лимитирует интернет-запросы (10/сессия) и имеет «last chance»-эскалацию. В DSH лимитов нет — при желании форк-плагин с guard'ом (по духу `ctx.on('tool')`-гейтов), либо принять нативное поведение.

## Риски

- **Паритет ответов** держится на промпте: system prompt DSH (`You are a coding agent powered by the {{model}} model.` + первичные инструкции харнесса) отличается от ботового. Этап 0 обязан это проверять, иначе «отвечать так же» не выполнится.
- **Один рантайм — общая судьба.** Падение `dsh`-процесса останавливает все чаты до перезапуска (SDK переспавнивает при следующем `run()`, сессии переживают). Сегодня ядро падало точечно.
- **Стоимость и лимиты** теперь из usage-событий, а не из провайдерных ответов бота — футер может посчитаться иначе на первых этапах.
