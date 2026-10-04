/**
 * The Thread tools: `thread_status` lists a Project's background Threads,
 * `thread_diff` shows what one Thread committed, and `library_list` lists the
 * Project's Library.
 *
 * `thread_status` and `thread_diff` read only the calling Project Session's own
 * `threads` projection, report liveness from the runtime, and bound the complete
 * rendered result in bytes. `library_list` reads the calling Project Session's
 * own Library read model instead and bounds its result the same way.
 * @module @deepseek-ai/dsh-experimental-threads-tool
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ThreadStatusRow } from '@deepseek-ai/dsh-experimental-threads'
import type {} from '@deepseek-ai/dsh-experimental-threads'
import type {} from '@deepseek-ai/dsh-worktree-manager'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { fitPatch, fitSummary, renderDiff } from './diff.ts'
import type { ThreadDiffResult } from './diff.ts'
import { fitLibrary, LIBRARY_SECTIONS, renderLibrary, toLibraryListResult } from './library.ts'
import type { LibraryListResult, LibrarySection } from './library.ts'
import { collectOverview, fitOverview, renderOverview } from './overview.ts'
import type { ThreadOverviewResult } from './overview.ts'
import { registerThreadTier } from './tier.ts'
import { fitStatus, renderStatus, THREAD_STATES, toEntry } from './status.ts'
import type { ThreadState, ThreadStatusEntry, ThreadStatusResult } from './status.ts'

export type {
  LibraryListResult, LibrarySection, ThreadDiffResult, ThreadOverviewResult,
  ThreadState, ThreadStatusEntry, ThreadStatusResult,
}

/** Cordis plugin name. */
export const name = 'tool-threads'

/**
 * Services required before the tools are registered.
 *
 * `ctx.threads` and `ctx.worktrees` are resolved at execution time so a
 * composition without them still shows the tools and the model learns which
 * capability is missing.
 */
export const inject = ['tools']

/** Hard ceilings and floors; no configuration can widen them. */
const LIMITS = {
  limit: { max: 100 },
  resultBytes: { min: 1024, max: 32768 },
  commits: { max: 100 },
  files: { max: 500 },
  patchBytes: { min: 256, max: 65536 },
  overviewThreads: { max: 100 },
  pairChecks: { max: 200 },
  libraryLimit: { max: 100 },
} as const

/** Configuration: what one call may spend. */
export interface Config {
  /** `thread_status` rows when the model omits `limit` (default 20). */
  readonly defaultLimit?: number
  /** Largest `limit` the model may request (default 100, ceiling 100). */
  readonly maxLimit?: number
  /** Byte bound over the complete rendered result of either tool (default 8192, 1024 through 32768). */
  readonly maxResultBytes?: number
  /** Commits `thread_diff` lists (default 30, ceiling 100). */
  readonly maxCommits?: number
  /** Changed files `thread_diff` lists (default 100, ceiling 500). */
  readonly maxFiles?: number
  /** Bytes of one file patch `thread_diff` returns (default 16384, 256 through 65536). */
  readonly maxPatchBytes?: number
  /** Threads the `thread_diff` overview reads (default 20, ceiling 100); each costs git calls. */
  readonly maxOverviewThreads?: number
  /** Overlapping Thread pairs the overview runs a merge check on (default 50, ceiling 200). */
  readonly maxPairChecks?: number
  /** `library_list` entries per shown section when the model omits `limit` (default 20). */
  readonly libraryDefaultLimit?: number
  /** Largest per-section `limit` the model may request from `library_list` (default 100, ceiling 100). */
  readonly libraryMaxLimit?: number
}

/** Loader schema for the Threads tools plugin. */
export const Config: z<Config> = z.object({
  defaultLimit: z.natural().max(LIMITS.limit.max).default(20),
  maxLimit: z.natural().max(LIMITS.limit.max).default(LIMITS.limit.max),
  maxResultBytes: z.natural().min(LIMITS.resultBytes.min).max(LIMITS.resultBytes.max).default(8192),
  maxCommits: z.natural().max(LIMITS.commits.max).default(30),
  maxFiles: z.natural().max(LIMITS.files.max).default(100),
  maxPatchBytes: z.natural().min(LIMITS.patchBytes.min).max(LIMITS.patchBytes.max).default(16384),
  maxOverviewThreads: z.natural().max(LIMITS.overviewThreads.max).default(20),
  maxPairChecks: z.natural().max(LIMITS.pairChecks.max).default(50),
  libraryDefaultLimit: z.natural().max(LIMITS.libraryLimit.max).default(20),
  libraryMaxLimit: z.natural().max(LIMITS.libraryLimit.max).default(LIMITS.libraryLimit.max),
})

