/**
 * The harvest-only routing seam: it answers the tier query with the shape a
 * configured deployment names, and refuses the override no schema read reaches.
 */

import { describe, expect, it } from 'vitest'
import { CatalogModelRouting } from '../src/catalog.ts'

describe('model-routing catalog seam', () => {
  it('names the tiers the harvested schema offers', () => {
    expect(new CatalogModelRouting().tierNames()).toEqual(['pro', 'flash'])
  })

  it('refuses a tier override, which a schema harvest never performs', () => {
    const routing = new CatalogModelRouting()
    expect(() => { routing.setThreadTier() }).toThrow(/unreachable during schema harvest/)
  })

  it('refuses a fallback choice, which a schema harvest never performs', () => {
    const routing = new CatalogModelRouting()
    expect(() => { routing.setOpenRouterFallback() }).toThrow(/unreachable during schema harvest/)
  })
})
