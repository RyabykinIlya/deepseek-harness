/**
 * Child process for the multi-process registry test: mounts the worktree service
 * on a shared root and tries to create one Thread. Prints `{ ok, code }` as JSON.
 *
 * argv: worktreeRoot repoRoot threadId branch maxWorktreesPerRepo
 */

import { Context } from '@deepseek-ai/cordis'
import WorktreeService from '../../src/index.ts'

const [worktreeRoot = '', repoRoot = '', threadId = '', branch = '', max = '32'] = process.argv.slice(2)

const ctx = new Context()
await ctx.plugin(WorktreeService, { worktreeRoot, pruneOnStart: false, maxWorktreesPerRepo: Number(max) })
try {
  // `ctx.worktrees` is declared by the sibling experimental service too; this
  // fixture mounts the manager and reads the key it registered.
  await (ctx.worktrees as never as {
    create(spec: { repoRoot: string; threadId: string; baseRef: string; branch: string }, signal: AbortSignal): Promise<unknown>
  }).create({ repoRoot, threadId, baseRef: 'HEAD', branch }, new AbortController().signal)
  process.stdout.write(JSON.stringify({ ok: true }))
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, code: (error as { code?: string }).code }))
}
