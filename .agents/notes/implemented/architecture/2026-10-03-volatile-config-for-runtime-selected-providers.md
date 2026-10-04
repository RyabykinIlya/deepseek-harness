# Agent Note: Volatile config for a runtime-selected plugin value

Status: implemented

English | [中文](2026-10-03-volatile-config-for-runtime-selected-providers.zh.md)

## Problem

The web access seam picks which registered provider serves a search or a fetch. `WebRuntime` in `packages/web/web/src/index.ts` captured that choice once, in its constructor:

```ts ignore-check
class WebRuntime extends Service {
  private readonly searchProviderId: string | undefined

  constructor(ctx: Context, config: WebRuntimeConfig = {}) {
    super(ctx, 'web')
    this.searchProviderId = config.searchProvider ?? process.env.DSH_WEB_SEARCH_PROVIDER
  }
}
```

Every later call read that snapshot. Nothing in the package subscribed to a settings change — there was no such event to subscribe to — so the only way to change the provider was to edit the composition and restart the process. `web_search` failed for any deployment holding no DeepSeek key, and the composition hard-selected `searchProvider: deepseek-official`, so no alternative could be reached at all: `resolveProvider` throws when a configured id is unregistered or unavailable and never falls back (`packages/web/web/src/index.ts`).

Making this settable from the settings page looked like a UI task. It was not, and the first attempt at it failed for a reason worth keeping.

The client settings layer reaches a plugin's configuration through `ctx.configForms.get(<namespace>)`, and the Web Search page already used that to edit `web-search-deepseek`. Binding the same machinery to the `web` namespace produced a permanently dead control: the scope reported `unavailable`, nothing mounted, and every save was refused. The cause is not a missing wiring step. `SettingsForms.describe()` projects only **volatile** fields (`packages/settings/settings/src/index.ts`, via `volatileForm` in `packages/settings/settings/src/schema.ts`), and `validatePaths()` throws `Config field "searchProvider" is not volatile` for anything else. `WebRuntime.Config` declared `searchProvider: z.string()`, so `volatileForm()` returned `undefined` and the `web` entry was omitted from `describe()` entirely. There was no settings form for the seam at all — not a form that lied about its value, but none.

The writes themselves travel `ConfigEditor.edit()` → `reconcileProfilePatches()` → `Include` → `Entry.update()` (`vendor/loader/src/config/entry.ts`). That entry point decides the fate of the change: a **volatile-only** diff is committed in place by mutating the running fiber's references, and returns **without** calling `fiber.update()` — the plugin is never reconstructed. Any other diff calls `fiber.update()` → `restart()`, and the plugin *is* recreated.

## Decision

`WebRuntime.Config` marks both selection fields volatile, and the runtime resolves them at use time instead of snapshotting them.

```ts ignore-check
interface WebRuntimeConfig {
  readonly searchProvider?: Volatile<WebSearchProviderId | undefined>
  readonly fetchProvider?: Volatile<WebFetchProviderId | undefined>
}
```

The two halves are not alternatives; the second is forced by the first. A volatile commit never reconstructs the runtime, so a `readonly` snapshot taken in the constructor would stay stale forever, silently serving the old provider while the settings document and the UI both reported the new one. Volatile marks the value editable; use-time resolution is what makes the edit take effect.

The annotation `z<WebRuntimeConfig>` was removed from the schema on purpose. Schemastery types a volatile field as its *storage* type, so pinning the accessor type in the schema is a lie; every other volatile plugin in the tree already omits it.

The ids are published as data rather than as a schema constraint:

```ts
export const WEB_SEARCH_PROVIDER_IDS = ['brave', 'deepseek-official', 'duckduckgo', 'exa', 'perplexity', 'tavily'] as const
export type WebSearchProviderId = typeof WEB_SEARCH_PROVIDER_IDS[number] | (string & {})
export const WEB_FETCH_PROVIDER_IDS = ['http'] as const
```

The schema stays `z.string()`. A Schemastery literal union would reject an unknown id inside `resolveConfig`, before `resolveProvider` ever runs, so `WEB_PROVIDER_CONFIGURED_MISSING` — the error that actually names the problem — could never fire. The `(string & {})` widening is the existing repo idiom (`packages/skill/skill/src/index.ts`) and buys editor completion without rejecting anything.

The client half lives in `packages/client/ui-settings-web-search`. The page had been hard-wired to one namespace (`WEB_SEARCH_NS = 'web-search-deepseek'`), so a key typed anywhere landed in `DEEPSEEK_API_KEY` regardless of which provider was selected. It now renders one block per mounted provider, each writing to its own credential reference, plus **one** provider selector for the `web` namespace. The selector is a single page entry rather than one per block because `searchProvider` is one global value; repeating one choice three times would be a defect. It offers *Automatic* when unset — which emits an `unset`, handing the choice back to the seam's auto-selection rather than writing an empty id — and renders an unknown configured value as its own option instead of rewriting it.

A corollary worth stating because it will otherwise be assumed wrong: **a served settings namespace is not a signal that a plugin is mounted.** `web-search-duckduckgo`, `web-search-exa` and `web-search-perplexity` declare no volatile fields, so they are omitted from `describe()` exactly as `web` was. The client cannot discover mount state, which is why the selector's option list is static.

## Alternatives considered

**A Schemastery literal union for `searchProvider`.** Rejected: it converts a clear runtime error into an opaque schema rejection, and an unknown id in an existing YAML would stop the plugin from loading at all.

**Subscribing to a settings-changed event.** There is no such event. The volatile path is the mechanism the repository actually provides, and every other web provider already uses it — `web-search-deepseek`, `web-search-brave` and `web-search-tavily` mark every field volatile and read `config.x.get()` per call.

**Leaving the field non-volatile and reloading the plugin.** This would have made the existing `readonly` capture correct, since `Entry.update()` on a non-volatile diff restarts the fiber. Rejected because it turns a settings save into a service restart, which is visible to every other consumer of `ctx.web`.

**Deriving the selector's options from the served namespaces.** Rejected: as recorded above, served ≠ mounted, and the filter would have hidden `duckduckgo`, which is the default composition's selection.

**Keeping the composition's `searchProvider` as the only control and adding no UI.** Rejected: selecting a provider required editing YAML, which is exactly the failure mode this removes — and a wrong choice there is invisible, since a geo-blocked or credential-less provider returns an empty result rather than an error.

## Consequences

A provider is now selectable from the settings page, and its key is written against that provider's own credential reference, so the three no longer overwrite one another. The cost is a second obligation attached to any future runtime-selected plugin value: the value must be declared volatile *and* re-read at use time, and a reader who adds only the first ships a setting that saves and does nothing.

The static option list must be extended when a provider is added — one array entry, no schema edit and no consumer edit. If an author forgets, the failure is benign: the id still reaches `resolveProvider`, which names it in `WEB_PROVIDER_CONFIGURED_MISSING`.

The selector offers ids whose packages are not mounted by default. Picking one yields that same clear error rather than silently misbehaving, which was judged better than hiding two shipped providers behind YAML editing.

Reactivity is verified through the real path, not a proxy: `packages/web/web/tests/web.spec.ts` mounts the actual Loader, registers extra providers, then drives `entry.update({ config: { searchProvider: … } })` — what `SettingsForms.write` does — and asserts the next `ctx.web.search()` dispatches to the new provider while `entry.fiber` and the `Volatile` reference are the same objects. Identity is asserted on the fiber rather than on `ctx.web` because a `Service` carries a tracker and `ctx.web` is a traceable Proxy. The test was checked for vacuity by reverting the constructor to snapshotting: all live-selection cases fail, and pass again on restore.