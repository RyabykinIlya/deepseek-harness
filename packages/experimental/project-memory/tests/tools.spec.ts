import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ProjectId } from '../src/index.ts'
import { agentFor, harness, run } from './harness.ts'

const contexts: Context[] = []

async function mount(options: Parameters<typeof harness>[0] = {}) {
  const mounted = await harness(options)
  contexts.push(mounted.ctx)
  const project = agentFor(mounted.ctx, 'p', { agentPreset: 'project' })
  const thread = agentFor(mounted.ctx, 't', { agentPreset: 'project-thread', parentSession: 'p' })
  return { ...mounted, project, thread }
}

afterEach(async () => {
  vi.useRealTimers()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

const P = 'p' as ProjectId

describe('memory_write', () => {
  it('adds as coordinator or thread and returns the id', async () => {
    const { ctx, project, thread } = await mount()
    const a = await run(ctx, project, 'memory_write', { action: 'add', text: 'Use pnpm' })
    const b = await run(ctx, thread, 'memory_write', { action: 'add', text: 'Deploy on Fridays is banned' })
    expect(a.result.isError).toBe(false)
    expect(a.text).toMatch(/^added m[0-9a-f]{8}$/)
    const entries = await ctx.projectMemory.list(P)
    expect(entries.map(entry => [entry.text, entry.author, entry.authorSessionId])).toEqual([
      ['Deploy on Fridays is banned', 'thread', 't'], ['Use pnpm', 'coordinator', 'p'],
    ])
    expect(b.text).toBe(`added ${entries[0]!.id}`)
  })

  it('updates and removes by id', async () => {
    const { ctx, project, thread } = await mount()
    const id = (await ctx.projectMemory.add(P, 'old', 'user')).id
    expect((await run(ctx, thread, 'memory_write', { action: 'update', id, text: 'new' })).text).toBe(`updated ${id}`)
    expect((await ctx.projectMemory.list(P))[0]).toMatchObject({ text: 'new', author: 'thread' })
    expect((await run(ctx, project, 'memory_write', { action: 'remove', id })).text).toBe(`removed ${id}`)
    expect(await ctx.projectMemory.list(P)).toEqual([])
  })

  it('returns actionable errors', async () => {
    const { ctx, project } = await mount({ config: { maxEntryChars: 4 } })
    const cases: [unknown, string][] = [
      [{ action: 'add' }, 'action "add" needs text.'],
      [{ action: 'add', text: 'too long' }, 'The memory text is 8 characters; the limit is 4. Shorten it or split it into separate entries.'],
      [{ action: 'update', id: 'mx' }, 'action "update" needs id and text. Call memory_read to find the id.'],
      [{ action: 'remove' }, 'action "remove" needs id. Call memory_read to find the id.'],
      [{ action: 'remove', id: 'mx' }, 'No memory entry "mx" exists in this Project. Call memory_read to see the current ids.'],
    ]
    for (const [args, message] of cases) {
      const { result, text } = await run(ctx, project, 'memory_write', args)
      expect(result.isError).toBe(true)
      expect(text).toContain(message)
    }
  })
})

describe('memory_read', () => {
  it('lists newest first, shares across threads, and filters case-insensitively', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { ctx, project, thread } = await mount()
    vi.setSystemTime(Date.UTC(2026, 0, 1))
    const a = await ctx.projectMemory.add(P, 'Use PNPM everywhere', 'coordinator')
    vi.setSystemTime(Date.UTC(2026, 0, 2))
    const b = await ctx.projectMemory.add(P, 'Ask Dana about billing', 'user')
    await ctx.projectMemory.add('other' as ProjectId, 'secret of another project', 'user')
    const all = `${b.id} [user, 2026-01-02T00:00:00.000Z] Ask Dana about billing\n${a.id} [coordinator, 2026-01-01T00:00:00.000Z] Use PNPM everywhere`
    expect((await run(ctx, thread, 'memory_read', {})).text).toBe(all)
    expect((await run(ctx, project, 'memory_read', { query: 'pnpm' })).text)
      .toBe(`${a.id} [coordinator, 2026-01-01T00:00:00.000Z] Use PNPM everywhere`)
    expect((await run(ctx, project, 'memory_read', { query: 'zzz' })).text).toBe('(no memory entries)')
  })

  it('applies limit and says what it left out', async () => {
    const { ctx, project } = await mount()
    for (let index = 0; index < 3; index++) await ctx.projectMemory.add(P, `e${index}`, 'user')
    const { text } = await run(ctx, project, 'memory_read', { limit: 2 })
    expect(text.split('\n')).toHaveLength(3)
    expect(text.split('\n')[2]).toBe('(showing 2 of 3 matching entries; narrow with query or raise limit to see more)')
    const bad = await run(ctx, project, 'memory_read', { limit: 0 })
    expect(bad.result.isError).toBe(true)
    expect(bad.text).toContain('limit must be an integer from 1 through 100')
  })

  it('bounds the complete rendered result in bytes: tiny, exact, and multibyte', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(0)
    const bytes = (text: string) => Buffer.byteLength(text, 'utf8')
    const render = async (maxReadBytes: number) => {
      const sample = await mount({ tools: { maxReadBytes } })
      await sample.ctx.projectMemory.add(P, '数据'.repeat(60), 'user')
      vi.setSystemTime(1)
      await sample.ctx.projectMemory.add(P, 'short', 'user')
      vi.setSystemTime(0)
      return (await run(sample.ctx, sample.project, 'memory_read', {})).text
    }
    const full = await render(8192)
    expect(bytes(full)).toBeGreaterThan(full.length)
    expect(bytes(full)).toBeGreaterThan(256)
    expect(full.split('\n')).toHaveLength(2)

    const exact = await render(bytes(full))
    expect(exact.replace(/m[0-9a-f]{8}/g, 'ID')).toBe(full.replace(/m[0-9a-f]{8}/g, 'ID'))

    const under = await render(bytes(full) - 1)
    expect(bytes(under)).toBeLessThanOrEqual(bytes(full) - 1)
    expect(under.split('\n')).toHaveLength(2)
    expect(under.split('\n')[0]).toContain('short')
    expect(under.split('\n')[1]).toBe('(showing 1 of 2 matching entries; narrow with query or raise limit to see more)')
  })

  it('reports only the truncation line when the first entry cannot fit', async () => {
    const { ctx, project } = await mount({ tools: { maxReadBytes: 256 } })
    await ctx.projectMemory.add(P, '😀'.repeat(150), 'user')
    const { text } = await run(ctx, project, 'memory_read', {})
    expect(text).toBe('(showing 0 of 1 matching entries; narrow with query or raise limit to see more)')
  })
})

