/**
 * Project identity: which Session is a Project, and which preset a new one is
 * composed from.
 *
 * "Project" is not a new Session type — the Host records no such flag. It is an
 * identity derived from the composition a Session runs, read from the
 * `agentPreset` Session projection the agent-preset registry publishes, and
 * compared against the preset ids the deployment configured. Keeping the whole
 * rule in these two pure functions is what lets the roster's visibility, its
 * add-a-Thread affordance, and the New Project entry point agree on one
 * answer without any of them re-deriving it.
 */

/**
 * Whether one Session is a Project.
 *
 * An absent or null preset is never a Project: `null` is the registry's own
 * "this deployment composes none" answer, and a Session whose composition has
 * not been read yet is unknown rather than a Project. An empty configured list
 * recognizes nothing, which is the shipped default.
 * @param agentPreset - the Session's `agentPreset` projection value.
 * @param projectAgentPresets - preset ids configured as Project identities.
 * @returns true when the configured list names this Session's preset.
 */
export function isProjectSession(
  agentPreset: string | null | undefined,
  projectAgentPresets: readonly string[],
): boolean {
  return typeof agentPreset === 'string' && projectAgentPresets.includes(agentPreset)
}

/**
 * The preset a New Project action composes.
 * @param projectAgentPresets - preset ids configured as Project identities.
 * @returns the first configured preset id, or undefined when none is configured.
 */
export function projectAgentPreset(projectAgentPresets: readonly string[]): string | undefined {
  return projectAgentPresets[0]
}

/**
 * The Workspace a sidebar-level New Project action creates in: the one holding
 * the most recently updated Session, as the shipped New Session fallback does
 * when no Session is selected. A Workspace with no Session counts from its
 * creation time.
 * @param workspaces - Workspace rows in Host order, each naming its Session ids.
 * @param updatedAtOf - reads a Session's last update time, or undefined when it is not listed.
 * @returns the chosen Workspace id (the first on a tie), or undefined when there are none.
 */
export function recentWorkspaceId<Id extends string, S extends string>(
  workspaces: readonly { readonly workspaceId: Id; readonly sessionIds: readonly S[]; readonly createdAt: string }[],
  updatedAtOf: (sessionId: S) => number | undefined,
): Id | undefined {
  let selected: Id | undefined
  let selectedTime = Number.NEGATIVE_INFINITY
  for (const workspace of workspaces) {
    let latest = Number.NEGATIVE_INFINITY
    for (const sessionId of workspace.sessionIds) latest = Math.max(latest, updatedAtOf(sessionId) ?? latest)
    if (latest === Number.NEGATIVE_INFINITY) latest = Date.parse(workspace.createdAt)
    if (selected === undefined || latest > selectedTime) {
      selected = workspace.workspaceId
      selectedTime = latest
    }
  }
  return selected
}
