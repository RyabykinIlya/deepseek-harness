---
kind: upgrade-guide
description: "The exported SubagentCapabilities interface gains a required repository flag, so a provider that omits it no longer type-checks."
---

# SubagentCapabilities requires a repository capability flag

English | [中文](guide.zh.md)

## Change

`SubagentCapabilities`, exported from `@deepseek-ai/dsh-subagent`, gains a required `repository: boolean` flag beside `agentOptions`, `outputSchema`, `depthLimit`, `toolFilter`, and `persona`. A provider that implements `SubagentProvider` outside this repository and declares its capabilities without the new field stops compiling. The flag states whether the provider selects a repository per child: the delegation tool exposes its optional `repository` parameter only for a provider that declares `true`, and refuses a call that carries the parameter for a provider that declares `false`. `SubagentStartRequest` and `ContinuableCreateRequest` also gain an optional `repository?: string`, so a caller that never passes a repository changes nothing. Every provider shipped in this repository declares the flag.

## Migration

1. In each provider you own, add `repository: true` or `repository: false` to its `capabilities` object. Declare `true` only when the provider resolves a delegated `repository` to the child's working tree; declare `false` when every child works in one place.
2. Confirm the providers compile: `pnpm run typecheck`
3. Confirm a composition that mounts your provider still starts a child, and that a delegation naming a repository against a `false` provider fails with `repository is not available for provider "<provider>", which does not select a repository per subagent; omit the parameter`.
