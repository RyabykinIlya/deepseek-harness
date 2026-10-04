/**
 * `library_list` suite.
 *
 * The executor-level cases run the real `threads.library` read model over real
 * Project/Thread Sessions and a fake worktree service, through a hand-built
 * calling Agent (the tool only ever reads `exec.agent.session`). The pure-render
 * cases hand `toLibraryListResult`/`renderLibrary`/`fitLibrary` crafted shapes
 * directly, to pin every branch a real call would rarely combine in one Project.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ThreadId, ThreadsService } from '@deepseek-ai/dsh-experimental-threads'
import type { WorktreeRecord } from '@deepseek-ai/dsh-worktree-manager'
import * as tool from '../src/index.ts'
import {
  fitLibrary, renderLibrary, toAttachmentEntry, toChangesEntry, toLibraryListResult, toPresentedEntry,
} from '../src/library.ts'
import type { LibraryChangesEntry, LibraryListResult, LibrarySectionResult } from '../src/library.ts'

const bytes = (value: string): number => Buffer.byteLength(value, 'utf8')

const contexts = new Set<Context>()

afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts) await ctx.fiber.dispose()
  contexts.clear()
})

/** Mount the tool with the Threads domain and no worktree service unless the caller provides one. */
async function mount(config?: tool.Config): Promise<Context> {
  const ctx = new Context()
  contexts.add(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(ThreadsService)
  await ctx.plugin(tool, config)
  return ctx
}

/** Mount without the Threads domain plugin, to exercise the "not loaded" error. */
async function mountWithoutThreads(config?: tool.Config): Promise<Context> {
  const ctx = new Context()
  contexts.add(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(tool, config)
  return ctx
}

/** Create a Project Session directly (no AgentLoop needed: the tool only reads `exec.agent.session`). */
function project(ctx: Context, id = 'project'): Session {
  return ctx.sessions.create(SessionId(id), { meta: { agentPreset: 'project' } })
}

/** A minimal Agent wrapping a Session, enough to drive `ctx.tools.execute`. */
function agentFor(ctx: Context, session: Session): Agent {
  return {
    id: session.id, session, ctx: ctx.extend(), options: {}, status: 'idle', inbox: unsupportedInbox(),
    send() {}, followup() {}, steer() {}, inject() {}, cancel() {},
    whenIdle: async () => {}, runMaintenance: operation => operation(new AbortController().signal),
  }
}

function createdThread(session: Session, id: string, label: string, branch?: string): void {
  session.append('thread/created', { threadId: ThreadId(id), label, ...branch === undefined ? {} : { branch } }, { ignorable: true })
}

function say(session: Session, content: Parameters<typeof createUserMessage>[0]['content']): void {
  session.append('user/message', createUserMessage({ content, source: { kind: 'user' } }), { surfaceOp: 'append' })
}

function presentFiles(session: Session, files: Array<{ path: string; description?: string }>): void {
  session.append('deliverables/presented', { turn: 1, callId: ToolCallId('call-1'), files })
}

/** Provide a fake `worktrees` service answering one live Thread. */
function fakeWorktrees(ctx: Context, threadId: string, extra: Partial<WorktreeRecord> = {}): void {
  const record: WorktreeRecord = {
    threadId, path: `/wt/${threadId}`, branch: `dsh/${threadId}`, baseRef: 'main', baseSha: 'b'.repeat(40),
    state: 'ready', repoRoot: '/repo', ...extra,
  }
  ctx.provide('worktrees', {
    get: () => Promise.resolve(record),
    changes: () => Promise.resolve({
      baseSha: 'b'.repeat(40), headSha: 'h'.repeat(40), commits: [], commitsTotal: 2, uncommitted: 1,
      files: [{ path: 'src/a.ts', added: 3, removed: 1 }, { path: 'img.png', binary: true }], filesTotal: 2,
    }),
  } as never)
}

let callNumber = 0

/** Execute `library_list` as the given calling agent. */
function callTool(ctx: Context, agent: Agent | undefined, args: unknown = {}) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`library-call-${++callNumber}`),
    name: 'library_list',
    arguments: args,
    ...agent === undefined ? {} : { agent },
  })
}

