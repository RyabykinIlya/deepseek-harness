import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebRuntime, { WebError } from '@deepseek-ai/dsh-web'
import {
  anchorHref,
  anchorInnerHtml,
  DUCKDUCKGO_DEFAULT_ENDPOINT,
  DUCKDUCKGO_DEFAULT_MAX_RESPONSE_BYTES,
  DUCKDUCKGO_DEFAULT_TIMEOUT_MS,
  DUCKDUCKGO_DEFAULT_USER_AGENT,
  DUCKDUCKGO_PROVIDER_ID,
  DuckDuckGoSearchProvider,
  extractResultLinks,
  mapResultLink,
  mapResultsPage,
} from '../src/provider.ts'
import * as ddgPlugin from '../src/index.ts'

const options = {
  endpoint: 'https://ddg.test/html/',
  userAgent: 'agent/1.0',
  timeoutMs: 1_000,
  maxResponseBytes: 65_536,
}

/** One result block as DuckDuckGo's HTML endpoint serves it, markup trimmed only. */
const REAL_BLOCK = `<div class="result results_links results_links_deep web-result ">
  <div class="links_main links_deep result__body">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="https://www.deepseek.com/en/harness/">DeepSeek Harness | Explore the limits of intelligence</a>
    </h2>
    <div class="result__extras">
      <div class="result__extras__url">
        <span class="result__icon">
          <a rel="nofollow" href="https://www.deepseek.com/en/harness/">
            <img class="result__icon__img" width="16" height="16" alt="" src="//external-content.duckduckgo.com/ip3/www.deepseek.com.ico" name="i15" />
          </a>
        </span>
        <a class="result__url" href="https://www.deepseek.com/en/harness/">
          www.deepseek.com/en/harness/
        </a>
      </div>
    </div>
    <a class="result__snippet" href="https://www.deepseek.com/en/harness/">Use <b>DeepSeek</b> <b>Harness</b> to work with documents, analyze spreadsheets, write code, and schedule tasks. Extend its capabilities with composable plugins.</a>
    <div class="clear"></div>
  </div>
</div>`

/** The HTTP 202 anomaly page the endpoint serves to a client it does not trust. */
const CHALLENGE_PAGE = `<!DOCTYPE html>
<html lang="en"><head><title>DuckDuckGo</title>
<script src="/dist/anomaly.js"></script></head>
<body><div class="challenge-form"><p>Please verify you are human.</p></div>
<a rel="nofollow" class="result__a">not a real result</a>
</body></html>`

/** Build one minimal result block. */
function block(href: string, title: string, snippet?: string): string {
  const snippetAnchor = snippet === undefined
    ? ''
    : `<a class="result__snippet" href="${href}">${snippet}</a>`
  return `<div class="result"><h2 class="result__title">
    <a rel="nofollow" class="result__a" href="${href}">${title}</a>
  </h2>${snippetAnchor}</div>`
}

/** A successful HTML response. */
function htmlResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html' }, ...init })
}

/** A successful response whose body arrives as the given chunks, so byte caps are exact. */
function chunkedResponse(chunks: readonly string[]): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
      controller.close()
    },
  }))
}

/** A successful response whose body read fails the way an aborted transfer does. */
function abortedBodyResponse(): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.error(new DOMException('aborted', 'AbortError')) },
  }))
}

