import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { OpenRouterEndpoint } from '@deepseek-ai/dsh-llm-pi-ai'
import {
  DiagnosticsFile,
  candidatesOf,
  cheapestRejectedOf,
  diagnosticsLine,
} from '../src/diagnostics.ts'
import type { SelectionResult, TurnMix } from '../src/select.ts'
import type { RoutingCandidate, RoutingDiagnosticsRecord } from '../src/types.ts'

const MIX: TurnMix = { cached: 0.9, fresh: 0.08, output: 0.02 }

/** One endpoint as the wire sent it, with only the fields a case names. */
function endpointOf(slug: string, over: Partial<OpenRouterEndpoint> = {}): OpenRouterEndpoint {
  return {
    slug,
    promptPrice: 1e-7,
    completionPrice: 3e-7,
    inputCacheReadPrice: 5e-8,
    status: 0,
    uptimeLast30m: 99,
    ...over,
  }
}

/** A ranking outcome assembled by hand; `select.spec.ts` owns the real one. */
function resultOf(over: Partial<SelectionResult> = {}): SelectionResult {
  return {
    ranked: [],
    rejections: {
      modality: 0, excluded: 0, status: 0, uptime: 0, tools: 0, context: 0,
      quantization: 0, 'untrusted-unknown': 0, unpriced: 0, free: 0, paid: 0,
    },
    considered: 0,
    unreadable: [],
    rejected: [],
    ...over,
  }
}

/** The complete fields a diagnostics line needs, with candidates injected. */
function recordOf(candidates: readonly RoutingCandidate[]): RoutingDiagnosticsRecord {
  return {
    at: 1000,
    boundary: 'start',
    requested: 'flash',
    tier: 'flash',
    model: 'z-ai/glm-5.3-flash',
    considered: candidates.length,
    runnersUp: [],
    excludedTags: [],
    unreadable: [],
    candidates,
  }
}

/** Read one written line the way a reader of the history would. */
function parseRecord(line: string): RoutingDiagnosticsRecord {
  return JSON.parse(line) as RoutingDiagnosticsRecord
}

describe('candidatesOf', () => {
  it('lists admitted endpoints in ranking order and dropped ones with their reason', () => {
    const winner = endpointOf('streamlake/fp8', { providerName: 'StreamLake', discount: 0.42, quantization: 'fp8' })
    const cheap = endpointOf('deepinfra/fp4', { providerName: 'DeepInfra', discount: 0.5, quantization: 'fp4' })
    const unpriced: OpenRouterEndpoint = {
      slug: 'mystery/tag', inputCacheReadPrice: 5e-8, status: 0, uptimeLast30m: 99,
    }
    const candidates = candidatesOf(resultOf({
      ranked: [{ model: 'm', endpoint: winner, blendedUsdPerToken: 2.8e-8, free: false }],
      rejected: [
        { model: 'm', endpoint: cheap, reason: 'quantization' },
        { model: 'm', endpoint: unpriced, reason: 'unpriced' },
      ],
      considered: 3,
    }), MIX)
    expect(candidates).toEqual([
      {
        model: 'm', tag: 'streamlake/fp8', providerName: 'StreamLake', quantization: 'fp8',
        promptUsd: 1e-7, completionUsd: 3e-7, cacheReadUsd: 5e-8, discount: 0.42, status: 0, uptimeLast30m: 99,
        blendedUsdPerToken: 2.8e-8, rank: 1,
      },
      {
        model: 'm', tag: 'deepinfra/fp4', providerName: 'DeepInfra', quantization: 'fp4',
        promptUsd: 1e-7, completionUsd: 3e-7, cacheReadUsd: 5e-8, discount: 0.5, status: 0, uptimeLast30m: 99,
        blendedUsdPerToken: 0.9 * 5e-8 + 0.08 * 1e-7 + 0.02 * 3e-7, rejection: 'quantization',
      },
      // A dropped endpoint records the price it would have paid, or none at all
      // when it published too little to state one.
      {
        model: 'm', tag: 'mystery/tag', cacheReadUsd: 5e-8, status: 0, uptimeLast30m: 99, rejection: 'unpriced',
      },
    ])
  })

  it('omits a field the endpoint did not publish', () => {
    const candidates = candidatesOf(resultOf({
      rejected: [{ model: 'm', endpoint: { slug: 'bare' }, reason: 'status' }],
    }), MIX)
    expect(candidates).toEqual([{ model: 'm', tag: 'bare', rejection: 'status' }])
  })
})

