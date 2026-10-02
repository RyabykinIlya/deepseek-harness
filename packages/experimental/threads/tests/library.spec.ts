/**
 * Library read model suite: `threads.library` over real Project and Thread
 * Sessions, a real git repository with a real worktree service, and a fake
 * persistence for archived Thread sessions.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type { WorkspaceChangesSummary } from '@deepseek-ai/dsh-workspace-changes/types'
import WorktreeService from '@deepseek-ai/dsh-worktree-manager'
import type { WorktreeRecord } from '@deepseek-ai/dsh-worktree-manager'
import { ThreadId, ThreadsService } from '../src/index.ts'
import type { Config } from '../src/index.ts'

const temporaries: string[] = []
afterEach(() => {
  for (const dir of temporaries.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function temporary(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  temporaries.push(dir)
  return dir
}

function git(args: readonly string[], cwd: string): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim()
}

function repository(): string {
  const dir = temporary('dsh-threads-lib-')
  git(['init', '--quiet', '--initial-branch=main', dir], dir)
  git(['config', 'user.email', 't@example.test'], dir)
  git(['config', 'user.name', 'T'], dir)
  writeFileSync(join(dir, 'README.md'), 'seed\n')
  git(['add', '.'], dir)
  git(['commit', '--quiet', '-m', 'seed'], dir)
  return dir
}

const DEFAULTS: Config = {
  providerName: 'thread',
  noteMaxBytes: 600,
  archiveStopTimeoutMs: 30_000,
  projectPresets: ['project'],
  libraryMaxAttachments: 200,
  libraryMaxPresented: 200,
  libraryMaxThreads: 50,
  libraryMaxFiles: 100,
}

async function mount(config: Partial<Config> = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(ThreadsService, { ...DEFAULTS, ...config })
  return ctx
}

function project(ctx: Context, id = 'project', agentPreset: string | null = 'project'): Session {
  return ctx.sessions.create(SessionId(id), { meta: agentPreset === null ? {} : { agentPreset } })
}

function say(session: Session, content: Parameters<typeof createUserMessage>[0]['content']): void {
  session.append('user/message', createUserMessage({ content, source: { kind: 'user' } }), { surfaceOp: 'append' })
}

function present(session: Session, files: Array<{ path: string; description?: string }>): void {
  session.append('deliverables/presented', { turn: 1, callId: 'call-1' as ToolCallId, files })
}

const ALPHA = ThreadId('alpha')
const BETA = ThreadId('beta')

function created(session: Session, threadId: ThreadId, label: string, branch?: string): void {
  session.append('thread/created', { threadId, label, ...branch === undefined ? {} : { branch } }, { ignorable: true })
}

/** Fake persistence serving the given stored logs by id. */
function persistence(stored: Record<string, { session: Session }>): never {
  return {
    stat: (id: SessionId) => Promise.resolve(stored[id] === undefined ? undefined : { header: stored[id].session.header }),
    open: (id: SessionId) => Promise.resolve({
      header: stored[id]!.session.header,
      read: () => Promise.resolve({ events: stored[id]!.session.snapshotEvents() }),
      close: () => Promise.resolve(),
    }),
  } as never
}

