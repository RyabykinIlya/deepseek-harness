import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { OpenRouterEndpoint } from '@deepseek-ai/dsh-llm-pi-ai'
import { parseOpenRouterEndpoints } from '@deepseek-ai/dsh-llm-pi-ai'

/** Load one recorded `/endpoints` reply and parse it exactly as the wire reader would. */
export async function endpointsOf(model: string): Promise<readonly OpenRouterEndpoint[]> {
  const name = `${model.replace('/', '__').replace(':', '--')}.json`
  const body: unknown = JSON.parse(
    await readFile(fileURLToPath(new URL(`./fixtures/endpoints/${name}`, import.meta.url)), 'utf8'),
  )
  return parseOpenRouterEndpoints(body, model)
}

/** Load every fixture a tier names, in the tier's own model order. */
export async function listsOf(models: readonly string[]): Promise<Map<string, readonly OpenRouterEndpoint[]>> {
  const lists = new Map<string, readonly OpenRouterEndpoint[]>()
  for (const model of models) lists.set(model, await endpointsOf(model))
  return lists
}

/** Load one recorded judge reply. */
export async function decisionOf(name: string): Promise<unknown> {
  return JSON.parse(
    await readFile(fileURLToPath(new URL(`./fixtures/decisions/${name}.json`, import.meta.url)), 'utf8'),
  )
}
