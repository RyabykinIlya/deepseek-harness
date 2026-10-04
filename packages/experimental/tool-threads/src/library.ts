/** The `library_list` tool: a byte-bounded listing of the caller's Project Library. @module */

import type {
  LibraryAttachment, LibraryChangedFile, LibraryList, LibraryPresentedFile, LibraryThreadChanges, ThreadsLibrary,
} from '@deepseek-ai/dsh-experimental-threads'
import { byteLength, count, oneLine, truncateUtf8 } from './text.ts'

/** The sections `library_list` can filter to. */
export const LIBRARY_SECTIONS = ['attachments', 'presented', 'changes'] as const

/** One member of {@link LIBRARY_SECTIONS}. */
export type LibrarySection = typeof LIBRARY_SECTIONS[number]

/** Byte cap on a rendered attachment name. */
const NAME_BYTES = 160

/** Byte cap on a rendered presented-file path. */
const PATH_BYTES = 200

/** Byte cap on a rendered presented-file description. */
const DESCRIPTION_BYTES = 200

/** Byte cap on a rendered Thread label. */
const LABEL_BYTES = 120

/** Changed file names shown inline per Thread before "(+N more)". */
const FILES_SHOWN = 5

/** One attachment as `library_list` reports it. */
export interface LibraryAttachmentEntry {
  /** `image` for a normalized raster image, `file` for a verbatim file. */
  readonly kind: 'image' | 'file'
  /** Opaque content-addressed attachment id. */
  readonly attachmentId: string
  /** Bounded display name, when one was recorded. */
  readonly name?: string
  /** Verified media type; recorded for images only. */
  readonly mediaType?: string
  /** Exact byte length. */
  readonly bytes: number
  /** Event time in Unix epoch milliseconds. */
  readonly time: number
}

/** One presented file as `library_list` reports it. */
export interface LibraryPresentedEntry {
  /** Bounded path as declared. */
  readonly path: string
  /** Bounded description supplied by the presenting model, when one was given. */
  readonly description?: string
  /** The Session that presented the file; the Project itself or a Thread session. */
  readonly sessionId: string
  /** Set when a Thread presented the file; absent for the Project. */
  readonly threadId?: string
  /** Event time in Unix epoch milliseconds. */
  readonly time: number
}

/** One changed file within a {@link LibraryChangesEntry}. */
export interface LibraryChangedFileEntry {
  /** Repository-relative path for a live worktree; the summary path of the turn for an archived Thread. */
  readonly path: string
  /** Added line count; absent for binary files. */
  readonly added?: number
  /** Removed line count; absent for binary files. */
  readonly removed?: number
  /** True when the file is binary. */
  readonly binary?: boolean
}

/** One Thread's changes as `library_list` reports it. */
export interface LibraryChangesEntry {
  /** The Thread. */
  readonly threadId: string
  /** Bounded task label recorded at creation. */
  readonly label: string
  /** `live` when read from the Thread's worktree; `archived` when read from its last recorded change summary. */
  readonly source: 'live' | 'archived'
  /** `dsh/<thread-short>` branch of a live worktree. */
  readonly branch?: string
  /** Absolute worktree root of a live Thread; changed `path` values are relative to it. */
  readonly worktree?: string
  /** Changed files, cut to the bounds. */
  readonly files: LibraryChangedFileEntry[]
  /** Complete changed-file count, including files not listed. */
  readonly filesTotal: number
  /** Commits since the worktree base; live Threads only. */
  readonly commitsTotal?: number
  /** Uncommitted entries in the worktree; live Threads only. */
  readonly uncommitted?: number
}

/** One bounded section of the `library_list` result. */
export interface LibrarySectionResult<T> {
  /** Entries kept after the row limit and the byte bound. */
  readonly items: T[]
  /** Complete number of entries in the section, including those not listed. */
  readonly total: number
  /** Whether the row limit or the byte bound dropped a matching entry. */
  readonly truncated: boolean
  /** Entries dropped. */
  readonly omitted: number
}

/**
 * The `library_list` result. Only the section(s) the caller asked for are
 * present; a section the caller did not ask for is omitted from the result
 * rather than reported as empty, since it was never read for this call.
 */
