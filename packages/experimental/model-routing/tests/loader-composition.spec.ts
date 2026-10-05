/**
 * Real Loader composition for the `tiers` route's input-modality filtering.
 *
 * One cordis.yml boots the LLM runtime, sessions, the agent loop, the real
 * pi-ai route, the local attachment store, and the model-routing service; only
 * the OpenRouter listings and the provider endpoint are stand-ins. A tier's
 * `input` list only admits an image to the route at all — which model is shown
 * to accept one is read solely from the stubbed `/models` catalog reply, so the
 * dispatch target follows that catalog and nothing else.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import ModelRouting from '../src/index.ts'
import { closeMockServers, mockServer, textEvents, type MockServer } from '../../../llm/llm-pi-ai/tests/mock-server.ts'

/** The cheapest Flash model the recorded listings offer, shown text-only by the catalog. */
const TEXT_MODEL = 'deepseek/deepseek-v4-flash'

/** The other Flash model, shown accepting image input by the catalog reply. */
const IMAGE_MODEL = 'z-ai/glm-5.3-flash'

/**
 * The `/models` reply the routing decision reads, in OpenRouter's own spelling.
 *
 * This is the only place either model is shown to accept anything: the routing
 * filter reads `architecture.input_modalities` and nothing else, so flipping an
 * entry here flips which model an image turn may reach.
 */
const CATALOG_REPLY = {
  data: [
    {
      id: TEXT_MODEL,
      canonical_slug: 'deepseek/deepseek-v4-flash-20260423',
      architecture: { input_modalities: ['text'] },
    },
    {
      id: IMAGE_MODEL,
      canonical_slug: 'z-ai/glm-5.3-flash-20260826',
      architecture: { input_modalities: ['text', 'image'] },
    },
  ],
}

/** One pixel of PNG bytes, the smallest image the attachment store normalizes and re-reads. */
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'

let context: Context | undefined
let root: string | undefined

beforeEach(() => {
  // The pi-ai route and the routing judge read the credential by reference; the
  // reference resolves from the launching environment when no store is mounted.
  vi.stubEnv('OPENROUTER_API_KEY', 'test-key')
})

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  await closeMockServers()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

/**
 * Serve the recorded OpenRouter listings and pass every other request through.
 * @param body - the `/models` catalog reply, the only modality evidence the decision reads.
 */
function stubOpenRouter(body: unknown): void {
  const passthrough = globalThis.fetch.bind(globalThis)
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url.endsWith('/models')) return new Response(JSON.stringify(body), { status: 200 })
    const marker = url.lastIndexOf('/models/')
    if (marker !== -1 && url.endsWith('/endpoints')) {
      const model = url.slice(marker + '/models/'.length, url.lastIndexOf('/endpoints'))
      const name = `${model.replace('/', '__').replace(':', '--')}.json`
      const recorded: unknown = JSON.parse(await readFile(
        fileURLToPath(new URL(`./fixtures/endpoints/${name}`, import.meta.url)),
        'utf8',
      ))
      return new Response(JSON.stringify(recorded), { status: 200 })
    }
    return passthrough(input, init)
  })
}

/**
 * Boot the routing composition from one real cordis.yml over a mocked provider.
 *
 * The `tiers` row's `input` is the only field the callers vary: everything the
 * decision reads about what a model accepts comes from {@link CATALOG_REPLY}.
 * @param tierInput - the input modalities the flash tier advertises to the runtime.
 * @returns the booted context and the provider stand-in recording dispatches.
 */
async function bootComposition(tierInput: readonly string[]): Promise<{ context: Context; server: MockServer }> {
  const server = await mockServer([{ events: textEvents }, { events: textEvents }])
  stubOpenRouter(CATALOG_REPLY)
  root = await mkdtemp(join(tmpdir(), 'dsh-model-routing-composition-'))
  const tier = {
    name: 'flash',
    label: 'Flash',
    models: [TEXT_MODEL, IMAGE_MODEL],
    contextWindow: 1_000_000,
    maxTokens: 32_768,
    input: [...tierInput],
    minQuantization: 'fp8',
    unknownQuantization: 'trusted',
    free: 'off',
  }
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
    ['@deepseek-ai/dsh-attachment-local', LocalAttachmentStore],
    ['@deepseek-ai/dsh-llm-pi-ai', LlmPiAi],
    ['@deepseek-ai/dsh-experimental-model-routing', ModelRouting],
  ])
  const configs = new Map<string, unknown>([
    ['@deepseek-ai/dsh-attachment-local', { dshHome: root }],
    // The inner route stands in for OpenRouter's chat endpoint; its `input`
    // lists are wire capabilities pi-ai admits content against, not evidence
    // the routing decision reads.
    ['@deepseek-ai/dsh-llm-pi-ai', {
      providers: {
        openrouter: {
          apiKeyEnv: 'OPENROUTER_API_KEY',
          api: 'openai-completions',
          baseURL: server.url,
          models: [
            { id: TEXT_MODEL, input: ['text'], reasoningEfforts: { off: null, high: 'high', xhigh: 'xhigh' } },
            { id: IMAGE_MODEL, input: ['text', 'image'], reasoningEfforts: { low: 'low', high: 'high', max: 'max' } },
          ],
        },
      },
    }],
    // `judgeEnabled: false` because these turns name their tier outright and
    // the judge decides only `auto` targets; the modality filter is the subject.
    ['@deepseek-ai/dsh-experimental-model-routing', {
      tiers: [tier],
      judgeEnabled: false,
      defaultTier: 'flash',
      judgeProTier: 'flash',
      judgeFlashTier: 'flash',
    }],
  ])
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [...modules.keys()].flatMap(name => [
    `- name: '${name}'`,
    ...configs.has(name) ? [`  config: ${JSON.stringify(configs.get(name))}`] : [],
  ]).join('\n') + '\n')

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const internal: ModuleLoaderV2 = {
    version: 'v2',
    loadCache: new Map(),
    import: (specifier: string) => {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return Promise.resolve(modules.get(specifier))
    },
    register(): never { throw new Error('unexpected module hook registration') },
    getOrCreateModuleJob(): never { throw new Error('unexpected module job creation') },
    resolveSync(): never { throw new Error('unexpected synchronous module resolution') },
    load(): never { throw new Error('unexpected module load') },
  }
  ctx.loader.internal = internal
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  return { context: ctx, server }
}

