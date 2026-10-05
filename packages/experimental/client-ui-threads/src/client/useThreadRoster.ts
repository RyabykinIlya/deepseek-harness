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
import { isProjectSession } from './project.ts'
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
 * The catalog is the identity source that exists in every deployment, but it
 * also names every ordinary (non-Thread) continuable subagent an ordinary
 * session delegated to — the shipped `standard` preset makes that the common
 * case, not an edge one. Outside a Project, a catalog row is not a Thread row:
 * including it would show a "Thread" dropdown, with an Archive button that
 * always fails, on a session that never ran a Project at all. So catalog rows
 * are merged in only once the owning Session is confirmed a Project; the `threads`
 * projection itself needs no such gate, because the Host only ever populates it
 * for a real Project, and its richer per-Thread fields still win over the
 * catalog's once a `thread/*` event was recorded.
 * @param useSessions - the Session-list selector hook.
 * @param parentSessionId - the Session a Thread row would be owned by.
 * @param projectAgentPresets - preset ids configured as Project identities.
 * @returns the raw snapshot and the merged rows.
 */
export function useThreadRoster(
  useSessions: UseSessions,
  parentSessionId: SessionId,
  projectAgentPresets: readonly string[],
): ThreadRosterRead {
  const snapshot = useSessions(state => state.projectionsBySession[parentSessionId])
  const sessionsById = useSessions(state => state.byId)
  const parentRow = sessionsById[parentSessionId]
  const project = isProjectSession(parentRow?.projectionValues?.agentPreset, projectAgentPresets)
  const catalog = project ? parentRow?.projectionValues?.subagentCatalog : undefined
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
