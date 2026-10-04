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
 * The chip renders nothing at all before the route's first decision: a session
 * that has not yet chosen a model has nothing honest to say about one.
 */

import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
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
 * Composer entry point for the current session's routing decision.
 * @param props - session standard props and the translator.
 * @returns the compact chip, or null before the first decision.
 */
export function ModelRoutingChip({ useProjection, t }: ModelRoutingChipProps) {
  const view = useProjection('modelRouting')
  if (view === undefined || view === null) return null
  // Only the two shipped tiers have a translated label; a deployment that adds
  // a third sees its own name, which is what the operator typed into the config.
  const tier = view.tier === 'pro' ? t('tier.pro') : view.tier === 'flash' ? t('tier.flash') : view.tier
  const label = `${tier} · ${shortModel(view.model)}`
  const title = [
    view.model,
    view.providerName ?? t('chip.unpinned'),
    view.quantization ?? '?',
    t(`boundary.${view.boundary}`),
  ].join(' · ')
  return (
    <span className={css.chip} title={title} data-testid="model-routing-chip">
      {label}
    </span>
  )
}
