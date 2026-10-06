/**
 * R1 acceptance, end to end under the REAL seatbelt profile (workspace-write):
 * 1. the live WorktreeService creates a Thread worktree (a local clone),
 * 2. `git add` + `git commit` inside it succeed under sandbox-exec,
 * 3. the same commit in a LINKED worktree under the same profile is denied
 *    (the pre-R1 HIGH finding, reproduced as the red control).
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '/Users/user/deepseek-harness/vendor/cordis/lib/index.js'
import WorktreeService from '/Users/user/deepseek-harness/packages/subagent/worktree-manager/src/index.ts'
import { seatbeltProfileArgs } from '/Users/user/deepseek-harness/packages/sandbox/sandbox-local/src/profiles.ts'

const temporaries: string[] = []
/**
 * Temp dirs live OUTSIDE the platform temp area: `writableRoots` grants writes
 * to all of `tmpdir()` unconditionally, so a parent repo inside it would make
 * the linked-worktree red control pass for the wrong reason.
 */
const BASE = '/Users/user/deepseek-harness/.tmp-r1-e2e-'
const temporary = (prefix: string): string => {
  const dir = mkdtempSync(BASE + prefix + '-')
  temporaries.push(dir)
  return dir
}
const git = (args: readonly string[], cwd?: string): string =>
  execFileSync('git', [...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim()

/** Run `sh -c` under the deployment's real seatbelt profile for one workspace root. */
const confined = (workspaceRoot: string, command: string): { code: number; stderr: string } => {
  const run = spawnSync('sandbox-exec', [
    ...seatbeltProfileArgs({ mode: 'workspace-write', workspaceRoot }),
    '--', '/bin/sh', '-c', command,
  ], { encoding: 'utf8' })
  return { code: run.status ?? -1, stderr: String(run.stderr) }
}

const parent = temporary('r1-e2e-parent-')
git(['init', '--quiet', '--initial-branch=main', parent])
git(['config', 'user.email', 'e2e@example.test'], parent)
git(['config', 'user.name', 'E2E'], parent)
writeFileSync(join(parent, 'README.md'), 'seed\n', 'utf8')
git(['add', '.'], parent)
git(['commit', '--quiet', '-m', 'seed'], parent)

const worktreeRoot = temporary('r1-e2e-root-')
const ctx = new Context()
await ctx.plugin(WorktreeService, { pruneOnStart: false, worktreeRoot })
const service = ctx.worktrees

const record = await service.create(
  { repoRoot: parent, threadId: 'e2e-thread', baseRef: 'HEAD' },
  new AbortController().signal,
)
console.log('worktree path:', record.path)
console.log('state:', record.state, '| branch:', record.branch)

const commitCmd = `cd ${JSON.stringify(record.path)} && echo fix >> README.md && git add -A && git -c user.email=t@e.test -c user.name=T commit --quiet -m fix && git rev-parse HEAD && git log --oneline -1`

// Green: the clone commits under the profile whose only writable root is the clone itself.
const green = confined(record.path, commitCmd)
console.log('\n[clone under workspace-write] exit:', green.code)
console.log(green.code === 0 ? '  git log: ' + git(['log', '--oneline', '-1'], record.path) : '  stderr: ' + green.stderr.trim())

// Red control: a LINKED worktree of the same parent under the same policy shape.
const linkedPath = join(worktreeRoot, 'linked-wt')
git(['worktree', 'add', '--quiet', '-b', 'linked', linkedPath, 'HEAD'], parent)
const red = confined(linkedPath, `cd ${JSON.stringify(linkedPath)} && echo fix >> README.md && git add -A && git -c user.email=t@e.test -c user.name=T commit --quiet -m fix`)
console.log('\n[linked worktree under workspace-write] exit:', red.code)
console.log('  stderr:', red.stderr.trim().split('\n')[0])

await service.remove(record, { force: true })
rmSync(linkedPath, { recursive: true, force: true })
git(['worktree', 'prune'], parent)
for (const dir of temporaries) rmSync(dir, { recursive: true, force: true })

const verdict = green.code === 0 && red.code !== 0
console.log('\nVERDICT:', verdict ? 'PASS — clone commits confined, linked worktree denied' : 'FAIL')
process.exit(verdict ? 0 : 1)