/** The `RequestInit` of the one call the stubbed `fetch` received. */
function requestOf(mock: ReturnType<typeof vi.fn<typeof fetch>>, index = 0): RequestInit {
  return mock.mock.calls[index]?.[1] ?? {}
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('DuckDuckGo anchor readers', () => {
  it('reads an href out of a matched anchor tag', () => {
    expect(anchorHref('<a rel="nofollow" class="result__a" href="https://a.test/x?y=1&amp;z=2">t</a>'))
      .toBe('https://a.test/x?y=1&amp;z=2')
  })

  it('reports no href for a tag that carries none', () => {
    expect(anchorHref('<a class="result__a">t</a>')).toBeUndefined()
  })

  it('reads the inner HTML between the tag and its closing tag', () => {
    expect(anchorInnerHtml('<a class="result__a" href="https://a.test"><b>hi</b> there</a>'))
      .toBe('<b>hi</b> there')
  })

  it('reads an empty inner HTML from an anchor with no closing tag', () => {
    expect(anchorInnerHtml('<a class="result__a" href="https://a.test">truncated')).toBe('')
  })
})

describe('DuckDuckGo result extraction', () => {
  it('extracts the real block shape with its snippet', () => {
    expect(extractResultLinks(REAL_BLOCK)).toEqual([{
      href: 'https://www.deepseek.com/en/harness/',
      titleHtml: 'DeepSeek Harness | Explore the limits of intelligence',
      snippetHtml: 'Use <b>DeepSeek</b> <b>Harness</b> to work with documents, analyze spreadsheets, write code, and schedule tasks. Extend its capabilities with composable plugins.',
    }])
  })

  it('extracts every block of a multi-result page in document order', () => {
    const html = `${block('https://a.test', 'A', 'first')}${block('https://b.test', 'B', 'second')}`
    expect(extractResultLinks(html).map(link => link.href)).toEqual(['https://a.test', 'https://b.test'])
  })

  it('omits the snippet when a block rendered none', () => {
    expect(extractResultLinks(block('https://a.test', 'A'))).toEqual([{
      href: 'https://a.test',
      titleHtml: 'A',
    }])
  })

  it('never lends a block the snippet that follows it', () => {
    const html = `${block('https://a.test', 'A')}${block('https://b.test', 'B', 'belongs to B')}`
    expect(extractResultLinks(html)[1]?.snippetHtml).toBe('belongs to B')
    expect(extractResultLinks(html)[0]?.snippetHtml).toBeUndefined()
  })

  it('skips a result anchor that carries no href', () => {
    expect(extractResultLinks('<a class="result__a">no target</a>')).toEqual([])
  })

  it('extracts nothing from a challenge page', () => {
    expect(extractResultLinks(CHALLENGE_PAGE)).toEqual([])
  })

  it('stays roughly linear, not quadratic, on many anchors with no closing tag', () => {
    // `endpoint` is operator-configurable, so a page the parser does not control
    // can carry many `<a class="result__a" ...>` opens with no `</a>` ever
    // following. An unbounded lazy `[\s\S]*?` scans to the end of the document
    // on every such attempt, which is quadratic in the number of such anchors
    // (measured ~1.5s for 8k before this test's bound was added). Two sizes
    // eight times apart should differ by roughly 8x if linear, not ~64x.
    const unterminated = (n: number): string => '<a class="result__a" href="x">'.repeat(n)
    const small = unterminated(1000)
    const large = unterminated(8000)
    const timeOf = (html: string): number => {
      const start = performance.now()
      extractResultLinks(html)
      return performance.now() - start
    }
    timeOf(small) // warm up the engine before timing either size
    const smallMs = Math.max(timeOf(small), 0.1)
    const largeMs = timeOf(large)
    expect(largeMs / smallMs).toBeLessThan(20)
  })
})

describe('DuckDuckGo result mapping', () => {
  it('maps a full block, decoding entities and dropping emphasis tags', () => {
    expect(mapResultLink(extractResultLinks(REAL_BLOCK)[0] ?? { href: '', titleHtml: '' })).toEqual({
      url: 'https://www.deepseek.com/en/harness/',
      title: 'DeepSeek Harness | Explore the limits of intelligence',
      snippet: 'Use DeepSeek Harness to work with documents, analyze spreadsheets, write code, and schedule tasks. Extend its capabilities with composable plugins.',
    })
  })

  it('decodes decimal, hexadecimal and named character references', () => {
    expect(mapResultLink({
      href: 'https://a.test/?a=1&amp;b=2',
      titleHtml: 'A &amp; B &#x27;quoted&#x27; &#38; &#233;',
      snippetHtml: '&quot;q&quot; &mdash; &hellip; &unknownref;',
    })).toEqual({
      url: 'https://a.test/?a=1&b=2',
      title: "A & B 'quoted' & é",
      snippet: '"q" — … &unknownref;',
    })
  })

  it('reads an uppercase hexadecimal reference', () => {
    expect(mapResultLink({ href: 'https://a.test', titleHtml: 'A&#X2F;B' })?.title).toBe('A/B')
  })

  it('leaves a numeric reference outside the Unicode range verbatim', () => {
    expect(mapResultLink({ href: 'https://a.test', titleHtml: 'A&#1114112;B' })?.title).toBe('A&#1114112;B')
  })

  it('resolves a protocol-relative target', () => {
    expect(mapResultLink({ href: '//a.test/x', titleHtml: 'A' })?.url).toBe('https://a.test/x')
  })

  it('keeps an http target', () => {
    expect(mapResultLink({ href: 'http://a.test/x', titleHtml: 'A' })?.url).toBe('http://a.test/x')
  })

  it('refuses a target that is not absolute http(s)', () => {
    expect(mapResultLink({ href: 'javascript:alert(1)', titleHtml: 'A' })).toBeUndefined()
    expect(mapResultLink({ href: 'not a url', titleHtml: 'A' })).toBeUndefined()
  })

  it('unwraps DuckDuckGo\'s own click-redirect to the real target', () => {
    // Every anchor on the real page — organic and ad alike — points at this
    // wrapper rather than the destination directly; fetching the wrapper itself
    // returns only a JS redirect page, so the model would see no content for
    // any source without unwrapping it here.
    const wrapped = 'https://duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Flearn&rut=4947f4daf7638'
    expect(mapResultLink({ href: wrapped, titleHtml: 'Node.js' })?.url).toBe('https://nodejs.org/learn')
  })

  it('unwraps a protocol-relative click-redirect too', () => {
    const wrapped = '//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.test%2Fx&rut=abc'
    expect(mapResultLink({ href: wrapped, titleHtml: 'A' })?.url).toBe('https://a.test/x')
  })

  it('drops an ad whose click-redirect still points at DuckDuckGo\'s own click-tracking endpoint', () => {
    // An ad's `uddg` value is DuckDuckGo's `y.js` click-tracking endpoint, not
    // the advertiser's site — the real advertiser URL is itself wrapped a
    // second time inside `y.js`'s own query string. That remaining
    // DuckDuckGo-hosted target, after one unwrap, is what distinguishes an ad
    // from an organic result at this layer.
    const adWrapped = 'https://duckduckgo.com/l/?uddg=https%3A%2F%2Fduckduckgo.com%2Fy.js%3Fad_domain%3Dexample.com&rut=abc'
    expect(mapResultLink({ href: adWrapped, titleHtml: 'Sponsored' })).toBeUndefined()
  })

  it('drops a click-redirect with no uddg target rather than citing the wrapper itself', () => {
    expect(mapResultLink({ href: 'https://duckduckgo.com/l/?rut=abc', titleHtml: 'A' })).toBeUndefined()
    expect(mapResultLink({ href: 'https://duckduckgo.com/l/?uddg=not-a-url&rut=abc', titleHtml: 'A' })).toBeUndefined()
  })

  it('omits a blank title and a blank snippet rather than emitting them', () => {
    expect(mapResultLink({ href: 'https://a.test', titleHtml: '   ', snippetHtml: '  ' }))
      .toEqual({ url: 'https://a.test/' })
    expect(mapResultLink({ href: 'https://a.test', titleHtml: 'A', snippetHtml: '<b></b>' }))
      .toEqual({ url: 'https://a.test/', title: 'A' })
  })

  it('maps a page to sources in order, dropping repeats and unusable targets', () => {
    const html = [
      block('https://a.test', 'A', 'first'),
      block('javascript:alert(1)', 'evil'),
      block('https://a.test', 'A again', 'repeat'),
      block('https://b.test', 'B', 'second'),
    ].join('')
    expect(mapResultsPage(html, undefined)).toEqual({
      sources: [
        { url: 'https://a.test/', title: 'A', snippet: 'first' },
        { url: 'https://b.test/', title: 'B', snippet: 'second' },
      ],
      truncated: false,
    })
  })

  it('honors a result bound and flags the cut', () => {
    const html = `${block('https://a.test', 'A', 'first')}${block('https://b.test', 'B', 'second')}`
    expect(mapResultsPage(html, 1)).toEqual({
      sources: [{ url: 'https://a.test/', title: 'A', snippet: 'first' }],
      truncated: true,
    })
    expect(mapResultsPage(html, 2).truncated).toBe(false)
  })

  it('maps a challenge page to an empty result set rather than failing', () => {
    expect(mapResultsPage(CHALLENGE_PAGE, 5)).toEqual({ sources: [], truncated: false })
  })

  it('generates no answer content', () => {
    expect(mapResultsPage(REAL_BLOCK, undefined).content).toBeUndefined()
  })
})

describe('DuckDuckGoSearchProvider availability', () => {
  it('is available with the keyless defaults', () => {
    expect(new DuckDuckGoSearchProvider({
      endpoint: DUCKDUCKGO_DEFAULT_ENDPOINT,
      userAgent: DUCKDUCKGO_DEFAULT_USER_AGENT,
      timeoutMs: DUCKDUCKGO_DEFAULT_TIMEOUT_MS,
      maxResponseBytes: DUCKDUCKGO_DEFAULT_MAX_RESPONSE_BYTES,
    }).available()).toBe(true)
  })

  it('is misconfigured when the endpoint does not parse', () => {
    expect(new DuckDuckGoSearchProvider({ ...options, endpoint: 'not a url' }).available()).toBe(false)
  })

  it('is misconfigured when the user agent is blank', () => {
    expect(new DuckDuckGoSearchProvider({ ...options, userAgent: '   ' }).available()).toBe(false)
  })

  it('is misconfigured when timeoutMs is not a positive integer', () => {
    expect(new DuckDuckGoSearchProvider({ ...options, timeoutMs: 0 }).available()).toBe(false)
    expect(new DuckDuckGoSearchProvider({ ...options, timeoutMs: 1.5 }).available()).toBe(false)
  })

  it('is misconfigured when maxResponseBytes is not a positive integer', () => {
    expect(new DuckDuckGoSearchProvider({ ...options, maxResponseBytes: -1 }).available()).toBe(false)
  })

  it('is misconfigured when numResults is set but not a positive integer', () => {
    expect(new DuckDuckGoSearchProvider({ ...options, numResults: 0 }).available()).toBe(false)
  })
})

describe('DuckDuckGoSearchProvider request', () => {
  it('POSTs the query as a form field with a browser user agent', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => htmlResponse(REAL_BLOCK))
    vi.stubGlobal('fetch', fetchMock)

    await new DuckDuckGoSearchProvider(options).search({ query: 'deepseek harness', maxResults: 5 })

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://ddg.test/html/')
    const init = requestOf(fetchMock)
    expect(init.method).toBe('POST')
    expect(init.redirect).toBe('error')
    expect(init.body).toBe('q=deepseek+harness')
    const headers = new Headers(init.headers)
    expect(headers.get('user-agent')).toBe('agent/1.0')
    expect(headers.get('content-type')).toBe('application/x-www-form-urlencoded')
    expect(headers.get('accept')).toContain('text/html')
  })

  it('always carries its own deadline signal', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => htmlResponse(REAL_BLOCK))
    vi.stubGlobal('fetch', fetchMock)

    await new DuckDuckGoSearchProvider(options).search({ query: 'q' })
    expect(requestOf(fetchMock).signal?.aborted).toBe(false)

    const controller = new AbortController()
    await new DuckDuckGoSearchProvider(options).search({ query: 'q' }, controller.signal)
    expect(requestOf(fetchMock, 1).signal?.aborted).toBe(false)
  })

  it('honors the request bound and the configured default', async () => {
    const html = `${block('https://a.test', 'A', 'first')}${block('https://b.test', 'B', 'second')}`
    const fetchMock = vi.fn<typeof fetch>(async () => htmlResponse(html))
    vi.stubGlobal('fetch', fetchMock)
    const provider = new DuckDuckGoSearchProvider({ ...options, numResults: 1 })

    await expect(provider.search({ query: 'q', maxResults: 2 }))
      .resolves.toMatchObject({ truncated: false })
    await expect(provider.search({ query: 'q' }))
      .resolves.toMatchObject({ truncated: true })
    await expect(new DuckDuckGoSearchProvider(options).search({ query: 'q' }))
      .resolves.toMatchObject({ truncated: false })
  })

  it('returns sources for a rendered page', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => htmlResponse(REAL_BLOCK)))
    const result = await new DuckDuckGoSearchProvider(options).search({ query: 'q' })
    expect(result.sources).toEqual([{
      url: 'https://www.deepseek.com/en/harness/',
      title: 'DeepSeek Harness | Explore the limits of intelligence',
      snippet: 'Use DeepSeek Harness to work with documents, analyze spreadsheets, write code, and schedule tasks. Extend its capabilities with composable plugins.',
    }])
  })
})

