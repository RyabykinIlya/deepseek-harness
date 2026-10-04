/**
 * The worktree SERVICE home (`ctx.worktrees`): the owner of one git worktree per
 * background Thread, and of the durable intent log that makes those worktrees
 * recoverable after a crash.
 *
 * The design rule this package exists to enforce is "fail loud, no silent
 * degradation": a Thread that cannot get its own working tree is REJECTED with a
 * typed {@link WorktreeError}, never handed the parent checkout and told to carry on.
 *
 * Durability is the other half. `create` appends a `reserved` intent record
 * BEFORE spawning `git worktree add`, writes `ready` only after the add
 * succeeded, and undoes a failed or aborted add with `git worktree remove --force`
 * in a `finally`. That ordering is what lets {@link WorktreeService.reconcile}
 * tell "crashed before the add" from "crashed after it" on the next start.
 *
 * The service deliberately does NOT know about sessions: the continuation manager
 * owns session persistence, so {@link WorktreeService.sessionExists} is the seam
 * through which a deployment tells this service which Threads still have one.
 *
 * @module @deepseek-ai/dsh-worktree-manager
 */

import { createHash } from 'node:crypto'
import { mkdirSync, realpathSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { WorktreeError } from './error.ts'
import {
  addWorktree,
  addWorktreeAtExistingBranch,
  branchExists,
  listWorktrees,
  removeWorktree,
  resolveRepoTopLevel,
  runGit,
  runGitBounded,
  stashCreate,
  worktreeStatus,
} from './git.ts'
import { WorktreeRegistry } from './registry.ts'
import type { WorktreeRecordFields } from './registry.ts'
import { ACTIVE_WORKTREE_STATES, TERMINAL_WORKTREE_STATES } from './states.ts'
import type {
  SessionExistsProbe,
  WorktreeBasePolicy,
  WorktreeChanges,
  WorktreeChangesOptions,
  WorktreeFileChange,
  WorktreeMergeCheck,
  WorktreeMergeCheckOptions,
  WorktreeRecord,
  WorktreeRegistryLocking,
  WorktreeRemoveOptions,
  WorktreeSpec,
  WorktreeStatus,
} from './types.ts'

export * from './types.ts'
export * from './states.ts'
export * from './error.ts'
export { resolveRepoTopLevel, runGit } from './git.ts'
export { WorktreeRegistry, REGISTRY_FILE_NAME, REGISTRY_LOCK_NAME, isLegalTransition, isWorktreeState } from './registry.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    worktrees: WorktreeService
  }
}

/** Where `repoRoot` comes from when a spec does not carry one. */
export type RepoRootResolution =
  /** Every {@link WorktreeService.create} call must name its own repository (default). */
  | 'explicit'
  /** An empty `repoRoot` resolves to the checkout the harness process was launched in. */
  | 'parent-cwd'

/**
 * Host configuration for the worktree service. Every field is validated ONCE,
 * at plugin load — never per Thread — following the `validateConfiguredCwd`
 * pattern: a deployment that misconfigures the root fails to mount instead of
 * scattering worktrees and discovering it later.
 */
export interface Config {
  /**
   * Absolute directory holding the intent sidecar and every managed worktree
   * (default `~/.dsh/worktrees`). It must NOT sit inside a registered checkout:
   * a worktree inside the repository pollutes the user's `git status` and
   * recurses on clone.
   */
  worktreeRoot?: string
  /** Where `repoRoot` comes from when a {@link WorktreeSpec} leaves it empty (default `explicit`). */
  repoRootResolution?: RepoRootResolution
  /**
   * What a new Thread's worktree is created from (default `head`).
   *
   * `head` is the committed `HEAD` a caller gets today. `head-with-uncommitted` snapshots the
   * parent's tracked uncommitted changes with `git stash create`, so a Thread started while a
   * coordinator is mid-edit sees the work in progress rather than the last commit — the failure
   * mode where the Thread cannot see an edit the parent never committed, and a later merge
   * conflicts on those exact lines. Untracked files are not part of the snapshot.
   *
   * {@link WorktreeSpec.base} overrides this per call. The default is `head`, not
   * `head-with-uncommitted`: switching it by default would silently move the base of every
   * existing deployment's Threads, and the snapshot also commits the parent's working state onto
   * the Thread branch, which is a policy each deployment should choose on purpose.
   */
  base?: WorktreeBasePolicy
  /** Run {@link WorktreeService.reconcile} when the service loads (default `true`). */
  pruneOnStart?: boolean
  /**
   * Maximum active (non-terminal) worktrees per repository (default `32`). Creation beyond it fails with
   * `WORKTREE_LIMIT_REACHED`; archive a Thread (remove its worktree) to free a slot. Running-Thread
   * concurrency is limited separately by `dsh-subagent`'s `maxActiveSubagents`.
   */
  maxWorktreesPerRepo?: number
  /**
   * Minimum age in milliseconds before {@link WorktreeService.reconcile} treats a worktree without a
   * persisted session as an orphan (default `600000`). It covers the window between worktree creation and
   * session publication. Records without a `createdAt` stamp count as older than any grace period.
   */
  adoptionGraceMs?: number
  /**
   * Longest wait in milliseconds for the registry lock shared by processes using one `worktreeRoot`
   * (default `10000`). Past it the operation fails with `WORKTREE_REGISTRY_LOCKED`.
   */
  lockTimeoutMs?: number
  /** Pause in milliseconds between registry lock attempts (default `50`). */
  lockRetryIntervalMs?: number
  /**
   * Age in milliseconds after which a registry lock whose holder stopped refreshing it (a crashed
   * process) may be taken over (default `30000`, minimum `5000`).
   */
  lockStaleMs?: number
}

/** Default active-worktree limit per repository. */
const DEFAULT_MAX_WORKTREES_PER_REPO = 32

