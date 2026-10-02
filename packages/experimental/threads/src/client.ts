/**
 * Client-safe Threads vocabulary: the `threads` projection row a browser reads
 * and the branded Thread identity it addresses a Thread chat with.
 *
 * A Client plugin imports this subpath and nothing else from the domain package.
 * Importing `./types.ts` directly would drag the Host-only `declare module`
 * augmentations of `@deepseek-ai/dsh-typert-protocol`,
 * `@deepseek-ai/dsh-session-projection/types` and
 * `@deepseek-ai/dsh-session/types` into a browser package, whose node_modules
 * does not carry them. The `threads` Remote contribution stays reachable
 * through the generated `@deepseek-ai/dsh-experimental-threads/remote` stub,
 * which is resolved from `lib/`.
 */

export type { ThreadStatusRow, ThreadStopReason, ThreadId } from './types.ts'
