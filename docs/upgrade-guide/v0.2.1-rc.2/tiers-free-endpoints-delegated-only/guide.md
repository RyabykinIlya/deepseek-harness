---
kind: upgrade-guide
description: "Free endpoints of a `free: prefer` tier now serve delegated sessions only; a solo Session needs the new `freeForSoloSessions` key to keep them."
---

# Free endpoints of a `prefer` tier serve delegated sessions only

English | [中文](guide.zh.md)

## Change

In v0.2.1-rc.2, `@deepseek-ai/dsh-experimental-model-routing` decides free-endpoint admission by delegation. Before, a top-level Session was always admitted and subagents were kept off free endpoints unless `freeForSubagents` was true. Now a subagent or a Thread — a session whose header origin is `subagent` and whose output an orchestrator reviews — is admitted when `freeForSubagents` is true, and a solo Session is admitted only when the new `freeForSoloSessions` key is true. Both keys default to false. A tier whose `free` mode is `only` answers to neither key: naming that tier is itself the request for free models, so it keeps serving every session that picks it. The shared daily budget (`freeMinRemaining`) and the per-model `RATE_LIMIT` bench are unchanged.

Deployments whose tiers use `free: 'off'` are unaffected. A deployment with a `free: prefer` tier is affected: its solo Sessions stop landing on free endpoints and rank the tier's paid endpoints instead, while `freeForSubagents: true` keeps free models available to subagents and Threads.

## Migration

1. Inspect the tier rows of the model-routing profile patch. A tier with `free: prefer` whose free endpoints should keep serving solo Sessions needs the route-wide key added beside `freeForSubagents`:

   ```yaml
   freeForSoloSessions: true
   ```

2. Confirm the split you now have: with `freeForSubagents: true` and no `freeForSoloSessions`, send one message in a solo Session and one to a subagent or Thread. The solo Session's `model-routing/decision` event ranks a paid endpoint with `allowFree: false`; the delegated one may record the free model.
3. A Session that names the `free: only` tier in the model picker keeps receiving free endpoints without either key; verify by picking that tier and confirming the turn completes.
