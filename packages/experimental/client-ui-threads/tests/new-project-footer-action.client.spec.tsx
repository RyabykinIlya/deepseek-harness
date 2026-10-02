// @vitest-environment jsdom
/**
 * The New Project footer action: a button in the sidebar foot that creates a
 * Project Session in the most recently active Workspace.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import {
  NewProjectFooterAction, type NewProjectFooterActionProps, type NewProjectResult,
} from '../src/client/project/NewProjectFooterAction.tsx'
import { recentWorkspaceId } from '../src/client/project.ts'
import { zh } from '../src/client/locales.ts'
import { fake } from './support.client.ts'

afterEach(cleanup)

const t: NewProjectFooterActionProps['t'] = makeTranslate(zh)

const WORKSPACES = [
  { workspaceId: 'ws/old', sessionIds: ['s1'], createdAt: '2026-01-01T00:00:00Z' },
  { workspaceId: 'ws/new', sessionIds: ['s2'], createdAt: '2026-01-01T00:00:00Z' },
]
const SESSIONS = { s1: { updatedAt: 10 }, s2: { updatedAt: 20 } }

/** Render the action over fixed Workspace and Session stores. */
function renderAction(
  startProject: (workspaceId: WorkspaceId) => Promise<NewProjectResult>,
  over: { workspaces?: unknown[]; wide?: boolean } = {},
): void {
  const state = { items: over.workspaces ?? WORKSPACES, byId: SESSIONS }
  const hook = <T,>(select: (value: typeof state) => T): T => select(state)
  // The hooks read a reduced store, so they are typed by the stand-in state.
  render(<NewProjectFooterAction {...fake<NewProjectFooterActionProps>({
    wide: over.wide ?? true,
    startProject,
    useWorkspaces: hook as never,
    useSessions: hook as never,
    t,
  })} />)
}

/** Click the button and let the pending request settle. */
async function press(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: '新建项目' }))
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}

describe('NewProjectFooterAction', () => {
  it('creates the Project in the Workspace holding the most recent Session', async () => {
    const startProject = vi.fn(() => Promise.resolve<NewProjectResult>({ ok: true }))
    renderAction(startProject)
    await press()
    expect(startProject).toHaveBeenCalledWith('ws/new')
  })

  it('shows its label only in the wide sidebar', () => {
    renderAction(vi.fn(() => Promise.resolve<NewProjectResult>({ ok: true })), { wide: false })
    expect(screen.getByRole('button', { name: '新建项目' }).textContent).toBe('')
    cleanup()
    renderAction(vi.fn(() => Promise.resolve<NewProjectResult>({ ok: true })))
    expect(screen.getByRole('button', { name: '新建项目' }).textContent).toBe('新建项目')
  })

  it('takes one activation at a time', async () => {
    let release: (() => void) | undefined
    const startProject = vi.fn(() => new Promise<NewProjectResult>((resolve) => {
      release = () => { resolve({ ok: true }) }
    }))
    renderAction(startProject)
    const button = screen.getByRole('button', { name: '新建项目' }) as HTMLButtonElement
    fireEvent.click(button)
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(startProject).toHaveBeenCalledTimes(1)
    await act(async () => { release?.(); await Promise.resolve() })
    expect(button.disabled).toBe(false)
  })

  it('says so when there is no Workspace to create in, without calling the Host', async () => {
    const startProject = vi.fn(() => Promise.resolve<NewProjectResult>({ ok: true }))
    renderAction(startProject, { workspaces: [] })
    await press()
    expect(startProject).not.toHaveBeenCalled()
    expect(screen.getByText('没有可用的工作区，无法新建项目')).toBeDefined()
  })

  it.each([
    [{ ok: false, reason: 'unconfigured' }, '没有配置项目预设，无法新建项目'],
    [{ ok: false, reason: 'create-failed', message: 'host refused' }, '无法新建项目：host refused'],
    [{ ok: false, reason: 'preset-not-found', preset: 'project' }, /找不到项目预设“project”/],
    [{ ok: false, reason: 'preset-locked', preset: 'project' }, /无法切换为项目预设“project”/],
    [{ ok: false, reason: 'preset-failed', message: 'nope' }, '无法为新会话选择项目预设：nope'],
  ] as const)('reports %j in a toast and leaves the button usable', async (result, text) => {
    renderAction(vi.fn(() => Promise.resolve<NewProjectResult>(result)))
    await press()
    expect(screen.getByText(text)).toBeDefined()
    expect(screen.getByRole('button', { name: '新建项目' }).hasAttribute('disabled')).toBe(false)
  })
})

describe('NewProjectFooterAction feedback lifetime', () => {
  it('dismisses its warning once the hold and fade complete', async () => {
    vi.useFakeTimers()
    renderAction(vi.fn(() => Promise.resolve<NewProjectResult>({ ok: false, reason: 'unconfigured' })))
    fireEvent.click(screen.getByRole('button', { name: '新建项目' }))
    await vi.advanceTimersByTimeAsync(0)
    expect(screen.getByText('没有配置项目预设，无法新建项目')).toBeDefined()
    await act(async () => { await vi.advanceTimersByTimeAsync(7000) })
    expect(screen.queryByText('没有配置项目预设，无法新建项目')).toBeNull()
  })
})

describe('recentWorkspaceId', () => {
  it('prefers the Workspace with the latest Session, then the first on a tie', () => {
    expect(recentWorkspaceId(WORKSPACES, id => SESSIONS[id as 's1']?.updatedAt)).toBe('ws/new')
    expect(recentWorkspaceId(WORKSPACES, () => 5)).toBe('ws/old')
  })

  it('falls back to creation time for a Workspace with no listed Session', () => {
    expect(recentWorkspaceId([
      { workspaceId: 'a', sessionIds: [], createdAt: '2026-01-01T00:00:00Z' },
      { workspaceId: 'b', sessionIds: ['gone'], createdAt: '2026-02-01T00:00:00Z' },
    ], () => undefined)).toBe('b')
  })

  it('returns nothing without Workspaces', () => {
    expect(recentWorkspaceId([], () => 0)).toBeUndefined()
  })
})
