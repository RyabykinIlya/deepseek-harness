# Базовая линия перед мержем upstream dsh-v0.2.2-rc.1

Замерено 2026-11-04. Снято в worktree форка перед мержем апстрима
`dsh-v0.2.2-rc.1` — чтобы пост-мерж регрессии были атрибутируемыми:
все ниже — **до** мержа, уже существующие состояния.

## 1. Окружение

- HEAD: `c2b6e7764e wip(model-routing): targetKind pin tracking and plugin-loader deps`
- Node v22.19.0 (repo требует `>=24.9.0` — warning при каждой команде)
- pnpm 11.28.5
- `pnpm-lock.yaml` присутствует (1 219 904 байт)

## 2. Гейты

| Гейт | Результат | Время |
|---|---|---|
| `pnpm install` | ✅ (с обходом: `pnpm install --store-dir=/tmp/pnpm-store-$$`, ~60 с) | 60 с |
| `pnpm run typecheck` | ✅ 5/5 gates passed | 4м 30с |
| `pnpm run lint` | ❌ 2 errors, 1 warning | 2м 26с |
| `pnpm run test` | ❌ 63 файла упали из 2597; 267 отдельных тестов упало | 16м 50с |
| `pnpm run build` | ⏸ пропущен — приоритет отданы гейтам выше; сборка после мержа | — |

Примечание по `pnpm install`: штатный вызов упал с
`[ERR_SQLITE_ERROR] unable to open database file` (недоступный
pnpm store под `/home/ilya/.local/share/pnpm/store/v11`). Повтор с
изолированным `--store-dir=/tmp/pnpm-store-$$` прошёл: все 411
workspace-проектов, 1431 пакет. Это окруженческая проблемa, а не состояние дерева.

### 2.1. Lint — уже красные (предсуществующий долг)

2 ошибки:

1. `@stylistic(quotes)` — двойные кавычки вместо одинарных:
   `packages/experimental/client-ui-model-routing/src/client/locales.ts:317`
   (`judgeEnabled: "Choisir le palier automatiquement"`).
2. `typescript(no-unnecessary-type-conversion)` —
   `packages/boot/plugin-market/tests/repository-cache.spec.ts:162`
   (`String((deadlined as Error).message)` — выражение уже `string`).

1 warning: неиспользуемая директива `oxlint-disable`
(`packages/experimental/client-ui-cot-translation/src/index.ts:82`).

### 2.2. Тесты — предсуществующие падения environment/sandbox

2597 тестовых файлов: **2534 passed, 63 failed**. Индивидуальных тестов
упало **267**. Полный лог — в выводе задачи; Ниже разобранные группы.

**EROFS / read-only /tmp и домашний каталог (sandbox, не регрессия):**

- `packages/workflow/workflow-ptc/tests/egress.spec.ts`
- `packages/workflow/workflow-ptc/tests/integration.spec.ts` (3 теста)
- `packages/workflow/workflow-ptc/tests/source-runtime.compat.spec.ts`
- `packages/ptc-runtime/ptc-runtime-node/tests/runtime.spec.ts` (28 из 29)
- `packages/ptc-runtime/ptc-runtime-node/tests/persistent-sandbox.spec.ts` (11 из 11)
- `packages/experimental/ptc-runtime-python/tests/sandbox.spec.ts` (28 из 30)

**worktree-manager / git worktree в sandboxed git (известный рантайм):**

- `packages/subagent/worktree-manager/tests/merge-check.spec.ts` —
  `expected { supported: false } to deeply equal { supported: true }`
- `packages/subagent/worktree-manager/tests/clone-worktrees.spec.ts`
- `packages/experimental/worktree/tests/checkout-safety.spec.ts`
- `packages/experimental/worktree/tests/worktree.spec.ts`

**其他環境 (платформенные/внешние):**

- Zsh promпt и shell-activity: `packages/subprocess/subprocess-local/tests/shell-activity.spec.ts`
  (`expected '' to contain 'READY>'` — zsh environment)
- subprocess egress proxy: `packages/subprocess/subprocess/tests/egress.spec.ts`
- locale-dictionary-parity: `scripts/locale-dictionary-parity.spec.ts`
- migrate-sessions-to-v4: `scripts/migrate-sessions-to-v4.spec.ts`
- threads-preset tier-preset: `packages/experimental/threads-preset/tests/tier-preset.spec.ts` (3 failed)
- threads-profile real-composition: `packages/experimental/threads-profile/tests/real-composition.spec.ts`
- threads-profile profile: `packages/experimental/threads-profile/tests/profile.spec.ts`
- native-command: `file-applications-linux-native.spec.ts`, `file-applications.spec.ts`,
  `path-opener.spec.ts` (platform expectations)
- client ui-theme: `menu-surfaces.client.spec.ts`, `elevation-styles.client.spec.ts`
- client ui-settings-account apply: `packages/client/ui-settings-account/tests/apply.client.spec.ts`
  (timing flake)
