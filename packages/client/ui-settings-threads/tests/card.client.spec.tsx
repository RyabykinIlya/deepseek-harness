// @vitest-environment jsdom
/** The Threads page as the Plugins page renders it: its seven controls and its notice. */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsFieldState, SettingsFormShell } from '@deepseek-ai/dsh-client-ui-primitives'
import { ThreadsCard, type ThreadsCardProps } from '../src/client/ThreadsCard.tsx'
import type { ThreadsCardState } from '../src/client/threads-card-controller.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t = (key: keyof typeof en) => en[key]

const settled: SettingsFormShell = { available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false }

function field(text: string, rest: Partial<SettingsFieldState> = {}): SettingsFieldState {
  return { text, overridden: false, invalid: false, ...rest }
}

/** The whole page as the Host serves it, with every field named by the real row. */
const served: ThreadsCardState = {
  ...settled,
  checkIn: field('milestones'),
  spawn: field('ask'),
  mergePolicy: field('ask'),
  threadProvider: field(''),
  threadModel: field(''),
  threadReasoningEffort: field(''),
  threadMaxTokens: field(''),
  partialThreadModel: false,
}

function renderCard(state: Partial<ThreadsCardState> = {}, view: 'summary' | 'page' = 'page') {
  const store = createSnapshotStore<ThreadsCardState>({ ...served, ...state })
  const actions = { edit: vi.fn(), resetField: vi.fn(), save: vi.fn(), discard: vi.fn() }
  const props = { ...actions, view, t, useThreadsCard: bindSnapshotSelector(store) } as ThreadsCardProps
  render(<ThreadsCard {...props} />)
  return actions
}

describe('ThreadsCard', () => {
  it('renders its one-liner alone in the summary view', () => {
    renderCard({}, 'summary')

    expect(document.body.textContent).toBe(en.description)
    expect(screen.queryByLabelText(en.checkIn)).toBeNull()
  })

  it('renders one labelled control for every field of the Host row the page edits', () => {
    renderCard()

    for (const label of [en.checkIn, en.spawn, en.mergePolicy, en.threadProvider, en.threadModel, en.threadReasoningEffort, en.threadMaxTokens]) {
      expect(screen.getByLabelText(label)).toBeDefined()
    }
  })

  it('stages each coordinator knob under the field name the Host row declares', () => {
    const actions = renderCard({ dirty: true })

    fireEvent.change(screen.getByLabelText(en.checkIn), { target: { value: 'quiet' } })
    fireEvent.change(screen.getByLabelText(en.spawn), { target: { value: 'auto' } })
    fireEvent.change(screen.getByLabelText(en.mergePolicy), { target: { value: 'auto' } })

    expect(actions.edit).toHaveBeenCalledWith('checkIn', 'quiet')
    expect(actions.edit).toHaveBeenCalledWith('spawn', 'auto')
    expect(actions.edit).toHaveBeenCalledWith('mergePolicy', 'auto')
  })

  it('stages each Thread model option under the field name the Host row declares', () => {
    const actions = renderCard({ dirty: true })

    fireEvent.change(screen.getByLabelText(en.threadProvider), { target: { value: 'deepseek' } })
    fireEvent.change(screen.getByLabelText(en.threadModel), { target: { value: 'deepseek-chat' } })
    fireEvent.change(screen.getByLabelText(en.threadReasoningEffort), { target: { value: 'high' } })
    fireEvent.change(screen.getByLabelText(en.threadMaxTokens), { target: { value: '8192' } })

    expect(actions.edit).toHaveBeenCalledWith('threadProvider', 'deepseek')
    expect(actions.edit).toHaveBeenCalledWith('threadModel', 'deepseek-chat')
    expect(actions.edit).toHaveBeenCalledWith('threadReasoningEffort', 'high')
    expect(actions.edit).toHaveBeenCalledWith('threadMaxTokens', '8192')
  })

  it('stages a reset under the field name the Host row declares, for every field it offers one on', () => {
    // One field at a time, so the single reset badge on screen is that field's:
    // each badge is a per-field control, and two of them answering the same
    // click would hide which field the page means to reset.
    for (const [name, text] of [
      ['checkIn', 'quiet'], ['spawn', 'auto'], ['mergePolicy', 'auto'],
      ['threadProvider', 'deepseek'], ['threadModel', 'deepseek-chat'],
      ['threadReasoningEffort', 'high'], ['threadMaxTokens', '8192'],
    ] as const) {
      const actions = renderCard({ [name]: field(text, { overridden: true }) })

      fireEvent.click(screen.getByRole('button', { name: en.reset }))

      expect(actions.resetField).toHaveBeenCalledWith(name)
      cleanup()
    }
  })

  it('says a half-written Thread model group blocks the save, and disables the save control', () => {
    const actions = renderCard({ dirty: true, invalid: true, partialThreadModel: true })

    expect(screen.getByRole('status').textContent).toBe(en.threadModelPartial)
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    expect(actions.save).not.toHaveBeenCalled()
  })

  it('says the deployment did not accept a save that failed', () => {
    renderCard({ dirty: true, failed: true })

    expect(screen.getByRole('status').textContent).toBe(en.saveFailed)
  })

  it('says the plugin is not loaded while its namespace is unavailable, and disables every field while the document is read-only', () => {
    renderCard({ available: false })
    expect(screen.getByRole('status').textContent).toBe(en.unavailable)
    cleanup()

    renderCard({ writable: false })
    expect(screen.getAllByRole('status').map(node => node.textContent)).toContain(en.readOnly)
    for (const label of [en.checkIn, en.spawn, en.mergePolicy, en.threadProvider, en.threadModel, en.threadReasoningEffort, en.threadMaxTokens]) {
      expect(screen.getByLabelText(label)).toHaveProperty('disabled', true)
    }
  })

  it('saves the staged edits through the form the Plugins page renders', () => {
    const actions = renderCard({ dirty: true })

    fireEvent.click(screen.getByRole('button', { name: en.save }))

    expect(actions.save).toHaveBeenCalledOnce()
  })
})