/** Configuration with defaults applied and ceilings enforced. */
interface Bounds {
  readonly defaultLimit: number
  readonly maxLimit: number
  readonly maxResultBytes: number
  readonly maxCommits: number
  readonly maxFiles: number
  readonly maxPatchBytes: number
  readonly maxOverviewThreads: number
  readonly maxPairChecks: number
  readonly libraryDefaultLimit: number
  readonly libraryMaxLimit: number
}

/** Clamp a possibly-missing configured value into its range. */
function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  return Math.min(Math.max(value ?? fallback, min), max)
}

/**
 * Apply defaults and ceilings; a direct `apply()` bypasses Schemastery.
 * @param config - raw configuration.
 * @returns the effective bounds.
 */
function resolveBounds(config: Config): Bounds {
  return {
    defaultLimit: clamp(config.defaultLimit, 20, 1, LIMITS.limit.max),
    maxLimit: clamp(config.maxLimit, LIMITS.limit.max, 1, LIMITS.limit.max),
    maxResultBytes: clamp(config.maxResultBytes, 8192, LIMITS.resultBytes.min, LIMITS.resultBytes.max),
    maxCommits: clamp(config.maxCommits, 30, 1, LIMITS.commits.max),
    maxFiles: clamp(config.maxFiles, 100, 1, LIMITS.files.max),
    maxPatchBytes: clamp(config.maxPatchBytes, 16384, LIMITS.patchBytes.min, LIMITS.patchBytes.max),
    maxOverviewThreads: clamp(config.maxOverviewThreads, 20, 1, LIMITS.overviewThreads.max),
    maxPairChecks: clamp(config.maxPairChecks, 50, 1, LIMITS.pairChecks.max),
    libraryDefaultLimit: clamp(config.libraryDefaultLimit, 20, 1, LIMITS.libraryLimit.max),
    libraryMaxLimit: clamp(config.libraryMaxLimit, LIMITS.libraryLimit.max, 1, LIMITS.libraryLimit.max),
  }
}

/**
 * Read the calling Project Session's Threads.
 *
 * Unavailability is an error: an empty list would claim the Project owns no
 * Threads.
 * @param ctx - context whose `threads` service is read.
 * @param tool - tool name for the message.
 * @param session - the calling Project Session.
 * @returns the durable Thread rows and the service that reports their liveness.
 */
function readCallerThreads(
  ctx: Context,
  tool: string,
  session: Session,
): { readonly rows: ThreadStatusRow[]; readonly service: Context['threads'] } {
  const threads = ctx.get('threads')
  if (threads === undefined) {
    throw new Error(`${tool} cannot read Threads: @deepseek-ai/dsh-experimental-threads is not loaded`)
  }
  if (!threads.available) {
    throw new Error(`${tool} cannot read Threads: the \`threads\` Session projection is unavailable `
      + '(it requires @deepseek-ai/dsh-session-projection)')
  }
  return { rows: threads.viewOf(session), service: threads }
}

/**
 * Resolve the Threads service for `library_list`.
 *
 * Unlike {@link readCallerThreads}, the Library read model derives directly
 * from Session logs and worktrees rather than the `threads` projection, so its
 * availability is never checked here.
 * @param ctx - context whose `threads` service is read.
 * @param tool - tool name for the message.
 * @returns the Threads service.
 */
function requireThreadsForLibrary(ctx: Context, tool: string): Context['threads'] {
  const threads = ctx.get('threads')
  if (threads === undefined) {
    throw new Error(`${tool} cannot read the Library: @deepseek-ai/dsh-experimental-threads is not loaded`)
  }
  return threads
}

/** Reject a path the worktree could resolve outside the repository. */
function assertRepoRelative(path: string): void {
  const segments = path.split(/[\\/]/)
  if (path === '' || path.startsWith('/') || path.startsWith('-') || path.includes('\0') || /^[A-Za-z]:/.test(path)
    || segments.includes('..')) {
    throw new Error('path must be a repo-relative file path (no leading / or -, no .. segments); '
      + 'copy it from the committed files list of thread_diff')
  }
}

