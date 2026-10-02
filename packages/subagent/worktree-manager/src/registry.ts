/**
 * The durable intent sidecar: one append-only JSONL transition per worktree
 * operation, folded into the current {@link WorktreeRecord} per `threadId`.
 *
 * Two properties matter and are why this is not a plain JSON snapshot:
 *
 * 1. **Intent is durable BEFORE the side effect.** `create` appends `reserved`
 *    before spawning `git worktree add`, so a crash between the two leaves a
 *    detectable record instead of an invisible directory.
 * 2. **State is derived, never stored twice.** There is one line per transition;
 *    the current state is the fold (last line for a `threadId` wins). No second
 *    machine keeps a parallel copy that could disagree with the log.
 *
 * @module @deepseek-ai/dsh-worktree-manager/registry
 */

import { mkdir, open } from 'node:fs/promises'
import { join } from 'node:path'
import lockfile from 'proper-lockfile'
import { WorktreeError } from './error.ts'
import type { WorktreeRecord, WorktreeRegistryLocking, WorktreeState } from './types.ts'

/** File name of the sidecar inside the configured `worktreeRoot`. */
export const REGISTRY_FILE_NAME = 'worktrees.jsonl'

/** Name of the advisory lock directory next to the sidecar. */
export const REGISTRY_LOCK_NAME = 'worktrees.lock'

/**
 * Legal forward transitions of the worktree state machine.
 *
 * Illegal transitions — rejected with `WORKTREE_STATE_ILLEGAL` — are everything
 * not listed here, which is worth spelling out because each one is a bug class:
 *
 * - `reserved → removing` / `reserved → removed`: the add never succeeded, so the
 *   record must pass through `rolled-back`; skipping it loses the intent that the
 *   worktree was ever supposed to exist.
 * - `reserved → ready` without a preceding `reserved` append: the intent record
 *   would not be durable, which is exactly the crash window this design closes.
 * - `ready → reserved`: reserved is only ever the FIRST transition for a thread.
 * - `ready → rolled-back`: rollback belongs to a failed `add`; a live worktree is
 *   removed through `removing → removed` so a failed removal stays a `removing`
 *   tombstone instead of being forgotten.
 * - `orphaned → ready` and `removing → ready`: once a record is classified as
 *   abandoned or mid-removal it is dead; reviving it would resurrect a directory
 *   whose contents may have been discarded.
 * - anything from `removed` / `rolled-back` EXCEPT `reserved`: both states are
 *   terminal, and the single exception is the RESTART edge. A Thread whose
 *   worktree was fully removed may be re-created, and that is the one way a new
 *   lineage begins: `removed → reserved`. It is safe because the terminal state
 *   means `git worktree remove` returned 0, so the path and the branch slot are
 *   free. Every other terminal → * transition is illegal.
 */
const LEGAL_TRANSITIONS: Readonly<Record<WorktreeState, readonly WorktreeState[]>> = {
  reserved: ['ready', 'rolled-back', 'orphaned'],
  ready: ['removing', 'orphaned'],
  orphaned: ['removing', 'rolled-back'],
  removing: ['removed'],
  // Restart edge only — see the note above.
  removed: ['reserved'],
  'rolled-back': ['reserved'],
}

/**
 * Test whether one state may follow another.
 * @param from - current folded state (`undefined` for a thread with no record yet).
 * @param to - state being entered.
 * @returns true for a first record, a no-op re-assertion of the same state, or a listed transition.
 */
export function isLegalTransition(from: WorktreeState | undefined, to: WorktreeState): boolean {
  if (from === undefined || from === to) return true
  return LEGAL_TRANSITIONS[from].includes(to)
}

/**
 * Parse one sidecar line into a record, rejecting a structurally wrong line.
 * @param line - a single JSONL line.
 * @returns the parsed transition record.
 */
function parseTransition(line: string): WorktreeRecord {
  const parsed: unknown = JSON.parse(line)
  if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object')
  const candidate = parsed as Partial<Record<keyof WorktreeRecord, unknown>>
  const { threadId, path, baseRef, state, repoRoot } = candidate
  if (typeof threadId !== 'string' || threadId === '') throw new Error('threadId')
  if (typeof path !== 'string' || path === '') throw new Error('path')
  if (typeof baseRef !== 'string' || baseRef === '') throw new Error('baseRef')
  if (typeof repoRoot !== 'string' || repoRoot === '') throw new Error('repoRoot')
  if (typeof state !== 'string' || !isWorktreeState(state)) throw new Error('state')
  const { branch, baseSha, createdAt } = candidate
  if (branch !== undefined && typeof branch !== 'string') throw new Error('branch')
  if (baseSha !== undefined && typeof baseSha !== 'string') throw new Error('baseSha')
  if (createdAt !== undefined && (typeof createdAt !== 'number' || !Number.isFinite(createdAt))) throw new Error('createdAt')
  return {
    threadId,
    path,
    baseRef,
    repoRoot,
    state,
    // `exactOptionalPropertyTypes`: absent facts stay absent, not `undefined`.
    ...branch === undefined ? {} : { branch },
    ...baseSha === undefined ? {} : { baseSha },
    ...createdAt === undefined ? {} : { createdAt },
  }
}