export interface LibraryListResult {
  /** Attachments sent in the Project chat, newest first. Present unless filtered out by `section`. */
  readonly attachments?: LibrarySectionResult<LibraryAttachmentEntry>
  /** Files presented by the Project and its Threads, newest first. Present unless filtered out by `section`. */
  readonly presented?: LibrarySectionResult<LibraryPresentedEntry>
  /** Changed files per Thread, newest Thread first. Present unless filtered out by `section`. */
  readonly changes?: LibrarySectionResult<LibraryChangesEntry>
}

/**
 * Project a Library attachment into the tool entry.
 * @param attachment - the Library attachment.
 * @returns the bounded entry.
 */
export function toAttachmentEntry(attachment: LibraryAttachment): LibraryAttachmentEntry {
  return {
    kind: attachment.kind,
    attachmentId: attachment.attachmentId,
    ...attachment.name === undefined ? {} : { name: oneLine(attachment.name, NAME_BYTES) },
    ...attachment.mediaType === undefined ? {} : { mediaType: attachment.mediaType },
    bytes: attachment.bytes,
    time: attachment.time,
  }
}

/**
 * Project a Library presented file into the tool entry.
 * @param file - the Library presented file.
 * @returns the bounded entry.
 */
export function toPresentedEntry(file: LibraryPresentedFile): LibraryPresentedEntry {
  return {
    path: oneLine(file.path, PATH_BYTES),
    ...file.description === undefined ? {} : { description: oneLine(file.description, DESCRIPTION_BYTES) },
    sessionId: file.sessionId,
    ...file.threadId === undefined ? {} : { threadId: file.threadId },
    time: file.time,
  }
}

/** Project one changed file. */
function toChangedFileEntry(file: LibraryChangedFile): LibraryChangedFileEntry {
  return {
    path: file.path,
    ...file.added === undefined ? {} : { added: file.added },
    ...file.removed === undefined ? {} : { removed: file.removed },
    ...file.binary === true ? { binary: true } : {},
  }
}

/**
 * Project a Library Thread's changes into the tool entry.
 * @param changes - the Library Thread changes.
 * @returns the bounded entry.
 */
export function toChangesEntry(changes: LibraryThreadChanges): LibraryChangesEntry {
  return {
    threadId: changes.threadId,
    label: oneLine(changes.label, LABEL_BYTES),
    source: changes.source,
    ...changes.branch === undefined ? {} : { branch: changes.branch },
    ...changes.worktree === undefined ? {} : { worktree: changes.worktree },
    files: changes.files.map(toChangedFileEntry),
    filesTotal: changes.filesTotal,
    ...changes.commitsTotal === undefined ? {} : { commitsTotal: changes.commitsTotal },
    ...changes.uncommitted === undefined ? {} : { uncommitted: changes.uncommitted },
  }
}

/** Keep the leading `limit` entries of one Library list, tracking the drop. */
function toSection<Source, Entry>(
  list: LibraryList<Source>,
  limit: number,
  project: (source: Source) => Entry,
): LibrarySectionResult<Entry> {
  const items = list.items.slice(0, limit).map(project)
  return { items, total: list.total, truncated: items.length < list.total, omitted: list.total - items.length }
}

/**
 * Project the full Library read model into the result for the requested section(s).
 * @param library - the Library read model read from `threads.library`.
 * @param section - the one section to include, or `undefined` for all three.
 * @param limit - entries kept per included section before the byte bound.
 * @returns the result carrying only the requested section(s).
 */
export function toLibraryListResult(library: ThreadsLibrary, section: LibrarySection | undefined, limit: number): LibraryListResult {
  const include = (name: LibrarySection): boolean => section === undefined || section === name
  return {
    ...include('attachments') ? { attachments: toSection(library.attachments, limit, toAttachmentEntry) } : {},
    ...include('presented') ? { presented: toSection(library.presented, limit, toPresentedEntry) } : {},
    ...include('changes') ? { changes: toSection(library.changes, limit, toChangesEntry) } : {},
  }
}

/** Format one attachment as a single line. */
function renderAttachmentLine(entry: LibraryAttachmentEntry): string {
  return [
    `${entry.attachmentId} [${entry.kind}]`,
    entry.name ?? '(unnamed)',
    `${entry.bytes} bytes`,
    new Date(entry.time).toISOString(),
  ].join(' | ')
}

