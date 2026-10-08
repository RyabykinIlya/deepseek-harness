/** Provider-supplied `cwd` and `agentPreset` on a continuable child, plus the child's return guidance. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import SubagentRuntime from '../src/index.ts'
import type { ContinuableCreateSpec } from '../src/index.ts'
import { continuationManager } from './continuation-internals.ts'
import { loadStoredSession } from './persistence-helpers.ts'
import { TestSessionQuery } from './test-session-query.ts'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const PRESET_ROW = pathToFileURL(join(FIXTURES, 'plugins/preset-tool.js')).href
const signal = new AbortController().signal

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** A real preset registry with two presets, persistence, and a provider returning `spec`. */
async function setup(spec: () => ContinuableCreateSpec, parentCwd?: string) {
  const ctx = new Context()
  const root = mkdtempSync(join(tmpdir(), 'dsh-subagent-provider-spec-'))
  cleanups.push(async () => {
    await ctx.fiber.dispose()
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  ctx.baseUrl = pathToFileURL(FIXTURES).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(AgentPresets, { default: 'coding' })
  for (const [id, tool] of [['coding', 'coding_tool'], ['reviewing', 'reviewing_tool']] as const) {
    await ctx.agentPresets.register({ id, plugins: [{ name: PRESET_ROW, config: { tool } }] })
  }
  const adapter = new MockAdapter([textResponse('parent idle'), textResponse('child one'), textResponse('child two')])
  ctx.llm.registerAdapter(['mock'], adapter)
  const prepare = vi.fn(() => Promise.resolve(spec()))
  ctx.subagents.registerProvider({
    name: 'custom',
    capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false, repository: false },
    inheritsParentContext: false,
    start: () => Promise.reject(new Error('one-shot start is not used')),
    prepareContinuable: prepare,
  })
  const handle = await ctx.agents.create({
    sessionId: SessionId('parent'),
    agentOptions: { provider: 'mock', model: 'mock' },
    ...parentCwd === undefined ? {} : { meta: { cwd: parentCwd } },
    setup: async (agentCtx: Context) => void await ctx.agentPresets.mount(agentCtx, 'coding'),
  })
  return { ctx, adapter, parent: handle.agent, prepare }
}

function start(ctx: Context, parent: Agent) {
  return ctx.subagents.startContinuable({
    provider: 'custom',
    label: 'child task',
    request: { prompt: [{ type: 'text', text: 'child task' }], parent },
    signal,
  })
}

async function settled(ctx: Context, childId: SessionId): Promise<void> {
  await vi.waitFor(() => { expect(ctx.agents.get(childId)).toBeUndefined() }, { timeout: 5_000 })
}

describe('provider-supplied cwd', () => {
  it('persists the provider cwd on the child header', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-child-cwd-'))
    cleanups.push(() => { rmSync(dir, { recursive: true, force: true }); return Promise.resolve() })
    const { ctx, parent } = await setup(() => ({ cwd: dir }), '/')
    const { childId } = await start(ctx, parent)
    expect(ctx.agents.get(childId)?.session.header.cwd).toBe(dir)
    await settled(ctx, childId)
    const stored = await loadStoredSession(ctx.sessionPersistence, childId)
    expect(stored.meta.cwd).toBe(dir)
  })

  it('inherits the parent cwd when the provider returns only a seed', async () => {
    const { ctx, parent } = await setup(() => ({ seed: [] }), tmpdir())
    const { childId } = await start(ctx, parent)
    expect(ctx.agents.get(childId)?.session.header.cwd).toBe(tmpdir())
    await settled(ctx, childId)
    const stored = await loadStoredSession(ctx.sessionPersistence, childId)
    expect(stored.meta.cwd).toBe(tmpdir())
  })

  it('rejects a relative cwd before any child exists', async () => {
    const { ctx, parent } = await setup(() => ({ cwd: 'relative/dir' }))
    await expect(start(ctx, parent)).rejects.toMatchObject({ code: 'INVALID_PROVIDER_CWD' })
    expect(ctx.agents.list().map(agent => agent.id)).toEqual([SessionId('parent')])
  })

  it('rejects a cwd that is not an existing directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-child-cwd-'))
    cleanups.push(() => { rmSync(dir, { recursive: true, force: true }); return Promise.resolve() })
    const file = join(dir, 'plain.txt')
    writeFileSync(file, 'x')
    for (const cwd of [file, join(dir, 'missing')]) {
      const { ctx, parent } = await setup(() => ({ cwd }))
      await expect(start(ctx, parent)).rejects.toMatchObject({ code: 'INVALID_PROVIDER_CWD' })
      expect(ctx.agents.list().map(agent => agent.id)).toEqual([SessionId('parent')])
    }
  })

  it('restores the header cwd on cold resume without asking the provider again', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-child-cwd-'))
    cleanups.push(() => { rmSync(dir, { recursive: true, force: true }); return Promise.resolve() })
    const { ctx, parent, prepare } = await setup(() => ({ cwd: dir }))
    const { childId } = await start(ctx, parent)
    await settled(ctx, childId)
    await continuationManager(ctx).queuePrompt(parent, childId, [{ type: 'text', text: 'again' }], { kind: 'user' }, signal)
    expect(ctx.agents.get(childId)?.session.header.cwd).toBe(dir)
    await settled(ctx, childId)
    expect(prepare).toHaveBeenCalledTimes(1)
  })
})

