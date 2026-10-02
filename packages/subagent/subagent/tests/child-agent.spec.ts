import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SESSION_FORMAT_VERSION, type SessionHeader } from '@deepseek-ai/dsh-session'
import { resolveChildAgentOptions, childSessionMeta } from '../src/child-agent.ts'

function parentAgent(): Agent {
  const id = SessionId('parent')
  return {
    id,
    options: {
      provider: 'parent-provider',
      model: 'parent-model',
      reasoningEffort: ReasoningEffortId('high'),
      maxTokens: 512,
    },
    session: Session.create(id),
  } as Agent
}

describe('child Agent options', () => {
  it('inherits the parent effort while the exact route is unchanged', () => {
    expect(resolveChildAgentOptions(parentAgent(), undefined, 1)).toEqual({
      provider: 'parent-provider',
      model: 'parent-model',
      reasoningEffort: 'high',
      maxTokens: 512,
      subagentDepth: 1,
    })
  })

  it('clears an inherited effort when the child route changes', () => {
    expect(resolveChildAgentOptions(parentAgent(), { model: 'child-model' }, 1)).toEqual({
      provider: 'parent-provider',
      model: 'child-model',
      maxTokens: 512,
      subagentDepth: 1,
    })
  })

  it('keeps an explicit child effort when the child route changes', () => {
    expect(resolveChildAgentOptions(parentAgent(), {
      provider: 'child-provider',
      model: 'child-model',
      reasoningEffort: ReasoningEffortId('max'),
    }, 1)).toEqual({
      provider: 'child-provider',
      model: 'child-model',
      reasoningEffort: 'max',
      maxTokens: 512,
      subagentDepth: 1,
    })
  })

  it('inherits the latest logged request selection over creation-time values', () => {
    const parent = parentAgent()
    parent.session.append('request/header', {
      header: {
        config: {
          provider: 'current-provider',
          model: 'current-model',
          reasoningEffort: ReasoningEffortId('low'),
        },
      },
      reason: 'initial',
    })

    expect(resolveChildAgentOptions(parent, undefined, 1)).toEqual({
      provider: 'current-provider',
      model: 'current-model',
      reasoningEffort: 'low',
      maxTokens: 512,
      subagentDepth: 1,
    })
  })
})

describe('child Session cwd', () => {
  /** A parent Agent whose Session header carries the given cwd. */
  function parentWithCwd(cwd: string | undefined): Agent {
    const id = SessionId('parent')
    const header: SessionHeader = {
      version: SESSION_FORMAT_VERSION,
      id,
      createdAt: 0,
      ...cwd === undefined ? {} : { cwd },
      isSeeded: false,
    }
    const session = Session.create(id, undefined, header)
    return {
      id,
      options: { provider: 'p', model: 'm', reasoningEffort: ReasoningEffortId('high'), maxTokens: 512 },
      session,
      ctx: new Context(),
    } as Agent
  }

  it('inherits the parent cwd when the provider supplies no override', () => {
    expect(childSessionMeta(parentWithCwd('/repo/src'), 1, false)).toMatchObject({ cwd: '/repo/src' })
  })

  it('honors a provider cwd override so the child is isolated from the parent', () => {
    expect(childSessionMeta(parentWithCwd('/repo/src'), 1, false, { cwd: '/worktrees/t-1' })).toMatchObject({
      cwd: '/worktrees/t-1',
    })
  })

  it('omits cwd entirely when neither the parent nor the provider supplies one', () => {
    const meta = childSessionMeta(parentWithCwd(undefined), 1, false)
    expect(meta).not.toHaveProperty('cwd')
  })

  it('keeps lineage, depth, and the subagent origin beside an override', () => {
    const parent = parentWithCwd('/repo/src')
    expect(childSessionMeta(parent, 2, false, { cwd: '/worktrees/t-1' })).toMatchObject({
      cwd: '/worktrees/t-1',
      parentSession: parent.session.header.id,
      isSeeded: false,
      origin: 'subagent',
      delegationDepth: 2,
    })
  })
})