/** Format one presented file as a single line. */
function renderPresentedLine(entry: LibraryPresentedEntry): string {
  return [
    entry.path,
    ...entry.description === undefined ? [] : [entry.description],
    entry.threadId === undefined ? 'presented by the Project' : `presented by thread ${entry.threadId}`,
    new Date(entry.time).toISOString(),
  ].join(' | ')
}

/** Format one Thread's changes as a single line, with its changed files inlined. */
function renderChangesLine(entry: LibraryChangesEntry): string {
  const names = entry.files.slice(0, FILES_SHOWN).map(file => file.path)
  const more = entry.filesTotal - names.length
  const counts = [
    ...entry.commitsTotal === undefined ? [] : [count(entry.commitsTotal, 'commit', 'commits')],
    ...entry.uncommitted === undefined ? [] : [`${entry.uncommitted} uncommitted`],
  ]
  return [
    `${entry.threadId} [${entry.source}] ${entry.label}`,
    ...entry.branch === undefined ? [] : [`branch ${entry.branch}`],
    ...counts.length === 0 ? [] : [counts.join(', ')],
    entry.filesTotal === 0
      ? 'no changed files'
      : `${count(entry.filesTotal, 'file', 'files')} changed: ${names.join(', ')}${more > 0 ? ` (+${more} more)` : ''}`,
  ].join(' | ')
}

/** Format one section with its header and omission footer. */
function renderSection<T>(
  key: LibrarySection,
  noun: string,
  section: LibrarySectionResult<T>,
  line: (entry: T) => string,
): string {
  return [
    `${key} (${section.total}):`,
    ...section.items.length === 0 && section.omitted === 0 ? [`(no ${noun})`] : section.items.map(line),
    ...section.omitted > 0 ? [`(${section.omitted} of ${section.total} ${noun} omitted; raise limit or request this section alone)`] : [],
  ].join('\n')
}

/**
 * Render a result as the model's text, clamped to `maxBytes`.
 * @param value - the result to render.
 * @param maxBytes - byte bound over the whole text.
 * @returns the text.
 */
export function renderLibrary(value: LibraryListResult, maxBytes: number): string {
  const sections = [
    ...value.attachments === undefined ? [] : [renderSection('attachments', 'attachments', value.attachments, renderAttachmentLine)],
    ...value.presented === undefined ? [] : [renderSection('presented', 'presented files', value.presented, renderPresentedLine)],
    ...value.changes === undefined ? [] : [renderSection('changes', 'Threads with changes', value.changes, renderChangesLine)],
  ]
  const text = sections.length === 0 ? '(no section selected)' : sections.join('\n\n')
  return truncateUtf8(text, maxBytes)
}

/** Keep the leading `keep` entries of one already-projected section, tracking the drop. */
function resliceSection<T>(section: LibrarySectionResult<T>, keep: number): LibrarySectionResult<T> {
  const items = section.items.slice(0, keep)
  return { items, total: section.total, truncated: items.length < section.total, omitted: section.total - items.length }
}

/**
 * Keep the longest per-section prefixes whose complete rendering fits the bound.
 *
 * Cuts `changes` first, since its per-entry inlined file list makes it the
 * most byte-expensive section, then `presented`, then `attachments` last.
 * @param full - the result from {@link toLibraryListResult}, before any byte cut.
 * @param maxBytes - byte bound over the rendered text.
 * @returns the result carrying only entries that render within the bound.
 */
export function fitLibrary(full: LibraryListResult, maxBytes: number): LibraryListResult {
  const cut = {
    attachments: full.attachments?.items.length ?? 0,
    presented: full.presented?.items.length ?? 0,
    changes: full.changes?.items.length ?? 0,
  }
  const build = (): LibraryListResult => ({
    ...full.attachments === undefined ? {} : { attachments: resliceSection(full.attachments, cut.attachments) },
    ...full.presented === undefined ? {} : { presented: resliceSection(full.presented, cut.presented) },
    ...full.changes === undefined ? {} : { changes: resliceSection(full.changes, cut.changes) },
  })
  const size = (): number => byteLength(renderLibrary(build(), Infinity))
  for (const key of ['changes', 'presented', 'attachments'] as const) {
    while (cut[key] > 0 && size() > maxBytes) cut[key] -= 1
  }
  return build()
}
