---
description: "The Tavily-backed search provider for ctx.web: how a deployment mounts Tavily web search with a credential that a settings page can write."
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-tavily

English | [中文](README.zh.md)

## Summary

With `dsh-web-search-tavily`, the harness searches the web through Tavily and gets results with extracted page text already bounded to a snippet. Choose it when a deployment has a Tavily API key and wants the key written from the Web settings page rather than exported in a shell. Tavily returns no answer unless one is asked for, and this provider never asks, so results carry `content` only in the unlikely event that a response sends an answer anyway. The model-facing `web_search` tool lives in `dsh-tool-web`.

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

Mount the provider in a composition that already loads the web service; it registers as the `tavily` search provider, so `ctx.web.search()` resolves it automatically when it is the only usable search backend — or pin it with `searchProvider: tavily`.

### When to choose it

Choose this backend when a deployment holds a Tavily API key and wants results that already carry extracted page text, bounded so one verbose page cannot fill a model context. The provider is unavailable — and the seam reports `WEB_PROVIDER_CONFIGURED_UNAVAILABLE` or `WEB_PROVIDER_UNAVAILABLE` rather than sending a doomed request — when no key can resolve, or when the endpoint does not parse.

### Minimal configuration

Load the web service and the provider; the key resolves through the credentials service first and falls back to `$TAVILY_API_KEY` in the launch environment, and all other settings have safe defaults.

```yaml
- name: '@deepseek-ai/dsh-web'
- name: '@deepseek-ai/dsh-web-search-tavily'
```

| Field | Default | Meaning |
|---|---|---|
| `apiKey` | (unset) | Literal Tavily API key; prefer `apiKeyEnv` so no secret enters configuration files |
| `apiKeyEnv` | `TAVILY_API_KEY` | Credential reference resolved for each search; a name outside the reference grammar makes the provider unavailable |
| `baseURL` | `https://api.tavily.com/search` | Full search endpoint, **path included** — no path is appended to it. An unparseable value makes the provider unavailable |
| `numResults` | `5` | Result count requested when a search carries no `maxResults`; must be a positive integer |
| `timeoutMs` | `15000` | Request timeout, applied to credential resolution, dispatch, and body read alike |
| `maxContentChars` | `2000` | Character cap on one result's snippet; must be a positive integer |

The generated [configuration catalog](../../../docs/config-catalog.md) is the exhaustive source for every accepted field and its JSDoc.

### Writing the key

The provider's settings section is served under the namespace `web-search-tavily`, the same name the Web settings page lists for this provider. That page writes the key through the credentials service — the literal never rides a response — so a deployment needs no `TAVILY_API_KEY` in its launching environment.

`available()` answers from a credential resolution that actually completed, not from the existence of a resolver: the provider reports itself unusable while no key can be sent, and becomes usable as soon as a key resolves. The launch environment is consulted synchronously, so a composition that exports the key is usable the moment it mounts.

### What a search returns

Each Tavily result maps to a `WebSearchSource`: `url`, `title` when present, and the extracted page text as `snippet`, cut to `maxContentChars` on a word boundary and ending in `…` so a bounded snippet reads as a fragment. Results keep Tavily's own order; a result without a URL is dropped and a repeated URL is dropped after the first. Tavily's relevance `score` is not mapped — the seam has no field for it, and re-ranking the results by it would be this provider's guess rather than Tavily's ranking. A request's `maxResults` wins over the configured `numResults` default and is sent as a cost and latency optimization; the final bound is enforced by the service, which truncates and flags.

### Failures and recovery

Provider failures — HTTP errors, network failures, unparseable bodies — surface as `WebError` `WEB_PROVIDER_ERROR`; an aborted request surfaces as `WEB_ABORTED`. HTTP redirects are rejected before the `Location` target is contacted and surface as `WEB_PROVIDER_ERROR`. An HTTP 401 carries Tavily's own message, which this endpoint places at `detail.error` rather than at a top-level `error`, and the message then names the credential reference to fix instead of the endpoint. Callers route on the code; the model-facing `web_search` tool surfaces failures to the model under its own error wrapper.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the provider; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The provider is a thin adapter over Tavily's API with three deliberate rules:

- **Bound what the vendor writes for readers.** Tavily's `content` is an extract of a whole page; it is cut to `maxContentChars` and marked with an ellipsis before it becomes a `snippet`, so no single verbose page can dominate the context.
- **Map nothing the seam cannot hold.** `score` has no field on `WebSearchSource`, so it is dropped rather than smuggled into a title or a snippet.
- **Never advertise a key that is not there.** Availability is a completed resolution, so the seam refuses the dispatch instead of spending a round trip on a request that can only be rejected.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config schema, credential resolution, availability answer, provider registration |
| [`src/provider.ts`](src/provider.ts) | The `TavilySearchProvider`: request dispatch, abort classification, result mapping |
| [`src/types.ts`](src/types.ts) | Tavily wire types: `TavilySearchRequest`, `TavilySearchResponse`, `TavilyResult`, `TavilyError` |
| — | No runtime invariant companion is published; this package exposes no independent event sequence or mutable data relation beyond contracts enforced at its owning seam. |

