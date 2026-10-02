import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import ProjectMemoryService from '../src/index.ts'
import { projectMemoryDomain } from '../src/index.ts'
import type { ProjectId } from '../src/index.ts'
import * as tools from '../src/tools.ts'
import { agentFor, harness, run } from './harness.ts'

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  return { ...actual, randomUUID: vi.fn(actual.randomUUID) }
})

const contexts: Context[] = []
afterEach(async () => {
  vi.mocked(randomUUID).mockClear()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

const P = 'p' as ProjectId

describe('direct construction without loader defaults', () => {
  it('applies the documented defaults to the service and the tools', async () => {
    const { ctx } = await harness({ service: false, tools: false })
    contexts.push(ctx)
    const service = new ProjectMemoryService(ctx, {})
    await service[Service.init]()
    tools.apply(ctx)
    const project = agentFor(ctx, 'p', { agentPreset: 'project' })
    expect(await service.resolveProject(project.session)).toBe('p')
    const added = await run(ctx, project, 'memory_write', { action: 'add', text: 'x'.repeat(500) })
    expect(added.result.isError).toBe(false)
    expect((await run(ctx, project, 'memory_write', { action: 'add', text: 'x'.repeat(501) })).result.isError).toBe(true)
    expect((await run(ctx, project, 'memory_read', {})).result.isError).toBe(false)
    const schema = ctx.tools.schemas().find(entry => entry.name === 'memory_read')!
    expect(JSON.stringify(schema.parameters)).toContain('Defaults to 20')
  })

  it('surfaces a failed storage open through service initialization', async () => {
    const { ctx } = await harness({ service: false, tools: false })
    contexts.push(ctx)
    await ctx.storageDomain.open(projectMemoryDomain)
    const second = new ProjectMemoryService(ctx, {})
    await expect(second[Service.init]()).rejects.toThrow(/is already open/)
  })
})

describe('entry id allocation', () => {
  it('draws again when an id is already taken', async () => {
    const { ctx } = await harness({ tools: false })
    contexts.push(ctx)
    const taken = await ctx.projectMemory.add(P, 'first', 'user')
    const mocked = vi.mocked(randomUUID)
    mocked.mockReturnValueOnce(`${taken.id.slice(1)}-0000-4000-8000-000000000000`)
    const next = await ctx.projectMemory.add(P, 'second', 'user')
    expect(next.id).not.toBe(taken.id)
    expect(await ctx.projectMemory.list(P)).toHaveLength(2)
  })
})
