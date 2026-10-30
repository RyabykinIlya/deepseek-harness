/**
 * Model-facing delegation through one configured `ctx.subagents` provider.
 * Provider lifecycle controls tool registration and context-sensitive schema
 * wording. Foreground calls collect the child's result and release the
 * activation; one-shot background calls own a plain job; continuable calls use
 * `ctx.subagents.startActivation()` with parent delivery and return the durable
 * child id. The subagent runtime owns execution and resource cleanup.
 * @module @deepseek-ai/dsh-tool-subagent
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import {
  assertSubagentMaxDepth,
  delegationDepthOf,
  parentAgentOptionsForDelegation,
} from '@deepseek-ai/dsh-subagent'
import type { SubagentProvider, SubagentResult, SubagentRun } from '@deepseek-ai/dsh-subagent'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import {
  AllowedModelRouteSchema,
  assertAllowedModelRoutes,
  assertAllowedModelSelection,
  hasConfiguredLlmSelection,
  hasDelegationModelRequest,
  preflightChildLlmRoute,
  requestedAgentOptions,
} from './model-selection.ts'
import type { AllowedModelRoute, DelegationModelRequest } from './model-selection.ts'
import { registerListSubagentModels } from './list-models.ts'
import { SubagentPresetSelection, type PresetSelectionConfig, type PresetSelectionRequest } from './preset-selection.ts'
import {
  subagentModelSelectionProjectionDefinition,
  subagentModelSelectionPolicy,
} from './model-selection-state.ts'

// One-shot background delegation is this package's job producer; the registry
// treats the kind as an opaque id namespace.
declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    subagent: 'subagent'
  }
}

export const name = 'tool-subagent'
export const inject = ['tools', 'subagents', 'systemPrompt', 'sessionProjections']

// Definition identity keeps shared guidance scoped to the actual visible tools,
// including scoped overrides and independently loaded tool registries.
const delegationTools = new Set<ToolDefinition>()

/** Config: which registered provider this tool delegates to, plus child defaults. */
export interface Config extends PresetSelectionConfig {
  /** The `ctx.subagents` provider name to start runs on (e.g. `spawn`, `acp`). */
  provider: string
  /**
   * Model-facing tool name (default `subagent`). Each loaded instance must use
   * a distinct name.
   */
  toolName?: string
  /**
   * Expose optional child `provider`, `model`, and `reasoning_effort` fields.
   * Requires provider `agentOptions` support. Execution enforces the Session
   * policy, or restricts explicit selection to the current parent route.
   * Mutually exclusive with `allowedModels`.
   */
  modelSelection?: boolean
  /**
   * Register the shared `list_subagent_models` tool for this scope.
   * Enable on only one instance per scope; defaults to false and does not
   * enable model selection. Discovery is removed when this instance unloads.
   * Ignored (and unnecessary) when `allowedModels` is set: a fixed route list
   * already mounts its own discovery over the same routes.
   */
  modelDiscovery?: boolean
  /**
   * Fixed child LLM routes this tool instance offers, independent of the Host
   * `subagent-model-selection` setting. Non-empty: every Session gets these exact
   * routes as its selection policy — the tool exposes `provider`, `model` and
   * `reasoning_effort`, mounts `list_subagent_models`, and records no
   * `subagent/model-selection-policy`. Absent or empty: no effect.
   * Requires provider `agentOptions` support; mutually exclusive with `modelSelection`.
   */
  allowedModels?: AllowedModelRoute[]
  /**
   * Expose `run_in_background` (default true). Disabled instances omit the
   * parameter and reject forced background calls.
   */
  enableRunInBackground?: boolean
  /**
   * Background execution policy (default `one-shot`). `one-shot` defaults calls
   * to foreground; `continuable` defaults them to background, requires a provider
   * with the `prepareContinuable` capability, and returns the durable child id.
   * Follow-up adapters remain independently optional.
   */
  backgroundMode?: 'one-shot' | 'continuable'
  /**
   * Agent options applied to every child; omitted fields use child-loop defaults.
   */
  agentOptions?: AgentOptions
  /**
   * Maximum child depth: a non-negative safe integer (`0` forbids delegation),
   * or `'provider-managed'` to send no cap. A numeric cap
   * requires the provider's `depthLimit` capability (mount fails loud
   * otherwise). The provider checks the calling agent's current depth at every
   * start; the tool remains model-visible so runtime policy owns rejection.
   * `'provider-managed'` is for an out-of-process provider whose recursion
   * budget belongs to the child runtime or its own deployment. Omission reads
   * the current Host subagent depth setting (default `1`) at each delegation.
   */
  maxDepth?: number | 'provider-managed'
}

