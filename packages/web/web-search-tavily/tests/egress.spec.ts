import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { installProxyFromEnvironment } from '@deepseek-ai/dsh-http-proxy'
import {
  TAVILY_DEFAULT_MAX_CONTENT_CHARS,
  TAVILY_DEFAULT_MAX_RESULTS,
  TAVILY_DEFAULT_TIMEOUT_MS,
  TavilySearchProvider,
} from '../src/provider.ts'

let seen: string[] = []
let proxy: Server
let proxyUrl: string

beforeAll(async () => {
  proxy = createServer((request, response) => {
    seen.push(`REQ ${request.url ?? ''}`)
    response.writeHead(502); response.end('fake-proxy')
  })
  proxy.on('connect', (request, socket) => {
    seen.push(`CONNECT ${request.url ?? ''}`)
    socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n'); socket.end()
  })
  const a = await new Promise<AddressInfo>((r) => { proxy.listen(0, '127.0.0.1', () => { r(proxy.address() as AddressInfo) }) })
  proxyUrl = `http://127.0.0.1:${String(a.port)}`
})
afterAll(async () => { await new Promise<void>((r) => { proxy.close(() => { r() }) }) })

/** The launch environment of a user who exported one proxy for both schemes. */
function proxyEnv(): { get(name: string): { value: string } | undefined } {
  return { get: name => (name === 'HTTP_PROXY' || name === 'HTTPS_PROXY' ? { value: proxyUrl } : undefined) }
}
async function observe(run: () => Promise<unknown>): Promise<string[]> {
  seen = []
  const dispose = await installProxyFromEnvironment(proxyEnv(), () => undefined)
  try { await run().catch(() => undefined) } finally { await dispose() }
  return seen
}

describe('tavily egress', () => {
  it('goes through the proxy, path included', async () => {
    const p = new TavilySearchProvider(() => ({
      credentialName: 'TAVILY_API_KEY',
      endpoint: 'http://tavily-probe.invalid/search',
      maxResults: TAVILY_DEFAULT_MAX_RESULTS,
      timeoutMs: TAVILY_DEFAULT_TIMEOUT_MS,
      maxContentChars: TAVILY_DEFAULT_MAX_CONTENT_CHARS,
      ambientKeyPresent: false,
      credentialPresent: true,
      credentialAnswerName: 'TAVILY_API_KEY',
      apiKey: 'probe-key',
    }))
    expect(await observe(() => p.search({ query: 'probe' }))).toEqual(['REQ http://tavily-probe.invalid/search'])
  })
})
