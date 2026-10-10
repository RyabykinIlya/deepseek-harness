/**
 * The seam's consumer-facing contracts: request, result, and capability types
 * for {@link SubagentProvider}, plus the `subagent/start` and `subagent/end`
 * payloads that plugins and hosts observe. Internal control interfaces belong
 * with their implementation — the lifecycle observer in `./lifecycle.ts`, the
 * manager host in `./manager.ts` — so this module stays the published
 * surface rather than a bag of everything type-shaped.
 *
 * @module @deepseek-ai/dsh-subagent/types
 */

import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ContentBlock, MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { ObjectJsonSchema, ToolRestriction } from '@deepseek-ai/dsh-tools'

/** Identifies one accepted subagent run across its lifecycle event pair. */
export type SubagentRunId = Branded<'SubagentRunId'>

/**
 * Brand a string as a {@link SubagentRunId}.
 * @param id - the raw run id.
 * @returns the same string, branded.
 */
export function SubagentRunId(id: string): SubagentRunId {
  return id as SubagentRunId
}

/** One managed child execution and its result delivery policy. */
export interface SubagentActivationSpec {
  /** Registered backend to use. */
  readonly provider: string
  /** Short task label retained in cataloged child membership. */
  readonly label: string
  /** Optional reserved identity for a local child; external backends allocate their own ids. */
  readonly childId?: SessionId
  /** Task, parent, and backend-supported execution options. */
  readonly request: Omit<SubagentStartRequest, 'label' | 'signal'>
  /** Cancellation before publication; callers own later cancellation through dispose. */
  readonly signal: AbortSignal
  /** Parent delivery notifies the model; caller delivery only returns the result. Local children always enter the parent catalog. */
  readonly delivery: 'parent' | 'caller'
}

/** A managed execution; disposal addresses this exact activation, never a later resume. */
export interface SubagentActivation {
  /** Stable identity of the child. */
  readonly childId: SessionId
  /** Accepted inbox message, when the backend has a local inbox. */
  readonly messageId?: MessageId
  /**
   * The handles {@link ContinuableCreateSpec.handles} reported for this child,
   * copied unchanged; absent when the provider reported none. A provider that
   * isolates the child owns these values, so a caller quotes them instead of
   * reconstructing them from the child id.
   */
  readonly handles?: Readonly<Record<string, string>>
  /**
   * Execution result after teardown settles and notifications are sent; capture failures reject.
   * Teardown failures are reported by dispose() without replacing a captured result.
   */
  readonly result: Promise<SubagentResult>
  /** Stop and release this activation and its owned descendants; rejects on teardown failure. */
  dispose(): Promise<void>
}

/**
 * Authority under which one interrupt request is admitted. `user` carries the
 * durable direct-parent address a human client presented; `ancestor` carries
 * the exact live Agent object whose recorded lineage must contain the caller.
 */
export type SubagentInterruptAuthority =
  | { readonly kind: 'user'; readonly parentSessionId: SessionId }
  | { readonly kind: 'ancestor'; readonly agent: Agent }

/** Options for one model-authored message between adjacent Agents. */
export interface SubagentSendMessageOptions {
  /** Caller cancellation, owning the operation only until inbox acceptance. */
  readonly signal: AbortSignal
}

/**
 * Observe-only identifying detail for a published subagent run, carried by
 * `subagent/start`. Local and external activations share this payload.
 */
export interface SubagentRunInfo {
  /** Unique identity shared with the paired terminal event. */
  readonly runId: SubagentRunId
  /**
   * Provider name recorded when the child was first created, retained even
   * after that provider is unregistered.
   */
  readonly provider: string
  /** The child agent's id. */
  readonly id: SessionId
  /** Whether this activation owns a local Agent, fixed at publication. */
  readonly local: boolean
}

/**
 * Observe-only outcome detail for a settled subagent run, carried by
 * `subagent/end` and paired with one {@link SubagentRunInfo} by `runId`.
 */
export interface SubagentRunEndInfo {
  /** Unique identity shared with the paired start event. */
  readonly runId: SubagentRunId
  /** The same provider name carried by the paired start event. */
  readonly provider: string
  /** The child agent's id. */
  readonly id: SessionId
  /** Whether this activation owns a local Agent, fixed at publication. */
  readonly local: boolean
  /** The terminal stop reason. */
  readonly stopReason: SubagentResult['stopReason']
  /**
   * The child's final assistant output, selected by the same rule as
   * {@link SubagentResult.output}; absent on infrastructure rejection or when
   * the child produced none.
   */
  readonly lastAssistantMessage?: readonly ContentBlock[]
}