export const Config: z<Config> = z.object({
  provider: z.string().required(),
  toolName: z.string().default('subagent'),
  modelSelection: z.boolean().default(false),
  modelDiscovery: z.boolean().default(false),
  // No default: Schemastery materializes an absent array as `[]`, and an empty
  // list must read as "no effect" rather than as a policy nobody configured.
  allowedModels: z.array(AllowedModelRouteSchema),
  enableRunInBackground: z.boolean().default(true),
  backgroundMode: z.union(['one-shot', 'continuable'] as const).default('one-shot'),
  // Prevent Schemastery from materializing omitted agentOptions as `{}`.
  agentOptions: z.object({
    provider: z.string(),
    model: z.string(),
    reasoningEffort: z.string().min(1) as z<ReturnType<typeof ReasoningEffortId> | undefined>,
    maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
  }).default(undefined as unknown as {
    provider: string
    model: string
    reasoningEffort: ReturnType<typeof ReasoningEffortId>
    maxTokens: number
  }),
  agentPreset: z.string().min(1),
  allowedAgentPresets: (z.array(z.string().min(1)).min(1) as z<string[] | undefined>).default(undefined),
  maxDepth: z.union([z.natural().max(Number.MAX_SAFE_INTEGER), z.const('provider-managed' as const)]),
})

/** Render text blocks from a collected child's output. */
function outputValueText(values: readonly JsonValue[]): string {
  return values
    .filter((value): value is { type: 'text'; text: string } =>
      typeof value === 'object' && value !== null && !Array.isArray(value)
      && value.type === 'text' && typeof value.text === 'string')
    .map(value => value.text)
    .join('')
}

/**
 * Project collected child output blocks into this tool's canonical JSON output.
 *
 * Content block interfaces carry no index signature, so they are not assignable
 * to {@link JsonValue} and no single assertion relates the two. The round trip
 * is this boundary's own lossless-JSON snapshot, which is what the tool output
 * contract asks for anyway.
 * @param blocks - the child's collected output blocks.
 * @returns the same blocks as canonical JSON values.
 */
function outputAsJson(blocks: readonly ContentBlock[]): JsonValue[] {
  const parsed: unknown = JSON.parse(JSON.stringify(blocks))
  return parsed as JsonValue[]
}

/** One provider handle as the tool's canonical output records it. */
interface ContinuableHandle {
  readonly name: string
  readonly value: string
}

/**
 * Render one continuable start as the child id plus one `name: value` line per
 * handle the provider reported, so a coordinating parent quotes verified values
 * instead of reconstructing them from the child id. Providers that report none
 * keep the single-line result.
 * @param value - the validated continuable start value this tool produced.
 * @returns the model-facing start result text.
 */
function continuableStartText(
  value: { readonly subagentId: string; readonly handles?: readonly ContinuableHandle[] },
): string {
  const lines = value.handles?.map(handle => `${handle.name}: ${handle.value}`) ?? []
  return [`started subagent ${value.subagentId}`, ...lines].join('\n')
}

/** Flatten a child's final output blocks to the job's final text. */
function finalText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/** Render a failed stop reason with optional provider-authored detail. */
function failureDetail(result: SubagentResult): string {
  return result.diagnostic === undefined
    ? result.stopReason
    : `${result.stopReason}; diagnostic: ${result.diagnostic}`
}

/**
 * Map a child result to the job outcome: completed carries final text, local
 * cancellation (`aborted` without a diagnostic) is killed, and provider-
 * diagnosed remote aborts plus every other reason are failed without partial
 * output.
 * @param result - child terminal result.
 * @returns outcome for the `ctx.jobs` registration.
 */
