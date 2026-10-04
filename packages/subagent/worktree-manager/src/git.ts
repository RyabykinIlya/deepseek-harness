/**
 * The git subprocess surface of the worktree service.
 *
 * Every invocation passes an ARGUMENT ARRAY to `execFile` — no shell, no string
 * interpolation — so a Thread id or a ref can never become shell syntax. A
 * non-zero exit is returned as data ({@link GitOutput.code}); only a failure to
 * spawn `git` at all rejects, and it rejects with `GIT_SPAWN_FAILED`.
 *
 * @module @deepseek-ai/dsh-worktree-manager/git
 */

import { execFile, spawn } from 'node:child_process'
import { WorktreeError } from './error.ts'

/** Captured-output ceiling; `git status --porcelain` over a very large tree is the worst case. */
const MAX_GIT_OUTPUT = 32 * 1024 * 1024

/**
 * The typed failure both runners raise when the `git` executable itself cannot start.
 *
 * The whole argv is named because the subcommand alone rarely identifies the
 * operation, and an invocation with no arguments at all names git on its own.
 * @param args - the argv that could not be spawned.
 * @param error - the underlying spawn failure (ENOENT, EACCES, …).
 * @returns the `GIT_SPAWN_FAILED` error to reject with.
 */
function spawnFailure(args: readonly string[], error: Error): WorktreeError {
  const invocation = args.length === 0 ? '' : ` (${args.join(' ')})`
  return new WorktreeError(
    `worktree-manager: could not spawn git${invocation}: ${error.message}`,
    'GIT_SPAWN_FAILED',
    { cause: error },
  )
}

/** One git invocation's result. A non-zero `code` is data, never an exception. */
export interface GitOutput {
  /** Process exit status (0 on success). */
  readonly code: number
  /** Captured standard output, decoded as UTF-8. */
  readonly stdout: string
  /** Captured standard error, decoded as UTF-8. */
  readonly stderr: string
}

/** One entry of `git worktree list --porcelain`. */
export interface GitWorktreeEntry {
  /** Absolute worktree path as git itself reports it (already realpath-normalized). */
  readonly path: string
  /** Full ref of the checked-out branch, or `undefined` for a detached worktree. */
  readonly branch?: string
}

/**
 * Run `git` with an argument array and no shell.
 *
 * Rejects only when the executable cannot be spawned (missing `git`, `EACCES`),
 * because that is an environment failure the caller cannot interpret; every other
 * outcome — including git's own non-zero exits — resolves.
 * @param args - git subcommand and flags, passed verbatim as separate argv entries.
 * @param cwd - directory to run in; `git` resolves the repository from it.
 * @returns the exit code and captured streams.
 */
export function runGit(args: readonly string[], cwd: string): Promise<GitOutput> {
  return new Promise<GitOutput>((resolve, reject) => {
    execFile(
      'git',
      [...args],
      {
        cwd,
        encoding: 'utf8',
        maxBuffer: MAX_GIT_OUTPUT,
        // A credential or host prompt must never wedge a worktree operation; the
        // operations here are local-only, so any prompt is a failure to report.
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ code: 0, stdout, stderr })
          return
        }
        // `code` is the exit status for a completed process and the errno string
        // (ENOENT, EACCES, …) when the spawn itself failed.
        if (typeof error.code !== 'number') {
          reject(spawnFailure(args, error))
          return
        }
        resolve({ code: error.code, stdout, stderr })
      },
    )
  })
}

/**
 * Resolve the absolute top level of the git repository containing `dir`.
 * @param dir - a directory that may or may not be inside a repository.
 * @returns the repository top level, or `undefined` when `dir` is not in a work tree.
 */
export async function resolveRepoTopLevel(dir: string): Promise<string | undefined> {
  const inside = await runGit(['rev-parse', '--is-inside-work-tree'], dir)
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') return undefined
  const topLevel = await runGit(['rev-parse', '--show-toplevel'], dir)
  if (topLevel.code !== 0) return undefined
  const resolved = topLevel.stdout.trim()
  return resolved === '' ? undefined : resolved
}

/**
 * List the repository's worktrees.
 * @param repoRoot - absolute path inside the owning repository.
 * @returns every registered worktree, with its branch when it is not detached.
 */
