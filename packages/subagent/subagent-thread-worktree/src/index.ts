/**
 * The in-process THREAD subagent backend: registers a {@link SubagentProvider} on
 * `ctx.subagents` that gives each continuable child its own git worktree, so parallel
 * children never share a checkout.
 *
 * The provider's whole participation in a continuable child is `prepareContinuable`:
 * it creates the worktree, returns the child's isolated `cwd`, and OWNS ROLLBACK of
 * that worktree when the continuation manager's preparation aborts or throws. The
 * manager owns identity, composition, delivery, resume, and disposal; this package
 * owns only the git side effect.
 *
 * The provider also installs the worktree service's `sessionExists` probe, so the service can sweep
 * worktrees whose child session was never published (admission refusal, duplicate id, materialization
 * error, cancellation inside the continuation manager).
 *
 * The one-shot `start` path is inherited from the shared in-process driver, which
 * cannot relocate a child: a one-shot child necessarily shares the parent's cwd and
 * is therefore NOT isolated. Threads are continuable by construction.
 *
 * @module @deepseek-ai/dsh-subagent-thread-worktree
 */

import { realpathSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {
  ContinuableCreateRequest,
  ContinuableCreateSpec,
  ResolvedSubagentStartRequest,
  SubagentCapabilities,
  SubagentProvider,
} from '@deepseek-ai/dsh-subagent'
import { resolveRepoTopLevel, threadSlug, WorktreeError } from '@deepseek-ai/dsh-worktree-manager'
import type { WorktreeBasePolicy, WorktreeService } from '@deepseek-ai/dsh-worktree-manager'
import { startInProcessRun } from '@deepseek-ai/dsh-subagent-in-process-driver'

export const name = 'subagent-thread-worktree'
// `worktrees` is the injected capability; `subagents` is the registry this provider
// joins. `tools` is deliberately NOT injected, matching the other in-process backends:
// the delegation tool's position in the model-visible tool list must not depend on
// which backend is loaded. `sessionPersistence` is read lazily and optional.
export const inject = ['subagents', 'worktrees']

/** What a new Thread's worktree is created from. */
export type ThreadBase =
  /** The parent checkout's committed `HEAD`. */
  | 'head'
  /**
   * `HEAD` plus the parent's tracked uncommitted changes, captured with `git stash create`
   * (falls back to `HEAD` when nothing tracked is modified). Untracked files are NOT included.
   */
  | 'head-with-uncommitted'

/** Config: the registry name plus the worktree layout policy. */
export interface Config {
  /** Provider name on `ctx.subagents` (default `thread`). */
  providerName: string
  /**
   * Whether each Thread gets its own branch. When false, the worktree is detached
   * at the current base ref and `WorktreeRecord.branch` stays empty.
   */
  branchPerThread: boolean
  /** Branch name template; `{{id}}` is replaced by the Thread's slug (see `threadSlug`). */
  branchTemplate: string
  /** Agent preset id the Thread is composed from; absent means the child inherits the parent's preset. */
  childAgentPreset?: string
  /**
   * Which base the service resolves (default `head`).
   *
   * The service owns the policy — including the `git stash create` that captures
   * the parent's uncommitted state. This provider used to run that snapshot
   * itself and hand the service a commit sha under the name `baseRef`, which
   * now means "the ref the request named" while the snapshot lands in
   * `baseSha`. Naming the field after the service's own vocabulary keeps the two
   * from colliding.
   */
  base: WorktreeBasePolicy
}

export const Config: z<Config> = z.object({
  providerName: z.string().default('thread'),
  branchPerThread: z.boolean().default(true),
  branchTemplate: z.string().default('dsh/thread-{{id}}'),
  childAgentPreset: z.string(),
  base: z.union(['head', 'head-with-uncommitted'] as const).default('head'),
})

/**
 * The worktree provider. Each continuable child receives its own git worktree whose
 * path becomes the child's durable `cwd`; the sandbox derives its write root from that
 * cwd, which is what actually confines the Thread's writes.
 */
class ThreadWorktreeProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities = {
    agentOptions: true,
    outputSchema: true,
    depthLimit: true,
    toolFilter: true,
    persona: true,
  }
  // A fresh Thread starts with no inherited history: an independent context window is
  // the point, and a fork prefix would spend the child's budget on the parent's bytes.
  readonly inheritsParentContext = false
  // The worktree is established in `prepareContinuable` and nowhere else, so the
  // one-shot route below would run this child in the parent's own checkout.
  readonly isolatesContinuableCwd = true

  constructor(
    readonly name: string,
    private readonly worktrees: WorktreeService,
    private readonly config: Config,
  ) {}

  /** One-shot children share the parent's cwd; isolation applies to continuable Threads only. */
  start(request: ResolvedSubagentStartRequest) {
    return startInProcessRun(request, {})
  }

  /**
   * Create the Thread's worktree and return its matching subdirectory as the child's cwd.
   *
   * ROLLBACK OWNERSHIP: the continuation manager cannot clean this up. By the time
   * this resolves, the child session is not yet published, so a later failure or
   * cancellation has no handle to dispose and `ContinuableCreateSpec` carries no
   * compensating callback. Every rejection path after the worktree exists removes it
   * before propagating; a crash or a failure inside the manager is left to the worktree
   * service's orphan sweep (see `apply`).
   *
   * @param request - the reserved child identity and the delegating parent.
   * @returns a spec carrying the isolated absolute cwd and the configured agent preset.
   * @throws propagates the worktree service's typed errors; `WORKTREE_SUBDIRECTORY_MISSING` when the
   *   parent's subdirectory is absent from the base commit. No silent degradation.
   */
  async prepareContinuable(request: ContinuableCreateRequest): Promise<ContinuableCreateSpec> {
    const parent: Agent = request.parent
    const parentCwd = parent.session.header.cwd
    if (parentCwd === undefined) {
      // Fail loud rather than silently producing an unisolated Thread.
      throw new Error('thread worktrees require the parent session to have a cwd')
    }
    request.signal.throwIfAborted()

    const slug = threadSlug(request.sessionId)
    const branch = this.config.branchPerThread
      ? this.config.branchTemplate.replace('{{id}}', slug)
      : undefined
    // The service writes a durable `reserved` intent BEFORE `git worktree add`, so a
    // crash mid-add is recoverable by reconcile. `create` rolls back on its own
    // failure and on abort.
    //
    // `baseRef` names the ref the snapshot is taken against and the fallback when
    // the working tree is clean; `base` is the policy that decides whether a
    // snapshot happens at all. The service owns both, so this provider runs no
    // git of its own here.
    const record = await this.worktrees.create({
      repoRoot: parentCwd,
      threadId: request.sessionId,
      baseRef: 'HEAD',
      base: this.config.base,
      ...branch === undefined ? {} : { branch },
    }, request.signal)

    try {
      // Post-creation cancellation: the child will never be published.
      request.signal.throwIfAborted()
      const cwd = await childCwd(record.path, parentCwd)
      return {
        cwd,
        ...this.config.childAgentPreset === undefined ? {} : { agentPreset: this.config.childAgentPreset },
      }
    } catch (error) {
      await this.worktrees.remove(record, { force: true })
      throw error
    }
  }
}

