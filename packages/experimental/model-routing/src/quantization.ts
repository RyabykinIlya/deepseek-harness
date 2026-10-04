/**
 * Quantization ranks and the `quantizations` filter list they produce.
 *
 * OpenRouter names a handful of quantization formats per endpoint, and the tiers
 * only compare them by precision: what matters for coding is how many bits carry
 * each weight, and every member of a rank group is interchangeable at that
 * granularity. Grouping rather than ordering exactly is what lets `fp8` admit
 * `int8` and `mxfp8` — all three are the same weight budget with a different
 * scaling scheme — without each tier having to know the names.
 *
 * @module dsh-experimental-model-routing/quantization
 */

import { QUANTIZATIONS } from './config.ts'
import type { Quantization } from './config.ts'

/** Precision rank by format; higher is more bits per weight. */
export const QUANTIZATION_RANK: Readonly<Record<Quantization, number>> = {
  int4: 2,
  fp4: 2,
  mxfp4: 2,
  nvfp4: 2,
  fp6: 3,
  int8: 4,
  fp8: 4,
  mxfp8: 4,
  fp16: 5,
  bf16: 5,
  fp32: 6,
}

/**
 * Precision rank of one endpoint's declared quantization.
 * @param value - the endpoint's `quantization`, or `undefined` when it states none.
 * @returns the rank, or `undefined` for an absent, `unknown`, or unlisted value.
 */
export function quantizationRank(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  return QUANTIZATION_RANK[value as Quantization]
}

/**
 * The `quantizations` filter list for a floor, in `QUANTIZATIONS` order.
 *
 * Only the unpinned fallback block uses this: a pinned request names one exact
 * endpoint tag and OpenRouter ignores the list, so the order exists to be
 * readable in the logged decision rather than to steer anything.
 * @param floor - the lowest precision the tier accepts.
 * @param includeUnknown - whether `unknown` belongs in the list, which is the wire
 *   equivalent of `unknownQuantization: 'trusted'` and `'accept'`.
 * @returns every named format at or above `floor`, plus `unknown` when asked for.
 */
export function quantizationsAtOrAbove(floor: Quantization, includeUnknown: boolean): string[] {
  const rank = QUANTIZATION_RANK[floor]
  return [
    ...QUANTIZATIONS.filter(name => QUANTIZATION_RANK[name] >= rank),
    ...includeUnknown ? ['unknown'] : [],
  ]
}