/**
 * Store one image in the composition's own attachment store.
 * @param ctx - the booted context whose store keeps the bytes.
 * @returns the durable reference the session history records.
 */
async function storeImage(ctx: Context): Promise<ImageAttachmentRef> {
  const [ref] = await ctx.attachments.saveImages([{ data: Buffer.from(PNG_BASE64, 'base64'), mediaType: 'image/png' }])
  if (ref === undefined) throw new Error('the attachment store kept no image')
  return ref
}

/**
 * Run one agent turn to idleness.
 * @param agent - the composed agent that dispatches the turn.
 * @param text - the user's text for this turn.
 * @param image - the image the turn adds to the Session's history, when it carries one.
 */
async function turn(
  agent: Awaited<ReturnType<Context['agentLoop']['create']>>,
  text: string,
  image?: ImageAttachmentRef,
): Promise<void> {
  const content = [
    ...image === undefined ? [] : [{ type: 'image' as const, attachment: image }],
    { type: 'text' as const, text },
  ]
  agent.followup(createUserMessage({ content, source: { kind: 'user' } }))
  await agent.whenIdle()
}

describe('input-modality routing through the booted composition', { timeout: 120_000 }, () => {
  it('dispatches an image turn to the model the catalog shows accepting image, and a text turn to the cheapest model', async () => {
    const { context: ctx, server } = await bootComposition(['text', 'image'])
    const image = await storeImage(ctx)
    const agent = await ctx.agentLoop.create(SessionId('modality'), { provider: 'tiers', model: 'flash' })

    await turn(agent, 'Summarize the repository layout.')
    await turn(agent, 'What does this screenshot show?', image)

    expect(server.requests[0]).toMatchObject({ model: TEXT_MODEL })
    expect(server.requests[1]).toMatchObject({ model: IMAGE_MODEL })
    // The image reaches the model the catalog vouches for, and only it.
    expect(JSON.stringify(server.requests[1])).toContain('image/png')
    expect(JSON.stringify(server.requests[0])).not.toContain('image/png')

    const decisions = agent.session.ownEvents()
      .filter(event => event.type === 'model-routing/decision')
      .map(event => event.data)
    expect(decisions).toHaveLength(2)
    expect(decisions[0]).toMatchObject({
      boundary: 'start',
      tier: 'flash',
      model: TEXT_MODEL,
      endpoint: { tag: 'streamlake/fp8' },
    })
    // The pinned text-only model cannot serve the Session once its history
    // holds an image, so the turn re-decides inside the same tier.
    expect(decisions[1]).toMatchObject({
      boundary: 'start',
      tier: 'flash',
      model: IMAGE_MODEL,
      endpoint: { tag: 'streamlake/fp8' },
    })
  })

  it('dispatches no image while the tier advertises text only, even to a model the catalog shows accepting one', async () => {
    const { context: ctx, server } = await bootComposition(['text'])
    const image = await storeImage(ctx)
    const agent = await ctx.agentLoop.create(SessionId('modality'), { provider: 'tiers', model: 'flash' })

    await turn(agent, 'Summarize the repository layout.')
    await turn(agent, 'What does this screenshot show?', image)

    expect(server.requests[0]).toMatchObject({ model: TEXT_MODEL })
    expect(server.requests[1]).toMatchObject({ model: TEXT_MODEL })
    // The runtime replaces the image with its deterministic text placeholder
    // before the route sees the request, so no model receives the image — not
    // even the one the catalog shows accepting it.
    expect(JSON.stringify(server.requests[1])).toContain('[image omitted because this model accepts text only;')
    expect(JSON.stringify(server.requests[1])).not.toContain('image/png')
    expect(JSON.stringify(server.requests)).not.toContain(IMAGE_MODEL)

    // Nothing asked for image input, so the pinned model serves every turn and
    // the Session records no second decision.
    const decisions = agent.session.ownEvents()
      .filter(event => event.type === 'model-routing/decision')
      .map(event => event.data)
    expect(decisions).toHaveLength(1)
    expect(decisions[0]).toMatchObject({ boundary: 'start', tier: 'flash', model: TEXT_MODEL })
  })
})
