import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import WebRuntime from '@deepseek-ai/dsh-web'
import { HttpFetchProvider, LOCAL_FETCH_PROVIDER_ID } from '@deepseek-ai/dsh-web-fetch-http'
import type { HttpFetchLimits, HttpFetchResolver } from '@deepseek-ai/dsh-web-fetch-http'
import * as fetchPlugin from '@deepseek-ai/dsh-web-fetch-http'
import {
  compileTrustedAddressRanges,
  createPinnedLookup,
  isNonPublicIpLiteral,
  isPublicIpAddress,
  publicHttpNetwork,
  requestPinned,
  resolvePublicAddresses,
} from '../src/network.ts'
import {
  classifyContentType,
  decoderForCharset,
  isSameOrigin,
  parseCharset,
  parseFetchUrl,
  validateFetchUrl,
  WEB_FETCH_MAX_URL_LENGTH,
} from '../src/policy.ts'

const limits: HttpFetchLimits = {
  maxResponseBytes: 5_000_000,
  maxBodyChars: 100_000,
  timeoutMs: 5_000,
  maxRedirects: 5,
  userAgent: 'test-agent/1.0',
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void

let server: Server
let base: string
let handler: Handler
let restoreResolution: () => void

beforeEach(async () => {
  handler = (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('default') }
  server = createServer((req, res) => { handler(req, res) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  base = `http://127.0.0.1:${port}`
  const spy = vi.spyOn(publicHttpNetwork, 'resolve').mockResolvedValue([{ address: '127.0.0.1', family: 4 }])
  restoreResolution = () => { spy.mockRestore() }
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  await new Promise<void>(resolve => server.close(() => { resolve() }))
})

function provider(overrides: Partial<HttpFetchLimits> = {}): HttpFetchProvider {
  return new HttpFetchProvider({ ...limits, ...overrides })
}

describe('policy helpers', () => {
  it('validates scheme, credentials, and length', () => {
    expect(parseFetchUrl('https://example.com/preflight').pathname).toBe('/preflight')
    expect(validateFetchUrl('https://example.com/x').hostname).toBe('example.com')
    expect(() => validateFetchUrl('ftp://example.com')).toThrow(expect.objectContaining({ code: 'WEB_INVALID_URL' }))
    expect(() => validateFetchUrl('not a url')).toThrow(expect.objectContaining({ code: 'WEB_INVALID_URL' }))
    expect(() => validateFetchUrl('https://user:pass@example.com')).toThrow(expect.objectContaining({ code: 'WEB_BLOCKED_URL' }))
    const prefix = 'https://example.com/'
    const exact = `${prefix}${'a'.repeat(WEB_FETCH_MAX_URL_LENGTH - prefix.length)}`
    expect(validateFetchUrl(exact).href).toBe(exact)
    expect(() => validateFetchUrl(`${exact}a`)).toThrow(expect.objectContaining({ code: 'WEB_INVALID_URL' }))
  })

  it('classifies content types', () => {
    expect(classifyContentType('text/html; charset=utf-8')).toBe('html')
    expect(classifyContentType('application/xhtml+xml')).toBe('html')
    expect(classifyContentType('text/plain')).toBe('text')
    expect(classifyContentType('application/json')).toBe('text')
    expect(classifyContentType('image/png')).toBeUndefined()
    expect(classifyContentType(null)).toBeUndefined()
  })

  it('compares origins', () => {
    expect(isSameOrigin(new URL('https://a.com/x'), new URL('https://a.com/y'))).toBe(true)
    expect(isSameOrigin(new URL('https://a.com'), new URL('https://b.com'))).toBe(false)
    expect(isSameOrigin(new URL('http://a.com'), new URL('https://a.com'))).toBe(false)
  })

  it('parses the charset parameter', () => {
    expect(parseCharset('text/html; charset=UTF-8')).toBe('utf-8')
    expect(parseCharset('text/plain; charset="iso-8859-1"')).toBe('iso-8859-1')
    expect(parseCharset('text/plain')).toBeUndefined()
    expect(parseCharset(null)).toBeUndefined()
  })

  it('builds a decoder for a charset and defaults to UTF-8', () => {
    expect(decoderForCharset(undefined).encoding).toBe('utf-8')
    expect(decoderForCharset('iso-8859-1').encoding).toBe('windows-1252')
    expect(() => decoderForCharset('not-a-charset')).toThrow(expect.objectContaining({ code: 'WEB_UNSUPPORTED_CONTENT_TYPE' }))
  })
})

describe('public-network policy', () => {
  it('accepts only globally reachable unicast addresses', () => {
    for (const address of ['8.8.8.8', '2001:4860:4860::8888', '::ffff:8.8.8.8']) {
      expect(isPublicIpAddress(address), address).toBe(true)
    }
    for (const address of [
      '0.0.0.0',
      '10.0.0.1',
      '100.64.0.1',
      '127.0.0.1',
      '169.254.169.254',
      '192.0.2.1',
      '224.0.0.1',
      '255.255.255.255',
      '::',
      '::1',
      'fe80::1',
      'fc00::1',
      'ff02::1',
      '::ffff:127.0.0.1',
      '64:ff9b::808:808',
      'not-an-ip',
    ]) {
      expect(isPublicIpAddress(address), address).toBe(false)
    }
  })

  it('retains one fully public DNS answer set', async () => {
    const resolver = vi.fn(async () => [
      { address: '8.8.4.4', family: 4 },
      { address: '2001:4860:4860::8888', family: 6 },
    ])
    await expect(resolvePublicAddresses('example.test', new AbortController().signal, resolver))
      .resolves.toEqual([
        { address: '8.8.4.4', family: 4 },
        { address: '2001:4860:4860::8888', family: 6 },
      ])
  })

  it('rejects the whole DNS answer set when one address is not public', async () => {
    const resolver = vi.fn(async () => [
      { address: '8.8.8.8', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ])
    await expect(resolvePublicAddresses('rebinding.test', new AbortController().signal, resolver))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_BLOCKED_URL' }))
  })

  it('rejects empty and invalid resolver results', async () => {
    await expect(resolvePublicAddresses('empty.test', new AbortController().signal, async () => []))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
    await expect(resolvePublicAddresses('family.test', new AbortController().signal, async () => [{ address: '8.8.8.8', family: 0 }]))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
    await expect(resolvePublicAddresses('mismatch.test', new AbortController().signal, async () => [{ address: '::1', family: 4 }]))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('validates bracketed IPv6 literals after checking for an active DNS64 prefix', async () => {
    const resolver = vi.fn(async () => [{ address: '192.0.0.170', family: 4 }])
    await expect(resolvePublicAddresses('[2001:4860:4860::8888]', new AbortController().signal, resolver))
      .resolves.toEqual([{ address: '2001:4860:4860::8888', family: 6 }])
    expect(resolver).toHaveBeenCalledWith('ipv4only.arpa', { all: true, order: 'verbatim' })
  })

  it('rejects a network-specific NAT64 address that translates to private IPv4', async () => {
    const resolver = vi.fn(async (hostname: string) => hostname === 'ipv4only.arpa'
      ? [{ address: '2001:4860:64:64::c000:aa', family: 6 }]
      : [{ address: '2001:4860:64:64::7f00:1', family: 6 }])

    await expect(resolvePublicAddresses('nat64.test', new AbortController().signal, resolver))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_BLOCKED_URL' }))
  })

  it('accepts a network-specific NAT64 address that translates to public IPv4', async () => {
    const resolver = vi.fn(async (hostname: string) => hostname === 'ipv4only.arpa'
      ? [{ address: '2001:4860:64:64::c000:aa', family: 6 }]
      : [{ address: '2001:4860:64:64::808:808', family: 6 }])

    await expect(resolvePublicAddresses('nat64.test', new AbortController().signal, resolver))
      .resolves.toEqual([{ address: '2001:4860:64:64::808:808', family: 6 }])
  })

  it('deduplicates discovered prefixes and ignores addresses outside their translation layout', async () => {
    const resolver = vi.fn(async (hostname: string) => hostname === 'ipv4only.arpa'
      ? [
        { address: '2001:4860:64:64::c000:aa', family: 6 },
        { address: '2001:4860:64:64::c000:ab', family: 6 },
        { address: '2001:4860:64:64:c0:0:aa00:0', family: 6 },
      ]
      : [
        { address: '2001:4860:65:64::808:808', family: 6 },
        { address: '2001:4860:64:64:100::1', family: 6 },
      ])

    await expect(resolvePublicAddresses('native-v6.test', new AbortController().signal, resolver))
      .resolves.toEqual([
        { address: '2001:4860:65:64::808:808', family: 6 },
        { address: '2001:4860:64:64:100::1', family: 6 },
      ])
  })

  it('stops waiting for DNS when the request is aborted', async () => {
    let finish!: (value: never[]) => void
    const resolver = vi.fn(() => new Promise<never[]>((resolve) => { finish = resolve }))
    const controller = new AbortController()
    const pending = resolvePublicAddresses('slow.test', controller.signal, resolver)
    controller.abort(new Error('stop'))
    await expect(pending).rejects.toThrow('web fetch aborted during hostname resolution')
    finish([])

    const alreadyAborted = new AbortController()
    alreadyAborted.abort(new Error('already stopped'))
    await expect(resolvePublicAddresses('slow.test', alreadyAborted.signal, resolver))
      .rejects.toThrow('web fetch aborted during hostname resolution')
  })

  it('propagates resolver failures', async () => {
    await expect(resolvePublicAddresses('broken.test', new AbortController().signal, async () => { throw new Error('dns failed') }))
      .rejects.toThrow('dns failed')
  })

  it('serves only the retained addresses through the connector lookup', async () => {
    const lookup = createPinnedLookup([
      { address: '8.8.8.8', family: 4 },
      { address: '2001:4860:4860::8888', family: 6 },
    ])
    const call = (options: Parameters<typeof lookup>[1]) => new Promise<{
      error: NodeJS.ErrnoException | null
      address: string | import('node:dns').LookupAddress[]
      family: number | undefined
    }>((resolve) => {
      lookup('fixed.test', options, (error, address, family) => { resolve({ error, address, family }) })
    })

    await expect(call({ all: true })).resolves.toMatchObject({
      error: null,
      address: [{ address: '8.8.8.8', family: 4 }, { address: '2001:4860:4860::8888', family: 6 }],
    })
    await expect(call({ family: 4 })).resolves.toMatchObject({ error: null, address: '8.8.8.8', family: 4 })
    await expect(call({ family: 'IPv6' })).resolves.toMatchObject({ error: null, address: '2001:4860:4860::8888', family: 6 })
    await expect(call({ family: 'IPv4' })).resolves.toMatchObject({ error: null, address: '8.8.8.8', family: 4 })
    await expect(call({ family: 7 })).resolves.toMatchObject({ error: { code: 'ENOTFOUND' }, address: '', family: 7 })
    await expect(call({ family: 7, all: true })).resolves.toMatchObject({ error: { code: 'ENOTFOUND' }, address: [], family: 7 })
  })

  it('pins the connection to the validated address without resolving the URL hostname again', async () => {
    handler = (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('pinned') }
    const { port } = server.address() as AddressInfo
    const request = await requestPinned(
      new URL(`http://does-not-resolve.invalid:${port}/`),
      [{ address: '127.0.0.1', family: 4 }],
      {},
      new AbortController().signal,
    )
    try {
      await expect(request.response.text()).resolves.toBe('pinned')
    } finally {
      await request.close()
    }
  })
})

describe('declared proxy address ranges', () => {
  /** The synthetic pool a transparent `fake-ip` proxy answers with. */
  const FAKE_IP_POOL = '198.18.0.0/15'

  /**
   * Every address class this guard refuses, one representative per `ipaddr.js` range name, so the
   * default-off contract is asserted against the documented block list rather than a sample.
   */
  const DOCUMENTED_BLOCK_LIST: Record<string, readonly string[]> = {
    reserved: ['198.18.3.178', '192.0.2.1', '203.0.113.1', '240.0.0.1'],
    private: ['10.0.0.1', '172.16.0.1', '192.168.1.1'],
    carrierGradeNat: ['100.64.0.1'],
    loopback: ['127.0.0.1', '::1'],
    linkLocal: ['169.254.1.1', 'fe80::1'],
    uniqueLocal: ['fc00::1'],
    multicast: ['224.0.0.1', 'ff02::1'],
    broadcast: ['255.255.255.255'],
    unspecified: ['0.0.0.0', '::'],
    ipv4Mapped: ['::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:169.254.1.1'],
  }

  it('refuses the whole documented block list when no range is declared', () => {
    for (const [name, addresses] of Object.entries(DOCUMENTED_BLOCK_LIST)) {
      for (const address of addresses) {
        expect(isPublicIpAddress(address), `${name}: ${address}`).toBe(false)
        expect(isPublicIpAddress(address, []), `${name}: ${address}`).toBe(false)
      }
    }
  })

  it('accepts only the declared pool and leaves every private address blocked', () => {
    const trusted = compileTrustedAddressRanges([FAKE_IP_POOL])
    for (const address of ['198.18.0.0', '198.18.3.178', '198.19.255.255', '::ffff:198.18.3.178']) {
      expect(isPublicIpAddress(address, trusted), address).toBe(true)
    }
    for (const address of [
      // The local network, and the IPv4-mapped forms of it.
      '10.0.0.1', '172.16.0.1', '192.168.1.1', '100.64.0.1', '127.0.0.1', '169.254.1.1',
      'fc00::1', '::1', 'fe80::1', '0.0.0.0', '224.0.0.1', '255.255.255.255',
      '192.0.2.1', '203.0.113.1',
      '::ffff:10.0.0.1', '::ffff:172.16.0.1', '::ffff:192.168.1.1', '::ffff:100.64.0.1',
      '::ffff:127.0.0.1', '::ffff:169.254.1.1', '::ffff:192.0.2.1',
    ]) {
      expect(isPublicIpAddress(address, trusted), address).toBe(false)
    }
    // RFC 2544 neighbours just outside /15 are ordinary public unicast: declaring the pool neither
    // adds nor removes them, which is what "only the declared block changes" means.
    for (const address of ['198.17.255.255', '198.20.0.1']) {
      expect(isPublicIpAddress(address), address).toBe(true)
      expect(isPublicIpAddress(address, trusted), address).toBe(true)
    }
  })

  it('honours a declared IPv6 block and a mixed-family list', () => {
    const trusted = compileTrustedAddressRanges(['fd00:1234::/48', FAKE_IP_POOL])
    for (const address of ['fd00:1234::1', 'fd00:1234:0:abcd::1', '198.18.3.178']) {
      expect(isPublicIpAddress(address, trusted), address).toBe(true)
    }
    for (const address of ['fd00:1234:1::1', 'fd00:1235::1', 'fc00::1', '::1', '10.0.0.1', '192.0.2.1']) {
      expect(isPublicIpAddress(address, trusted), address).toBe(false)
    }
  })

  it('never lets a block of one family widen the other', () => {
    // Even a maximally broad block stays inside its own family, so declaring every IPv6 address
    // (`::/0`) cannot reach one IPv4 destination, nor the reverse.
    const allIpv6 = compileTrustedAddressRanges(['::/0'])
    const allIpv4 = compileTrustedAddressRanges(['0.0.0.0/0'])
    for (const address of ['10.0.0.1', '127.0.0.1', '198.18.3.178', '::ffff:10.0.0.1']) {
      expect(isPublicIpAddress(address, allIpv6), address).toBe(false)
    }
    for (const address of ['::1', 'fc00::1', 'fe80::1', '::']) {
      expect(isPublicIpAddress(address, allIpv4), address).toBe(false)
    }
    // A mapped form is judged as the IPv4 address it embeds, so an IPv6 block naming every mapped
    // address (`::ffff:0:0/96`) cannot lend trust to any embedded IPv4 destination.
    expect(isPublicIpAddress('::ffff:10.0.0.1', compileTrustedAddressRanges(['::ffff:0:0/96']))).toBe(false)
  })

  it('rejects a malformed block at compile time, naming the offending entry', () => {
    expect(() => compileTrustedAddressRanges([FAKE_IP_POOL, '198.18.0.0/33']))
      .toThrow('web-fetch-http: trustedProxyAddressRanges[1] "198.18.0.0/33" is not a valid IPv4 or IPv6 CIDR block')
    for (const invalid of ['198.18.0.0', 'not-a-cidr', '198.18.0.0/', '2001:db8::/129', '/15']) {
      expect(() => compileTrustedAddressRanges([invalid]), invalid)
        .toThrow(/is not a valid IPv4 or IPv6 CIDR block/)
    }
  })

  it('rejects inet_aton-style IPv4 shorthand instead of silently compiling a different network', () => {
    // `ipaddr.parseCIDR` replicates BSD inet_aton: a short form fills in zero octets from the
    // RIGHT, so "10/8" is "0.0.0.10/8" — network 0.0.0.0/8, not 10.0.0.0/8 — and "192.168/16" is
    // network 192.0.0.0/16, not 192.168.0.0/16. Both parse without error, so an operator who
    // copies the shorthand from a casual description (rather than a canonical CIDR) would trust
    // the wrong block with no warning.
    for (const shorthand of ['10/8', '127/8', '192.168/16', '169.254/16']) {
      expect(() => compileTrustedAddressRanges([shorthand]), shorthand)
        .toThrow(/must spell every IPv4 octet in decimal with no leading zero/)
    }
  })

  it('rejects an octal or hex IPv4 octet instead of silently compiling a different network', () => {
    // A leading zero reads as octal to the same inet_aton-style parser: "010.0.0.0" is
    // "8.0.0.0", not "10.0.0.0". A "0x" prefix reads as hex.
    for (const nonDecimal of ['010.0.0.0/8', '0x0a.0.0.0/8', '192.168.001.0/24']) {
      expect(() => compileTrustedAddressRanges([nonDecimal]), nonDecimal)
        .toThrow(/must spell every IPv4 octet in decimal with no leading zero/)
    }
  })

  it('still accepts every IPv4 octet written in full decimal, including a bare "0"', () => {
    expect(compileTrustedAddressRanges(['10.0.0.0/8', '0.0.0.0/0', '198.18.0.0/15'])).toHaveLength(3)
  })

  it('retains a synthetic DNS answer only when its pool is declared', async () => {
    const resolver = vi.fn(async () => [{ address: '198.18.3.178', family: 4 }])
    await expect(resolvePublicAddresses('cursor.test', new AbortController().signal, resolver))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_BLOCKED_URL' }))
    await expect(resolvePublicAddresses(
      'cursor.test',
      new AbortController().signal,
      resolver,
      compileTrustedAddressRanges([FAKE_IP_POOL]),
    )).resolves.toEqual([{ address: '198.18.3.178', family: 4 }])
  })

  it('applies the declared blocks to a NAT64-translated IPv4 destination', async () => {
    const resolver = vi.fn(async (hostname: string) => hostname === 'ipv4only.arpa'
      ? [{ address: '2001:4860:64:64::c000:aa', family: 6 }]
      : [{ address: '2001:4860:64:64::c612:1b2', family: 6 }])

    // The outer address is public unicast; the embedded 198.18.1.178 is what the pool covers.
    await expect(resolvePublicAddresses('nat64.test', new AbortController().signal, resolver))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_BLOCKED_URL' }))
    await expect(resolvePublicAddresses(
      'nat64.test',
      new AbortController().signal,
      resolver,
      compileTrustedAddressRanges([FAKE_IP_POOL]),
    )).resolves.toEqual([{ address: '2001:4860:64:64::c612:1b2', family: 6 }])
  })

  it('judges an IP literal by the declared blocks too', () => {
    const trusted = compileTrustedAddressRanges([FAKE_IP_POOL])
    // Undeclared, a literal in the pool stays refused — the default is byte-for-byte unchanged.
    expect(isNonPublicIpLiteral('198.18.3.178')).toBe(true)
    expect(isNonPublicIpLiteral('198.18.3.178', trusted)).toBe(false)
    expect(isNonPublicIpLiteral('[::ffff:198.18.3.178]', trusted)).toBe(false)
    expect(isNonPublicIpLiteral('10.0.0.1', trusted)).toBe(true)
    expect(isNonPublicIpLiteral('[::ffff:10.0.0.1]', trusted)).toBe(true)
  })
})

describe('HttpFetchProvider success', () => {
  it('fetches a text body', async () => {
    handler = (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('hello world') }
    const result = await provider().fetch({ url: base })
    expect(provider().available()).toBe(true)
    expect(result.statusCode).toBe(200)
    expect(result.body).toEqual({ kind: 'text', content: 'hello world' })
    expect(result.truncated).toBe(false)
  })

  it('fetches an html body and classifies it as html', async () => {
    handler = (_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<h1>hi</h1>') }
    const result = await provider().fetch({ url: base })
    expect(result.body).toEqual({ kind: 'html', content: '<h1>hi</h1>' })
  })

  it('uses an explicitly injected validated-address resolver', async () => {
    const resolveAddresses = vi.fn<HttpFetchResolver>(async () => [{ address: '127.0.0.1', family: 4 }])
    const result = await new HttpFetchProvider(limits, resolveAddresses).fetch({ url: base })
    expect(result.statusCode).toBe(200)
    expect(resolveAddresses).toHaveBeenCalledWith('127.0.0.1', expect.any(AbortSignal))
    expect(publicHttpNetwork.resolve).not.toHaveBeenCalled()
  })

  it('sends the configured user agent', async () => {
    let seen: string | undefined
    handler = (req, res) => { seen = req.headers['user-agent']; res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok') }
    await provider().fetch({ url: base })
    expect(seen).toBe('test-agent/1.0')
  })

  it('returns a non-2xx response as a result, not an error', async () => {
    handler = (_req, res) => { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('nope') }
    const result = await provider().fetch({ url: base })
    expect(result.statusCode).toBe(404)
    expect(result.body).toEqual({ kind: 'text', content: 'nope' })
  })
})

describe('HttpFetchProvider caps', () => {
  it('rejects an over-cap Content-Length with WEB_FETCH_TOO_LARGE', async () => {
    handler = (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '999999' }); res.end('x'.repeat(999999)) }
    await expect(provider({ maxResponseBytes: 10 }).fetch({ url: base }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_FETCH_TOO_LARGE' }))
  })

  it('truncates a stream that grows past the byte cap', async () => {
    handler = (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('abcdefghij') }
    const result = await provider({ maxResponseBytes: 4 }).fetch({ url: base })
    expect(result.body.content).toBe('abcd')
    expect(result.truncated).toBe(true)
  })

  it('does not flag a body that exactly fills the byte cap as truncated', async () => {
    handler = (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('abcd') }
    const result = await provider({ maxResponseBytes: 4 }).fetch({ url: base })
    expect(result.body.content).toBe('abcd')
    expect(result.truncated).toBe(false)
  })

  it('truncates a decoded body past the character cap', async () => {
    handler = (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('abcdefghij') }
    const result = await provider({ maxBodyChars: 3 }).fetch({ url: base })
    expect(result.body.content).toBe('abc')
    expect(result.truncated).toBe(true)
  })

  it('rejects an unsupported content type', async () => {
    handler = (_req, res) => { res.writeHead(200, { 'content-type': 'image/png' }); res.end('binary') }
    await expect(provider().fetch({ url: base }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_UNSUPPORTED_CONTENT_TYPE' }))
  })

  it('rejects a response with no content type at all', async () => {
    handler = (_req, res) => { res.writeHead(200); res.end('no type') }
    await expect(provider().fetch({ url: base }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_UNSUPPORTED_CONTENT_TYPE' }))
  })

  it('accepts a declared content-length within the cap', async () => {
    handler = (_req, res) => { const body = 'sized'; res.writeHead(200, { 'content-type': 'text/plain', 'content-length': String(body.length) }); res.end(body) }
    const result = await provider().fetch({ url: base })
    expect(result.body.content).toBe('sized')
  })

  it('decodes a non-UTF-8 declared charset', async () => {
    // 0xE9 is "é" in ISO-8859-1; decoded as UTF-8 it would be a replacement char.
    handler = (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain; charset=iso-8859-1' }); res.end(Buffer.from([0x63, 0x61, 0x66, 0xE9])) }
    const result = await provider().fetch({ url: base })
    expect(result.body.content).toBe('café')
  })

  it('rejects an unsupported declared charset', async () => {
    handler = (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain; charset=not-a-charset' }); res.end('x') }
    await expect(provider().fetch({ url: base }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_UNSUPPORTED_CONTENT_TYPE' }))
  })
})

describe('HttpFetchProvider redirects', () => {
  it('follows a same-origin redirect and reports the final URL', async () => {
    handler = (req, res) => {
      if (req.url === '/start') { res.writeHead(302, { location: '/end' }); res.end() }
      else { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('arrived') }
    }
    const result = await provider().fetch({ url: `${base}/start` })
    expect(result.body.content).toBe('arrived')
    expect(result.url).toBe(`${base}/end`)
  })

  it('blocks a cross-origin redirect with WEB_REDIRECT_BLOCKED', async () => {
    handler = (_req, res) => { res.writeHead(302, { location: 'https://example.com/' }); res.end() }
    await expect(provider().fetch({ url: base }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_REDIRECT_BLOCKED' }))
  })

  it('re-validates a redirect target, rejecting same-origin credentials in the Location', async () => {
    const { port } = server.address() as AddressInfo
    handler = (_req, res) => { res.writeHead(302, { location: `http://user:pass@127.0.0.1:${port}/` }); res.end() }
    await expect(provider().fetch({ url: base }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_BLOCKED_URL' }))
  })

  it('rejects exceeding the redirect hop cap', async () => {
    handler = (req, res) => {
      const n = Number(new URL(req.url ?? '/', base).searchParams.get('n') ?? '0')
      res.writeHead(302, { location: `/?n=${n + 1}` })
      res.end()
    }
    await expect(provider({ maxRedirects: 2 }).fetch({ url: `${base}/?n=0` }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_REDIRECT_BLOCKED' }))
  })

  it('follows exactly maxRedirects hops: a chain landing on the Nth redirect succeeds', async () => {
    // maxRedirects: 2 → /?n=0 → /?n=1 → /?n=2(200). Exactly 2 redirects + 1
    // final = 3 requests; the cap is inclusive of the landing request.
    let requests = 0
    handler = (req, res) => {
      requests++
      const n = Number(new URL(req.url ?? '/', base).searchParams.get('n') ?? '0')
      if (n >= 2) { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('landed') }
      else { res.writeHead(302, { location: `/?n=${n + 1}` }); res.end() }
    }
    const result = await provider({ maxRedirects: 2 }).fetch({ url: `${base}/?n=0` })
    expect(result.body.content).toBe('landed')
    expect(requests).toBe(3)
  })

  it('makes exactly maxRedirects+1 requests before blocking an over-long chain', async () => {
    // maxRedirects: 2 on an infinite chain: requests at n=0,1,2 (the 3rd is the
    // over-limit redirect, refused before its Location is followed) = 3 total.
    let requests = 0
    handler = (req, res) => {
      requests++
      const n = Number(new URL(req.url ?? '/', base).searchParams.get('n') ?? '0')
      res.writeHead(302, { location: `/?n=${n + 1}` })
      res.end()
    }
    await expect(provider({ maxRedirects: 2 }).fetch({ url: `${base}/?n=0` }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_REDIRECT_BLOCKED', message: 'exceeded the maximum of 2 redirects' }))
    expect(requests).toBe(3)
  })

  it('reports an over-limit redirect as "exceeded", not cross-origin, even when the over-limit hop points cross-origin', async () => {
    // The redirect budget is checked BEFORE the over-limit hop's target is
    // origin-validated, so the diagnosis is "exceeded", not "cross-origin".
    handler = (req, res) => {
      const n = Number(new URL(req.url ?? '/', base).searchParams.get('n') ?? '0')
      const location = n === 0 ? '/?n=1' : 'https://example.com/'
      res.writeHead(302, { location })
      res.end()
    }
    await expect(provider({ maxRedirects: 1 }).fetch({ url: `${base}/?n=0` }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_REDIRECT_BLOCKED', message: 'exceeded the maximum of 1 redirects' }))
  })

  it('maxRedirects: 0 follows no redirect but still fetches a direct 200', async () => {
    handler = (req, res) => {
      if (req.url === '/r') { res.writeHead(302, { location: '/done' }); res.end() }
      else { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('direct') }
    }
    await expect(provider({ maxRedirects: 0 }).fetch({ url: `${base}/r` }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_REDIRECT_BLOCKED' }))
    const direct = await provider({ maxRedirects: 0 }).fetch({ url: `${base}/done` })
    expect(direct.body.content).toBe('direct')
  })

  it('treats a redirect without a Location header as a provider error', async () => {
    handler = (_req, res) => { res.writeHead(302); res.end() }
    await expect(provider().fetch({ url: base }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('follows a relative same-origin redirect', async () => {
    handler = (req, res) => {
      if (req.url === '/a') { res.writeHead(301, { location: 'b' }); res.end() }
      else { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('landed') }
    }
    const result = await provider().fetch({ url: `${base}/a` })
    expect(result.body.content).toBe('landed')
  })
})

describe('HttpFetchProvider invalid URLs and abort', () => {
  it('blocks a loopback destination before opening a connection', async () => {
    restoreResolution()
    await expect(provider().fetch({ url: base }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_BLOCKED_URL' }))
  })

  it('reaches a loopback destination once its range is declared', async () => {
    // Same real request as the block above, through the real resolver over a
    // real socket on 127.0.0.1 — only the declared range differs. This is what
    // the `trustedProxyAddressRanges` setting buys a deployment.
    restoreResolution()
    handler = (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('local') }
    const result = await provider({
      trustedProxyAddressRanges: compileTrustedAddressRanges(['127.0.0.0/8']),
    }).fetch({ url: base })
    expect(result.statusCode).toBe(200)
    expect(result.body).toEqual({ kind: 'text', content: 'local' })
  })

  it('keeps a private destination blocked when only loopback is declared', async () => {
    // A declared block widens reach to exactly that block: declaring loopback
    // must not also admit RFC1918, so a `192.168` literal stays refused.
    restoreResolution()
    const privateAddress = provider({
      trustedProxyAddressRanges: compileTrustedAddressRanges(['127.0.0.0/8']),
    })
    await expect(async () => {
      await privateAddress.fetch({ url: 'http://192.168.1.1:1/' })
    }).rejects.toThrow(expect.objectContaining({ code: 'WEB_BLOCKED_URL' }))
  })

  it('rejects a non-http scheme before any network access', async () => {
    await expect(provider().fetch({ url: 'ftp://example.com' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_INVALID_URL' }))
  })

  it('rejects credentials in the URL', async () => {
    await expect(provider().fetch({ url: 'http://user:pass@127.0.0.1/' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_BLOCKED_URL' }))
  })

  it('honors a pre-aborted signal', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(provider().fetch({ url: base }, controller.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('aborts an in-flight fetch via the signal', async () => {
    handler = (_req, _res) => { /* never responds */ }
    const controller = new AbortController()
    const promise = provider().fetch({ url: base }, controller.signal)
    controller.abort()
    await expect(promise).rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('times out a slow response with WEB_FETCH_TIMEOUT', async () => {
    handler = (_req, _res) => { /* never responds */ }
    await expect(provider({ timeoutMs: 50 }).fetch({ url: base }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_FETCH_TIMEOUT' }))
  })

  it('classifies a timeout DURING the body read as WEB_FETCH_TIMEOUT, not WEB_ABORTED', async () => {
    // Promise body that resolves headers (so fetch() returns) but a content-length
    // that outlasts the bytes sent, so readCapped()'s reader awaits more and the
    // timeout fires mid-read — the reader then surfaces a generic AbortError that
    // must still be recovered as the timeout reason via signal.reason.
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '100' })
      res.write('partial')
      // never send the remaining bytes nor end the response
    }
    await expect(provider({ timeoutMs: 80 }).fetch({ url: base }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_FETCH_TIMEOUT' }))
  })

  it('maps a connection failure to WEB_PROVIDER_ERROR', async () => {
    // Port 1 on loopback is not listening: a real connection failure (not abort).
    await expect(provider().fetch({ url: 'http://127.0.0.1:1/' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

})

describe('HttpFetchProvider body cancellation on error paths', () => {
  /** A fake Response whose body.cancel is observable. */
  type FakeInit = { status: number; headers: Record<string, string>; location?: string }
  function fakeResponse(init: FakeInit): { response: Response; cancelled: () => boolean } {
    let cancelled = false
    const headers = new Headers(init.headers)
    if (init.location !== undefined) headers.set('location', init.location)
    const response = {
      status: init.status,
      headers,
      body: { cancel: () => { cancelled = true; return Promise.resolve() } },
    } as unknown as Response
    return { response, cancelled: () => cancelled }
  }

  function stubRequest(response: Response): void {
    vi.spyOn(publicHttpNetwork, 'request').mockResolvedValue({
      response: response as never,
      close: async () => {},
    })
  }

  it('cancels the body when a cross-origin redirect is blocked', async () => {
    const { response, cancelled } = fakeResponse({ status: 302, headers: {}, location: 'https://elsewhere.test/' })
    stubRequest(response)
    await expect(provider().fetch({ url: 'http://127.0.0.1:9/' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_REDIRECT_BLOCKED' }))
    expect(cancelled()).toBe(true)
  })

  it('cancels the body when an unsupported charset is rejected', async () => {
    const { response, cancelled } = fakeResponse({ status: 200, headers: { 'content-type': 'text/plain; charset=not-a-charset' } })
    stubRequest(response)
    await expect(provider().fetch({ url: 'http://127.0.0.1:9/' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_UNSUPPORTED_CONTENT_TYPE' }))
    expect(cancelled()).toBe(true)
  })

  it('cancels the body when a redirect has no Location header', async () => {
    const { response, cancelled } = fakeResponse({ status: 302, headers: {} })
    stubRequest(response)
    await expect(provider().fetch({ url: 'http://127.0.0.1:9/' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
    expect(cancelled()).toBe(true)
  })
})

describe('web-fetch-http plugin registration', () => {
  it('registers the provider into ctx.web (HMR-safe)', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { fetchProvider: LOCAL_FETCH_PROVIDER_ID })
    const fiber = await ctx.plugin(fetchPlugin, {})
    await expect(ctx.web.fetch({ url: `${base}/` }))
      .resolves.toMatchObject({ statusCode: 200 })
    await fiber.dispose()
    await expect(ctx.web.fetch({ url: `${base}/` }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' }))
  })

  it('has no default export (namespace plugin export shape)', () => {
    expect('default' in fetchPlugin).toBe(false)
  })

  it('rejects a non-positive resource limit at construction', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { fetchProvider: LOCAL_FETCH_PROVIDER_ID })
    await expect(ctx.plugin(fetchPlugin, { maxResponseBytes: -1 }))
      .rejects.toThrow(/maxResponseBytes must be a positive finite number/)
  })

  it('rejects a zero timeout at construction', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { fetchProvider: LOCAL_FETCH_PROVIDER_ID })
    await expect(ctx.plugin(fetchPlugin, { timeoutMs: 0 }))
      .rejects.toThrow(/timeoutMs must be a positive finite number/)
  })

  it('rejects a timeout beyond Node timer range at construction', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { fetchProvider: LOCAL_FETCH_PROVIDER_ID })
    await expect(ctx.plugin(fetchPlugin, { timeoutMs: 2_147_483_648 }))
      .rejects.toThrow(/timeoutMs must be no greater than 2147483647/)
  })

  it('rejects a fractional redirect cap at construction', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { fetchProvider: LOCAL_FETCH_PROVIDER_ID })
    await expect(ctx.plugin(fetchPlugin, { maxRedirects: 1.5 }))
      .rejects.toThrow(/maxRedirects must be a non-negative integer/)
  })

  it('rejects a negative redirect cap at construction', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { fetchProvider: LOCAL_FETCH_PROVIDER_ID })
    await expect(ctx.plugin(fetchPlugin, { maxRedirects: -1 }))
      .rejects.toThrow(/maxRedirects must be a non-negative integer/)
  })

  it('accepts maxRedirects: 0 (follow no redirects) as valid config', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { fetchProvider: LOCAL_FETCH_PROVIDER_ID })
    const fiber = await ctx.plugin(fetchPlugin, { maxRedirects: 0 })
    await expect(ctx.web.fetch({ url: `${base}/` }))
      .resolves.toMatchObject({ statusCode: 200 })
    await fiber.dispose()
  })

  it('rejects a malformed address block at construction', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { fetchProvider: LOCAL_FETCH_PROVIDER_ID })
    await expect(ctx.plugin(fetchPlugin, { trustedProxyAddressRanges: ['198.18.0.0/33'] }))
      .rejects.toThrow(/trustedProxyAddressRanges\[0\] "198\.18\.0\.0\/33" is not a valid IPv4 or IPv6 CIDR block/)
    await expect(ctx.plugin(fetchPlugin, { trustedProxyAddressRanges: '198.18.0.0/15' as never }))
      .rejects.toThrow()
  })

  it('declares no address block by default, so a synthetic answer is still refused', async () => {
    // The resolver is replaced, not the guard: the real policy still decides every answer, with
    // exactly the blocks `apply()` compiled from an operator's empty configuration.
    const resolve = vi.spyOn(publicHttpNetwork, 'resolve').mockImplementation(
      (hostname, signal, _resolver, trusted) => resolvePublicAddresses(
        hostname, signal, async () => [{ address: '198.18.3.178', family: 4 }], trusted),
    )
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { fetchProvider: LOCAL_FETCH_PROVIDER_ID })
    const fiber = await ctx.plugin(fetchPlugin, {})
    await expect(ctx.web.fetch({ url: 'https://cursor.test/' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_BLOCKED_URL' }))
    expect(resolve.mock.calls[0]?.[3]).toEqual([])
    await fiber.dispose()
  })

  it('fetches a synthetic answer from the pool the operator declared', async () => {
    const resolve = vi.spyOn(publicHttpNetwork, 'resolve').mockImplementation(
      (hostname, signal, _resolver, trusted) => resolvePublicAddresses(
        hostname, signal, async () => [{ address: '198.18.3.178', family: 4 }], trusted),
    )
    vi.spyOn(publicHttpNetwork, 'request').mockImplementation(async () => ({
      response: new Response('synthetic', { headers: { 'content-type': 'text/plain' } }) as never,
      close: async () => {},
    }))

    const ctx = new Context()
    await ctx.plugin(WebRuntime, { fetchProvider: LOCAL_FETCH_PROVIDER_ID })
    const fiber = await ctx.plugin(fetchPlugin, { trustedProxyAddressRanges: ['198.18.0.0/15'] })
    await expect(ctx.web.fetch({ url: 'https://cursor.test/' }))
      .resolves.toMatchObject({ statusCode: 200, body: { kind: 'text', content: 'synthetic' } })
    expect(resolve).toHaveBeenCalledWith(
      'cursor.test',
      expect.any(AbortSignal),
      expect.any(Function),
      [expect.objectContaining({ prefixLength: 15 })],
    )
    await fiber.dispose()
  })
})
