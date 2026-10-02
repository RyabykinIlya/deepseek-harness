/**
 * Project memory view, shown inside the roster popover of a Project Session.
 *
 * Lists the Project's entries newest first with author and age, and lets the
 * user add, edit and delete entries. Every mutation is followed by a re-read, so
 * the list is always what the Host stores. A refusal (`project-memory/refused`)
 * or any other failure is shown in place, beside the retained list, with the
 * Host's own message.
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import {
  Button, IconChevronLeftOutlineRegular, IconEditOutlineRegular, IconTrashOutlineRegular, Input,
  relativeTime, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { MemoryResult } from './actions.ts'
import type { NS } from './locales.ts'
import type { MemoryEntry, MemoryEntryId } from './memory-types.ts'
import css from './ThreadsHeaderAction.module.css'

/** Project memory requests supplied by the slot registration; `projectId` is the Project Session id. */
export interface MemoryInjected {
  /**
   * Read the Project's entries.
   * @param projectId - the Project Session.
   * @returns the entries, or the Remote failure.
   */
  listMemory: (projectId: SessionId) => Promise<MemoryResult<readonly MemoryEntry[]>>
  /**
   * Add an entry as the user.
   * @param projectId - the Project Session.
   * @param text - entry text.
   * @returns the stored entry, or the refusal.
   */
  addMemory: (projectId: SessionId, text: string) => Promise<MemoryResult<MemoryEntry>>
  /**
   * Rewrite an entry as the user.
   * @param projectId - the Project Session.
   * @param id - entry to rewrite.
   * @param text - replacement text.
   * @returns the stored entry, or the refusal.
   */
  updateMemory: (projectId: SessionId, id: MemoryEntryId, text: string) => Promise<MemoryResult<MemoryEntry>>
  /**
   * Delete an entry.
   * @param projectId - the Project Session.
   * @param id - entry to delete.
   * @returns success, or the refusal.
   */
  removeMemory: (projectId: SessionId, id: MemoryEntryId) => Promise<MemoryResult<void>>
}

/** Props of {@link MemoryPanel}. */
export interface MemoryPanelProps extends MemoryInjected {
  /** The Project Session whose memory is shown. */
  projectId: SessionId
  /** Return to the Thread list. */
  onBack: () => void
  /** `threads` namespace translator. */
  t: TranslateNS<typeof NS>
}

/** Localized age of an entry. */
function ageLabel(at: number, t: TranslateNS<typeof NS>): string {
  const { unit, n } = relativeTime(at, Date.now())
  return t(`memory.time.${unit}`, { n })
}

/**
 * Render the memory list with its add form.
 * @param props - the Project, the memory requests, and the back action.
 * @returns the panel body for the roster popover.
 */
export function MemoryPanel({ projectId, listMemory, addMemory, updateMemory, removeMemory, onBack, t }: MemoryPanelProps) {
  const [entries, setEntries] = useState<readonly MemoryEntry[] | undefined>(undefined)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState<{ id: MemoryEntryId; text: string } | undefined>(undefined)
  const [pending, setPending] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    const result = await listMemory(projectId)
    if (result.ok) setEntries([...result.value].sort((a, b) => b.updatedAt - a.updatedAt))
    else setFailure(result.message)
  }, [listMemory, projectId])

  useEffect(() => { void refresh() }, [refresh])

  /** Run one mutation, show a refusal in place, and re-read on success. */
  const mutate = async (run: () => Promise<MemoryResult<unknown>>, onDone: () => void): Promise<void> => {
    setPending(true)
    try {
      const result = await run()
      if (!result.ok) {
        setFailure(result.message)
        return
      }
      setFailure(undefined)
      onDone()
      await refresh()
    } finally {
      setPending(false)
    }
  }

  const submitAdd = (event: FormEvent): void => {
    event.preventDefault()
    void mutate(() => addMemory(projectId, draft), () => { setDraft('') })
  }

  const submitEdit = (target: { id: MemoryEntryId; text: string }) => (event: FormEvent): void => {
    event.preventDefault()
    void mutate(() => updateMemory(projectId, target.id, target.text), () => { setEditing(undefined) })
  }

  return (
    <>
      <div className={css.memoryHead}>
        <Tooltip label={t('memory.back')} side="bottom" align="center">
          <button type="button" className={css.rowButton} aria-label={t('memory.back')} onClick={onBack}>
            <IconChevronLeftOutlineRegular />
          </button>
        </Tooltip>
        <span className={css.memoryTitle}>{t('memory.title')}</span>
      </div>
      <div className={css.menuBody}>
        {failure !== undefined && <div className={css.error} role="alert"><span>{failure}</span></div>}
        {entries !== undefined && entries.length === 0 && <p className={css.notice}>{t('memory.empty')}</p>}
        {entries !== undefined && entries.length > 0 && (
          <ul className={css.memoryList} aria-label={t('memory.list.aria')}>
            {entries.map(entry => (
              <li key={entry.id} className={css.memoryItem} data-memory-id={entry.id}>
                {editing?.id === entry.id
                  ? (
                    <form className={css.memoryEdit} onSubmit={submitEdit(editing)}>
                      <Input
                        aria-label={t('memory.text.aria')}
                        value={editing.text}
                        onChange={(event) => { setEditing({ id: entry.id, text: event.target.value }) }}
                      />
                      <Button size="sm" variant="primary" type="submit" disabled={pending}>{t('memory.save')}</Button>
                      <Button size="sm" onClick={() => { setEditing(undefined) }}>{t('memory.cancel')}</Button>
                    </form>
                  )
                  : (
                    <>
                      <span className={css.memoryBody}>
                        <span className={css.memoryText}>{entry.text}</span>
                        <span className={css.memoryMeta}>
                          {t(`memory.author.${entry.author}`)} · {ageLabel(entry.updatedAt, t)}
                        </span>
                      </span>
                      <Tooltip label={t('memory.edit')} side="bottom" align="end">
                        <button
                          type="button"
                          className={css.rowButton}
                          aria-label={t('memory.edit.aria', { text: entry.text })}
                          onClick={() => { setEditing({ id: entry.id, text: entry.text }) }}
                        >
                          <IconEditOutlineRegular />
                        </button>
                      </Tooltip>
                      <Tooltip label={t('memory.delete')} side="bottom" align="end">
                        <button
                          type="button"
                          className={css.rowButton}
                          aria-label={t('memory.delete.aria', { text: entry.text })}
                          disabled={pending}
                          onClick={() => { void mutate(() => removeMemory(projectId, entry.id), () => {}) }}
                        >
                          <IconTrashOutlineRegular />
                        </button>
                      </Tooltip>
                    </>
                  )}
              </li>
            ))}
          </ul>
        )}
      </div>
      <form className={css.memoryForm} onSubmit={submitAdd}>
        <Input
          aria-label={t('memory.text.aria')}
          placeholder={t('memory.add.placeholder')}
          value={draft}
          onChange={(event) => { setDraft(event.target.value) }}
        />
        <Button size="sm" variant="primary" type="submit" disabled={pending}>{t('memory.add')}</Button>
      </form>
    </>
  )
}
