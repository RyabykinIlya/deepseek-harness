# Все плагины форка deepseek-harness

Подключаются через Cordis-загрузчик (встречаются в `name:` конфигов профилей): **244**. Из них входят в базовый профиль `dsh-base`: 93; добавлены форком (нет в `origin/master`): 13.

Метки: ✅ базовый профиль · 🆕 добавлено в форке · · подключается в конкретном профиле.

Описания — первое предложение поля `description` из `package.json`.

## Локальные плагины форка (`.local-plugins/`, не в воркспейсе)

Standalone ESM-бандлы без сборки и без зависимостей: устанавливаются через `dsh plugin add` (npm или GitHub) или остаются локальными. Не входят ни в `packages/`, ни в `pnpm`-воркспейс.

| Плагин | Описание | Меню / слот |
| --- | --- | --- |
| `@local/openrouter-spend` | Host-половина читает реальные списания OpenRouter через management key: `POST /api/v1/analytics/query` (метрики `total_usage`, `request_count`, разрезы по API-ключу и модели, гранулярность день) и `GET /api/v1/credits` для остатка предоплаченного баланса. Отдаёт одно кэшированное резюме на `/openrouter-spend/summary`; ключ хранится/очищается через `credentials` на `/openrouter-spend/credential`. Конфиг: `credentialRef` (по умолчанию `OPENROUTER_MGMT_API_KEY`), `refreshSeconds`, `historyDays`, `apiBase`, `timeoutMs`. Браузерная половина — чип под композером с суммой и раскрывающейся панелью (период 1/7/30 дней, разрез по модели и по ключу, баланс и lifetime) плюс секция настроек для management key, периода обновления и фильтра по ключу. | «OpenRouter spend» — чип в `conversation.composer.dock` и секция в `settings.section` |
| `@local/browser-use-playwright` | Бандл-обёртка: вставляет строку `browser-use` и подключает `dsh-experimental-browser-use-playwright-mcp` в режиме `launch` с `headless: true` — свой headless Chromium на Session, управление через Playwright MCP (навигация, клик, ввод, чтение страниц, скриншоты). Переключение на `mode: attach` с `endpoint` даёт управление уже запущенным браузером. Кода не содержит: только `cordis.patch.yml`, локали и иконка. | Только метаданные для Plugin Manager |


## acp (1)

| Плагин | Описание | |
| --- | --- | --- |
| `@deepseek-ai/dsh-acp` | Automation-only Agent Client Protocol server for driving DeepSeek Harness agents over JSON-RPC stdio | · |

## api (9)

| Плагин | Описание | |
| --- | --- | --- |
| `@deepseek-ai/dsh-api-account-controller` | Expose safe account operations over authenticated Remote | · |
| `@deepseek-ai/dsh-api-gateway` | Typert Remote Host dispatcher and Client API endpoint | ✅ |
| `@deepseek-ai/dsh-api-job-controller` | Job Remote observation stream and the reference-counted client job-output service | · |
| `@deepseek-ai/dsh-api-remotes` | Remote BFF assembly for application-selected Host capabilities | · |
| `@deepseek-ai/dsh-api-session-controller` | Session Remote commands, cold reads, and live control transport | · |
| `@deepseek-ai/dsh-api-settings-controller` | Remote owner for the configuration surfaces over the settings-domain seams | · |
| `@deepseek-ai/dsh-api-terminal-controller` | Session-owned interactive terminals with shell discovery, screen recovery and typed Remote control | · |
| `@deepseek-ai/dsh-api-workspace-controller` | Workspace Remote commands and reconnect-safe state transport | · |
| `@deepseek-ai/dsh-api-workspace-files` | Workspace file service and Client resource provider: bounded reads, directory listing, and live metadata over the workspaceFiles Remote… | · |

## attachment (1)

| Плагин | Описание | |
| --- | --- | --- |
| `@deepseek-ai/dsh-attachment-local` | Private content-addressed DSH_HOME attachment storage | ✅ |

## boot (3)

| Плагин | Описание | |
| --- | --- | --- |
| `@deepseek-ai/dsh-config-editor` | Persist plugin configuration through profile patches and Loader reconciliation | ✅ |
| `@deepseek-ai/dsh-hmr` | Coordinated module and profile configuration hot reload | ✅ |
| `@deepseek-ai/dsh-plugin-manager` | Current-profile plugin and bundle management shared by dsh CLI, Web and agent tools | ✅ |

## browser-use (1)

| Плагин | Описание | |
| --- | --- | --- |
| `@deepseek-ai/dsh-browser-use` | Exclusive named browser-use provider registration | · |

## bundle (4)

