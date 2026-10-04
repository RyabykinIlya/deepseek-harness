---
description: "The tiers model route, its settings page, and the composer chip in one experimental bundle."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-model-routing-profile

English | [中文](README.zh.md)

## Summary

`dsh-experimental-model-routing-profile` is the installable bundle of the `tiers` model route: it inserts the Host plugin that registers the route and the `modelRouting` service, and the browser package that renders the composer chip and the settings page. It carries no configuration, so the route stays dormant — an empty model list, no decisions, no spending — until a person names the tiers they are willing to pay for. It is published under its experimental name and carries no stability promise.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Install the bundle through the Host's plugin manager, which is what the Plugins page's install action calls: `ctx.pluginManager.installBundle('/abs/path/to/packages/experimental/model-routing-profile')`. There is no `dsh plugin install-bundle` CLI verb in this repository — installation is a Host service method, not a command — so a headless install goes through the same service.

Installing the bundle on its own changes nothing observable. The route advertises no models and the settings page has nothing to edit until the `model-routing` namespace lists a tier.

<a id="configure"></a>
### Configure the tiers

The tiers live in the `model-routing` settings namespace, which is written as `config:` on the bundle's own row in the profile patch. The fragment below is what the plan's §16 step 5 documents; `trustedUnknownProviders` comes from the W0 survey.

```yaml
- id: model-routing
  name: '@deepseek-ai/dsh-experimental-model-routing'
  config:
    tiers:
      - { name: pro, label: Pro, models: [deepseek/deepseek-v4-pro, z-ai/glm-5.3], contextWindow: 1000000, maxTokens: 32768, input: [text], minQuantization: fp8, unknownQuantization: reject, free: 'off' }
      - { name: flash, label: Flash, models: [deepseek/deepseek-v4-flash, z-ai/glm-5.3-flash, stealth/space-bunny-alpha], contextWindow: 1000000, maxTokens: 32768, input: [text], minQuantization: fp8, unknownQuantization: trusted, free: prefer }
    # Replace with the list from the W0 report (§8).
    trustedUnknownProviders: [stealth]
    judgeModel: typesafe/jev-1.13
    presetRoutes:
      - { preset: project, model: pro }
- id: project
  config:
    threadProvider: tiers
    threadModel: flash
    threadReasoningEffort: high
    threadMaxTokens: 32768
    threadModels:
      - { provider: tiers, model: flash }
      - { provider: tiers, model: pro }
    tierContract: tiers
```

The `project` block belongs to `dsh-experimental-threads-preset`, a different bundle. Installing this one alone leaves it inert; installing both, and declaring the `project` row's `id` so the user patch targets it by id, is what makes a Project coordinator start on `tiers/pro`.

<a id="credential"></a>
### Store the OpenRouter credential

The route reads the Decisions API and the free-budget endpoint with the credential named by `apiKeyRef` (`OPENROUTER_API_KEY` by default). Store it through the credentials service — the web Models page writes it — or export it before the Host starts. Without it the route still serves requests; only the judge and the free-budget counter fall back to their defaults.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The observable behavior is fully covered in [Use this package](#use-this-package).

### Patch document

`cordis.patch.yml` inserts exactly two top-level rows and repoints nothing: the Host route and the browser half. A deployment that already ships a `model-routing` row of its own gets a duplicate-id failure at load, which is the intended loud outcome — two route plugins cannot both own `tiers`.

### Why the bundle carries no configuration

A tier list is a spending decision. The route is designed so that installing it costs nothing: no tiers means no models advertised, no decisions taken, and no request dispatched through it. Putting a default tier list in the bundle would make every installer's first OpenRouter request a paid one, chosen by whoever wrote the bundle.

</details>

-----

<a id="model-experience"></a>
## Model Experience

None, as the bundle only inserts the model-routing rows and registers no model-facing surface of its own.

#### KV Cache effect

None; the bundle carries no configuration and dispatches nothing.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- A verification pass that boots the real Loader over this bundle's rows and an `openrouter` route has not been written yet; the bundle test covers the patch document and the configuration fragment, not a live composition. That belongs with the manual acceptance in the plan's §18.
- The bundle does not install `llm-pi-ai`, so a profile without it mounts the route and then refuses every request with `NO_ADAPTER`. The web profile already ships it; a headless profile must add it explicitly.
- `judgeModel` is pinned to `typesafe/jev-1.13`. A newer decisions model would move the calibrated thresholds off their calibration, so upgrading it is a deliberate act rather than a default that follows an alias.

-----

<a id="dev-note"></a>
## Dev Note

None.
