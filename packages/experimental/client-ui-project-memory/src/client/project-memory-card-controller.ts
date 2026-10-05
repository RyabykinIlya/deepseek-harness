/**
 * The Project memory page's staged form over the `project-memory` settings namespace.
 *
 * Every field name here is a key of the Host row's own `z.object({ ... })`, the
 * Host schema being the only authority on what its namespace carries: a name the
 * schema lacks is not merely hidden, the Host rejects a write to it, so a card
 * built over a convenient subset would fail its own save while still passing
 * every test that only exercised the fields it happened to pick. The row's
 * remaining keys — the coordinator preset ids and the lineage depth — are boot
 * composition this page deliberately does not edit.
 *
 * The caps themselves are bounded by the Host row (`maxEntries` 1 through 10000,
 * `maxEntryChars` 1 through 100000). This card rejects a draft that is not a
 * whole number, because a decimal cap is meaningless everywhere it is enforced;
 * the range stays the Host's to answer, and a value outside it surfaces as a
 * refused save rather than as a pre-emptively hidden control.
 */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  SettingsFormModel, settingsNumberField,
  type SettingsFieldSpec, type SettingsFieldState, type SettingsFormActions, type SettingsFormScope, type SettingsFormShell,
} from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * Loader entry id of the Project memory row, and so the namespace this page
 * edits. Spelled here rather than imported: a client package must not depend on
 * a Host package, so the schema this name mirrors cannot be read here.
 */
export const PROJECT_MEMORY_NS = 'project-memory'

/**
 * The two caps this page edits, mirroring the volatile fields of the Host row.
 *
 * The Host row's Project-identity fields are absent here for the same reason the
 * Threads page omits preset ids: a first edit would pin boot composition into
 * the profile row.
 */
export interface ProjectMemorySettings {
  /** Entries kept per Project before an add is refused. */
  maxEntries?: number
  /** Longest entry text in Unicode code points. */
  maxEntryChars?: number
}

/** What the Project memory page renders. */
export interface ProjectMemoryCardState extends SettingsFormShell {
  /** Entries kept per Project. */
  maxEntries: SettingsFieldState
  /** Longest entry text in Unicode code points. */
  maxEntryChars: SettingsFieldState
}

/** The registration-side face the Project memory page's slot entry injects. */
export interface ProjectMemoryCardFace extends SettingsFormActions {
  hooks: {
    /** Page snapshot bound by the renderer as useProjectMemoryCard. */
    projectMemoryCard: SnapshotStore<ProjectMemoryCardState>
  }
}

/**
 * A cap: the Host's whole number, so an entry count or a character length is
 * never a fraction.
 * @param field - the field name inside the namespace section.
 * @returns the field's conversion spec.
 */
function capField(field: string): SettingsFieldSpec {
  const numeric = settingsNumberField(field)
  return {
    ...numeric,
    parse: (text) => {
      const write = numeric.parse(text)
      if (write?.kind !== 'set') return write
      return Number.isSafeInteger(write.value) ? write : undefined
    },
  }
}

/** The specs this card edits, keyed by the Host field name each one stages. */
const SPECS: readonly SettingsFieldSpec[] = [
  capField('maxEntries'),
  capField('maxEntryChars'),
]

/** Bridges the `project-memory` scope onto the page's staged form. */
export class ProjectMemoryCardController {
  private readonly form: SettingsFormModel<ProjectMemorySettings>
  private readonly store: SnapshotStore<ProjectMemoryCardState>

  /** @param scope - the bound settings scope for the `project-memory` namespace. */
  constructor(scope: SettingsFormScope<ProjectMemorySettings>) {
    this.form = new SettingsFormModel(scope, [...SPECS])
    this.store = this.form.bind(() => this.projection())
  }

  private projection(): ProjectMemoryCardState {
    return {
      ...this.form.shell(),
      maxEntries: this.form.field('maxEntries'),
      maxEntryChars: this.form.field('maxEntryChars'),
    }
  }

  /**
   * Build the face the page's slot registration injects.
   * @returns the page's snapshot and its form actions.
   */
  inject(): ProjectMemoryCardFace {
    return { hooks: { projectMemoryCard: this.store }, ...this.form.actions() }
  }

  /** Release accepted-value subscriptions. */
  dispose(): void { this.form.dispose() }
}
