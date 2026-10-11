/**
 * The harvest mount for the memory tools: they resolve `projectMemory` at
 * execution, so the registry alone is enough to read their schemas.
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

describe('project-memory catalog mount', () => {
  it('registers both memory tools without the service present', async () => {
    const ctx = new Context()
    contexts.add(ctx)
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime)
    await mount(ctx)
    const names = ctx.tools.schemas().map(schema => schema.name).sort()
    expect(names).toEqual(['memory_read', 'memory_write'])
  })
})
