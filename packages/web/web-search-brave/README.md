---
description: "The Brave Search-backed provider for ctx.web: how deployments mount a credentialed Brave search with per-search token resolution and evidence-based availability."
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-brave

English | [中文](README.zh.md)

## Summary

With `dsh-web-search-brave`, the harness searches the web through Brave Search and gets vendor-native results with portable snippets and page-age strings. Choose it when a deployment holds a Brave subscription token and wants a single-purpose search endpoint rather than a model turn. Brave generates no answer, so results carry no `content` — only citeable sources. Every request authenticates with one header and no secret enters the provider object. A missing token fails the call with a structured error; a response whose optional fields are absent still resolves. The model-facing `web_search` tool lives in `dsh-tool-web`.

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

Mount the provider in a composition that already loads the web service; it registers as the `brave` search provider, so `ctx.web.search()` resolves it automatically when it is the only usable search backend — or pin it with `searchProvider: brave`.

### When to choose it

Choose this backend when a deployment holds a Brave Search subscription token and wants Brave's index with per-result description snippets and page-age strings, at a flat per-request cost rather than a model's token bill. Avoid it when the deployment has no token: without one the provider is unavailable and every search fails with a structured error.

### Minimal configuration

Load the web service and the provider. The token resolves from `ctx.credentials` when that service is mounted, otherwise from the process environment; every other setting has a safe default.

```yaml
- name: '@deepseek-ai/dsh-web'
- name: '@deepseek-ai/dsh-web-search-brave'
```

| Field | Default | Meaning |
|---|---|---|
| `apiKey` | omitted | Literal Brave subscription token; prefer `apiKeyEnv` so no secret enters configuration. A non-empty literal wins over `apiKeyEnv` |
| `apiKeyEnv` | `BRAVE_API_KEY` | Credential reference resolved for each search through `ctx.credentials`, or from the process environment when that service is absent. The reference, not the value, is all this package stores |
| `baseURL` | `https://api.search.brave.com` | Brave API base; `/res/v1/web/search` is appended. An unparseable value makes the provider unavailable |
| `maxResults` | `8` | Positive-integer result count sent as Brave's `count` when a request carries no `maxResults`; the same bound the `web_search` tool applies |
| `timeoutMs` | `15000` | Positive-integer request timeout; this provider's own deadline, merged with the caller's cancellation |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-web-search-brave) is the exhaustive source for every accepted field and its JSDoc.

<a id="authentication"></a>
### Authentication

A search sends the resolved token in exactly one header, `X-Subscription-Token` — not `Authorization`. A non-empty literal `apiKey` wins; otherwise `apiKeyEnv` resolves through `ctx.credentials` per search, so a token stored or rotated in a settings page reaches the next search without a restart. Without a credentials service the launching environment is the whole credential plane, and an empty value there counts as no token at all. No token resolves to `WEB_PROVIDER_CREDENTIAL_MISSING`, naming the reference and where one can be stored.

### Availability is evidence-based

`available()` is a synchronous predicate, but a credential store is not, so this package records what the credential plane last reported instead of assuming a token exists. The provider is available when a literal `apiKey` is configured, or when the section's current reference was observed as configured. The plugin probes once at load and again on every `credentials/reference-updated` event naming that reference; an observation counts only for the reference it describes, so renaming `apiKeyEnv` discards it. A search that resolves a token also records it. Until one of those observations arrives, the provider reports unavailable rather than claiming a token it never saw — the deliberate difference from the DeepSeek provider, which reports available as soon as a resolver function exists.

### What a search returns

Each Brave web result maps to a `WebSearchSource`: `url`, `title`, `description` as `snippet`, and `page_age` as `publishedAt`; absent or empty optional fields are omitted rather than defaulted, and an entry with no usable URL is dropped. Repeated URLs are dropped (first wins). Brave answers a query with no matches as an empty `web.results`, and omits `web` when no web vertical answered; both resolve to `sources: []` rather than a failure. A request's `maxResults` wins over the configured `maxResults` default and is sent as `count`, clamped into Brave's documented 1–20 range — the final bound is enforced by the service, which truncates and flags. Brave generates no answer, so the result carries no `content`.

### Failures and recovery

Provider failures — HTTP errors, network failures, timeouts, unparseable bodies — surface as `WebError` `WEB_PROVIDER_ERROR`; caller cancellation surfaces as `WEB_ABORTED`; a missing token as `WEB_PROVIDER_CREDENTIAL_MISSING`. A non-2xx response carries the HTTP status, Brave's `error.detail`, and Brave's `error.code` into the message: an authentication failure arrives as HTTP 422 with `SUBSCRIPTION_TOKEN_INVALID`, and this package reports exactly what Brave said rather than reclassifying a status. HTTP redirects are rejected before the `Location` target is contacted. Failures after dispatch name the resolved endpoint and state that only the user should change it. Callers route on the code; the model-facing `web_search` tool surfaces failures to the model under its own error wrapper.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the provider; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The provider is a thin adapter over Brave's web endpoint with three deliberate rules:

