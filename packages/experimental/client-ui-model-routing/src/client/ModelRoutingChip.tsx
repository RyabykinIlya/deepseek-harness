/**
 * The composer chip: which tier is running, and which concrete model and
 * upstream provider answered it.
 *
 * A tier on its own says nothing actionable — `flash` could be any of five
 * models on any of a dozen providers. The concrete model is what a person needs
 * when a turn goes wrong, so the chip shows both and keeps the provider,
 * quantization, and boundary in the tooltip, where they are one hover away
 * rather than three more words in the input bar.
 *
 * The route decides at a request boundary, so a model picked in the composer is
 * not in force until the next request: the answered model stays pinned until
 * then. A chip naming only the answered model reads as if that pick had been
 * ignored, so while a selection is waiting the chip names it after an arrow.
 *
 * The chip renders nothing at all before the route's first decision: a session
 * that has not yet chosen a model has nothing honest to say about one.
 */

import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelSelectionProjection } from '@deepseek-ai/dsh-api-session-controller/types'
import type { NS } from './locales.ts'
import css from './ModelRoutingChip.module.css'

/** Full props for the composer chip. */
export type ModelRoutingChipProps =
  PropsRuntime<'conversation.input.right'> & PropsLocale<typeof NS>

/**
 * The model id without its `author/` prefix.
 *
 * `deepseek/deepseek-v4-flash` reads as `deepseek-v4-flash` beside a tier called
 * `flash`: the tier already says which vendor's tier this is, so the author
 * would be the part repeated twice.
 * @param model - OpenRouter model id, `author/slug`.
 * @returns the slug on its own.
 */
export function shortModel(model: string): string {
  const slash = model.indexOf('/')
  return slash === -1 ? model : model.slice(slash + 1)
}

/**
 * The model the next request would ask for, when that differs from the model the
 * last decision was asked for.
 *
 * `modelSelection.next` is the pending selection while one exists and the last
 * used selection otherwise, so a `next` equal to the decision's own request means
 * nothing is waiting to be applied. Comparing the request rather than the
 * answered model keeps an `auto` or tier request from reading as pending just
 * because a concrete model answered it.
 * @param requested - the model the last recorded decision was asked for.
 * @param selection - the `modelSelection` projection, or `undefined` on a Host that does not serve it.
 * @returns the pending model id, or `undefined` when no selection is waiting.
 */
export function pendingModel(
  requested: string,
  selection: ModelSelectionProjection | undefined,
): string | undefined {
  const next = selection?.next
  if (next === undefined || next === null || next.model === requested) return undefined
  return next.model
}

/**
 * Composer entry point for the current session's routing decision.
 * @param props - session standard props and the translator.
 * @returns the compact chip, or null before the first decision.
 */
export function ModelRoutingChip({ useProjection, t }: ModelRoutingChipProps) {
  const view = useProjection('modelRouting')
  const selection = useProjection('modelSelection')
  if (view === undefined || view === null) return null
  // Only the two shipped tiers have a translated label; a deployment that adds
  // a third sees its own name, which is what the operator typed into the config.
  const tier = view.tier === 'pro' ? t('tier.pro') : view.tier === 'flash' ? t('tier.flash') : view.tier
  const pending = pendingModel(view.requested, selection)
  const label = `${tier} · ${shortModel(view.model)}`
  const title = [
    view.model,
    view.providerName ?? t('chip.unpinned'),
    view.quantization ?? '?',
    t(`boundary.${view.boundary}`),
    ...pending === undefined ? [] : [t('chip.pending', { model: pending })],
  ].join(' · ')
  return (
    <span
      className={pending === undefined ? css.chip : `${css.chip} ${css.chipPending}`}
      title={title}
      data-testid="model-routing-chip"
    >
      {pending === undefined ? label : `${label} → ${shortModel(pending)}`}
    </span>
  )
}
