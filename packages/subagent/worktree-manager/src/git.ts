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
 * Create a local clone of a repository at `destPath`, without a checkout.
 *
 * The clone keeps its default `origin` → parent path (file transport) and a complete
 * `.git` of its own inside `destPath`, so one sandbox root covers files and git
 * metadata alike. That is the isolation property of the whole design: a Thread's
 * `git push` to `origin` writes into the parent, outside its root, and the sandbox
 * refuses it. `--no-checkout` keeps the single checkout in the branch step, at the
 * recorded base, instead of twice at HEAD then base.
 * @param repoRoot - absolute top level of the repository to clone.
 * @param destPath - absolute destination path (must not exist yet).
 * @returns git's raw result; the caller classifies a non-zero exit.
 */
export function cloneLocal(repoRoot: string, destPath: string): Promise<GitOutput> {
  return runGit(['clone', '--local', '--no-checkout', repoRoot, destPath], repoRoot)
}

/**
 * Create `branch` at `at` and check it out — the first attempt of a Thread's branch.
 * @param clonePath - absolute root of the clone.
 * @param branch - branch to create.
 * @param at - resolved commit the branch starts at.
 * @returns git's raw result; the caller classifies a non-zero exit.
 */
export function checkoutNewBranch(clonePath: string, branch: string, at: string): Promise<GitOutput> {
  return runGit(['checkout', '-b', branch, at], clonePath)
}

/**
 * Check out the existing `branch`, keeping whatever it already committed.
 *
 * Removal imports a Thread's branch back into the parent (see
 * {@link fetchBranchIntoParent}), so a fresh clone of a restarted Thread already
 * contains the branch and its commits — resuming must not create it again.
 * @param clonePath - absolute root of the clone.
 * @param branch - existing branch to check out.
 * @returns git's raw result; the caller classifies a non-zero exit.
 */
export function checkoutExistingBranch(clonePath: string, branch: string): Promise<GitOutput> {
  return runGit(['checkout', branch], clonePath)
}

/**
 * Check out `at` detached, recording no branch — the `detached` spec path.
 * @param clonePath - absolute root of the clone.
 * @param at - resolved commit to check out.
 * @returns git's raw result; the caller classifies a non-zero exit.
 */
export function checkoutDetached(clonePath: string, at: string): Promise<GitOutput> {
  return runGit(['checkout', '--detach', at], clonePath)
}

/**
 * Fetch `what` — a commit sha, a branch name, or a refspec — from `source` into the clone.
 *
 * Two callers: pulling the `head-with-uncommitted` snapshot commit from the parent, and
 * pulling a merge-check target from the parent or a sibling Thread's clone. Fetching writes
 * only into the clone's own object store and `FETCH_HEAD`.
 * @param clonePath - absolute root of the clone to fetch into.
 * @param source - repository path to fetch from.
 * @param what - the sha, branch, or refspec to fetch.
 * @returns git's raw result; the caller classifies a non-zero exit.
 */
export function fetchIntoClone(clonePath: string, source: string, what: string): Promise<GitOutput> {
  return runGit(['fetch', source, what], clonePath)
}

/**
 * Import `branch` from the clone back into the parent — the archive-time branch import.
 *
 * The force refspec updates the parent's ref even though the clone owned the branch while
 * it lived. Run in the parent; a non-zero exit means the archive contract ("the branch is
 * kept") cannot be honoured and the removal must fail loud.
 * @param repoRoot - absolute top level of the parent repository.
 * @param clonePath - absolute root of the clone that owns the branch.
 * @param branch - branch to import.
 * @returns git's raw result; the caller classifies a non-zero exit.
 */
export function fetchBranchIntoParent(repoRoot: string, clonePath: string, branch: string): Promise<GitOutput> {
  return runGit(['fetch', clonePath, `+refs/heads/${branch}:refs/heads/${branch}`], repoRoot)
}

/**
 * Test whether `path` is the top level of a live git repository.
 *
 * The clone-era liveness test: a directory without a working `.git` is not a live Thread
 * checkout, and git — not the filesystem — decides. `path` must exist; callers test the
 * directory first, so a missing path is classified without spawning git.
 * @param path - absolute directory to test.
 * @returns true when `git rev-parse --show-toplevel` in `path` names `path` itself.
 */
export async function isRepoTopLevel(path: string): Promise<boolean> {
  const output = await runGit(['rev-parse', '--show-toplevel'], path)
  return output.code === 0 && output.stdout.trim() === path
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
 * The commit is a real merge commit whose tree is the working state, so a checkout at that
 * commit materializes exactly what the parent was looking at.
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