describe('memory tools availability', () => {
  it('registers exactly the two tools with the pinned descriptions', async () => {
    const { ctx } = await mount()
    const schemas = ctx.tools.schemas().filter(schema => schema.name.startsWith('memory_'))
    expect(schemas.map(schema => [schema.name, schema.description])).toEqual([
      ['memory_read', 'Read the Project memory: short facts that every Thread of this Project shares, newest first. '
        + 'Read it when you start a task, before you decide something another Thread may already have settled. '
        + 'Optional query keeps entries containing that text, ignoring case.'],
      ['memory_write', 'Add, update, or remove one entry of the Project memory, which every Thread of this Project reads. '
        + 'Write a decision other Threads will need: an agreed constraint, a date, who to ask, a convention you discovered. '
        + 'Do not store file contents, logs, or transient progress. Keep each entry to one short, self-contained fact. '
        + 'Returns the entry id; use it to update or remove the entry later.'],
    ])
  })

  it('tells the model when the session is not in a Project', async () => {
    const { ctx } = await mount()
    const lone = agentFor(ctx, 'lone')
    for (const [name, args] of [['memory_read', {}], ['memory_write', { action: 'add', text: 'x' }]] as const) {
      const { result, text } = await run(ctx, lone, name, args)
      expect(result.isError).toBe(true)
      expect(text).toContain('This session is not part of a Project, so it has no shared memory.')
    }
  })

  it('explains a missing service and a missing caller', async () => {
    const { ctx, project } = await mount({ service: false })
    const missing = await run(ctx, project, 'memory_read', {})
    expect(missing.result.isError).toBe(true)
    expect(missing.text).toContain('memory_read is unavailable: this deployment has no Project memory service')
    const withService = await mount()
    const noCaller = await run(withService.ctx, undefined, 'memory_write', { action: 'add', text: 'x' })
    expect(noCaller.text).toContain('memory_write requires a calling agent')
  })

  it('removes and reinstalls both tools across plugin HMR', async () => {
    const { ctx, toolFiber } = await mount()
    const names = () => ctx.tools.schemas().map(schema => schema.name).filter(name => name.startsWith('memory_')).sort()
    expect(names()).toEqual(['memory_read', 'memory_write'])
    await toolFiber!.dispose()
    expect(names()).toEqual([])
    const tools = await import('../src/tools.ts')
    await ctx.plugin(tools)
    expect(names()).toEqual(['memory_read', 'memory_write'])
  })
})
