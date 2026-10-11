/**
 * The Thread tools as a schema harvest mounts them.
 * @module @deepseek-ai/dsh-experimental-threads-tool/catalog
 */

import type { Context } from '@deepseek-ai/cordis'
import { CatalogModelRouting } from '@deepseek-ai/dsh-experimental-model-routing/catalog'
import * as ToolThreads from './index.ts'

/**
 * Mount the Thread tools with the seams their registration waits on.
 *
 * The tools register from the tool registry alone, so the harvest reaches their
 * schemas without the Threads domain: an unavailable projection is a runtime
 * error, never a missing schema. `thread_tier` is the exception, registering
 * only while a routing service is present.
 * @param ctx - the context carrying the tool registry.
 */
export async function mount(ctx: Context): Promise<void> {
  ctx.provide('modelRouting', new CatalogModelRouting())
  await ctx.plugin(ToolThreads)
}
