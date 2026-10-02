/**
 * The Threads contracts, as rows a preset mounts.
 *
 * A Project (coordinator) and a Thread (worker) are two roles with different
 * obligations, so each has its own runtime-context row. A model that is not told
 * its role delegates wrongly: it polls instead of waiting for a report, assumes
 * a finished Thread landed its edits in the checkout, or, as a Thread, leaves
 * its work uncommitted and its parent without a summary. The rules are stated as
 * runtime contexts rather than system-prompt sections for the same reason
 * `SUBAGENT_DELEGATION_CONTEXT` is one: the deployment's system prompt stays
 * uniform across a Project and the Threads it spawns, and these are facts about
 * the situation of the agent reading them.
 *
 * Both rows are scope-only by construction: a preset mounts them inside the
 * agent's own scope, where a scoped `PromptContext` shadows any global entry of
 * the same name, so a session that selected another preset never sees them. The
 * text is a pure function of the row's `Config`, never of the session, so the
 * assembled prefix is stable across turns and restarts.
 * @module @deepseek-ai/dsh-experimental-threads-preset/threads-contract
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type-only: make `ctx.systemPrompt` resolve when this row is composed.
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Cordis plugin name. */
export const name = 'thread-contract'

/** The prompt registry this row contributes to. */
export const inject = ['systemPrompt']

/** Context name of the coordinator contract, unique within its scope. */
export const THREADS_CONTEXT_NAME = 'threads:contract'

/** Context name of the worker contract, unique within its scope. */
export const THREAD_WORKER_CONTEXT_NAME = 'threads:worker-contract'

/**
 * Placement among the runtime contexts the harness already allocates.
 *
 * `dsh-system-prompt` owns the central table (sandbox 110, approval 115,
 * subagent delegation 120) and hands it out through `getContextOrder()`. This
 * row is experimental and incubating, so it takes the next free slot in that
 * same band rather than adding a key to a core allocation table. Ten apart, so a
 * later allocation has room.
 */
export const THREADS_CONTEXT_ORDER = 130

/** Which role's contract a row states. */
export type ThreadsRole = 'coordinator' | 'worker'

/** How often the coordinator tells the user about Thread progress. */
export type CheckInPolicy = 'milestones' | 'each-thread' | 'quiet'

/** Whether the coordinator needs user approval before starting Threads. */
export type SpawnPolicy = 'ask' | 'auto'

/** Whether the coordinator needs user approval before merging a Thread. */
export type MergePolicy = 'ask' | 'auto'

/** Contract row configuration; every field selects one fixed sentence. */
export interface Config {
  /** Role whose contract is stated (default `coordinator`). */
  readonly role?: ThreadsRole
  /** Progress reporting cadence for the coordinator (default `milestones`). */
  readonly checkIn?: CheckInPolicy
  /** Approval before starting Threads (default `ask`). */
  readonly spawn?: SpawnPolicy
  /** Approval before merging a Thread branch (default `ask`). */
  readonly mergePolicy?: MergePolicy
}

/** Loader schema for the contract row. */
export const Config: z<Config> = z.object({
  role: z.union(['coordinator', 'worker'] as const).default('coordinator'),
  checkIn: z.union(['milestones', 'each-thread', 'quiet'] as const).default('milestones'),
  spawn: z.union(['ask', 'auto'] as const).default('ask'),
  mergePolicy: z.union(['ask', 'auto'] as const).default('ask'),
})

/** Spawn sentences, one per {@link SpawnPolicy}. */
export const SPAWN_SENTENCES: Record<SpawnPolicy, string> = {
  ask: 'Before starting any Thread, show the user the proposed split and wait for their approval.',
  auto: 'Once the split is clear, start the Threads without waiting for approval, and tell the user what you started.',
}

/** Check-in sentences, one per {@link CheckInPolicy}. */
export const CHECK_IN_SENTENCES: Record<CheckInPolicy, string> = {
  milestones: 'Tell the user at milestones: when the Threads have started, when each one finishes, and when everything is integrated.',
  'each-thread': 'Each time a Thread finishes, tell the user its outcome and its branch before you continue.',
  quiet: 'Do not narrate progress between Threads; report once when every Thread has finished, or earlier only when you need a decision from the user.',
}

