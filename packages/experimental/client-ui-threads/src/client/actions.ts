/**
 * Outcome shape shared by the Thread row actions (Stop, Archive).
 *
 * The browser half resolves a Remote call into this plain value so the roster
 * component decides the user-visible feedback without importing Remote types.
 */

/** Remote failure code Archive reports when the Thread's worktree holds uncommitted changes. */
export const WORKTREE_DIRTY_CODE = 'threads/worktree-dirty'

/** Result of one Thread action: success, or the Remote failure's code and message. */
export type ThreadActionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: string; readonly message: string }

/**
 * Fold a Remote result into a {@link ThreadActionResult}.
 * @param result - the resolved Remote call; a failure carries `error.code` and `error.message`.
 * @returns success, or the failure's code and message.
 */
export function toActionResult(
  result: { readonly ok: true } | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } },
): ThreadActionResult {
  return result.ok ? { ok: true } : { ok: false, code: result.error.code, message: result.error.message }
}

/** Result of one Project memory request: the value, or the Remote failure's code and message. */
export type MemoryResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: string; readonly message: string }

/**
 * Fold a Remote result into a {@link MemoryResult}.
 * @param result - the resolved Remote call.
 * @returns the value, or the failure's code and message.
 */
export function toMemoryResult<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } },
): MemoryResult<T> {
  return result.ok ? { ok: true, value: result.value } : { ok: false, code: result.error.code, message: result.error.message }
}
