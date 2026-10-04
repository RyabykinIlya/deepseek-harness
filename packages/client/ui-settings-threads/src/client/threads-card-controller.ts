/**
 * The Threads page's staged form over the `threads-preset` settings namespace.
 *
 * Every field name here is a key of the Host row's own `z.object({ ... })`, the
 * Host schema being the only authority on what its namespace carries. A name
 * the schema lacks is not merely hidden: the Host rejects a write to it, so a
 * card built over a convenient subset of the row would fail its own save while
 * still passing every test that only exercised the fields it happened to pick.
 * The row's remaining keys — the preset ids, display names, the base preset, the
 * provider name, and the `tools` budget dict — are boot composition this page
 * deliberately does not edit.
 *
 * The four thread model options are read and written as one: the Host throws
 * unless `threadProvider`, `threadModel`, `threadReasoningEffort` and
 * `threadMaxTokens` are all set or all unset, so a save that left three of four
 * staged would write a row that cannot load. That rule spans four fields and no
 * single `SettingsFieldSpec` can express it, so the card checks it itself — over
 * the staged drafts and the values the Host already holds — and refuses the save
 * rather than handing the Host a row it must reject.
 */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  SettingsFormModel, settingsNumberField, settingsTextField,
  type SettingsFieldSpec, type SettingsFieldState, type SettingsFormActions, type SettingsFormScope, type SettingsFormShell,
} from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * Loader entry id of the Threads presets row, and so the namespace this page
 * edits. Spelled here rather than imported: a client package must not depend on
 * a Host package, so the schema this name mirrors cannot be read here.
 */
export const THREADS_PRESET_NS = 'threads-preset'

/** Cadences the coordinator contract accepts, in the Host union's order. */
export const CHECK_IN_POLICIES = ['milestones', 'each-thread', 'quiet'] as const

/** One coordinator progress-reporting cadence. */
export type CheckInPolicy = typeof CHECK_IN_POLICIES[number]

/** Answers the coordinator contract accepts for either approval question. */
export const APPROVAL_POLICIES = ['ask', 'auto'] as const

/** Whether the coordinator waits for the user before acting. */
export type ApprovalPolicy = typeof APPROVAL_POLICIES[number]

/**
 * The four Thread model options, in the Host's own declaration order.
 *
 * Listed rather than written out per field so the completeness check and the
 * card's four controls cannot disagree about which fields the group has.
 */
export const THREAD_MODEL_FIELDS = [
  'threadProvider', 'threadModel', 'threadReasoningEffort', 'threadMaxTokens',
] as const

/** One field of the Thread model group. */
export type ThreadModelField = typeof THREAD_MODEL_FIELDS[number]

/**
 * The section fields this page edits, mirroring the Host row's schema.
 *
 * The four Thread model options are optional here because the Host row leaves
 * them optional: an absent one is what "every Thread inherits the deployment
 * default" looks like on the wire.
 */
export interface ThreadsSettings {
  /** Coordinator contract: how often the Project narrates Thread progress. */
  checkIn?: CheckInPolicy
  /** Coordinator contract: approval before starting a Thread. */
  spawn?: ApprovalPolicy
  /** Coordinator contract: approval before merging a Thread branch. */
  mergePolicy?: ApprovalPolicy
  /** LLM provider every Thread runs on. */
  threadProvider?: string
  /** Model every Thread runs on. */
  threadModel?: string
  /** Reasoning effort every Thread runs at. */
  threadReasoningEffort?: string
  /** Output token ceiling for every Thread. */
  threadMaxTokens?: number
}

/** Effective values and drafts presented by the Threads card. */
export interface ThreadsCardState extends SettingsFormShell {
  /** Coordinator progress-reporting cadence. */
  checkIn: SettingsFieldState
  /** Approval before starting a Thread. */
  spawn: SettingsFieldState
  /** Approval before merging a Thread branch. */
  mergePolicy: SettingsFieldState
  /** LLM provider every Thread runs on. */
  threadProvider: SettingsFieldState
  /** Model every Thread runs on. */
  threadModel: SettingsFieldState
  /** Reasoning effort every Thread runs at. */
  threadReasoningEffort: SettingsFieldState
  /** Output token ceiling for every Thread. */
  threadMaxTokens: SettingsFieldState
  /**
   * Whether some but not all four Thread model options carry a value.
   *
   * The Host refuses a row that sets only some of them, so this blocks the save
   * the way an unparsable draft does rather than after a refused round trip.
   */
  partialThreadModel: boolean
}

/** Actions and observable state bound by the slot renderer. */
export interface ThreadsCardFace extends SettingsFormActions {
  hooks: {
    /** Page snapshot bound by the renderer as useThreadsCard. */
    threadsCard: SnapshotStore<ThreadsCardState>
  }
}

/**
 * A field whose value is one of a fixed set.
 *
 * The settings primitives ship a text control and no select, so an enum is a
 * text field whose parser accepts only the literals the Host union declares,
 * plus the empty draft every settings field treats as a clear — the Host row
 * defaults all three knobs, so unsetting one means "inherit" rather than "unset
 * to nothing". Any other draft parses to nothing, which the form already reports
 * as an invalid draft and refuses to save: the same treatment a non-numeric draft
 * of a number field gets, and for the same reason — the Host is the authority on
 * which values exist, not this card.
 * @param field - the field name inside the namespace section.
 * @param allowed - every value the Host union accepts, in its declared order.
 * @returns the field's conversion spec.
 */
function enumField(field: string, allowed: readonly string[]): SettingsFieldSpec {
  return {
    field,
    format: value => typeof value === 'string' && allowed.includes(value) ? value : '',
    parse: (text) => {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'clear' }
      return allowed.includes(trimmed) ? { kind: 'set', value: trimmed } : undefined
    },
  }
}

