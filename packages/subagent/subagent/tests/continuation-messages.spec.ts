import { describe, expect, it } from 'vitest'
import { ToolCallId, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createSettlementMessage, withContinuableReturnGuidance } from '../src/continuation-messages.ts'

const childId = SessionId('settled-child')
const summary = { type: 'text', text: `Background subagent ${childId} finished and will do no further work unless you send it more.` }
const reasoning: ContentBlock = { type: 'reasoning', text: 'private child reasoning' }
const toolCall: ContentBlock = { type: 'tool-call', id: ToolCallId('child-call'), name: 'read', arguments: '{}' }

describe('continuable settlement content', () => {
  it.each([
    ['reasoning before the answer', [reasoning, { type: 'text', text: 'answer' }]],
    ['a tool call after the answer', [{ type: 'text', text: 'answer' }, toolCall]],
  ] satisfies [string, ContentBlock[]][])('reports only the closing text with %s', (_label, output) => {
    const original = structuredClone(output)
    const message = createSettlementMessage(childId, { stopReason: 'completed', output })

    expect(message.role).toBe('user')
    expect(message.content).toEqual([
      summary,
      { type: 'text', text: 'Its closing message:' },
      { type: 'text', text: 'answer' },
    ])
    expect(output).toEqual(original)
  })

  it.each([
    ['absent output', undefined],
    ['empty output', []],
    ['reasoning-only output', [reasoning]],
    ['empty text', [{ type: 'text', text: '' }]],
  ] satisfies [string, ContentBlock[] | undefined][])('reports no closing message for %s', (_label, output) => {
    const message = createSettlementMessage(childId, { stopReason: 'completed', ...output === undefined ? {} : { output } })

    expect(message.content).toEqual([
      summary,
      { type: 'text', text: 'It left no closing message.' },
    ])
  })

  it('preserves text block order and bytes around omitted reasoning and tool calls', () => {
    const first: ContentBlock = { type: 'text', text: '  first\n' }
    const second: ContentBlock = { type: 'text', text: '\n第二段  ' }
    const message = createSettlementMessage(childId, {
      stopReason: 'completed',
      output: [reasoning, first, toolCall, second],
    })

    expect(message.content).toEqual([
      summary,
      { type: 'text', text: 'Its closing message:' },
      first,
      second,
    ])
  })
})

describe('continuable return guidance', () => {
  const parentId = SessionId('parent-1')
  const task: ContentBlock[] = [{ type: 'text', text: 'task' }]

  it('keeps the shared-workspace text for a child in the parent cwd', () => {
    expect(withContinuableReturnGuidance(parentId, task)).toEqual([
      task[0],
      {
        type: 'text',
        text: 'Your parent agent id is "parent-1". Before you finish, send your result to that agent with '
          + 'send_message({ agent_id: "parent-1", message: "<self-contained result>" }). The parent shares '
          + 'your workspace but does not automatically receive your transcript, tool output, or reasoning. Send '
          + 'earlier messages as well when a finding changes what the parent should do next; sending a message '
          + 'does not end your turn.',
      },
    ])
  })

  it('states the separate checkout and the self-contained result for an isolated child', () => {
    expect(withContinuableReturnGuidance(parentId, task, '/work/tree')).toEqual([
      task[0],
      {
        type: 'text',
        text: 'Your parent agent id is "parent-1". Before you finish, send your result to that agent with '
          + 'send_message({ agent_id: "parent-1", message: "<self-contained result>" }). You work in your own '
          + 'separate checkout at "/work/tree". The parent does not see files you change there until it '
          + 'inspects that checkout, and it does not automatically receive your transcript, tool output, or '
          + 'reasoning. State in the message what changed, where, and how you verified it. Send earlier '
          + 'messages as well when a finding changes what the parent should do next; sending a message does '
          + 'not end your turn.',
      },
    ])
  })
})
