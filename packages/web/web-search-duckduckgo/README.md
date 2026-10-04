---
description: "The keyless DuckDuckGo search provider for ctx.web: how a deployment gets working web search with no API key, and what that costs."
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-duckduckgo

English | [中文](README.zh.md)

## Summary

With `dsh-web-search-duckduckgo` the harness searches the web with no API key, no account, and no credential. Choose it when a deployment needs a working `web_search` and holds no DeepSeek, Exa, or Perplexity key. The provider POSTs the query to DuckDuckGo's public HTML endpoint and maps the rendered result blocks to portable sources. DuckDuckGo throttles automated clients: its anti-bot system answers some requests with an HTTP 202 challenge page, which resolves as an empty result set rather than a failure. The model-facing `web_search` tool lives in `dsh-tool-web`.

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

Mount the provider in a composition that already loads the web service; it registers as the `duckduckgo` search provider, so `ctx.web.search()` resolves it automatically when it is the only usable search backend — or pin it with `searchProvider: duckduckgo`.

### When to choose it

Choose this backend when no search credential exists and search must still work. The provider is unavailable — and every search call fails with a structured error — only when its own configuration cannot be used: an endpoint that does not parse, a blank `userAgent`, or a non-positive `timeoutMs`, `maxResponseBytes`, or `numResults`. It is a scraping adapter over a page that carries no compatibility promise, so a deployment that can hold a real API key should still prefer one.

### Minimal configuration

Load the web service and the provider; there is no key to supply and every field has a working default.

```yaml
- name: '@deepseek-ai/dsh-web'
- name: '@deepseek-ai/dsh-web-search-duckduckgo'
```

| Field | Default | Meaning |
|---|---|---|
| `endpoint` | `https://html.duckduckgo.com/html/` | HTML endpoint the query is POSTed to as `application/x-www-form-urlencoded`; an unparseable value makes the provider unavailable |
| `userAgent` | a Chrome `User-Agent` | Sent on every request. DuckDuckGo answers anything that does not look like a browser with an empty challenge page |
| `numResults` | (unset) | Default result count when a request carries no `maxResults`; must be a positive integer |
| `timeoutMs` | `15000` | Request timeout; exceeding it fails the call with `WEB_PROVIDER_ERROR`, not a cancellation |
| `maxResponseBytes` | `1048576` | Byte cap on the response body this provider will read |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-web-search-duckduckgo) is the exhaustive source for every accepted field and its JSDoc.

### What a search returns

Each rendered result block maps to a `WebSearchSource`: the `result__a` anchor's `href` as `url`, its title with DuckDuckGo's `<b>` emphasis stripped and HTML entities decoded, and the following `result__snippet` anchor as `snippet`. A block that rendered no snippet still yields a source without one, and a target that is not an absolute `http(s)` URL is dropped rather than guessed at. Repeated targets are dropped. The endpoint has no server-side result-count control, so the request's `maxResults` — or the configured `numResults` default — is applied here and `truncated` is set when it cuts anything; the service enforces the same bound again on the way back.

### Failures and recovery

A transport failure, a non-2xx response, or a body read that fails surfaces as `WebError` `WEB_PROVIDER_ERROR`; the caller's own cancellation surfaces as `WEB_ABORTED`, and this provider's own deadline surfaces as `WEB_PROVIDER_ERROR` naming the timeout. An anti-bot challenge page is none of these: DuckDuckGo answers it with HTTP 202, a 2xx response whose body holds no result anchor, so the call resolves with `sources: []`. HTTP redirects are rejected before the `Location` target is contacted. Callers route on the code; the model-facing `web_search` tool surfaces failures to the model under its own error wrapper.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the provider; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The provider is a thin adapter over one public HTML page with three deliberate rules:

- **A challenge page is an empty result, not a failure.** DuckDuckGo's anti-bot answer is a 2xx response that renders no results, so the provider parses it to zero sources. A tool that reported an error instead would make every throttled search look like a broken integration, and would push a deployment to retry against a rate limit rather than back off.
- **Never invent a field.** A missing title or snippet is omitted instead of being derived from the URL, and no publication date is emitted at all because the page renders none that can be trusted.
- **Bound what is read.** The response body is read under a byte cap, so a challenge page or an oversized document cannot grow the process's memory.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config schema, constant defaults, provider registration |
| [`src/provider.ts`](src/provider.ts) | The `DuckDuckGoSearchProvider`: request dispatch, body bound, abort classification, result mapping |
| [`src/types.ts`](src/types.ts) | Wire vocabulary: the `DuckDuckGoResultLink` fragments one result block parses into |
| — | No runtime invariant companion is published; this package exposes no independent event sequence or mutable data relation beyond contracts enforced at its owning seam. |

