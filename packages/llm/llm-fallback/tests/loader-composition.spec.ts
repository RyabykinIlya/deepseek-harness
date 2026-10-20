/**
 * Real-Loader composition for llm-fallback: the plugin mounts through a
 * test-only cordis.yml, exports the function-plugin surface, and validates its
 * configuration before the behavioral tests rely on it.
 *
 * @module @deepseek-ai/dsh-llm-fallback/tests
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as fallback from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Node internals the Loader never exercises in this test. */
function unused(): never {
  throw new Error('the llm-fallback loader test resolves every module through the import stub')
}

/**
 * Map every workspace specifier the config names to its mounted module.
 *
 * The Loader resolves plugins through `loader.internal.import` when Node's
 * internals are reachable, so the stub keeps resolution deterministic and
 * independent of the test process's real module graph.
 */
async function loadYaml(lines: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-llm-fallback-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [...lines, ''].join('\n'))

  const loaded = new Context()
  context = loaded
  loaded.baseUrl = pathToFileURL(root).href + '/'
  await loaded.plugin(Loader)
  loaded.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-llm-fallback', fallback],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
  ])
  const stub: ModuleLoaderV2 = {
    version: 'v2',
    loadCache: new Map(),
    async import(specifier: string): Promise<unknown> {
      const module = modules.get(specifier)
      if (module === undefined) throw new Error(`unexpected Loader import: ${specifier}`)
      return module
    },
    register: unused,
    getOrCreateModuleJob: unused,
    resolveSync: unused,
    load: unused,
  }
  loaded.loader.internal = stub
  await loaded.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await loaded.loader.await()
  return loaded
}

const prelude = [
  "- name: '@deepseek-ai/dsh-llm'",
  "- name: '@deepseek-ai/dsh-session'",
  "- name: '@deepseek-ai/dsh-session-projection'",
  "- name: '@deepseek-ai/dsh-system-prompt'",
  "- name: '@deepseek-ai/dsh-tools'",
  "- name: '@deepseek-ai/dsh-agent'",
]

const loopEntry = "- name: '@deepseek-ai/dsh-agent-loop'"

describe('real Loader composition', () => {
  // Real-Loader composition resolves workspace packages through tsx at test
  // time; first resolution after the host/client program split is slow enough
  // to trip the default 5s budget on cold caches.
  it('mounts llm-fallback from cordis.yml with a valid chains config', { timeout: 60_000 }, async () => {
    const loaded = await loadYaml([
      ...prelude,
      "- name: '@deepseek-ai/dsh-llm-fallback'",
      '  config:',
      '    chains:',
      '      default:',
      '        name: Default',
      '        steps:',
      '          - provider: a',
      '            model: model-a',
      '          - provider: b',
      '            model: model-b',
      loopEntry,
    ])

    const unloaded = [...loaded.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])
    expect(loaded.agents).toBeInstanceOf(AgentRegistry)
    expect([...loaded.loader.entries()].map(entry => entry.options.name))
      .toContain('@deepseek-ai/dsh-llm-fallback')
  })

  it('exposes the function-plugin surface and no default export', { timeout: 60_000 }, async () => {
    await loadYaml([...prelude, "- name: '@deepseek-ai/dsh-llm-fallback'", loopEntry])

    expect(fallback.name).toBe('llm-fallback')
    expect(fallback.inject).toEqual(['agents', 'sessionProjections'])
    expect(typeof fallback.apply).toBe('function')
    // A default export makes the Loader discard the function-plugin namespace.
    expect('default' in fallback).toBe(false)
  })

  it('accepts a valid chains config through the exported Config schema', { timeout: 60_000 }, async () => {
    const loaded = await loadYaml([...prelude, "- name: '@deepseek-ai/dsh-llm-fallback'", loopEntry])

    const resolved = fallback.Config({
      chains: {
        coding: {
          steps: [
            { provider: 'a', model: 'model-a', label: 'Primary' },
            { provider: 'b', model: 'model-b' },
          ],
        },
      },
    })

    expect(resolved.chains.coding?.steps.map(step => [step.provider, step.model])).toEqual([
      ['a', 'model-a'],
      ['b', 'model-b'],
    ])
    expect(loaded.agents).toBeInstanceOf(AgentRegistry)
  })

  it('rejects a chains config whose steps is not an array', { timeout: 60_000 }, async () => {
    const loaded = await loadYaml([...prelude, "- name: '@deepseek-ai/dsh-llm-fallback'", loopEntry])

    // The Loader validates raw config; `~standard.validate` is the schemastery
    // entry point for exactly that untyped input.
    const validated = fallback.Config['~standard'].validate({
      chains: { broken: { steps: 'not-an-array' } },
    })

    if (!('issues' in validated) || validated.issues === undefined) {
      throw new Error('expected schemastery to reject steps: not-an-array')
    }
    expect(validated.issues.map(issue => issue.message).join('\n')).toContain('steps')
    expect(loaded.agents).toBeInstanceOf(AgentRegistry)
  })
})