/**
 * Start-time options supported by a registered backend. The manager checks
 * every requested option before preparing a local child or starting an external
 * execution. depthLimit controls maxDepth; the remaining flag names match
 * SubagentStartRequest fields.
 */
export interface SubagentCapabilities {
  readonly agentOptions: boolean
  readonly outputSchema: boolean
  readonly depthLimit: boolean
  readonly toolFilter: boolean
  readonly persona: boolean
  readonly repository: boolean
}

/**
 * Task and optional capabilities supplied to a backend. startActivation carries
 * these fields in request while owning its label, cancellation, and delivery
 * policy separately.
 */
export interface SubagentStartRequest {
  /** Initial child directory; relative paths resolve against the parent's current directory. Omitted inherits that directory at start. */
  readonly cwd?: string
  /** Optional short display label persisted with a session-backed child. */
  readonly label?: string
  /** Content delivered as the child's user message. */
  readonly prompt: ContentBlock[]
  /**
   * The spawning agent. Its effective directory supplies the default cwd;
   * in-process children retain its origin, lineage, and delegation depth.
   */
  readonly parent: Agent
  /**
   * Cancellation signal from the spawning context (the tool's `exec.signal`).
   * This is the canonical cancellation channel both before and after startup:
   * a provider rejects `start()` after cleaning partial resources when it
   * fires before the run is published, and cancels the published run's
   * remaining turn work when it fires afterward.
   */
  readonly signal: AbortSignal
  /**
   * Optional host-Agent provider, model, reasoning-effort, and output-token
   * overrides. Requires {@link SubagentCapabilities.agentOptions}; in-process
   * providers merge them over the parent Agent's options when they create the
   * child, while the DSH SDK provider merges them over its instance defaults
   * before initializing the separate child runtime.
   */
  readonly agentOptions?: AgentOptions
  /**
   * Object-rooted JSON Schema within `assertObjectJsonSchema`'s enforced subset. Start rejects
   * unsupported schemas or providers without the capability. Data must be plain host-realm JSON;
   * a successful child returns the matching value as {@link SubagentResult.structured}.
   */
  readonly outputSchema?: ObjectJsonSchema
  /**
   * Optional absolute delegation-depth cap for the child being started: its
   * computed depth must be less than or equal to this non-negative safe
   * integer. Requires {@link SubagentCapabilities.depthLimit}; rejected at
   * start otherwise.
   */
  readonly maxDepth?: number
  /**
   * Optional child tool scoping. Requires {@link SubagentCapabilities.toolFilter};
   * rejected at start otherwise. In-process backends apply it as a scoped
   * `tools.restrict()` in the child's creation window: the named tools vanish
   * from the child's prompt AND refuse to execute (one visibility), with loud
   * unknown-name validation.
   */
  readonly toolFilter?: ToolRestriction
  /**
   * Optional per-child persona. Requires {@link SubagentCapabilities.persona};
   * rejected at start otherwise. In-process backends register it as a scoped
   * `deployment:persona-prefix` section on the child, SHADOWING the deployment's
   * persona for this child alone — same template semantics as the deployment
   * persona (strict `{{…}}` interpolation against the registered variables).
   */
  readonly persona?: string
  /**
   * Optional repository the child's isolated working tree is created from,
   * named as a path inside the parent's working directory — usually a
   * subdirectory name, and any directory inside the repository works because
   * the provider resolves it to that repository's top level. Requires
   * {@link SubagentCapabilities.repository}; rejected at start otherwise.
   *
   * It exists for a parent whose working directory is NOT a repository itself
   * but holds several (a workspace directory): the parent names which one the
   * child works in. Omission keeps the provider's existing resolution, which
   * for a worktree provider is the parent's own working directory.
   */
  readonly repository?: string
}

/** Provider-facing request with an absolute directory selected before startup. */
export interface ResolvedSubagentStartRequest extends SubagentStartRequest {
  /** Absolute child directory captured from the parent or explicit request. */
  readonly cwd: string
}

/**
 * What the continuation manager asks a provider for while materializing one
 * continuable child's FIRST activation. The manager has already reserved the
 * durable child identity and owns every later operation, so this request
 * carries only what distinguishes a fresh child from one seeded with parent
 * history.
 */