### Request and mapping flow

`search()` POSTs the query as a form field to `endpoint` with `redirect: 'error'`, so a redirect fails the request without contacting the target. The response body is read through a byte-capped stream reader, then `result__a` anchors are located in document order; each block's snippet is the `result__snippet` anchor that follows it before the next title, so a block that rendered none never borrows its neighbour's text. Titles and snippets are reduced to plain text — tags to spaces, then entities decoded, then whitespace collapsed — before they are mapped. An abort caused by the caller's signal becomes `WEB_ABORTED`; an abort caused by this provider's own deadline, and every other failure, becomes `WEB_PROVIDER_ERROR`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared vocabulary to the service, the model-facing tools, and the design rationale.

- [Web subsystem](../../../docs/subsystems/web.md) — the exhaustive search request/result vocabulary and error codes.
- [Web package map](../README.md) — the search and fetch provider family and each role.
- [dsh-web](../web/README.md) — the web service this provider registers into.
- [dsh-tool-web](../tool-web/README.md) — the model-facing `web_search` tool that renders this provider's sources.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-web-search-duckduckgo) — every accepted config field and its source declaration.
- [Web capability seam decision](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md) — why search and fetch share one provider-selection service.

-----

<a id="model-experience"></a>
## Model Experience

### Conversation tool result, indirectly

#### What the model sees

Through `dsh-tool-web`, the conversation model sees this provider's `maxResults`-bounded URLs, titles, and snippets as citeable sources. DuckDuckGo generates no answer, so no provider prose enters the context. A failed search surfaces this provider's exact message under the consumer's error wrapper — `DuckDuckGo search aborted`, `DuckDuckGo search timed out after <ms>ms`, `DuckDuckGo search request failed: <error>`, or `DuckDuckGo search failed (HTTP <status>)`. A throttled search reaches the model as a successful call with no sources rather than as an error.

#### Token effect

Zero direct conversation tokens: this package registers no prompt section, no tool schema, and no Session events. Result tokens scale with the sources the model reads, and the seam applies the request's `maxResults` before they reach the tool result.

#### KV Cache effect

Append-only. Newly visible search results follow the reusable request prefix and do not invalidate existing KV-cache entries; `dsh-tool-web` owns that prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the provider is a poor fit. They are current package constraints.

- **Throttling is silent** — an anti-bot challenge page resolves as `sources: []`, so a rate-limited deployment cannot tell "no results" from "blocked". Only a `WEB_PROVIDER_ERROR` surfaces as a failure.
- **The endpoint has no compatibility promise** — it is a public HTML page with no API contract, no rate-limit documentation, and no service level. Its markup is what this package parses, so an unannounced redesign costs results rather than errors.
- **The default `userAgent` is a browser identity** — this is the one place in the repository where a request does not identify as the product, because the endpoint serves no results to anything else. A deployment that objects can set `userAgent` explicitly and accept empty results.
- **Only `endpoint`/`userAgent`/`numResults`/`timeoutMs`/`maxResponseBytes` are exposed** — the endpoint's own parameters (`kl` region, `df` date filter, timeouts, safe search) wait on provider-neutral service fields ([seam Agent Note](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md)).
- **Abort classification distinguishes caller from deadline by signal state** — a custom abort reason that does not set the caller's signal is reported as `WEB_PROVIDER_ERROR`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and undecided directions. It is explicitly non-authoritative — shipped behavior, limits, and rationale live in the sections above and the linked Agent Notes.

#### Future: a fallback across keyless endpoints

DuckDuckGo is the only no-key source with working markup at the time of writing; the alternatives reachable without a key were unreachable, geo-blocked, or returned nothing usable. A deployment that wants redundancy needs either a second keyless source or a real key, and this package deliberately owns one.

#### Future: telling a throttled search from an empty one

Resolving both as `sources: []` keeps a tool call successful, but it also hides the failure from the model. Surfacing it would need a seam field for it, so it waits on the same provider-neutral request/result vocabulary as the endpoint's own parameters.

</details>
