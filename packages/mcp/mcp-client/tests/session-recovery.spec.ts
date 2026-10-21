import { describe, expect, it, vi } from 'vitest'
import { SdkErrorCode, SdkHttpError } from '@modelcontextprotocol/client'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { isExpiredSessionError, syncTools } from '@deepseek-ai/dsh-mcp-client/src/tools.ts'
import type { ToolBridgeOptions } from '@deepseek-ai/dsh-mcp-client/src/tools.ts'

const testToolSignal = new AbortController().signal

/** The exact error the streamable-HTTP transport raises for a session the server dropped. */
function expiredSessionError(): SdkHttpError {
  return new SdkHttpError(
    SdkErrorCode.ClientHttpNotImplemented,
    'Error POSTing to endpoint: {"jsonrpc":"2.0","id":"server-error","error":{"code":-32600,"message":"Session not found"}}',
    { status: 404, statusText: 'Not Found' },
  )
}

const tool = { name: 'lookup', inputSchema: { type: 'object' as const } }

async function mount(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  return ctx
}

function opts(recoverSession?: ToolBridgeOptions['recoverSession']): ToolBridgeOptions {
  return {
    registrationFailure: 'contain',
    serverName: 'srv',
    toolCallTimeoutMs: 5_000,
    ...(recoverSession === undefined ? {} : { recoverSession }),
  }
}

function clientWith(callTool: (params: unknown, options: unknown) => Promise<unknown>) {
  return {
    getServerCapabilities: () => ({ tools: {} }),
    listTools: async () => ({ tools: [tool], nextCursor: undefined }),
    callTool: vi.fn(callTool),
  }
}

describe('isExpiredSessionError', () => {
  it('recognizes the 404 session-not-found rejection', () => {
    expect(isExpiredSessionError(expiredSessionError())).toBe(true)
  })

  it('rejects a 404 that is not a session expiry', () => {
    const routing = new SdkHttpError(
      SdkErrorCode.ClientHttpNotImplemented,
      'Error POSTing to endpoint: nginx 404',
      { status: 404 },
    )
    expect(isExpiredSessionError(routing)).toBe(false)
  })

  it('rejects a session-not-found message carried by another status', () => {
    const wrongStatus = new SdkHttpError(
      SdkErrorCode.ClientHttpNotImplemented,
      'Error POSTing to endpoint: Session not found',
      { status: 500 },
    )
    expect(isExpiredSessionError(wrongStatus)).toBe(false)
  })

  it('rejects errors that are not SDK HTTP errors', () => {
    expect(isExpiredSessionError(new Error('Session not found'))).toBe(false)
    expect(isExpiredSessionError('Session not found')).toBe(false)
  })
})

describe('syncTools session recovery', () => {
  it('retries on the recovering client after the server drops the session', async () => {
    const ctx = await mount()
    const stale = clientWith(async () => { throw expiredSessionError() })
    const fresh = clientWith(async () => ({ content: [{ type: 'text', text: 'recovered' }] }))
    const recoverSession = vi.fn(async () => fresh as never)

    await syncTools(stale as never, ctx, opts(recoverSession), new Map())
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('c1'),
      name: 'mcp__srv__lookup',
      arguments: {},
    })

    expect(recoverSession).toHaveBeenCalledTimes(1)
    expect(fresh.callTool).toHaveBeenCalledTimes(1)
    expect(result.content[0]).toEqual({ type: 'text', text: 'recovered' })
  })

  it('rethrows the original error when no replacement client became available', async () => {
    const ctx = await mount()
    const stale = clientWith(async () => { throw expiredSessionError() })

    await syncTools(stale as never, ctx, opts(async () => undefined), new Map())
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('c2'),
      name: 'mcp__srv__lookup',
      arguments: {},
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.type === 'text' ? result.content[0].text : '').toMatch(/Session not found/)
  })

  it('does not retry an expired session when no recovery hook is configured', async () => {
    const ctx = await mount()
    const stale = clientWith(async () => { throw expiredSessionError() })

    await syncTools(stale as never, ctx, opts(), new Map())
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('c3'),
      name: 'mcp__srv__lookup',
      arguments: {},
    })
    expect(result.isError).toBe(true)
    expect(stale.callTool).toHaveBeenCalledTimes(1)
  })

  it('does not retry an unrelated failure', async () => {
    const ctx = await mount()
    const failing = clientWith(async () => { throw new Error('boom') })
    const recoverSession = vi.fn(async () => undefined)

    await syncTools(failing as never, ctx, opts(recoverSession), new Map())
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('c4'),
      name: 'mcp__srv__lookup',
      arguments: {},
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.type === 'text' ? result.content[0].text : '').toMatch(/boom/)
    expect(recoverSession).not.toHaveBeenCalled()
  })
})