/** Per-state worktree failure message for a record that cannot be read. */
function unusableWorktree(threadId: string, state: string, branch: string | undefined): string {
  const keep = branch === undefined ? '' : ` Its commits may still be on branch ${branch}: inspect with git log ${branch} in the Project checkout.`
  if (state === 'removed' || state === 'rolled-back') {
    return `the worktree of thread ${threadId} was archived (${state}), so its changes cannot be read here.${keep}`
  }
  return `the worktree of thread ${threadId} is not readable right now (state ${state}); try again later.${keep}`
}

/**
 * Register `thread_status` and `thread_diff`.
 * @param ctx - context carrying the tool registry.
 * @param config - per-deployment bounds.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const bounds = resolveBounds(config)

  ctx.tools.register(defineTool({
    name: 'thread_status',
    description:
      'List the background Threads this Project started, one line per Thread in creation order: id, state, '
      + 'label, branch, commits ahead and uncommitted counts, and the start of the closing message. '
      + 'State is running, idle (not running, no outcome yet), or the last outcome: completed, aborted, error, '
      + 'max-tokens, refusal. Threads report back on their own when they finish, so poll only to survey '
      + 'outstanding work. Output is bounded and says how many Threads were omitted; filter by status to narrow it. '
      + 'A Thread\'s work lives on its branch until you merge it; use thread_diff to inspect it.',
    parameters: {
      status: {
        type: 'string',
        enum: [...THREAD_STATES],
        description: 'Optional exact state filter. Omit for every state.',
      },
      limit: {
        type: 'integer',
        description: `Rows to return, 1 through ${bounds.maxLimit}. Defaults to ${Math.min(bounds.defaultLimit, bounds.maxLimit)}.`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          threads: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                threadId: { type: 'string', required: true },
                state: { type: 'string', required: true, enum: [...THREAD_STATES] },
                label: { type: 'string', required: true },
                branch: { type: 'string' },
                commitsAhead: { type: 'integer' },
                uncommitted: { type: 'integer' },
                note: { type: 'string' },
              },
            },
          },
          total: { type: 'integer', required: true },
          truncated: { type: 'boolean', required: true },
          omitted: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderStatus(value, bounds.maxResultBytes) }],
    },
    execute(args, exec) {
      const caller = exec.agent
      if (!caller) throw new Error('thread_status requires a calling agent (exec.agent was undefined)')
      const requested = args.limit ?? bounds.defaultLimit
      if (!Number.isSafeInteger(requested) || requested < 1 || requested > LIMITS.limit.max) {
        throw new Error(`limit must be an integer from 1 through ${LIMITS.limit.max}`)
      }
      const { rows, service } = readCallerThreads(ctx, 'thread_status', caller.session)
      const matched = rows
        .map(row => toEntry(row, service.isRunning(row.threadId)))
        .filter(entry => args.status === undefined || entry.state === args.status)
      const page = matched.slice(0, Math.min(requested, bounds.maxLimit))
      return Promise.resolve(fitStatus(page, matched.length, bounds.maxResultBytes))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'thread_diff',
    description:
      'Inspect what Threads committed on their own branches. With thread_id and without path: base and head commits, '
      + 'commit subjects (newest first), committed files with +/- line counts, the uncommitted count, and how to merge '
      + 'the branch. With thread_id and path: the committed patch of that one file. Without thread_id: an overview of '
      + 'every Thread of this Project that has a live worktree, to use before merging several Threads: per Thread '
      + 'commits, files and uncommitted counts; committed paths touched by two or more Threads; whether each Thread '
      + 'merges cleanly into the Project checkout\'s HEAD and whether overlapping Threads conflict with each other '
      + '(needs git 2.38+; otherwise only overlaps are shown); and a suggested merge order. The overview reads '
      + 'committed work only and skips Threads whose worktree is missing or archived, naming the reason. '
      + 'Only Threads from thread_status are accepted. Output is bounded and says what was omitted. Read-only: '
      + 'merging stays your decision, and the work is not in the Project checkout until you merge the branch.',
    parameters: {
      thread_id: {
        type: 'string',
        description: 'Thread id as listed by thread_status. Omit to get the overview across all Threads '
          + '(call it before merging several Threads).',
      },
      path: {
        type: 'string',
        description: 'Repo-relative file to show the committed patch for. Requires thread_id. Omit for the summary.',
      },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              threadId: { type: 'string', required: true },
              branch: { type: 'string' },
              worktree: { type: 'string', required: true },
              baseSha: { type: 'string' },
              headSha: { type: 'string' },
              commits: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: { sha: { type: 'string', required: true }, subject: { type: 'string', required: true } },
                },
              },
              commitsTotal: { type: 'integer', required: true },
              files: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    path: { type: 'string', required: true },
                    added: { type: 'integer' },
                    removed: { type: 'integer' },
                    binary: { type: 'boolean' },
                  },
                },
              },
              filesTotal: { type: 'integer', required: true },
              uncommitted: { type: 'integer' },
              patchPath: { type: 'string' },
              patch: { type: 'string' },
              patchTruncated: { type: 'boolean' },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              mode: { type: 'string', required: true, enum: ['overview'] },
              threads: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    threadId: { type: 'string', required: true },
                    label: { type: 'string', required: true },
                    branch: { type: 'string' },
                    commitsTotal: { type: 'integer', required: true },
                    filesTotal: { type: 'integer', required: true },
                    uncommitted: { type: 'integer', required: true },
                    merge: {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        status: { type: 'string', required: true, enum: ['clean', 'conflict', 'failed'] },
                        conflicts: { type: 'array', required: true, items: { type: 'string' } },
                        conflictsTotal: { type: 'integer', required: true },
                        error: { type: 'string' },
                      },
                    },
                  },
                },
              },
              threadsTotal: { type: 'integer', required: true },
              skipped: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: { threadId: { type: 'string', required: true }, reason: { type: 'string', required: true } },
                },
              },
              skippedTotal: { type: 'integer', required: true },
              unexamined: { type: 'integer', required: true },
              overlaps: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    path: { type: 'string', required: true },
                    threadIds: { type: 'array', required: true, items: { type: 'string' } },
                  },
                },
              },
              overlapsTotal: { type: 'integer', required: true },
              filesCapped: { type: 'boolean', required: true },
              predictionSupported: { type: 'boolean', required: true },
              pairs: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    first: { type: 'string', required: true },
                    second: { type: 'string', required: true },
                    status: { type: 'string', required: true, enum: ['clean', 'conflict', 'failed'] },
                    conflicts: { type: 'array', required: true, items: { type: 'string' } },
                    conflictsTotal: { type: 'integer', required: true },
                    error: { type: 'string' },
                  },
                },
              },
              pairsTotal: { type: 'integer', required: true },
              pairsUnchecked: { type: 'integer', required: true },
              order: { type: 'array', required: true, items: { type: 'string' } },
            },
          },
        ],
      },
      render: (_args, value) => [{
        type: 'text',
        text: 'mode' in value ? renderOverview(value, bounds.maxResultBytes) : renderDiff(value, bounds.maxResultBytes),
      }],
    },
    async execute(args, exec) {
      const caller = exec.agent
      if (!caller) throw new Error('thread_diff requires a calling agent (exec.agent was undefined)')
      if (args.thread_id === undefined && args.path !== undefined) {
        throw new Error('path needs thread_id; omit both for the overview of all Threads')
      }
      if (args.path !== undefined) assertRepoRelative(args.path)
      const rows = readCallerThreads(ctx, 'thread_diff', caller.session).rows
      const worktrees = ctx.get('worktrees')
      if (args.thread_id === undefined) {
        if (worktrees === undefined) {
          throw new Error('thread_diff cannot read Thread changes: @deepseek-ai/dsh-worktree-manager is not loaded')
        }
        return fitOverview(await collectOverview(rows, worktrees, {
          maxThreads: bounds.maxOverviewThreads,
          maxFiles: bounds.maxFiles,
          maxPairChecks: bounds.maxPairChecks,
        }), bounds.maxResultBytes)
      }
      const row = rows.find(candidate => candidate.threadId === args.thread_id)
      if (row === undefined) throw new Error(`unknown thread id ${args.thread_id}; call thread_status to list this Project's threads`)
      if (worktrees === undefined) {
        throw new Error('thread_diff cannot read Thread changes: @deepseek-ai/dsh-worktree-manager is not loaded')
      }
      const record = await worktrees.get(row.threadId)
      if (record === undefined) {
        throw new Error(`no worktree is recorded for thread ${row.threadId}; it was never created or has been cleaned up.`
          + (row.branch === undefined ? '' : ` Its commits may still be on branch ${row.branch}.`))
      }
      if (record.state !== 'ready') throw new Error(unusableWorktree(row.threadId, record.state, record.branch ?? row.branch))
      const result: ThreadDiffResult | ThreadOverviewResult = args.path === undefined
        ? fitSummary(record, await worktrees.changes(record, { maxCommits: bounds.maxCommits, maxFiles: bounds.maxFiles }),
          row.threadId, bounds.maxResultBytes)
        : fitPatch(record, row.threadId, args.path, await worktrees.filePatch(record, args.path, bounds.maxPatchBytes),
          bounds.maxResultBytes)
      return result
    },
  }))

  ctx.tools.register(defineTool({
    name: 'library_list',
    description:
      'List what is already in this Project\'s Library: attachments sent in the chat, files the Project or its '
      + 'Threads presented, and the files each Thread changed, newest first within each section. This only reports '
      + 'what the Library already holds; it does not fetch new files or read a path you supply. For a Thread\'s '
      + 'current running state use thread_status, and for its committed diffs or a merge overview use thread_diff. '
      + 'Filter to one section with section, or omit it for all three. Output is bounded and says how many entries '
      + 'were omitted per section; narrow with section or raise limit to see more.',
    parameters: {
      section: {
        type: 'string',
        enum: [...LIBRARY_SECTIONS],
        description: 'Optional: list only this section of the Library. Omit to list all three.',
      },
      limit: {
        type: 'integer',
        description: `Entries to list per shown section, 1 through ${bounds.libraryMaxLimit}. `
          + `Defaults to ${Math.min(bounds.libraryDefaultLimit, bounds.libraryMaxLimit)}.`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          attachments: {
            type: 'object',
            additionalProperties: false,
            properties: {
              items: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    kind: { type: 'string', required: true, enum: ['image', 'file'] },
                    attachmentId: { type: 'string', required: true },
                    name: { type: 'string' },
                    mediaType: { type: 'string' },
                    bytes: { type: 'integer', required: true },
                    time: { type: 'integer', required: true },
                  },
                },
              },
              total: { type: 'integer', required: true },
              truncated: { type: 'boolean', required: true },
              omitted: { type: 'integer', required: true },
            },
          },
          presented: {
            type: 'object',
            additionalProperties: false,
            properties: {
              items: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    path: { type: 'string', required: true },
                    description: { type: 'string' },
                    sessionId: { type: 'string', required: true },
                    threadId: { type: 'string' },
                    time: { type: 'integer', required: true },
                  },
                },
              },
              total: { type: 'integer', required: true },
              truncated: { type: 'boolean', required: true },
              omitted: { type: 'integer', required: true },
            },
          },
          changes: {
            type: 'object',
            additionalProperties: false,
            properties: {
              items: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    threadId: { type: 'string', required: true },
                    label: { type: 'string', required: true },
                    source: { type: 'string', required: true, enum: ['live', 'archived'] },
                    branch: { type: 'string' },
                    worktree: { type: 'string' },
                    files: {
                      type: 'array',
                      required: true,
                      items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                          path: { type: 'string', required: true },
                          added: { type: 'integer' },
                          removed: { type: 'integer' },
                          binary: { type: 'boolean' },
                        },
                      },
                    },
                    filesTotal: { type: 'integer', required: true },
                    commitsTotal: { type: 'integer' },
                    uncommitted: { type: 'integer' },
                  },
                },
              },
              total: { type: 'integer', required: true },
              truncated: { type: 'boolean', required: true },
              omitted: { type: 'integer', required: true },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderLibrary(value, bounds.maxResultBytes) }],
    },
    async execute(args, exec) {
      const caller = exec.agent
      if (!caller) throw new Error('library_list requires a calling agent (exec.agent was undefined)')
      const requested = args.limit ?? bounds.libraryDefaultLimit
      if (!Number.isSafeInteger(requested) || requested < 1 || requested > LIMITS.libraryLimit.max) {
        throw new Error(`limit must be an integer from 1 through ${LIMITS.libraryLimit.max}`)
      }
      const threads = requireThreadsForLibrary(ctx, 'library_list')
      const library = await threads.library({ projectId: caller.session.id })
      const full = toLibraryListResult(library, args.section, Math.min(requested, bounds.libraryMaxLimit))
      return fitLibrary(full, bounds.maxResultBytes)
    },
  }))

  registerThreadTier(ctx)
}
