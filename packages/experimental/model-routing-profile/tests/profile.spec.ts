/**
 * The model-routing profile bundle: its patch document, and the shape a user
 * fills in beside it.
 *
 * The bundle itself carries no configuration. A route with no tiers advertises
 * an empty model list and decides nothing, which is the correct dormant posture
 * — a person who installs this has not yet said which models they are willing
 * to pay for, and guessing for them would spend money on their behalf. The
 * fragment below is what such a person writes into their own profile.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { Config, readSettings, validateSettings } from '@deepseek-ai/dsh-experimental-model-routing'

interface Row {
  id?: string
  name?: string
  disabled?: boolean
  config?: Record<string, unknown>
  insert?: Row[]
}

const root = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  name?: string
  icon?: string
  publishConfig?: { access?: string }
  dependencies?: Record<string, string>
  dsh?: { bundle?: { patch?: string } }
}
const patches = yaml.load(
  readFileSync(resolve(root, manifest.dsh!.bundle!.patch!), 'utf8'),
  { schema: entryListSchema },
) as Row[]
const inserted = patches.flatMap(patch => patch.insert ?? [])

describe('model-routing profile bundle', () => {
  it('declares a public bundle with a parseable patch and an icon', () => {
    expect(manifest.publishConfig?.access).toBe('public')
    expect(manifest.icon).toBe('./icon.svg')
    expect(patches.length).toBeGreaterThan(0)
  })

  it('inserts exactly the route and its browser half, and nothing else', () => {
    expect(inserted.map(row => [row.id, row.name])).toEqual([
      ['model-routing', '@deepseek-ai/dsh-experimental-model-routing'],
      ['ui-model-routing', '@deepseek-ai/dsh-experimental-client-ui-model-routing'],
    ])
  })

  it('only inserts rows: nothing the base layers ship is repointed or disabled', () => {
    for (const patch of patches) {
      expect(patch.id).toBeUndefined()
      expect(patch.disabled).toBeUndefined()
    }
  })

  it('carries no configuration, so the route stays dormant until a person names tiers', () => {
    // A tier list is a spending decision; the bundle must not make one.
    for (const row of inserted) expect(row.config).toBeUndefined()
  })

  it('depends on both packages the patch names', () => {
    // The dependency value is the `workspace:*` range; the name it stands for is
    // the package key, which is what the patch document spells out.
    const names = Object.keys(manifest.dependencies ?? {})
    for (const row of inserted) {
      expect(names).toContain(row.name)
      expect(manifest.dependencies![row.name!]).toMatch(/^workspace:/)
    }
  })
})

describe('the profile fragment the README documents', () => {
  /** The rows the plan's §16 step 5 tells an operator to add to their own profile. */
  const FRAGMENT = {
    'model-routing': {
      tiers: [
        {
          name: 'pro',
          models: ['deepseek/deepseek-v4-pro', 'z-ai/glm-5.3'],
          contextWindow: 1_000_000,
          maxTokens: 32_768,
          minQuantization: 'fp8',
          unknownQuantization: 'reject',
          free: 'off',
        },
        {
          name: 'flash',
          models: ['deepseek/deepseek-v4-flash', 'z-ai/glm-5.3-flash', 'stealth/space-bunny-alpha'],
          contextWindow: 1_000_000,
          maxTokens: 32_768,
          minQuantization: 'fp8',
          unknownQuantization: 'trusted',
          free: 'prefer',
        },
      ],
      trustedUnknownProviders: ['stealth'],
      judgeModel: 'typesafe/jev-1.13',
      presetRoutes: [{ preset: 'project', model: 'pro' }],
    },
    project: {
      threadProvider: 'tiers',
      threadModel: 'flash',
      threadReasoningEffort: 'high',
      threadMaxTokens: 32_768,
      threadModels: [{ provider: 'tiers', model: 'flash' }, { provider: 'tiers', model: 'pro' }],
      tierContract: 'tiers',
    },
  }

  it('validates under the Host\'s own rules', () => {
    const routing = Config({
      tiers: FRAGMENT['model-routing'].tiers,
      trustedUnknownProviders: FRAGMENT['model-routing'].trustedUnknownProviders,
      judgeModel: FRAGMENT['model-routing'].judgeModel,
      presetRoutes: FRAGMENT['model-routing'].presetRoutes,
    } as never)
    expect(() =>{  validateSettings(readSettings(routing)) }).not.toThrow()
    expect(readSettings(routing).tiers.map(tier => tier.name)).toEqual(['pro', 'flash'])
  })

  it('gives the coordinator both tiers the contract tells it to pick between', () => {
    const models = FRAGMENT.project.threadModels.map(route => route.model)
    expect(models).toContain('flash')
    expect(models).toContain('pro')
  })
})
