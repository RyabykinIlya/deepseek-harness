/** Typed test doubles shared by the ui-threads specs, so no spec asserts through `unknown`. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ThreadActionResult } from '../src/client/actions.ts'
import type { ThreadActionsInjected } from '../src/client/ThreadActions.tsx'
import type { ThreadsRosterInjected } from '../src/client/ThreadsHeaderAction.tsx'
import type { NewProjectInjected } from '../src/client/project/NewProjectFooterAction.tsx'

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
