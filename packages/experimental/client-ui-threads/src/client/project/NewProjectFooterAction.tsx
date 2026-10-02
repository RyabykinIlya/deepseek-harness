/**
 * The New Project entry point: one `sidebar.footer.action` button that opens a
 * fresh Session composed from the Project preset.
 *
 * The footer seat was chosen over the other existing seats on purpose:
 * `conversation.hero.agentPreset` is a single-occupant seat the agent-preset
 * picker already holds, `sidebar.panellist` entries address a main panel rather
 * than run an action, and a Session "..." menu row implies acting on that
 * Session. The footer sits beside Settings in every sidebar width, outside the
 * Session list, so the action reads as app-level and creates a new row instead
 * of changing one.
 *
 * With no Session selected in this seat's props, it creates the Project in the
 * Workspace holding the most recently updated Session, which is the shipped New
 * Session fallback.
 */
import { useRef, useState } from 'react'
import {
  IconProjectAddOutlineRegular, IconWarningOutlineRegular, Toast, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
// Pulls in the `sidebar.footer.action` SlotMap augmentation this entry
// registers into; the import is types-only and erased at build.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { NS, ThreadKey } from '../locales.ts'
import { recentWorkspaceId } from '../project.ts'
import css from './NewProjectFooterAction.module.css'

/** Why a New Project request did not produce an open Project. */
export type NewProjectFailure =
  | { readonly reason: 'unconfigured' }
  | { readonly reason: 'create-failed'; readonly message: string }
  | { readonly reason: 'preset-not-found'; readonly preset: string }
  | { readonly reason: 'preset-locked'; readonly preset: string }
  | { readonly reason: 'preset-failed'; readonly message: string }

/** Outcome of one New Project request. */
export type NewProjectResult = { readonly ok: true } | ({ readonly ok: false } & NewProjectFailure)

/** Business actions supplied by the slot registration. */
export interface NewProjectInjected {
  /**
   * Create a blank Session in one Workspace, select the Project preset before
   * its first turn, and open it. A failure is returned, never thrown, so the
   * button can report it.
   * @param workspaceId - Workspace the Project is created in.
   * @returns success, or why no Project was opened.
   */
  startProject: (workspaceId: WorkspaceId) => Promise<NewProjectResult>
}

/** Full props of the New Project footer action. */
export type NewProjectFooterActionProps =
  PropsRuntime<'sidebar.footer.action'>
  & PropsLocale<typeof NS>
  & InjectFace<NewProjectInjected>

/** Copy key and arguments for one failure, covering the closed reason union. */
function failureCopy(failure: NewProjectFailure): readonly [ThreadKey, Record<string, string>?] {
  switch (failure.reason) {
    case 'unconfigured': return ['project.failed.unconfigured']
    case 'create-failed': return ['project.failed.create', { message: failure.message }]
    case 'preset-not-found': return ['project.failed.presetNotFound', { preset: failure.preset }]
    case 'preset-locked': return ['project.failed.presetLocked', { preset: failure.preset }]
    case 'preset-failed': return ['project.failed.preset', { message: failure.message }]
    /* v8 ignore next 2 -- closed-union backstop; only reached if a failure reason is forged */
    default: return failure satisfies never
  }
}

/**
 * Footer button: start a Project.
 *
 * The button disables itself while the Session is created and configured, so a
 * second click cannot race the first into opening two Projects. Failures are
 * transient operation outcomes and surface as a warning toast held by this
 * button, which stays mounted for the life of the sidebar.
 * @param props - owner share, the Project action, the Workspace and Session hooks, and the translator.
 * @returns The button and its toast.
 */
export function NewProjectFooterAction({
  wide, startProject, useWorkspaces, useSessions, t,
}: NewProjectFooterActionProps) {
  const workspaces = useWorkspaces(state => state.items)
  const sessionsById = useSessions(state => state.byId)
  const [busy, setBusy] = useState(false)
  const seq = useRef(0)
  const [toast, setToast] = useState<{ seq: number; text: string } | null>(null)
  const warn = (text: string): void => {
    seq.current += 1
    setToast({ seq: seq.current, text })
  }
  const start = (): void => {
    const workspaceId = recentWorkspaceId(workspaces, id => sessionsById[id]?.updatedAt)
    if (workspaceId === undefined) {
      warn(t('project.failed.noWorkspace'))
      return
    }
    setBusy(true)
    void startProject(workspaceId).then((result) => {
      if (result.ok) return
      const [key, args] = failureCopy(result)
      warn(t(key, args))
    }).finally(() => { setBusy(false) })
  }
  return (
    <>
      <Tooltip label={t('project.new')} side="right" portal disabled={wide}>
        <button
          type="button"
          className={wide ? css.button : `${css.button} ${css.rail}`}
          aria-label={t('project.new')}
          disabled={busy}
          onClick={start}
        >
          <IconProjectAddOutlineRegular size={wide ? 16 : 18} />
          {wide && <span className={css.label}>{t('project.new')}</span>}
        </button>
      </Tooltip>
      {toast !== null && (
        <Toast
          key={toast.seq}
          text={toast.text}
          icon={<IconWarningOutlineRegular />}
          holdMs={6000}
          onDone={() => { setToast(null) }}
        />
      )}
    </>
  )
}