describe('DuckDuckGoSearchProvider body bound', () => {
  it('reads a whole body that fits the cap', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => chunkedResponse(['<p>', 'ok</p>'])))
    const result = await new DuckDuckGoSearchProvider(options).search({ query: 'q' })
    expect(result.sources).toEqual([])
  })

  it('keeps only the prefix that fits when a chunk overflows the cap', async () => {
    const html = `${block('https://a.test', 'A', 'first')}${block('https://b.test', 'B', 'second')}`
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => chunkedResponse([html])))
    // The cap lands inside the second block, so only the first survives the cut.
    const provider = new DuckDuckGoSearchProvider({ ...options, maxResponseBytes: 150 })
    const result = await provider.search({ query: 'q' })
    expect(result.sources.map(source => source.url)).toEqual(['https://a.test/'])
    expect(result.truncated).toBe(false)
  })

  it('releases a body that ends exactly at the cap', async () => {
    const html = block('https://a.test', 'A')
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => chunkedResponse([html])))
    // The cap lands on the last byte, so the reader stops with the document unread.
    const provider = new DuckDuckGoSearchProvider({
      ...options,
      maxResponseBytes: new TextEncoder().encode(html).byteLength,
    })
    await expect(provider.search({ query: 'q' })).resolves.toEqual({
      sources: [{ url: 'https://a.test/', title: 'A' }],
      truncated: false,
    })
  })

  it('reads an empty body without consuming a stream', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(null, { status: 200 })))
    await expect(new DuckDuckGoSearchProvider(options).search({ query: 'q' }))
      .resolves.toEqual({ sources: [], truncated: false })
  })
})

