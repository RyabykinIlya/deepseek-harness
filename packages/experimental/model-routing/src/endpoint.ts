/**
 * The one projection from a live OpenRouter endpoint into the vocabulary the
 * decision event, the Remote quote, and the composer's chip all share.
 *
 * It lives in its own module because three callers need it and none of them owns
 * it: the adapter writes it into `model-routing/decision`, the service returns it
 * from `quote`, and the settings page renders it verbatim. Prices are USD per
 * token, exactly as OpenRouter publishes them.
 *
 * @module dsh-experimental-model-routing/endpoint
 */

import type { OpenRouterEndpoint } from '@deepseek-ai/dsh-llm-pi-ai'
import type { RoutingEndpoint } from './types.ts'

/**
 * Project one endpoint into the shared event and quote vocabulary.
 *
 * A price the endpoint did not state becomes `0` rather than being omitted: the
 * quote's whole job is to be comparable across providers, and a missing number
 * there would read as "free" rather than "unknown". Endpoints reach this function
 * only after `rejectionOf` has already refused anything unpriced.
 * @param endpoint - the live endpoint.
 * @returns the same facts under the route's own names.
 */
export function routingEndpointOf(endpoint: OpenRouterEndpoint): RoutingEndpoint {
  return {
    tag: endpoint.slug,
    ...endpoint.providerName === undefined ? {} : { providerName: endpoint.providerName },
    ...endpoint.quantization === undefined ? {} : { quantization: endpoint.quantization },
    promptUsd: endpoint.promptPrice ?? 0,
    completionUsd: endpoint.completionPrice ?? 0,
    ...endpoint.inputCacheReadPrice === undefined ? {} : { cacheReadUsd: endpoint.inputCacheReadPrice },
    ...endpoint.contextLength === undefined ? {} : { contextLength: endpoint.contextLength },
    ...endpoint.maxCompletionTokens === undefined ? {} : { maxCompletionTokens: endpoint.maxCompletionTokens },
  }
}
