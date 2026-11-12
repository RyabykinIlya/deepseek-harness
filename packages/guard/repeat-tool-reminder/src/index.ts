/**
 * Per-agent repeat-call guard. It nudges the model out of identical and
 * near-identical (fuzzy) tool-call loops with advisory reminders, and at a
 * configured hard threshold replaces the call result with a block. A separate
 * degradation streak (consecutive steps with no reasoning) lowers the hard
 * threshold. Configuration and chain semantics live in the package README;
 * rationale lives in the repeat-tool-reminder Agent Note.
 * @module @deepseek-ai/dsh-repeat-tool-reminder
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'repeat-tool-reminder': { kind: 'repeat-tool-reminder' } & ContextFormed
  }
}

import type { MessageSource } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, UserMessage } from '@deepseek-ai/dsh-session'
import type { PostToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'

export const name = 'repeat-tool-reminder'

/**
 * Plugin config, validated by the same-named schemastery schema plus the
 * load-time checks in `apply` (misconfiguration fails loud: an empty
 * `thresholds` list, a non-integer, a value below 2, or a duplicate throws at
 * plugin load, never a silent fall-back). `include`/`exclude` entries are
 * `*`-wildcard predicates over tool names at call time, not references to
 * registry entries — a pattern matching no currently registered tool is valid
 * (`exclude: [mcp_*]` must stay legal in a deployment that loads no MCP tools).
 */
export interface Config {
  /** Consecutive-repeat counts that trigger a reminder (default `[3, 5, 8]`). */
  thresholds?: number[]
  /** Tool-name patterns to track; empty means every tool is tracked. */
  include?: string[]
  /** Tool-name patterns transparent to the chain (neither count nor reset). */
  exclude?: string[]
  /**
   * Overlap coefficient of canonical-argument tokens above which two calls
   * with the same tool count as the same chain step (default `1`: exact-only).
   * `0.9` catches `git status …` vs `git status … ; grep …` alternations.
   */
  fuzzySimilarity?: number
  /**
   * Fuzzy-chain length at which the call is blocked instead of reminded
   * (default `0`: never block — advisory only). `>= 2` enables the hard stop.
   */
  blockThreshold?: number
  /**
   * Consecutive empty-reasoning steps that count as degradation (default `0`:
   * disabled). When degradation is active the effective block threshold drops
   * to this value: a repeating call blocks once both the fuzzy chain and the
   * empty-reasoning streak reach it.
   */
  emptyReasoningThreshold?: number
  /**
   * Maximum characters of canonical arguments quoted in the DETAILED reminder
   * (default 500). Large payloads (a `write` body, a long command) would
   * otherwise ride into the next request unbounded — precisely in a loop
   * scenario; the cap bounds the reminder, never the detection (the chain key
   * always compares the FULL canonical string).
   */
  argumentsPreviewChars?: number
}

export const Config: z<Config> = z.object({
  thresholds: z.array(z.number()).default([3, 5, 8]),
  include: z.array(z.string()).default([]),
  exclude: z.array(z.string()).default([]),
  fuzzySimilarity: z.number().default(1),
  blockThreshold: z.number().default(0),
  emptyReasoningThreshold: z.number().default(0),
  argumentsPreviewChars: z.number().default(500),
})

/**
 * The `{kind:'repeat-tool-reminder'}` producer source stamped on every reminder
 * this guard injects — the label is load-bearing (an unlabeled context would
 * render as a user prompt in derived history).
 */
const REMINDER_SOURCE: MessageSource = { kind: 'repeat-tool-reminder' }

/**
 * The gentle first-threshold reminder. Keyed to `thresholds[0]`, not a literal
 * count, so a custom first threshold keeps the gentle-then-detailed escalation.
 */
const GENTLE_REMINDER =
  'You are repeating the exact same tool call with identical arguments. '
  + 'Carefully analyze the previous result before calling again: if the task is '
  + 'not complete, try a different approach or different arguments instead of '
  + 'repeating the call.'

/** The detailed later-threshold reminder naming the tool, the run length, and the canonical arguments. */
function detailedReminder(toolName: string, count: number, canonicalArguments: string): string {
  return 'Repeated tool call detected:\n'
    + `- tool: ${toolName}\n`
    + `- consecutive_calls: ${count}\n`
    + `- arguments: ${canonicalArguments}\n`
    + 'The repeated calls are not making progress. Do not call this tool with '
    + 'these exact arguments again. Inspect the latest result and choose a '
    + 'different action, different arguments, or finish the task if enough '
    + 'evidence has been gathered.'
}

