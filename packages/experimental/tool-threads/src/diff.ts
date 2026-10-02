/** The `thread_diff` tool: a byte-bounded read of one Thread's committed work. @module */

import type { WorktreeChanges, WorktreeRecord } from '@deepseek-ai/dsh-worktree-manager'
import { byteLength, oneLine, truncateUtf8 } from './text.ts'

/** Byte cap on one rendered commit subject. */
const SUBJECT_BYTES = 200

/** Abbreviated commit id length in rendered text. */
const SHORT_SHA = 12

/** The `thread_diff` result for either mode. */
export interface ThreadDiffResult {
  /** The Thread inspected. */
  readonly threadId: string
  /** Branch holding the Thread's commits. */
  readonly branch?: string
  /** Worktree root of the Thread. */
  readonly worktree: string
  /** Commit the Thread started from. */
  readonly baseSha?: string
  /** Current head commit. Summary mode only. */
  readonly headSha?: string
  /** Commits, newest first, cut to the bounds. Summary mode only. */
  readonly commits: { readonly sha: string; readonly subject: string }[]
  /** Commits between base and head. */
  readonly commitsTotal: number
  /** Committed changed files, cut to the bounds. Summary mode only. */
  readonly files: { readonly path: string; readonly added?: number; readonly removed?: number; readonly binary?: boolean }[]
  /** Committed changed files in total. */
  readonly filesTotal: number
  /** Uncommitted entries in the worktree. Summary mode only. */
  readonly uncommitted?: number
  /** File whose patch was requested. */
  readonly patchPath?: string
  /** Committed patch text for `patchPath`, cut to the bounds. */
  readonly patch?: string
  /** Whether `patch` ends before the end of the file's diff. */
  readonly patchTruncated?: boolean
}

/** Merge instructions phrased for the Project model. */
function mergeLine(result: ThreadDiffResult): string {
  if (result.branch !== undefined) {
    return `branch ${result.branch}: merge with \`git merge --no-ff ${result.branch}\` in the Project checkout`
  }
  return `no branch (detached): merge commit ${(result.headSha ?? '').slice(0, SHORT_SHA)} from ${result.worktree}`
}

/** Render the summary mode. */
function renderSummary(result: ThreadDiffResult): string {
  const lines = [
    `Thread ${result.threadId}`,
    mergeLine(result),
    `base ${(result.baseSha ?? '').slice(0, SHORT_SHA)}, head ${(result.headSha ?? '').slice(0, SHORT_SHA)}; `
    + `${result.uncommitted ?? 0} uncommitted in ${result.worktree} (not on the branch until committed)`,
    result.commitsTotal === 0 ? 'commits: none' : `commits (${result.commitsTotal}, newest first):`,
    ...result.commits.map(commit => `  ${commit.sha.slice(0, SHORT_SHA)} ${commit.subject}`),
    ...result.commits.length < result.commitsTotal
      ? [`  (${result.commitsTotal - result.commits.length} more commits omitted)`]
      : [],
    result.filesTotal === 0 ? 'committed files: none' : `committed files (${result.filesTotal}):`,
    ...result.files.map(file => file.binary === true
      ? `  binary ${file.path}`
      : `  +${file.added ?? 0} -${file.removed ?? 0} ${file.path}`),
    ...result.files.length < result.filesTotal
      ? [`  (${result.filesTotal - result.files.length} more files omitted; pass path to read one patch)`]
      : [],
  ]
  return lines.join('\n')
}

/** Marker line that ends a cut patch. */
function patchMarker(result: ThreadDiffResult): string {
  const base = result.baseSha ?? 'BASE'
  return `[patch truncated here; read the rest with git -C ${result.worktree} diff ${base}..HEAD -- ${result.patchPath}]`
}

/** Render the single-file patch mode. */
function renderPatch(result: ThreadDiffResult): string {
  const header = `Thread ${result.threadId}${result.branch === undefined ? '' : ` branch ${result.branch}`}, `
    + `committed changes to ${result.patchPath}`
  const body = result.patch === '' ? '(no committed changes to this file)' : (result.patch ?? '')
  return [header, body, ...result.patchTruncated === true ? [patchMarker(result)] : []].join('\n')
}

/**
 * Render a result as the model's text, clamped to `maxBytes`.
 * @param result - the result to render.
 * @param maxBytes - byte bound over the whole text.
 * @returns the text.
 */
export function renderDiff(result: ThreadDiffResult, maxBytes: number): string {
  const text = result.patchPath === undefined ? renderSummary(result) : renderPatch(result)
  return truncateUtf8(text, maxBytes)
}

/**
 * Build the summary result, dropping files then commits until it fits.
 * @param record - the Thread's worktree record.
 * @param changes - committed and uncommitted changes read from the worktree.
 * @param threadId - Thread id.
 * @param maxBytes - byte bound over the rendered text.
 * @returns the largest result that renders within the bound.
 */
export function fitSummary(
  record: WorktreeRecord,
  changes: WorktreeChanges,
  threadId: string,
  maxBytes: number,
): ThreadDiffResult {
  const build = (commits: number, files: number): ThreadDiffResult => ({
    threadId,
    ...record.branch === undefined ? {} : { branch: record.branch },
    worktree: record.path,
    baseSha: changes.baseSha,
    headSha: changes.headSha,
    commits: changes.commits.slice(0, commits).map(commit => ({
      sha: commit.sha,
      subject: oneLine(commit.subject, SUBJECT_BYTES),
    })),
    commitsTotal: changes.commitsTotal,
    files: changes.files.slice(0, files),
    filesTotal: changes.filesTotal,
    uncommitted: changes.uncommitted,
  })
  let commits = changes.commits.length
  let files = changes.files.length
  const size = (): number => byteLength(renderDiff(build(commits, files), Infinity))
  while (files > 0 && size() > maxBytes) files -= 1
  while (commits > 0 && size() > maxBytes) commits -= 1
  return build(commits, files)
}

/**
 * Build the single-file result, cutting the patch so the complete text fits.
 * @param record - the Thread's worktree record.
 * @param threadId - Thread id.
 * @param path - repo-relative file.
 * @param patch - committed patch as read from the worktree.
 * @param maxBytes - byte bound over the rendered text including header and marker.
 * @returns the result whose rendering is within the bound.
 */
export function fitPatch(
  record: WorktreeRecord,
  threadId: string,
  path: string,
  patch: { readonly patch: string; readonly truncated: boolean },
  maxBytes: number,
): ThreadDiffResult {
  const build = (text: string, truncated: boolean): ThreadDiffResult => ({
    threadId,
    ...record.branch === undefined ? {} : { branch: record.branch },
    worktree: record.path,
    ...record.baseSha === undefined ? {} : { baseSha: record.baseSha },
    commits: [],
    commitsTotal: 0,
    files: [],
    filesTotal: 0,
    patchPath: path,
    patch: text,
    patchTruncated: truncated,
  })
  const whole = build(patch.patch, patch.truncated)
  if (byteLength(renderDiff(whole, Infinity)) <= maxBytes) return whole
  const overhead = byteLength(renderDiff(build('', true), Infinity))
  return build(truncateUtf8(patch.patch, Math.max(0, maxBytes - overhead)), true)
}
