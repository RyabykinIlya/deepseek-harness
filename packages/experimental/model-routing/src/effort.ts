/**
 * Mapping a tier-level reasoning effort onto whatever a concrete model accepts.
 *
 * The tiers advertise one effort vocabulary, and the models inside them do not
 * share it: DeepSeek v4 takes `off`/`high`/`xhigh`, GLM 5.3 takes `low`/`high`/`max`,
 * Nemotron free takes `off`/`low`/`medium`. A tier is a promise the operator makes
 * once, so the mapping has to be forgiving in exactly one direction — round *up* to
 * the next supported level — because silently dropping the request would hand a
 * pro-tier turn to a model thinking less than the operator asked for.
 *
 * @module dsh-experimental-model-routing/effort
 */

/** Every effort name the mapping ranks, cheapest reasoning first. */
export const EFFORT_ORDER = ['off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/**
 * Map a tier-level effort to a concrete model's supported effort.
 * @param requested - the effort the tier or the request asked for.
 * @param supported - the efforts the chosen model declares, when it declares any.
 * @returns the same id when supported; otherwise the nearest supported id above,
 *   otherwise the nearest below excluding 'off' and 'none'; undefined when the request is
 *   undefined, the model lists no efforts, or the requested id is not in EFFORT_ORDER.
 */
export function mapEffort(requested: string | undefined, supported: readonly string[] | undefined): string | undefined {
  if (requested === undefined || supported === undefined || supported.length === 0) return undefined
  const wanted = (EFFORT_ORDER as readonly string[]).indexOf(requested)
  if (wanted === -1) return undefined
  // Only names the ranking knows can be compared; a provider that invents one
  // gets no mapping rather than an arbitrary position.
  const usable = supported.filter(id => (EFFORT_ORDER as readonly string[]).includes(id))
  if (usable.length === 0) return undefined
  const above = usable
    .map(id => ({ id, index: (EFFORT_ORDER as readonly string[]).indexOf(id) }))
    .filter(entry => entry.index >= wanted)
    .sort((left, right) => left.index - right.index)[0]
  if (above !== undefined) return above.id
  // Nothing at or above: the nearest below, but never "no reasoning at all" —
  // that would answer a weaker request than the operator asked for.
  return usable
    .map(id => ({ id, index: (EFFORT_ORDER as readonly string[]).indexOf(id) }))
    .filter(entry => entry.index < wanted && entry.id !== 'off' && entry.id !== 'none')
    .sort((left, right) => right.index - left.index)[0]?.id
}
