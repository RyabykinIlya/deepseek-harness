---
description: "Loop-hygiene guard that nudges the model out of repeated (identical and near-identical) tool-call loops and blocks a stuck chain, for users and maintainers choosing, configuring, or debugging the plugin."
kind: "package-reference"
---

# @deepseek-ai/dsh-repeat-tool-reminder

English | [中文](README.zh.md)

## Summary

This package helps a model escape loops in which it calls the same tool with identical or near-identical arguments without making progress. At configured repeat counts it asks the model to inspect the previous result and change approach or finish; at a configured hard threshold it blocks the call instead of reminding. A separate empty-reasoning streak (consecutive steps with no reasoning) lowers the hard threshold, because a repeating model that has stopped reasoning cannot recover by itself. Repeats are tracked separately for each agent and cleared by a new user message. The `dsh` base bundle enables the package with reminders at 3, 5, and 8 repeats, fuzzy matching at 0.9, a hard block at 30 repeats, and a degradation-aware early block at 10 empty-reasoning steps.

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

Mount this plugin when the model should catch itself looping on repeated tool calls. There is nothing to learn or wire: the `dsh` base bundle already runs it, and the defaults work for most sessions — tune the thresholds and tool scope below when you want the nudge sooner, later, or on fewer tools.

### When to choose it

Choose it when the model works autonomously for long stretches and a stuck loop is the failure you want to break with advice rather than force. Avoid it when identical repeats are legitimate and must run undisturbed — the guard only reminds, and a reminder is a small extra message after the repeated call — and when near-identical variants must be caught, because exact-only matching (the plugin default) misses them; enable `fuzzySimilarity` for alternations such as a command and the same command with an appended clause.

### Setting the thresholds and scope

When you want to change when reminders fire or which tools they cover, mount the plugin with configuration:

```yaml
- name: '@deepseek-ai/dsh-repeat-tool-reminder'
  config:
    thresholds: [3, 5, 8]        # remind at 3, 5, and 8 consecutive repeats
    include: []                  # track every tool; list patterns to track only some
    exclude: [todo_write]        # never track these tools
    fuzzySimilarity: 0.9         # 1 = exact-only; < 1 merges near-identical arguments
    blockThreshold: 30           # 0 = advisory only; >= 2 blocks the repeated call
    emptyReasoningThreshold: 10  # 0 = off; degraded repeats block at this count
    argumentsPreviewChars: 500   # cap on arguments shown in the detailed reminder
```

| Field | Plugin default | Meaning |
|---|---|---|
| `thresholds` | `[3, 5, 8]` | Repeat counts that trigger a reminder |
| `include` | `[]` | Only these tools are tracked; empty means every tool |
| `exclude` | `[]` | These tools are never tracked; calls to them neither count nor reset |
| `fuzzySimilarity` | `1` | Overlap above which same-tool calls count as one chain (`1` = exact-only) |
| `blockThreshold` | `0` | Fuzzy-chain length that blocks the call (`0` = never block) |
| `emptyReasoningThreshold` | `0` | Empty-reasoning streak that lowers the block to this count (`0` = off) |
| `argumentsPreviewChars` | `500` | How many characters of the repeated arguments the detailed reminder shows |

The `dsh` base bundle overrides the last three to `0.9`, `30`, and `10`. Invalid configuration fails at startup with a clear error — an empty `thresholds` list, a repeat count below 2, a duplicate, a `fuzzySimilarity` outside `(0, 1]`, or a `blockThreshold`/`emptyReasoningThreshold` of `1` — never a silent change of behavior. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-repeat-tool-reminder) documents every accepted value.

### What you get

With the plugin defaults, a model that repeats the same call with identical arguments receives a short reminder on the third repeat — to analyze the previous result before calling again — and detailed reminders on the fifth and eighth, naming the tool and the repeated arguments so it can decide whether to change approach, gather more evidence, or finish. The base bundle adds fuzzy matching, so `git status …` and `git status … ; grep …` count as one chain, and it blocks the call at 30 repeats (or at 10 when reasoning has been empty for 10 steps): the blocked call returns an error result instead of running, so the stranded chain cannot make progress. A new user message clears both the chain and the empty-reasoning streak, so a fresh instruction is never treated as a loop. Reminders appear in the conversation after the repeated call's result, attributed to the plugin, so the model reads them like any other message.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the guard detects repeats and delivers reminders, and points at the code that realizes it; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The guard is built on five commitments:

