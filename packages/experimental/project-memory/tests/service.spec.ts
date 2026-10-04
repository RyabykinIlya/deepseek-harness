import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { MemoryMediaPool } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { ProjectMemoryError } from '../src/index.ts'
import type { MemoryEntryId, ProjectId } from '../src/index.ts'
import { agentFor, harness, selectPreset } from './harness.ts'

const P = 'proj' as ProjectId
const contexts: Context[] = []

async function mount(options: Parameters<typeof harness>[0] = {}) {
  const mounted = await harness({ tools: false, ...options })
  contexts.push(mounted.ctx)
  return mounted
}

afterEach(async () => {
  vi.useRealTimers()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

async function refusal(work: Promise<unknown>): Promise<ProjectMemoryError> {
  try { await work } catch (error) {
    if (error instanceof ProjectMemoryError) return error
    throw error
  }
  throw new Error('expected a ProjectMemoryError')
}

async function failureOf(work: Promise<unknown>) {
  try { await work } catch (error: unknown) { return remoteErrorOf(error) }
  return undefined
}

describe('ProjectMemoryService CRUD', () => {
  it('adds, lists newest first, updates, and removes per Project', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { ctx } = await mount()
    vi.setSystemTime(1000)
    const a = await ctx.projectMemory.add(P, '  first  ', 'coordinator')
    vi.setSystemTime(2000)
    const b = await ctx.projectMemory.add(P, 'second', 'thread')
    await ctx.projectMemory.add('other' as ProjectId, 'foreign', 'user')
    expect(a.text).toBe('first')
    expect((await ctx.projectMemory.list(P)).map(entry => entry.id)).toEqual([b.id, a.id])

    vi.setSystemTime(3000)
    const updated = await ctx.projectMemory.update(P, a.id, 'first v2', 'user')
    expect(updated).toMatchObject({ author: 'user', createdAt: 1000, updatedAt: 3000 })
    expect((await ctx.projectMemory.list(P)).map(entry => entry.id)).toEqual([a.id, b.id])

    await ctx.projectMemory.remove(P, b.id)
    expect((await ctx.projectMemory.list(P)).map(entry => entry.id)).toEqual([a.id])
  })

  it('refuses entries of other Projects and unknown ids with an actionable message', async () => {
    const { ctx } = await mount()
    const entry = await ctx.projectMemory.add(P, 'x', 'user')
    const wrong = await refusal(ctx.projectMemory.update('other' as ProjectId, entry.id, 'y', 'user'))
    expect(wrong.code).toBe('not-found')
    expect(wrong.message).toBe(`No memory entry "${entry.id}" exists in this Project. Call memory_read to see the current ids.`)
    expect((await refusal(ctx.projectMemory.remove(P, 'nope' as MemoryEntryId))).code).toBe('not-found')
  })

  it('records the writing Session', async () => {
    const { ctx } = await mount()
    const entry = await ctx.projectMemory.add(P, 'x', 'thread', 's1' as never)
    expect(entry.authorSessionId).toBe('s1')
    const next = await ctx.projectMemory.update(P, entry.id, 'y', 'user')
    expect(next.authorSessionId).toBeUndefined()
  })
})

describe('ProjectMemoryService limits', () => {
  it('accepts exactly maxEntryChars code points and refuses one more', async () => {
    const { ctx } = await mount({ config: { maxEntryChars: 5 } })
    await ctx.projectMemory.add(P, '😀😀😀😀😀', 'user')
    await ctx.projectMemory.add(P, 'abcde', 'user')
    const error = await refusal(ctx.projectMemory.add(P, '😀😀😀😀😀😀', 'user'))
    expect(error.code).toBe('text-too-long')
    expect(error.message).toBe('The memory text is 6 characters; the limit is 5. Shorten it or split it into separate entries.')
    expect((await refusal(ctx.projectMemory.update(P, (await ctx.projectMemory.list(P))[0]!.id, 'abcdef', 'user'))).code).toBe('text-too-long')
  })

  it('refuses empty text', async () => {
    const { ctx } = await mount()
    expect((await refusal(ctx.projectMemory.add(P, '  \n', 'user'))).code).toBe('empty-text')
  })

  it('holds exactly maxEntries per Project, also under concurrent writers', async () => {
    const { ctx } = await mount({ config: { maxEntries: 3 } })
    const results = await Promise.allSettled(Array.from({ length: 5 }, (_, index) => ctx.projectMemory.add(P, `e${index}`, 'user')))
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(3)
    const failure = results.find(result => result.status === 'rejected')
    expect((failure as PromiseRejectedResult).reason).toMatchObject({ code: 'entry-limit' })
    await ctx.projectMemory.add('other' as ProjectId, 'separate cap', 'user')
    const [first] = await ctx.projectMemory.list(P)
    await ctx.projectMemory.remove(P, first!.id)
    await ctx.projectMemory.add(P, 'fits again', 'user')
  })
})

describe('ProjectMemoryService persistence', () => {
  it('serves entries after the Host restarts over the same medium', async () => {
    const pool = new MemoryMediaPool()
    const first = await mount({ pool })
    const entry = await first.ctx.projectMemory.add(P, 'durable', 'coordinator')
    await first.ctx.fiber.dispose()
    const second = await mount({ pool })
    expect(await second.ctx.projectMemory.list(P)).toEqual([entry])
  })
})

describe('ProjectMemoryService project resolution', () => {
  it('resolves a coordinator to itself and walks threads and helpers up to it', async () => {
    const { ctx } = await mount()
    const project = agentFor(ctx, 'p', { agentPreset: 'project' })
    const thread = agentFor(ctx, 't', { agentPreset: 'project-thread', parentSession: 'p' })
    const helper = agentFor(ctx, 'h', { parentSession: 't' })
    expect(await ctx.projectMemory.resolveProject(project.session)).toBe('p')
    expect(await ctx.projectMemory.resolveProject(thread.session)).toBe('p')
    expect(await ctx.projectMemory.resolveProject(helper.session)).toBe('p')
  })

  it('resolves a Project switched to its preset after creation', async () => {
    // How the New Project button composes a Session: created under the deployment
    // default, then recomposed before the first turn. The creation header stays frozen
    // on the default, so reading it alone refuses a real Project.
    const { ctx } = await mount({ projections: true })
    const project = agentFor(ctx, 'p', { agentPreset: 'standard' })
    selectPreset(project, 'project')
    expect(project.session.header.agentPreset).toBe('standard')
    expect(await ctx.projectMemory.resolveProject(project.session)).toBe('p')
  })

  it('resolves a Thread whose live Project was switched after creation', async () => {
    const { ctx } = await mount({ projections: true })
    const project = agentFor(ctx, 'p', { agentPreset: 'standard' })
    selectPreset(project, 'project')
    const thread = agentFor(ctx, 't', { agentPreset: 'project-thread', parentSession: 'p' })
    expect(await ctx.projectMemory.resolveProject(thread.session)).toBe('p')
  })

  it('stops resolving a Project switched away from its preset', async () => {
    const { ctx } = await mount({ projections: true })
    const project = agentFor(ctx, 'p', { agentPreset: 'project' })
    selectPreset(project, 'standard')
    await expect(ctx.projectMemory.resolveProject(project.session)).rejects.toMatchObject({ code: 'not-in-project' })
  })

  it('honours a switched preset that the configuration does not name', async () => {
    const { ctx } = await mount({ projections: true, config: { projectPresets: ['lead'] } })
    const lead = agentFor(ctx, 'l', { agentPreset: 'standard' })
    selectPreset(lead, 'lead')
    const old = agentFor(ctx, 'o', { agentPreset: 'standard' })
    selectPreset(old, 'project')
    expect(await ctx.projectMemory.resolveProject(lead.session)).toBe('l')
    await expect(ctx.projectMemory.resolveProject(old.session)).rejects.toMatchObject({ code: 'not-in-project' })
  })

  it('falls back to the header when the projection registry is absent', async () => {
    const { ctx } = await mount()
    expect(ctx.get('sessionProjections')).toBeUndefined()
    const project = agentFor(ctx, 'p', { agentPreset: 'project' })
    expect(await ctx.projectMemory.resolveProject(project.session)).toBe('p')
  })

  it('falls back to the header when no preset unit is registered', async () => {
    const { ctx } = await mount({ projections: true })
    ctx.sessionProjections.stateOf(agentFor(ctx, 'x', { agentPreset: 'standard' }).session, 'agentPreset')
    const project = agentFor(ctx, 'p', { agentPreset: 'project' })
    expect(await ctx.projectMemory.resolveProject(project.session)).toBe('p')
  })

  it('honours configured project presets', async () => {
    const { ctx } = await mount({ config: { projectPresets: ['lead'] } })
    const lead = agentFor(ctx, 'l', { agentPreset: 'lead' })
    const old = agentFor(ctx, 'o', { agentPreset: 'project' })
    expect(await ctx.projectMemory.resolveProject(lead.session)).toBe('l')
    await expect(ctx.projectMemory.resolveProject(old.session)).rejects.toMatchObject({ code: 'not-in-project' })
  })

  it('fails with the model-facing message outside a Project', async () => {
    const { ctx } = await mount()
    const lone = agentFor(ctx, 'lone')
    await expect(ctx.projectMemory.resolveProject(lone.session)).rejects.toThrow(
      'This session is not part of a Project, so it has no shared memory. Keep notes in your own reply instead.',
    )
  })

  it('bounds the walk by maxLineageDepth', async () => {
    const { ctx } = await mount({ config: { maxLineageDepth: 2 } })
    agentFor(ctx, 'p', { agentPreset: 'project' })
    agentFor(ctx, 'c1', { parentSession: 'p' })
    const c2 = agentFor(ctx, 'c2', { parentSession: 'c1' })
    const c3 = agentFor(ctx, 'c3', { parentSession: 'c2' })
    expect(await ctx.projectMemory.resolveProject(c2.session)).toBe('p')
    await expect(ctx.projectMemory.resolveProject(c3.session)).rejects.toThrow(/within 2 levels/)
  })

  it('reports an ancestor that is not live', async () => {
    const { ctx } = await mount()
    const orphan = agentFor(ctx, 'orphan', { parentSession: 'gone' })
    await expect(ctx.projectMemory.resolveProject(orphan.session)).rejects.toThrow(/parent session "gone" does not exist/)
  })

  it('resolves a Thread whose Project Session is only persisted', async () => {
    const { ctx } = await mount({ persisted: { p: { agentPreset: 'project' } } })
    const thread = agentFor(ctx, 't', { agentPreset: 'project-thread', parentSession: 'p' })
    expect(await ctx.projectMemory.resolveProject(thread.session)).toBe('p')
  })

  it('walks a chain mixing live and persisted ancestors', async () => {
    const { ctx } = await mount({
      persisted: { p: { agentPreset: 'project' }, mid: { parentSession: 'p' } },
    })
    agentFor(ctx, 'live', { parentSession: 'mid' })
    const leaf = agentFor(ctx, 'leaf', { parentSession: 'live' })
    expect(await ctx.projectMemory.resolveProject(leaf.session)).toBe('p')
  })

  it('reports a parent that is neither live nor persisted', async () => {
    const { ctx } = await mount({ persisted: {} })
    const orphan = agentFor(ctx, 'orphan', { parentSession: 'gone' })
    await expect(ctx.projectMemory.resolveProject(orphan.session)).rejects.toMatchObject({ code: 'lineage-unavailable' })
  })

  it('stays live-only without a session persistence service', async () => {
    const { ctx } = await mount()
    expect(ctx.get('sessionPersistence')).toBeUndefined()
    const thread = agentFor(ctx, 't', { parentSession: 'p' })
    await expect(ctx.projectMemory.resolveProject(thread.session)).rejects.toMatchObject({ code: 'lineage-unavailable' })
  })

  it('bounds the walk across persisted hops', async () => {
    const { ctx } = await mount({
      config: { maxLineageDepth: 2 },
      persisted: { p: { agentPreset: 'project' }, c1: { parentSession: 'p' }, c2: { parentSession: 'c1' } },
    })
    const near = agentFor(ctx, 'near', { parentSession: 'c1' })
    const far = agentFor(ctx, 'far', { parentSession: 'c2' })
    expect(await ctx.projectMemory.resolveProject(near.session)).toBe('p')
    await expect(ctx.projectMemory.resolveProject(far.session)).rejects.toMatchObject({ code: 'lineage-too-deep' })
  })
})

describe('ProjectMemoryService remote methods', () => {
  it('lets a user add, edit, read, and remove entries', async () => {
    const { ctx } = await mount()
    const added = await ctx.projectMemory.remoteAdd({ projectId: P, text: 'from panel' })
    expect(added.author).toBe('user')
    const edited = await ctx.projectMemory.remoteUpdate({ projectId: P, id: added.id, text: 'edited' })
    expect(edited.text).toBe('edited')
    expect(await ctx.projectMemory.remoteList({ projectId: P })).toEqual([edited])
    await ctx.projectMemory.remoteDelete({ projectId: P, id: added.id })
    expect(await ctx.projectMemory.remoteList({ projectId: P })).toEqual([])
  })

  it('reports refusals as project-memory/refused Remote failures', async () => {
    const { ctx } = await mount({ config: { maxEntryChars: 3 } })
    const failures = await Promise.all([
      failureOf(ctx.projectMemory.remoteAdd({ projectId: P, text: 'toolong' })),
      failureOf(ctx.projectMemory.remoteUpdate({ projectId: P, id: 'x' as MemoryEntryId, text: 'ok' })),
      failureOf(ctx.projectMemory.remoteDelete({ projectId: P, id: 'x' as MemoryEntryId })),
    ])
    expect(failures.map(failure => failure?.code)).toEqual(['project-memory/refused', 'project-memory/refused', 'project-memory/refused'])
    expect(failures.map(failure => failure?.details)).toEqual([
      { reason: 'text-too-long' }, { reason: 'not-found' }, { reason: 'not-found' },
    ])
  })

  it('rethrows non-refusal failures unchanged', async () => {
    const { ctx } = await mount()
    vi.spyOn(ctx.projectMemory, 'add').mockRejectedValue(new Error('disk'))
    await expect(ctx.projectMemory.remoteAdd({ projectId: P, text: 'x' })).rejects.toThrow('disk')
  })
})