function runOutcome(result: SubagentResult): JobOutcome {
  switch (result.stopReason) {
    case 'completed':
      return { status: 'completed', result: finalText(result.output) }
    case 'aborted':
      return result.diagnostic === undefined
        ? { status: 'killed' }
        : { status: 'failed', detail: failureDetail(result) }
    case 'error':
    case 'max-tokens':
    case 'refusal':
      return { status: 'failed', detail: failureDetail(result) }
    // Merge-extensible reasons remain failures with provider-authored detail.
    default:
      return { status: 'failed', detail: failureDetail(result) }
  }
}

/**
 * Await the child result, dispose the run, then return its job outcome. Result
 * and disposal failures become `failed`; when both fail, both details survive.
 * @param run - live run to settle and release.
 * @returns outcome after child resources are released.
 */
async function settleRun(run: SubagentRun): Promise<JobOutcome> {
  let outcome: JobOutcome
  try {
    outcome = runOutcome(await run.result)
  } catch (error: unknown) {
    outcome = { status: 'failed', detail: String(error) }
  }
  try {
    await run.dispose()
  } catch (error: unknown) {
    const prefix = outcome.detail === undefined ? '' : `${outcome.detail}; `
    return { status: 'failed', detail: `${prefix}dispose failed: ${String(error)}` }
  }
  return outcome
}

/** Settle pending startup without rejecting the task producer contract. */
async function settleStart(start: Promise<SubagentRun>, signal: AbortSignal): Promise<JobOutcome> {
  try {
    return await settleRun(await start)
  } catch (error: unknown) {
    // Product providers aggregate startup and rollback failures. Cancellation
    // must not turn a failed cleanup into a cleanly killed Job.
    return signal.aborted && !(error instanceof AggregateError)
      ? { status: 'killed' }
      : { status: 'failed', detail: String(error) }
  }
}

/** A non-`completed` stop reason means the child did not finish cleanly. */
function stopReasonError(result: SubagentResult): string | undefined {
  switch (result.stopReason) {
    case 'completed':
      return undefined
    case 'aborted':
      return 'subagent run was cancelled'
    case 'error':
      return 'subagent run failed'
    case 'max-tokens':
      return 'subagent run hit its token limit before finishing'
    case 'refusal':
      return 'subagent declined the task'
    // Merge-extensible union: a backend may add stop reasons. Treat an unknown
    // terminal reason as a failure rather than reporting partial output as success.
    default:
      return `subagent run ended abnormally (${String(result.stopReason)})`
  }
}

/**
 * Append provider-authored failure detail and the child's preserved partial
 * answer to a stop-reason error, keeping diagnostic text separate from the
 * child's assistant output.
 * @param error - the stop-reason headline.
 * @param result - the child's terminal result.
 * @returns the headline, diagnostic, and partial text that are present.
 */
function withDiagnosticAndPartialText(error: string, result: SubagentResult): string {
  const diagnostic = result.diagnostic === undefined
    ? ''
    : `\nDiagnostic: ${result.diagnostic}`
  const text = result.output
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
  const partial = text.length === 0
    ? ''
    : `\nPartial output before the run ended:\n${text}`
  return `${error}${diagnostic}${partial}`
}

type ForegroundToolResult = {
  readonly kind: 'foreground'
  readonly runId: SubagentRun['id']
  readonly output: JsonValue[]
}

/**
 * Collect and release one foreground run without letting disposal replace an
 * independent result failure.
 */
async function settleForegroundRun(run: SubagentRun): Promise<ForegroundToolResult> {
  const [execution] = await Promise.allSettled([
    run.result.then((result): ForegroundToolResult => {
      const error = stopReasonError(result)
      if (error !== undefined) {
        // The registry converts this throw to isError; partial output is not
        // success, but the preserved partial answer still reaches the parent.
        throw new Error(withDiagnosticAndPartialText(error, result))
      }
      return {
        kind: 'foreground',
        runId: run.id,
        output: outputAsJson(result.output),
      }
    }),
  ])
  const [disposal] = await Promise.allSettled([Promise.resolve().then(() => run.dispose())])
  if (execution.status === 'rejected') {
    if (disposal.status === 'rejected') {
      throw new AggregateError(
        [execution.reason, disposal.reason],
        `subagent run failed: ${String(execution.reason)}; dispose failed: ${String(disposal.reason)}`,
      )
    }
    throw execution.reason
  }
  if (disposal.status === 'rejected') throw disposal.reason
  return execution.value
}

