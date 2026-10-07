/**
 * `thread_diff` renderer suite.
 *
 * `thread_diff` builds every result it renders, so the tool suite alone leaves
 * the renderer's defensive shapes — a detached worktree, a record with no
 * `baseSha`, counts the worktree service never returns — unmeasured. These
 * cases hand `renderDiff` the same shapes directly, pinning the text each one
 * produces.
 */

import { describe, expect, it } from 'vitest'
import { renderDiff } from '../src/diff.ts'
import type { ThreadDiffResult } from '../src/diff.ts'

const bytes = (value: string): number => Buffer.byteLength(value, 'utf8')

/** A summary result with every optional field omitted unless the case sets it. */
function summary(extra: Partial<ThreadDiffResult> = {}): ThreadDiffResult {
  return { threadId: 'thread-a', worktree: '/wt/thread-a', commits: [], commitsTotal: 0, files: [], filesTotal: 0, ...extra }
}

/** A single-file patch result with every optional field omitted unless the case sets it. */
function patchOf(extra: Partial<ThreadDiffResult> = {}): ThreadDiffResult {
  return { ...summary(), patchPath: 'src/auth.ts', patch: 'diff --git a/src/auth.ts b/src/auth.ts\n+x', ...extra }
}

describe('renderDiff summary', () => {
  it('names the merge commit of a detached worktree', () => {
    const headSha = 'abcdef0123456789abcdef0123456789abcdef01'

    expect(renderDiff(summary({ headSha }), 4096)).toBe([
      'Thread thread-a',
      `no branch (detached): fetch commit ${headSha} from /wt/thread-a into the Project checkout and merge it`,
      `base , head ${headSha.slice(0, 12)}; 0 uncommitted in /wt/thread-a (not on the branch until committed)`,
      'commits: none',
      'committed files: none',
    ].join('\n'))
  })

  it('renders a result the worktree service cannot fill in', () => {
    expect(renderDiff(summary(), 4096)).toBe([
      'Thread thread-a',
      'no branch (detached): fetch commit the head commit from /wt/thread-a into the Project checkout and merge it',
      'base , head ; 0 uncommitted in /wt/thread-a (not on the branch until committed)',
      'commits: none',
      'committed files: none',
    ].join('\n'))
  })

  it('counts a file with neither added nor removed lines as zero', () => {
    const out = renderDiff(summary({
      branch: 'dsh/thread-a', baseSha: 'b'.repeat(40), headSha: 'h'.repeat(40), uncommitted: 2,
      files: [{ path: 'LICENSE' }], filesTotal: 3,
    }), 4096)

    expect(out).toBe([
      'Thread thread-a',
      'branch dsh/thread-a: import it into the Project checkout with `git fetch /wt/thread-a dsh/thread-a:dsh/thread-a`, then merge with `git merge --no-ff dsh/thread-a`',
      `base ${'b'.repeat(12)}, head ${'h'.repeat(12)}; 2 uncommitted in /wt/thread-a (not on the branch until committed)`,
      'commits: none',
      'committed files (3):',
      '  +0 -0 LICENSE',
      '  (2 more files omitted; pass path to read one patch)',
    ].join('\n'))
  })
})

describe('renderDiff patch', () => {
  it('titles a detached worktree and names the commit to read from', () => {
    const out = renderDiff(patchOf({ patchTruncated: true }), 4096)

    expect(out).toBe([
      'Thread thread-a, committed changes to src/auth.ts',
      'diff --git a/src/auth.ts b/src/auth.ts\n+x',
      '[patch truncated here; read the rest with git -C /wt/thread-a diff BASE..HEAD -- src/auth.ts]',
    ].join('\n'))
  })

  it('renders a result with no patch text at all', () => {
    const { patch: _absent, ...withoutPatch } = patchOf({ branch: 'dsh/thread-a', baseSha: 'b'.repeat(40) })

    expect(renderDiff(withoutPatch, 4096)).toBe([
      'Thread thread-a branch dsh/thread-a, committed changes to src/auth.ts',
      '',
    ].join('\n'))
  })
})

describe('renderDiff byte bound', () => {
  it('cuts the rendered text to the bound without splitting a code point', () => {
    const result = patchOf({ patch: '多'.repeat(200) })
    const whole = renderDiff(result, Infinity)

    expect(bytes(renderDiff(result, bytes(whole)))).toBe(bytes(whole))
    const out = renderDiff(result, 64)
    expect(bytes(out)).toBeLessThanOrEqual(64)
    expect(out).not.toContain('\ufffd')
  })
})