/** The immutable facts a transition carries; `createdAt` is owned by the registry. */
export type WorktreeRecordFields = Omit<WorktreeRecord, 'threadId' | 'state' | 'createdAt'>

/**
 * Narrow an arbitrary string to a {@link WorktreeState}.
 * @param value - candidate state name.
 * @returns true only for a declared state.
 */
export function isWorktreeState(value: string): value is WorktreeState {
  return value === 'reserved'
    || value === 'ready'
    || value === 'rolled-back'
    || value === 'removing'
    || value === 'removed'
    || value === 'orphaned'
}

/** The locked view handed to a {@link WorktreeRegistry.reserve} decision callback. */
export interface WorktreeRegistryTransaction {
  /** Current folded record of a Thread, read after the tail written by other processes was folded in. */
  find(threadId: string): WorktreeRecord | undefined
  /** Every folded record. */
  all(): readonly WorktreeRecord[]
  /** Append a transition while the lock is already held. Same rules as {@link WorktreeRegistry.transition}. */
  transition(threadId: string, next: WorktreeState, fields: WorktreeRecordFields): Promise<WorktreeRecord>
}

/**
 * The fold of the sidecar log, plus the append that extends it.
 *
 * Several processes may share one `worktreeRoot`. Every transition runs under an
 * advisory lock (`proper-lockfile`), folds the lines other processes appended
 * since the last read, validates the edge against that fresh view, and writes the
 * record with one `O_APPEND` write, so a concurrent reader never observes a
 * half-updated record.
 */
export class WorktreeRegistry {
  private readonly file: string
  private readonly lockPath: string
  private readonly folded = new Map<string, WorktreeRecord>()
  /** Bytes of the sidecar already folded; always the end of a complete line. */
  private offset = 0
  private lineNumber = 0
  private refreshing: Promise<unknown> = Promise.resolve()

  /**
   * @param root - the configured `worktreeRoot`; it holds the sidecar and the worktrees.
   * @param locking - lock acquisition and staleness settings.
   */
  constructor(readonly root: string, private readonly locking: WorktreeRegistryLocking) {
    this.file = join(root, REGISTRY_FILE_NAME)
    this.lockPath = join(root, REGISTRY_LOCK_NAME)
  }

  /**
   * Fold the sidecar into memory. A missing file is an empty registry (first run), not an error.
   *
   * An unterminated final line is the normal artifact of a crash mid-append and is
   * skipped; a malformed terminated line means the log is genuinely corrupt and
   * throws, because silently discarding mid-log records would resurrect finished worktrees.
   * @returns this registry, for chaining.
   */
  load(): Promise<this> {
    return this.refresh()
  }

  /**
   * Fold the lines appended since the previous read, including those written by other processes.
   * @returns this registry, for chaining.
   */
  refresh(): Promise<this> {
    const run = this.refreshing.then(() => this.readTail())
    // The queue itself never rejects; each caller sees its own read's failure through `run`.
    this.refreshing = run.catch(() => {})
    return run.then(() => this)
  }

  /** Read and fold the bytes after {@link WorktreeRegistry.offset}. */
  private async readTail(): Promise<void> {
    let raw: string
    try {
      const handle = await open(this.file, 'r')
      try {
        const { size } = await handle.stat()
        const buffer = Buffer.alloc(Math.max(0, size - this.offset))
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, this.offset)
        raw = buffer.subarray(0, bytesRead).toString('utf8')
      } finally {
        await handle.close()
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw new WorktreeError(`worktree-manager: cannot read ${this.file}`, 'WORKTREE_CREATE_FAILED', { cause: error })
    }
    const end = raw.lastIndexOf('\n') + 1
    for (const line of raw.slice(0, end).split('\n')) {
      this.lineNumber++
      if (line.trim() === '') continue
      try {
        const record = parseTransition(line)
        this.folded.set(record.threadId, record)
      } catch (error) {
        throw new WorktreeError(
          `worktree-manager: corrupt worktree registry at ${this.file}:${this.lineNumber}`,
          'WORKTREE_CREATE_FAILED',
          { cause: error },
        )
      }
    }
    this.lineNumber--
    this.offset += Buffer.byteLength(raw.slice(0, end), 'utf8')
  }

  /**
   * Current folded records, ordered by `threadId` for a stable listing.
   * @returns every record the log contains, terminal states included.
   */
  all(): readonly WorktreeRecord[] {
    return [...this.folded.values()].sort((a, b) => Number(a.threadId > b.threadId) - Number(a.threadId < b.threadId))
  }

