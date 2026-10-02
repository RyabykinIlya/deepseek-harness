/**
 * Plugin configuration for the Threads client half.
 *
 * The Project preset ships in its own package, so nothing here imports it: the
 * deployment names the preset ids that count as a Project through this config.
 * The default names the id the shipped `dsh-experimental-threads-preset` bundle
 * registers, so the feature is live out of the box.
 *
 * The default is deliberately NON-EMPTY. A client entry's `config` is never
 * delivered to the browser half: nothing on the Host assembles a config for a
 * client row, so `apply(ctx, config)` always receives `undefined` and only the
 * schema default can reach the browser. An empty default would leave the New
 * Project action permanently inert — and silently so.
 */
import z from '@deepseek-ai/schemastery'

/**
 * Agent preset id the shipped Threads bundle registers its Project preset under.
 * Duplicated as a literal because the browser half cannot import the Host-side
 * preset package; the Threads bundle test asserts the two stay in step.
 */
const DEFAULT_PROJECT_PRESET = 'project'

/** Threads client runtime configuration. */
export interface Config {
  /**
   * Agent preset ids whose sessions are Project sessions, in the order the
   * deployment wants them read. The first entry is also the preset a "New
   * Project" action composes, so a deployment that names more than one chooses
   * which identity its entry point creates.
   */
  projectAgentPresets?: string[]
}

/** Validated Threads client runtime configuration. */
export const Config: z<Config> = z.object({
  projectAgentPresets: z.array(String).default([DEFAULT_PROJECT_PRESET]),
})
