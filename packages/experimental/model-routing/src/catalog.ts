/**
 * The `modelRouting` seam as a schema harvest mounts it.
 *
 * `thread_tier` registers only while a routing service is present, and the tool
 * exists to ask that service to record a decision, so a harvest that mounts the
 * Thread tools alone never sees its schema. This service answers the
 * registration and refuses every operation, keeping the harvest away from the
 * recording path.
 * @module @deepseek-ai/dsh-experimental-model-routing/catalog
 */

import type { ModelRoutingControl } from './types.ts'

/**
 * Routing seam marker whose every call refuses.
 *
 * The tier names are the shape a configured deployment names, so the harvested
 * schema is the one the model receives; the override call cannot be reached
 * from a schema read.
 */
export class CatalogModelRouting implements ModelRoutingControl {
  tierNames(): readonly string[] {
    return ['pro', 'flash']
  }

  setThreadTier(): void {
    throw new Error('gen-tool-catalog: thread_tier execution is unreachable during schema harvest')
  }

  setOpenRouterFallback(): void {
    throw new Error('gen-tool-catalog: routing choices are unreachable during schema harvest')
  }
}