- И ещё ~30 файлов (scripts/*, apps/desktop, packages/*) — полный список
  ниже.

**Полный список 63 упавших файлов:**

```
thread-safe:packages/experimental/ptc-runtime-python/tests/runtime.spec.ts
process-bound:packages/workflow/workflow-ptc/tests/workflow-ptc.spec.ts
thread-safe:packages/boot/plugin-manager/tests/manager.spec.ts
thread-safe:apps/desktop/tests/main-startup.spec.ts
thread-safe:scripts/ci-workflow.spec.ts
thread-safe:packages/experimental/client-ui-forge/tests/controller.host.spec.ts
thread-safe:scripts/verify-package-dependencies.spec.ts
thread-safe:packages/api/terminal-controller/tests/controller.spec.ts
thread-safe:packages/client/ui-settings-account/tests/apply.client.spec.ts
thread-safe:scripts/install-lefthook.spec.ts
thread-safe:scripts/project-doc-site.spec.ts
thread-safe:scripts/persistence-schema.spec.ts
thread-safe:packages/host/open-in-app/tests/resolver.spec.ts
thread-safe:packages/experimental/threads-preset/tests/project-preset.spec.ts
thread-safe:packages/deliverables/workspace-changes/tests/plugin.spec.ts
thread-safe:packages/experimental/worktree/tests/worktree.spec.ts
thread-safe:packages/llm/token-meter/tests/token-meter.spec.ts
thread-safe:scripts/release/families.spec.ts
thread-safe:packages/util/native-command/tests/path-opener.spec.ts
thread-safe:packages/client/ui-deliverables/tests/review-tab.client.spec.tsx
thread-safe:scripts/migrate-sessions-to-v4.spec.ts
thread-safe:scripts/locale-dictionary-parity.spec.ts
thread-safe:packages/ptc-runtime/ptc-runtime-node/tests/runtime.spec.ts
thread-safe:packages/terminal/terminal-bash/tests/local.spec.ts
thread-safe:packages/experimental/ptc-runtime-python/tests/sandbox.spec.ts
thread-safe:packages/client/ui-settings-general/tests/apply.client.spec.ts
thread-safe:scripts/compile-referenced-projects.spec.ts
thread-safe:packages/experimental/threads-profile/tests/real-composition.spec.ts
thread-safe:packages/experimental/threads-profile/tests/profile.spec.ts
thread-safe:scripts/release/pack.spec.ts
thread-safe:packages/ssh/ssh/tests/helper-boundaries.spec.ts
thread-safe:packages/client/ui-theme/tests/elevation-styles.client.spec.ts
thread-safe:packages/client/connection/tests/binary-rpc.host.spec.ts
thread-safe:packages/experimental/liveshare/tests/write-current-policy.spec.ts
thread-safe:apps/desktop/tests/macos-notarization-proxy.spec.ts
thread-safe:packages/subagent/worktree-manager/tests/clone-worktrees.spec.ts
thread-safe:packages/experimental/worktree/tests/checkout-safety.spec.ts
thread-safe:scripts/gen-client-catalog.spec.ts
thread-safe:packages/fs/fs-sandbox/tests/fs-sandbox.spec.ts
thread-safe:packages/util/native-command/tests/file-applications.spec.ts
thread-safe:packages/experimental/threads-preset/tests/tier-preset.spec.ts
thread-safe:packages/ptc-runtime/ptc-runtime-node/tests/persistent-sandbox.spec.ts
thread-safe:apps/desktop/tests/prepare-runtime-patches.spec.ts
thread-safe:packages/ptc-runtime/ptc-runtime-node/tests/vm-script.spec.ts
thread-safe:packages/core/agent-loop/tests/resource-lifecycle.spec.ts
thread-safe:packages/subprocess/subprocess-local/tests/shell-activity.spec.ts
thread-safe:packages/core/tools/tests/gen-tool-catalog.spec.ts
thread-safe:packages/subagent/worktree-manager/tests/merge-check.spec.ts
thread-safe:packages/experimental/browser-use-stagehand-native/tests/loader-composition.spec.ts
thread-safe:packages/subprocess/subprocess/tests/egress.spec.ts
thread-safe:packages/client/ui-theme/tests/menu-surfaces.client.spec.ts
thread-safe:scripts/build.spec.ts
thread-safe:scripts/release/verify-packed-install.spec.ts
thread-safe:packages/workflow/workflow-ptc/tests/integration.spec.ts
thread-safe:packages/client/ui-sidebar-right/tests/expand-button.client.spec.tsx
thread-safe:scripts/snapshot-workspace-parent.spec.ts
thread-safe:apps/desktop/tests/purge-command.spec.ts
thread-safe:packages/typert/generator/tests/tools-catalog.spec.ts
thread-safe:packages/util/native-command/tests/file-applications-linux-native.spec.ts
thread-safe:packages/workflow/workflow-ptc/tests/source-runtime.compat.spec.ts
thread-safe:scripts/persistence-epoch-header.spec.ts
thread-safe:packages/workflow/workflow-ptc/tests/egress.spec.ts
thread-safe:packages/experimental/browser-use-stagehand-native/tests/worker-protocol.spec.ts
```

### 2.3. Verify-гейты (gen/verify пары) — 16/18 зелёных

| Verify-гейт | Результат |
|---|---|
| `verify-tsconfig-paths` | ✅ |
| `verify-cli-help` | ✅ |
| `verify-cordis-catalog` | ✅ |
| `verify-cordis-api` | ✅ |
| `verify-cordis-inspect-catalog` | ✅ |
| `verify-client-catalog` | ✅ |
| `verify-workflow-guest` | ✅ |
| `verify-tool-catalog` | ✅ |
| `verify-config-catalog` | ❌ stale: `docs/config-catalog.md`, `docs/config-catalog.zh.md` |
| `verify-plugin-packages` | ✅ |
| `verify-dependency-catalog` | ✅ |
| `verify-doc-graphs` | ✅ |
| `verify-persistence-catalog` | ❌ stale: `docs/persistence-catalog*.md`, `.zh.md`, `.i18n.yaml`, `docs/persistence-schema.json` |
| `verify-session-format-catalog` | ✅ |
| `verify-third-party-notices` | ✅ |
| `verify-module-graph` | ✅ |
| `verify-official-bundle-catalog` | ✅ |
| `verify-provider-data` | ✅ |

### 2.4. Translation pairing — предсуществующий долг

`pnpm run verify-translation-pairing --list | grep -vE '^ok|^$'` (дословно):

```
out-of-sync .agents/notes/implemented/architecture/2026-10-02-continuable-child-cwd-seam.md
out-of-sync .agents/notes/implemented/feature/2026-07-28-continuable-subagent-conversations.md
out-of-sync docs/tool-catalog.md
out-of-sync packages/subagent/README.md
out-of-sync packages/subagent/subagent-thread-worktree/README.md
out-of-sync packages/subagent/worktree-manager/README.md
missing     .agents/notes/implemented/architecture/2026-10-04-restore-conversation-forks-a-prefix.md  (required)
verify-translation-pairing: 1163 ok, 6 out-of-sync, 1 missing (of 1170 in scope)
```

Итого: **6 out-of-sync + 1 missing** из 1170. Это долг до мержа.

## 3. Перезамер INVENTORY (UPSTREAM=f3803c9697, dsh-v0.2.2-alpha.2)

```
$ git rev-list --count f3803c9697..HEAD
162

$ git diff --shortstat f3803c9697...HEAD
 692 files changed, 223856 insertions(+), 1718 deletions(-)
```

### Новые пакеты (18)

```
packages/client/ui-settings-threads/
packages/experimental/client-ui-model-routing/
packages/experimental/client-ui-project-memory/
packages/experimental/client-ui-threads/
packages/experimental/model-routing-profile/
packages/experimental/model-routing/
packages/experimental/project-memory/
packages/experimental/threads-preset/
packages/experimental/threads-profile/
packages/experimental/threads/
packages/experimental/tool-threads/
packages/llm/llm-fallback/
packages/subagent/subagent-thread-worktree/
packages/subagent/worktree-manager/
packages/web/web-search-brave/
packages/web/web-search-duckduckgo/
packages/web/web-search-profile/
packages/web/web-search-tavily/
```

### Изменённые апстримные файлы: 191

Разбор по пакетам (топ):

```
17 packages/llm/llm-pi-ai
16 packages/client/ui-chat
15 packages/client/ui-workspace
14 packages/subagent/subagent
11 packages/subagent/tool-subagent
 7 packages/llm/llm
 7 packages/core/session
 7 packages/client/ui-settings-web-search
 6 packages/workflow/workflow-ptc
 4 packages/llm/llm-retry
 3 packages/test-support/session-snapshot
 2 packages/web/web
  ...ещё 2-1 файл в ~70 пакетах/корне (см. полный вывод в INVENTORY)
```

### `.local-plugins/` и `packages/experimental/`

```
.local-plugins/: browser-use-playwright, dsh-openrouter-spend, openrouter-spend, tg-notify
```

## 4. Красные флаги до мержа (не регрессии)

| Что | Статус |
|---|---|
| lint: 2 errors в `client-ui-model-routing/locales.ts` и `boot/plugin-market` | предсуществующий |
| tests: 63 файла / 267 тестов упало |предсуществующий (sandbox EROFS, git worktree, zsh, platform) |
| verify-config-catalog: stale | предсуществующий |
| verify-persistence-catalog: stale | предсуществующий |
| translation-pairing: 6 out-of-sync + 1 missing | предсуществующий долг |

Любое **новое** падение после мержа `rc.1` — регрессия.
