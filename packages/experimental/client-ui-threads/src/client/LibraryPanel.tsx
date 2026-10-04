/**
 * Project Library view, shown inside the roster popover of a Project Session.
 *
 * Read-only: lists the attachments sent in the Project chat, the files the
 * Project and its Threads presented, and the changed files of its newest
 * Threads, each newest first. A failed read shows the Host's message beside a
 * retry button, mirroring the roster's own failed-load state; there is no
 * polling and no mutation.
 */
import { useCallback, useEffect, useState } from 'react'
import {
  IconChevronLeftOutlineRegular, IconRefreshOutlineRegular, relativeTime, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  LibraryAttachment, LibraryList, LibraryPresentedFile, LibraryThreadChanges, ThreadsLibrary,
} from '@deepseek-ai/dsh-experimental-threads/client'
import type { LibraryResult } from './actions.ts'
import type { NS } from './locales.ts'
import css from './ThreadsHeaderAction.module.css'

/** Library requests supplied by the slot registration; `projectId` is the Project Session id. */
export interface LibraryInjected {
  /**
   * Read the Project's Library.
   * @param projectId - the Project Session.
   * @returns the three bounded sections, or the Remote failure.
   */
  listLibrary: (projectId: SessionId) => Promise<LibraryResult<ThreadsLibrary>>
}

/** Props of {@link LibraryPanel}. */
export interface LibraryPanelProps extends LibraryInjected {
  /** The Project Session whose Library is shown. */
  projectId: SessionId
  /** Return to the Thread list. */
  onBack: () => void
  /** `threads` namespace translator. */
  t: TranslateNS<typeof NS>
}

/** Localized age of an entry. */
function ageLabel(at: number, t: TranslateNS<typeof NS>): string {
  const { unit, n } = relativeTime(at, Date.now())
  return t(`library.time.${unit}`, { n })
}

/** Non-empty parts of a meta line, joined with the roster's separator. */
function metaLine(parts: readonly (string | undefined)[]): string {
  return parts.filter(value => value !== undefined && value !== '').join(' · ')
}

/** The bound-list truncation notice shared by every section. */
function Truncated({ list, t }: { list: Pick<LibraryList<unknown>, 'items' | 'total' | 'truncated'>; t: TranslateNS<typeof NS> }) {
  if (!list.truncated) return null
  return <p className={css.notice}>{t('library.truncated', { shown: list.items.length, total: list.total })}</p>
}

/** Attachments sent in the Project chat. */
function AttachmentsSection({ list, t }: { list: LibraryList<LibraryAttachment>; t: TranslateNS<typeof NS> }) {
  return (
    <section className={css.librarySection}>
      <h3 className={css.libraryHeading}>{t('library.attachments.title')}</h3>
      {list.items.length === 0 && <p className={css.notice}>{t('library.attachments.empty')}</p>}
      {list.items.length > 0 && (
        <ul className={css.libraryList} aria-label={t('library.attachments.aria')}>
          {list.items.map(item => (
            <li key={item.attachmentId} className={css.libraryItem}>
              <span className={css.libraryPrimary}>{t(`library.attachments.kind.${item.kind}`)} · {item.name ?? item.attachmentId}</span>
              <span className={css.libraryMeta}>{t('library.attachments.bytes', { bytes: item.bytes, age: ageLabel(item.time, t) })}</span>
            </li>
          ))}
        </ul>
      )}
      <Truncated list={list} t={t} />
    </section>
  )
}

/** Files declared with `present` by the Project and its Threads. */
function PresentedSection({ list, t }: { list: LibraryList<LibraryPresentedFile>; t: TranslateNS<typeof NS> }) {
  return (
    <section className={css.librarySection}>
      <h3 className={css.libraryHeading}>{t('library.presented.title')}</h3>
      {list.items.length === 0 && <p className={css.notice}>{t('library.presented.empty')}</p>}
      {list.items.length > 0 && (
        <ul className={css.libraryList} aria-label={t('library.presented.aria')}>
          {list.items.map(item => (
            <li key={`${item.sessionId}:${item.seq}:${item.index}`} className={css.libraryItem}>
              <span className={css.libraryPrimary}>{item.path}</span>
              {item.description !== undefined && item.description !== '' && (
                <span className={css.libraryMeta}>{item.description}</span>
              )}
              <span className={css.libraryMeta}>
                {metaLine([
                  item.threadId === undefined ? t('library.presented.project') : t('library.presented.thread', { threadId: item.threadId }),
                  ageLabel(item.time, t),
                ])}
              </span>
            </li>
          ))}
        </ul>
      )}
      <Truncated list={list} t={t} />
    </section>
  )
}

