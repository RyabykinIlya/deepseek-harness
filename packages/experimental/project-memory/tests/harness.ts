/** Project memory tests run the real service over the in-memory storage backend. */
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { agentPresetProjectionDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import type SessionPersistence from '@deepseek-ai/dsh-session-persistence'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import ProjectMemoryService from '../src/index.ts'
import type { Config } from '../src/index.ts'
import * as tools from '../src/tools.ts'

/** Mount the service (and optionally the tools) in a fresh Context.
 * @param options - shared media pool for restart simulation, service config, tool config, and whether the tools mount.
 * @returns The Context, pool, and the service and tool fibers.
 */
export async function harness(options: {
  pool?: MemoryMediaPool
  config?: Config
  tools?: false | tools.Config
  service?: false
  /** Headers served by a fake `sessionPersistence.stat`, by Session id; the service is absent when omitted. */
  persisted?: Readonly<Record<string, { agentPreset?: string; parentSession?: string }>>
  /** Mount the projection registry with the real `agentPreset` unit; absent by default so the header stays the only answer. */
  projections?: boolean
} = {}) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(Storage)
  if (options.projections === true) {
    await ctx.plugin(SessionProjectionRegistry)
    ctx.effect(() => ctx.sessionProjections.register(agentPresetProjectionDefinition))
  }
  const pool = options.pool ?? new MemoryMediaPool()
  const backend = new MemoryStorageBackend(pool)
  ctx.effect(() => ctx.storage.backend.register('fixture', backend))
  ctx.effect(() => async () => { await backend.close() })
  const facility = new DomainFacility(ctx, { backend: 'fixture' })
  ctx.effect(() => {
    const unmount = ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    return async () => { await facility.closeAll(); unmount() }
  })
  if (options.persisted !== undefined) {
    const persisted = options.persisted
    const stat: Partial<SessionPersistence>['stat'] = async (id) => {
      const meta = persisted[id]
      if (meta === undefined) return undefined
      const header = {
        id,
        ...meta.agentPreset === undefined ? {} : { agentPreset: meta.agentPreset },
        ...meta.parentSession === undefined ? {} : { parentSession: SessionId(meta.parentSession) },
      } as SessionHeader
      return { header, revision: 'fake' } as Awaited<ReturnType<SessionPersistence['stat']>>
    }
    ctx.effect(() => ctx.provide('sessionPersistence', { stat } as SessionPersistence), 'fake-session-persistence')
  }
  const serviceFiber = options.service === false ? undefined : await ctx.plugin(ProjectMemoryService, options.config)
  const toolFiber = options.tools === false ? undefined : await ctx.plugin(tools, options.tools)
  return { ctx, pool, serviceFiber, toolFiber }
}

/** Create a Session with optional preset and parent lineage, and an Agent over it.
 * @param ctx - Context owning the sessions.
 * @param id - Session id.
 * @param meta - Preset and parent of the Session header.
 * @returns A minimal Agent for the Session.
 */
export function agentFor(ctx: Context, id: string, meta: { agentPreset?: string; parentSession?: string } = {}): Agent {
  const session = ctx.sessions.create(SessionId(id), {
    meta: {
      ...meta.agentPreset === undefined ? {} : { agentPreset: meta.agentPreset },
      ...meta.parentSession === undefined ? {} : { parentSession: SessionId(meta.parentSession) },
    },
  })
  return {
    id: session.id, session, ctx: ctx.extend(), options: {}, status: 'idle', inbox: unsupportedInbox(),
    send() {}, followup() {}, steer() {}, inject() {}, cancel() {},
    whenIdle: async () => {}, runMaintenance: operation => operation(new AbortController().signal),
  }
}

/**
 * Recompose a live Session under another preset, the way `agentPresets.select` does:
 * the composition moves and the event is appended, while the deep-frozen creation
 * header keeps naming the preset the Session started with.
 * @param agent - the Session to switch.
 * @param agentPreset - the preset the composition moves to.
 */
export function selectPreset(agent: Agent, agentPreset: string): void {
  agent.session.append('agent-preset/selected', { agentPreset })
}

let call = 0

/** Execute a memory tool through the registry as the given Agent.
 * @param ctx - Context carrying the tool registry.
 * @param agent - Calling Agent.
 * @param name - Tool name.
 * @param args - Model arguments.
 * @returns The registry result and its rendered text.
 */
export async function run(ctx: Context, agent: Agent | undefined, name: string, args: unknown) {
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`memory-call-${++call}`),
    name,
    arguments: args,
    ...agent === undefined ? {} : { agent },
  })
  const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('')
  return { result, text }
}
