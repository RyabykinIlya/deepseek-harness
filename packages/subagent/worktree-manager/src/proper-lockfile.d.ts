/**
 * Minimal type surface for `proper-lockfile` (no bundled declarations): only the
 * `lock` function the worktree registry uses, on the CommonJS default export.
 * @module @deepseek-ai/dsh-worktree-manager/proper-lockfile-types
 */

declare module 'proper-lockfile' {
  /** Options accepted by {@link lock}. */
  interface LockOptions {
    /** Milliseconds after which an un-refreshed lock counts as stale (library minimum 5000). */
    stale?: number
    /** Resolve symlinks of the target path first; requires the target to exist. */
    realpath?: boolean
    /** Explicit lock directory path instead of `<target>.lock`. */
    lockfilePath?: string
    /** Retry policy: a count or `retry` module options. */
    retries?: { retries: number; factor: number; minTimeout: number; maxTimeout: number }
    /** Called when the lock was lost (stale takeover or deleted lock directory). */
    onCompromised?: (error: Error) => void
  }

  /**
   * Acquire an advisory lock on `file`.
   * @param file - path to lock.
   * @param options - lock options.
   * @returns a function that releases the lock.
   */
  function lock(file: string, options?: LockOptions): Promise<() => Promise<void>>

  const lockfile: { lock: typeof lock }
  export default lockfile
}