describe('cheapestRejectedOf', () => {
  it('keeps one entry per reason, cheapest first and unpriced last', () => {
    const candidates: RoutingCandidate[] = [
      { model: 'm', tag: 'kept', rank: 1, blendedUsdPerToken: 1e-8 },
      { model: 'm', tag: 'dear-fp4', rejection: 'quantization', blendedUsdPerToken: 3e-8 },
      { model: 'm', tag: 'cheap-fp4', rejection: 'quantization', blendedUsdPerToken: 2e-8 },
      { model: 'm', tag: 'no-price', rejection: 'quantization' },
      { model: 'm', tag: 'down', rejection: 'status', blendedUsdPerToken: 1.5e-8 },
      { model: 'm', tag: 'unknown-q', rejection: 'untrusted-unknown' },
    ]
    expect(cheapestRejectedOf(candidates).map(entry => entry.tag)).toEqual([
      'down', 'cheap-fp4', 'unknown-q',
    ])
  })

  it('replaces an unpriced incumbent as soon as one states a price', () => {
    const candidates: RoutingCandidate[] = [
      { model: 'm', tag: 'no-price', rejection: 'quantization' },
      { model: 'm', tag: 'priced', rejection: 'quantization', blendedUsdPerToken: 1e-8 },
    ]
    expect(cheapestRejectedOf(candidates).map(entry => entry.tag)).toEqual(['priced'])
  })

  it('answers an empty table with an empty list', () => {
    expect(cheapestRejectedOf([])).toEqual([])
  })
})

describe('diagnosticsLine', () => {
  const candidates: RoutingCandidate[] = [
    { model: 'm', tag: 'one', blendedUsdPerToken: 1e-8, rank: 1 },
    { model: 'm', tag: 'two', blendedUsdPerToken: 2e-8, rank: 2 },
    { model: 'm', tag: 'three', blendedUsdPerToken: 3e-8, rank: 3 },
  ]

  it('keeps every candidate at exactly the budget the full line needs', () => {
    const record = recordOf(candidates)
    const full = diagnosticsLine(record, Number.MAX_SAFE_INTEGER)!
    const exact = diagnosticsLine(record, Buffer.byteLength(full.line, 'utf8'))!
    expect(exact.line).toBe(full.line)
    expect(exact.dropped).toBe(0)
  })

  it('drops candidates from the tail once one byte is missing', () => {
    const record = recordOf(candidates)
    const full = diagnosticsLine(record, Number.MAX_SAFE_INTEGER)!
    const short = diagnosticsLine(record, Buffer.byteLength(full.line, 'utf8') - 1)!
    expect(short.dropped).toBe(1)
    expect(parseRecord(short.line).candidates).toHaveLength(2)
  })

  it('drops one oversized candidate and keeps the smaller ones around it', () => {
    const huge = { model: 'm', tag: 'x'.repeat(4000), rank: 2, blendedUsdPerToken: 2e-8 }
    const record = recordOf([candidates[0]!, huge, candidates[2]!])
    const budget = 1200
    const built = diagnosticsLine(record, budget)!
    expect(built.dropped).toBe(1)
    expect(parseRecord(built.line).candidates.map(entry => entry.tag)).toEqual(['one', 'three'])
    expect(Buffer.byteLength(built.line, 'utf8')).toBeLessThanOrEqual(budget)
  })

  it('measures the budget in bytes, not in characters', () => {
    const cyrillic = { model: 'm', tag: 'ёж', providerName: 'Ёлка-провайдер', rank: 1, blendedUsdPerToken: 1e-8 }
    const record = recordOf([cyrillic])
    const full = diagnosticsLine(record, Number.MAX_SAFE_INTEGER)!
    expect(full.line.length).toBeLessThan(Buffer.byteLength(full.line, 'utf8'))
    // A budget equal to the line's character count is short by the second byte
    // every Cyrillic letter carries, so the row does not fit under it.
    expect(diagnosticsLine(record, full.line.length)!.dropped).toBe(1)
    expect(diagnosticsLine(record, Buffer.byteLength(full.line, 'utf8'))!.dropped).toBe(0)
  })

  it('answers nothing when the record alone exceeds the budget', () => {
    expect(diagnosticsLine(recordOf([]), 10)).toBeUndefined()
  })
})

