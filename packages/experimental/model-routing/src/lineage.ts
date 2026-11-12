/**
 * Live-ancestor traversal for the fallback switch: a Session that never chose
 * reads the choice of the nearest ancestor the Host still holds.
 *
 * @module dsh-experimental-model-routing/lineage
 */

import type { Session, SessionId } from '@deepseek-ai/dsh-session'

/**
 * The live ancestor chain of one Session, nearest first.
 *
 * The walk stops at the first ancestor the live registry no longer holds — a
 * resumed child may outlive its parent, and an absent ancestor reads as the
 * end of the lineage rather than as a gap to skip — and refuses to revisit a
 * Session, so a damaged header cycle reads as a short chain instead of an
 * infinite one.
 * @param session - the Session whose ancestors to collect.
 * @param resolve - the live Session registry.
 * @returns every live ancestor, nearest first; empty for a top-level Session.
 */
export function liveAncestors(
  session: Session | undefined,
  resolve: (id: SessionId) => Session | undefined,
): Session[] {
  if (session === undefined) return []
  const ancestors: Session[] = []
  const seen = new Set<SessionId>([session.id])
  let parentId = session.header.parentSession
  while (parentId !== undefined && !seen.has(parentId)) {
    const parent = resolve(parentId)
    if (parent === undefined) break
    seen.add(parentId)
    ancestors.push(parent)
    parentId = parent.header.parentSession
  }
  return ancestors
}
