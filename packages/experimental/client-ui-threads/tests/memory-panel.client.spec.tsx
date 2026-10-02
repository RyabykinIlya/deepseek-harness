// @vitest-environment jsdom
/** The Memory view: newest-first list, user add/edit/delete, in-place refusals, empty state. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { MemoryResult } from '../src/client/actions.ts'
import { MemoryPanel, type MemoryPanelProps } from '../src/client/MemoryPanel.tsx'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { MemoryEntry, MemoryEntryId } from '../src/client/memory-types.ts'
import { en, zh } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const PROJECT = 'project/1' as SessionId
const t: MemoryPanelProps['t'] = makeTranslate(zh)
const NOW = Date.UTC(2026, 9, 2, 12, 0, 0)

function entry(id: string, text: string, author: MemoryEntry['author'], ageMs: number): MemoryEntry {
  return {
    id: brandString<MemoryEntryId>(id), text, author, createdAt: NOW - ageMs, updatedAt: NOW - ageMs,
  }
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const ENTRIES = [
  entry('m1', 'old decision', 'coordinator', 3 * DAY),
  entry('m2', 'newest fact', 'user', 10_000),
  entry('m3', 'thread note', 'thread', 5 * HOUR),
  entry('m4', 'five minutes', 'user', 5 * MINUTE),
  entry('m5', 'last quarter', 'user', 60 * DAY),
  entry('m6', 'last year', 'user', 400 * DAY),
]

function ok<V>(value: V): Promise<MemoryResult<V>> {
  return Promise.resolve({ ok: true, value })
}

function refused(message: string): Promise<MemoryResult<never>> {
  return Promise.resolve({ ok: false, code: 'project-memory/refused', message })
}

function panelProps(over: Partial<MemoryPanelProps> = {}): MemoryPanelProps {
  return {
    projectId: PROJECT,
    listMemory: vi.fn(() => ok<readonly MemoryEntry[]>(ENTRIES)),
    addMemory: vi.fn((_project: SessionId, text: string) => ok(entry('m9', text, 'user', 0))),
    updateMemory: vi.fn((_project: SessionId, id: MemoryEntryId, text: string) => ok(entry(id, text, 'user', 0))),
    removeMemory: vi.fn(() => ok(undefined)),
    onBack: vi.fn(),
    t,
    ...over,
  }
}

describe('MemoryPanel', () => {
  it('lists entries newest first with author and age', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    render(<MemoryPanel {...panelProps()} />)
    const list = await screen.findByRole('list', { name: '记忆条目' })
    const items = within(list).getAllByRole('listitem')
    expect(items.map(item => item.getAttribute('data-memory-id'))).toEqual(['m2', 'm4', 'm3', 'm1', 'm5', 'm6'])
    expect(items[0]?.textContent).toContain('你 · 刚刚')
    expect(items[1]?.textContent).toContain('你 · 5 分钟前')
    expect(items[2]?.textContent).toContain('线程 · 5 小时前')
    expect(items[3]?.textContent).toContain('协调者 · 3 天前')
    expect(items[4]?.textContent).toContain('2 个月前')
    expect(items[5]?.textContent).toContain('1 年前')
  })

  it('has an English dictionary for every memory key', () => {
    expect(Object.keys(en).filter(key => key.startsWith('memory.')).sort())
      .toEqual(Object.keys(zh).filter(key => key.startsWith('memory.')).sort())
  })

  it('shows the empty state when there are no entries', async () => {
    render(<MemoryPanel {...panelProps({ listMemory: () => ok<readonly MemoryEntry[]>([]) })} />)
    expect(await screen.findByText(/还没有记忆/)).toBeDefined()
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('shows nothing but the form while the first read is pending', () => {
    render(<MemoryPanel {...panelProps({ listMemory: () => new Promise(() => {}) })} />)
    expect(screen.queryByRole('list')).toBeNull()
    expect(screen.queryByText(/还没有记忆/)).toBeNull()
  })

  it('shows a failed read in place', async () => {
    render(<MemoryPanel {...panelProps({
      listMemory: () => Promise.resolve({ ok: false, code: 'gateway/internal', message: 'storage offline' }),
    })} />)
    expect((await screen.findByRole('alert')).textContent).toBe('storage offline')
  })

  it('adds an entry, clears the field and re-reads', async () => {
    const props = panelProps()
    render(<MemoryPanel {...props} />)
    await screen.findByRole('list')
    const field = screen.getByPlaceholderText('添加一条事实或决定') as HTMLInputElement
    fireEvent.change(field, { target: { value: 'use pnpm' } })
    fireEvent.click(screen.getByRole('button', { name: '添加' }))
    await waitFor(() => { expect(field.value).toBe('') })
    expect(props.addMemory).toHaveBeenCalledWith(PROJECT, 'use pnpm')
    await waitFor(() => { expect(props.listMemory).toHaveBeenCalledTimes(2) })
  })

  it('shows a refusal in place with its message and keeps the draft and the list', async () => {
    render(<MemoryPanel {...panelProps({ addMemory: () => refused('The memory text is empty.') })} />)
    await screen.findByRole('list')
    const field = screen.getByPlaceholderText('添加一条事实或决定') as HTMLInputElement
    fireEvent.change(field, { target: { value: ' ' } })
    fireEvent.click(screen.getByRole('button', { name: '添加' }))
    expect((await screen.findByRole('alert')).textContent).toBe('The memory text is empty.')
    expect(field.value).toBe(' ')
    expect(screen.getAllByRole('listitem')).toHaveLength(6)
  })

  it('clears an earlier refusal after the next request succeeds', async () => {
    const addMemory = vi.fn<MemoryPanelProps['addMemory']>()
      .mockImplementationOnce(() => refused('too long'))
      .mockImplementation((_project, text) => ok(entry('m9', text, 'user', 0)))
    render(<MemoryPanel {...panelProps({ addMemory })} />)
    await screen.findByRole('list')
    fireEvent.click(screen.getByRole('button', { name: '添加' }))
    await screen.findByRole('alert')
    fireEvent.click(screen.getByRole('button', { name: '添加' }))
    await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
  })

  it('edits an entry in place and saves it', async () => {
    const props = panelProps()
    render(<MemoryPanel {...props} />)
    await screen.findByRole('list')
    fireEvent.click(screen.getByRole('button', { name: '编辑记忆 newest fact' }))
    const [field] = screen.getAllByLabelText('记忆内容') as HTMLInputElement[]
    expect(field?.value).toBe('newest fact')
    fireEvent.change(field!, { target: { value: 'newer fact' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => { expect(screen.queryByRole('button', { name: '保存' })).toBeNull() })
    expect(props.updateMemory).toHaveBeenCalledWith(PROJECT, 'm2', 'newer fact')
  })

  it('cancels an edit without writing, and keeps the editor on a refusal', async () => {
    const props = panelProps({ updateMemory: () => refused('text too long') })
    render(<MemoryPanel {...props} />)
    await screen.findByRole('list')
    fireEvent.click(screen.getByRole('button', { name: '编辑记忆 newest fact' }))
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '编辑记忆 newest fact' }))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect((await screen.findByRole('alert')).textContent).toBe('text too long')
    expect(screen.getByRole('button', { name: '保存' })).toBeDefined()
  })

  it('deletes an entry and re-reads', async () => {
    const props = panelProps()
    render(<MemoryPanel {...props} />)
    await screen.findByRole('list')
    fireEvent.click(screen.getByRole('button', { name: '删除记忆 thread note' }))
    await waitFor(() => { expect(props.removeMemory).toHaveBeenCalledWith(PROJECT, 'm3') })
    await waitFor(() => { expect(props.listMemory).toHaveBeenCalledTimes(2) })
  })

  it('shows a refused deletion and keeps the row', async () => {
    render(<MemoryPanel {...panelProps({ removeMemory: () => refused('No memory entry "m3" exists in this Project.') })} />)
    await screen.findByRole('list')
    fireEvent.click(screen.getByRole('button', { name: '删除记忆 thread note' }))
    expect((await screen.findByRole('alert')).textContent).toContain('m3')
    expect(screen.getByText('thread note')).toBeDefined()
  })

  it('returns to the Thread list', async () => {
    const props = panelProps()
    render(<MemoryPanel {...props} />)
    await screen.findByRole('list')
    fireEvent.click(screen.getByRole('button', { name: '返回线程列表' }))
    expect(props.onBack).toHaveBeenCalledOnce()
  })
})