/**
 * Model-visible feedback for a blocked repeat. Returned as the block's
 * `feedback`, so it becomes the blocked call's error result: the model sees
 * it on the next step and the tool body never runs again for this chain.
 */
interface BlockFeedbackInput {
  toolName: string
  count: number
  canonicalArguments: string
  emptyReasoningSteps: number
  degraded: boolean
}

function blockFeedback(input: BlockFeedbackInput): string {
  const { toolName, count, canonicalArguments, emptyReasoningSteps, degraded } = input
  const lines = [
    'Repeated tool call blocked (loop detected):',
    `- tool: ${toolName}`,
    `- consecutive_calls: ${count}`,
    `- arguments: ${canonicalArguments}`,
  ]
  if (degraded) {
    lines.push(`- empty_reasoning_steps: ${emptyReasoningSteps}`)
  }
  lines.push(
    'The repeated calls are not making progress. Do not call this tool with '
    + 'these or similar arguments again. The turn cannot continue usefully on '
    + 'this chain: finish the task with text, choose a different action, or '
    + 'ask the user how to proceed.',
  )
  return lines.join('\n')
}

/**
 * Deep key-sort of a parsed-JSON value so two argument objects that differ
 * only in property order canonicalize identically. Arguments reach the guard
 * as the loop's `JSON.parse` output (or its raw-string fallback for malformed
 * argument JSON), so JSON's value domain is the whole input domain — no
 * bigint, cycle, or `undefined` handling exists because no input path can
 * produce them.
 */
function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue)
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortJsonValue(record[key])
    }
    return sorted
  }
  return value
}

/** Canonical string form of a call's arguments: deep key-sort, then stringify. */
function canonicalize(argumentsValue: unknown): string {
  return JSON.stringify(sortJsonValue(argumentsValue))
}

/**
 * Word tokens of a canonical string for fuzzy overlap: runs of
 * `[A-Za-z0-9_]` (shell paths, flags, identifiers). Punctuation such as
 * `&&`, `;`, `|` and quotes separates tokens, so a command and the same
 * command with an appended `; grep …` suffix share the base token set.
 */
function tokenize(canonical: string): Set<string> {
  return new Set(canonical.match(/[A-Za-z0-9_]+/g) ?? [])
}

/**
 * Overlap coefficient `|A ∩ B| / min(|A|, |B|)`: a subset matches at `1`, so
 * `git status …` vs `git status … ; grep …` counts as the same chain step
 * while `ls` vs `pwd` scores `0`. An empty token set on either side falls
 * back to exact string equality (`1` if equal, `0` otherwise).
 */
function overlap(a: Set<string>, b: Set<string>, exactEqual: boolean): number {
  if (a.size === 0 || b.size === 0) return exactEqual ? 1 : 0
  let intersection = 0
  for (const token of a) {
    if (b.has(token)) intersection += 1
  }
  return intersection / Math.min(a.size, b.size)
}

/** Compile one `*`-wildcard pattern to an anchored RegExp (every other regex metacharacter is matched literally). */
function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, String.raw`\$&`)
  return new RegExp(`^${escaped.replaceAll('*', '.*')}$`)
}

/**
 * Head-truncate the canonical arguments for quoting in the detailed reminder,
 * marking how much was omitted. Bounds only the model-visible text — the
 * chain key always uses the full canonical string.
 */
function previewArguments(canonical: string, cap: number): string {
  if (canonical.length <= cap) return canonical
  return `${canonical.slice(0, cap)}… (+${canonical.length - cap} more chars)`
}

/**
 * Validate `thresholds` per the fail-loud contract and return them sorted
 * ascending (the escalation rule reads `thresholds[0]` as the gentle tier, so
 * order is normalized here, once).
 */
function validateThresholds(values: number[]): number[] {
  if (values.length === 0) {
    throw new Error('repeat-tool-reminder: `thresholds` must not be empty')
  }
  for (const value of values) {
    if (!Number.isInteger(value) || value < 2) {
      throw new Error(`repeat-tool-reminder: invalid threshold ${value} — every threshold must be an integer >= 2`)
    }
  }
  if (new Set(values).size !== values.length) {
    throw new Error('repeat-tool-reminder: `thresholds` must not contain duplicates')
  }
  return [...values].sort((a, b) => a - b)
}