/**
 * The Thread token ceiling: the Host's whole number of at least one.
 * @param field - the field name inside the namespace section.
 * @returns the field's conversion spec.
 */
function tokenCeilingField(field: string): SettingsFieldSpec {
  const numeric = settingsNumberField(field)
  return {
    ...numeric,
    parse: (text) => {
      const write = numeric.parse(text)
      if (write?.kind !== 'set') return write
      const value = write.value as number
      return Number.isSafeInteger(value) && value >= 1 ? write : undefined
    },
  }
}

/**
 * The specs this card edits, keyed by the Host field name each one stages.
 *
 * The card reads a spec back when it decides whether the Thread model group is
 * complete, so the completeness rule and the controls parse the same draft the
 * same way.
 */
const SPECS: ReadonlyMap<string, SettingsFieldSpec> = new Map<string, SettingsFieldSpec>([
  ['checkIn', enumField('checkIn', CHECK_IN_POLICIES)],
  ['spawn', enumField('spawn', APPROVAL_POLICIES)],
  ['mergePolicy', enumField('mergePolicy', APPROVAL_POLICIES)],
  ['threadProvider', settingsTextField('threadProvider')],
  ['threadModel', settingsTextField('threadModel')],
  ['threadReasoningEffort', settingsTextField('threadReasoningEffort')],
  ['threadMaxTokens', tokenCeilingField('threadMaxTokens')],
])

/** What one field of the Thread model group would write. */
type StagedIntent = 'set' | 'clear'

/** Bind the Threads knobs and the Thread model group to one staged settings form. */
export class ThreadsCardController {
  private readonly form: SettingsFormModel<ThreadsSettings>
  private readonly store: SnapshotStore<ThreadsCardState>
  /**
   * What each staged field intends, for the four Thread model fields only.
   *
   * `SettingsFieldSpec` cannot express "this field is absent": a staged clear
   * leaves the control showing the composition layer's value while the save
   * writes an unset for it, so a field's draft text alone cannot tell a staged
   * clear from a value the Host already holds. The completeness rule needs that
   * distinction, because clearing one of four is what makes a stored group
   * unwritable, and only the card can see it.
   */
  private readonly staged = new Map<ThreadModelField, StagedIntent>()

  /** @param scope - the bound settings scope for the `threads-preset` namespace. */
  constructor(scope: SettingsFormScope<ThreadsSettings>) {
    this.form = new SettingsFormModel(scope, [...SPECS.values()])
    this.store = this.form.bind(() => this.projection())
  }

  /**
   * Whether some but not all four Thread model options carry a value.
   *
   * It reads the same effective draft text a control renders, so a value the
   * Host already holds counts exactly as a value the user just typed.
   * @returns true when the group would be written partially.
   */
  private partialThreadModel(): boolean {
    const present = THREAD_MODEL_FIELDS.filter(field => this.stages(field))
    return present.length > 0 && present.length < THREAD_MODEL_FIELDS.length
  }

  /**
   * Whether one Thread model field's effective draft is a value the field holds.
   * @param field - the Host field name to read.
   * @returns true when a save would leave an entry for this field.
   */
  private stages(field: ThreadModelField): boolean {
    const intent = this.staged.get(field)
    if (intent !== undefined) return intent === 'set'
    const text = this.form.field(field).text.trim()
    return text !== '' && SPECS.get(field)?.parse(text)?.kind === 'set'
  }

  private projection(): ThreadsCardState {
    const shell = this.form.shell()
    // The shared model owns which drafts are staged; an empty set means a save
    // landed or a discard dropped them, and the mirror has to follow or it would
    // keep reporting a clear the model no longer holds.
    if (!shell.dirty) this.staged.clear()
    const partialThreadModel = this.partialThreadModel()
    return {
      ...shell,
      invalid: shell.invalid || partialThreadModel,
      partialThreadModel,
      checkIn: this.form.field('checkIn'),
      spawn: this.form.field('spawn'),
      mergePolicy: this.form.field('mergePolicy'),
      threadProvider: this.form.field('threadProvider'),
      threadModel: this.form.field('threadModel'),
      threadReasoningEffort: this.form.field('threadReasoningEffort'),
      threadMaxTokens: this.form.field('threadMaxTokens'),
    }
  }

  /**
   * Build the face the page's slot registration injects.
   *
   * The save is the form's own, guarded: the shared model refuses a draft no
   * single field can parse, and only this card can see that the Thread model
   * group as a whole is half written. The card's own `invalid` flag disables the
   * control for the same reason; the guard is what holds when save is reached
   * some other way.
   * @returns the page's snapshot and its staged write actions.
   */
  inject(): ThreadsCardFace {
    const actions = this.form.actions()
    return {
      hooks: { threadsCard: this.store },
      edit: (field, text) => {
        this.stagedIntent(field, text.trim() === '' ? 'clear' : 'set')
        actions.edit(field, text)
      },
      resetField: (field) => {
        this.stagedIntent(field, 'clear')
        actions.resetField(field)
      },
      save: () => { if (!this.partialThreadModel()) actions.save() },
      discard: () => { this.staged.clear(); actions.discard() },
    }
  }

  /**
   * Record what a staged Thread model field would write, ignoring any other field.
   * @param field - the field the caller staged.
   * @param intent - whether the draft writes a value or clears the field.
   */
  private stagedIntent(field: string, intent: StagedIntent): void {
    if ((THREAD_MODEL_FIELDS as readonly string[]).includes(field)) {
      this.staged.set(field as ThreadModelField, intent)
    }
  }

  /** Release accepted-value subscriptions. */
  dispose(): void { this.form.dispose() }
}