/** Default orphan grace period: ten minutes. */
const DEFAULT_ADOPTION_GRACE_MS = 600_000

/** Default registry lock wait: ten seconds. */
const DEFAULT_LOCK_TIMEOUT_MS = 10_000

/** Default pause between registry lock attempts. */
const DEFAULT_LOCK_RETRY_INTERVAL_MS = 50

/** Default registry lock staleness: thirty seconds. */
const DEFAULT_LOCK_STALE_MS = 30_000

/** Longest sanitized Thread slug kept inside a directory or branch name. */
const MAX_SLUG = 48

/** Thread ids named in a limit error before the list is summarized. */
const MAX_LISTED_THREADS = 50

/** Longest commit subject returned by {@link WorktreeService.changes}. */
const MAX_SUBJECT_CHARS = 200

/** Git's own wording when a refused removal was caused by local changes. */
const DIRTY_WORKTREE_PATTERN = /modified or untracked files|use --force to delete it/i

/** Resolve the nearest existing ancestor of `path` through `realpath`. */
function realPathOfNearestExisting(path: string): string {
  const tail: string[] = []
  // `realpath` succeeds on the filesystem root, and every absolute path reaches
  // it, so the walk always terminates there — there is no "nothing resolved" case
  // to decide, and no path to report back unresolved.
  for (let current = resolve(path);; current = dirname(current)) {
    try {
      return join(realpathSync(current), ...tail)
    } catch {
      tail.unshift(basename(current))
    }
  }
}

/**
 * Test whether `child` is `parent` itself or lives underneath it.
 *
 * Both sides must already be realpath-normalized, otherwise a symlinked root
 * (macOS `/tmp`, `/var`) makes containment invisible.
 */
function contains(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Validate and normalize the configured `worktreeRoot` at load.
 *
 * This turns the design's warning ("a worktree inside the repository pollutes
 * `git status`") into a load-time refusal: a deployment that points the root
 * inside its own checkout gets a loud, actionable error instead of silent litter.
 */
function resolveConfiguredRoot(configured: string | undefined, parentCwd: string): string {
  if (configured !== undefined && configured.trim() === '') {
    throw new Error('worktree-manager: config worktreeRoot must not be empty — omit the key for the ~/.dsh/worktrees default')
  }
  const requested = configured ?? join(homedir(), '.dsh', 'worktrees')
  if (!isAbsolute(requested)) {
    throw new Error(`worktree-manager: config worktreeRoot must be an absolute path, got ${requested}`)
  }
  const root = realPathOfNearestExisting(requested)
  if (contains(parentCwd, root)) {
    throw new Error(
      'worktree-manager: config worktreeRoot must not live inside the registered '
      + `checkout — move it out of ${parentCwd} (got ${root})`,
    )
  }
  return root
}

/**
 * Stable per-repository bucket name, so two checkouts never share a bucket and a
 * restart always lands on the same directory.
 */
function repositoryBucket(repoRoot: string): string {
  return createHash('sha256').update(repoRoot).digest('hex').slice(0, 16)
}

/**
 * Reduce a Thread id to the one slug used for both the worktree directory name and the branch suffix.
 *
 * Thread ids are opaque strings minted elsewhere; anything that is not a valid ref character becomes
 * `-`, so a Thread id can never be shell or ref syntax. An id that sanitization or truncation changed
 * gets an 8-hex hash suffix, so two different ids never share a slug.
 * @param threadId - the Thread key.
 * @returns a non-empty slug of at most 57 characters; an unchanged id of at most 48 safe characters maps to itself.
 */
export function threadSlug(threadId: string): string {
  const slug = threadId.replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^[-.]+|[-.]+$/gu, '').slice(0, MAX_SLUG)
  if (slug === threadId) return slug
  const hash = createHash('sha256').update(threadId).digest('hex').slice(0, 8)
  return `${slug === '' ? 'thread' : slug}-${hash}`
}

/** Default branch for a Thread: `dsh/thread-<slug>`. */
function defaultBranchName(threadId: string): string {
  return `dsh/thread-${threadSlug(threadId)}`
}

