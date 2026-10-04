import { describe, expect, it } from 'vitest'
import type { OpenRouterCatalogEntry } from '@deepseek-ai/dsh-llm-pi-ai'
import { resolveModelFamily } from '../src/family.ts'

/**
 * The DeepSeek and GLM entries of `GET https://openrouter.ai/api/v1/models` as
 * of 2026-10-04, reduced to the two identity fields this module reads.
 */
const catalog: readonly OpenRouterCatalogEntry[] = [
  { id: 'deepseek/deepseek-v4-pro', canonicalSlug: 'deepseek/deepseek-v4-pro-20260423' },
  { id: 'deepseek/deepseek-v4-pro-0813', canonicalSlug: 'deepseek/deepseek-v4-pro-20260813' },
  { id: 'deepseek/deepseek-v4-flash', canonicalSlug: 'deepseek/deepseek-v4-flash-20260423' },
  // The variant is listed first, so the plain id has to win the tie rather than
  // keeping whichever entry the catalog happened to order first.
  { id: 'deepseek/deepseek-v4-flash:batch', canonicalSlug: 'deepseek/deepseek-v4-flash-20260731' },
  { id: 'deepseek/deepseek-v4-flash-0731', canonicalSlug: 'deepseek/deepseek-v4-flash-20260731' },
  { id: 'deepseek/deepseek-v4.1-flash', canonicalSlug: 'deepseek/deepseek-v4.1-flash-20260910' },
  { id: 'deepseek/deepseek-v4.1-flash:batch', canonicalSlug: 'deepseek/deepseek-v4.1-flash-20260910' },
  { id: 'deepseek/deepseek-v4-flash-vision-exp', canonicalSlug: 'deepseek/deepseek-v4-flash-vision-exp-20260821' },
  { id: 'deepseek/deepseek-r1-0528', canonicalSlug: 'deepseek/deepseek-r1-0528' },
  { id: '~deepseek/deepseek-pro-latest', canonicalSlug: '~deepseek/deepseek-pro-latest' },
  { id: 'z-ai/glm-5.3', canonicalSlug: 'z-ai/glm-5.3-20260920' },
]

describe('resolveModelFamily', () => {
  it('moves an unversioned id to the newest snapshot of its family', () => {
    expect(resolveModelFamily('deepseek/deepseek-v4-pro', catalog)).toEqual({
      configured: 'deepseek/deepseek-v4-pro',
      resolved: 'deepseek/deepseek-v4-pro-0813',
      moved: true,
    })
  })

  it('moves a dated id forward and leaves the newest release where it is', () => {
    expect(resolveModelFamily('deepseek/deepseek-v4-flash', catalog).resolved)
      .toBe('deepseek/deepseek-v4-flash-0731')
    expect(resolveModelFamily('deepseek/deepseek-v4-flash-0731', catalog))
      .toEqual({ configured: 'deepseek/deepseek-v4-flash-0731', resolved: 'deepseek/deepseek-v4-flash-0731', moved: false })
  })

  it('names the plain id of a release, not its variant spelling', () => {
    expect(resolveModelFamily('deepseek/deepseek-v4-flash', catalog).resolved)
      .toBe('deepseek/deepseek-v4-flash-0731')
    // A release published only as a variant still resolves to something routable.
    const variantOnly: readonly OpenRouterCatalogEntry[] = [
      { id: 'deepseek/deepseek-v4-pro', canonicalSlug: 'deepseek/deepseek-v4-pro-20260423' },
      { id: 'deepseek/deepseek-v4-pro-0813:batch', canonicalSlug: 'deepseek/deepseek-v4-pro-20260813' },
    ]
    expect(resolveModelFamily('deepseek/deepseek-v4-pro', variantOnly).resolved)
      .toBe('deepseek/deepseek-v4-pro-0813:batch')
    // Once the plain id of the same release is listed, it takes the tie.
    expect(resolveModelFamily('deepseek/deepseek-v4-pro', [...variantOnly, {
      id: 'deepseek/deepseek-v4-pro-0813',
      canonicalSlug: 'deepseek/deepseek-v4-pro-20260813',
    }]).resolved).toBe('deepseek/deepseek-v4-pro-0813')
  })

  it('keeps a sibling slug out of its parent family', () => {
    // `-vision-exp` and `-v4.1-` are separate families, so a later date under
    // either must not pull the v4 flash tier onto a different model.
    expect(resolveModelFamily('deepseek/deepseek-v4-flash', catalog).resolved)
      .toBe('deepseek/deepseek-v4-flash-0731')
  })

  it('leaves a model with no dated identity, or none at all, exactly as configured', () => {
    for (const model of ['deepseek/deepseek-r1-0528', '~deepseek/deepseek-pro-latest', 'vendor/not-listed']) {
      expect(resolveModelFamily(model, catalog))
        .toEqual({ configured: model, resolved: model, moved: false })
    }
  })

  it('never crosses into another publisher family, however recent that one is', () => {
    const withNewerGlm: readonly OpenRouterCatalogEntry[] = [
      ...catalog,
      { id: 'z-ai/glm-5.3-1111', canonicalSlug: 'z-ai/glm-5.3-20261231' },
    ]
    expect(resolveModelFamily('z-ai/glm-5.3', withNewerGlm).resolved).toBe('z-ai/glm-5.3-1111')
    expect(resolveModelFamily('deepseek/deepseek-v4-pro', withNewerGlm).resolved)
      .toBe('deepseek/deepseek-v4-pro-0813')
  })

  it('decides against a catalog that lists only the family it is asked about', () => {
    expect(resolveModelFamily('deepseek/deepseek-v4-pro', [])).toEqual({
      configured: 'deepseek/deepseek-v4-pro',
      resolved: 'deepseek/deepseek-v4-pro',
      moved: false,
    })
  })
})