describe('DuckDuckGoSearchProvider error handling', () => {
  /** Return the provider's rejected WebError, or propagate an unexpected outcome. */
  async function rejectedWebError(operation: Promise<unknown>): Promise<WebError> {
    try {
      await operation
    } catch (error: unknown) {
      if (error instanceof WebError) return error
      throw error
    }
    throw new Error('expected search operation to reject')
  }

  it('maps a non-2xx response to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response('rate limited', { status: 429 })))
    await expect(new DuckDuckGoSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'DuckDuckGo search failed (HTTP 429)' }))
  })

  it('resolves an HTTP 202 challenge page as an empty result set', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => htmlResponse(CHALLENGE_PAGE, { status: 202 })))
    await expect(new DuckDuckGoSearchProvider(options).search({ query: 'q' }))
      .resolves.toEqual({ sources: [], truncated: false })
  })

  it('resolves markup that changed shape as an empty result set', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => htmlResponse('<main><p>redesigned</p></main>')))
    await expect(new DuckDuckGoSearchProvider(options).search({ query: 'q' }))
      .resolves.toEqual({ sources: [], truncated: false })
  })

  it('maps a network failure to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(() => Promise.reject(new TypeError('connection refused'))))
    const failure = await rejectedWebError(new DuckDuckGoSearchProvider(options).search({ query: 'q' }))
    expect(failure.code).toBe('WEB_PROVIDER_ERROR')
    expect(failure.message).toContain('connection refused')
  })

  it('maps the caller aborting to WEB_ABORTED', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>((_url, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal ?? new AbortController().signal
      const fail = (): void => { reject(new DOMException('aborted', 'AbortError')) }
      if (signal.aborted) fail()
      else signal.addEventListener('abort', fail, { once: true })
    })))
    const controller = new AbortController()
    const pending = new DuckDuckGoSearchProvider(options).search({ query: 'q' }, controller.signal)
    controller.abort(new Error('caller cancelled'))
    await expect(pending).rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED', message: 'DuckDuckGo search aborted' }))
  })

  it('maps its own deadline to WEB_PROVIDER_ERROR, not a cancellation', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>((_url, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal ?? new AbortController().signal
      signal.addEventListener('abort', () => { reject(new DOMException('aborted', 'AbortError')) }, { once: true })
    })))
    await expect(new DuckDuckGoSearchProvider({ ...options, timeoutMs: 5 }).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'DuckDuckGo search timed out after 5ms' }))
  })

  it('maps the real AbortSignal.timeout() rejection — named TimeoutError, not AbortError', async () => {
    // Node's own `AbortSignal.timeout()` aborts with a DOMException named
    // `TimeoutError`, never `AbortError`. A double that only ever mocks
    // `AbortError` (the test above) cannot catch a provider that checks for
    // the wrong name — reproduce the real rejection the deadline actually fires.
    vi.stubGlobal('fetch', vi.fn<typeof fetch>((_url, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal ?? new AbortController().signal
      // `AbortSignal.reason` types as `any` in lib.dom.d.ts; DOMException extends Error at
      // runtime (Node and browsers both), so the rejection is a real Error, not an escape hatch.
      signal.addEventListener('abort', () => { reject(signal.reason as DOMException) }, { once: true })
    })))
    await expect(new DuckDuckGoSearchProvider({ ...options, timeoutMs: 5 }).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'DuckDuckGo search timed out after 5ms' }))
  })

  it('maps a body read that aborts to the same timeout failure', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => abortedBodyResponse()))
    const failure = await rejectedWebError(new DuckDuckGoSearchProvider(options).search({ query: 'q' }))
    expect(failure.code).toBe('WEB_PROVIDER_ERROR')
    expect(failure.message).toContain('timed out')
  })

  it('maps a body read that fails outright to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.error(new TypeError('stream reset')) },
    }))))
    const failure = await rejectedWebError(new DuckDuckGoSearchProvider(options).search({ query: 'q' }))
    expect(failure.code).toBe('WEB_PROVIDER_ERROR')
    expect(failure.message).toContain('stream reset')
  })
})

