/**
 * The in-process THREAD subagent backend: registers a {@link SubagentProvider} on
 * `ctx.subagents` that gives each continuable child its own git worktree, so parallel
 * children never share a checkout. The delegation's optional `repository` names which
 * repository the worktree comes from; without one, the parent's own working directory
 * must be that repository.
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
 * is therefore NOT isolated. Threads are continuable by construction, and a one-shot
 * request that names a `repository` is refused (see `start`).
 *
 * @module @deepseek-ai/dsh-subagent-thread-worktree
 */

import { realpathSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
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
    // `prepareContinuable` resolves `request.repository` to the worktree's source repository.
    repository: true,
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

  /**
   * Run a one-shot child in the parent's working directory, where this route builds no worktree.
   *
   * @param request - the one-shot start request after the service's capability checks.
   * @returns the shared driver's run of the child in the parent's working directory.
   * @throws Error when the request names a `repository`: this route cannot honor the name, and
   *   accepting the request would ignore it.
   */
  start(request: ResolvedSubagentStartRequest) {
    if (request.repository !== undefined) {
      throw new Error(
        'thread worktrees: repository is not available on the one-shot route, which runs the child '
        + 'in the parent\'s working directory with no worktree; start the child in the background instead',
      )
    }
    return startInProcessRun(request, {})
  }

  /**
   * Create the Thread's worktree from the repository the delegation names and return the
   * child's cwd inside it.
   *
   * The repository is `request.repository` resolved against the parent's working directory,
   * or the working directory itself when the delegation named none — which only works while
   * that directory is itself a repository. Resolution happens on the child's FIRST activation:
   * `repoRoot` stays durable in the worktree record and the returned cwd in the session header,
   * so a cold resume re-resolves nothing.
   *
   * ROLLBACK OWNERSHIP: the continuation manager cannot clean this up. By the time
   * this resolves, the child session is not yet published, so a later failure or
   * cancellation has no handle to dispose and `ContinuableCreateSpec` carries no
   * compensating callback. Every rejection path after the worktree exists removes it
   * before propagating; a crash or a failure inside the manager is left to the worktree
   * service's orphan sweep (see `apply`).
   *
   * @param request - the reserved child identity, the delegating parent, and the repository
   *   the delegation named inside the parent's working directory.
   * @returns a spec carrying the isolated absolute cwd and the configured agent preset.
   * @throws WorktreeError `NOT_A_GIT_REPO` when the repository is not resolvable inside the
   *   parent's working directory (the message lists the repositories it holds), or
   *   `WORKTREE_SUBDIRECTORY_MISSING` when the chosen subdirectory is absent from the base
   *   commit; the worktree service's typed errors propagate as they stand. No silent
   *   degradation.
   */
  async prepareContinuable(request: ContinuableCreateRequest): Promise<ContinuableCreateSpec> {
    const parent: Agent = request.parent
    const parentCwd = parent.session.header.cwd
    if (parentCwd === undefined) {
      // Fail loud rather than silently producing an unisolated Thread.
      throw new Error('thread worktrees require the parent session to have a cwd')
    }
    request.signal.throwIfAborted()

    const target = request.repository === undefined ? parentCwd : resolve(parentCwd, request.repository)
    const repoTop = await resolveThreadRepository(target, parentCwd)

    const slug = threadSlug(request.sessionId)
    const branch = this.config.branchPerThread
      ? this.config.branchTemplate.replace('{{id}}', slug)
      : undefined
    // The service writes a durable `reserved` intent BEFORE it clones, so a crash
    // mid-create is recoverable by reconcile. `create` rolls back on its own
    // failure and on abort.
    //
    // `baseRef` names the ref the snapshot is taken against and the fallback when
    // the working tree is clean; `base` is the policy that decides whether a
    // snapshot happens at all. The service owns both, so this provider runs no
    // git of its own here. Exactly one of `branch` and `detached` travels: without
    // a branch per Thread the checkout is detached and the record carries none.
    const record = await this.worktrees.create({
      // Any path inside the chosen repository: the service resolves the enclosing top level.
      repoRoot: target,
      threadId: request.sessionId,
      baseRef: 'HEAD',
      base: this.config.base,
      ...branch === undefined ? { detached: true } : { branch },
    }, request.signal)

    try {
      // Post-creation cancellation: the child will never be published.
      request.signal.throwIfAborted()
      const cwd = await childCwd(record.path, repoTop, target)
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
 * Map the delegation's target into the new worktree: worktree root plus the target's path
 * below the chosen repository's top level.
 *
 * The base the relative path is measured from is the REPOSITORY's top level, which encloses
 * the target by construction (see `resolveThreadRepository`). Any other base would let the
 * joined path climb out of the worktree with `..` segments — a cwd that is no longer confined
 * by the worktree it was isolated for.
 * @param worktreePath - absolute worktree root.
 * @param repoTop - top level of the repository the worktree was created from.
 * @param target - the resolved path inside that repository the child works in.
 * @returns the absolute child cwd, which exists.
 * @throws WorktreeError `WORKTREE_SUBDIRECTORY_MISSING` when that path is absent from the
 *   worktree — untracked or not in the base commit.
 */
async function childCwd(worktreePath: string, repoTop: string, target: string): Promise<string> {
  const rel = relative(realpathSync(repoTop), realpathSync(target))
  if (rel === '') return worktreePath
  const cwd = join(worktreePath, rel)
  if (!await isExistingDirectory(cwd)) {
    throw new WorktreeError(
      `thread worktrees: the parent cwd subdirectory "${rel}" does not exist in the new worktree at ${worktreePath}; `
      + 'it is untracked or not in the base commit',
      'WORKTREE_SUBDIRECTORY_MISSING',
    )
  }
  return cwd
}

/**
 * Whether `path` is an existing directory.
 * @param path - absolute path to test.
 * @returns true for an existing directory; a missing or unreadable path is not one.
 */
async function isExistingDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    // ENOENT/EACCES: an absent or unreadable path is not a directory, which is both
    // what an unresolvable repository and a worktree subdirectory that is not there mean.
    return false
  }
}

/**
 * Resolve the repository a delegation names, refusing one outside the parent's directory.
 *
 * @param target - the path the delegation resolved to: the parent cwd when it named no
 *   repository, `parentCwd` joined with `repository` otherwise.
 * @param parentCwd - the parent session's working directory.
 * @returns the top level of the repository `target` lies in.
 * @throws WorktreeError `NOT_A_GIT_REPO` when `target` is missing, is a file, lies in no work
 *   tree, or resolves outside `parentCwd` after realpath; the message lists the repositories
 *   under `parentCwd`, so the coordinator learns what it may name instead of probing names.
 */
async function resolveThreadRepository(target: string, parentCwd: string): Promise<string> {
  // A path git cannot even start in — missing, or a file — must produce the same
  // refusal as a path outside a work tree, never a git spawn failure.
  if (!await isExistingDirectory(target)) throw await unresolvableRepository(target, parentCwd)
  const inside = relative(realpathSync(parentCwd), realpathSync(target))
  if (isAbsolute(inside) || inside === '..' || inside.startsWith(`..${sep}`)) {
    throw await unresolvableRepository(target, parentCwd)
  }
  const repoTop = await resolveRepoTopLevel(target)
  if (repoTop === undefined) throw await unresolvableRepository(target, parentCwd)
  return repoTop
}

/**
 * The refusal for a repository the delegation did not resolve inside the parent's directory.
 *
 * @param target - the path the delegation resolved to.
 * @param parentCwd - the parent session's working directory the repository must lie inside.
 * @returns the `NOT_A_GIT_REPO` error whose message lists the repositories under `parentCwd`.
 */
async function unresolvableRepository(target: string, parentCwd: string): Promise<WorktreeError> {
  return new WorktreeError(
    `thread worktrees: the repository for this Thread is not resolvable from ${target}; `
    + `name a repository inside ${parentCwd} with the repository parameter. `
    + `Repositories under ${parentCwd}: ${await repositoryCandidates(parentCwd)}.`,
    'NOT_A_GIT_REPO',
  )
}

/**
 * The immediate subdirectories of `dir` that are themselves repository top levels.
 *
 * @param dir - the parent working directory to list repositories under.
 * @returns their sorted names, comma-separated, or the literal `none found` when `dir` holds
 *   no repository or cannot be read.
 */
async function repositoryCandidates(dir: string): Promise<string> {
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    // A missing or unreadable parent directory holds no candidates; the refusal it is
    // reported with stands either way, so the readdir failure must not replace it.
    return 'none found'
  }
  const candidates: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const path = join(dir, entry.name)
    // Realpath on both sides, as in the containment check: a subdirectory whose git
    // top level is the subdirectory itself is a repository of its own.
    if (await resolveRepoTopLevel(path) === realpathSync(path)) candidates.push(entry.name)
  }
  const sorted = candidates.sort().join(', ')
  return sorted === '' ? 'none found' : sorted
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
