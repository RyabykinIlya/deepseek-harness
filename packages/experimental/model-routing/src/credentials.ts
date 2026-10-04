/**
 * Resolving the OpenRouter credential.
 *
 * The route reads two things with this key: the Decisions API call the judge
 * makes, and `GET /key` for the free-model budget. Neither is an LLM request, so
 * the key stays inside this package — it is resolved here rather than handed to
 * the inner pi-ai route, which would pin an unrelated deployment's credential to
 * every routed request.
 *
 * @module dsh-experimental-model-routing/credentials
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'

/**
 * Resolve one reference to its current value, with the precedence every provider
 * in this repository uses: the credentials service when it is mounted, and the
 * launching environment — the whole credential plane — when it is not.
 * @param ctx - plugin context supplying the credential and environment planes.
 * @param ref - the reference to resolve.
 * @returns the value, or `undefined` while no layer supplies one.
 */
export async function resolveKey(ctx: Context, ref: CredentialRef): Promise<string | undefined> {
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) return (await credentials.resolve(ref))?.value
  const ambient = launchEnvironmentOf(ctx).get(ref)
  return ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined
}

/**
 * Resolve a configured reference name to a value, or report that none is stored.
 *
 * `undefined` is the answer, not a throw: the route still serves a session whose
 * endpoints can be read and whose request can go out, because the key is only
 * needed for the judge and the free-budget counter, both of which already degrade
 * on failure.
 * @param ctx - plugin context supplying the credential and environment planes.
 * @param apiKeyRef - the configured reference name.
 * @returns the key, or `undefined` while none is stored.
 */
export async function resolveApiKeyRef(ctx: Context, apiKeyRef: string): Promise<string | undefined> {
  return resolveKey(ctx, credentialRef(apiKeyRef))
}
