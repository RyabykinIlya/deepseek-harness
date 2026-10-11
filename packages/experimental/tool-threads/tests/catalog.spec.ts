/**
 * The harvest mount for the Thread tools: `thread_tier` registers only while a
 * routing service is present, so this mount is what makes its schema reachable.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { mount } from '../src/catalog.ts'

const contexts = new Set<Context>()

afterEach(async () => {
  for (const ctx of contexts) await ctx.fiber.dispose()
  contexts.clear()
})

describe('tool-threads catalog mount', () => {
  it('registers every Thread tool, thread_tier included', async () => {
    const ctx = new Context()
    contexts.add(ctx)
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime)
    await mount(ctx)
    const names = ctx.tools.schemas().map(schema => schema.name).sort()
    expect(names).toEqual(['library_list', 'thread_diff', 'thread_status', 'thread_tier'])
  })
})
