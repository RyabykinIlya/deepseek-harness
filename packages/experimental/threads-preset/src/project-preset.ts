/**
 * The two compositions of the Threads feature: the Project coordinator and the
 * Thread worker.
 *
 * A Project is not a new session kind. It is an ordinary Session whose agent
 * was composed from the coordinator list, and that is the whole of its identity:
 * the registry stamps the preset id into `SessionHeader.agentPreset`, so a
 * restart or a cold read resolves the same composition without a new persisted
 * field. A Thread is the child the `thread` provider starts; the provider asks
 * the continuation manager to compose it from the worker list, so a Thread never
 * receives the coordinator contract, `thread_status`, `thread_diff`, or the
 * `thread` delegation tool.
 *
 * Two declarations are needed because the registry mounts one declaration once
 * into a registry-owned scope: a row cannot present different tools to the
 * Project and to its children.
 *
 * The Host plane is not part of either list. The worktree service and the
 * `thread` provider exist once per deployment, so mounting them here would
 * create a second worktree root and a duplicate provider name for every
 * Project. Every row here contributes a tool or a prompt, never a service.
 * @module @deepseek-ai/dsh-experimental-threads-preset/project-preset
 */

import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import type { CheckInPolicy, MergePolicy, SpawnPolicy } from './threads-contract.ts'

/** The coordinator preset id a client matches a Project session on. */
export const PROJECT_PRESET_ID = 'project'

/** The worker preset id the `thread` provider composes Thread children from. */
export const PROJECT_THREAD_PRESET_ID = 'project-thread'

/**
 * The `thread` subagent provider the coordinator delegates to.
 *
 * It is the name `@deepseek-ai/dsh-subagent-thread-worktree` registers by
 * default on the Host plane.
 */
export const THREAD_PROVIDER = 'thread'

/** Row id of the contract runtime context inside either preset. */
export const THREAD_CONTRACT_ROW_ID = 'thread-contract'

/** Row id of the worktree-isolated delegation tool inside the coordinator. */
export const THREAD_DELEGATION_ROW_ID = 'tool-subagent'

/** Row id of the Thread status and diff tools inside the coordinator. */
export const THREAD_STATUS_ROW_ID = 'tool-threads'

/** Row id of the `memory_read` and `memory_write` tools inside both presets. */
export const PROJECT_MEMORY_TOOLS_ROW_ID = 'project-memory-tools'

/** Row id of the steering tools inside the coordinator. */
export const THREAD_CONTROL_ROW_ID = 'tool-subagent-control'

/**
 * Base-preset rows the coordinator replaces or drops.
 *
 * `tool-subagent` is replaced by the `thread` row. A fork child runs in the
 * Project checkout with no worktree and records no `thread/*` events, and
 * `thread_status` is the bounded replacement for `list_agents`.
 */
export const COORDINATOR_REPLACED_ROW_IDS: readonly string[] = [
  THREAD_DELEGATION_ROW_ID,
  'tool-subagent-fork',
  'tool-subagent-list-agents',
]

/**
 * The module specifier each row carries in a published profile.
 *
 * The Loader resolves these through Node's ESM resolver against the installed
 * package graph. {@link row} may hand the Loader a different string for the
 * same row when running from a source tree.
 */
export const PROJECT_PRESET_ROW_NAMES = {
  [THREAD_CONTRACT_ROW_ID]: '@deepseek-ai/dsh-experimental-threads-preset/threads-contract',
  [THREAD_DELEGATION_ROW_ID]: '@deepseek-ai/dsh-tool-subagent',
  [THREAD_STATUS_ROW_ID]: '@deepseek-ai/dsh-experimental-threads-tool',
  [THREAD_CONTROL_ROW_ID]: '@deepseek-ai/dsh-tool-subagent-control',
  [PROJECT_MEMORY_TOOLS_ROW_ID]: '@deepseek-ai/dsh-experimental-project-memory/tools',
} as const

/**
 * Resolve one declared row to a module the Loader can import right now.
 *
 * A repository checkout is a different plane from an installed profile: the
 * Loader imports rows through Node's ESM resolver, which resolves a bare
 * specifier to a package's `main` and never to its `src`, and an experimental
 * package in a working tree has no `lib/`. Running from `src` is the only way
 * this function takes the path branch.
 * @param name - the published package specifier a profile resolves.
 * @param sourcePath - the row's module relative to this file.
 * @returns the specifier to hand the Loader.
 */