  /**
   * Read one thread's current record.
   * @param threadId - the Thread key.
   * @returns the folded record, or `undefined` when the thread has none.
   */
  find(threadId: string): WorktreeRecord | undefined {
    return this.folded.get(threadId)
  }

  /**
   * Run `fn` while holding the registry lock, with the tail of the log already folded in.
   * @param fn - work to run under the lock.
   * @returns the value `fn` resolves to.
   */
  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await mkdir(this.root, { recursive: true })
    const { timeoutMs, retryIntervalMs, staleMs } = this.locking
    let compromised: Error | undefined
    let release: () => Promise<void>
    try {
      release = await lockfile.lock(this.root, {
        lockfilePath: this.lockPath,
        realpath: false,
        stale: staleMs,
        retries: {
          retries: Math.ceil(timeoutMs / retryIntervalMs),
          factor: 1,
          minTimeout: retryIntervalMs,
          maxTimeout: retryIntervalMs,
        },
        onCompromised: (error) => { compromised = error },
      })
    } catch (error) {
      throw new WorktreeError(
        `worktree-manager: cannot acquire the registry lock ${this.lockPath} within ${timeoutMs} ms`,
        'WORKTREE_REGISTRY_LOCKED',
        { cause: error },
      )
    }
    let result: T
    try {
      await this.refresh()
      result = await fn()
    } finally {
      try {
        await release()
      } catch (releaseError) {
        // A compromised lock makes release() reject; the compromise is reported below, so the rejection adds nothing.
        void releaseError
      }
    }
    if (compromised !== undefined) {
      throw new WorktreeError(
        `worktree-manager: the registry lock ${this.lockPath} was lost while a transition was running`,
        'WORKTREE_REGISTRY_LOCKED',
        { cause: compromised },
      )
    }
    return result
  }

  /**
   * Append one durable transition and fold it in.
   *
   * Re-asserting the current state is an idempotent no-op (no line appended, the
   * existing record returned), which is what makes a retried `create` or a repeated
   * prune converge instead of writing a second worktree.
   * @param threadId - the Thread key.
   * @param next - the state being entered.
   * @param fields - the immutable facts of the worktree (`path`, `repoRoot`, `baseRef`, `branch`, `baseSha`).
   *   `createdAt` is stamped by the `reserved` transition and carried by later ones.
   * @returns the folded record after the transition.
   */
  transition(threadId: string, next: WorktreeState, fields: WorktreeRecordFields): Promise<WorktreeRecord> {
    return this.withLock(() => this.appendTransition(threadId, next, fields))
  }

  /**
   * Atomically check and reserve: under the lock, run `decide` against the fresh
   * registry and, unless it returns an existing record, append `reserved`.
   * @param threadId - the Thread key.
   * @param fields - the immutable facts of the worktree being reserved.
   * @param decide - throws to refuse, returns a record to reuse it, or `undefined` to reserve.
   * @returns the record to use and whether this call appended `reserved`.
   */
  reserve(
    threadId: string,
    fields: WorktreeRecordFields,
    decide: (transaction: WorktreeRegistryTransaction) => Promise<WorktreeRecord | undefined>,
  ): Promise<{ record: WorktreeRecord; created: boolean }> {
    return this.withLock(async () => {
      const reused = await decide({
        find: id => this.folded.get(id),
        all: () => this.all(),
        transition: (id, next, facts) => this.appendTransition(id, next, facts),
      })
      if (reused !== undefined) return { record: reused, created: false }
      return { record: await this.appendTransition(threadId, 'reserved', fields), created: true }
    })
  }

  /** Validate against the folded view, write one line with a single `O_APPEND` write, and fold it. */
  private async appendTransition(threadId: string, next: WorktreeState, fields: WorktreeRecordFields): Promise<WorktreeRecord> {
    const previous = this.folded.get(threadId)
    if (previous !== undefined && !isLegalTransition(previous.state, next)) {
      throw new WorktreeError(
        `worktree-manager: illegal worktree transition ${previous.state} → ${next} for thread ${threadId}`,
        'WORKTREE_STATE_ILLEGAL',
      )
    }
    if (previous !== undefined && previous.state === next) return previous
    const createdAt = next === 'reserved' ? Date.now() : previous?.createdAt
    const record: WorktreeRecord = {
      threadId,
      path: fields.path,
      repoRoot: fields.repoRoot,
      baseRef: fields.baseRef,
      state: next,
      // `exactOptionalPropertyTypes`: an absent fact must stay absent, not `undefined`.
      ...fields.branch === undefined ? {} : { branch: fields.branch },
      ...fields.baseSha === undefined ? {} : { baseSha: fields.baseSha },
      ...createdAt === undefined ? {} : { createdAt },
    }
    const handle = await open(this.file, 'a')
    try {
      await handle.write(Buffer.from(`${JSON.stringify(record)}\n`, 'utf8'))
    } finally {
      await handle.close()
    }
    await this.refresh()
    return record
  }
}
