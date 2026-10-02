/**
 * Coordinator and worker compositions over the rows of the shipped `standard`
 * preset, whose delegation rows sit inside a `cordis:group`.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import { coordinatorPreset, workerPreset } from '../src/index.ts'

/** YAML schema that keeps the shipped rows' `!!js` Loader expressions as opaque markers. */
const LOADER_YAML = yaml.DEFAULT_SCHEMA.extend([
  new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: (source: string) => ({ js: source }) }),
])

/** The `plugins` list of the shipped `standard` preset declaration. */
function shippedStandardRows(): PresetDefinition['plugins'] {
  const path = fileURLToPath(new URL('../../../bundle/web-app/presets/standard.patch.yml', import.meta.url))
  const patch = yaml.load(readFileSync(path, 'utf8'), { schema: LOADER_YAML }) as {
    insert: { id: string; config: { id: string; plugins: PresetDefinition['plugins'] } }[]
  }[]
  const declaration = patch.flatMap(entry => entry.insert).find(entry => entry.config.id === 'standard')
  if (declaration === undefined) throw new Error('standard.patch.yml declares no `standard` preset')
  return declaration.config.plugins
}

/** Every row at every group depth, in document order. */
function flatten(rows: PresetDefinition['plugins']): PresetDefinition['plugins'] {
  return rows.flatMap(entry => entry.group === true && Array.isArray(entry.config)
    ? flatten(entry.config as PresetDefinition['plugins'])
    : [entry])
}

/** Ids of the rows that are not disabled, at every group depth. */
function activeIds(rows: PresetDefinition['plugins']): string[] {
  return flatten(rows).filter(entry => entry.disabled !== true).map(entry => entry.id ?? entry.name)
}

const display = { id: 'project', name: 'Project', description: 'coordinator', order: 50 }

describe('compositions over the shipped standard preset', () => {
  const base = shippedStandardRows()

  it('nests the delegation rows the coordinator rewrites', () => {
    expect(base.some(entry => entry.id === 'tool-subagent')).toBe(false)
    expect(activeIds(base)).toEqual(expect.arrayContaining(['tool-subagent', 'tool-subagent-fork', 'tool-subagent-list-agents']))
  })

  it('gives the coordinator one subagent row, on the thread provider, inside the delegation group', () => {
    const preset = coordinatorPreset({
      display,
      provider: 'thread',
      base,
      contract: { checkIn: 'milestones', spawn: 'ask', mergePolicy: 'ask' },
      tools: { defaultLimit: 20, maxLimit: 100 },
    })
    const rows = flatten(preset.plugins)
    const delegations = rows.filter(entry => entry.id === 'tool-subagent')
    expect(delegations).toHaveLength(1)
    expect(delegations[0]?.config).toEqual({ provider: 'thread', toolName: 'subagent', backgroundMode: 'continuable' })
    expect(preset.plugins.some(entry => entry.id === 'tool-subagent')).toBe(false)
    const ids = activeIds(preset.plugins)
    expect(ids).not.toContain('tool-subagent-fork')
    expect(ids).not.toContain('tool-subagent-list-agents')
    expect(ids.filter(id => id === 'tool-subagent-control')).toHaveLength(1)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('caps the depth of the worker\'s nested subagent row and keeps its spawn provider', () => {
    const preset = workerPreset({ display: { ...display, id: 'project-thread' }, base, maxDepth: 2 })
    const delegations = flatten(preset.plugins).filter(entry => entry.id === 'tool-subagent')
    expect(delegations).toHaveLength(1)
    expect(delegations[0]?.config).toMatchObject({ provider: 'spawn', toolName: 'subagent', maxDepth: 2 })
    const ids = activeIds(preset.plugins)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