function row(name: string, sourcePath: string): string {
  /* v8 ignore next -- the built branch needs a published tree, which only the release build has. */
  return import.meta.url.endsWith('.ts') ? new URL(sourcePath, import.meta.url).href : name
}

/**
 * Display fields of one preset declaration.
 *
 * Every field is required: the declaring row's own `Config` carries a default
 * for each, so an absent field never reaches this builder, and optionality here
 * would only be a second, unreachable defaulting step.
 */
export interface PresetDisplay {
  /** Preset identity recorded in `SessionHeader.agentPreset`. */
  readonly id: string
  /** Roster display name. */
  readonly name: string
  /** Roster display description. */
  readonly description: string
  /** Roster sort position. */
  readonly order: number
}

/** Agent options applied to every Thread; all four fields are required together. */
export interface ThreadAgentOptions {
  /** LLM provider id. */
  readonly provider: string
  /** Model id. */
  readonly model: string
  /** Reasoning effort id. */
  readonly reasoningEffort: string
  /** Output token ceiling. */
  readonly maxTokens: number
}

/** Everything the coordinator list depends on. */
export interface CoordinatorOptions {
  /** Display fields of the coordinator declaration. */
  readonly display: PresetDisplay
  /** Subagent provider name the delegation row targets. */
  readonly provider: string
  /** Rows of the preset the coordinator extends; empty when the deployment's tools are global. */
  readonly base: PresetDefinition['plugins']
  /** Contract sentence variants. */
  readonly contract: {
    readonly checkIn: CheckInPolicy
    readonly spawn: SpawnPolicy
    readonly mergePolicy: MergePolicy
  }
  /** Config of the Thread tools row, validated by that plugin's own schema. */
  readonly tools: Readonly<Record<string, number>>
  /** Model options for every Thread, when configured. */
  readonly agentOptions?: ThreadAgentOptions
}

/** Everything the worker list depends on. */
export interface WorkerOptions {
  /** Display fields of the worker declaration. */
  readonly display: PresetDisplay
  /** Rows of the preset the worker extends; empty when the deployment's tools are global. */
  readonly base: PresetDefinition['plugins']
  /**
   * Delegation depth cap for the worker's own `subagent` row. A Thread is one
   * level below the Project, so the Host default cap of 1 rejects the Thread's
   * helpers; unset leaves the base row's cap, and with it the Host setting.
   */
  readonly maxDepth?: number
}

/** One row of a preset's plugin list. */
type PresetRow = PresetDefinition['plugins'][number]

/**
 * Whether a row is a `cordis:group` whose `config` holds nested rows.
 * @param entry - the row to inspect.
 * @returns the nested rows, or undefined for an ordinary row.
 */
function groupRows(entry: PresetRow): PresetDefinition['plugins'] | undefined {
  return entry.group === true && Array.isArray(entry.config) ? entry.config as PresetDefinition['plugins'] : undefined
}

/**
 * Rewrite a row list at every group depth.
 *
 * Shipped presets nest their delegation rows inside a `cordis:group` (the
 * `delegation` group of `standard` isolates `workflowEngine`), so a top-level
 * id match would miss them.
 * @param rows - the rows to rewrite.
 * @param visit - returns the replacement rows for one non-group row: `[]` drops it, `[entry]` keeps it.
 * @returns the rewritten rows; groups keep their own fields around the rewritten children.
 */
function rewriteRows(
  rows: PresetDefinition['plugins'],
  visit: (entry: PresetRow) => readonly PresetRow[],
): PresetDefinition['plugins'] {
  return rows.flatMap((entry) => {
    const children = groupRows(entry)
    return children === undefined ? visit(entry) : [{ ...entry, config: rewriteRows(children, visit) }]
  })
}

/**
 * Whether a row id occurs at any group depth.
 * @param rows - the rows to search.
 * @param id - the row id.
 * @returns true when some row, nested or not, carries `id`.
 */
function containsRow(rows: PresetDefinition['plugins'], id: string): boolean {
  return rows.some(entry => entry.id === id || containsRow(groupRows(entry) ?? [], id))
}

/**
 * The declaration fields one preset identity carries.
 * @param display - the declaration's identity and display fields.
 * @returns the declaration fields without the row list.
 */
