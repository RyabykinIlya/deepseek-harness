/**
 * Host half of the model-routing browser surfaces.
 *
 * Everything this feature shows lives in the browser: the composer chip, the
 * settings page, and the Thread roster entry. The Host owns only the `tiers`
 * route and its settings namespace, which
 * `@deepseek-ai/dsh-experimental-model-routing` provides, so this package
 * contributes nothing here.
 *
 * @module @deepseek-ai/dsh-experimental-client-ui-model-routing
 */

/** No Host registration: the browser half in `./client` owns every surface. */
export function apply(): void {}
