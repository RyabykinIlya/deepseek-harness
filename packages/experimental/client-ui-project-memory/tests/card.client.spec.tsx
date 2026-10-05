// @vitest-environment jsdom
/** The Project memory page as the Plugins page renders it: its one-liner and its two caps. */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsFieldState, SettingsFormShell } from '@deepseek-ai/dsh-client-ui-primitives'
import { ProjectMemoryCard, type ProjectMemoryCardProps } from '../src/client/ProjectMemoryCard.tsx'
import type { ProjectMemoryCardState } from '../src/client/project-memory-card-controller.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t = (key: keyof typeof en) => en[key]

const settled: SettingsFormShell = { available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false }

function field(text: string, rest: Partial<SettingsFieldState> = {}): SettingsFieldState {
  return { text, overridden: false, invalid: false, ...rest }
}

function renderCard(state: Partial<ProjectMemoryCardState> = {}, view: 'summary' | 'page' = 'page') {
  const store = createSnapshotStore<ProjectMemoryCardState>({
    ...settled,
    maxEntries: field('200'),
    maxEntryChars: field('2000'),
    ...state,
  })
  const actions = { edit: vi.fn(), resetField: vi.fn(), save: vi.fn(), discard: vi.fn() }
  const props = { ...actions, view, t, useProjectMemoryCard: bindSnapshotSelector(store) } as ProjectMemoryCardProps
  render(<ProjectMemoryCard {...props} />)
  return actions
}

describe('ProjectMemoryCard', () => {
  it('renders its one-liner alone in the summary view', () => {
    renderCard({}, 'summary')

    expect(document.body.textContent).toBe(en.description)
    expect(screen.queryByLabelText(en.maxEntries)).toBeNull()
  })

  it('stages and saves both caps', () => {
    const actions = renderCard({ dirty: true })

    fireEvent.change(screen.getByLabelText(en.maxEntryChars), { target: { value: '4000' } })
    fireEvent.click(screen.getByRole('button', { name: en.save }))

    expect(actions.edit).toHaveBeenCalledWith('maxEntryChars', '4000')
    expect(actions.save).toHaveBeenCalledOnce()
  })

  it('stages a reset for each cap it owns', () => {
    const actions = renderCard({ maxEntryChars: field('4000', { overridden: true }) })

    fireEvent.click(screen.getAllByRole('button', { name: en.reset })[0]!)

    expect(actions.resetField).toHaveBeenCalledWith('maxEntryChars')
  })

  it('says Project memory is not loaded while its namespace is unavailable, and disables the caps while the document is read-only', () => {
    renderCard({ available: false })
    expect(screen.getByRole('status').textContent).toBe(en.unavailable)
    cleanup()

    renderCard({ writable: false })
    expect(screen.getByRole('status').textContent).toBe(en.readOnly)
    expect(screen.getByLabelText(en.maxEntries)).toHaveProperty('disabled', true)
    expect(screen.getByLabelText(en.maxEntryChars)).toHaveProperty('disabled', true)
  })
})
