import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, ReplayEnvelope } from '@deepseek-ai/dsh-llm'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { LlmError } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { PiAiAdapter, piAiResponseIdentity } from '@deepseek-ai/dsh-llm-pi-ai'
import { resolveProfiles } from '../src/config.ts'
import { toPiReplayState } from '../src/replay.ts'
import { memoryAuth } from './auth-double.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

afterEach(async () => {
  vi.unstubAllEnvs()
  await closeMockServers()
})

beforeEach(() => {
  vi.stubEnv('PI_TEST_KEY', 'test-key')
})

/** The smallest request that reaches the wire; the body is what these tests read. */
const REQUEST: GenerateOptions = {
  provider: 'gate',
  model: 'gate-large',
  messages: [],
}

async function harness(baseURL: string, overrides: Record<string, unknown> = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmPiAi, {
    providers: {
      gate: {
        apiKeyEnv: 'PI_TEST_KEY',
        baseURL,
        api: 'openai-completions',
        models: [{ id: 'gate-large', name: 'Gate Large', contextWindow: 131072, maxTokens: 4096 }],
        ...overrides,
      },
    },
  })
  return ctx
}

describe('ctx.piAiDispatch', () => {
  it('is provided while the fiber lives and withdrawn with it', async () => {
    const server = await mockServer([{ events: textEvents }])
    const ctx = await harness(server.url)
    expect(ctx.get('piAiDispatch')).toBeDefined()
    await ctx.fiber.dispose()
    expect(ctx.get('piAiDispatch')).toBeUndefined()
  })

  it('sends the per-call routing block verbatim', async () => {
    const server = await mockServer([{ events: textEvents }])
    const ctx = await harness(server.url)
    const dispatch = ctx.get('piAiDispatch')
    expect(dispatch).toBeDefined()
    const chunks: unknown[] = []
    for await (const chunk of dispatch!.stream(REQUEST, {
      openRouterRouting: { only: ['streamlake/fp8'], allow_fallbacks: false },
    })) chunks.push(chunk)
    expect(chunks.length).toBeGreaterThan(0)
    expect(server.requests).toHaveLength(1)
    expect((server.requests[0] as { provider?: unknown }).provider)
      .toEqual({ only: ['streamlake/fp8'], allow_fallbacks: false })
  })

  it('sends no provider block when none is dispatched', async () => {
    const server = await mockServer([{ events: textEvents }])
    const ctx = await harness(server.url)
    const chunks: unknown[] = []
    for await (const chunk of ctx.get('piAiDispatch')!.stream(REQUEST)) chunks.push(chunk)
    expect(chunks.length).toBeGreaterThan(0)
    expect('provider' in (server.requests[0] as Record<string, unknown>)).toBe(false)
  })

  it('refuses a routing block on a model that cannot send it', async () => {
    const server = await mockServer([])
    const adapter = new PiAiAdapter({
      profiles: () => resolveProfiles({
        gate: {
          apiKeyEnv: 'PI_TEST_KEY',
          baseURL: server.url,
          api: 'anthropic-messages',
          models: [{ id: 'gate-large', name: 'Gate Large', contextWindow: 131072, maxTokens: 4096 }],
        },
      }),
      resolveApiKey: () => Promise.resolve('test-key'),
      auth: memoryAuth(),
    })
    const iterator = adapter
      .dispatch(REQUEST, { openRouterRouting: { only: ['streamlake/fp8'], allow_fallbacks: false } })
      [Symbol.asyncIterator]()
    const error: unknown = await iterator.next().then(() => undefined, (reason: unknown) => reason)
    expect(error).toBeInstanceOf(LlmError)
    expect((error as LlmError).code).toBe('INVALID_CONFIG')
    expect((error as LlmError).message).toContain('cannot take an OpenRouter routing block')
    expect(server.requests).toHaveLength(0)
  })
})

describe('piAiResponseIdentity', () => {
  it('reads both identity fields off a pi-ai envelope', () => {
    const state: ReplayEnvelope = toPiReplayState({
      role: 'assistant',
      content: [],
      api: 'openai-completions',
      provider: 'openrouter',
      model: 'deepseek/deepseek-v4-flash',
      responseId: 'gen-1',
      responseModel: 'm',
      usage: {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
      timestamp: 0,
    })
    expect(piAiResponseIdentity(state)).toEqual({ responseId: 'gen-1', responseModel: 'm' })
  })

  it('returns undefined for a foreign envelope and for no envelope', () => {
    expect(piAiResponseIdentity({ response: { kind: 'other' } })).toBeUndefined()
    expect(piAiResponseIdentity(undefined)).toBeUndefined()
  })
})
