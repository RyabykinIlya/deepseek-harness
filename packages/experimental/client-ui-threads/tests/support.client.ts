/** Typed test doubles shared by the ui-threads specs, so no spec asserts through `unknown`. */
import { useSyncExternalStore } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ThreadActionResult } from '../src/client/actions.ts'
import type { ThreadActionsInjected } from '../src/client/ThreadActions.tsx'
import type { ThreadsRosterInjected } from '../src/client/ThreadsHeaderAction.tsx'
import type { ProjectTokensInjected } from '../src/client/ProjectTokenUsage.tsx'
import type { NewProjectInjected } from '../src/client/project/NewProjectFooterAction.tsx'
import type { ThreadActionOverlaysProps, ThreadsOverlayInjected } from '../src/client/ThreadActionOverlays.tsx'
import type { SidebarThreadActionInjected } from '../src/client/SidebarThreadAction.tsx'
import type { ThreadsFeedbackHandle, ThreadsFeedbackState } from '../src/client/feedback.ts'

/** A successful Thread action outcome. */
export function okResult(): Promise<ThreadActionResult> {
  return Promise.resolve({ ok: true })
}

/**
 * A partial double typed as the full face. Specs supply the members the code
 * under test reads; `Partial<T>` and `T` overlap, so the assertion needs no `unknown`.
 * @param part - the members the double provides.
 * @returns the double, typed as `T`.
 */
export function fake<T extends object>(part: Partial<T>): T {
  return part as T
}

/** A registered entry's `inject` thunk, as a spec calls it. */
type StoredInject = ((...args: never[]) => Record<string, unknown>) | undefined

/**
 * Call a registered Project-ledger entry's argument-less `inject`.
 * @param inject - the entry's `inject` function.
 * @returns the injected Project identity face.
 */
export function tokensInjected(inject: StoredInject): ProjectTokensInjected {
  const call = inject as (() => ProjectTokensInjected) | undefined
  if (call === undefined) throw new Error('entry has no inject')
  return call()
}

/**
 * Call a registered roster entry's per-Session `inject`.
 * @param inject - the entry's `inject` function.
 * @param sessionId - the Session the inject is evaluated for.
 * @returns the injected roster face.
 */
export function rosterInjectedFor(inject: StoredInject, sessionId: SessionId): ThreadsRosterInjected {
  const call = inject as ((id: SessionId) => ThreadsRosterInjected) | undefined
  if (call === undefined) throw new Error('entry has no inject')
  return call(sessionId)
}

/**
 * Call a registered entry's argument-less `inject` for the Thread actions.
 * @param inject - the entry's `inject` function.
 * @returns the injected Thread actions.
 */
export function threadActionsInjected(inject: StoredInject): ThreadActionsInjected {
  const call = inject as (() => ThreadActionsInjected) | undefined
  if (call === undefined) throw new Error('entry has no inject')
  return call()
}

/**
 * Call the New Project entry's argument-less `inject`.
 * @param inject - the entry's `inject` function.
 * @returns the injected New Project actions.
 */
export function newProjectInjected(inject: StoredInject): NewProjectInjected {
  const call = inject as (() => NewProjectInjected) | undefined
  if (call === undefined) throw new Error('entry has no inject')
  return call()
}

/**
 * Call the sidebar Thread row entry's argument-less `inject`.
 * @param inject - the entry's `inject` function.
 * @returns the injected sidebar Thread actions.
 */
export function sidebarThreadActionsInjected(inject: StoredInject): SidebarThreadActionInjected {
  const call = inject as (() => SidebarThreadActionInjected) | undefined
  if (call === undefined) throw new Error('entry has no inject')
  return call()
}

/**
 * Call the `'shell.overlay'` feedback entry's argument-less `inject`.
 * @param inject - the entry's `inject` function.
 * @returns the injected overlay face, including the raw feedback source in `hooks`.
 */
export function overlayInjected(inject: StoredInject): ThreadsOverlayInjected {
  const call = inject as (() => ThreadsOverlayInjected) | undefined
  if (call === undefined) throw new Error('entry has no inject')
  return call()
}

/**
 * Build the overlay host's props over a real feedback store, so a spec renders
 * the same notice pipeline the app composes through `'shell.overlay'`.
 * @param handle - the feedback store the row component under test writes through.
 * @param over - the Remote calls and translator the confirmation's forced retry needs.
 * @returns props for `ThreadActionOverlays`.
 */
export function overlayPropsFor(
  handle: ThreadsFeedbackHandle,
  over: Pick<ThreadActionOverlaysProps, 'archiveThread' | 'refreshProjection' | 't'>,
): ThreadActionOverlaysProps {
  return fake<ThreadActionOverlaysProps>({
    useFeedback: <S>(select: (state: ThreadsFeedbackState) => S): S =>
      useSyncExternalStore(
        listener => handle.source.subscribe(listener),
        () => select(handle.source.getSnapshot()),
      ),
    writes: handle.writes,
    dismissToast: handle.dismissToast,
    settleDirtyArchive: handle.settleDirtyArchive,
    ...over,
  })
}