export async function listWorktrees(repoRoot: string): Promise<readonly GitWorktreeEntry[]> {
  const output = await runGit(['worktree', 'list', '--porcelain'], repoRoot)
  if (output.code !== 0) {
    throw new WorktreeError(
      `worktree-manager: git worktree list failed in ${repoRoot}: ${output.stderr.trim()}`,
      'WORKTREE_OPERATION_FAILED',
    )
  }
  return parseWorktreePorcelain(output.stdout)
}

/**
 * Parse `git worktree list --porcelain` into entries.
 *
 * Records are separated by a blank line and start with `worktree <path>`, followed
 * by `HEAD <sha>` and then either `branch <full-ref>` or `detached`. Only the first
 * two facts are needed here, so the rest is skipped rather than modelled.
 * @param stdout - raw porcelain output.
 * @returns the parsed entries in git's own order (main worktree first).
 */
export function parseWorktreePorcelain(stdout: string): readonly GitWorktreeEntry[] {
  const entries: GitWorktreeEntry[] = []
  let currentPath: string | undefined
  let currentBranch: string | undefined
  const flush = (): void => {
    if (currentPath !== undefined) {
      entries.push(currentBranch === undefined ? { path: currentPath } : { path: currentPath, branch: currentBranch })
    }
    currentPath = undefined
    currentBranch = undefined
  }
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') {
      flush()
      continue
    }
    if (line.startsWith('worktree ')) {
      // A new `worktree` line closes the previous record even without a blank line.
      flush()
      currentPath = line.slice('worktree '.length).trim()
    } else if (line.startsWith('branch ')) {
      currentBranch = line.slice('branch '.length).trim()
    }
  }
  flush()
  return entries
}

/**
 * Test whether a branch already exists in the repository.
 * @param repoRoot - absolute path inside the owning repository.
 * @param branch - branch name to look for.
 * @returns true when `git branch --list` reports at least one match.
 */
export async function branchExists(repoRoot: string, branch: string): Promise<boolean> {
  const output = await runGit(['branch', '--list', branch], repoRoot)
  if (output.code !== 0) {
    throw new WorktreeError(
      `worktree-manager: git branch --list failed in ${repoRoot}: ${output.stderr.trim()}`,
      'WORKTREE_OPERATION_FAILED',
    )
  }
  return output.stdout.trim() !== ''
}

/**
 * Create a worktree, and with it the Thread's branch.
 * @param repoRoot - absolute path inside the owning repository.
 * @param worktreePath - absolute destination path (must not exist yet).
 * @param branch - branch to create at `baseRef`.
 * @param baseRef - ref the new branch is created from.
 * @returns git's raw result; the caller classifies a non-zero exit.
 */
export function addWorktree(
  repoRoot: string,
  worktreePath: string,
  branch: string,
  baseRef: string,
): Promise<GitOutput> {
  return runGit(['worktree', 'add', '-b', branch, worktreePath, baseRef], repoRoot)
}

/**
 * Create a worktree by checking out a branch that already exists.
 *
 * `git worktree add -b` refuses an existing branch, so a Thread that restarts on
 * the branch it created earlier needs this form instead: the branch keeps whatever
 * it already committed, which is the whole point of resuming a Thread.
 * @param repoRoot - absolute path inside the owning repository.
 * @param worktreePath - absolute destination path (must not exist yet).
 * @param branch - existing branch to check out.
 * @returns git's raw result; the caller classifies a non-zero exit.
 */
export function addWorktreeAtExistingBranch(
  repoRoot: string,
  worktreePath: string,
  branch: string,
): Promise<GitOutput> {
  return runGit(['worktree', 'add', worktreePath, branch], repoRoot)
}

/**
 * Remove a worktree. `--force` discards local modifications and untracked files.
 * @param repoRoot - absolute path inside the owning repository.
 * @param worktreePath - absolute path of the registered worktree.
 * @param force - pass `--force` (required for a dirty worktree).
 * @returns git's raw result; the caller classifies a non-zero exit.
 */
export function removeWorktree(repoRoot: string, worktreePath: string, force: boolean): Promise<GitOutput> {
  return runGit(force ? ['worktree', 'remove', '--force', worktreePath] : ['worktree', 'remove', worktreePath], repoRoot)
}

