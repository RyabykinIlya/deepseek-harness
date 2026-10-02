/**
 * Plugin registration suite: the `threads` key is installed through
 * `ctx.inject(['sessionProjections'], …)`, so it must appear while both this
 * plugin and the registry are loaded, and read as capability absence — not
 * corruption — when either is missing.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { ThreadsService } from '../src/index.ts'
import { ThreadId } from '../src/types.ts'

const ALPHA = ThreadId('thread-a')

async function withRegistry(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  return ctx
}

describe('ThreadsService registration', () => {
  it('installs the threads key and serves both host state and client rows', async () => {
    const ctx = await withRegistry()
    await ctx.plugin(ThreadsService)
    const session: Session = ctx.sessions.create()
    session.append('thread/created', { threadId: ALPHA, label: 'port auth', branch: 'dsh/thread-a' })

    expect(ctx.threads.available).toBe(true)
    expect(ctx.threads.stateOf(session)).toEqual({
      threads: [{ threadId: ALPHA, label: 'port auth', branch: 'dsh/thread-a' }],
    })
    expect(ctx.threads.viewOf(session)).toEqual([
      { threadId: ALPHA, label: 'port auth', branch: 'dsh/thread-a' },
    ])
  })

  it('reads as capability absence, not corruption, without the registry', async () => {
    const bare = new Context()
    await bare.plugin(SessionStore)
    await bare.plugin(ThreadsService)
    const session: Session = bare.sessions.create()
    session.append('thread/created', { threadId: ALPHA, label: 'port auth' })

    expect(bare.threads.available).toBe(false)
    expect(bare.threads.stateOf(session)).toBeUndefined()
    expect(bare.threads.viewOf(session)).toEqual([])
  })

  it('leaves a registry without this plugin free of the threads key', async () => {
    const ctx = await withRegistry()
    const session: Session = ctx.sessions.create()
    session.append('thread/created', { threadId: ALPHA, label: 'port auth' })
    // No unit registered: no checkpoint row is produced for it.
    expect(ctx.sessionProjections.restoreFloor({})).toBeUndefined()
    expect(ctx.sessionProjections.snapshot(session, ['threads']).values.threads).toBeUndefined()
  })
})
