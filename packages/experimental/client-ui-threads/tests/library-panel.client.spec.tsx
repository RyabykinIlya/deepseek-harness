// @vitest-environment jsdom
/** The Library view: read-only attachments, presented files, and Thread changes, each with its own empty/truncated case. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ThreadId as toThreadId } from '@deepseek-ai/dsh-experimental-threads/types'
import type {
  LibraryAttachment, LibraryPresentedFile, LibraryThreadChanges, ThreadsLibrary,
} from '@deepseek-ai/dsh-experimental-threads/client'
import type { LibraryResult } from '../src/client/actions.ts'
import { LibraryPanel, type LibraryPanelProps } from '../src/client/LibraryPanel.tsx'
import { en, zh } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const PROJECT = 'project/1' as SessionId
/** A Thread's own Session: a file it presents is carried by that log, not the Project's. */
const THREAD_SESSION = 'thread/7' as SessionId
const t: LibraryPanelProps['t'] = makeTranslate(zh)
const NOW = Date.UTC(2026, 9, 2, 12, 0, 0)

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

function ok(value: ThreadsLibrary): Promise<LibraryResult<ThreadsLibrary>> {
  return Promise.resolve({ ok: true, value })
}

function failed(message: string): Promise<LibraryResult<never>> {
  return Promise.resolve({ ok: false, code: 'threads/project-not-found', message })
}

function attachment(over: Partial<LibraryAttachment> & { attachmentId: string }): LibraryAttachment {
  return { kind: 'file', bytes: 100, seq: 1, time: NOW - MINUTE, ...over }
}

function presented(over: Partial<LibraryPresentedFile> & { path: string }): LibraryPresentedFile {
  return { sessionId: PROJECT, seq: 1, index: 0, time: NOW - MINUTE, ...over }
}

function changes(over: Partial<LibraryThreadChanges> & { threadId: ReturnType<typeof toThreadId>; label: string }): LibraryThreadChanges {
  return { source: 'live', files: [], filesTotal: 0, ...over }
}

/** An empty Library, so a spec can override only the section it exercises. */
function emptyLibrary(): ThreadsLibrary {
  return {
    attachments: { items: [], total: 0, truncated: false },
    presented: { items: [], total: 0, truncated: false },
    changes: { items: [], total: 0, truncated: false },
  }
}

function panelProps(over: Partial<LibraryPanelProps> = {}): LibraryPanelProps {
  return {
    projectId: PROJECT,
    listLibrary: vi.fn(() => ok(emptyLibrary())),
    onBack: vi.fn(),
    t,
    ...over,
  }
}

