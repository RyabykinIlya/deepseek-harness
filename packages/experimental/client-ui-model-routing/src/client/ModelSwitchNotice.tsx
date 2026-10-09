/**
 * The model-switch row: which model and route took over, and why the route was
 * allowed to re-decide.
 *
 * The row names both sides rather than only the new one, because the fact worth
 * showing is the change itself: a reader comparing two answers needs to know
 * that the second came from a different model, and by how much the route moved.
 */

import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { NS } from './locales.ts'
import type { ModelSwitchServing } from './model-switch.ts'
import css from './ModelSwitch.module.css'

/** Full props for the model-switch row. */
export type ModelSwitchNoticeProps =
  PropsRuntime<'conversation.chat.node', 'model-switch'> & PropsLocale<typeof NS>

/** One side of the change, named as `route/model`. */
function servingLabel(serving: ModelSwitchServing): string {
  return `${serving.route}/${serving.model}`
}

/**
 * One recorded route change in the transcript.
 * @param props - the keyed Chat node and the translator.
 * @returns the row, labelled with both servings and the boundary that allowed it.
 */
export function ModelSwitchNotice({ node, t }: ModelSwitchNoticeProps) {
  const data = node.data
  return (
    <div className={css.row} role="status" data-testid="model-switch">
      <span className={css.title}>{t('switch.title')}</span>
      <span className={css.movement}>
        <code className={css.serving}>{servingLabel(data.from)}</code>
        <span className={css.arrow} aria-hidden="true">→</span>
        <code className={css.serving}>{servingLabel(data.to)}</code>
      </span>
      <span className={css.reason}>{t(`boundary.${data.boundary}`)}</span>
    </div>
  )
}
