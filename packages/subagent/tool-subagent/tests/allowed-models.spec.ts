import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { mountWorkingDirectoryFixture } from '../../subagent/tests/working-directory-fixture.ts'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as mock from './scripted-provider.ts'
import * as tool from '../src/index.ts'
import { callSubagent, setup, text } from './harness.ts'

const TIERS = [
  { provider: 'tiers', model: 'flash' },
  { provider: 'tiers', model: 'pro' },
]

/**
 * Mount the real tool over a route set the LLM runtime already owns.
 *
 * The ordinary `setup()` path registers no adapter, so a configured
 * `allowedModels` list would fail preflight against a route nobody serves. This
 * one declares `tiers` up front and hands the adapter back for assertions.
 * @param requests - collects each child start request.
 * @returns the context and the adapter serving `tiers`.
 */
async function setupWithRoutes(requests: SubagentStartRequest[]): Promise<{ ctx: Context; adapter: MockAdapter }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await mountWorkingDirectoryFixture(ctx)
  await ctx.plugin(SubagentRuntime)
  await mock.mountScriptedProvider(ctx, { name: 'mock', onStart: (request) => { requests.push(request) } })
  const adapter = new MockAdapter([])
  ctx.llm.registerAdapter(['tiers'], adapter)
  await ctx.plugin(tool, { provider: 'mock', allowedModels: TIERS })
  return { ctx, adapter }
}

describe('tool-subagent allowedModels', () => {
  it('exposes the configured routes and mounts route discovery', async () => {
    const { ctx } = await setupWithRoutes([])
    const schema = ctx.tools.schemas().find(entry => entry.name === 'subagent')!
    const props = (schema.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    expect(Object.keys(props).sort()).toEqual([
      'cwd',
      'description',
      'model',
      'prompt',
      'provider',
      'reasoning_effort',
      'run_in_background',
    ])
    expect(ctx.tools.get('list_subagent_models')).toBeDefined()
  })

  it('rejects a route outside the configured list', async () => {
    const requests: SubagentStartRequest[] = []
    const { ctx } = await setupWithRoutes(requests)
    const result = await callSubagent(ctx, {
      description: 'too strong',
      prompt: 'do it',
      provider: 'tiers',
      model: 'max',
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('child LLM route "tiers/max" is not allowed for this Session')
    expect(requests).toHaveLength(0)
  })

  it('starts the child on a configured route and records no Session policy event', async () => {
    const requests: SubagentStartRequest[] = []
    const policies: string[] = []
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await mountWorkingDirectoryFixture(ctx)
    await ctx.plugin(SubagentRuntime)
    await mock.mountScriptedProvider(ctx, { name: 'mock', onStart: (request) => { requests.push(request) } })
    ctx.llm.registerAdapter(['tiers'], new MockAdapter([]))
    ctx.on('session/event', (_session, event) => {
      if (event.type === 'subagent/model-selection-policy') policies.push(event.type)
    })
    await ctx.plugin(tool, { provider: 'mock', allowedModels: TIERS })

    const result = await callSubagent(ctx, {
      description: 'routine work',
      prompt: 'do it',
      provider: 'tiers',
      model: 'flash',
    })

    expect(result.isError).toBe(false)
    expect(requests[0]?.agentOptions).toMatchObject({ provider: 'tiers', model: 'flash' })
    // The configuration is the policy, so nothing is written to any Session log.
    expect(policies).toEqual([])
  })

  it('refuses to mount next to modelSelectionSettings', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await mountWorkingDirectoryFixture(ctx)
    await ctx.plugin(SubagentRuntime)
    await mock.mountScriptedProvider(ctx, { name: 'mock' })
    await expect(ctx.plugin(tool, {
      provider: 'mock',
      allowedModels: TIERS,
      modelSelectionSettings: true,
    })).rejects.toThrow('`allowedModels` and `modelSelectionSettings` are mutually exclusive')
  })

  it('treats an empty list as no effect', async () => {
    const ctx = await setup({ provider: 'mock', allowedModels: [] })
    const schema = ctx.tools.schemas().find(entry => entry.name === 'subagent')!
    const props = (schema.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    expect(Object.keys(props).sort()).toEqual(['cwd', 'description', 'prompt', 'run_in_background'])
    expect(ctx.tools.get('list_subagent_models')).toBeUndefined()
  })
})