/**
 * Count changed entries in a worktree.
 * @param worktreePath - absolute path of the worktree.
 * @returns git's raw `git status --porcelain` result.
 */
export function worktreeStatus(worktreePath: string): Promise<GitOutput> {
  return runGit(['status', '--porcelain'], worktreePath)
}

/**
 * Snapshot the repository's tracked uncommitted changes as a commit object, WITHOUT touching the
 * working tree or the index.
 *
 * `git stash create` writes only into the object database — nothing lands in the ref namespace and
 * no file moves — so it is safe to run while other agents are working in the same checkout. A plain
 * `git stash push`/`pop` would not be: it rewrites the parent's working tree under everyone else's
 * feet, and two Threads starting at once would pop each other's stash.
 *
 * The commit is a real merge commit whose tree is the working state, so `git worktree add <path>
 * <sha>` materializes exactly what the parent was looking at.
 * @param repoRoot - absolute path inside the owning repository.
 * @returns git's raw result; empty `stdout` with exit 0 means "nothing tracked is modified".
 */
export function stashCreate(repoRoot: string): Promise<GitOutput> {
  return runGit(['stash', 'create'], repoRoot)
}


/** Result of {@link runGitBounded}. */
export interface BoundedGitOutput {
  /** Captured standard output, cut at a UTF-8 character boundary within the byte bound. */
  readonly stdout: string
  /** True when git produced more output than the bound and was stopped. */
  readonly truncated: boolean
  /** Exit status; `0` when git was stopped for exceeding the bound. */
  readonly code: number
  /** Captured standard error, capped at 64 KiB. */
  readonly stderr: string
}

const MAX_BOUNDED_STDERR = 64 * 1024

/**
 * Exit status reported when a signal killed git before it exited on its own.
 *
 * Node reports `code: null` for a signalled process. Reporting that as success
 * would hand back a partial patch as if it were complete, which is the silent
 * degradation this package exists to forbid; the kill this module performs itself
 * to enforce the byte bound is the one exception, and it never reaches here.
 */
const KILLED_BY_SIGNAL = -1

/**
 * Run `git` and keep at most `maxBytes` bytes of standard output; git is killed once the bound is exceeded,
 * so a very large diff never accumulates in memory.
 * @param args - git subcommand and flags, passed verbatim as separate argv entries.
 * @param cwd - directory to run in.
 * @param maxBytes - non-negative byte bound of the returned stdout.
 * @returns the bounded output; rejects with `GIT_SPAWN_FAILED` only when git cannot be spawned.
 */
export function runGitBounded(args: readonly string[], cwd: string, maxBytes: number): Promise<BoundedGitOutput> {
  return new Promise<BoundedGitOutput>((resolve, reject) => {
    const child = spawn('git', [...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
    // Up to 3 extra bytes let the cut detect whether it falls inside a multibyte character.
    const limit = maxBytes + 4
    const chunks: Buffer[] = []
    let collected = 0
    let overflow = false
    const errChunks: Buffer[] = []
    let errCollected = 0
    child.stdout.on('data', (chunk: Buffer) => {
      if (overflow) return
      const room = limit - collected
      if (chunk.length >= room) {
        chunks.push(chunk.subarray(0, room))
        collected = limit
        overflow = true
        child.kill()
        return
      }
      chunks.push(chunk)
      collected += chunk.length
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (errCollected >= MAX_BOUNDED_STDERR) return
      errChunks.push(chunk)
      errCollected += chunk.length
    })
    child.on('error', (error) => {
      reject(spawnFailure(args, error))
    })
    child.on('close', (code) => {
      const buffer = Buffer.concat(chunks)
      const stderr = Buffer.concat(errChunks).toString('utf8')
      if (buffer.length <= maxBytes) {
        resolve({ stdout: buffer.toString('utf8'), truncated: false, code: code ?? KILLED_BY_SIGNAL, stderr })
        return
      }
      let end = maxBytes
      // `buffer.length > maxBytes` above, so `end` is a valid index and can only
      // shrink from there. A continuation byte (10xxxxxx) at the cut means the
      // character straddles it: drop the whole character.
      while (end > 0 && (buffer.readUInt8(end) & 0xc0) === 0x80) end--
      resolve({ stdout: buffer.subarray(0, end).toString('utf8'), truncated: true, code: 0, stderr })
    })
  })
}