/** The model's rendered text for one tool result. */
function text(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

describe('library_list tool', () => {
  it('registers with its optional section and limit parameters', async () => {
    const ctx = await mount()
    const schema = ctx.tools.schemas().find(candidate => candidate.name === 'library_list')!
    const params = schema.parameters as { required?: string[]; properties?: Record<string, { enum?: string[]; description?: string }> }
    expect(Object.keys(params.properties ?? {})).toEqual(['section', 'limit'])
    expect(params.properties?.section?.enum).toEqual(['attachments', 'presented', 'changes'])
    expect(params.properties?.limit?.description).toContain('1 through 100')
    expect(params.required ?? []).toEqual([])
    expect(schema.description).toContain('thread_status')
    expect(schema.description).toContain('thread_diff')
  })

  it('requires a calling agent', async () => {
    const ctx = await mount()
    const result = await callTool(ctx, undefined)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('library_list requires a calling agent')
  })

  it('fails loudly when the Threads domain is not loaded', async () => {
    const ctx = await mountWithoutThreads()
    const p = project(ctx)
    const result = await callTool(ctx, agentFor(ctx, p))
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('@deepseek-ai/dsh-experimental-threads is not loaded')
  })

  it('rejects an out-of-range or non-integer limit', async () => {
    const ctx = await mount()
    const p = project(ctx)
    const agent = agentFor(ctx, p)
    // The tool's own guard owns the integer range; the runtime's argument check
    // rejects a non-integer first, so that case never reaches the tool.
    for (const limit of [0, 101]) {
      const result = await callTool(ctx, agent, { limit })
      expect(result.isError, String(limit)).toBe(true)
      expect(text(result), String(limit)).toContain('limit must be an integer from 1 through 100')
    }
    const fractional = await callTool(ctx, agent, { limit: 2.5 })
    expect(fractional.isError).toBe(true)
    expect(text(fractional)).toContain('limit')
  })

  it('lists attachments, presented files, and live Thread changes for the caller only', async () => {
    const ctx = await mount()
    const p = project(ctx)
    const other = ctx.sessions.create(SessionId('other-project'), { meta: { agentPreset: 'project' } })
    fakeWorktrees(ctx, 'thread-a')
    createdThread(p, 'thread-a', 'port auth', 'dsh/thread-a')
    presentFiles(p, [{ path: '/out/report.docx', description: 'the report' }])
    say(p, [{ type: 'file', attachment: { attachmentId: 'sha256:a' as AttachmentId, name: 'spec.pdf', bytes: 99 } }])
    createdThread(other, 'thread-foreign', 'someone else')
    presentFiles(other, [{ path: '/out/other.txt' }])

    const result = await callTool(ctx, agentFor(ctx, p))

    expect(result.isError).toBe(false)
    const out = text(result)
    expect(out).toContain('attachments (1):')
    expect(out).toContain('sha256:a [file] | spec.pdf | 99 bytes')
    expect(out).toContain('presented (1):')
    expect(out).toContain('/out/report.docx | the report | presented by the Project')
    expect(out).toContain('changes (1):')
    expect(out).toContain('thread-a [live] port auth | branch dsh/thread-a | 2 commits, 1 uncommitted')
    expect(out).toContain('2 files changed: src/a.ts, img.png')
    expect(out).not.toContain('other.txt')
    expect(out).not.toContain('someone else')
  })

  it('filters to one section when asked and omits the other two', async () => {
    const ctx = await mount()
    const p = project(ctx)
    createdThread(p, 'thread-a', 'a')
    presentFiles(p, [{ path: 'notes.md' }])
    say(p, [{ type: 'file', attachment: { attachmentId: 'sha256:a' as AttachmentId, name: 'a.txt', bytes: 1 } }])

    const result = await callTool(ctx, agentFor(ctx, p), { section: 'presented' })

    const out = text(result)
    expect(out).toMatch(/^presented \(1\):\nnotes\.md \| presented by the Project \| \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  it('reports an explicit empty Library', async () => {
    const ctx = await mount()
    const p = project(ctx)
    const out = text(await callTool(ctx, agentFor(ctx, p)))
    expect(out).toBe('attachments (0):\n(no attachments)\n\npresented (0):\n(no presented files)\n\nchanges (0):\n(no Threads with changes)')
  })

  it('says how many were omitted once the row limit cuts a section', async () => {
    const ctx = await mount()
    const p = project(ctx)
    for (let index = 0; index < 5; index += 1) say(p, [{ type: 'file', attachment: { attachmentId: `sha256:${index}` as AttachmentId, name: `file-${index}.txt`, bytes: 1 } }])

    const out = text(await callTool(ctx, agentFor(ctx, p), { limit: 2, section: 'attachments' }))

    expect(out).toContain('attachments (5):')
    expect(out).toContain('(3 of 5 attachments omitted; raise limit or request this section alone)')
  })

  it('honours configured page sizes and clamps direct-apply values', async () => {
    const ctx = await mount({ libraryDefaultLimit: 2 })
    const p = project(ctx)
    for (let index = 0; index < 5; index += 1) say(p, [{ type: 'file', attachment: { attachmentId: `sha256:${index}` as AttachmentId, name: `file-${index}.txt`, bytes: 1 } }])

    const out = text(await callTool(ctx, agentFor(ctx, p), { section: 'attachments' }))
    expect(out).toContain('(3 of 5 attachments omitted')

    const direct = new Context()
    contexts.add(direct)
    await direct.plugin(SessionStore)
    await direct.plugin(SessionProjectionRegistry)
    await direct.plugin(AgentRegistry)
    await direct.plugin(SystemPrompt, {})
    await direct.plugin(ToolRuntime)
    await direct.plugin(ThreadsService)
    const fiber = await direct.plugin(tool)
    await fiber.dispose()
    // A direct apply() bypasses Schemastery's own z.natural().max(100) clamp, so this proves resolveBounds's
    // own clamp() still caps the ceiling instead of leaking the raw out-of-range configured values.
    tool.apply(direct, { libraryDefaultLimit: 250, libraryMaxLimit: 500 })
    const schema = direct.tools.schemas().find(candidate => candidate.name === 'library_list')
    expect((schema?.parameters as { properties?: { limit?: { description?: string } } })
      .properties?.limit?.description).toContain('Defaults to 100')
  })

  it('bounds the complete text in bytes when many entries are seeded', async () => {
    const ctx = await mount({ maxResultBytes: 1024 })
    const p = project(ctx)
    for (let index = 0; index < 60; index += 1) {
      say(p, [{ type: 'file', attachment: { attachmentId: `sha256:${index}`.padEnd(40, '0') as AttachmentId, name: `file-${index}.bin`, bytes: index } }])
    }

    const out = text(await callTool(ctx, agentFor(ctx, p), { limit: 60 }))

    expect(bytes(out)).toBeLessThanOrEqual(1024)
    expect(out).toMatch(/\(\d+ of 60 attachments omitted; raise limit or request this section alone\)/)
  })
})

describe('library.ts projectors', () => {
  it('bounds an attachment name and keeps media type only for recorded cases', () => {
    const withName = toAttachmentEntry({
      kind: 'file', attachmentId: 'sha256:a', name: 'spec file '.repeat(40), bytes: 10, seq: 1, time: 1700000000000,
    })
    expect(withName.name?.endsWith('…')).toBe(true)
    expect(withName).not.toHaveProperty('mediaType')

    const withMediaType = toAttachmentEntry({
      kind: 'image', attachmentId: 'sha256:b', mediaType: 'image/png', bytes: 20, seq: 2, time: 1700000000000,
    })
    expect(withMediaType).not.toHaveProperty('name')
    expect(withMediaType.mediaType).toBe('image/png')
  })

  it('bounds a presented-file path/description and keeps threadId only when a Thread presented it', () => {
    const fromProject = toPresentedEntry({
      path: '/out/report.docx', description: 'd'.repeat(300), sessionId: SessionId('p'), seq: 0, index: 0, time: 1,
    })
    expect(fromProject).not.toHaveProperty('threadId')
    expect(fromProject.description?.endsWith('…')).toBe(true)

    const fromThread = toPresentedEntry({
      path: 'notes.md', sessionId: SessionId('t'), threadId: ThreadId('thread-a'), seq: 0, index: 1, time: 2,
    })
    expect(fromThread).not.toHaveProperty('description')
    expect(fromThread.threadId).toBe('thread-a')
  })

  it('carries branch, worktree, and live counts only when the Library reported them', () => {
    const live: LibraryChangesEntry = toChangesEntry({
      threadId: ThreadId('thread-a'), label: 'l'.repeat(400), source: 'live', branch: 'dsh/thread-a', worktree: '/wt/a',
      files: [{ path: 'a.ts', added: 1, removed: 0 }, { path: 'b.bin', binary: true }, { path: 'c.ts' }],
      filesTotal: 3, commitsTotal: 2, uncommitted: 1,
    })
    expect(live.label.endsWith('…')).toBe(true)
    expect(live).toMatchObject({ branch: 'dsh/thread-a', worktree: '/wt/a', commitsTotal: 2, uncommitted: 1 })
    expect(live.files).toEqual([{ path: 'a.ts', added: 1, removed: 0 }, { path: 'b.bin', binary: true }, { path: 'c.ts' }])

    const archived = toChangesEntry({
      threadId: ThreadId('thread-b'), label: 'archived', source: 'archived', files: [], filesTotal: 0,
    })
    expect(archived).not.toHaveProperty('branch')
    expect(archived).not.toHaveProperty('worktree')
    expect(archived).not.toHaveProperty('commitsTotal')
    expect(archived).not.toHaveProperty('uncommitted')
  })
})

describe('toLibraryListResult', () => {
  const library = {
    attachments: { items: [{ kind: 'file' as const, attachmentId: 'a', bytes: 1, seq: 0, time: 0 }], total: 1, truncated: false },
    presented: { items: [{ path: 'x', sessionId: SessionId('p'), seq: 0, index: 0, time: 0 }], total: 1, truncated: false },
    changes: {
      items: [{ threadId: ThreadId('t'), label: 'l', source: 'live' as const, files: [], filesTotal: 0 }],
      total: 1, truncated: false,
    },
  }

  it('includes all three sections when no section filter is given', () => {
    const result = toLibraryListResult(library, undefined, 10)
    expect(Object.keys(result)).toEqual(['attachments', 'presented', 'changes'])
  })

  it('includes only attachments when filtered to that section', () => {
    expect(Object.keys(toLibraryListResult(library, 'attachments', 10))).toEqual(['attachments'])
  })

  it('includes only presented when filtered to that section', () => {
    expect(Object.keys(toLibraryListResult(library, 'presented', 10))).toEqual(['presented'])
  })

  it('includes only changes when filtered to that section, and cuts to the row limit', () => {
    const bigger = { ...library, changes: { ...library.changes, items: [...library.changes.items, ...library.changes.items], total: 2 } }
    const result = toLibraryListResult(bigger, 'changes', 1)
    expect(Object.keys(result)).toEqual(['changes'])
    expect(result.changes).toEqual({ items: [expect.objectContaining({ threadId: 't' })], total: 2, truncated: true, omitted: 1 })
  })
})

describe('renderLibrary', () => {
  const attachmentsSection: LibrarySectionResult<ReturnType<typeof toAttachmentEntry>> = {
    items: [
      { kind: 'file', attachmentId: 'sha256:a', name: 'spec.pdf', bytes: 99, time: 1700000000000 },
      { kind: 'image', attachmentId: 'sha256:b', mediaType: 'image/png', bytes: 10, time: 1700000000000 },
    ],
    total: 2, truncated: false, omitted: 0,
  }

  it('renders one line per attachment, falling back to (unnamed)', () => {
    const value: LibraryListResult = { attachments: attachmentsSection }
    expect(renderLibrary(value, 4096)).toBe([
      'attachments (2):',
      'sha256:a [file] | spec.pdf | 99 bytes | 2023-11-14T22:13:20.000Z',
      'sha256:b [image] | (unnamed) | 10 bytes | 2023-11-14T22:13:20.000Z',
    ].join('\n'))
  })

  it('renders an omission footer when a section was cut', () => {
    const value: LibraryListResult = { attachments: { ...attachmentsSection, items: attachmentsSection.items.slice(0, 1), omitted: 1 } }
    expect(renderLibrary(value, 4096)).toBe([
      'attachments (2):',
      'sha256:a [file] | spec.pdf | 99 bytes | 2023-11-14T22:13:20.000Z',
      '(1 of 2 attachments omitted; raise limit or request this section alone)',
    ].join('\n'))
  })

  it('reports an empty section even when the total is nonzero but nothing was fetched', () => {
    const value: LibraryListResult = { presented: { items: [], total: 4, truncated: true, omitted: 4 } }
    expect(renderLibrary(value, 4096)).toBe([
      'presented (4):',
      '(4 of 4 presented files omitted; raise limit or request this section alone)',
    ].join('\n'))
  })

  it('renders presented files with and without a description or threadId', () => {
    const value: LibraryListResult = {
      presented: {
        items: [
          { path: '/out/report.docx', description: 'the report', sessionId: 'p', time: 5 },
          { path: 'notes.md', sessionId: 't', threadId: 't', time: 6 },
        ],
        total: 2, truncated: false, omitted: 0,
      },
    }
    expect(renderLibrary(value, 4096)).toBe([
      'presented (2):',
      `/out/report.docx | the report | presented by the Project | ${new Date(5).toISOString()}`,
      `notes.md | presented by thread t | ${new Date(6).toISOString()}`,
    ].join('\n'))
  })

  it('renders Thread changes with counts, an inline file list, and the "+N more" marker', () => {
    const value: LibraryListResult = {
      changes: {
        items: [
          {
            threadId: 't1', label: 'port auth', source: 'live', branch: 'dsh/t1', commitsTotal: 3, uncommitted: 2,
            filesTotal: 7,
            files: Array.from({ length: 7 }, (_, i) => ({ path: `f${i}.ts`, added: 1 })),
          },
          { threadId: 't2', label: 'write docs', source: 'archived', filesTotal: 0, files: [] },
          {
            threadId: 't3', label: 'tiny', source: 'live', filesTotal: 1, files: [{ path: 'a.ts', added: 1, removed: 0 }],
          },
        ],
        total: 3, truncated: false, omitted: 0,
      },
    }
    expect(renderLibrary(value, 4096)).toBe([
      'changes (3):',
      't1 [live] port auth | branch dsh/t1 | 3 commits, 2 uncommitted | 7 files changed: f0.ts, f1.ts, f2.ts, f3.ts, f4.ts (+2 more)',
      't2 [archived] write docs | no changed files',
      't3 [live] tiny | 1 file changed: a.ts',
    ].join('\n'))
  })

  it('renders nothing selected when every section is absent', () => {
    expect(renderLibrary({}, 4096)).toBe('(no section selected)')
  })

  it('cuts the complete text to the byte bound without splitting a code point', () => {
    const value: LibraryListResult = {
      attachments: {
        items: Array.from({ length: 20 }, (_, i) => ({ kind: 'file' as const, attachmentId: `多${i}`, bytes: i, time: 0 })),
        total: 20, truncated: false, omitted: 0,
      },
    }
    const whole = renderLibrary(value, Infinity)
    expect(bytes(renderLibrary(value, bytes(whole)))).toBe(bytes(whole))
    const out = renderLibrary(value, 64)
    expect(bytes(out)).toBeLessThanOrEqual(64)
    expect(out).not.toContain('�')
  })
})

describe('fitLibrary', () => {
  const attachments = (n: number): LibrarySectionResult<ReturnType<typeof toAttachmentEntry>> => ({
    items: Array.from({ length: n }, (_, i) => ({ kind: 'file' as const, attachmentId: `att-${i}`, bytes: i, time: 0 })),
    total: n, truncated: false, omitted: 0,
  })
  const presented = (n: number): LibrarySectionResult<ReturnType<typeof toPresentedEntry>> => ({
    items: Array.from({ length: n }, (_, i) => ({ path: `presented-${i}.txt`, sessionId: 'p', time: 0 })),
    total: n, truncated: false, omitted: 0,
  })
  const changes = (n: number): LibrarySectionResult<LibraryChangesEntry> => ({
    items: Array.from({ length: n }, (_, i) => ({
      threadId: `thread-${i}`, label: `task ${i}`, source: 'live' as const, filesTotal: 1,
      files: [{ path: `src/module-${i}.ts`, added: 1, removed: 0 }],
    })),
    total: n, truncated: false, omitted: 0,
  })

  it('keeps everything untouched when the complete render already fits', () => {
    const full: LibraryListResult = { attachments: attachments(3), presented: presented(3), changes: changes(3) }
    expect(fitLibrary(full, 4096)).toEqual(full)
  })

  it('cuts changes first, leaving attachments and presented intact', () => {
    const full: LibraryListResult = { attachments: attachments(3), presented: presented(3), changes: changes(30) }
    const bound = bytes(renderLibrary({ attachments: attachments(3), presented: presented(3), changes: changes(0) }, Infinity)) + 80

    const result = fitLibrary(full, bound)

    expect(bytes(renderLibrary(result, Infinity))).toBeLessThanOrEqual(bound)
    expect(result.attachments?.omitted).toBe(0)
    expect(result.presented?.omitted).toBe(0)
    expect(result.changes?.omitted).toBeGreaterThan(0)
  })

  it('exhausts changes, then cuts presented, before touching attachments', () => {
    const full: LibraryListResult = { attachments: attachments(3), presented: presented(30), changes: changes(30) }
    // The bound is the size of the shape the pass should land on: `presented`
    // and `changes` fully drained, each keeping its omission footer.
    const exhausted: LibraryListResult = {
      attachments: attachments(3),
      presented: { items: [], total: 30, truncated: true, omitted: 30 },
      changes: { items: [], total: 30, truncated: true, omitted: 30 },
    }
    const bound = bytes(renderLibrary(exhausted, Infinity))

    const result = fitLibrary(full, bound)

    expect(bytes(renderLibrary(result, Infinity))).toBeLessThanOrEqual(bound)
    expect(result.changes?.items).toEqual([])
    expect(result.presented?.items).toEqual([])
    expect(result.presented?.omitted).toBe(30)
    expect(result.changes?.omitted).toBe(30)
    expect(result.attachments?.omitted).toBe(0)
  })

  it('drops attachments last, once changes and presented are both exhausted', () => {
    const full: LibraryListResult = { attachments: attachments(30), presented: presented(30), changes: changes(30) }
    const out = fitLibrary(full, 256)

    // 256 is below the floor the three omission footers alone need, so no entry
    // cut can satisfy it: `fitLibrary` sheds every row it can and the hard byte
    // bound belongs to the render the tool actually emits.
    expect(out.changes?.items).toEqual([])
    expect(out.presented?.items).toEqual([])
    expect(bytes(renderLibrary(out, Infinity))).toBeGreaterThan(256)
    expect(bytes(renderLibrary(out, 256))).toBe(256)
  })
})