/**
 * Model-facing wording from the provider's conversation-history descriptor
 * ({@link SubagentProvider.inheritsParentContext}).
 * A fresh child needs a standalone prompt; a forked child already sees the
 * conversation's completed turns — telling the model to restate everything
 * (or, worse, that the child "does not see this conversation") would be false
 * for a fork.
 * @param inheritsConversation - whether the child's conversation is seeded
 *   with the parent's completed turns; this says nothing about tool, service,
 *   scope, or authority inheritance.
 * @returns the tool `description` and the `prompt` parameter description.
 */
function providerWording(inheritsConversation: boolean): { description: string; promptDescription: string } {
  if (inheritsConversation) {
    return {
      description:
        'Delegate a task to a subagent that inherits this conversation: a child agent seeded with all '
        + 'completed turns so far (it does not see the current in-flight turn). Use this when the subtask '
        + 'builds on this conversation\'s context — a follow-up analysis, '
        + 'a review, a continuation — without consuming this conversation\'s context for the work itself. '
        + 'You receive its result, not its intermediate steps.',
      promptDescription:
        'The task for the subagent. It already sees this conversation\'s completed turns, so build on them '
        + 'freely and state only what is new.',
    }
  }
  return {
    description:
      'Delegate a self-contained task to a subagent (a separate agent that works in its own context) '
      + 'to offload focused, independent work — research, a scoped '
      + 'implementation, an analysis — so it does not consume this conversation\'s context. The subagent '
      + 'returns its result, not its intermediate steps.',
    promptDescription:
      'The complete, self-contained task for the subagent. It does not share this '
      + 'conversation\'s context, so include everything it needs.',
  }
}

interface DelegationRunRequest {
  readonly run_in_background?: boolean
}

interface DelegationRunSpec {
  readonly runInBackground: boolean
}

interface DelegationRepositoryRequest {
  readonly repository?: string
}

/**
 * Resolve the model's optional repository choice, refusing one this provider
 * cannot honor.
 * @param request - the model-supplied arguments.
 * @param options - whether the mounted provider accepts a repository, and its name for the refusal.
 * @returns the named repository, or undefined when the model named none.
 */
function resolveDelegationRepository(
  request: DelegationRepositoryRequest,
  options: { readonly supported: boolean; readonly provider: string },
): string | undefined {
  const repository = request.repository
  if (repository === undefined) return undefined
  if (!options.supported) {
    // The validator permits undeclared keys, so schema omission also needs
    // execution-time enforcement.
    throw new Error(
      `repository is not available for provider "${options.provider}", which does not select a`
      + ' repository per subagent; omit the parameter',
    )
  }
  if (repository.trim().length === 0) {
    throw new Error(
      'repository was empty; name a repository inside your working directory, or omit the parameter'
      + ' to use your working directory',
    )
  }
  return repository
}

/** Resolve the model's optional scheduling request into one execution route. */
function resolveDelegationRun(
  request: DelegationRunRequest,
  options: { readonly backgroundEnabled: boolean; readonly continuable: boolean; readonly isolatesForeground: boolean },
): DelegationRunSpec {
  if (!options.backgroundEnabled) {
    // The validator permits undeclared keys, so schema omission also needs
    // execution-time enforcement.
    if (request.run_in_background === true) {
      throw new Error('run_in_background is disabled for this tool instance (enableRunInBackground: false)')
    }
    return { runInBackground: false }
  }
  if (options.isolatesForeground && request.run_in_background === false) {
    // This provider isolates its child only while preparing a continuable
    // creation (the Thread provider's git worktree is created there and nowhere
    // else), so the foreground route would run the child in the parent's own
    // cwd — unisolated, writing into the Project checkout. Refused rather than
    // answered with the isolation silently dropped. A provider that isolates
    // nothing on either route keeps the foreground option.
    throw new Error(
      'run_in_background: false is not available for this provider, because the foreground route'
      + ' would run the child outside the isolation this provider establishes; omit the parameter'
      + ' to start the child in the background',
    )
  }
  return {
    // Continuable work is independently scheduled unless the caller explicitly
    // needs the result before its next action. One-shot policy keeps its existing
    // foreground default because its background result requires Task collection.
    runInBackground: request.run_in_background ?? options.continuable,
  }
}

