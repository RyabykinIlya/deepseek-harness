/**
 * Test-only worker tool: writes a file in the calling agent's cwd and commits it.
 * The shipped shell tool needs sandbox and approval services a unit composition does not mount.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Cordis plugin name. */
export const name = 'test-commit-tool'

/** Services required before the tool registers. */
export const inject = ['tools']

/** Where and on which branch one commit happened. */
export interface CommitObservation {
  readonly cwd: string
  readonly branch: string
}

/** Commits made through the tool since the last reset; tests clear it before each composition. */
export const observed: CommitObservation[] = []

/**
 * Run git with an argv array.
 * @param args - git arguments.
 * @param cwd - working directory.
 * @returns trimmed stdout.
 */
function git(args: readonly string[], cwd: string): string {
  return execFileSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim()
}

/**
 * Register `commit_file`.
 * @param ctx - context carrying the tool registry.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'commit_file',
    description: 'Write a file in the calling agent cwd and commit it with git.',
    parameters: {
      path: { type: 'string', required: true },
      content: { type: 'string', required: true },
      message: { type: 'string', required: true },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { branch: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: `committed on ${value.branch}` }],
    },
    execute(args, exec) {
      const cwd = exec.agent?.session.header.cwd
      if (cwd === undefined) throw new Error('commit_file needs an agent with a cwd')
      mkdirSync(dirname(join(cwd, args.path)), { recursive: true })
      writeFileSync(join(cwd, args.path), args.content, 'utf8')
      git(['add', '-A'], cwd)
      git(['-c', 'user.email=thread@example.test', '-c', 'user.name=Thread', 'commit', '--quiet', '-m', args.message], cwd)
      const branch = git(['branch', '--show-current'], cwd)
      observed.push({ cwd, branch })
      return Promise.resolve({ branch })
    },
  }))
}
