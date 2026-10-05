/**
 * The decision diagnostics: the full candidate table of one routing decision,
 * and the append-only JSONL file that keeps it.
 *
 * The session event records what won. Answering *why a cheaper rival lost* needs
 * what the event cannot carry: every endpoint the ranking walked, with its
 * prices, its OpenRouter discount, its measurements, and the exact reason it was
 * dropped. That table is what this module builds and writes, one JSON line per
 * decision, so a price decision taken weeks ago can be re-checked against the
 * data as it was then rather than against a catalog that has since moved.
 *
 * Every line is bounded before it is written: candidates are added in ranking
 * order and a line never exceeds the configured byte budget, so a tier that
 * lists dozens of models cannot make one record unbounded. What did not fit is
 * derivable from the line itself — `considered` names every endpoint the
 * ranking walked and `candidates` lists those that fit.
 *
 * @module dsh-experimental-model-routing/diagnostics
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { OpenRouterEndpoint } from '@deepseek-ai/dsh-llm-pi-ai'
import { blendedPrice } from './select.ts'
import type { SelectionResult, TurnMix } from './select.ts'
import type { RoutingCandidate, RoutingDiagnosticsRecord } from './types.ts'

/** One complete JSONL line and what its budget could not hold. */
export interface DiagnosticsLine {
  /** The JSON object to append, without its trailing newline. */
  line: string
  /** Candidates left out to keep `line` within the budget. */
  dropped: number
}

/** One endpoint under the route's own names, without its ranking verdict. */
function candidateOf(model: string, endpoint: OpenRouterEndpoint): RoutingCandidate {
  return {
    model,
    tag: endpoint.slug,
    ...endpoint.providerName === undefined ? {} : { providerName: endpoint.providerName },
    ...endpoint.quantization === undefined ? {} : { quantization: endpoint.quantization },
    ...endpoint.promptPrice === undefined ? {} : { promptUsd: endpoint.promptPrice },
    ...endpoint.completionPrice === undefined ? {} : { completionUsd: endpoint.completionPrice },
    ...endpoint.inputCacheReadPrice === undefined ? {} : { cacheReadUsd: endpoint.inputCacheReadPrice },
    ...endpoint.discount === undefined ? {} : { discount: endpoint.discount },
    ...endpoint.contextLength === undefined ? {} : { contextLength: endpoint.contextLength },
    ...endpoint.maxCompletionTokens === undefined ? {} : { maxCompletionTokens: endpoint.maxCompletionTokens },
    ...endpoint.status === undefined ? {} : { status: endpoint.status },
    ...endpoint.uptimeLast30m === undefined ? {} : { uptimeLast30m: endpoint.uptimeLast30m },
  }
}

/**
 * Every endpoint one ranking walked, as a diagnostics record lists them.
 *
 * Admitted endpoints come first in ranking order, then the dropped ones in the
 * order the walk met them. A dropped endpoint keeps the blended price it *would*
 * have been charged at, which is what makes "a cheaper one was dropped" a fact
 * the record can state rather than an opinion it cannot back.
 * @param result - the outcome of the ranking pass that decided.
 * @param mix - the turn's token buckets the prices are blended under.
 * @returns one entry per considered endpoint.
 */
export function candidatesOf(result: SelectionResult, mix: TurnMix): RoutingCandidate[] {
  const admitted = result.ranked.map((entry, index) => ({
    ...candidateOf(entry.model, entry.endpoint),
    blendedUsdPerToken: entry.blendedUsdPerToken,
    rank: index + 1,
  }))
  const dropped = result.rejected.map(({ model, endpoint, reason }) => {
    const price = blendedPrice(endpoint, mix)
    return {
      ...candidateOf(model, endpoint),
      ...price === undefined ? {} : { blendedUsdPerToken: price },
      rejection: reason,
    }
  })
  return [...admitted, ...dropped]
}

/**
 * The cheapest endpoint each rejection reason dropped.
 *
 * This is the answer to "the leader is not the cheapest — where did the cheaper
 * one go": one entry per reason, cheapest first overall. A dropped endpoint that
 * states no price sorts behind every priced one, because "unknown" is not a
 * saving.
 * @param candidates - the full candidate table of one decision.
 * @returns at most one entry per reason present.
 */
export function cheapestRejectedOf(candidates: readonly RoutingCandidate[]): RoutingCandidate[] {
  const best = new Map<string, RoutingCandidate>()
  for (const candidate of candidates) {
    if (candidate.rejection === undefined) continue
    const current = best.get(candidate.rejection)
    if (current === undefined || cheaper(candidate, current)) best.set(candidate.rejection, candidate)
  }
  return [...best.values()].sort((left, right) => priceOf(left) - priceOf(right))
}

