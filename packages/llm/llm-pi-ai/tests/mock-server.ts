import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'

export interface MockServer {
  url: string
  paths: string[]
  requests: unknown[]
  headers: IncomingMessage['headers'][]
  readonly closedResponses: number
  requestReceived: Promise<void>
  responseClosed: Promise<void>
}
/** One scripted reply: either a status/body pair or a scripted SSE event list. */
export interface MockBehavior {
  status?: number
  events?: string[]
  body?: string
  delayMs?: number
  /** Keep the SSE response open after its scripted events until the client disconnects. */
  holdOpen?: boolean
  headers?: Record<string, string>
}

const servers: Server[] = []

/** Close every listener and connection opened since the last call; run from each spec's afterEach. */
export async function closeMockServers(): Promise<void> {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
    server.close(() => { resolve() })
    server.closeAllConnections()
  })))
}

/** A minimal complete text generation in pi-ai's chat-completions shape. */
export const textEvents = [
  '{"choices":[{"delta":{"role":"assistant","content":""},"index":0,"finish_reason":null}]}',
  '{"choices":[{"delta":{"content":"hello"},"index":0,"finish_reason":null}]}',
  '{"choices":[{"delta":{},"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}',
  '[DONE]',
]

/** A minimal complete text generation in pi-ai's anthropic-messages shape. */
export const anthropicTextEvents = [
  '{"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"deepseek-flash","content":[],"stop_reason":null,"usage":{"input_tokens":3,"output_tokens":0}}}',
  '{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}',
  '{"type":"content_block_stop","index":0}',
  '{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
  '{"type":"message_stop"}',
]

/** The key a request carried in its `Authorization` header, or undefined when it carried none. */
function bearerCredential(headers: IncomingMessage['headers']): string | undefined {
  const value = headers.authorization
  if (typeof value !== 'string' || !value.startsWith('Bearer ')) return undefined
  return value.slice('Bearer '.length)
}

/**
 * Local provider stand-in: replays scripted behaviors per request.
 *
 * A behavior may branch on the credential the request carried, which is what
 * lets one server answer two API keys differently — the shape key rotation is
 * observed through, since the keys themselves never appear in a request body.
 * @param script - one behavior per request, or one keyed behavior per credential.
 * @returns the running server and the observations it recorded.
 */
export async function mockServer(script: (MockBehavior & {
  /**
   * Behavior per credential value, consulted before the surrounding fields. A
   * credential with no entry falls through to the surrounding behavior, which
   * is how a test states what an unexpected key receives.
   */
  byKey?: Record<string, MockBehavior>
})[]): Promise<MockServer> {
  const paths: string[] = []
  const requests: unknown[] = []
  const headers: IncomingMessage['headers'][] = []
  let closedResponses = 0
  const requestReceived = Promise.withResolvers<undefined>()
  const responseClosed = Promise.withResolvers<undefined>()
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    response.on('close', () => {
      clearTimeout(timer)
      closedResponses += 1
      responseClosed.resolve(undefined)
    })
    let body = ''
    request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    request.on('end', () => {
      paths.push(request.url ?? '')
      requests.push(body.length === 0 ? undefined : JSON.parse(body))
      headers.push(request.headers)
      requestReceived.resolve(undefined)
      const entry = script.shift() ?? { status: 500, body: 'script exhausted' }
      const credential = bearerCredential(request.headers)
      const behavior = credential === undefined ? undefined : entry.byKey?.[credential]
      const reply: MockBehavior = behavior ?? entry
      if (reply.status !== undefined && reply.status !== 200) {
        response.writeHead(reply.status, { 'content-type': 'application/json', ...reply.headers })
        response.end(reply.body ?? '{}')
        return
      }
      if (reply.body !== undefined) {
        response.writeHead(200, { 'content-type': 'application/json', ...reply.headers })
        response.end(reply.body)
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.flushHeaders()
      let index = 0
      const writeNext = (): void => {
        const event = reply.events?.[index++]
        if (event === undefined) {
          if (!reply.holdOpen) response.end()
          return
        }
        response.write(`data: ${event}\n\n`)
        if (reply.delayMs === undefined) writeNext()
        else timer = setTimeout(writeNext, reply.delayMs)
      }
      writeNext()
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return {
    url: `http://127.0.0.1:${address.port}`,
    paths,
    requests,
    headers,
    requestReceived: requestReceived.promise,
    responseClosed: responseClosed.promise,
    get closedResponses() { return closedResponses },
  }
}
