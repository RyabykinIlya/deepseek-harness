/**
 * Thread roster plugin, node half. Pure UI plugin: the empty apply exists so
 * the package appears in the host cordis.yml / Loader; the browser half ships
 * via exports["./client"], discovered through the package.json `dsh.client`
 * declaration.
 *
 * @module @deepseek-ai/dsh-experimental-client-ui-threads
 */

/** Host plugin body — no host-side behavior for this source plugin. */
export function apply(): void {}
