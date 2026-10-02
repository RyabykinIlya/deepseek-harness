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

import { Context, Service } from '@deepseek-ai/cordis'
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
  type ThreadAgentOptions,
} from './project-preset.ts'
import type { CheckInPolicy, MergePolicy, SpawnPolicy } from './threads-contract.ts'

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
  readonly checkIn: CheckInPolicy
  /** Coordinator contract: approval before starting Threads (default `ask`). */
  readonly spawn: SpawnPolicy
  /** Coordinator contract: approval before merging a Thread (default `ask`). */
  readonly mergePolicy: MergePolicy
  /** Config of the `thread_status` / `thread_diff` row; the tool plugin validates every key. */
  readonly tools: Record<string, number>
  /** LLM provider for every Thread; set together with the three fields below or not at all. */
  readonly threadProvider?: string
  /** Model for every Thread. */
  readonly threadModel?: string
  /** Reasoning effort for every Thread. */
  readonly threadReasoningEffort?: string
  /** Output token ceiling for every Thread. */
  readonly threadMaxTokens?: number
}

/** Runtime schema for the Threads preset row. */
export const Config: z<Config> = z.object({
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
  checkIn: z.union(['milestones', 'each-thread', 'quiet'] as const).default('milestones'),
  spawn: z.union(['ask', 'auto'] as const).default('ask'),
  mergePolicy: z.union(['ask', 'auto'] as const).default('ask'),
  tools: z.dict(z.number()).default({ defaultLimit: 20, maxLimit: 100 }),
  threadProvider: z.string(),
  threadModel: z.string(),
  threadReasoningEffort: z.string(),
  threadMaxTokens: z.number().step(1).min(1),
})

/**
 * Read the thread agent options as all-or-nothing.
 * @param config - the preset row configuration.
 * @returns the complete options, or undefined when none of the four fields is set.
 * @throws when only some of the four fields are set.
 */
export function threadAgentOptions(
  config: Pick<Config, 'threadProvider' | 'threadModel' | 'threadReasoningEffort' | 'threadMaxTokens'>,
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
  static Config: z<Config> = Config

  constructor(private readonly ctx: Context, private readonly config: Config) {}

  async* [Service.init](): AsyncGenerator<() => Promise<void>> {
    const config = this.config
    const base = config.basePreset === undefined ? [] : await readBaseRows(this.ctx.agentPresets, config.basePreset)
    const agentOptions = threadAgentOptions(config)
    yield await this.ctx.agentPresets.register(coordinatorPreset({
      display: { id: config.id, name: config.name, description: config.description, order: config.order },
      provider: config.provider,
      base,
      contract: { checkIn: config.checkIn, spawn: config.spawn, mergePolicy: config.mergePolicy },
      tools: config.tools,
      ...agentOptions === undefined ? {} : { agentOptions },
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
    }))
  }
}