/** Validate the fuzzy overlap threshold: `(0, 1]` (default `1` = exact-only). */
function validateFuzzySimilarity(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error(`repeat-tool-reminder: invalid fuzzySimilarity ${value} — must be in (0, 1]`)
  }
  return value
}

/** Validate a hard/degradation threshold: `0` = disabled, otherwise integer `>= 2`. */
function validateCountThreshold(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0 || (value === 1)) {
    throw new Error(`repeat-tool-reminder: invalid ${name} ${value} — must be 0 (disabled) or an integer >= 2`)
  }
  return value
}

/**
 * Prepend the guard's reminder while preserving every downstream context's
 * source and metadata.
 */
function prependContext(ours: UserMessage, theirs: UserMessage[] | undefined): UserMessage[] {
  return [ours, ...theirs ?? []]
}

/**
 * One agent's consecutive-repeat chain. `key` is exact identity
 * (`[tool, canonical]`); `tokens` is the last call's fuzzy fingerprint — on a
 * fuzzy hit the chain continues across near-identical arguments, so an
 * A/B/A/B alternation never resets.
 */
interface Chain {
  key: string
  tokens: Set<string>
  count: number
}

/** Degradation streak for one session: consecutive empty-reasoning steps. */
interface Degradation {
  streak: number
  /** True once a step with non-whitespace reasoning was observed (a model that never reasons is never degraded). */
  seenReasoning: boolean
}

/**
 * Install the guard's listeners.
 * @param ctx - plugin context; listeners are scoped to it and disposed with it.
 * @param config - validated {@link Config}; `thresholds` is re-checked fail-loud here.
 */