- **Remind first, block only at the hard threshold.** Below `blockThreshold` the guard enriches post-execute decisions with model context; only at the hard threshold, or its degradation-lowered form, does it block, turning the call into an error result.
- **Count in post-execute.** Detection runs on `tools/post-execute`, which also fires for denied calls; counting there lets one listener cover every attempt with no cross-event state for the chain.
- **Canonicalize, then fuzz.** Arguments reach the guard as the loop's `JSON.parse` output (or its raw-string fallback), so JSON's value domain is the whole input domain and a deep key-sort plus `JSON.stringify` is a complete, deterministic identity — no bigint, cycle, or `undefined` handling exists because no input path can produce them. Fuzzy matching then compares word-token overlap of the canonical strings.
- **Degradation is a streak, not a vote.** Empty reasoning is counted per session from `assistant/message` events and only counts after the model has shown non-empty reasoning once; a model that never reasons is never degraded.
- **Fail loud at load.** `thresholds`, `fuzzySimilarity`, `blockThreshold`, `emptyReasoningThreshold`, and `argumentsPreviewChars` validate in `apply` and throw, never falling back to defaults.

### Detection: the repeat chain

Each agent's chain stores the last call's exact identity `(tool name, canonical arguments)` and its fuzzy fingerprint (word tokens of the canonical string). A new call continues the chain when the tool matches and either the canonical string is identical or — with `fuzzySimilarity < 1` — the token-overlap coefficient `|A ∩ B| / min(|A|, |B|)` reaches the threshold; a subset matches at `1`, so a command and the same command with an appended clause count as one step. A different tracked call that fails the fuzzy test resets the count to 1. The chain lives in a `WeakMap<Agent, Chain>`. The degradation streak lives in a separate `WeakMap<Session, Degradation>` fed by a `session/event` listener on `assistant/message` events: a step with non-whitespace reasoning sets `seenReasoning` and resets the streak, an empty step increments it only when `seenReasoning` is already true; both maps are cleared on a user-prompt `agent/pre-step`:

- **Untracked calls are transparent to the chain.** A call excluded by `include`/`exclude` neither increments nor resets the counter, so `grep X → todo_write → grep X` still counts as two consecutive `grep X` when `todo_write` is excluded — bookkeeping tools interleaved into a loop do not launder it.
- **Denied calls count.** Detection sits on `tools/post-execute`, which also runs for calls a `tools/pre-execute` listener denied; a model hammering a denied call is exactly the loop worth breaking.
- **Calls without an agent are ignored.** A direct `ctx.tools.execute()` caller has no model to remind and no live agent object to key on.
- **A downstream block is preserved.** When a later post-execute listener blocks the call, the guard keeps its feedback and only folds its own reminder onto `additionalContexts`; the guard's own block applies to an accepted call.
- **Per-agent keying, reset on user prompts.** One agent's repetition never trips another's reminder; a user prompt (`agent/pre-step`) deletes the submitting agent's chain and degradation streak, and object lifetime bounds the weak entries without a disposal listener.
- **In-memory only.** A session resumed from persistence starts with a fresh chain and streak — the guard is a heuristic nudge, not a logged invariant, so reminders after a resume are the accepted cost.

### Reminder delivery