/** Characters git forbids in a ref name; the check is deliberately conservative. */
const ILLEGAL_REF_CHARACTERS = /[\x00-\x20~^:?*[\\]|\.\.|@\{|\/$|^\/|^-|\.lock$/

/**
 * The immutable facts of a record, as the sidecar stores them.
 * `exactOptionalPropertyTypes` keeps an absent branch absent rather than `undefined`.
 */
function recordFields(record: WorktreeRecord): WorktreeRecordFields {
  return {
    path: record.path,
    repoRoot: record.repoRoot,
    baseRef: record.baseRef,
    ...record.branch === undefined ? {} : { branch: record.branch },
    ...record.base === undefined ? {} : { base: record.base },
    ...record.baseSha === undefined ? {} : { baseSha: record.baseSha },
  }
}

/**
 * What the locked reservation hands down to {@link resolveBase}: what the Thread's leftover record
 * says about the lineage being restarted, or the empty defaults when there is no such record.
 */
interface RestartFacts {
  /** The Thread's own terminal record still owns `branch`, so the branch is re-checked-out, not created. */
  ownBranch: boolean
  /** Commit that record's lineage was measured from; absent on records written before `baseSha` existed. */
  baseSha: string | undefined
  /** Policy that record's `baseSha` came from; absent on records written before `base` existed. */
  base: WorktreeBasePolicy | undefined
}

/**
 * The commit a new worktree is created at, and the policy that produced it.
 *
 * `head` is the resolved `baseRef` and nothing more — the behaviour this package shipped before
 * the policy existed, so a caller that asks for nothing gets exactly that.
 *
 * `head-with-uncommitted` asks `git stash create` for a commit object holding the parent's tracked
 * uncommitted changes, and the Thread starts from that instead of from `HEAD`. It is `create` and
 * not `push`/`pop` on purpose: `create` only adds object-database entries, so the parent's working
 * tree and index stay exactly as they were and a second agent creating a Thread at the same moment
 * cannot observe or clobber the first one's in-progress edit.
 *
 * Two failure-shaped cases are decided here rather than left to the caller:
 *
 * - nothing tracked is modified → git exits 0 with empty output. That is not an error, it is the
 *   clean-tree case, and the committed base is the whole story.
 * - git fails → the create fails LOUDLY with `WORKTREE_CREATE_FAILED`. Falling back to plain `HEAD`
 *   would hand the Thread a base nobody asked for, and the conflict this policy exists to prevent
 *   would reappear silently, which is the exact degradation this service refuses everywhere else.
 *
 * @param requested - the policy the spec resolved to (`spec.base ?? service.base`).
 * @param restart - what the reservation found about the lineage being restarted.
 * @param refSha - `baseRef` already resolved to a commit.
 * @param repoRoot - repository top level, where the working state is snapshotted.
 * @returns the commit to create the branch at, and the policy the record must carry.
 */
async function resolveBase(
  requested: WorktreeBasePolicy,
  restart: RestartFacts,
  refSha: string,
  repoRoot: string,
): Promise<{ base: WorktreeBasePolicy; baseSha: string }> {
  // A restart re-checks-out the branch the Thread already owns so its earlier commits survive.
  // Snapshotting the parent again here would record a base that is no longer an ancestor of the
  // Thread's own history, and `changes`/`filePatch` would diff that Thread against a commit it has
  // never heard of. The earlier lineage's base — and the policy that produced it — is inherited
  // instead, so a resumed Thread measures its work from where it actually started.
  if (restart.ownBranch && restart.baseSha !== undefined) {
    return { base: restart.base ?? requested, baseSha: restart.baseSha }
  }
  if (requested === 'head') return { base: requested, baseSha: refSha }
  const snapshotted = await stashCreate(repoRoot)
  if (snapshotted.code !== 0) {
    throw new WorktreeError(
      `worktree-manager: git stash create failed while basing a worktree on the uncommitted changes of ${repoRoot}: ${snapshotted.stderr.trim()}`,
      'WORKTREE_CREATE_FAILED',
    )
  }
  const sha = snapshotted.stdout.trim()
  return { base: requested, baseSha: sha === '' ? refSha : sha }
}

/** Reject a count bound that is not a non-negative safe integer. */
function assertBound(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new WorktreeError(`worktree-manager: ${name} must be a non-negative integer, got ${value}`, 'WORKTREE_OPERATION_FAILED')
  }
}

/** Reject a path that is absolute, empty, or leaves the worktree. */
function assertRepoRelativePath(path: string): void {
  const segments = path.split(/[/\\]/u)
  if (path === '' || path.includes('\0') || isAbsolute(path) || /^[A-Za-z]:/u.test(path) || segments.includes('..')) {
    throw new WorktreeError(
      `worktree-manager: path must be a repository-relative path without "..", got ${JSON.stringify(path)}`,
      'WORKTREE_OPERATION_FAILED',
    )
  }
}

/**
 * The worktree service (`ctx.worktrees`).
 *
 * One worktree per Thread, placed under a configured root that survives restarts.
 * The service owns creation, the durable intent log, explicit removal, status, and
 * the startup reconciliation sweep; it owns nothing about sessions, which the
 * continuation manager keeps.
 */
export class WorktreeService extends Service {
  // Inline schema call: the config catalog walks `static Config` statically.
  static Config: z<Config> = z.object({
    // No schema default: `~/.dsh/worktrees` is resolved in the constructor so the
    // stored root is absolute and checkout-guarded however it was supplied.
    worktreeRoot: z.string(),
    repoRootResolution: z.union(['explicit', 'parent-cwd'] as const).default('explicit'),
    base: z.union(['head', 'head-with-uncommitted'] as const).default('head'),
    pruneOnStart: z.boolean().default(true),
    maxWorktreesPerRepo: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_WORKTREES_PER_REPO),
    adoptionGraceMs: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_ADOPTION_GRACE_MS),
    lockTimeoutMs: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_LOCK_TIMEOUT_MS),
    lockRetryIntervalMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_LOCK_RETRY_INTERVAL_MS),
    lockStaleMs: z.number().step(1).min(5000).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_LOCK_STALE_MS),
  })

  /** Absolute, checkout-guarded root holding the sidecar and every managed worktree. */
  readonly worktreeRoot: string
  /** How an empty `spec.repoRoot` is resolved. */
  readonly repoRootResolution: RepoRootResolution
  /** Base policy a spec falls back to when it names none; see {@link Config.base}. */
  readonly base: WorktreeBasePolicy
  /** Whether the startup sweep runs on load. */
  readonly pruneOnStart: boolean
  /** Maximum active worktrees per repository. */
  readonly maxWorktreesPerRepo: number
  /** Orphan grace period in milliseconds. */
  readonly adoptionGraceMs: number
  /** Registry lock settings shared by every process on this root. */
  readonly registryLocking: WorktreeRegistryLocking

  /**
   * The launch checkout, captured at load. `repoRootResolution: 'parent-cwd'`
   * resolves empty specs here, and the `worktreeRoot` guard measures containment
   * against it.
   */
  readonly parentCwd: string

  /**
   * "Does a persisted session still exist for this Thread?".
   *
   * Session persistence belongs to the continuation manager, so this service never
   * guesses: install the predicate (for example against `ctx.sessionPersistence`)
   * and {@link WorktreeService.reconcile} will sweep Threads whose session is gone and whose
   * record is older than `adoptionGraceMs`.
   * Left unset, a record is NEVER called an orphan on session grounds — the sweep
   * then only repairs records whose worktree is missing from disk, which needs no
   * knowledge of sessions at all.
   *
   * It is a mutable property rather than a config field because a function cannot
   * arrive through YAML; assign it right after mounting the service.
   */
  sessionExists: SessionExistsProbe | undefined

  private readonly registry: WorktreeRegistry
  private readonly inFlight = new Map<string, Promise<WorktreeRecord>>()
  /** Tail of the reconcile chain; see {@link WorktreeService.reconcile}. */
  private sweepQueue: Promise<unknown> = Promise.resolve()

  constructor(ctx: Context, config: Config) {
    super(ctx, 'worktrees')
    // schemastery (static Config) already filled the defaulted fields; the casts
    // record that runtime fact for fields whose interface form is optional.
    this.repoRootResolution = config.repoRootResolution ?? 'explicit'
    this.base = config.base ?? 'head'
    this.pruneOnStart = config.pruneOnStart ?? true
    this.maxWorktreesPerRepo = config.maxWorktreesPerRepo ?? DEFAULT_MAX_WORKTREES_PER_REPO
    this.adoptionGraceMs = config.adoptionGraceMs ?? DEFAULT_ADOPTION_GRACE_MS
    this.parentCwd = realPathOfNearestExisting(process.cwd())
    this.worktreeRoot = resolveConfiguredRoot(config.worktreeRoot, this.parentCwd)
    this.registryLocking = {
      timeoutMs: config.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
      retryIntervalMs: config.lockRetryIntervalMs ?? DEFAULT_LOCK_RETRY_INTERVAL_MS,
      staleMs: config.lockStaleMs ?? DEFAULT_LOCK_STALE_MS,
    }
    this.registry = new WorktreeRegistry(this.worktreeRoot, this.registryLocking)

    if (this.pruneOnStart) {
      // An async cordis effect: the fiber awaits it during start, so the sweep has
      // finished before any Thread can ask for a worktree. Failures propagate —
      // a broken git environment must surface at load, not at the first Thread.
      // Worktrees outlive the service, so there is nothing to tear down.
      ctx.effect(async () => {
        await this.reconcile()
        return () => {}
      }, 'worktrees.pruneOnStart')
    }
  }

  /**
   * Create (or re-attach to) the worktree for one Thread.
   *
   * The call is idempotent by `threadId`: a second `create` for a Thread whose
   * worktree still exists returns the SAME record without a second `git worktree
   * add`. An abort is honored at every boundary — before any git process is
   * spawned, and again after the add resolves — and either way the reserved
   * intent is rolled back with `git worktree remove --force`.
   * Each call first runs {@link WorktreeService.reconcile}, so abandoned worktrees do not hold limit slots.
   * The commit the Thread starts from is chosen by the base policy — `spec.base`, else the configured
   * `base` — and `head-with-uncommitted` snapshots the parent's tracked uncommitted changes with
   * `git stash create`, which leaves the parent's working tree untouched.
   * @param spec - the repository, Thread, base ref and policy, and optional branch.
   * @param signal - aborts the attempt; the worktree is rolled back, never left half-created.
   * @returns the `ready` record whose `path` may be used as a session cwd.
   */
  create(spec: WorktreeSpec, signal: AbortSignal): Promise<WorktreeRecord> {
    // Concurrent creates for one Thread share a single attempt: two parallel
    // `git worktree add` calls would race for the same path and the loser would
    // leave a stray registration behind.
    const running = this.inFlight.get(spec.threadId)
    if (running !== undefined) return running
    const attempt = this.createWorktree(spec, signal)
      .finally(() => { this.inFlight.delete(spec.threadId) })
    this.inFlight.set(spec.threadId, attempt)
    return attempt
  }

  /**
   * Remove a Thread's worktree.
   *
   * Removal is explicit and never automatic: a settled Thread's worktree holds its
   * result, and deleting a turn's output silently is not acceptable. The order is
   * NOT the mirror of creation — the durable record goes to `removing` first, then
   * git, then `removed` — so a failed git removal leaves a `removing` tombstone a
   * later prune can finish, instead of claiming a deletion that never happened.
   * @param record - the record to remove (may come from an earlier session).
   * @param opts - `force` discards local modifications; without it a dirty worktree is refused.
   */
  async remove(record: WorktreeRecord, opts: WorktreeRemoveOptions = {}): Promise<void> {
    const registry = await this.loadRegistry()
    const current = registry.find(record.threadId)
    if (current === undefined) {
      throw new WorktreeError(`worktree-manager: no worktree record for thread ${record.threadId}`, 'WORKTREE_NOT_FOUND')
    }
    if (TERMINAL_WORKTREE_STATES.includes(current.state)) return
    const fields = recordFields(current)
    // A `reserved` record never reached `ready`; there is nothing to "remove", only
    // a reservation to roll back.
    const terminal: 'removed' | 'rolled-back' = current.state === 'reserved' ? 'rolled-back' : 'removed'
    if (current.state === 'ready' || current.state === 'orphaned') {
      await registry.transition(record.threadId, 'removing', fields)
    }
    await this.runRemoval(current, fields, terminal, opts.force === true)
  }

  /**
   * List the active worktrees of one repository.
   * @param repoRoot - any path inside the repository.
   * @returns records in a live state, ordered by `threadId`; terminal records are history, not worktrees.
   */
  async list(repoRoot: string): Promise<WorktreeRecord[]> {
    const registry = await this.loadRegistry()
    const topLevel = await this.requireRepoTopLevel(repoRoot)
    return registry.all()
      .filter(record => record.repoRoot === topLevel && ACTIVE_WORKTREE_STATES.includes(record.state))
  }

  /**
   * Latest record of a Thread in any state.
   * @param threadId - the Thread key.
   * @returns the folded record (terminal states included), or `undefined` when the Thread never had one.
   */
  async get(threadId: string): Promise<WorktreeRecord | undefined> {
    return (await this.loadRegistry()).find(threadId)
  }

  /**
   * Report whether a worktree is clean and how far it is ahead of its base.
   *
   * A record whose path is gone throws `WORKTREE_NOT_FOUND`. It NEVER reports
   * `clean: true` for a missing directory: "nothing to report" and "nothing
   * wrong" are different facts, and conflating them would let a crashed Thread
   * look finished.
   * @param record - the worktree to inspect.
   * @returns `{ clean, changed, commitsAhead }` from `git status --porcelain` and `git rev-list --count`.
   */
  async status(record: WorktreeRecord): Promise<WorktreeStatus> {
    await this.requireLiveWorktree(record)
    const changed = await this.countUncommitted(record)
    const commitsAhead = await this.countCommits(record, baseOf(record))
    return { clean: changed === 0, changed, commitsAhead }
  }

  /**
   * Summarize the work a Thread did: commits and files since its base plus the uncommitted count.
   *
   * Every list is bounded by the caller's limits; totals count what was not listed. Same
   * `WORKTREE_NOT_FOUND` rule as {@link WorktreeService.status}.
   * @param record - the worktree to inspect.
   * @param opts - non-negative integer `maxCommits` and `maxFiles`.
   * @returns the {@link WorktreeChanges} of `baseSha..HEAD`.
   */
  async changes(record: WorktreeRecord, opts: WorktreeChangesOptions): Promise<WorktreeChanges> {
    assertBound('maxCommits', opts.maxCommits)
    assertBound('maxFiles', opts.maxFiles)
    await this.requireLiveWorktree(record)
    const base = baseOf(record)
    const baseSha = await this.revParse(record, base)
    const headSha = await this.revParse(record, 'HEAD')
    const range = `${baseSha}..HEAD`
    const commitsTotal = await this.countCommits(record, baseSha)
    const commits: { sha: string; subject: string }[] = []
    if (opts.maxCommits > 0 && commitsTotal > 0) {
      // Records start with U+001E and split sha from subject at U+001F, so no subject text can shift a field.
      const log = await runGit(['log', '--no-color', `--max-count=${opts.maxCommits}`, '--format=%x1e%H%x1f%s', range], record.path)
      this.requireOk(log, record, 'git log')
      for (const chunk of log.stdout.split('\x1e')) {
        const split = chunk.indexOf('\x1f')
        if (split < 0) continue
        commits.push({ sha: chunk.slice(0, split), subject: chunk.slice(split + 1).replace(/\n+$/u, '').slice(0, MAX_SUBJECT_CHARS) })
      }
    }
    const numstat = await runGit(['diff', '--numstat', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', range], record.path)
    this.requireOk(numstat, record, 'git diff --numstat')
    const files: WorktreeFileChange[] = []
    let filesTotal = 0
    for (const entry of numstat.stdout.split('\0')) {
      if (entry === '') continue
      const [added = '', removed = '', ...pathParts] = entry.split('\t')
      filesTotal++
      if (files.length >= opts.maxFiles) continue
      const path = pathParts.join('\t')
      files.push(added === '-' && removed === '-'
        ? { path, binary: true }
        : { path, added: Number(added), removed: Number(removed) })
    }
    const uncommitted = await this.countUncommitted(record)
    return { baseSha, headSha, commits, commitsTotal, files, filesTotal, uncommitted }
  }

  /**
   * Predict whether merging the worktree's HEAD into `target` would conflict.
   *
   * `target` is resolved in the main checkout (`repoRoot`), so `HEAD` names the
   * main checkout's current commit and a branch name may be another Thread's branch.
   * Uncommitted edits in either checkout are not part of the prediction. No ref,
   * index, or working tree changes. Same `WORKTREE_NOT_FOUND` rule as {@link WorktreeService.status}.
   * @param record - the worktree whose HEAD would be merged.
   * @param options - the target ref.
   * @param maxConflicts - non-negative bound on the listed conflicting paths.
   * @returns the predicted result, or `{ supported: false }` when git lacks `merge-tree --write-tree`.
   */
  async mergeCheck(record: WorktreeRecord, options: WorktreeMergeCheckOptions, maxConflicts: number): Promise<WorktreeMergeCheck> {
    assertBound('maxConflicts', maxConflicts)
    await this.requireLiveWorktree(record)
    const target = await runGit(['rev-parse', '--verify', `${options.target}^{commit}`], record.repoRoot)
    this.requireOk(target, record, `git rev-parse ${options.target}`)
    const targetSha = target.stdout.trim()
    const headSha = await this.revParse(record, 'HEAD')
    const merge = await runGit(['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', targetSha, headSha], record.path)
    // Exit 0 is a clean merge and 1 a conflicted one; git before 2.38 rejects
    // `--write-tree` as a usage error (129).
    if (merge.code === 129) return { supported: false }
    if (merge.code !== 0 && merge.code !== 1) this.requireOk(merge, record, 'git merge-tree')
    // With -z the output is the tree id, then one NUL-terminated entry per conflicting path.
    const [, ...paths] = merge.stdout.split('\0').filter(entry => entry !== '')
    const conflicts = [...new Set(paths)]
    return {
      supported: true,
      targetSha,
      headSha,
      clean: merge.code === 0,
      conflicts: conflicts.slice(0, maxConflicts),
      conflictsTotal: conflicts.length,
    }
  }

  /**
   * Committed diff `baseSha..HEAD` of one file, cut at a byte bound.
   *
   * Uncommitted edits are not included. The cut never splits a multibyte character, so the returned
   * patch may be shorter than `maxBytes`; git is stopped as soon as the bound is exceeded.
   * @param record - the worktree to inspect.
   * @param path - repository-relative path; absolute paths and `..` segments are rejected.
   * @param maxBytes - non-negative byte bound of the returned patch.
   * @returns the patch text and whether it was truncated.
   */
  async filePatch(record: WorktreeRecord, path: string, maxBytes: number): Promise<{ patch: string; truncated: boolean }> {
    assertBound('maxBytes', maxBytes)
    assertRepoRelativePath(path)
    await this.requireLiveWorktree(record)
    const baseSha = await this.revParse(record, baseOf(record))
    const output = await runGitBounded(
      ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', `${baseSha}..HEAD`, '--', `:(literal)${path}`],
      record.path,
      maxBytes,
    )
    this.requireOk(output, record, 'git diff')
    return { patch: output.stdout, truncated: output.truncated }
  }

  /** Throw `WORKTREE_NOT_FOUND` unless the record's path is a registered git worktree on disk. */
  private async requireLiveWorktree(record: WorktreeRecord): Promise<void> {
    if (!await isDirectory(record.path)) {
      throw new WorktreeError(
        `worktree-manager: worktree for thread ${record.threadId} is gone: ${record.path}`,
        'WORKTREE_NOT_FOUND',
      )
    }
    // Git, not the filesystem, decides what a worktree is: a directory left behind
    // by a crashed `worktree remove` is still on disk but is no longer registered.
    if (!(await this.registeredWorktrees(record.repoRoot)).has(record.path)) {
      throw new WorktreeError(
        `worktree-manager: worktree path for thread ${record.threadId} is not a registered git worktree: ${record.path}`,
        'WORKTREE_NOT_FOUND',
      )
    }
  }

  /** Throw `WORKTREE_OPERATION_FAILED` for a non-zero git result. */
  private requireOk(output: { code: number; stderr: string }, record: WorktreeRecord, what: string): void {
    if (output.code !== 0) {
      throw new WorktreeError(
        `worktree-manager: ${what} failed in ${record.path}: ${output.stderr.trim()}`,
        'WORKTREE_OPERATION_FAILED',
      )
    }
  }

  private async countUncommitted(record: WorktreeRecord): Promise<number> {
    const output = await worktreeStatus(record.path)
    this.requireOk(output, record, 'git status')
    return output.stdout.split('\n').filter(line => line.trim() !== '').length
  }

  private async countCommits(record: WorktreeRecord, base: string): Promise<number> {
    const output = await runGit(['rev-list', '--count', `${base}..HEAD`], record.path)
    this.requireOk(output, record, 'git rev-list')
    return Number(output.stdout.trim())
  }

  private async revParse(record: WorktreeRecord, rev: string): Promise<string> {
    const output = await runGit(['rev-parse', '--verify', `${rev}^{commit}`], record.path)
    this.requireOk(output, record, `git rev-parse ${rev}`)
    return output.stdout.trim()
  }

  /**
   * Sweep records that no longer describe a live Thread.
   *
   * Two independent rules, both of which only ever REMOVE worktrees that git
   * already owns:
   * 1. a `reserved`/`ready` record whose path is missing from disk — a crash
   *    between the intent write and the add;
   * 2. a `reserved`/`ready` record whose Thread has no persisted session, judged
   *    by {@link WorktreeService.sessionExists} (skipped when no probe is installed,
   *    because session existence is not this service's knowledge) and whose record
   *    is older than `adoptionGraceMs`.
   *
   * In-flight creations of this process are never swept. Each orphan is marked
   * `orphaned`, removed with `git worktree remove --force`, and settled to
   * `removed` (or `rolled-back` when nothing was ever on disk).
   * @returns the records classified as orphans, in their `orphaned` state.
   */
  async reconcile(): Promise<WorktreeRecord[]> {
    // Sweeps are serialized. The startup sweep and an explicit call can overlap in
    // production, and two sweeps reading the same fold would race each other's
    // transitions (one of them sees `removing` where it expected `ready`). The
    // queue below is the `.catch()` of the previous run, so it never rejects and
    // the sweep always runs on the settled queue.
    const run = this.sweepQueue.then(() => this.sweep())
    this.sweepQueue = run.catch(() => {})
    return run
  }

  /** The sweep body; {@link WorktreeService.reconcile} serializes calls onto it. */
  private async sweep(): Promise<WorktreeRecord[]> {
    const registry = await this.loadRegistry()
    const orphans: WorktreeRecord[] = []
    for (const record of registry.all()) {
      if (record.state !== 'reserved' && record.state !== 'ready') continue
      if (this.inFlight.has(record.threadId)) continue
      // A young `reserved` record may belong to an add still running in another process.
      if (record.state === 'reserved' && Date.now() - (record.createdAt ?? 0) < this.adoptionGraceMs) continue
      const fields = recordFields(record)
      // "Live" means git still registers this path AND the directory is there. A
      // crash between the add and its bookkeeping, or between a removal and its
      // bookkeeping, shows up on either side of that pair.
      const live = (await this.registeredWorktrees(record.repoRoot)).has(record.path)
        && await isDirectory(record.path)
      // Rule 2 needs the probe; rule 1 does not. Asking is safe either way, so the
      // probe runs whenever one is installed and its answer is what decides a
      // worktree that IS still live.
      const sessionAlive = this.sessionExists === undefined
        ? undefined
        : await this.sessionExists(record.threadId)
      // A worktree git still owns, whose Thread still has a session, is not an orphan.
      const keepLive = live && sessionAlive !== false
      if (keepLive) continue
      // A session that is not there yet may still be on its way: the creator publishes it after the worktree.
      if (live && Date.now() - (record.createdAt ?? 0) < this.adoptionGraceMs) continue
      const orphaned = await registry.transition(record.threadId, 'orphaned', fields)
      orphans.push(orphaned)
      if (!live) {
        await registry.transition(record.threadId, 'rolled-back', fields)
        continue
      }
      await registry.transition(record.threadId, 'removing', fields)
      await this.runRemoval(record, fields, 'removed', true)
    }
    return orphans
  }

  /** Fold the lines other processes appended since the last read; every operation goes through this gate. */
  private async loadRegistry(): Promise<WorktreeRegistry> {
    return this.registry.refresh()
  }

  /**
   * Paths git itself currently registers as worktrees of a repository.
   *
   * Read through `git worktree list --porcelain` rather than inferred from the
   * filesystem: a directory surviving a crashed removal is not a worktree, and
   * treating it as one is exactly the silent degradation this package forbids.
   */
  private async registeredWorktrees(repoRoot: string): Promise<ReadonlySet<string>> {
    const entries = await listWorktrees(repoRoot)
    return new Set(entries.map(entry => entry.path))
  }

  /**
   * Resolve and validate the repository root a spec names.
   *
   * The value is normalized to the enclosing repository's top level, so a spec may
   * point at any directory inside the checkout. A path that is not inside a work
   * tree is `NOT_A_GIT_REPO` — loud, so the Thread is refused instead of running
   * unisolated.
   */
  private async requireRepoTopLevel(repoRoot: string): Promise<string> {
    const requested = repoRoot.trim()
    if (requested === '') {
      if (this.repoRootResolution !== 'parent-cwd') {
        throw new WorktreeError(
          'worktree-manager: repoRootResolution is "explicit", so every create must name its repository',
          'NOT_A_GIT_REPO',
        )
      }
      return this.parentCwd
    }
    if (!isAbsolute(requested)) {
      throw new WorktreeError(`worktree-manager: repoRoot must be an absolute path, got ${requested}`, 'NOT_A_GIT_REPO')
    }
    const topLevel = await resolveRepoTopLevel(requested)
    if (topLevel === undefined) {
      throw new WorktreeError(`worktree-manager: not a git work tree: ${requested}`, 'NOT_A_GIT_REPO')
    }
    return topLevel
  }

  /** The real implementation behind {@link WorktreeService.create}, one attempt per Thread. */
  private async createWorktree(spec: WorktreeSpec, signal: AbortSignal): Promise<WorktreeRecord> {
    // Abort wins before anything observable happens: no sidecar line, no git process.
    signal.throwIfAborted()
    const registry = await this.loadRegistry()
    const repoRoot = await this.requireRepoTopLevel(spec.repoRoot)
    // Free slots held by abandoned worktrees (no session after the grace period) before counting the limit.
    await this.reconcile()
    const branch = spec.branch ?? defaultBranchName(spec.threadId)
    if (ILLEGAL_REF_CHARACTERS.test(branch)) {
      throw new WorktreeError(`worktree-manager: unusable branch name ${JSON.stringify(branch)}`, 'WORKTREE_CREATE_FAILED')
    }
    if (/[/\\]/.test(spec.threadId) || spec.threadId === '.' || spec.threadId === '..') {
      throw new WorktreeError(
        `worktree-manager: threadId must be a single path segment, got ${JSON.stringify(spec.threadId)}`,
        'WORKTREE_CREATE_FAILED',
      )
    }

    const bucket = join(this.worktreeRoot, repositoryBucket(repoRoot))
    const path = join(bucket, threadSlug(spec.threadId))
    // Resolved once, here, so the `reserved` intent line already states the policy this attempt
    // will follow — a crash mid-create then leaves a record that says what was being attempted.
    const base: WorktreeBasePolicy = spec.base ?? this.base
    const fields: WorktreeRecordFields = { path, repoRoot, baseRef: spec.baseRef, branch, base }
    /** Facts the lock-held check hands to the add below. */
    const restart: RestartFacts = { ownBranch: false, baseSha: undefined, base: undefined }
    // The checks and the `reserved` append share one registry lock, so processes sharing the root
    // cannot both pass the limit, path, or branch check.
    const { record: reserved, created } = await registry.reserve(spec.threadId, fields, async (transaction) => {
      const existing = transaction.find(spec.threadId)
      if (existing !== undefined && !TERMINAL_WORKTREE_STATES.includes(existing.state)) {
        // A `reserved` record younger than the grace period may be another process's add in progress.
        if (existing.state === 'reserved' && Date.now() - (existing.createdAt ?? 0) < this.adoptionGraceMs) {
          throw new WorktreeError(
            `worktree-manager: worktree for thread ${spec.threadId} is being created by another process: ${existing.path}`,
            'WORKTREE_PATH_IN_USE',
          )
        }
        if (await isDirectory(existing.path)) return existing
        // A durable record claims a worktree that is not there. Silently re-adding
        // would discard the evidence that something was lost, so classify it and
        // let reconcile()/the operator deal with it.
        await transaction.transition(spec.threadId, 'orphaned', recordFields(existing))
        throw new WorktreeError(
          `worktree-manager: durable record for thread ${spec.threadId} has no worktree on disk: ${existing.path}`,
          'WORKTREE_ORPHANED',
        )
      }
      const active = transaction.all()
        .filter(record => record.repoRoot === repoRoot && ACTIVE_WORKTREE_STATES.includes(record.state))
      if (active.length >= this.maxWorktreesPerRepo) {
        const listed = active.slice(0, MAX_LISTED_THREADS).map(record => record.threadId).join(', ')
        const more = active.length > MAX_LISTED_THREADS ? ` and ${active.length - MAX_LISTED_THREADS} more` : ''
        throw new WorktreeError(
          `worktree-manager: worktree limit reached for ${repoRoot} (${active.length}/${this.maxWorktreesPerRepo}); `
          + `archive one of these Threads first: ${listed}${more}`,
          'WORKTREE_LIMIT_REACHED',
        )
      }
      if (await isDirectory(path) || await pathExists(path)) {
        throw new WorktreeError(`worktree-manager: worktree path already in use: ${path}`, 'WORKTREE_PATH_IN_USE')
      }
      // A restart of the SAME Thread reuses the branch it owned before. Removal
      // deliberately keeps the branch (design §2: "what to delete on close" is keyed
      // on `(threadId, path)`, not on the branch), so without this exemption a
      // re-created Thread would be refused by its own leftover branch. Any OTHER
      // pre-existing branch — another Thread's, or a human's — is still refused.
      restart.ownBranch = existing !== undefined
        && TERMINAL_WORKTREE_STATES.includes(existing.state)
        && existing.branch === branch
      restart.baseSha = existing?.baseSha
      restart.base = existing?.base
      const claimed = active.some(record => record.branch === branch)
      if (claimed || !restart.ownBranch && await branchExists(repoRoot, branch)) {
        throw new WorktreeError(`worktree-manager: branch already exists: ${branch}`, 'WORKTREE_BRANCH_EXISTS')
      }
      signal.throwIfAborted()
      return undefined
    })
    if (!created) return reserved
    // The `reserved` intent is durable BEFORE the side effect. A crash after it
    // is what reconcile() repairs; a crash before it means git was never invoked.
    mkdirSync(bucket, { recursive: true })
    let committed = false
    try {
      // A restart checks out the branch this Thread already owns, so its earlier
      // commits survive; a first attempt creates the branch at `baseRef`.
      const resolved = await runGit(['rev-parse', '--verify', `${spec.baseRef}^{commit}`], repoRoot)
      if (resolved.code !== 0) {
        throw new WorktreeError(
          `worktree-manager: base ref ${JSON.stringify(spec.baseRef)} does not name a commit in ${repoRoot}: ${resolved.stderr.trim()}`,
          'WORKTREE_CREATE_FAILED',
        )
      }
      // The policy decides the commit; a restart keeps the base its earlier lineage was
      // measured from rather than re-snapshotting the parent (see `resolveBase`).
      const effective = await resolveBase(base, restart, resolved.stdout.trim(), repoRoot)
      const added = restart.ownBranch
        ? await addWorktreeAtExistingBranch(repoRoot, path, branch)
        : await addWorktree(repoRoot, path, branch, effective.baseSha)
      if (added.code !== 0) throw classifyAddFailure(added.stderr, added.stdout, path, branch)
      // Checked while the record is still `reserved`, so an abort here rolls back
      // through the single legal `reserved → rolled-back` edge.
      signal.throwIfAborted()
      // The EFFECTIVE policy, not the requested one: a restart that inherited an earlier
      // lineage's base records the policy that produced it, so the line never claims
      // a snapshot was taken when none was.
      const ready = await registry.transition(spec.threadId, 'ready', {
        ...fields,
        base: effective.base,
        baseSha: effective.baseSha,
      })
      committed = true
      return ready
    } finally {
      if (!committed) await this.rollback(spec.threadId, fields, registry)
    }
  }

  /**
   * Undo a failed or aborted add: `git worktree remove --force`, then `rolled-back`.
   *
   * Best effort by design. The add may never have created anything, in which case
   * git's "not a working tree" complaint is the expected answer and must not mask
   * the original failure. The `rolled-back` line is always written, so the
   * reservation can never be mistaken for a live worktree.
   */
  private async rollback(
    threadId: string,
    fields: WorktreeRecordFields,
    registry: WorktreeRegistry,
  ): Promise<void> {
    if (await isDirectory(fields.path)) {
      await removeWorktree(fields.repoRoot, fields.path, true)
    }
    await registry.transition(threadId, 'rolled-back', fields)
  }

  /**
   * Run `git worktree remove` and settle the record, leaving a `removing`
   * tombstone behind when git refuses (design §5).
   */
  private async runRemoval(
    record: WorktreeRecord,
    fields: WorktreeRecordFields,
    terminal: 'removed' | 'rolled-back',
    force: boolean,
  ): Promise<void> {
    const registry = await this.loadRegistry()
    const removed = await removeWorktree(record.repoRoot, record.path, force)
    if (removed.code !== 0) {
      if (!force && DIRTY_WORKTREE_PATTERN.test(removed.stderr)) {
        throw new WorktreeError(
          `worktree-manager: worktree for thread ${record.threadId} has unsaved changes: ${removed.stderr.trim()}`,
          'REMOVE_DIRTY_WITHOUT_FORCE',
        )
      }
      throw new WorktreeError(
        `worktree-manager: git worktree remove failed for ${record.path}: ${removed.stderr.trim()}`,
        'WORKTREE_OPERATION_FAILED',
      )
    }
    await registry.transition(record.threadId, terminal, fields)
  }
}

/** The ref a record's commits are counted from: its recorded commit, else the ref it was created from. */
function baseOf(record: WorktreeRecord): string {
  return record.baseSha ?? record.baseRef
}

/** Whether `path` currently exists as a directory. */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/** Whether `path` exists at all (file, directory, or link). */
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Map a failing `git worktree add` onto the typed taxonomy.
 *
 * Git's wording is the only signal available, so the patterns are narrow and the
 * fallthrough is deliberately the generic `WORKTREE_CREATE_FAILED` — an
 * unclassified failure still fails loud, it just does not claim a more specific cause.
 */
function classifyAddFailure(stderr: string, stdout: string, path: string, branch: string): WorktreeError {
  const detail = `${stderr}\n${stdout}`.trim()
  if (/not a git repository/i.test(detail)) {
    return new WorktreeError(`worktree-manager: not a git work tree while adding ${path}`, 'NOT_A_GIT_REPO')
  }
  if (new RegExp(`branch .*${escapeRegExp(branch)}.*already exists`, 'i').test(detail)
    || /already exists/i.test(detail) && detail.includes(branch)) {
    return new WorktreeError(`worktree-manager: branch already exists: ${branch}`, 'WORKTREE_BRANCH_EXISTS')
  }
  if (detail.includes(path) || /already (?:registered|used by worktree)|already exists/i.test(detail)) {
    return new WorktreeError(`worktree-manager: worktree path already in use: ${path}`, 'WORKTREE_PATH_IN_USE')
  }
  return new WorktreeError(`worktree-manager: git worktree add failed for ${path}: ${detail}`, 'WORKTREE_CREATE_FAILED')
}

/** Escape a literal string for use inside a `RegExp`. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

export default WorktreeService