describe('provider-supplied agentPreset', () => {
  it('composes the child from the override preset, not the parent preset', async () => {
    const { ctx, parent } = await setup(() => ({ agentPreset: 'reviewing' }))
    const { childId } = await start(ctx, parent)
    const child = ctx.agents.get(childId)!
    expect(child.session.header.agentPreset).toBe('reviewing')
    expect(ctx.agentPresets.composedPreset(child.ctx)).toBe('reviewing')
    expect(ctx.tools.schemas(child).map(schema => schema.name)).toEqual(['reviewing_tool'])
    await settled(ctx, childId)
    const stored = await loadStoredSession(ctx.sessionPersistence, childId)
    const system = JSON.stringify(stored.events.filter(event => event.type === 'system/message'))
    expect(system).toContain('section for reviewing_tool')
    expect(system).not.toContain('section for coding_tool')
  })

  it('keeps the parent preset when the provider names none', async () => {
    const { ctx, parent } = await setup(() => ({}))
    const { childId } = await start(ctx, parent)
    const child = ctx.agents.get(childId)!
    expect(child.session.header.agentPreset).toBe('coding')
    expect(ctx.tools.schemas(child).map(schema => schema.name)).toEqual(['coding_tool'])
    await settled(ctx, childId)
  })

  it('cold-resumes the child on the override preset recorded in its header', async () => {
    const { ctx, parent, prepare } = await setup(() => ({ agentPreset: 'reviewing' }))
    const { childId } = await start(ctx, parent)
    await settled(ctx, childId)
    await continuationManager(ctx).queuePrompt(parent, childId, [{ type: 'text', text: 'again' }], { kind: 'user' }, signal)
    const resumed = ctx.agents.get(childId)!
    expect(ctx.tools.schemas(resumed).map(schema => schema.name)).toEqual(['reviewing_tool'])
    await settled(ctx, childId)
    expect(prepare).toHaveBeenCalledTimes(1)
  })

  it('fails loud at start for an unknown preset id', async () => {
    const { ctx, parent } = await setup(() => ({ agentPreset: 'missing' }))
    await expect(start(ctx, parent)).rejects.toMatchObject({ code: 'UNKNOWN_AGENT_PRESET' })
    expect(ctx.agents.list().map(agent => agent.id)).toEqual([SessionId('parent')])
  })
})
