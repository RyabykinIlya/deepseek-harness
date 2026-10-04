/**
 * Token spend of a Project and its Threads, in the Project's header.
 *
 * The entry sits in the same session-header band as the Thread roster, in that
 * band's visual language (12px label, tertiary colour, no border), and renders
 * only for a Project: the ledger is a Project fact, and an ordinary Session has
 * no Thread set to aggregate. The number is the sum of the `tokenUsage`
 * projection over the Project Session and every Thread the roster names; see
 * `token-usage.ts` for the membership and empty-state semantics, which this
 * component only presents.
 */
import { useMemo } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { IconDatabaseOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { isProjectSession } from './project.ts'
import { useThreadRoster } from './useThreadRoster.ts'
import { useProjectTokenUsage } from './useProjectTokenUsage.ts'
import { formatTokenCount, hasTokenSpend } from './token-usage.ts'
import type { NS } from './locales.ts'
import css from './ProjectTokenUsage.module.css'

/** The one deployment-configured fact the entry needs to recognize a Project. */
export interface ProjectTokensInjected {
  /**
   * Agent preset ids this deployment treats as Project identities. Empty is the
   * shipped default and keeps every session outside a Project.
   */
  projectAgentPresets: readonly string[]
}

/** Full props for the Project token-spend header entry. */
export type ProjectTokenUsageProps =
  PropsRuntime<'conversation.session.header.actions'> & ProjectTokensInjected & PropsLocale<typeof NS>

/**
 * Session-header entry point for the current Project Session's aggregated token
 * spend. Outside a Project this renders nothing at all.
 * @param props - session standard props, the configured Project presets, and the translator.
 * @returns the compact Project ledger, or null.
 */
export function ProjectTokenUsage({ sessionId, useSessions, projectAgentPresets, t }: ProjectTokenUsageProps) {
  // Composition is the Session's identity, so it is read from the same list row
  // the roster reads: a Project is known before any usage is published.
  const agentPreset = useSessions(state => state.byId[sessionId]?.projectionValues?.agentPreset)
  const project = isProjectSession(agentPreset, projectAgentPresets)
  // The Project's Threads are the roster's rows, never a second membership
  // rule: the ledger counts exactly what the roster lists.
  const { roster } = useThreadRoster(useSessions, sessionId)
  const threadIds = useMemo(
    () => roster.entries.map((row): SessionId => String(row.threadId) as SessionId),
    [roster.entries],
  )
  const usage = useProjectTokenUsage(useSessions, sessionId, threadIds)
  if (!project) return null
  // Nothing reported yet is an absence of readings, not a measured zero, so it
  // is stated as such rather than rendered as `0`.
  const recorded = hasTokenSpend(usage)
  const headline = recorded
    ? t('tokens.total', { count: formatTokenCount(usage.totalTokens, t) })
    : t('tokens.empty')
  const detail = recorded
    ? t('tokens.detail', {
      input: formatTokenCount(usage.inputTokens, t),
      output: formatTokenCount(usage.outputTokens, t),
      cacheRead: formatTokenCount(usage.cacheReadTokens, t),
      cacheWrite: formatTokenCount(usage.cacheWriteTokens, t),
    })
    : undefined
  return (
    <div
      className={css.usage}
      data-project-tokens=""
      role="group"
      aria-label={t('tokens.aria', { count: headline })}
      title={detail}
    >
      <IconDatabaseOutlineRegular className={css.icon} />
      <span className={css.value}>{headline}</span>
    </div>
  )
}