export interface ContinuableCreateRequest {
  /** Absolute initial directory captured before provider preparation. */
  readonly cwd: string
  /** The reserved durable child session id, for provider diagnostics. */
  readonly sessionId: SessionId
  /** The delegating parent agent whose history a seeding provider reads. */
  readonly parent: Agent
  /**
   * Caller cancellation, which owns preparation only until the manager accepts
   * the initial prompt into the child's inbox.
   */
  readonly signal: AbortSignal
  /**
   * Repository named on the delegation, as a path inside the parent's working
   * directory. A provider that isolates the child in a git worktree resolves it
   * here, because preparation is the only moment it decides which repository
   * the child works in; the manager carries the value without interpreting it.
   * Absent — the provider keeps its existing resolution.
   */
  readonly repository?: string
}

/**
 * A provider's detached contribution to one continuable child's creation. This
 * is DATA, never a capability: it carries no Agent, `AgentHandle`, prompt
 * delivery, result, disposal, or resume operation, because the continuation
 * manager owns the child's whole lifecycle after preparation.
 */
export interface ContinuableCreateSpec {
  /**
   * Completed-turn prefix of the parent's log to seed the child session with,
   * or absent for a fresh child. Same durable contract as
   * `CreateAgentOptions.seed`: contiguous from seq 0, lossless JSON, balanced.
   */
  readonly seed?: readonly SessionEvent[]
  /**
   * Absolute working directory for the child, when the provider isolates it from
   * the parent (e.g. a dedicated git worktree). Absent — the child inherits the
   * parent's cwd, the default every existing provider relies on. It is DATA, not
   * a capability: the continuation manager still owns creation, composition,
   * delivery, resume, and disposal. Because the value becomes durable session
   * metadata, a cold resume restores the isolated root from the persisted header
   * without the provider re-creating anything. The manager requires an absolute
   * path to an existing, enterable directory and rejects anything else with a
   * {@link SubagentError} (`INVALID_PROVIDER_CWD`) before the child exists.
   */
  readonly cwd?: string
  /**
   * Model-visible facts about the prepared child the delegating parent must
   * quote verbatim rather than derive from the child id — the exact identifiers
   * of whatever the provider established for it. Keys are the provider's own
   * vocabulary and values are exact; a provider reporting none omits the field
   * and its start result carries only the child id. The manager copies them
   * into {@link SubagentActivation} unchanged, and the delegation tool renders
   * each entry as its own line.
   */
  readonly handles?: Readonly<Record<string, string>>
  /**
   * Id of the agent preset the child is composed from, when the provider wants a
   * composition other than the parent's. Absent — the child joins the parent's
   * composed preset. The manager mounts this preset on the child's scope and
   * records the id in the child's session header, so cold resume composes the
   * child from the same preset. An id the preset registry does not define, or a
   * composition without a preset registry, fails the start with a
   * {@link SubagentError} (`UNKNOWN_AGENT_PRESET`) before the child exists.
   */
  readonly agentPreset?: string
}

/**
 * Why a subagent run ended. Merge-extensible (a backend may add variants);
 * consumers branch on the known cases and fall through `default`. The known
 * cases mirror the harness turn-end vocabulary so the tool layer can map a
 * non-`completed` result to an `isError` tool result.
 */
export interface SubagentStopReasonMap {
  /** The child finished its turn normally. */
  completed: 'completed'
  /** Cancelled through the request signal or disposal. */
  aborted: 'aborted'
  /** Model or transport failure. */
  error: 'error'
  /** The child hit its token ceiling before finishing. */
  'max-tokens': 'max-tokens'
  /** The child declined the task. */
  refusal: 'refusal'
}

/** The union over {@link SubagentStopReasonMap} — widens automatically as backends merge in variants. */
export type SubagentStopReason = SubagentStopReasonMap[keyof SubagentStopReasonMap]

/**
 * The terminal outcome of a subagent run, resolved by {@link SubagentRun.result}.
 */
export interface SubagentResult {
  /**
   * The child's final assistant output is the content of its last non-empty
   * assistant message. Empty-content messages, including usage-only messages,
   * are skipped. Without a non-empty message, the output is its accumulated
   * assistant text stream, or `[]` when the child produced neither.
   */
  readonly output: readonly ContentBlock[]
  /**
   * The structured result after a requested `outputSchema` was successfully
   * satisfied. Requesting a schema does not guarantee presence: a provider can
   * end with `stopReason: 'error'` when the child fails or finishes without a
   * valid capture. The structured value is validated against the requested
   * output schema by the provider; `unknown` here because the seam is
   * schema-agnostic.
   */
  readonly structured?: unknown
  /**
   * Provider-authored, non-assistant failure detail for a non-`completed`
   * result. Providers keep this text free of tool inputs, file contents,
   * environment values, credentials, and raw protocol payloads, and limit it
   * to 4096 UTF-8 bytes. Consumers present it separately from {@link output}.
   */
  readonly diagnostic?: string
  /** Why the run ended. A non-`completed` reason means `output` may be partial. */
  readonly stopReason: SubagentStopReason
}