| Плагин | Описание | |
| --- | --- | --- |
| `@deepseek-ai/dsh-acp-app` | The dsh ACP profile bundle: automation-only JSON-RPC stdio and process lifecycle over dsh-base | · |
| `@deepseek-ai/dsh-headless` | The dsh one-shot bundle: a direct core Agent/Session runner over dsh-base with no Host, HTTP, or browser layer | · |
| `@deepseek-ai/dsh-sdk-app` | The dsh SDK profile bundle: stdio JSON-RPC serving and process lifecycle over dsh-base | · |
| `@deepseek-ai/dsh-web-app` | The dsh browser-surface bundle: the web patch layer over dsh-base plus the runtime glue plugin (frontend dist serving, web-surface prompt,… | · |

## client (58)

| Плагин | Описание | |
| --- | --- | --- |
| `@deepseek-ai/dsh-client-connection` | Authenticated RPC transport and generation lifecycle | · |
| `@deepseek-ai/dsh-client-file-upload` | Agent-scoped browser file upload, streaming intake, and staged receipt service | · |
| `@deepseek-ai/dsh-client-hmr` | Web client graph synchronization and rebuilt-bundle reload transport | · |
| `@deepseek-ai/dsh-client-locale` | Locale plugin: Host-backed preference, extensible language catalog, browser fallback, and typed built-in dictionaries | · |
| `@deepseek-ai/dsh-client-modules` | Client module system, dual-face: node half composes the __DSH_BOOT__ entry graph (incremental dsh.client scan, bundle route, index tap,… | · |
| `@deepseek-ai/dsh-client-product-analytics` | Desktop product event collection and authenticated Host reporting | · |
| `@deepseek-ai/dsh-client-resources` | Unified client resource model: protocol-registered providers turn URL addresses into live values, consumed through the useResource global… | · |
| `@deepseek-ai/dsh-client-shortcuts` | Application keyboard command registry and physical-key routing | · |
| `@deepseek-ai/dsh-client-ui-agent-preset` | Agent-preset surfaces: the default for later sessions, this session's seat, and the composition editor | · |
| `@deepseek-ai/dsh-client-ui-approval` | Approval composer takeover over the scoped Remote Event waterfall | · |
| `@deepseek-ai/dsh-client-ui-attachment` | Dynamic attachment presentation plugin for conversation input, message-image, and trajectory image slots | · |
| `@deepseek-ai/dsh-client-ui-brand-official` | Official DeepSeek Harness brand occupants for the Web client's sidebar slots | · |
| `@deepseek-ai/dsh-client-ui-chat` | Chat Conversation target, node definitions, renderers, and details surface | · |
| `@deepseek-ai/dsh-client-ui-commands` | Client command surface: global directory cache, '/' source, three command UI kinds, popupSelect registry | · |
| `@deepseek-ai/dsh-client-ui-conversation` | Target-neutral Conversation assembly, shell, composer, queue, and view navigation | · |
| `@deepseek-ai/dsh-client-ui-deliverables` | Changed-files card with per-file comparison tabs, delivery cards, and clickable final-response file references for Web | · |
| `@deepseek-ai/dsh-client-ui-directory-picker-browse` | In-app directory browsing surface: the workspace directory-flow owner rendering the host's listing and creation primitives | · |
| `@deepseek-ai/dsh-client-ui-goal` | Session goal surface: GoalBar docked above the composer, read from the goal session projection | · |
| `@deepseek-ai/dsh-client-ui-input-trigger` | Input trigger pipeline: '/' and '@' detection, candidate menu, pick routing to registered sources | · |
| `@deepseek-ai/dsh-client-ui-jobs` | Session-header background-job list with on-demand streaming record panels | · |
| `@deepseek-ai/dsh-client-ui-layout` | Shell plugin: three-column AppFrame with drag handles, ctx.layout viewing-state service (navigation + panels) | · |
| `@deepseek-ai/dsh-client-ui-message-feedback` | The Web feedback surface: per-message Like/Dislike in the assistant-message action strip and the feedback dialog behind both ratings and… | · |
| `@deepseek-ai/dsh-client-ui-model-selection` | Model selection over the shared model catalog, Session projection, and session.selectModel | · |
| `@deepseek-ai/dsh-client-ui-open-in-app` | Web "Open In..." controls: the Session-header split button opening the workspace directory in an installed application, and the document… | · |
| `@deepseek-ai/dsh-client-ui-permission-presets` | Permission surfaces: a new-session default in General settings and a current-session /permission popup over the permissions projection | · |
| `@deepseek-ai/dsh-client-ui-plan` | Plan mode controls, persistent transcript plan cards, and sidebar Markdown previews | · |
| `@deepseek-ai/dsh-client-ui-plugin-manager` | Plugin management for the dsh web client: the sidebar Plugins panel installs, enables, disables, retries, and composes installed plugin… | · |
| `@deepseek-ai/dsh-client-ui-reference` | Unified Web @file and @session reference source | · |
| `@deepseek-ai/dsh-client-ui-renderer` | Browser UI renderer: React slot bindings, ctx.uiRenderer, and the assembled application root | · |
| `@deepseek-ai/dsh-client-ui-schedule` | Host task management page and Session reminder catalog | · |
| `@deepseek-ai/dsh-client-ui-session` | Session Controller adapter for React and session-scoped slots | · |
| `@deepseek-ai/dsh-client-ui-settings` | Settings domain base plugin: shared configuration forms and the canonical settings slot-type contract | · |
| `@deepseek-ai/dsh-client-ui-settings-account` | Manage DeepSeek login and open Platform billing pages | · |
| `@deepseek-ai/dsh-client-ui-settings-agent-loop` | Settings page of the agent loop on the dsh web client's Plugins page: the parallel tool-call cap of the agent-loop namespace | · |
| `@deepseek-ai/dsh-client-ui-settings-general` | Settings ownerless-copy and product onboarding plugin: the General section, shell trigger/header chrome content, settings dictionaries, and… | · |
| `@deepseek-ai/dsh-client-ui-settings-models` | Models settings and shared product-onboarding dialogs over existing settings and credential joins | · |
| `@deepseek-ai/dsh-client-ui-settings-plugin-inventory` | Read-only Cordis Loader inventory tab in Web Plugins settings | · |
| `@deepseek-ai/dsh-client-ui-settings-plugins` | Built-in plugins settings section for the dsh web client: the Settings navigation entry and the tab chrome feature-owned tabs register into | · |
| `@deepseek-ai/dsh-client-ui-settings-session-log` | General settings control for Session-log upload with DeepSeek API requests | · |
| `@deepseek-ai/dsh-client-ui-settings-shell` | Settings page of the shell executor on the dsh web client's Plugins page: the command timeout and the per-stream output cap of the shell… | · |
| `@deepseek-ai/dsh-client-ui-settings-subagent` | Settings page of Subagent delegation on the dsh web client's Plugins page: recursion depth, parallel capacity, and the models agents may… | · |
| `@deepseek-ai/dsh-client-ui-settings-threads` | Settings page of the Threads presets on the dsh web client's Plugins page: the coordinator check-in and approval knobs and the model every… | 🆕 |
| `@deepseek-ai/dsh-client-ui-settings-web-search` | Settings page of the DeepSeek web-search provider on the dsh web client's Plugins page: its API key, endpoint, and per-request search budget | · |
| `@deepseek-ai/dsh-client-ui-shortcuts` | Keyboard shortcut reference, recording, and local preference editing | · |
| `@deepseek-ai/dsh-client-ui-sidebar` | Sidebar plugin: session multi-level tree, search, grouping, state dots | · |
| `@deepseek-ai/dsh-client-ui-sidebar-browser` | Sandboxed Web browser tabs for the right Sidebar | · |
| `@deepseek-ai/dsh-client-ui-sidebar-documentpreview` | Extensible Sidebar previews for Office documents, spreadsheets, Markdown, code, images, PDF, HTML, and plain text | · |
| `@deepseek-ai/dsh-client-ui-sidebar-files` | Workspace file tree tab type for the right Sidebar: lazy directory listing over the workspaceFiles Remote namespace, opening files into the… | · |
| `@deepseek-ai/dsh-client-ui-sidebar-right` | Right Sidebar: the docking surface's session-bound state, its panel and header expand control, and the navigation service over it | · |
| `@deepseek-ai/dsh-client-ui-sidebar-terminal` | Interactive shell tabs for the right Sidebar | · |
| `@deepseek-ai/dsh-client-ui-skill` | Web skill references and the dedicated skill tool row | · |
| `@deepseek-ai/dsh-client-ui-subagent` | Subagent conversation catalog, continuation routing UI, and '@' reference source | · |
| `@deepseek-ai/dsh-client-ui-theme` | Theme plugin: Host bootstrap for the pre-plugin palette; DOM-free ThemeRuntime for light/dark/system state; | · |
| `@deepseek-ai/dsh-client-ui-tool` | Client Tool call-tree renderer and keyed per-tool presentation slot | · |
| `@deepseek-ai/dsh-client-ui-trajectory` | Trajectory event ledger with an interactive timing overview: pure-consumer plugin registering into the conversation ViewMap (no service) | · |
| `@deepseek-ai/dsh-client-ui-user-questions` | Web ask_user_question composer takeover and plan-review presentation UI | · |
| `@deepseek-ai/dsh-client-ui-workflow-run` | Durable workflow-run Conversation Node and nested member disclosure for dsh web | · |
| `@deepseek-ai/dsh-client-ui-workspace` | Workspace picker plugin: one WorkspacePicker registered into the sidebar and empty-state workspace slots | · |

## compaction (4)

| Плагин | Описание | |
| --- | --- | --- |
| `@deepseek-ai/dsh-command-compact` | Human-facing slash command for explicit session compaction | ✅ |
| `@deepseek-ai/dsh-compaction-basic` | Token-meter-driven compaction policy and LLM summarization backend for the DeepSeek Harness | ✅ |
| `@deepseek-ai/dsh-compaction-image-offload` | Durable image offload for image-capable routes: replace over-budget request images with placeholders and retry | ✅ |
| `@deepseek-ai/dsh-compaction-tool-result-pruner` | Replay-safe model-free head/middle/tail pruning for tool-result surface nodes | ✅ |

## computer-use (1)

| Плагин | Описание | |
| --- | --- | --- |
| `@deepseek-ai/dsh-computer-use` | Exclusive named computer-use provider registration | · |

## context (4)

| Плагин | Описание | |
| --- | --- | --- |
| `@deepseek-ai/dsh-agent-instructions` | Workspace context loader for AGENTS.md/CLAUDE.md instruction files | ✅ |
| `@deepseek-ai/dsh-file-reference-local` | Local-filesystem ctx.fileReferences provider with bounded fuzzy indexes | · |
| `@deepseek-ai/dsh-session-reference` | Cross-session snapshot references and durable untrusted model context (ctx.sessionReferenceResolver) | · |
| `@deepseek-ai/dsh-time-context` | Durable per-step context with the current time and elapsed time | · |

## core (7)

| Плагин | Описание | |
| --- | --- | --- |
| `@deepseek-ai/dsh-agent` | Agent interface, registry, initiator scope, and event vocabulary for the DeepSeek Harness | ✅ |
| `@deepseek-ai/dsh-agent-default-model` | Default model selection shared by Agent entry points | ✅ |
| `@deepseek-ai/dsh-agent-loop` | The concrete agent loop plugin for the DeepSeek Harness | ✅ |
| `@deepseek-ai/dsh-agent-tool-presentation` | Agent-plane presentation selector: composes one agent's tools as PTC mode, native, or both | · |
| `@deepseek-ai/dsh-session` | Event-sourced session store for the DeepSeek Harness | ✅ |
| `@deepseek-ai/dsh-system-prompt` | System prompt assembly registry for the DeepSeek Harness | ✅ |
| `@deepseek-ai/dsh-tools` | Tool registry and execution pipeline for the DeepSeek Harness | ✅ |

## credentials (3)

| Плагин | Описание | |
| --- | --- | --- |
| `@deepseek-ai/dsh-authorization` | Authorization seam (ctx.authorization): plugin-owned flows that obtain a credential through a conversation with the human | ✅ |
| `@deepseek-ai/dsh-credentials-local` | File-backed credentials provider ($DSH_HOME/.env under the live process environment) for the DeepSeek Harness | ✅ |
| `@deepseek-ai/dsh-deepseek-account-platform` | Authorize DeepSeek accounts through browser PKCE | ✅ |

## deliverables (2)

| Плагин | Описание | |
| --- | --- | --- |
| `@deepseek-ai/dsh-tool-present` | Explicit workspace file delivery declarations for the DeepSeek Harness | · |
| `@deepseek-ai/dsh-workspace-changes` | Per-turn workspace file changes recorded from git working-tree snapshots and whole-file captures, with per-file comparisons, for the… | · |

## document (1)

| Плагин | Описание | |
| --- | --- | --- |
| `@deepseek-ai/dsh-office-to-pdf` | Shared Office-to-PDF conversion with bounded queues and caching | · |

## experimental (22)

| Плагин | Описание | |
| --- | --- | --- |
| `@deepseek-ai/dsh-experimental-agent-team` | Implicit-root Agent Teams roster, durable peer mailbox, and shared task DAG | · |
| `@deepseek-ai/dsh-experimental-api-speech-to-text` | Authenticated experimental speech transcription for browser clients | · |
| `@deepseek-ai/dsh-experimental-auto-review` | Per-tool LLM authorization review for the DeepSeek Harness Auto permission preset | · |
| `@deepseek-ai/dsh-experimental-browser-use-playwright-mcp` | Experimental per-Session Chromium browser tools through @playwright/mcp | · |
| `@deepseek-ai/dsh-experimental-claude-code-mods` | Experimental bridge: load Claude Code mods (hooks modules) and run their hook chains on DeepSeek Harness extension points | · |
| `@deepseek-ai/dsh-experimental-client-ui-agent-team` | Web Agent Teams roster, task board, and teammate navigation | · |
| `@deepseek-ai/dsh-experimental-client-ui-model-routing` | Composer chip, settings page, and Thread roster entry for the tiers model route on the dsh web client | 🆕 |
| `@deepseek-ai/dsh-experimental-client-ui-project-memory` | Settings page of the Project memory caps on the dsh web client's Plugins page: how many entries a Project keeps and how long each one may be | · |
| `@deepseek-ai/dsh-experimental-client-ui-threads` | Session-header Thread roster for a Project Session, and the addressed Thread chat resource | 🆕 |
| `@deepseek-ai/dsh-experimental-client-ui-voice-input` | Record speech and insert editable text into the conversation draft | · |
| `@deepseek-ai/dsh-experimental-computer-use-cua-driver-mcp` | Experimental computer use through an installed Cua Driver MCP executable | · |
| `@deepseek-ai/dsh-experimental-inspector` | Experimental cross-realm CDP hub for Host debugging and Client Runtime inspection | · |
| `@deepseek-ai/dsh-experimental-model-routing` | Tier-based OpenRouter model routing: cheapest qualifying model and upstream provider per tier | 🆕 |
| `@deepseek-ai/dsh-experimental-project-memory` | Host-side shared memory for a Project and the memory_read / memory_write tools | 🆕 |
| `@deepseek-ai/dsh-experimental-ptc-runtime-python` | CPython subprocess implementation of the DeepSeek Harness PTC execution seam | · |
| `@deepseek-ai/dsh-experimental-session-inspector` | Experimental virtualized Session log and live Chat group/node inspectors | · |
| `@deepseek-ai/dsh-experimental-speech-to-text` | Experimental speech recognition with independently selectable providers | · |
| `@deepseek-ai/dsh-experimental-speech-to-text-sensevoice` | Local SenseVoice ONNX transcription with a managed sherpa-onnx process | · |
| `@deepseek-ai/dsh-experimental-threads` | Log-only Thread events and the per-session threads projection for a Project Session | 🆕 |
| `@deepseek-ai/dsh-experimental-threads-preset` | The Project and Thread agent presets: a coordinator that starts worktree-isolated Threads and a worker contract for the Threads themselves | 🆕 |
| `@deepseek-ai/dsh-experimental-threads-tool` | Bounded thread_status and thread_diff tools over the per-session threads projection | 🆕 |
| `@deepseek-ai/dsh-experimental-tool-agent-team` | Scoped model-facing Agent Teams tools over ctx.agentTeams | · |

## extensions (4)

| Плагин | Описание | |
| --- | --- | --- |
| `@deepseek-ai/dsh-client-ui-cordis` | Cordis dynamic-plugin definition card: the keyed cordis_define tool row with its run/stop switch | · |
| `@deepseek-ai/dsh-cordis-client-runner` | Browser half of dynamic dual-half plugin packages: event subscription, closure evaluation, guard facade, and loader entries | · |
| `@deepseek-ai/dsh-cordis-host-runner` | Dynamic package definition registry, host-half sandbox lifecycle, and invoke handler table for model-mounted dual-half packages | · |
| `@deepseek-ai/dsh-tool-cordis` | Read-only runtime API inspection for Harness plugin development | · |

## feedback (2)

| Плагин | Описание | |
| --- | --- | --- |
| `@deepseek-ai/dsh-command-feedback` | Log-only session feedback: the record event, the sessionFeedback Host Remote, and the human-facing slash command | ✅ |
| `@deepseek-ai/dsh-message-feedback` | Canonical Session-log ratings and notes for finalized assistant messages | · |

## fs (6)

| Плагин | Описание | |
| --- | --- | --- |
| `@deepseek-ai/dsh-fs-local` | Local-filesystem implementation of the DeepSeek Harness filesystem seam (ctx.fs) | · |
| `@deepseek-ai/dsh-fs-observation-policy` | File-context policy plugin for the DeepSeek Harness — observed-state, read-before-edit, and version-guarded write/edit added over the… | ✅ |
| `@deepseek-ai/dsh-fs-sandbox` | Sandbox-enforcing implementation of the DeepSeek Harness filesystem seam: fences write/edit by the per-call sandbox mode (read-only denies… | ✅ |
| `@deepseek-ai/dsh-tool-fs` | Model-facing filesystem tools (read, write, edit) over the DeepSeek Harness filesystem seam (ctx.fs) | ✅ |
| `@deepseek-ai/dsh-tool-fs-search` | Model-facing filesystem discovery tools (glob, grep) backed by the packaged ripgrep binary (@vscode/ripgrep) | ✅ |
| `@deepseek-ai/dsh-tool-str-replace-editor` | Model-facing view, create, literal replace, and line insert tool over the Harness filesystem service | · |

## goal (4)

| Плагин | Описание | |
| --- | --- | --- |
| `@deepseek-ai/dsh-command-goal` | Human-facing slash command for persisted same-session goals | ✅ |
| `@deepseek-ai/dsh-goal` | Event-sourced same-session goal state and lifecycle service for the DeepSeek Harness | ✅ |
| `@deepseek-ai/dsh-goal-round-driver` | Race-fenced same-session goal-round driver | ✅ |
| `@deepseek-ai/dsh-tool-goal` | Model-facing same-session goal tools with execution-time authority checks | ✅ |

## guard (2)

| Плагин | Описание | |
| --- | --- | --- |
| `@deepseek-ai/dsh-repeat-tool-reminder` | Repeat-tool-call guard plugin: advisory reminders when an agent loops on identical tool calls | ✅ |
| `@deepseek-ai/dsh-tool-call-timeout-policy` | Tool-call timeout policy: a tools/execute wrapper that arms a per-tool deadline on exec.signal and returns TOOL_TIMEOUT when it wins | ✅ |

## hooks (2)

| Плагин | Описание | |
| --- | --- | --- |
| `@deepseek-ai/dsh-hooks-claude-code` | Bridge plugin: run a Claude Code hooks.json / settings hook config on the DeepSeek Harness interception seams | · |
| `@deepseek-ai/dsh-hooks-codex` | Bridge plugin: run a Codex hooks.json hook config on the DeepSeek Harness interception seams | · |

## host (6)

| Плагин | Описание | |
| --- | --- | --- |
| `@deepseek-ai/dsh-host-directory-picker-auto` | Adaptive chooser of the directory-picker seam: resolves the host situation at boot and mounts the native or browse backend for the DeepSeek… | · |
| `@deepseek-ai/dsh-host-directory-picker-browse` | In-app browsing backend of the directory-picker seam (listing/creation primitives over the host filesystem) | · |
| `@deepseek-ai/dsh-host-open-in-app` | Host half of open-in-app: resolved application catalog, icons, and the launch endpoint as three webServer routes | · |
| `@deepseek-ai/dsh-host-plugin-inventory` | Read-only Remote projection of current Cordis Loader plugin state | · |
| `@deepseek-ai/dsh-host-product-telemetry-otel` | Explicit product usage events exported through OpenTelemetry HTTP logs | · |
| `@deepseek-ai/dsh-host-webserver` | Web route-registration plugin: HTTP and upgrade routes, index transform taps, and static dist fallback; | · |

## interaction (5)

| Плагин | Описание | |
| --- | --- | --- |
| `@deepseek-ai/dsh-commands` | Plugin-owned human command registry for DeepSeek Harness UIs | ✅ |
| `@deepseek-ai/dsh-permission-presets` | User-facing permission presets (ctx.permissionPresets) for the DeepSeek Harness: one product-level Permissions select bundling the… | ✅ |
| `@deepseek-ai/dsh-tool-ask-user` | Model-facing ask_user_question tool over the ctx.userQuestions seam | · |
| `@deepseek-ai/dsh-user-approval` | User-approval seam (ctx.approval) for the DeepSeek Harness: one-shot permission decisions dispatched to composed answerers over the… | ✅ |
| `@deepseek-ai/dsh-user-questions` | Abstract user-questions seam (ctx.userQuestions) for asking the human during agent runs | ✅ |

## jobs (2)

| Плагин | Описание | |
| --- | --- | --- |
| `@deepseek-ai/dsh-jobs-local` | Process-local implementation of the DeepSeek Harness background job registry seam | ✅ |
| `@deepseek-ai/dsh-tool-jobs` | Model-facing background job control tools (job_output, job_list, job_kill) over the ctx.jobs registry | ✅ |

## llm (8)

| Плагин | Описание | |
| --- | --- | --- |
| `@deepseek-ai/dsh-deepseek-llm-api-extensions` | Additive request-field registry for the official DeepSeek LLM API adapter | ✅ |
| `@deepseek-ai/dsh-llm` | Provider-neutral LLM service interface for the DeepSeek Harness | ✅ |
| `@deepseek-ai/dsh-llm-deepseek-account` | DeepSeek account provider authentication and discovery | ✅ |
| `@deepseek-ai/dsh-llm-deepseek-api-key` | DeepSeek api-key provider authentication and discovery | ✅ |
| `@deepseek-ai/dsh-llm-pi-ai` | pi-ai-backed DeepSeek adapter for the DeepSeek Harness LLM seam (design-verification twin of dsh-llm-deepseek) | ✅ |
| `@deepseek-ai/dsh-llm-retry` | Provider-routed LLM request retry policy for the DeepSeek Harness | ✅ |
| `@deepseek-ai/dsh-plugin-package-inventory-deepseek` | Active Loader-backed plugin package inventory for official DeepSeek LLM API requests | ✅ |
| `@deepseek-ai/dsh-token-meter` | Replay-aware token measurement service (ctx.tokenMeter) for the DeepSeek Harness | ✅ |

## lsp (3)

| Плагин | Описание | |
| --- | --- | --- |
| `@deepseek-ai/dsh-lsp` | Abstract LSP capability seam (ctx.lsp) for the DeepSeek Harness — language-server provider registry keyed by branded id and extension… | · |
| `@deepseek-ai/dsh-lsp-stdio` | Generic stdio language-server provider for the DeepSeek Harness LSP capability seam (ctx.lsp) — spawns configured servers, translates… | · |
| `@deepseek-ai/dsh-tool-lsp` | Model-facing lsp tool over the DeepSeek Harness LSP capability seam (ctx.lsp) — one read-only tool with… | · |

## mcp (2)

| Плагин | Описание | |
| --- | --- | --- |
| `@deepseek-ai/dsh-mcp-client` | MCP client bridge: connects to MCP servers and registers their tools on ctx.tools | · |
| `@deepseek-ai/dsh-mcp-resources` | Scoped MCP resource discovery and reading through shared model tools | ✅ |

## plan (1)

| Плагин | Описание | |
| --- | --- | --- |
| `@deepseek-ai/dsh-plan-mode` | Logged per-agent plan mode with deployment guidance, a direct slash command, and a user-reviewed exit | ✅ |

## preset (3)

| Плагин | Описание | |
| --- | --- | --- |
| `@deepseek-ai/dsh-agent-preset` | Declare an Agent capability composition in Cordis YAML | · |
| `@deepseek-ai/dsh-agent-preset-registry` | Declarative Agent preset registry and profile-backed editing | · |
| `@deepseek-ai/dsh-persona` | Composition-authored deployment persona section for the DeepSeek Harness | · |

## ptc-runtime (1)

| Плагин | Описание | |
| --- | --- | --- |
| `@deepseek-ai/dsh-ptc-runtime-node` | Sandboxed Node process implementation of the DeepSeek Harness PTC execution capability | ✅ |

## sandbox (2)

| Плагин | Описание | |
| --- | --- | --- |
| `@deepseek-ai/dsh-sandbox-local` | Local process-sandbox backends for the DeepSeek Harness sandbox seam: bwrap, the npm-distributed landlock-run launcher, macOS Seatbelt, or… | ✅ |
| `@deepseek-ai/dsh-sandbox-policy` | Per-call sandbox policy resolver and current model context: deployment fallbacks plus each session's mode and workspace root, shared by… | ✅ |

## schedule (2)

| Плагин | Описание | |
| --- | --- | --- |
| `@deepseek-ai/dsh-schedule` | Host-wide durable reminders with shared management and original-Session delivery | · |
| `@deepseek-ai/dsh-tool-schedule` | Model-facing reminder management tools (schedule_create, schedule_list, schedule_update, schedule_delete) over the Host ctx.schedule service | · |

## sdk (1)

| Плагин | Описание | |
| --- | --- | --- |
| `@deepseek-ai/dsh-sdk-jsonrpc-server` | Stdio JSON-RPC server plugin for out-of-process DeepSeek Harness SDK clients | · |

## session (10)

| Плагин | Описание | |
| --- | --- | --- |
| `@deepseek-ai/dsh-session-checkpoint-policy` | Semantic session durability checkpoints before model requests and tool side effects | ✅ |
| `@deepseek-ai/dsh-session-log-deepseek` | Incremental lossless session-log request extension for the official DeepSeek LLM API | ✅ |
| `@deepseek-ai/dsh-session-persistence-jsonl` | JSONL durable session persistence backend for the DeepSeek Harness | ✅ |
| `@deepseek-ai/dsh-session-projection` | Session-projection seam: the merge-extensible projection type table, the provider contract, and the ctx.sessionProjections registry serving… | ✅ |
| `@deepseek-ai/dsh-session-projection-cache` | Persisted projection cache (ctx.sessionProjectionCache): durable per-session checkpoint records on the session_projcache storage domain… | ✅ |
| `@deepseek-ai/dsh-session-stats` | Whole-log conversation counts and wall times projection (sessionStats) for the DeepSeek Harness | · |
| `@deepseek-ai/dsh-session-telemetry-otel` | Feedback-authorized Session logs over byte-bounded OpenTelemetry HTTP requests | ✅ |
| `@deepseek-ai/dsh-session-title` | Log-backed session title service and provider registry for the DeepSeek Harness | ✅ |
| `@deepseek-ai/dsh-session-title-first-prompt-llm` | First-message LLM provider plugin for DeepSeek Harness session titles | ✅ |
| `@deepseek-ai/dsh-session-turn-outline` | Whole-log turn outline projection (turnOutline) for the DeepSeek Harness | · |

## session-query (3)

| Плагин | Описание | |
| --- | --- | --- |
| `@deepseek-ai/dsh-session-log-export` | Web Session-log export command and shared download dialog | · |
| `@deepseek-ai/dsh-session-query-sqlite` | Concrete ctx.sessionQuery backend with SQLite FTS5 search | ✅ |
| `@deepseek-ai/dsh-tool-session-query` | Workspace-authorized model-facing session history search, trace, and event read tools | · |

## settings (1)

| Плагин | Описание | |
| --- | --- | --- |
| `@deepseek-ai/dsh-settings` | Abstract user-settings seam (ctx.settings) for the DeepSeek Harness | ✅ |

## shell (9)

| Плагин | Описание | |
| --- | --- | --- |
| `@deepseek-ai/dsh-bash-local` | Local-subprocess implementation of the DeepSeek Harness bash executor seam | · |
| `@deepseek-ai/dsh-bash-sandbox` | Sandbox-consuming implementation of the DeepSeek Harness bash executor seam (confines every command via ctx.sandbox, reports… | ✅ |
| `@deepseek-ai/dsh-pwsh-local` | Local PowerShell implementation of the DeepSeek Harness bash executor seam | · |
| `@deepseek-ai/dsh-pwsh-sandbox` | Sandbox-consuming implementation of the DeepSeek Harness PowerShell executor seam (confines every command via ctx.sandbox, reports… | ✅ |
| `@deepseek-ai/dsh-shell-env` | Tool-independent managed DSH_* shell environment registry | ✅ |
| `@deepseek-ai/dsh-tool-bash` | Model-facing bash tool with optional generic background-job and sandbox-escalation support | ✅ |
| `@deepseek-ai/dsh-tool-bash-persistent` | Model-facing owner-scoped persistent Bash tool backed by the Harness PTY service | · |
| `@deepseek-ai/dsh-tool-pwsh` | Model-facing pwsh tool over the bash executor seam | ✅ |
| `@deepseek-ai/dsh-tool-pwsh-persistent` | Model-facing owner-scoped persistent PowerShell tool backed by the Harness PTY service | · |

## skill (6)

| Плагин | Описание | |
| --- | --- | --- |
| `@deepseek-ai/dsh-skill` | Agent skill provider registry for the DeepSeek Harness | ✅ |
| `@deepseek-ai/dsh-skill-badge` | Bundled dsh badge skill provider for DeepSeek Harness | ✅ |
| `@deepseek-ai/dsh-skill-filesystem` | Local filesystem skill provider for the DeepSeek Harness | ✅ |
| `@deepseek-ai/dsh-skill-office` | Bundled Word, PowerPoint, and Excel workflows and structural checks | · |
| `@deepseek-ai/dsh-tool-skill` | Model-facing skill loading tool for the DeepSeek Harness | ✅ |
| `@deepseek-ai/dsh-tool-workspace-dependencies` | The load_workspace_dependencies tool: absolute paths into a bundled Python, Node.js, and pnpm payload | · |

## spill (2)

| Плагин | Описание | |
| --- | --- | --- |
| `@deepseek-ai/dsh-spill-local` | Local-filesystem implementation of the DeepSeek Harness spill storage seam (private session-scoped files) | ✅ |
| `@deepseek-ai/dsh-spill-policy` | Token-budgeted tool-result retention with recoverable text and image paths | ✅ |

## storage (3)

| Плагин | Описание | |
| --- | --- | --- |
| `@deepseek-ai/dsh-storage` | Storage hub (ctx.storage): named backend registry plus mounted data-form facilities for the DeepSeek Harness | ✅ |
| `@deepseek-ai/dsh-storage-domain` | Domain data form (ctx.storage.domain): schema-validated, event-emitting KV domains over storage backends for the DeepSeek Harness | ✅ |
| `@deepseek-ai/dsh-storage-json` | JSON file KV storage backend for the DeepSeek Harness storage hub | ✅ |

## subagent (11)

| Плагин | Описание | |
| --- | --- | --- |
| `@deepseek-ai/dsh-subagent` | Abstract subagent seam (ctx.subagents): named-provider registry for delegating to child agents | ✅ |
| `@deepseek-ai/dsh-subagent-acp` | Out-of-process ACP subagent backend: drives a child agent in a spawned subprocess over the Agent Client Protocol | · |
| `@deepseek-ai/dsh-subagent-claude-code` | One-shot Claude Code subagent provider over the official Agent SDK | · |
| `@deepseek-ai/dsh-subagent-codex` | One-shot Codex subagent provider over the official app-server protocol | · |
| `@deepseek-ai/dsh-subagent-dsh-sdk` | Out-of-process SDK subagent backend: drives a child DeepSeek Harness runtime subprocess over stdio JSON-RPC through the TypeScript SDK… | · |
| `@deepseek-ai/dsh-subagent-fork-in-process` | In-process fork subagent backend: runs a child agent seeded with a prefix of the parent's log | ✅ |
| `@deepseek-ai/dsh-subagent-spawn-in-process` | In-process spawn subagent backend: runs a fresh child agent on ctx.agents | ✅ |
| `@deepseek-ai/dsh-subagent-thread-worktree` | Worktree-isolated continuable subagent backend: every child runs in its own git worktree | 🆕 |
| `@deepseek-ai/dsh-tool-subagent` | Model-facing subagent delegation tool over the ctx.subagents seam | ✅ |
| `@deepseek-ai/dsh-tool-subagent-control` | Globally named send_message, interrupt_agent, and list_agents tools over ctx.subagents continuations | ✅ |
| `@deepseek-ai/dsh-worktree-manager` | Host service that manages git worktrees for background Threads (ctx.worktrees) | 🆕 |

## subprocess (1)

| Плагин | Описание | |
| --- | --- | --- |
| `@deepseek-ai/dsh-subprocess-local` | Local-subprocess implementation of the DeepSeek Harness subprocess seam | ✅ |

## telemetry (1)

| Плагин | Описание | |
| --- | --- | --- |
| `@deepseek-ai/dsh-otel` | Cordis service for independent ordinary-event and byte-bounded Session-log OTLP channels | ✅ |

## terminal (3)

| Плагин | Описание | |
| --- | --- | --- |
| `@deepseek-ai/dsh-terminal` | Persistent PTY session seam for the DeepSeek Harness — owner-scoped ids, backend registry, interactive sends, reads, signals, and awaited… | · |
| `@deepseek-ai/dsh-terminal-bash` | Persistent shell PTY backend over the DeepSeek Harness subprocess terminal primitive | · |
| `@deepseek-ai/dsh-tool-terminal` | Six model-facing persistent PTY tools with owner isolation and generic background-job integration | · |

## test-support (1)

| Плагин | Описание | |
| --- | --- | --- |
| `@deepseek-ai/dsh-llm-replay` | Replay LLM plugin: short-circuits llm/stream with model chunks reconstructed from a recorded session JSONL (keyless snapshot tests) | · |

## todo (1)

| Плагин | Описание | |
| --- | --- | --- |
| `@deepseek-ai/dsh-tool-todo` | Model-facing todo_write tool over the DeepSeek Harness event-sourced session log | ✅ |

## typert (2)

| Плагин | Описание | |
| --- | --- | --- |
| `@deepseek-ai/dsh-typert-loader` | Loader integration for generated Typert package contributions | ✅ |
| `@deepseek-ai/dsh-typert-registry` | Runtime registry for generated package reflection and Zod schemas | ✅ |

## web (7)

| Плагин | Описание | |
| --- | --- | --- |
| `@deepseek-ai/dsh-tool-web` | Model-facing web tools (web_search, web_fetch) over the DeepSeek Harness web capability seam (ctx.web) | ✅ |
| `@deepseek-ai/dsh-web` | Abstract web access capability seam (ctx.web) for the DeepSeek Harness — search/fetch provider registry, registration-order-independent… | ✅ |
| `@deepseek-ai/dsh-web-fetch-http` | Anonymous public HTTP(S) fetch provider for the DeepSeek Harness web capability seam (ctx.web) | ✅ |
| `@deepseek-ai/dsh-web-search-brave` | Brave Search-backed search provider for the DeepSeek Harness web capability seam (ctx.web) | ✅🆕 |
| `@deepseek-ai/dsh-web-search-deepseek` | DeepSeek-backed search provider (native web_search via the Anthropic-compatible API) for the DeepSeek Harness web capability seam (ctx.web) | ✅ |
| `@deepseek-ai/dsh-web-search-duckduckgo` | Keyless DuckDuckGo search provider for the DeepSeek Harness web capability seam (ctx.web) | ✅🆕 |
| `@deepseek-ai/dsh-web-search-tavily` | Tavily-backed search provider for the DeepSeek Harness web capability seam (ctx.web) | ✅🆕 |

## webhook (2)

| Плагин | Описание | |
| --- | --- | --- |
| `@deepseek-ai/dsh-webhook` | Fire-and-forget webhook rule runtime that creates Workspace-backed DeepSeek Harness Sessions | · |
| `@deepseek-ai/dsh-webhook-github` | Signed GitHub HTTP webhook adapter for the DeepSeek Harness webhook runtime | · |

## workflow (3)

| Плагин | Описание | |
| --- | --- | --- |
| `@deepseek-ai/dsh-tool-ralph` | Model-facing fresh-agent Ralph loop over the workflow and subagent seams | ✅ |
| `@deepseek-ai/dsh-tool-workflow` | Model-facing workflow tool: run a JavaScript orchestration script over ctx.workflowEngine | ✅ |
| `@deepseek-ai/dsh-workflow-ptc` | Workflow orchestration in the shared sandboxed Node PTC runtime | ✅ |

## workspace (1)

| Плагин | Описание | |
| --- | --- | --- |
| `@deepseek-ai/dsh-workspace` | Workspace entity registry (ctx.workspaceRegistry): durable workspace records with validated session attachment over the domain data form… | · |