describe('DiagnosticsFile', () => {
  const directories: string[] = []
  afterEach(async () => {
    await Promise.all(directories.splice(0).map(entry => rm(entry, { recursive: true, force: true })))
  })

  /** A fresh directory this case owns until the `afterEach` removes it. */
  async function directoryOf(): Promise<string> {
    const created = await mkdtemp(join(tmpdir(), 'model-routing-diagnostics-'))
    directories.push(created)
    return created
  }

  it('appends one JSON line per decision, creating the directory on the way', async () => {
    const root = await directoryOf()
    const path = join(root, 'nested', 'history.jsonl')
    const warnings: string[] = []
    const file = new DiagnosticsFile({ path: () => path, maxBytes: () => 65536, warn: message => warnings.push(message) })
    file.record(recordOf([{ model: 'm', tag: 'one', blendedUsdPerToken: 1e-8, rank: 1 }]))
    file.record(recordOf([]))
    await file.flush()
    const lines = (await readFile(path, 'utf8')).trimEnd().split('\n')
    expect(lines).toHaveLength(2)
    const first = parseRecord(lines[0]!)
    expect(first.model).toBe('z-ai/glm-5.3-flash')
    expect(first.candidates).toEqual([{ model: 'm', tag: 'one', blendedUsdPerToken: 1e-8, rank: 1 }])
    expect(parseRecord(lines[1]!).candidates).toEqual([])
    expect(warnings).toEqual([])
  })

  it('writes no history at all while the configured path is empty', async () => {
    const warnings: string[] = []
    const file = new DiagnosticsFile({ path: () => '', maxBytes: () => 65536, warn: message => warnings.push(message) })
    file.record(recordOf([]))
    await file.flush()
    expect(warnings).toEqual([])
  })

  it('warns and writes nothing when the budget cannot hold one record', async () => {
    const root = await directoryOf()
    const path = join(root, 'history.jsonl')
    const warnings: string[] = []
    const file = new DiagnosticsFile({ path: () => path, maxBytes: () => 10, warn: message => warnings.push(message) })
    file.record(recordOf([]))
    await file.flush()
    expect(warnings).toEqual([expect.stringContaining('diagnosticsMaxBytes 10 cannot hold one decision record')])
    expect(warnings[0]).toContain(path)
  })

  it('contains an append failure and keeps the request alive', async () => {
    const root = await directoryOf()
    const warnings: string[] = []
    // A directory cannot be appended to, which is what an unusable path reports.
    const file = new DiagnosticsFile({ path: () => root, maxBytes: () => 65536, warn: message => warnings.push(message) })
    file.record(recordOf([]))
    await file.flush()
    expect(warnings).toEqual([expect.stringContaining(`could not append a diagnostics record to ${root}`)])
  })

  it('records what the byte budget could not hold by leaving it out', async () => {
    const root = await directoryOf()
    const path = join(root, 'history.jsonl')
    const warnings: string[] = []
    const candidates: RoutingCandidate[] = Array.from({ length: 20 }, (_, index) => ({
      model: 'm', tag: `tag-${index}`, rank: index + 1, blendedUsdPerToken: 1e-8,
    }))
    const file = new DiagnosticsFile({ path: () => path, maxBytes: () => 1200, warn: message => warnings.push(message) })
    file.record(recordOf(candidates))
    await file.flush()
    const written = parseRecord((await readFile(path, 'utf8')).trimEnd())
    expect(written.candidates.length).toBeLessThan(candidates.length)
    // `considered` still names every endpoint the ranking walked.
    expect(written.considered).toBe(20)
    expect(warnings).toEqual([])
  })
})