### Request and mapping flow

`search()` snapshots one settings section, resolves the key under a deadline built from the caller's signal and the configured timeout, and posts `{"query", "max_results"}` to the endpoint with `redirect: 'error'` and an `Authorization: Bearer` header, so a redirect fails the request without contacting the target. The parsed `results[]` are mapped one by one, URL-less entries dropped, and the service applies the final `maxResults` bound on the way back. A cancellation the caller asked for becomes `WEB_ABORTED`; the provider's own deadline, and the transport timeout that reports the same thing, becomes `WEB_PROVIDER_ERROR`; every other failure becomes `WEB_PROVIDER_ERROR` too.

### What was observed, and what was not

The request shape — `POST`, the absolute `/search` path, `Authorization: Bearer`, a JSON body of `query` and `max_results` — and the HTTP 401 body carrying its message at `detail.error` were confirmed against the live endpoint. The success envelope, including `content`, `answer`, `score`, and an absent or empty `results`, comes from Tavily's published documentation; this package has never exchanged a successful search with the API, because no key was available to exchange one with. The `tests/` suites mock `fetch` throughout and contact nothing.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared vocabulary to the service, the model-facing tools, and the design rationale.

- [Web subsystem](../../../docs/subsystems/web.md) — the exhaustive search request/result vocabulary and error codes.
- [Web package map](../README.md) — the family and each role.
- [dsh-web](../web/README.md) — the web service this provider registers into.
- [dsh-tool-web](../tool-web/README.md) — the model-facing `web_search` tool that renders this provider's sources.
- [Generated configuration catalog](../../../docs/config-catalog.md) — every accepted config field and its source declaration.
- [Web capability seam decision](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md) — why search and fetch share one provider-selection service.

-----

<a id="model-experience"></a>
## Model Experience

### Conversation tool result, indirectly

#### What the model sees

Through `dsh-tool-web`, the conversation model sees deduplicated URLs, titles, and length-bounded snippets from Tavily's `results[]`, in Tavily's own ranking order. A snippet the `maxContentChars` bound cut ends in `…`, so the model can tell that the text it holds is a fragment rather than a whole page. This provider's exact failures include `Tavily search aborted`, `Tavily search timed out after <ms>`, `Tavily search credential resolution failed: <error>`, `Tavily search request failed: <error>`, and `Tavily returned an unprocessable response body: <error>`. An HTTP 401 appends Tavily's own message — read from `detail.error`, the place this endpoint actually puts it — followed by an instruction to guide the user to store a working key for the named reference, and never a suggestion to change the endpoint. An absent or empty `results` reaches the model as a successful call with no sources rather than as an error. The consumer owns the error wrapper.

#### Token effect

Zero direct conversation tokens from registration. Result tokens scale with the returned sources and their bounded snippets — the bound is what keeps one verbose page from dominating them — and the service then enforces the requested source bound.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the provider is a poor fit. They are current package constraints.

- **A result without a URL is dropped** — it has nothing a model could cite, so fewer sources than requested can return.
- **A snippet is cut, never summarized** — the ellipsis marks the cut, but the text after `maxContentChars` is simply absent.
- **Only `baseURL`/`numResults`/`timeoutMs`/`maxContentChars` are exposed** — Tavily's other controls (search depth, topic, time range, domain filters, include-answer, raw content) wait on provider-neutral service fields ([seam Agent Note](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md)).
- **A stored key becomes visible to `available()` asynchronously** — the credentials seam answers in a promise, so a key written in the settings page can leave the provider reporting itself unavailable for a moment before the answer settles; the launch-environment and literal-key paths are synchronous and never wait.
- **Abort classification is signal-shaped** — only a fired deadline, a fired caller signal, or a transport `TimeoutError` is treated as a cancellation; an abort nobody asked for surfaces as the phase's ordinary failure rather than as a claimed timeout.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and undecided directions. It is explicitly non-authoritative — shipped behavior, limits, and rationale live in the sections above and the linked Agent Notes.

#### Future: a wider Tavily control surface

Tavily's topic, time range, domain filters, search depth, and raw-content controls stay unexposed. Exposing them needs provider-neutral service fields first, so the family adds one coordinated control rather than a vendor-specific argument.

#### Open: an end-to-end check against the live API

Every statement about this package's request and error handling is proven by mocked tests plus the one observed HTTP 401. A live search has never been exchanged, so the success envelope this package codes against is documentation, not observation. Whoever first has a spare key should confirm it and, if the envelope differs, correct `src/types.ts` before anything else.

</details>