describe('web-search-duckduckgo plugin registration', () => {
  it('registers the provider into ctx.web (HMR-safe)', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => htmlResponse(REAL_BLOCK)))
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: DUCKDUCKGO_PROVIDER_ID })
    const fiber = await ctx.plugin(ddgPlugin, {})
    const served = await ctx.web.search({ query: 'q' })
    expect(served.sources.length).toBeGreaterThan(0)
    expect(served.truncated).toBe(false)
    await fiber.dispose()
    await expect(ctx.web.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' }))
  })

  it('has no default export (namespace plugin export shape)', () => {
    expect('default' in ddgPlugin).toBe(false)
  })

  it('is selected automatically as the only usable search provider', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => htmlResponse(REAL_BLOCK)))
    const ctx = new Context()
    await ctx.plugin(WebRuntime, {})
    await ctx.plugin(ddgPlugin, {})
    await expect(ctx.web.search({ query: 'q' })).resolves.toMatchObject({ truncated: false })
  })

  it('threads endpoint, user agent, timeout, size cap and default count config through', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => htmlResponse(REAL_BLOCK))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: DUCKDUCKGO_PROVIDER_ID })
    const fiber = await ctx.plugin(ddgPlugin, {
      endpoint: 'https://ddg.test/lite/',
      userAgent: 'configured/2.0',
      numResults: 3,
      timeoutMs: 2_000,
      maxResponseBytes: 4_096,
    })
    await ctx.web.search({ query: 'q' })
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://ddg.test/lite/')
    expect(new Headers(requestOf(fetchMock).headers).get('user-agent')).toBe('configured/2.0')
    await fiber.dispose()
  })

  it('applies the keyless defaults when config is empty', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => htmlResponse(REAL_BLOCK))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: DUCKDUCKGO_PROVIDER_ID })
    const fiber = await ctx.plugin(ddgPlugin, {})
    await ctx.web.search({ query: 'q' })
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://html.duckduckgo.com/html/')
    expect(new Headers(requestOf(fetchMock).headers).get('user-agent')).toBe(DUCKDUCKGO_DEFAULT_USER_AGENT)
    await fiber.dispose()
  })
})