/**
 * Map the parent's cwd into the new worktree: worktree root plus the parent cwd's path below the
 * repository top level.
 *
 * The base the relative path is measured from must be the PARENT's own repository
 * top level. Falling back to another base would let the joined path climb out of
 * the worktree with `..` segments — a cwd that is no longer confined by the
 * worktree it was isolated for — so a cwd outside a work tree is refused instead.
 * @param worktreePath - absolute worktree root.
 * @param parentCwd - the parent session's cwd.
 * @returns the absolute child cwd, which exists.
 * @throws WorktreeError `NOT_A_GIT_REPO` when the parent cwd is in no work tree, or
 *   `WORKTREE_SUBDIRECTORY_MISSING` when its directory is absent in the worktree.
 */
async function childCwd(worktreePath: string, parentCwd: string): Promise<string> {
  const parentTop = await resolveRepoTopLevel(parentCwd)
  if (parentTop === undefined) {
    throw new WorktreeError(
      `thread worktrees: the parent cwd ${parentCwd} is not inside a git work tree`,
      'NOT_A_GIT_REPO',
    )
  }
  const rel = relative(realpathSync(parentTop), realpathSync(parentCwd))
  if (rel === '') return worktreePath
  const target = join(worktreePath, rel)
  let isDirectory = false
  try {
    isDirectory = (await stat(target)).isDirectory()
  } catch {
    // Absent path: reported below with the same message as a non-directory.
    isDirectory = false
  }
  if (!isDirectory) {
    throw new WorktreeError(
      `thread worktrees: the parent cwd subdirectory "${rel}" does not exist in the new worktree at ${worktreePath}; `
      + 'it is untracked or not in the base commit',
      'WORKTREE_SUBDIRECTORY_MISSING',
    )
  }
  return target
}

export function apply(ctx: Context, config: Config): void {
  const worktrees = ctx.worktrees
  ctx.subagents.registerProvider(new ThreadWorktreeProvider(config.providerName, worktrees, config))

  let warned = false
  const probe = async (threadId: string): Promise<boolean> => {
    const persistence = ctx.get('sessionPersistence')
    if (persistence === undefined) {
      if (!warned) {
        warned = true
        ctx.logger.warn('subagent-thread-worktree: no session persistence service; orphaned worktrees are not swept')
      }
      // Unknown is not "missing": never sweep on a guess.
      return true
    }
    return (await persistence.stat(brandString<SessionId>(threadId))) !== undefined
  }
  ctx.effect(() => {
    worktrees.sessionExists = probe
    return () => {
      if (worktrees.sessionExists === probe) worktrees.sessionExists = undefined
    }
  }, 'subagent-thread-worktree.sessionExists')
}

export { ThreadWorktreeProvider }
