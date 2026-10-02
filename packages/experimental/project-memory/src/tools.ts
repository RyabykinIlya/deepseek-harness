/**
 * The `memory_read` and `memory_write` tools over the Project memory service.
 *
 * Results are ordinary tool results and therefore part of the session log;
 * nothing is injected into the system prompt.
 * @module @deepseek-ai/dsh-experimental-project-memory/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { MemoryAuthor, MemoryEntry, MemoryEntryId } from './types.ts'
import type {} from './index.ts'

/** Cordis plugin name. */
export const name = 'project-memory-tools'

/**
 * Services required before the tools are registered. `projectMemory` is
 * resolved at execution so a composition without it still shows the tools and
 * the model learns why they cannot work.
 */
export const inject = ['tools']

/** Configuration of the memory tools. */
export interface Config {
  /** Byte budget of one complete `memory_read` result, truncation line included. */
  maxReadBytes?: number
  /** Entries returned when the model omits `limit`. */
  defaultLimit?: number
  /** Largest `limit` the model may request. */
  maxLimit?: number
}

/** Loader schema for the memory tools plugin. */
export const Config: z<Config> = z.object({
  maxReadBytes: z.number().step(1).min(256).max(1_000_000).default(8192),
  defaultLimit: z.number().step(1).min(1).max(1000).default(20),
  maxLimit: z.number().step(1).min(1).max(1000).default(100),
})

/** One entry as `memory_read` returns it. */
interface ReadEntry {
  readonly id: string
  readonly author: MemoryAuthor
  readonly text: string
  readonly updatedAt: string
}

/** One text line per entry, the format the model reads and the byte budget measures. */
function line(entry: ReadEntry): string {
  return `${entry.id} [${entry.author}, ${entry.updatedAt}] ${entry.text.replaceAll('\n', ' ')}`
}

/** Final line naming how many matching entries the result left out. */
function truncationLine(shown: number, matched: number): string {
  return `(showing ${shown} of ${matched} matching entries; narrow with query or raise limit to see more)`
}

/** Render the complete result text. */
function renderRead(entries: readonly ReadEntry[], matched: number): string {
  if (matched === 0) return '(no memory entries)'
  return [...entries.map(line), ...entries.length < matched ? [truncationLine(entries.length, matched)] : []].join('\n')
}

/** Keep the longest prefix of `entries` whose complete rendering fits `maxBytes`. */
function fitBytes(entries: readonly ReadEntry[], matched: number, maxBytes: number): ReadEntry[] {
  let kept = entries.length
  while (kept > 0 && Buffer.byteLength(renderRead(entries.slice(0, kept), matched), 'utf8') > maxBytes) kept--
  return entries.slice(0, kept)
}

/** The Project's author role for the calling Agent. */
async function authorOf(memory: Context['projectMemory'], agent: Agent): Promise<MemoryAuthor> {
  return await memory.resolveProject(agent.session) === String(agent.session.id) ? 'coordinator' : 'thread'
}

/** Get the service and the caller, as a model-facing error when either is missing. */
function callerOf(ctx: Context, tool: string, agent: Agent | undefined): { memory: Context['projectMemory']; agent: Agent } {
  const memory = ctx.get('projectMemory')
  if (memory === undefined) {
    throw new Error(`${tool} is unavailable: this deployment has no Project memory service (@deepseek-ai/dsh-experimental-project-memory is not mounted).`)
  }
  if (agent === undefined) throw new Error(`${tool} requires a calling agent (exec.agent was undefined)`)
  return { memory, agent }
}

/**
 * Register `memory_read` and `memory_write`.
 * @param ctx - context carrying the tool registry.
 * @param config - byte and page bounds.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const maxBytes = config.maxReadBytes ?? 8192
  const maxLimit = config.maxLimit ?? 100
  const defaultLimit = Math.min(config.defaultLimit ?? 20, maxLimit)

  ctx.tools.register(defineTool({
    name: 'memory_read',
    description:
      'Read the Project memory: short facts that every Thread of this Project shares, newest first. '
      + 'Read it when you start a task, before you decide something another Thread may already have settled. '
      + 'Optional query keeps entries containing that text, ignoring case.',
    parameters: {
      query: { type: 'string', description: 'Keep only entries containing this text, ignoring case.' },
      limit: { type: 'integer', description: `Entries to return, 1 through ${maxLimit}. Defaults to ${defaultLimit}.` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          entries: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                author: { type: 'string', required: true, enum: ['coordinator', 'thread', 'user'] },
                text: { type: 'string', required: true },
                updatedAt: { type: 'string', required: true },
              },
            },
          },
          matched: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderRead(value.entries, value.matched) }],
    },
    async execute(args, exec) {
      const { memory, agent } = callerOf(ctx, 'memory_read', exec.agent)
      const limit = args.limit ?? defaultLimit
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxLimit) {
        throw new Error(`limit must be an integer from 1 through ${maxLimit}`)
      }
      const needle = args.query?.toLowerCase()
      const matched = (await memory.list(await memory.resolveProject(agent.session)))
        .filter(entry => needle === undefined || entry.text.toLowerCase().includes(needle))
        .map((entry: MemoryEntry): ReadEntry => ({
          id: entry.id, author: entry.author, text: entry.text, updatedAt: new Date(entry.updatedAt).toISOString(),
        }))
      const entries = fitBytes(matched.slice(0, limit), matched.length, maxBytes)
      return { entries, matched: matched.length }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_write',
    description:
      'Add, update, or remove one entry of the Project memory, which every Thread of this Project reads. '
      + 'Write a decision other Threads will need: an agreed constraint, a date, who to ask, a convention you discovered. '
      + 'Do not store file contents, logs, or transient progress. Keep each entry to one short, self-contained fact. '
      + 'Returns the entry id; use it to update or remove the entry later.',
    parameters: {
      action: { type: 'string', required: true, enum: ['add', 'update', 'remove'], description: 'add needs text; update needs id and text; remove needs id.' },
      id: { type: 'string', description: 'Entry id from memory_read or a previous memory_write.' },
      text: { type: 'string', description: 'Entry text for add or update.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true, enum: ['add', 'update', 'remove'] },
          id: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `${value.action === 'add' ? 'added' : value.action === 'update' ? 'updated' : 'removed'} ${value.id}` }],
    },
    async execute(args, exec) {
      const { memory, agent } = callerOf(ctx, 'memory_write', exec.agent)
      const projectId = await memory.resolveProject(agent.session)
      const author = await authorOf(memory, agent)
      const id = args.id === undefined ? undefined : brandString<MemoryEntryId>(args.id)
      if (args.action === 'add') {
        if (args.text === undefined) throw new Error('action "add" needs text.')
        return { action: 'add' as const, id: (await memory.add(projectId, args.text, author, agent.session.id)).id }
      }
      if (args.action === 'update') {
        if (id === undefined || args.text === undefined) throw new Error('action "update" needs id and text. Call memory_read to find the id.')
        return { action: 'update' as const, id: (await memory.update(projectId, id, args.text, author, agent.session.id)).id }
      }
      if (id === undefined) throw new Error('action "remove" needs id. Call memory_read to find the id.')
      await memory.remove(projectId, id)
      return { action: 'remove' as const, id }
    },
  }))
}
