---
description: "The keyless search default, two keyed search providers, and the transparent-proxy fetch range as one profile layer."
kind: "package-bundle"
---

# @deepseek-ai/dsh-web-search-profile

English | [中文](README.zh.md)

## Summary

`dsh-web-search-profile` is the installable bundle of the web search and fetch rows a deployment without a DeepSeek credential needs: it repoints the `web` row to the keyless `duckduckgo` provider, mounts the Brave and Tavily providers for a deployment that stores their keys, and declares the `198.18.0.0/15` range a transparent-proxy host needs for fetch. A profile lists it after `@deepseek-ai/dsh-base`, which contributes every row it addresses. Nothing is mounted by default, so the layer is inert until a profile names it.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### Install into a profile

The bundle is a workspace package, so a profile adds it the same way it adds any other bundle:

```sh
dsh plugin --profile web add @deepseek-ai/dsh-web-search-profile
```

In this repository the profile resolves it from the checkout rather than from a registry, so a source-launch profile links the package directory instead:

```json
{
  "dependencies": {
    "@deepseek-ai/dsh-web-search-profile": "link:/abs/path/to/packages/web/web-search-profile"
  }
}
```

Add the bundle to `dsh.profile.bundles` **after** `@deepseek-ai/dsh-base`. Bundle layers apply in list order and a later layer wins per row, so the `web` override here beats the base layer's `deepseek-official` default. Removing it with `dsh plugin --profile <name> remove @deepseek-ai/dsh-web-search-profile` restores the base composition.

### What you get

The layer overrides two rows the base ships and inserts three provider rows:

| Row | Effect |
|---|---|
| `web` | Repoints `searchProvider` to `duckduckgo`, keeping `fetchProvider: http` |
| `web-search-duckduckgo` | Mounts the keyless search provider the `web` row selects |
| `web-search-brave` | Mounts the Brave provider; selected only when `searchProvider` names `brave` |
| `web-search-tavily` | Mounts the Tavily provider; selected only when `searchProvider` names `tavily` |
| `web-fetch-http` | Declares `trustedProxyAddressRanges: [198.18.0.0/15]` for a fake-IP transparent-proxy host |

The `web-search-deepseek` row stays mounted and configured by the base layer, so a deployment that later stores `DEEPSEEK_API_KEY` can point `searchProvider` back at `deepseek-official` without this bundle changing.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The observable behavior is fully covered in [Use this package](#use-this-package).

### Patch document

`cordis.patch.yml` holds three entries: the `web` override, one `insert` list carrying the three provider rows, and the `web-fetch-http` override. Both overrides address rows the base layer inserted and name no plugin of their own; the provider rows are the only rows this bundle loads, and each resolves from the bundle's own `dependencies`.

A patch replaces the targeted row's whole `config` rather than merging into it, so the `web` override restates `fetchProvider: http` alongside the provider it changes, and the `web-fetch-http` override states the complete range list. A profile that needs a wider list — LAN hosts, loopback — overrides the same row in its own `cordis.patch.yml`, which applies after every bundle layer.

An id-targeted override needs its row to exist. A profile that lists this bundle without `@deepseek-ai/dsh-base` gets a skipped-patch warning for both overrides and mounts only the three insert rows.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Web subsystem](../../../docs/subsystems/web.md) — the search/fetch requests and results, provider availability, and public-address enforcement.
- [`web-fetch-http`](../web-fetch-http/README.md) — the guard that reads `trustedProxyAddressRanges`.
- [`packages/bundle/base`](../../bundle/base/README.md) — the layer that ships the rows this bundle repoints.
- [Package and install a plugin](../../../docs/user/develop/basic/publish.md) — the layer order and patch semantics this bundle relies on.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the search provider the `web` row selects and the `web_search` / `web_fetch` tools `dsh-tool-web` owns.

#### KV Cache effect

None. The bundle contributes no prompt text and no tool schema of its own; which provider answers a search changes the tool result, not the request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The bundle carries no credential. A deployment that selects `brave` or `tavily` stores the key through the Web Search settings page, and one that selects `deepseek-official` stores `DEEPSEEK_API_KEY`; until then the configured provider is registered but unavailable, and a search fails with `WEB_PROVIDER_CONFIGURED_UNAVAILABLE` rather than falling back to the mounted keyless provider.
- `trustedProxyAddressRanges` states the range only; this bundle cannot detect that the host really is behind a transparent proxy, so a deployment whose DNS resolves normally must override the row to omit the range.
- A verification pass that boots the real Loader over this bundle beside `@deepseek-ai/dsh-base` has not been written; the bundle test covers the patch document, not a live composition.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