Reminders ride the post-execute decision's `additionalContexts` (source `{kind: 'repeat-tool-reminder', form: 'notice', summary: '<tool> × <count>'}`), never a `content` replacement: the `tool/result` event stays the tool's own output for audit. The loop buffers the context and appends it as an injected `user/message` after the step's tool results, which the session renders as a plain synthetic user message — model-visible, source-attributed, and reconstructable from the session log with no new session event. A block instead returns `{kind: 'block', feedback}`: the executor turns the feedback into an error `tool/result` without running the tool body, and the guard prepends its reminder to the block's `additionalContexts` when one is due. The guard always delegates via `next()` and prepends its reminder to the downstream decision's context array, so both decision variants (a blocked call included) still get the nudge while every entry retains its own source and metadata. The effective hard limit is `blockThreshold`, lowered to `emptyReasoningThreshold` once the empty-reasoning streak reaches it; every later call in the same chain blocks again.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config` schema, fail-loud validation, chain listeners |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the tools waterfall to exhaustive configuration and the guard group map.

- [Tools subsystem reference](../../../docs/subsystems/tools.md) — the `tools/execute` waterfall, `additionalContexts`, and decision shapes this guard consumes.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-repeat-tool-reminder) — every accepted config field and its source declaration.
- [guard group map](../README.md) — the sibling guard packages and the loop-hygiene family.

-----

<a id="model-experience"></a>
## Model Experience

### First-threshold context message

#### What the model sees

At the first configured consecutive-repeat threshold, that agent receives the reminder below. No tool schema or normal-call text is added.

##### First-threshold reminder

```markdown
You are repeating the exact same tool call with identical arguments. Carefully analyze the previous result before calling again: if the task is not complete, try a different approach or different arguments instead of repeating the call.
```

#### Token effect

Zero tokens before the threshold. The reminder is retained history for that agent.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Later-threshold context message

#### What the model sees

A later threshold receives the detailed reminder template below. A capped argument preview ends exactly `… (+<omitted> more chars)`.

##### Later-threshold reminder

```markdown
Repeated tool call detected:
- tool: <toolName>
- consecutive_calls: <count>
- arguments: <canonicalArguments>
The repeated calls are not making progress. Do not call this tool with these exact arguments again. Inspect the latest result and choose a different action, different arguments, or finish the task if enough evidence has been gathered.
```

#### Token effect

Each reminder is retained history; `argumentsPreviewChars` bounds its data-dependent argument text, while agents keep independent counters.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Hard-block tool result

#### What the model sees

At the effective hard limit, the repeated call is blocked: the model sees an error `tool/result` with the template below instead of the tool output. A reminder, when due at the same count, is also attached as injected context.

##### Hard-block feedback

```markdown
Repeated tool call blocked (loop detected):
- tool: <toolName>
- consecutive_calls: <count>
- arguments: <canonicalArguments>
[- empty_reasoning_steps: <streak> — only when the block is degradation-lowered]
The repeated calls are not making progress. Do not call this tool with these or similar arguments again. The turn cannot continue usefully on this chain: finish the task with text, choose a different action, or ask the user how to proceed.
```

#### Token effect

The block feedback is retained history for that agent; `argumentsPreviewChars` bounds its data-dependent argument text, while agents keep independent counters.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the guard is a poor fit. They are current package constraints, not a task backlog.

- **Token-overlap fuzziness is coarse** — word tokens split on `[^A-Za-z0-9_]`, so two short commands differing in one token (`ls /tmp/a` vs `ls /tmp/b`) score below `0.9` and evade the chain; lower `fuzzySimilarity` to catch them at the cost of more false positives.
- **Compaction does not reset chains** — a chain spanning a compaction checkpoint keeps counting.
- **A block denies one call, not the turn** — the turn ends only when the model stops calling tools (or the user aborts); a `agent/pre-step` reject that would kill the turn outright is deferred.
- **No subagent chain-sharing** — chains stay isolated per agent; a parent and its subagent repeating the same call never combine.
- **Legitimate idempotent polling still draws nudges** past the thresholds — the pressure valves are the `thresholds`/`exclude` config.
- **Past the highest threshold a chain goes silent** — reminders fire only at exact configured counts, never beyond them.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

The [repeat-tool-guard feature note](../../../.agents/notes/archived/feature/2026-07-08-repeat-tool-guard.md) records the original design and alternatives under the former package name; the [naming ledger](../../../.agents/notes/archived/architecture/2026-08-11-repository-naming-contract-and-rename-ledger.md) records the rename to `repeat-tool-reminder` and its reason.

</details>