/**
 * Install one delegation-tool composition.
 * The owning composition shares its registrations across Agents; child startup resolves the selected preset.
 * @param ctx - Context that owns the registrations.
 * @param config - delegation-tool configuration.
 * @returns when the plugin is ready.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  for (const field of ['persona', 'toolFilter']) {
    if (Object.hasOwn(config, field)) {
      throw new Error(`tool-subagent: ${field} is no longer supported; configure persona and tool plugins in an Agent Preset and select it with agentPreset (spawn only)`)
    }
  }
  const presets = new SubagentPresetSelection(config)
  if (presets.configured && ctx.get('agentPresets') === undefined) {
    throw new Error('tool-subagent: agent preset selection requires the agent-presets service')
  }
  // Direct apply() bypasses Schemastery's numeric constraints. A direct-apply
  // omission stays capless (the schema default only runs through the loader).
  if (config.maxDepth !== 'provider-managed') assertSubagentMaxDepth(config.maxDepth)
  const backgroundEnabled = config.enableRunInBackground !== false
  const continuable = (config.backgroundMode ?? 'one-shot') === 'continuable'
  const toolName = config.toolName ?? 'subagent'

  // A deployment-owned route list is the same capability the Host setting
  // provides, decided in configuration instead of sampled per Session — so the
  // two together would leave two sources of truth for one tool. Refused at load,
  // not at the first call, because the conflict is a configuration fault.
  const fixedRoutes = config.allowedModels !== undefined && config.allowedModels.length > 0
    ? config.allowedModels
    : undefined
  if (fixedRoutes !== undefined && config.modelSelection === true) {
    throw new Error('tool-subagent: `allowedModels` and `modelSelection` are mutually exclusive')
  }
  if (fixedRoutes !== undefined) assertAllowedModelRoutes(fixedRoutes)
  const modelSelectionEnabled = config.modelSelection === true || fixedRoutes !== undefined
  const subagentModelSelectionProjectionHandle = await ctx.sessionProjections.register(subagentModelSelectionProjectionDefinition)

  const assertSubagentProviderConfiguration = (subagentProvider: SubagentProvider): void => {
    presets.assertProvider(subagentProvider)
    if (ctx.subagents.resolveMaxDepth(config.maxDepth) !== undefined && !subagentProvider.capabilities.depthLimit) {
      throw new Error(
        `tool-subagent: provider "${subagentProvider.name}" cannot enforce maxDepth (no depthLimit capability) — `
        + 'set maxDepth: \'provider-managed\' to leave the recursion budget to the provider',
      )
    }
    if (config.agentOptions !== undefined && !subagentProvider.capabilities.agentOptions) {
      throw new Error(
        `tool-subagent: provider "${subagentProvider.name}" does not support child agentOptions`,
      )
    }
    if (modelSelectionEnabled && !subagentProvider.capabilities.agentOptions) {
      throw new Error(
        `tool-subagent: provider "${subagentProvider.name}" does not support child model selection`,
      )
    }
    if (continuable && subagentProvider.prepareContinuable === undefined) {
      throw new Error(
        `tool-subagent: provider "${subagentProvider.name}" does not support \`backgroundMode: continuable\``,
      )
    }
  }

  // Validate provider-owned config outside the optional LLM binding so an
  // invalid provider always rejects its registration or this plugin's load.
  ctx.on('subagent/provider-added', (subagentProvider) => {
    if (subagentProvider.name === config.provider) assertSubagentProviderConfiguration(subagentProvider)
  })
  const initialProvider = ctx.subagents.getProvider(config.provider)
  if (initialProvider !== undefined) assertSubagentProviderConfiguration(initialProvider)

  // A fixed route list mounts its own discovery over those exact routes; a
  // redundant `modelDiscovery: true` would otherwise double-register the
  // shared tool name and throw. The handle is synthetic: the routes come from
  // configuration, not from any Session's folded events, so every reader
  // returns the same list.
  if (fixedRoutes !== undefined) {
    registerListSubagentModels(ctx, {
      stateOf: () => fixedRoutes,
      readerFor: () => () => fixedRoutes,
      dispose: () => Promise.resolve(),
    })
  } else if (config.modelDiscovery === true) {
    registerListSubagentModels(ctx, subagentModelSelectionProjectionHandle)
  }

  // Load order and HMR replacement can change provider availability while
  // this fiber remains active.
  let mounted: { subagentProvider: SubagentProvider; definition: ToolDefinition; disposeTool: () => void } | undefined
  const mount = (subagentProvider: SubagentProvider): void => {
    assertSubagentProviderConfiguration(subagentProvider)
    const wording = providerWording(subagentProvider.inheritsParentContext)
    const isolatesForeground = subagentProvider.isolatesContinuableCwd === true
    const repositorySupported = subagentProvider.capabilities.repository ?? false
    const providerRouteDefaults = subagentProvider.agentRouteDefaults
    const selectionDescription = providerRouteDefaults !== undefined
      ? ' Supply `provider` and `model` together. Omitted values use child defaults, falling back to this backend\'s route defaults. When the effective route changes, an omitted `reasoning_effort` uses the model\'s default.'
      : ' Supply `provider` and `model` together. Omitted values use child defaults, falling back to compatible parent values. When the effective route changes, an omitted `reasoning_effort` uses the model\'s default.'
    const definition = defineTool({
      name: toolName,
      description: wording.description + (backgroundEnabled
        // The completion notice is the continuation service's own behavior, not
        // a separately installed capability, so this promise holds whenever the
        // continuable background path is reachable at all.
        ? continuable
          ? ' It runs in the background by default and returns a subagent id you can continue with `send_message`; you are notified when the run settles.'
          : ' This call waits for the result by default.'
        : ' This call waits for the subagent and returns its result.')
        + (modelSelectionEnabled ? selectionDescription : '')
        + (modelSelectionEnabled && subagentProvider.inheritsParentContext
          ? ' Changing the route can prevent provider-side reuse of the inherited conversation prefix.'
          : ''),
      parameters: {
        cwd: {
          type: 'string',
          description: 'Initial child working directory. Relative paths use your current directory; omitted inherits it. Later directory changes in either agent are independent.',
        },
        description: {
          type: 'string',
          required: true,
          description: 'A short (3-5 word) description of the delegated task, for display.',
        },
        prompt: {
          type: 'string',
          required: true,
          description: wording.promptDescription,
        },
        ...presets.choices === undefined ? {} : {
          agent_preset: {
            type: 'string' as const,
            enum: [...presets.choices],
            description: presets.description,
          },
        },
        ...modelSelectionEnabled ? {
          provider: {
            type: 'string' as const,
            description: 'Child LLM provider id.',
          },
          model: {
            type: 'string' as const,
            description: 'Model id within that provider.',
          },
          reasoning_effort: {
            type: 'string' as const,
            description: 'Model-specific reasoning effort id.',
          },
        } : {},
        ...backgroundEnabled ? {
          run_in_background: {
            type: 'boolean' as const,
            description: isolatesForeground
              ? 'Always runs in the background; omit this parameter. `false` is refused, because only the background route runs the child inside the isolation this provider establishes.'
              : continuable
                ? 'Defaults to true. Set false only when your next action depends on the result.'
                : 'Run as a background job and return its id (collect with job_output, stop with job_kill). Defaults to false.',
          },
        } : {},
        ...repositorySupported ? {
          repository: {
            type: 'string' as const,
            description: 'Repository this subagent works in, named as a path inside your working directory —'
              + ' usually a subdirectory name. Required when your working directory is not itself a'
              + ' repository but holds several; omit it when your working directory is already the'
              + ' repository you mean.',
          },
        } : {},
      },
      output: {
        schema: {
          oneOf: [
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true, const: 'background' },
                jobId: { type: 'string', required: true },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true, const: 'continuable' },
                subagentId: { type: 'string', required: true },
                handles: {
                  type: 'array',
                  description: 'Provider-reported handles for the child, as the parent must quote them.',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      name: { type: 'string', required: true },
                      value: { type: 'string', required: true },
                    },
                  },
                },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true, const: 'foreground' },
                runId: { type: 'string', required: true },
                output: { type: 'array', required: true, items: { type: 'json' } },
              },
            },
          ],
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.kind === 'background'
            ? `started background subagent job ${value.jobId}`
            : value.kind === 'continuable'
              ? continuableStartText(value)
              : outputValueText(value.output),
        }],
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const parent = exec.agent
        if (!parent) {
          // Non-agent callers provide no parent for delegation ownership.
          throw new Error('subagent tool requires a calling agent (exec.agent was undefined)')
        }

        const routes = fixedRoutes ?? subagentModelSelectionPolicy(subagentModelSelectionProjectionHandle, parent.session)
        const modelSelectionPolicy = routes === undefined ? undefined : { routes }
        const agentPreset = presets.resolve(args as PresetSelectionRequest)
        const modelRequest = args as DelegationModelRequest
        const parentOptions = parentAgentOptionsForDelegation(parent)
        const requiresRoutePreflight = hasDelegationModelRequest(modelRequest)
          || hasConfiguredLlmSelection(config.agentOptions)
        const configuredChildAgentOptions = requiresRoutePreflight && providerRouteDefaults !== undefined
          ? { ...providerRouteDefaults, ...config.agentOptions }
          : config.agentOptions
        const requestedChildAgentOptions = requestedAgentOptions(
          parentOptions,
          configuredChildAgentOptions,
          modelRequest,
          modelSelectionEnabled,
        )
        assertAllowedModelSelection(
          modelSelectionPolicy,
          parentOptions,
          requestedChildAgentOptions,
          modelRequest,
        )
        if (requiresRoutePreflight) {
          const llm = ctx.get('llm')
          if (llm === undefined) {
            throw new Error('cannot resolve the selected child LLM route because the `llm` service is unavailable')
          }
          await preflightChildLlmRoute(
            llm,
            parentOptions,
            requestedChildAgentOptions,
            exec.signal,
            providerRouteDefaults === undefined,
          )
          if (ctx.subagents.getProvider(config.provider) !== subagentProvider) {
            throw new Error(`subagent provider "${config.provider}" changed while resolving the child LLM route; retry the delegation`)
          }
        }
        exec.signal.throwIfAborted()
        const maxDepth = ctx.subagents.resolveMaxDepth(config.maxDepth)
        const repository = resolveDelegationRepository(args as DelegationRepositoryRequest, {
          supported: repositorySupported,
          provider: subagentProvider.name,
        })
        // The activation spec carries `label` itself; its `request` is the
        // `Omit<SubagentStartRequest, 'label' | 'signal'>` face.
        const request = {
          ...args.cwd === undefined ? {} : { cwd: args.cwd },
          prompt: [{ type: 'text', text: args.prompt }] as ContentBlock[],
          parent,
          ...agentPreset === undefined ? {} : { agentPreset },
          ...requestedChildAgentOptions !== undefined ? { agentOptions: requestedChildAgentOptions } : {},
          ...maxDepth !== undefined ? { maxDepth } : {},
          ...repository !== undefined ? { repository } : {},
        }

        const runSpec = resolveDelegationRun(args, {
          backgroundEnabled,
          continuable,
          isolatesForeground,
        })
        if (runSpec.runInBackground) {
          if (continuable) {
            // Resolves at inbox acceptance: the child owns its own turns from
            // there, so this call neither waits for nor collects a result.
            const started = await ctx.subagents.startActivation({
              provider: config.provider,
              label: args.description,
              request,
              signal: exec.signal,
              delivery: 'parent',
            })
            // Handles travel as a name/value array, not the provider's own map,
            // so the output schema validates each handle's string value.
            return {
              kind: 'continuable' as const,
              subagentId: started.childId,
              ...started.handles === undefined
                ? {}
                : { handles: Object.entries(started.handles).map(([name, value]) => ({ name, value })) },
            }
          }
          if (subagentProvider.start === undefined) {
            // A continuable-only provider has no one-shot run to hand to the
            // job, and the activation seam would otherwise reach it as an
            // opaque TypeError inside the job's starter.
            throw new Error(
              `tool-subagent: provider "${subagentProvider.name}" does not support one-shot background`
                + ' delegation (no `start`); run in the foreground or configure `backgroundMode: continuable`',
            )
          }
          const jobs = ctx.get('jobs')
          if (jobs === undefined) {
            throw new Error('background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs')
          }
          // One-shot background child: job preflight finishes before the
          // starter can spawn, and the task-owned signal covers startup. After
          // publication the spec signal stops reaching the child, so cancel
          // also disposes the activation receipt (idempotent).
          const id = jobs.start({
            kind: 'subagent',
            label: args.description,
            owner: parent.id,
            run: () => {
              const controller = new AbortController()
              let published: Awaited<ReturnType<typeof ctx.subagents.startActivation>> | undefined
              const start = ctx.subagents.startActivation({
                provider: config.provider,
                label: args.description,
                request,
                signal: controller.signal,
                delivery: 'caller',
              }).then((activation) => {
                published = activation
                return {
                  id: activation.childId,
                  result: activation.result,
                  dispose: () => activation.dispose(),
                }
              })
              return {
                cancel: (reason?: string) => {
                  controller.abort(reason ?? 'background subagent task killed')
                  void published?.dispose()
                },
                done: settleStart(start, controller.signal),
                // No output sources: the child session owns intermediate detail.
              }
            },
          })
          return { kind: 'background' as const, jobId: id }
        }

        const started = await ctx.subagents.startActivation({
          provider: config.provider,
          label: args.description,
          request,
          signal: exec.signal,
          delivery: 'caller',
        })
        return settleForegroundRun({
          id: started.childId,
          result: started.result,
          dispose: () => started.dispose(),
        })
      },
    })
    const disposeTool = ctx.effect(() => {
      const unregister = ctx.tools.register(definition)
      delegationTools.add(definition)
      return () => {
        delegationTools.delete(definition)
        unregister()
      }
    })
    // oxlint-disable-next-line typescript/no-misused-promises -- Tool and guidance disposal are synchronous.
    mounted = { subagentProvider, definition, disposeTool }
  }

  // Register listeners before checking presence so no synchronous change is missed.
  ctx.on('subagent/provider-added', (subagentProvider) => {
    if (subagentProvider.name === config.provider && mounted === undefined) mount(subagentProvider)
  })
  ctx.on('subagent/provider-removed', (name) => {
    if (name !== config.provider || mounted === undefined) return
    mounted.disposeTool()
    mounted = undefined
  })
  const present = ctx.subagents.getProvider(config.provider)
  if (present !== undefined) {
    mount(present)
  } else {
    // A backend fiber may activate later; a misspelled provider remains visible in this log.
    ctx.logger.info(`subagent provider "${config.provider}" not registered yet; the "${config.toolName ?? 'subagent'}" tool will register when it appears`)
  }
  ctx.systemPrompt.section({
    name: `tool:${toolName}`,
    order: ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT'),
    text: (context) => {
      if (mounted === undefined) return ''
      const visible = [...delegationTools]
        .filter(tool => ctx.tools.get(tool.name, context.scope) === tool)
        .map(tool => tool.name)
        .sort()
      if (visible[0] !== toolName) return ''
      const names = visible.map(name => `\`${name}\``).join(' or ')
      return `Start independent delegations with ${names} together in one assistant message and continue useful work while they run. When only waiting for their results remains, end your turn instead of sleeping or polling; the next result starts a new turn.`
    },
  })
  ctx.systemPrompt.context({
    name: `tool:${toolName}:depth`,
    order: ctx.systemPrompt.getContextOrder('SUBAGENT_DELEGATION'),
    text: (context) => {
      if (context.agent === undefined || mounted === undefined
        || ctx.tools.get(toolName, context.scope) !== mounted.definition) return ''
      const maxDepth = ctx.subagents.resolveMaxDepth(config.maxDepth)
      if (maxDepth === undefined) return ''
      const depth = delegationDepthOf(context.agent)
      if (depth < maxDepth) return ''
      return `Delegation depth for \`${toolName}\`: current ${depth}, maximum ${maxDepth}, remaining levels 0.`
        + ` Do not call \`${toolName}\` at this depth; carry out the work directly.`
    },
  })
}