- **No invented facts.** A source gains a `snippet` only from Brave's `description` and a `publishedAt` only from `page_age`; nothing is synthesized from other fields, and an entry with no URL is dropped rather than cited.
- **Defensive parsing.** `web`, `web.results`, and every result field are optional in practice: a vertical Brave did not return, a results field that is not an array, and a missing `description` all resolve to an empty or reduced source set instead of a failed search.
- **Honest availability.** The provider is selected only when a key is actually observable. Where a sibling cannot query its asynchronous credential store and assumes a key exists, this one records observations and reports the truth until one arrives.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config schema, settings namespace, credential observation, provider registration |
| [`src/provider.ts`](src/provider.ts) | The `BraveSearchProvider`: request dispatch, deadline composition, abort classification, result and error mapping |
| [`src/types.ts`](src/types.ts) | Brave wire types: `BraveSearchResponse`, `BraveWebResult`, `BraveErrorResponse` |
| — | No runtime invariant companion is published; this package exposes no independent event sequence or mutable data relation beyond contracts enforced at its owning seam. |

### Request and mapping flow

Each search captures the current Config values into provider options — endpoint, result bound, timeout, credential reference — resolves the token once for that snapshot, then dispatches `GET {baseURL}/res/v1/web/search?q=<query>&count=<count>` with `redirect: 'error'` under a signal merging the caller's cancellation with this provider's own deadline, so a redirect fails without contacting its target and a hung request cannot outlive `timeoutMs`. The parsed `web.results[]` are mapped one by one, deduplicated by URL, and the service applies the final `maxResults` bound on the way back. Cancellation is classified by shape: a caller-aborted signal is `WEB_ABORTED` whatever it carries, a `TimeoutError` with no caller cancellation is this provider's deadline, and an unexplained `AbortError` is cancellation rather than a provider fault.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared vocabulary to the service, the model-facing tools, and the design rationale.

- [Web subsystem](../../../docs/subsystems/web.md) — the exhaustive search request/result vocabulary and error codes.
- [Web package map](../README.md) — the provider family and each role.
- [dsh-web](../web/README.md) — the web service this provider registers into.
- [dsh-tool-web](../tool-web/README.md) — the model-facing `web_search` tool that renders this provider's sources.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-web-search-brave) — every accepted config field and its source declaration.
- [Web capability seam decision](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md) — why search and fetch share one provider-selection service.

-----

<a id="model-experience"></a>
## Model Experience

### Conversation tool result, indirectly

#### What the model sees

Through `dsh-tool-web`, the conversation model sees this provider's `maxResults`-bounded URLs, titles, `description` snippets, and `page_age` strings as citeable sources. Brave generates no answer, so no provider prose enters the context. A failed search surfaces this provider's exact message under the consumer's error wrapper — `Brave search aborted`, `Brave search timed out after <timeoutMs>ms`, `Brave search request failed: <error>`, `Brave search credential resolution failed: <error>`, `Brave Search returned an unprocessable response body: <error>`, or `Brave search has no API key for "<reference>"` — and every HTTP failure additionally carries the endpoint Brave was asked for plus the instruction that only the user changes it.

#### Token effect

Zero direct conversation tokens: this package registers no prompt section, no tool schema, and no Session events. Result tokens scale with the sources the model reads, and the seam applies the request's `maxResults` before they reach the tool result.

#### KV Cache effect

Append-only. Newly visible search results follow the reusable request prefix and do not invalidate existing KV-cache entries; `dsh-tool-web` owns that prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the provider is unavailable or incomplete. They are current package constraints.

- **Availability waits for the first observation** — with a mounted credentials service, a search issued before the load-time probe settles is refused as unavailable even when a token is stored. This is the cost of not claiming a token the provider has not seen; a probe settles within a tick of load, and every later change refreshes it.
- **An unreadable credential store reports unavailable** — a failing `describe` is not evidence of a token, so the provider stays unselected rather than guessing. The next probe, or the next stored change, decides.
- **The success shape is from Brave's documentation, not from an observed response** — this package was built and tested without a subscription token. The failure envelope (HTTP 422, `SUBSCRIPTION_TOKEN_INVALID`) was observed live; a successful response was not, so the parser accepts an absent `web`, an absent `results`, and absent result fields rather than depending on their presence.
- **Only the `web` vertical is requested** — Brave's news, image, and other verticals are neither requested nor mapped, and `safesearch`, country, freshness, and offset controls stay unexposed until the seam has provider-neutral fields for them.
- **An uncooperative credential resolver is awaited** — a credential backend that never settles delays that one search past cancellation; the seam's own cooperative budget still ends the surrounding tool call.
- **A section naming a reference outside the credential grammar fails at search time** — the credential seam owns the reference grammar, so an invalid `apiKeyEnv` raises its own `TypeError` rather than a `WebError`, the same as the DeepSeek provider.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and undecided directions. It is explicitly non-authoritative — shipped behavior, limits, and rationale live in the sections above and the linked Agent Notes.

#### Open: a live end-to-end confirmation

No Brave subscription token was available while this package was written, so no successful response has been observed from the endpoint. Before shipping, one live search should confirm the documented envelope and whether Brave serves results from every region this product supports; a regional restriction would surface as an empty `web.results` set rather than an error.

#### Future: the wider Brave control surface

Country, freshness, safesearch, and offset controls exist on the wire and stay unexposed. Exposing them needs provider-neutral seam fields first, so the provider family gains one coordinated control rather than a vendor-specific argument.

</details>