function declaration(display: PresetDisplay): Omit<PresetDefinition, 'plugins'> {
  return { id: display.id, name: display.name, description: display.description, order: display.order }
}

/**
 * Build the coordinator declaration.
 *
 * Rows: the base rows at every group depth, with the base `subagent` row
 * replaced in place by `subagent` on the `thread` provider in continuable mode
 * (appended when the base has none) and the other delegation rows dropped; then
 * the coordinator contract, the Thread status and diff tools, the memory tools,
 * and the steering tools unless the base already mounts them.
 * @param options - the resolved coordinator configuration.
 * @returns the declaration the registry registers and eagerly mounts.
 */
export function coordinatorPreset(options: CoordinatorOptions): PresetDefinition {
  const delegation: PresetRow = {
    id: THREAD_DELEGATION_ROW_ID,
    name: row(PROJECT_PRESET_ROW_NAMES[THREAD_DELEGATION_ROW_ID], '../../../subagent/tool-subagent/src/index.ts'),
    config: {
      provider: options.provider,
      toolName: 'subagent',
      backgroundMode: 'continuable',
      ...options.agentOptions === undefined ? {} : { agentOptions: options.agentOptions },
    },
  }
  // The base `subagent` row is replaced where it stands, so the Thread
  // delegation keeps the base group's isolation; the other delegation rows go.
  const kept = rewriteRows(options.base, (entry) => {
    if (entry.id === THREAD_DELEGATION_ROW_ID) return [delegation]
    return COORDINATOR_REPLACED_ROW_IDS.includes(entry.id ?? '') ? [] : [entry]
  })
  const hasDelegation = containsRow(kept, THREAD_DELEGATION_ROW_ID)
  const hasControl = containsRow(kept, THREAD_CONTROL_ROW_ID)
  return {
    ...declaration(options.display),
    plugins: [
      ...kept,
      {
        id: THREAD_CONTRACT_ROW_ID,
        name: row(PROJECT_PRESET_ROW_NAMES[THREAD_CONTRACT_ROW_ID], './threads-contract.ts'),
        config: { role: 'coordinator', ...options.contract },
      },
      ...hasDelegation ? [] : [delegation],
      {
        id: THREAD_STATUS_ROW_ID,
        name: row(PROJECT_PRESET_ROW_NAMES[THREAD_STATUS_ROW_ID], '../../tool-threads/src/index.ts'),
        config: { ...options.tools },
      },
      {
        id: PROJECT_MEMORY_TOOLS_ROW_ID,
        name: row(PROJECT_PRESET_ROW_NAMES[PROJECT_MEMORY_TOOLS_ROW_ID], '../../project-memory/src/tools.ts'),
      },
      ...hasControl
        ? []
        : [{
          id: THREAD_CONTROL_ROW_ID,
          name: row(PROJECT_PRESET_ROW_NAMES[THREAD_CONTROL_ROW_ID], '../../../subagent/tool-subagent-control/src/index.ts'),
        }],
    ],
  }
}

/**
 * Build the worker declaration.
 *
 * Rows: the base rows (the `subagent` row at any group depth optionally with a
 * depth cap), plus the worker contract and the memory tools. The base `subagent` therefore stays bound to the
 * shipped provider, and no Thread tool or `thread` delegation exists in a Thread.
 * @param options - the resolved worker configuration.
 * @returns the declaration the registry registers and eagerly mounts.
 */
export function workerPreset(options: WorkerOptions): PresetDefinition {
  return {
    ...declaration(options.display),
    plugins: [
      ...rewriteRows(options.base, entry => [entry.id === THREAD_DELEGATION_ROW_ID && options.maxDepth !== undefined
        ? { ...entry, config: { ...entry.config as Record<string, unknown>, maxDepth: options.maxDepth } }
        : entry]),
      {
        id: THREAD_CONTRACT_ROW_ID,
        name: row(PROJECT_PRESET_ROW_NAMES[THREAD_CONTRACT_ROW_ID], './threads-contract.ts'),
        config: { role: 'worker' },
      },
      {
        id: PROJECT_MEMORY_TOOLS_ROW_ID,
        name: row(PROJECT_PRESET_ROW_NAMES[PROJECT_MEMORY_TOOLS_ROW_ID], '../../project-memory/src/tools.ts'),
      },
    ],
  }
}