/**
 * Backend execution handle owned directly by the activation registry.
 * A result may become available before resource release; the manager always
 * disposes the handle and awaits cleanup. Backend startup failures clean up
 * partial resources before rejecting, while accepted execution failures settle
 * through result.
 */
export interface SubagentRun {
  /** Provider-minted id, unique across all parents, providers, and local Sessions in this runtime. */
  readonly id: SessionId
  /**
   * Resolves with the child's terminal {@link SubagentResult} when the run
   * settles. Does NOT reject on a child-level failure — a model/transport
   * failure resolves with `stopReason: 'error'` so the consumer maps it to an
   * `isError` tool result. Rejects on an infrastructure fault the seam cannot
   * represent as a stop reason.
   */
  readonly result: Promise<SubagentResult>
  /**
   * Cancel remaining work, reach child quiescence, and release resources.
   * Idempotent.
   */
  dispose(): Promise<void>
}

/**
 * One registered transport for running child agents. Providers are trusted
 * same-process implementations; callers treat descriptors and returned values
 * as borrowed immutable data. The service may call one provider concurrently
 * for distinct children. Providers isolate operation-local mutable state; a
 * shared capacity controller may delay an operation but must not couple its
 * settlement or cleanup to a sibling.
 */
export interface SubagentProvider {
  /** Unique registry name (e.g. `spawn`, `fork`, `acp`). */
  readonly name: string
  /** The start-time features this provider supports (see {@link SubagentCapabilities}). */
  readonly capabilities: SubagentCapabilities
  /**
   * Whether the child sees the parent's completed-turn prefix. This is descriptive, not a
   * service-validated start capability: the model-facing tool derives truthful wording from it.
   * It says nothing about tool registration, injected services, or authority inheritance.
   */
  readonly inheritsParentContext: boolean
  /**
   * Optional static provider-owned provider/model route for child Agent
   * options. Consumers merge tool/model overrides over these values before
   * preflight; providers whose route derives from the parent omit it. The value
   * is detached immutable data and requires `agentOptions` support.
   */
  readonly agentRouteDefaults?: Readonly<{ provider: string; model: string }>
  /**
   * Establish one external execution and return its owned handle.
   * The service has already validated that every requested start-time
   * capability is supported. Before fulfillment, the provider owns setup and
   * cleans any unpublished partial resources before rejecting. Ownership transfers on
   * fulfillment; subsequent turn or infrastructure failure settles through
   * the returned run. Distinct starts may overlap; cancellation, failure,
   * result settlement, and disposal remain independent for each run.
   */
  start?(request: ResolvedSubagentStartRequest): Promise<SubagentRun>
  /**
   * OPTIONAL (continuable-creation capability): contribute the detached
   * creation inputs that distinguish this provider's continuable children —
   * only whether the child session is seeded with parent history. Method
   * presence selects local activation execution. Providers without it execute
   * through start and do not accept subsequent messages.
   *
   * This is the provider's ONLY participation in a continuable child. The
   * continuation manager owns identity reservation, composition, Agent
   * creation, prompt delivery, cold resume, ownership, and disposal, so a
   * provider never sees the child's Agent, handle, turns, or teardown.
   * Distinct preparations may overlap; each follows its own signal and returns
   * data belonging only to `request.sessionId`.
   */
  prepareContinuable?(request: ContinuableCreateRequest): Promise<ContinuableCreateSpec>
  /**
   * Whether a continuable child of this provider runs somewhere the ONE-SHOT
   * route would not put it — a git worktree, a container, any working
   * directory the provider establishes only while preparing a continuable
   * creation. `true` promises that {@link SubagentProvider.start} would run
   * the child unisolated, so a caller that must not lose the isolation refuses
   * the one-shot route instead of taking it.
   *
   * Descriptive, like {@link SubagentProvider.inheritsParentContext}: the
   * provider states the fact and the model-facing tool derives its own wording
   * and refusal from it. A provider that isolates nothing omits this, and its
   * children then run identically on either route.
   */
  readonly isolatesContinuableCwd?: boolean
}
