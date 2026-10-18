import { Context } from '@deepseek-ai/cordis'
import { it, expect } from 'vitest'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
it('probe with deps', async () => {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  console.log('wd?', ctx.get('workingDirectory') !== undefined, 'agents?', ctx.get('agents') !== undefined)
  const f = await ctx.plugin(SubagentRuntime)
  console.log('subagents?', ctx.get('subagents') !== undefined)
  expect(f).toBeDefined()
})
