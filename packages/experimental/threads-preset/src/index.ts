/**
 * The Threads agent presets: the Project coordinator and the Thread worker.
 *
 * Mounted once on the Host plane, this plugin registers two presets with
 * `ctx.agentPresets`; the registry mounts each eagerly and once per
 * definition. Every Project Session selects the coordinator id; every Thread
 * child the `thread` provider starts is composed from the worker id. Every other
 * session, and every other child, is untouched. The rows are declared in
 * {@link coordinatorPreset} and {@link workerPreset}, and the model-facing
 * rules they carry are in the `./threads-contract` row.
 * @module @deepseek-ai/dsh-experimental-threads-preset
 */

import { Context, Service, type Volatile } from '@deepseek-ai/cordis'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import z from '@deepseek-ai/schemastery'
import { load } from 'js-yaml'
import { entryListProblem, type PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import type { AgentPresetRegistry } from '@deepseek-ai/dsh-agent-preset-registry'
import {
  COORDINATOR_REPLACED_ROW_IDS,
  PROJECT_PRESET_ID,
  PROJECT_PRESET_ROW_NAMES,
  PROJECT_THREAD_PRESET_ID,
  THREAD_CONTRACT_ROW_ID,
  THREAD_CONTROL_ROW_ID,
  THREAD_DELEGATION_ROW_ID,
  THREAD_PROVIDER,
  THREAD_STATUS_ROW_ID,
  coordinatorPreset,
  workerPreset,
  type AllowedThreadModel,
  type ThreadAgentOptions,
} from './project-preset.ts'
import type { CheckInPolicy, MergePolicy, SpawnPolicy, TierContract } from './threads-contract.ts'

export {
  COORDINATOR_REPLACED_ROW_IDS,
  PROJECT_PRESET_ID,
  PROJECT_PRESET_ROW_NAMES,
  PROJECT_THREAD_PRESET_ID,
  THREAD_CONTRACT_ROW_ID,
  THREAD_CONTROL_ROW_ID,
  THREAD_DELEGATION_ROW_ID,
  THREAD_PROVIDER,
  THREAD_STATUS_ROW_ID,
  coordinatorPreset,
  workerPreset,
}
export type { ThreadAgentOptions }
export {
  THREADS_CONTRACT_CONTEXT,
  THREADS_CONTEXT_NAME,
  THREADS_CONTEXT_ORDER,
  THREAD_WORKER_CONTRACT_CONTEXT,
  THREAD_WORKER_CONTEXT_NAME,
  coordinatorContract,
  workerContract,
} from './threads-contract.ts'

/**
 * Config: identities, display fields, and behaviour of both presets.
 *
 * Every field but `basePreset`, `workerMaxDepth`, and the four thread model
 * options has a schema default, so the class reads them as resolved values
 * rather than defaulting again at use.
 *
 * The three coordinator knobs and the four thread model options are declared
 * `volatile`: `SettingsForms.describe()` projects only volatile fields, so a
 * field that is not one is neither shown nor writable from the harness settings
 * surface, and a write to it is refused outright. They are references rather
 * than plain values, so a consumer reads one through `.get()` at the moment it
 * uses it instead of capturing the value the Loader happened to resolve at
 * mount. The presets themselves are registered once, in `[Service.init]`, so a
 * changed value is read by the next registration rather than by the rows
 * already mounted.
 */
export interface Config {
  /** Coordinator preset id recorded in `SessionHeader.agentPreset` (default `project`). */
  readonly id: string
  /** Coordinator roster display name (default `Project`). */
  readonly name: string
  /** Coordinator roster display description. */
  readonly description: string
  /** Coordinator roster sort position (default `20`). */
  readonly order: number
  /** Worker preset id; the `thread` provider's `childAgentPreset` must name it (default `project-thread`). */
  readonly workerId: string
  /** Worker roster display name (default `Project Thread (internal)`). */
  readonly workerName: string
  /** Worker roster display description. */
  readonly workerDescription: string
  /** Worker roster sort position (default `1000`, after every preset meant for a person). */
  readonly workerOrder: number
  /** Subagent provider the coordinator delegates to (default `thread`). */
  readonly provider: string
  /**
   * Id of an already registered preset whose rows both presets extend (for
   * example `standard` in the Web profile). Unset when the deployment's tools
   * are global rather than preset rows. An unknown id fails the load.
   */
  readonly basePreset?: string
  /**
   * Delegation depth cap for the `subagent` row a Thread inherits from the base
   * preset. A Thread sits one level below its Project, so helpers a Thread starts
   * need a cap of at least 2. Unset keeps the base row's cap (the Host default).
   */
  readonly workerMaxDepth?: number
  /** Coordinator contract: progress reporting cadence (default `milestones`). */
  readonly checkIn: Volatile<CheckInPolicy>
  /** Coordinator contract: approval before starting Threads (default `ask`). */
  readonly spawn: Volatile<SpawnPolicy>
  /** Coordinator contract: approval before merging a Thread (default `ask`). */
  readonly mergePolicy: Volatile<MergePolicy>
  /** Config of the `thread_status` / `thread_diff` row; the tool plugin validates every key. */
  readonly tools: Record<string, number>
  /** LLM provider for every Thread; set together with the three fields below or not at all. */
  readonly threadProvider?: Volatile<string>
  /** Model for every Thread. */
  readonly threadModel?: Volatile<string>
  /** Reasoning effort for every Thread. */
  readonly threadReasoningEffort?: Volatile<string>
  /** Output token ceiling for every Thread. */
  readonly threadMaxTokens?: Volatile<number>
  /** Exact routes the coordinator may choose for a Thread (default `[]`). */
  readonly threadModels: Volatile<readonly AllowedThreadModel[]>
  /** Whether the tier sentences join the contracts (default `none`). */
  readonly tierContract: Volatile<TierContract>
}

/**
 * The row's configuration as a deployment writes it: plain values, before the
 * Loader wraps the volatile fields of {@link Config} in references.
 *
 * Every field is optional because every field but `basePreset` and
 * `workerMaxDepth` has a schema default, so a row never has to spell it out.
 * Only the volatile fields differ from {@link Config}; the rest stay out of every
 * settings section on purpose — they are boot composition a person does not
 * tune, and a section that carried them would pin them into the profile row on
 * the first edit.
 */
export interface ThreadsPresetInput extends ThreadAgentOptionFields {
  /** Coordinator preset id recorded in `SessionHeader.agentPreset`. */
  readonly id?: string | undefined
  /** Coordinator roster display name. */
  readonly name?: string | undefined
  /** Coordinator roster display description. */
  readonly description?: string | undefined
  /** Coordinator roster sort position. */
  readonly order?: number | undefined
  /** Worker preset id the `thread` provider's `childAgentPreset` must name. */
  readonly workerId?: string | undefined
  /** Worker roster display name. */
  readonly workerName?: string | undefined
  /** Worker roster display description. */
  readonly workerDescription?: string | undefined
  /** Worker roster sort position. */
  readonly workerOrder?: number | undefined
  /** Subagent provider the coordinator delegates to. */
  readonly provider?: string | undefined
  /** Id of an already registered preset whose rows both presets extend. */
  readonly basePreset?: string | undefined
  /** Delegation depth cap for the `subagent` row a Thread inherits. */
  readonly workerMaxDepth?: number | undefined
  /** Coordinator contract: progress reporting cadence. */
  readonly checkIn?: CheckInPolicy | undefined
  /** Coordinator contract: approval before starting Threads. */
  readonly spawn?: SpawnPolicy | undefined
  /** Coordinator contract: approval before merging a Thread. */
  readonly mergePolicy?: MergePolicy | undefined
  /** Config of the `thread_status` / `thread_diff` row. */
  readonly tools?: Record<string, number> | undefined
  /** Exact routes the coordinator may choose for a Thread. */
  readonly threadModels?: readonly AllowedThreadModel[] | undefined
  /** Whether the tier sentences join the contracts. */
  readonly tierContract?: TierContract | undefined
}

/**
 * The four thread model options as plain values, which is what
 * {@link threadAgentOptions} validates. The resolved row carries them as
 * volatile references instead; {@link threadAgentOptionsOf} bridges the two.
 */
export interface ThreadAgentOptionFields {
  /** LLM provider for every Thread. */
  readonly threadProvider?: string | undefined
  /** Model for every Thread. */
  readonly threadModel?: string | undefined
  /** Reasoning effort for every Thread. */
  readonly threadReasoningEffort?: string | undefined
  /** Output token ceiling for every Thread. */
  readonly threadMaxTokens?: number | undefined
}

/** Runtime schema for the Threads preset row. */
export const Config: z<ThreadsPresetInput, Config> = z.object({
  id: z.string().default(PROJECT_PRESET_ID),
  name: z.string().default('Project'),
  description: z.string().default('Coordinate a goal as a Project: split it into Threads that work in isolated git worktrees, review them, and merge the results.'),
  order: z.number().default(20),
  workerId: z.string().default(PROJECT_THREAD_PRESET_ID),
  workerName: z.string().default('Project Thread (internal)'),
  workerDescription: z.string().default('Composition of the Threads a Project starts. Started by the Project, not meant to be selected by hand.'),
  workerOrder: z.number().default(1000),
  provider: z.string().default(THREAD_PROVIDER),
  basePreset: z.string(),
  workerMaxDepth: z.natural().max(Number.MAX_SAFE_INTEGER),
  checkIn: z.union(['milestones', 'each-thread', 'quiet'] as const).default('milestones').volatile(),
  spawn: z.union(['ask', 'auto'] as const).default('ask').volatile(),
  mergePolicy: z.union(['ask', 'auto'] as const).default('ask').volatile(),
  tools: z.dict(z.number()).default({ defaultLimit: 20, maxLimit: 100 }),
  threadProvider: z.string().volatile(),
  threadModel: z.string().volatile(),
  threadReasoningEffort: z.string().volatile(),
  threadMaxTokens: z.number().step(1).min(1).volatile(),
  threadModels: z.array(z.object({
    provider: z.string(),
    model: z.string(),
  })).default([]).volatile(),
  tierContract: z.union(['none', 'tiers'] as const).default('none').volatile(),
}) as z<ThreadsPresetInput, Config>

/**
 * Read the thread agent options as all-or-nothing.
 * @param config - the four thread model options, as plain values.
 * @returns the complete options, or undefined when none of the four is set.
 * @throws when only some of the four fields are set.
 */
export function threadAgentOptions(
  config: ThreadAgentOptionFields,
): ThreadAgentOptions | undefined {
  const { threadProvider, threadModel, threadReasoningEffort, threadMaxTokens } = config
  if (threadProvider === undefined && threadModel === undefined
    && threadReasoningEffort === undefined && threadMaxTokens === undefined) return undefined
  if (threadProvider === undefined || threadModel === undefined
    || threadReasoningEffort === undefined || threadMaxTokens === undefined) {
    throw new Error('threads-preset: threadProvider, threadModel, threadReasoningEffort and threadMaxTokens must be set together')
  }
  return { provider: threadProvider, model: threadModel, reasoningEffort: threadReasoningEffort, maxTokens: threadMaxTokens }
}

/**
 * Read the thread agent options out of a resolved preset row.
 *
 * The four fields are volatile references, so they are read at the moment the
 * options are needed rather than captured; the all-or-nothing rule stays
 * {@link threadAgentOptions}'s.
 * @param config - the resolved preset row.
 * @returns the complete options, or undefined when none of the four is set.
 * @throws when only some of the four fields is set.
 */
export function threadAgentOptionsOf(
  config: Pick<Config, 'threadProvider' | 'threadModel' | 'threadReasoningEffort' | 'threadMaxTokens'>,
): ThreadAgentOptions | undefined {
  return threadAgentOptions({
    threadProvider: config.threadProvider?.get(),
    threadModel: config.threadModel?.get(),
    threadReasoningEffort: config.threadReasoningEffort?.get(),
    threadMaxTokens: config.threadMaxTokens?.get(),
  })
}

/**
 * Read the rows of an already registered preset.
 * @param presets - the preset roster.
 * @param id - the base preset id.
 * @returns the declared rows, with `!!js` expressions preserved.
 * @throws when the preset is unknown or its document is not an entry list.
 */
export async function readBaseRows(presets: AgentPresetRegistry, id: string): Promise<PresetDefinition['plugins']> {
  const document = await presets.readDocument(id)
  const rows = load(document.content, { schema: entryListSchema })
  const problem = entryListProblem(rows)
  if (problem !== undefined) throw new Error(`threads-preset: base preset "${id}" is unreadable: ${problem}`)
  return rows as PresetDefinition['plugins']
}

/**
 * Register the coordinator and worker presets and own their disposers.
 *
 * The registry retains a mounted revision for as long as a session uses it, so
 * yielding each `register()` disposer makes the declarations, and the trees they
 * mounted, go away with this row.
 */
export default class ThreadsPreset {
  static inject = ['agentPresets']
  static Config: z<ThreadsPresetInput, Config> = Config

  constructor(private readonly ctx: Context, private readonly config: Config) {}

  async* [Service.init](): AsyncGenerator<() => Promise<void>> {
    const config = this.config
    const base = config.basePreset === undefined ? [] : await readBaseRows(this.ctx.agentPresets, config.basePreset)
    const agentOptions = threadAgentOptionsOf(config)
    const threadModels = config.threadModels.get()
    const tierContract = config.tierContract.get()
    // The tier contract names two routes the coordinator is told to pick between.
    // If the delegation row cannot offer them, the sentences would describe a
    // choice the tool rejects at call time, so the row refuses to mount instead.
    if (tierContract === 'tiers') {
      const models = new Set(threadModels.map(route => route.model))
      if (!models.has('flash') || !models.has('pro')) {
        throw new Error('threads-preset: tierContract "tiers" needs threadModels with models "flash" and "pro"')
      }
    }
    yield await this.ctx.agentPresets.register(coordinatorPreset({
      display: { id: config.id, name: config.name, description: config.description, order: config.order },
      provider: config.provider,
      base,
      contract: { checkIn: config.checkIn.get(), spawn: config.spawn.get(), mergePolicy: config.mergePolicy.get() },
      tools: config.tools,
      ...agentOptions === undefined ? {} : { agentOptions },
      threadModels,
      tierContract,
    }))
    yield await this.ctx.agentPresets.register(workerPreset({
      display: {
        id: config.workerId,
        name: config.workerName,
        description: config.workerDescription,
        order: config.workerOrder,
      },
      base,
      ...config.workerMaxDepth === undefined ? {} : { maxDepth: config.workerMaxDepth },
      tierContract,
    }))
  }
}
