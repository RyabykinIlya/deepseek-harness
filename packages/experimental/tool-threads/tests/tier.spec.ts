/**
 * `thread_tier` over the same environment as the rest of the Threads tools:
 * real fold inputs in a real Project Session, and a recording stand-in for the
 * routing service so the cases read what the tool asked for rather than what a
 * router did with it.
 *
 * The tool's whole reason to exist is conditional, so the first cases are about
 * presence: absent service, no tool; service, tool; service withdrawn, no tool
 * again. Everything else is about what it refuses.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { ThreadId, ThreadsService } from '@deepseek-ai/dsh-experimental-threads'
import type { ModelRoutingControl } from '@deepseek-ai/dsh-experimental-model-routing'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as tool from '../src/index.ts'

const SIGNAL = new AbortController().signal

const roots: string[] = []
const contexts = new Set<Context>()

afterEach(async () => {
  for (const ctx of contexts) await ctx.fiber.dispose()
  contexts.clear()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** What the recording routing service was asked to do. */
interface RoutingCalls { project: unknown; threadId: string; tier: string }

/** Mount the tools, the Threads domain, and one Project Session owning one Thread. */
async function setup(): Promise<{ ctx: Context; project: Agent; fiber: Fiber; calls: RoutingCalls[] }> {
  const ctx = new Context()
  contexts.add(ctx)
  await mountAgentLoopTestDependencies(ctx)
  const root = mkdtempSync(join(tmpdir(), 'dsh-thread-tier-'))
  roots.push(root)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(ThreadsService)
  const fiber = await ctx.plugin(tool)
  ctx.llm.registerAdapter(['mock'], new MockAdapter([]))
  const project = await ctx.agentLoop.create(SessionId('project'), { provider: 'mock', model: 'mock' })
  project.session.append('thread/created', { threadId: ThreadId('t1'), label: 'port auth' }, { ignorable: true })
  return { ctx, project, fiber, calls: [] }
}

/** Provide a recording `modelRouting` service for as long as the returned fiber lives. */
async function provideRouting(
  ctx: Context,
  calls: RoutingCalls[],
  fail?: (threadId: string, tier: string) => void,
): Promise<() => Promise<void>> {
  const control: ModelRoutingControl = {
    tierNames: () => ['pro', 'flash'],
    setThreadTier(project, threadId, tier) {
      if (fail !== undefined) fail(threadId, tier)
      calls.push({ project: project.id, threadId, tier })
    },
  }
  // `ctx.effect` returns its own disposer, which withdraws the value it provided.
  const withdraw = ctx.effect(() => ctx.reflect.provide('modelRouting', control), 'test: modelRouting')
  await settle()
  return async () => {
    await withdraw()
    await settle()
  }
}

/** Let Cordis run the injections a provided or disposed service triggers. */
async function settle(): Promise<void> {
  for (let tick = 0; tick < 5; tick += 1) await new Promise((resolve) => { setImmediate(resolve) })
}

let callNumber = 0

/** Execute `thread_tier` as the given calling agent. */
function callTier(ctx: Context, agent: Agent, args: unknown) {
  return ctx.tools.execute({
    signal: SIGNAL,
    callId: ToolCallId(`tier-${++callNumber}`),
    name: 'thread_tier',
    arguments: args,
    agent,
  })
}

/** The text blocks of one rendered tool result. */
function text(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

describe('conditional registration', () => {
  it('offers no tool while no routing service is loaded', async () => {
    const { ctx } = await setup()
    expect(ctx.tools.get('thread_tier')).toBeUndefined()
  })

  it('offers the tool once the service appears, and withdraws it again', async () => {
    const { ctx } = await setup()
    const withdrawFirst = await provideRouting(ctx, [])
    // `ctx.inject` runs on the tick the service appears, not inside `provide`.
    await settle()
    expect(ctx.tools.get('thread_tier')).toBeDefined()
    await withdrawFirst()
    await settle()
    expect(ctx.tools.get('thread_tier')).toBeUndefined()

    const withdrawSecond = await provideRouting(ctx, [])
    await settle()
    expect(ctx.tools.get('thread_tier')).toBeDefined()
    await withdrawSecond()
    await settle()
    expect(ctx.tools.get('thread_tier')).toBeUndefined()
  })
})

describe('switching a Thread', () => {
  it('records the switch on the calling Project and renders the outcome', async () => {
    const { ctx, project, calls } = await setup()
    await provideRouting(ctx, calls)

    const result = await callTier(ctx, project, { thread_id: 't1', tier: 'pro' })

    expect(result.isError).toBe(false)
    expect(calls).toEqual([{ project: project.session.id, threadId: 't1', tier: 'pro' }])
    expect(text(result)).toBe('Thread t1 switches to tier pro from its next model request.')
  })

  it('refuses a Thread this Project does not own, in the words thread_diff uses', async () => {
    const { ctx, project, calls } = await setup()
    await provideRouting(ctx, calls)

    const result = await callTier(ctx, project, { thread_id: 't-other', tier: 'pro' })

    expect(result.isError).toBe(true)
    expect(text(result)).toContain('unknown thread id t-other; call thread_status to list this Project\'s threads')
    expect(calls).toEqual([])
  })

  it('passes the routing service\'s own refusal through unchanged', async () => {
    const { ctx, project, calls } = await setup()
    await provideRouting(ctx, calls, (_threadId, tier) => {
      throw new Error(`model-routing: unknown tier "${tier}"; configured tiers: pro, flash`)
    })

    const result = await callTier(ctx, project, { thread_id: 't1', tier: 'max' })

    expect(result.isError).toBe(true)
    expect(text(result)).toContain('model-routing: unknown tier "max"; configured tiers: pro, flash')
    expect(calls).toEqual([])
  })

  it('needs a calling agent', async () => {
    const { ctx, calls } = await setup()
    await provideRouting(ctx, calls)
    const result = await ctx.tools.execute({
      signal: SIGNAL,
      callId: ToolCallId('tier-no-agent'),
      name: 'thread_tier',
      arguments: { thread_id: 't1', tier: 'pro' },
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('thread_tier requires a calling agent')
  })
})
