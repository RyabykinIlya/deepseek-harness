/**
 * Host half of the Project memory browser surfaces.
 *
 * The Host entry exists so the page's package appears in the host cordis.yml /
 * Loader; everything this feature shows lives in the browser. The namespace the
 * page edits is registered by `@deepseek-ai/dsh-experimental-project-memory`, so
 * this package contributes nothing here.
 *
 * @module @deepseek-ai/dsh-experimental-client-ui-project-memory
 */

/** No Host registration: the browser half in `./client` owns every surface. */
export function apply(): void {}
