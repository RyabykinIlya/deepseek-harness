/**
 * Typed failures of the worktree service.
 *
 * The codes CONTINUE the existing `SubagentError` vocabulary (design §3.3) rather
 * than starting a parallel one, so a caller can route on `error.code` without
 * knowing which package raised it. Some codes have no counterpart in the design's
 * table and are additions this implementation needs; they are marked below.
 *
 * @module @deepseek-ai/dsh-worktree-manager/error
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'

/** Stable, machine-routable worktree failure codes. Never parse `message`; route on this. */
export type WorktreeErrorCode =
  /** The requested `repoRoot` is not inside a git work tree (design §3.3). */
  | 'NOT_A_GIT_REPO'
  /** A creation step (clone or checkout) returned non-zero for a reason no other code covers (design §3.3). */
  | 'WORKTREE_CREATE_FAILED'
  /** The Thread's branch already exists; the worktree was not added (design §3.3, SBFT A4). */
  | 'WORKTREE_BRANCH_EXISTS'
  /** The target worktree path is already occupied on disk or by another worktree. */
  | 'WORKTREE_PATH_IN_USE'
  /** The `git` executable could not be spawned at all (missing binary, EACCES, …). */
  | 'GIT_SPAWN_FAILED'
  /** A dirty worktree was removed without `force`; unsaved work is never discarded silently (SBFT A7). */
  | 'REMOVE_DIRTY_WITHOUT_FORCE'
  /** The configured `maxWorktreesPerRepo` active worktrees already exist for the repository. */
  | 'WORKTREE_LIMIT_REACHED'
  /** A durable record claims a worktree that reconcile found abandoned (design §3.3). */
  | 'WORKTREE_ORPHANED'
  /** Addition: the record's path is not on disk or not a git work tree (SBFT A8). */
  | 'WORKTREE_NOT_FOUND'
  /** Addition: the caller's subdirectory of the repository does not exist in the new worktree. */
  | 'WORKTREE_SUBDIRECTORY_MISSING'
  /** Addition: an illegal state-machine transition was attempted (internal invariant guard). */
  | 'WORKTREE_STATE_ILLEGAL'
  /** Addition: a git invocation failed for a reason no other code describes (list/remove/status). */
  | 'WORKTREE_OPERATION_FAILED'
  /** Addition: the registry lock shared by processes on one `worktreeRoot` could not be acquired in time, or was lost mid-transition. */
  | 'WORKTREE_REGISTRY_LOCKED'

/** Typed failure for the worktree seam. Route on {@link WorktreeError.code}. */
export class WorktreeError extends HarnessError {
  constructor(message: string, code: WorktreeErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'WorktreeError'
  }
}
