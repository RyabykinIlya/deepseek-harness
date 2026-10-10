/**
 * The Project memory tools as a schema harvest mounts them.
 * @module @deepseek-ai/dsh-experimental-project-memory/catalog
 */

import type { Context } from '@deepseek-ai/cordis'
import * as ProjectMemoryTools from './tools.ts'

/**
 * Mount `memory_read` and `memory_write` for schema harvest.
 *
 * The tools resolve `projectMemory` at execution, so the harvest needs only the
 * tool registry.
 * @param ctx - the context carrying the tool registry.
 */
export async function mount(ctx: Context): Promise<void> {
  await ctx.plugin(ProjectMemoryTools)
}
