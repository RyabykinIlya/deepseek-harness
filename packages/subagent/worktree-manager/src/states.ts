/**
 * Runtime state sets of the worktree state machine; the state names are declared in `types.ts`.
 *
 * @module @deepseek-ai/dsh-worktree-manager/states
 */

import type { WorktreeState } from './types.ts'

/** Terminal states: a record in one of these holds no worktree and is never revived. */
export const TERMINAL_WORKTREE_STATES: readonly WorktreeState[] = ['rolled-back', 'removed']

/** States whose record still claims (or may still claim) a worktree on disk. */
export const ACTIVE_WORKTREE_STATES: readonly WorktreeState[] = ['reserved', 'ready', 'orphaned', 'removing']