export function apply(ctx: Context, config: Config): void {
  // schemastery's .default() guarantees the fields are set after validation.
  const thresholds = validateThresholds(config.thresholds as number[])
  const thresholdSet = new Set(thresholds)
  const includePatterns = (config.include as string[]).map(wildcardToRegExp)
  const excludePatterns = (config.exclude as string[]).map(wildcardToRegExp)
  const argumentsPreviewChars = config.argumentsPreviewChars as number
  if (!Number.isInteger(argumentsPreviewChars) || argumentsPreviewChars < 1) {
    throw new Error(`repeat-tool-reminder: invalid argumentsPreviewChars ${argumentsPreviewChars} — must be an integer >= 1`)
  }
  const fuzzySimilarity = validateFuzzySimilarity(config.fuzzySimilarity as number)
  const blockThreshold = validateCountThreshold('blockThreshold', config.blockThreshold as number)
  const emptyReasoningThreshold = validateCountThreshold('emptyReasoningThreshold', config.emptyReasoningThreshold as number)

  const chains = new WeakMap<Agent, Chain>()
  const degradations = new WeakMap<Session, Degradation>()

  /** Whether a tool participates in the chain (untracked calls are transparent: they neither count nor reset). */
  function tracked(toolName: string): boolean {
    if (includePatterns.length > 0 && !includePatterns.some(pattern => pattern.test(toolName))) return false
    return !excludePatterns.some(pattern => pattern.test(toolName))
  }

  /** Whether one step's assistant message carries non-whitespace reasoning. */
  function hasReasoning(event: SessionEvent<'assistant/message'>): boolean {
    return event.data.message.content.some(
      block => block.type === 'reasoning' && block.text.trim() !== '',
    )
  }

  // Track the empty-reasoning streak per session. A model that never emits
  // reasoning (non-reasoning routes) never sets `seenReasoning`, so its
  // streak stays at zero and degradation never boosts the block — empty
  // reasoning only counts after the model has shown it can reason.
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'assistant/message') return
    const state = degradations.get(session) ?? { streak: 0, seenReasoning: false }
    if (hasReasoning(event)) {
      state.seenReasoning = true
      state.streak = 0
    } else if (state.seenReasoning) {
      state.streak += 1
    } else {
      state.streak = 0
    }
    degradations.set(session, state)
  })

  /** The reminder for a fuzzy-chain count, if it hits a configured threshold. */
  function reminderFor(toolName: string, count: number, canonical: string): UserMessage | undefined {
    if (!thresholdSet.has(count)) return undefined
    const text = count === thresholds[0]
      ? GENTLE_REMINDER
      : detailedReminder(toolName, count, previewArguments(canonical, argumentsPreviewChars))
    return createUserMessage({
      content: [{ type: 'text', text }],
      source: { ...REMINDER_SOURCE, form: 'notice', summary: `${toolName} × ${count}` },
    })
  }

  interface Observation {
    reminder?: UserMessage
    /** When set, the call must be blocked (hard stop) — feedback is the block text. */
    block?: { feedback: string; degraded: boolean }
  }

  /**
   * Advance the calling agent's chain for one attempt and decide the guard's
   * outcome: a reminder at a configured threshold, a block at the hard
   * threshold, or nothing. Counting happens here — in post-execute — because
   * denied calls also flow through this waterfall (`ToolRuntime.execute`
   * routes a deny through the same pipeline), and a model hammering a denied
   * call is exactly the loop worth breaking.
   */
  function observe(exec: ToolExecution): Observation {
    // A direct `ctx.tools.execute()` caller has no model to remind and no id
    // to key on; only agent-loop calls participate.
    if (!exec.agent) return {}
    if (!tracked(exec.name)) return {}
    const canonical = canonicalize(exec.arguments)
    const key = JSON.stringify([exec.name, canonical])
    const tokens = tokenize(canonical)
    const chain = chains.get(exec.agent)
    const fuzzyHit = chain !== undefined
      && chain.key !== key
      && fuzzySimilarity < 1
      && overlap(chain.tokens, tokens, chain.key === key) >= fuzzySimilarity
    const count = chain !== undefined && (chain.key === key || fuzzyHit) ? chain.count + 1 : 1
    chains.set(exec.agent, { key, tokens, count })
    const observation: Observation = {}
    const reminder = reminderFor(exec.name, count, canonical)
    if (reminder !== undefined) observation.reminder = reminder
    // Hard stop: pure-repeat limit, lowered to `emptyReasoningThreshold` once
    // reasoning has been empty for that many steps (repeating + degraded).
    const degradation = degradations.get(exec.agent.session)
    const emptyReasoningSteps = degradation?.seenReasoning === true ? degradation.streak : 0
    const degraded = emptyReasoningThreshold > 0 && emptyReasoningSteps >= emptyReasoningThreshold
    let hardLimit = Number.POSITIVE_INFINITY
    if (blockThreshold > 0) hardLimit = blockThreshold
    if (degraded) hardLimit = Math.min(hardLimit, emptyReasoningThreshold)
    if (Number.isFinite(hardLimit) && count >= hardLimit) {
      const preview = previewArguments(canonical, argumentsPreviewChars)
      const feedback = blockFeedback({ toolName: exec.name, count, canonicalArguments: preview, emptyReasoningSteps, degraded })
      observation.block = { feedback, degraded }
    }
    return observation
  }

  // Observe first (state advances regardless of the downstream outcome),
  // DELEGATE so a later listener can still block or replace, then fold the
  // outcome onto whatever came back. A downstream block is preserved with its
  // feedback; the guard's own block applies to an accepted call.
  ctx.on('tools/post-execute', async (exec, _result, next): Promise<PostToolDecision> => {
    const observation = observe(exec)
    const downstream = await next()
    if (downstream.kind === 'block') {
      if (observation.reminder === undefined) return downstream
      return { kind: 'block', feedback: downstream.feedback, additionalContexts: prependContext(observation.reminder, downstream.additionalContexts) }
    }
    if (observation.block !== undefined) {
      const additionalContexts = observation.reminder === undefined
        ? [...(downstream.additionalContexts ?? [])]
        : prependContext(observation.reminder, downstream.additionalContexts)
      return {
        kind: 'block',
        feedback: [{ type: 'text' as const, text: observation.block.feedback }],
        additionalContexts,
      }
    }
    if (observation.reminder === undefined) return downstream
    return {
      ...downstream,
      additionalContexts: prependContext(observation.reminder, downstream.additionalContexts),
    }
  })

  // A user interjection changes the context; repetition across it is not a
  // loop. Pure reset hook: always delegates (attaching nothing, vetoing
  // nothing).
  ctx.on('agent/pre-step', ({ agent, messages }, next): Promise<PreStepDecision> => {
    if (messages.some(message => message.source.kind === 'user')) {
      chains.delete(agent)
      degradations.delete(agent.session)
    }
    return next()
  })
}