describe('LibraryPanel', () => {
  it('shows nothing but the header while the first read is pending', () => {
    render(<LibraryPanel {...panelProps({ listLibrary: () => new Promise(() => {}) })} />)
    expect(screen.queryByRole('list')).toBeNull()
    expect(screen.queryByText('附件')).toBeNull()
  })

  it('shows a failed read with a retry button, and recovers on retry', async () => {
    const listLibrary = vi.fn<LibraryPanelProps['listLibrary']>()
      .mockImplementationOnce(() => failed('Session project/1 is not a project'))
      .mockImplementation(() => ok(emptyLibrary()))
    render(<LibraryPanel {...panelProps({ listLibrary })} />)
    expect(await screen.findByText('Session project/1 is not a project')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByText('还没有附件')).toBeDefined()
    expect(screen.queryByText('Session project/1 is not a project')).toBeNull()
    expect(listLibrary).toHaveBeenCalledTimes(2)
  })

  it('returns to the Thread list', async () => {
    const props = panelProps()
    render(<LibraryPanel {...props} />)
    await screen.findByText('还没有附件')
    fireEvent.click(screen.getByRole('button', { name: '返回线程列表' }))
    expect(props.onBack).toHaveBeenCalledOnce()
  })

  it('has an English dictionary for every library key', () => {
    expect(Object.keys(en).filter(key => key.startsWith('library.')).sort())
      .toEqual(Object.keys(zh).filter(key => key.startsWith('library.')).sort())
  })

  describe('attachments', () => {
    it('lists kind, the name fallback, byte count and age', async () => {
      vi.spyOn(Date, 'now').mockReturnValue(NOW)
      const library: ThreadsLibrary = {
        ...emptyLibrary(),
        attachments: {
          items: [
            attachment({ attachmentId: 'a1', kind: 'image', name: 'screenshot.png', bytes: 2048, time: NOW - 5 * MINUTE }),
            attachment({ attachmentId: 'a2', kind: 'file', bytes: 10, time: NOW }),
          ],
          total: 2,
          truncated: false,
        },
      }
      render(<LibraryPanel {...panelProps({ listLibrary: () => ok(library) })} />)
      const list = await screen.findByRole('list', { name: '资料库附件' })
      const items = within(list).getAllByRole('listitem')
      expect(items[0]?.textContent).toContain('图片 · screenshot.png')
      expect(items[0]?.textContent).toContain('2048 B · 5 分钟前')
      // Falls back to the attachment id when no name was recorded.
      expect(items[1]?.textContent).toContain('文件 · a2')
      expect(items[1]?.textContent).toContain('10 B · 刚刚')
      expect(screen.queryByText(/显示最新/)).toBeNull()
    })

    it('shows the empty state with no attachments', async () => {
      render(<LibraryPanel {...panelProps()} />)
      expect(await screen.findByText('还没有附件')).toBeDefined()
      expect(screen.queryByRole('list', { name: '资料库附件' })).toBeNull()
    })

    it('shows the truncated notice', async () => {
      const library: ThreadsLibrary = {
        ...emptyLibrary(),
        attachments: { items: [attachment({ attachmentId: 'a1' })], total: 5, truncated: true },
      }
      render(<LibraryPanel {...panelProps({ listLibrary: () => ok(library) })} />)
      expect(await screen.findByText('显示最新 1 条，共 5 条')).toBeDefined()
    })
  })

  describe('presented files', () => {
    it('shows the path, an optional description, Project or Thread, and age', async () => {
      vi.spyOn(Date, 'now').mockReturnValue(NOW)
      const library: ThreadsLibrary = {
        ...emptyLibrary(),
        presented: {
          items: [
            presented({ path: 'report.md', description: 'Final report', time: NOW - HOUR }),
            presented({
              path: 'notes.txt', sessionId: THREAD_SESSION, threadId: toThreadId('t-1'), seq: 4, index: 2, time: NOW - DAY,
            }),
          ],
          total: 2,
          truncated: false,
        },
      }
      render(<LibraryPanel {...panelProps({ listLibrary: () => ok(library) })} />)
      const list = await screen.findByRole('list', { name: '展示的文件' })
      const items = within(list).getAllByRole('listitem')
      expect(items[0]?.textContent).toContain('report.md')
      expect(items[0]?.textContent).toContain('Final report')
      expect(items[0]?.textContent).toContain('项目 · 1 小时前')
      expect(items[1]?.textContent).toContain('notes.txt')
      expect(items[1]?.textContent).toContain('线程 t-1 · 1 天前')
    })

    it('shows the empty state with no presented files', async () => {
      render(<LibraryPanel {...panelProps()} />)
      expect(await screen.findByText('还没有展示的文件')).toBeDefined()
    })

    it('shows the truncated notice', async () => {
      const library: ThreadsLibrary = {
        ...emptyLibrary(),
        presented: { items: [presented({ path: 'a.md' })], total: 9, truncated: true },
      }
      render(<LibraryPanel {...panelProps({ listLibrary: () => ok(library) })} />)
      expect(await screen.findByText('显示最新 1 条，共 9 条')).toBeDefined()
    })
  })

  describe('thread changes', () => {
    it('shows label, source, branch, commit and uncommitted counts, and changed files', async () => {
      const library: ThreadsLibrary = {
        ...emptyLibrary(),
        changes: {
          items: [
            changes({
              threadId: toThreadId('t-1'), label: 'alpha', source: 'live', branch: 'dsh/t-1', commitsTotal: 1, uncommitted: 2,
              files: [
                { path: 'a.ts', added: 3, removed: 1 },
                { path: 'b.bin', binary: true },
                // Added-only and removed-only rows exercise each half of the diff ternaries.
                { path: 'c.ts', added: 2 },
                { path: 'd.ts', removed: 4 },
              ],
              filesTotal: 4,
            }),
            changes({
              threadId: toThreadId('t-2'), label: 'beta', source: 'archived', commitsTotal: 3, filesTotal: 0,
            }),
            // No branch, no commits, no uncommitted: the meta line is empty and skipped.
            changes({ threadId: toThreadId('t-3'), label: 'gamma', source: 'live', commitsTotal: 0, uncommitted: 0, filesTotal: 0 }),
          ],
          total: 3,
          truncated: false,
        },
      }
      render(<LibraryPanel {...panelProps({ listLibrary: () => ok(library) })} />)
      const list = await screen.findByRole('list', { name: '线程改动' })
      const items = within(list).getAllByRole('listitem')
      expect(items[0]?.textContent).toContain('alpha')
      expect(items[0]?.textContent).toContain('进行中')
      expect(items[0]?.textContent).toContain('dsh/t-1 · 领先 1 个提交 · 2 个未提交')
      expect(items[0]?.textContent).toContain('a.ts')
      expect(items[0]?.textContent).toContain('+3')
      expect(items[0]?.textContent).toContain('-1')
      expect(items[0]?.textContent).toContain('b.bin')
      expect(items[0]?.textContent).toContain('二进制文件')
      expect(items[0]?.textContent).toContain('c.ts')
      expect(items[0]?.textContent).toContain('+2')
      expect(items[0]?.textContent).toContain('d.ts')
      expect(items[0]?.textContent).toContain('-4')
      expect(items[1]?.textContent).toContain('beta')
      expect(items[1]?.textContent).toContain('已归档')
      expect(items[1]?.textContent).toContain('领先 3 个提交')
      expect(items[2]?.textContent).toContain('gamma')
    })

    it('shows the per-thread files-truncated notice when fewer files were listed than exist', async () => {
      const library: ThreadsLibrary = {
        ...emptyLibrary(),
        changes: {
          items: [
            changes({ threadId: toThreadId('t-1'), label: 'alpha', files: [{ path: 'a.ts', added: 1 }], filesTotal: 5 }),
          ],
          total: 1,
          truncated: false,
        },
      }
      render(<LibraryPanel {...panelProps({ listLibrary: () => ok(library) })} />)
      expect(await screen.findByText('显示最新 1 条，共 5 条')).toBeDefined()
    })

    it('shows the empty state with no thread changes', async () => {
      render(<LibraryPanel {...panelProps()} />)
      expect(await screen.findByText('还没有线程改动')).toBeDefined()
    })

    it('shows the truncated notice for the Thread list itself', async () => {
      const library: ThreadsLibrary = {
        ...emptyLibrary(),
        changes: { items: [changes({ threadId: toThreadId('t-1'), label: 'alpha' })], total: 4, truncated: true },
      }
      render(<LibraryPanel {...panelProps({ listLibrary: () => ok(library) })} />)
      expect(await screen.findByText('显示最新 1 条，共 4 条')).toBeDefined()
    })
  })
})
