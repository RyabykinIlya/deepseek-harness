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
import { isDirect } from './select.ts'
import type { Candidate, DirectSource } from './select.ts'
import type { RoutingEndpoint, RoutingSource } from './types.ts'

/**
 * The source identity one candidate dispatches through.
 *
 * The `kind` is `openrouter` for an endpoint and the pi-ai route key for a
 * direct source, so a decision record can rebuild the dispatch target without
 * knowing which `extraSources` entry produced it.
 * @param endpoint - the candidate the decision pinned.
 * @returns where that candidate is dispatched.
 */
export function routingSourceOf(endpoint: Candidate): RoutingSource {
  return isDirect(endpoint)
    ? { kind: endpoint.route, tag: endpoint.id }
    : { kind: 'openrouter', tag: endpoint.slug }
}

/**
 * Project one direct source candidate into the shared event and quote vocabulary.
 *
 * Unlike {@link routingEndpointOf}, a price the source did not stay absent:
 * the quote's zero would read as "free", and a direct source's silence means
 * "not priced here" rather than "costs nothing". The prices are exactly the
 * ones the ranking blended, so a decision log shows why that source won.
 * @param source - the direct candidate.
 * @returns the same facts under the route's own names.
 */
export function routingDirectOf(source: DirectSource): RoutingEndpoint {
  const prices = source.prices
  return {
    tag: source.id,
    providerName: source.route,
    ...prices === undefined ? {} : {
      promptUsd: prices.prompt,
      completionUsd: prices.completion,
      ...prices.cacheRead === undefined ? {} : { cacheReadUsd: prices.cacheRead },
    },
  }
}

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
    ...endpoint.discount === undefined ? {} : { discount: endpoint.discount },
    ...endpoint.contextLength === undefined ? {} : { contextLength: endpoint.contextLength },
    ...endpoint.maxCompletionTokens === undefined ? {} : { maxCompletionTokens: endpoint.maxCompletionTokens },
  }
}