/**
 * One changed file within a Thread's changes. A `<div>`, not a list item: the
 * enclosing Thread row is already the `role="listitem"` the changes list
 * walks, and a file's own breakdown is not a second navigable list.
 */
function ChangedFileRow({ file, t }: { file: LibraryThreadChanges['files'][number]; t: TranslateNS<typeof NS> }) {
  return (
    <div className={css.libraryFile}>
      <span className={css.libraryFilePath}>{file.path}</span>
      <span className={css.libraryMeta}>
        {file.binary === true
          ? t('library.changes.file.binary')
          : metaLine([
            file.added === undefined ? undefined : t('library.changes.file.added', { n: file.added }),
            file.removed === undefined ? undefined : t('library.changes.file.removed', { n: file.removed }),
          ])}
      </span>
    </div>
  )
}

/** Changed files of one Thread. */
function ThreadChangesRow({ thread, t }: { thread: LibraryThreadChanges; t: TranslateNS<typeof NS> }) {
  const meta = metaLine([
    thread.branch,
    thread.commitsTotal === undefined || thread.commitsTotal === 0
      ? undefined
      : t(thread.commitsTotal === 1 ? 'commitsAhead.one' : 'commitsAhead.other', { count: thread.commitsTotal }),
    thread.uncommitted === undefined || thread.uncommitted === 0
      ? undefined
      : t('uncommitted', { count: thread.uncommitted }),
  ])
  return (
    <li className={css.libraryItem}>
      <span className={css.libraryPrimary}>
        {thread.label}
        <span className={css.libraryBadge}>{t(`library.changes.source.${thread.source}`)}</span>
      </span>
      {meta !== '' && <span className={css.libraryMeta}>{meta}</span>}
      {thread.files.length > 0 && (
        <div className={css.libraryFiles}>
          {thread.files.map(file => <ChangedFileRow key={file.path} file={file} t={t} />)}
        </div>
      )}
      {thread.files.length < thread.filesTotal && (
        <Truncated list={{ items: thread.files, total: thread.filesTotal, truncated: true }} t={t} />
      )}
    </li>
  )
}

/** Changed files per Thread. */
function ChangesSection({ list, t }: { list: LibraryList<LibraryThreadChanges>; t: TranslateNS<typeof NS> }) {
  return (
    <section className={css.librarySection}>
      <h3 className={css.libraryHeading}>{t('library.changes.title')}</h3>
      {list.items.length === 0 && <p className={css.notice}>{t('library.changes.empty')}</p>}
      {list.items.length > 0 && (
        <ul className={css.libraryList} aria-label={t('library.changes.aria')}>
          {list.items.map(thread => <ThreadChangesRow key={thread.threadId} thread={thread} t={t} />)}
        </ul>
      )}
      <Truncated list={list} t={t} />
    </section>
  )
}

/**
 * Render the Library's three sections, read once on mount.
 * @param props - the Project, the Library read, and the back action.
 * @returns the panel body for the roster popover.
 */
export function LibraryPanel({ projectId, listLibrary, onBack, t }: LibraryPanelProps) {
  const [library, setLibrary] = useState<ThreadsLibrary | undefined>(undefined)
  const [failure, setFailure] = useState<string | undefined>(undefined)

  const refresh = useCallback(async (): Promise<void> => {
    const result = await listLibrary(projectId)
    if (result.ok) {
      setLibrary(result.value)
      setFailure(undefined)
    } else {
      setFailure(result.message)
    }
  }, [listLibrary, projectId])

  useEffect(() => { void refresh() }, [refresh])

  return (
    <>
      <div className={css.memoryHead}>
        <Tooltip label={t('library.back')} side="bottom" align="center">
          <button type="button" className={css.rowButton} aria-label={t('library.back')} onClick={onBack}>
            <IconChevronLeftOutlineRegular />
          </button>
        </Tooltip>
        <span className={css.memoryTitle}>{t('library.title')}</span>
      </div>
      <div className={css.menuBody}>
        {failure !== undefined && (
          <div className={css.error}>
            <span>{failure}</span>
            <button type="button" className={css.refresh} onClick={() => { void refresh() }}>
              <IconRefreshOutlineRegular size={14} />
              {t('retry')}
            </button>
          </div>
        )}
        {library !== undefined && (
          <>
            <AttachmentsSection list={library.attachments} t={t} />
            <PresentedSection list={library.presented} t={t} />
            <ChangesSection list={library.changes} t={t} />
          </>
        )}
      </div>
    </>
  )
}