/** Merge sentences, one per {@link MergePolicy}. */
export const MERGE_SENTENCES: Record<MergePolicy, string> = {
  ask: 'Ask the user before you merge each Thread.',
  auto: 'Merge a Thread without asking when its checks passed and the merge is conflict-free; ask the user when a conflict needs a design decision or the tests fail.',
}

/**
 * Build the coordinator contract text.
 * @param config - the selected sentence variants; omitted fields take their defaults.
 * @returns the runtime-context text for a Project session.
 */
export function coordinatorContract(config: Config = {}): string {
  return '## Threads\n'
    + '\n'
    + 'You coordinate this Project. A Thread is a background agent that works in its own git worktree on its own branch, so its edits do not appear in the Project checkout until you merge its branch.\n'
    + '\n'
    + 'Restate the goal in your own words, propose a split into independent Threads (tasks that do not need each other\'s results and, where possible, touch different files), and start each Thread with the `subagent` tool. '
    + `${SPAWN_SENTENCES[config.spawn ?? 'ask']}\n`
    + '\n'
    + 'A Thread starts with no history of this conversation. Write each task to be self-contained: the goal, the relevant paths, the constraints, and how to verify the result.\n'
    + '\n'
    + 'The `subagent` call is asynchronous: it returns a Thread id as soon as the Thread starts, not its work. A Thread reports back on its own when it finishes, with a closing message. Do not poll or wait in a loop; continue with other work, or end your turn. '
    + `${CHECK_IN_SENTENCES[config.checkIn ?? 'milestones']}\n`
    + '\n'
    + '`thread_status` shows your Threads with their state, branch, commits ahead of the base, and uncommitted files. It is bounded and may omit Threads, so never read it as the full list; narrow it with the state filter instead.\n'
    + '\n'
    + 'Read the Project memory with memory_read when you start a goal, and record decisions, agreements, and facts every Thread needs with memory_write.\n'
    + '\n'
    + 'Review a finished Thread with `thread_diff`, which lists its commits and changed files. Use `send_message` to give a running Thread more instructions and `interrupt_agent` to stop it.\n'
    + '\n'
    + 'Integrate a reviewed Thread by merging its branch into the Project checkout with `git merge --no-ff <branch>`, resolving conflicts, and running the tests. When several Threads changed the same files, propose a merge order before you merge any of them. '
    + `${MERGE_SENTENCES[config.mergePolicy ?? 'ask']}\n`
    + '\n'
    + 'After a Thread\'s branch is merged, suggest that the user archive that Thread. Archiving is done by the user from the interface; you cannot do it.'
}

/**
 * Build the worker contract text.
 * @returns the runtime-context text for a Thread session.
 */
export function workerContract(): string {
  return '## Thread\n'
    + '\n'
    + 'You are a Thread of a Project: a background agent working on one task given by the coordinator that started you. Your checkout and your git branch are your own. Your edits reach the Project checkout only when the coordinator merges your branch.\n'
    + '\n'
    + 'Commit each finished step with a meaningful message. Do not push, and do not change other branches, unless you are asked to.\n'
    + '\n'
    + 'Read the Project memory with memory_read before you start, and record a decision other Threads need with memory_write; do not store file contents or logs there.\n'
    + '\n'
    + 'When you are done, send your parent a self-contained summary with `send_message`: what changed, how you verified it, the remaining risks, and your branch name from `git branch --show-current`. Your parent cannot read your transcript or your files; the summary and your branch are all it gets.'
}

/** The coordinator contract with every default variant. */
export const THREADS_CONTRACT_CONTEXT = coordinatorContract()

/** The worker contract. */
export const THREAD_WORKER_CONTRACT_CONTEXT = workerContract()

/**
 * Register the contract of the configured role for the mounting context's scope.
 * @param ctx - the agent's scope, carrying the prompt registry.
 * @param config - the role and sentence variants.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const worker = config.role === 'worker'
  ctx.effect(
    () => ctx.systemPrompt.context({
      name: worker ? THREAD_WORKER_CONTEXT_NAME : THREADS_CONTEXT_NAME,
      order: THREADS_CONTEXT_ORDER,
      text: worker ? workerContract() : coordinatorContract(config),
    }),
    'threads-contract.context()',
  )
}
