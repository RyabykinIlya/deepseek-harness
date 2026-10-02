/**
 * Reads one Project Session's Thread rows: the `threads` projection merged over
 * the delegation catalog, with liveness taken from the Session store. Shared by
 * the header roster and the Thread chat header so both show the same rows.
 */
import { useCallback, useMemo } from 'react'
import type { SessionProjectionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ThreadStatusRow } from '@deepseek-ai/dsh-experimental-threads/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { catalogRows, mergeRosterRows, withLiveness, type ThreadRosterRow } from './roster.ts'

/** The Session-list selector hook every Session-scoped Slot receives. */
export type UseSessions = PropsRuntime<'conversation.session.header.actions'>['useSessions']

/** A projection read plus enough load state to tell "no threads" from "not read yet". */
export type ThreadsSnapshot = Omit<SessionProjectionSnapshot, 'values' | 'state'> & {
  state: 'loading' | 'ready' | 'error'
  entries: ThreadRosterRow[]
}

/** Result of {@link useThreadRoster}. */
export interface ThreadRosterRead {
  /** The raw projection read, absent until the Host has published one. */
  snapshot: SessionProjectionSnapshot | undefined
  /** The merged rows with their load state. */
  roster: ThreadsSnapshot
}

/**
 * Read the Thread rows owned by one Project Session.
 *
 * The catalog is the identity source that exists in every deployment; Thread
 * rows are merged over it so the richer per-Thread fields win once a
 * `thread/*` event was recorded. A Thread is running exactly when its own
 * Session is.
 * @param useSessions - the Session-list selector hook.
 * @param parentSessionId - the Project Session.
 * @returns the raw snapshot and the merged rows.
 */
export function useThreadRoster(useSessions: UseSessions, parentSessionId: SessionId): ThreadRosterRead {
  const snapshot = useSessions(state => state.projectionsBySession[parentSessionId])
  const sessionsById = useSessions(state => state.byId)
  const catalog = sessionsById[parentSessionId]?.projectionValues?.subagentCatalog
  const childRunning = useCallback((threadId: ThreadStatusRow['threadId']) =>
    sessionsById[String(threadId) as SessionId]?.running === true, [sessionsById])
  const roster = useMemo<ThreadsSnapshot>(() => {
    const merged = (threads: readonly ThreadStatusRow[]): ThreadRosterRow[] =>
      withLiveness(mergeRosterRows(catalogRows(catalog), threads), childRunning)
    if (snapshot === undefined) {
      return { state: 'loading', entries: merged([]), error: null }
    }
    const state = snapshot.state === 'idle'
      ? snapshot.values.threads === undefined ? 'loading' : 'ready'
      : snapshot.state
    return {
      state,
      error: snapshot.error,
      entries: merged(snapshot.values.threads ?? []),
    }
  }, [snapshot, catalog, childRunning])
  return { snapshot, roster }
}