describe('threads.library', () => {
  it('lists attachments of the Project chat, newest first, ignoring other events and text', async () => {
    const ctx = await mount()
    const p = project(ctx)
    p.append('turn/start', { turn: 1 })
    say(p, [
      { type: 'text', text: 'see' },
      { type: 'image', attachment: { attachmentId: 'sha256:a' as AttachmentId, mediaType: 'image/png', bytes: 10, width: 1, height: 1, name: 'shot.png' } },
      { type: 'image', attachment: { attachmentId: 'sha256:b' as AttachmentId, mediaType: 'image/gif', bytes: 11, width: 1, height: 1 } },
    ])
    say(p, [{ type: 'file', attachment: { attachmentId: 'sha256:c' as AttachmentId, name: 'spec.pdf', bytes: 99 } }])
    const { attachments } = await ctx.threads.library({ projectId: p.id })
    expect(attachments.total).toBe(3)
    expect(attachments.truncated).toBe(false)
    expect(attachments.items.map(item => [item.kind, item.attachmentId, item.name, item.mediaType, item.bytes])).toEqual([
      ['file', 'sha256:c', 'spec.pdf', undefined, 99],
      ['image', 'sha256:b', undefined, 'image/gif', 11],
      ['image', 'sha256:a', 'shot.png', 'image/png', 10],
    ])
    expect(typeof attachments.items[0]?.seq).toBe('number')
    expect(typeof attachments.items[0]?.time).toBe('number')
  })

  it('attributes each presented file to the Session that declared it, with threadId set only for a Thread-presented file', async () => {
    const ctx = await mount()
    const p = project(ctx)
    created(p, ALPHA, 'port auth')
    present(p, [{ path: '/out/report.docx', description: 'the report' }])
    const t = ctx.sessions.create(SessionId(ALPHA), { meta: { parentSession: p.id } })
    present(t, [{ path: 'notes.md' }, { path: '/wt/b.txt' }])
    const { presented, attachments, changes } = await ctx.threads.library({ projectId: p.id })
    expect(attachments.items).toEqual([])
    expect(changes).toEqual({ items: [], total: 1, truncated: false })
    expect(presented.total).toBe(3)
    const byPath = Object.fromEntries(presented.items.map(item => [item.path, item]))
    expect(byPath['/out/report.docx']).toMatchObject({ sessionId: p.id, description: 'the report', index: 0 })
    expect(byPath['/out/report.docx']).not.toHaveProperty('threadId')
    expect(byPath['notes.md']).toMatchObject({ sessionId: ALPHA, threadId: ALPHA, index: 0 })
    expect(byPath['notes.md']).not.toHaveProperty('description')
    expect(byPath['/wt/b.txt']).toMatchObject({ threadId: ALPHA, index: 1 })
    const times = presented.items.map(item => item.time)
    expect(times).toEqual([...times].sort((a, b) => b - a))
  })

  it('reads a live Thread worktree with commits and uncommitted work from real git', async () => {
    const repo = repository()
    const ctx = await mount()
    await ctx.plugin(WorktreeService, { pruneOnStart: false, worktreeRoot: temporary('dsh-threads-lib-root-') })
    const record = await ctx.worktrees.create({ repoRoot: repo, threadId: 'alpha', baseRef: 'HEAD' }, new AbortController().signal)
    writeFileSync(join(record.path, 'a.txt'), 'one\ntwo\n')
    writeFileSync(join(record.path, 'b.bin'), Buffer.from([0, 1, 2, 0]))
    git(['add', '.'], record.path)
    git(['-c', 'user.email=t@example.test', '-c', 'user.name=T', 'commit', '--quiet', '-m', 'work'], record.path)
    writeFileSync(join(record.path, 'dirty.txt'), 'x')
    const p = project(ctx)
    created(p, ALPHA, 'port auth', record.branch)
    const { changes } = await ctx.threads.library({ projectId: p.id })
    const [entry] = changes.items
    expect(entry).toMatchObject({
      threadId: ALPHA, label: 'port auth', source: 'live', branch: record.branch, worktree: record.path,
      filesTotal: 2, commitsTotal: 1, uncommitted: 1,
    })
    expect(entry?.files).toEqual(expect.arrayContaining([
      { path: 'a.txt', added: 2, removed: 0 },
      { path: 'b.bin', binary: true },
    ]))
  }, 30_000)

  it('omits a Thread whose worktree is gone, removed, or never created', async () => {
    const repo = repository()
    const ctx = await mount()
    await ctx.plugin(WorktreeService, { pruneOnStart: false, worktreeRoot: temporary('dsh-threads-lib-root-') })
    const signal = new AbortController().signal
    const vanished = await ctx.worktrees.create({ repoRoot: repo, threadId: 'alpha', baseRef: 'HEAD' }, signal)
    const removed = await ctx.worktrees.create({ repoRoot: repo, threadId: 'beta', baseRef: 'HEAD' }, signal)
    await ctx.worktrees.remove(removed, { force: true })
    rmSync(vanished.path, { recursive: true, force: true })
    const p = project(ctx)
    created(p, ALPHA, 'a')
    created(p, BETA, 'b')
    created(p, ThreadId('gamma'), 'c')
    const { changes } = await ctx.threads.library({ projectId: p.id })
    expect(changes).toEqual({ items: [], total: 3, truncated: false })
  }, 30_000)

  it('omits live Threads when the worktree service is not loaded', async () => {
    const ctx = await mount()
    const p = project(ctx)
    created(p, ALPHA, 'a')
    expect((await ctx.threads.library({ projectId: p.id })).changes.items).toEqual([])
  })

  it('maps worktree entries without branch or counts', async () => {
    const ctx = await mount()
    const record: WorktreeRecord = { threadId: 'alpha', path: '/wt/alpha', baseRef: 'HEAD', state: 'ready', repoRoot: '/repo' }
    ctx.provide('worktrees', {
      get: () => Promise.resolve(record),
      changes: () => Promise.resolve({
        baseSha: 'a', headSha: 'b', commits: [], commitsTotal: 0, filesTotal: 1, uncommitted: 0,
        files: [{ path: 'x', binary: true }],
      }),
    } as never)
    const p = project(ctx)
    created(p, ALPHA, 'a')
    const [entry] = (await ctx.threads.library({ projectId: p.id })).changes.items
    expect(entry).toEqual({
      threadId: ALPHA, label: 'a', source: 'live', worktree: '/wt/alpha',
      files: [{ path: 'x', binary: true }], filesTotal: 1, commitsTotal: 0, uncommitted: 0,
    })
  })

  describe('archived Threads', () => {
    const summary: WorkspaceChangesSummary = {
      turn: 1, cwd: '/wt', total: 3, added: 5, deleted: 1,
      files: [
        { path: 'a.ts', display: 'a.ts', added: 4, deleted: 1 },
        { path: 'img.png', display: 'img.png', added: 0, deleted: 0, binary: true },
      ],
    }

    async function archived(options: { workspaceChanges?: boolean; withChangesEvent?: boolean; stored?: boolean; branch?: string }) {
      const ctx = await mount({ libraryMaxFiles: 1 })
      if (options.workspaceChanges !== false) {
        ctx.provide('workspaceChanges', { summary: (id: SessionId, seq: number) => id === SessionId(ALPHA) && seq === 1 ? summary : undefined, diff: () => Promise.resolve(undefined) })
      }
      const p = project(ctx)
      created(p, ALPHA, 'port auth', options.branch)
      p.append('thread/removed', { threadId: ALPHA }, { ignorable: true })
      const other = await mount()
      const t = other.sessions.create(SessionId(ALPHA))
      present(t, [{ path: '/out/x.txt' }])
      if (options.withChangesEvent !== false) t.append('workspace/changes', { turn: 1 })
      if (options.stored !== false) ctx.provide('sessionPersistence', persistence({ [ALPHA]: { session: t } }))
      return { ctx, p }
    }

    it('serves the last recorded summary and presented files of a persisted Thread session', async () => {
      const { ctx, p } = await archived({ branch: 'dsh/alpha' })
      const result = await ctx.threads.library({ projectId: p.id })
      expect(result.changes.items).toEqual([{
        threadId: ALPHA, label: 'port auth', source: 'archived', branch: 'dsh/alpha',
        files: [{ path: 'a.ts', added: 4, removed: 1 }], filesTotal: 3,
      }])
      expect(result.presented.items.map(item => item.path)).toEqual(['/out/x.txt'])
    })

    it('renders binary summary files without counts and no branch when none was recorded', async () => {
      const ctx = await mount({})
      ctx.provide('workspaceChanges', { summary: () => ({ ...summary, files: [summary.files[1]!] }), diff: () => Promise.resolve(undefined) })
      const p = project(ctx)
      created(p, ALPHA, 'a')
      p.append('thread/removed', { threadId: ALPHA }, { ignorable: true })
      const t = (await mount()).sessions.create(SessionId(ALPHA))
      t.append('workspace/changes', { turn: 1 })
      ctx.provide('sessionPersistence', persistence({ [ALPHA]: { session: t } }))
      const [entry] = (await ctx.threads.library({ projectId: p.id })).changes.items
      expect(entry?.files).toEqual([{ path: 'img.png', binary: true }])
      expect(entry).not.toHaveProperty('branch')
    })

    it('omits the Thread when its session is not stored, has no change event, or the summary is gone', async () => {
      for (const options of [{ stored: false }, { withChangesEvent: false }, { workspaceChanges: false }]) {
        const { ctx, p } = await archived(options)
        expect((await ctx.threads.library({ projectId: p.id })).changes.items).toEqual([])
      }
    })

    it('treats a persistence that lacks the session as having no Thread log', async () => {
      const ctx = await mount()
      ctx.provide('sessionPersistence', persistence({}))
      const p = project(ctx)
      created(p, ALPHA, 'a')
      p.append('thread/removed', { threadId: ALPHA }, { ignorable: true })
      expect((await ctx.threads.library({ projectId: p.id })).presented.items).toEqual([])
    })
  })

  it('bounds every list and reports complete totals', async () => {
    const ctx = await mount({ libraryMaxAttachments: 1, libraryMaxPresented: 2, libraryMaxThreads: 1 })
    const p = project(ctx)
    for (const id of ['a', 'b']) {
      say(p, [{ type: 'file', attachment: { attachmentId: `sha256:${id}` as AttachmentId, name: `${id}.txt`, bytes: 1 } }])
    }
    created(p, ALPHA, 'old')
    created(p, BETA, 'new')
    present(p, [{ path: '1' }, { path: '2' }, { path: '3' }])
    const result = await ctx.threads.library({ projectId: p.id })
    expect(result.attachments).toMatchObject({ total: 2, truncated: true })
    expect(result.attachments.items.map(item => item.name)).toEqual(['b.txt'])
    expect(result.presented).toMatchObject({ total: 3, truncated: true })
    expect(result.presented.items).toHaveLength(2)
    expect(result.changes).toMatchObject({ total: 2, truncated: true })
  })

  it('reads a re-announced Thread once and ignores removal of an unknown Thread', async () => {
    const ctx = await mount()
    const p = project(ctx)
    created(p, ALPHA, 'first')
    created(p, ALPHA, 'renamed')
    p.append('thread/removed', { threadId: BETA }, { ignorable: true })
    expect((await ctx.threads.library({ projectId: p.id })).changes.total).toBe(1)
  })

  it('refuses an unknown session and a session that is not a Project', async () => {
    const ctx = await mount()
    project(ctx, 'plain', null)
    project(ctx, 'worker', 'worker')
    const unknown = await ctx.threads.library({ projectId: SessionId('nope') }).catch((error: unknown) => error)
    expect(remoteErrorOf(unknown)).toMatchObject({ code: 'threads/project-not-found', details: { projectId: 'nope', reason: 'unknown' } })
    for (const id of ['plain', 'worker']) {
      const refused = await ctx.threads.library({ projectId: SessionId(id) }).catch((error: unknown) => error)
      expect(remoteErrorOf(refused)).toMatchObject({ code: 'threads/project-not-found', details: { reason: 'not-project' } })
    }
  })

  it('reads a persisted Project when it is not live and honours configured Project presets', async () => {
    const source = await mount()
    const stored = project(source, 'stored', 'lead')
    say(stored, [{ type: 'file', attachment: { attachmentId: 'sha256:z' as AttachmentId, name: 'z.txt', bytes: 3 } }])
    const ctx = await mount({ projectPresets: ['lead'] })
    ctx.provide('sessionPersistence', persistence({ stored: { session: stored } }))
    const { attachments } = await ctx.threads.library({ projectId: SessionId('stored') })
    expect(attachments.items.map(item => item.name)).toEqual(['z.txt'])
  })

  it('declares validated bounds', () => {
    expect(() => ThreadsService.Config({ ...DEFAULTS, libraryMaxFiles: -1 })).toThrow()
    expect(ThreadsService.Config({ ...DEFAULTS })).toMatchObject({
      projectPresets: ['project'], libraryMaxAttachments: 200, libraryMaxPresented: 200, libraryMaxThreads: 50, libraryMaxFiles: 100,
    })
  })
})
