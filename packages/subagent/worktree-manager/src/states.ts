/**
 * Runtime guards and state sets of the worktree vocabulary; the names themselves are declared in `types.ts`.
 *
 * @module @deepseek-ai/dsh-worktree-manager/states
 */

import type { WorktreeBasePolicy, WorktreeState } from './types.ts'

/** Terminal states: a record in one of these holds no worktree and is never revived. */
export const TERMINAL_WORKTREE_STATES: readonly WorktreeState[] = ['rolled-back', 'removed']

/** States whose record still claims (or may still claim) a worktree on disk. */
export const ACTIVE_WORKTREE_STATES: readonly WorktreeState[] = ['reserved', 'ready', 'orphaned', 'removing']

/**
 * Narrow an arbitrary value to a {@link WorktreeBasePolicy}.
 *
 * Used on the way back IN, so a hand-edited or truncated sidecar line cannot smuggle an unknown
 * policy past the fold and have it act like something it is not.
 * @param value - candidate base policy name, of any type.
 * @returns true only for a declared policy.
 */
export function isWorktreeBasePolicy(value: unknown): value is WorktreeBasePolicy {
  return value === 'head' || value === 'head-with-uncommitted'
}