/** The sort key of one cheapest-rejected entry; an unpriced one sorts behind every priced one. */
function priceOf(candidate: RoutingCandidate): number {
  return candidate.blendedUsdPerToken ?? Number.MAX_SAFE_INTEGER
}

/** Whether one candidate undercuts another, with an unpriced one never winning. */
function cheaper(candidate: RoutingCandidate, current: RoutingCandidate): boolean {
  const price = candidate.blendedUsdPerToken
  const incumbent = current.blendedUsdPerToken
  if (price === undefined) return false
  if (incumbent === undefined) return true
  return price < incumbent
}

/**
 * Serialize one record under a byte budget.
 *
 * The budget is measured on the complete line in UTF-8 bytes, metadata
 * included. Candidates are offered in the order {@link candidatesOf} produced
 * them and each one is kept only if the whole line still fits, so a single
 * oversized candidate is dropped while the smaller ones around it survive.
 * @param record - the decision and its candidate table.
 * @param maxBytes - the largest line this writer may write.
 * @returns the line and its drop count, or `undefined` when the record without
 *   any candidate already exceeds the budget.
 */
export function diagnosticsLine(record: RoutingDiagnosticsRecord, maxBytes: number): DiagnosticsLine | undefined {
  const head = lineOf(record, [])
  if (byteLength(head) > maxBytes) return undefined
  const kept: RoutingCandidate[] = []
  let dropped = 0
  for (const candidate of record.candidates) {
    const trial = lineOf(record, [...kept, candidate])
    if (byteLength(trial) <= maxBytes) kept.push(candidate)
    else dropped += 1
  }
  return { line: lineOf(record, kept), dropped }
}

/** The JSON line for one record with exactly these candidates. */
function lineOf(record: RoutingDiagnosticsRecord, candidates: readonly RoutingCandidate[]): string {
  return JSON.stringify({ ...record, candidates })
}

/** The length of one line as it will be written, in UTF-8 bytes. */
function byteLength(line: string): number {
  return Buffer.byteLength(line, 'utf8')
}

/** What one {@link DiagnosticsFile} reads its deployment from. */
export interface DiagnosticsFileDeps {
  /** The file to append to; an empty string writes no history at all. */
  path(): string
  /** The largest one line may reach, in bytes. */
  maxBytes(): number
  /** Reports a contained failure; never throws into the request path. */
  warn(message: string): void
}

/**
 * The append-only diagnostics file, one JSON line per routing decision.
 *
 * Appends are queued and contained: a file that cannot be written warns and
 * loses that line, never the request that produced it. A path that cannot hold
 * one record at its budget is a configuration fault and says so on every
 * decision rather than writing a silently incomplete history.
 */
export class DiagnosticsFile {
  private queue: Promise<void> = Promise.resolve()
  private directoryReady = false

  constructor(private readonly deps: DiagnosticsFileDeps) {}

  /**
   * Queue one decision record for the file.
   *
   * Returns immediately; {@link DiagnosticsFile.flush} settles the write.
   * @param entry - the decision and its candidate table.
   */
  record(entry: RoutingDiagnosticsRecord): void {
    const path = this.deps.path()
    if (path === '') return
    const built = diagnosticsLine(entry, this.deps.maxBytes())
    if (built === undefined) {
      this.deps.warn(
        `model-routing: diagnosticsMaxBytes ${this.deps.maxBytes()} cannot hold one decision record for`
        + ` ${path}; nothing is written`,
      )
      return
    }
    this.queue = this.queue.then(() => this.append(path, built.line))
  }

  /** Append one already-bounded line, containing its own failure. */
  private async append(path: string, line: string): Promise<void> {
    try {
      if (!this.directoryReady) {
        await mkdir(dirname(path), { recursive: true })
        this.directoryReady = true
      }
      await appendFile(path, `${line}\n`, 'utf8')
    } catch (error: unknown) {
      // The request is worth more than the record of it: a history file that
      // cannot be written must not fail the turn that produced the record.
      this.deps.warn(`model-routing: could not append a diagnostics record to ${path}: ${String(error)}`)
    }
  }

  /**
   * Resolves once every record queued so far is on disk or has failed.
   * @returns the settled append chain.
   */
  flush(): Promise<void> {
    return this.queue
  }
}
