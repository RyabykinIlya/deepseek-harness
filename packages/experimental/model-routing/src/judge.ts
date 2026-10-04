/**
 * The Jev judge: which tier should handle the user's latest request.
 *
 * Two rules govern this module. First, `state` carries **user text only** — no
 * tool output, no file contents. Independent readings of the same model agree that
 * plausible added context flips its verdict ("structured output is not an
 * injection defense", §A.4), and a routing decision that can be steered by what a
 * file happens to contain is not a routing decision. Second, the judge never
 * throws: a routing hint that fails must leave the request running on the tier it
 * was already on, never fail the turn.
 *
 * @module dsh-experimental-model-routing/judge
 */

import type { RequestMessage } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'
import type { RoutingSettings } from './config.ts'
import type { JudgeRule, JudgeVerdict } from './types.ts'

/** What Jev reads about the request it is judging. */
export interface JudgeState {
  latest_user_message: string
  previous_user_messages?: string[]
  compaction_summary?: string
}

/**
 * The typed questions in the Appendix A.2 format, assembled from settings.
 * @param settings - the whole settings value.
 * @returns the `questions` object for one Decisions API call.
 */
export function judgeQuestions(settings: RoutingSettings): Record<string, unknown> {
  return {
    tier: {
      type: 'choice',
      instructions: settings.judgeTierInstructions,
      criteria: {
        [settings.judgeFlashTier]: settings.judgeFlashCriteria,
        [settings.judgeProTier]: settings.judgeProCriteria,
      },
    },
    difficulty: {
      type: 'score',
      instructions: settings.judgeDifficultyInstructions,
      criteria: [...settings.judgeDifficultyLevels],
    },
    precision: {
      type: 'noul',
      instructions: settings.judgePrecisionInstructions,
      criteria: { true: settings.judgePrecisionTrue, false: settings.judgePrecisionFalse },
    },
  }
}

/** Text of a message, or `undefined` when it carries none. */
function textOf(message: RequestMessage): string | undefined {
  const joined = message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
  return joined.length === 0 ? undefined : joined
}

/** Whether one message is something the user wrote. */
function isUserText(message: RequestMessage): boolean {
  if (message.role !== 'user') return false
  // A request user input has no `source` at all; a durable one carries `user`.
  return message.source === undefined || message.source.kind === 'user'
}

/** Cut text to a budget, keeping the beginning and marking the cut. */
function truncate(text: string, budget: number): string {
  return text.length <= budget ? text : `${text.slice(0, Math.max(budget - 1, 0))}…`
}

/**
 * Assemble the judge's state from the request messages.
 *
 * The budget is split rather than shared evenly: the latest message is the one
 * being judged, a compaction summary is the context that explains it, and earlier
 * messages only disambiguate. Anything above `floor(maxChars * 0.5)` in the latest
 * message is noise that would crowd out the answer, and the Decisions API refuses
 * the whole call past 32k tokens rather than truncating for us.
 * @param messages - the request history.
 * @param userMessages - how many earlier user messages to include.
 * @param maxChars - the total character budget for `state`.
 * @returns the state, or `undefined` when the request carries no user text at all.
 */
export function judgeState(
  messages: readonly RequestMessage[],
  userMessages: number,
  maxChars: number,
): JudgeState | undefined {
  const userTexts = messages.filter(isUserText).map(message => textOf(message)).filter((text): text is string => text !== undefined)
  const latest = userTexts.at(-1)
  if (latest === undefined) return undefined
  const earlier = userTexts.slice(0, -1)
  // `slice(-0)` is `slice(0)`, which would return the whole history; taking the
  // tail first and then trimming keeps an explicit zero at zero.
  const previous = userMessages > 0 ? earlier.slice(-userMessages) : []
  const summarySource = messages.filter(message =>
    message.role === 'user' && message.source?.kind === 'compact-checkpoint').at(-1)
  const summary = summarySource === undefined ? undefined : textOf(summarySource)
  const summaryBudget = Math.floor(maxChars * 0.25)
  const latestBudget = Math.floor(maxChars * 0.5)
  const sharedBudget = Math.max(maxChars - latestBudget - summaryBudget, 0)
  const eachBudget = previous.length === 0 ? 0 : Math.floor(sharedBudget / previous.length)
  return {
    latest_user_message: truncate(latest, latestBudget),
    ...previous.length === 0 ? {} : { previous_user_messages: previous.map(text => truncate(text, eachBudget)) },
    ...summary === undefined ? {} : { compaction_summary: truncate(summary, summaryBudget) },
  }
}

/** The Decisions API reply, as far as the verdict reads it. */
export interface DecisionResponse {
  model: string
  answers: {
    tier: { probabilities: Record<string, number>; confidence: number }
    difficulty: { score: number }
    precision: { noul: number }
  }
  usage?: { cost?: number | undefined } | undefined
}

/** Response schema; the judge sends more than this asks for, and that is fine. */
export const DecisionResponseSchema: z.ZodType<DecisionResponse> = z.object({
  model: z.string(),
  answers: z.object({
    tier: z.object({
      type: z.string().optional(),
      choice: z.string().optional(),
      probabilities: z.record(z.string(), z.number()),
      confidence: z.number(),
    }).loose(),
    difficulty: z.object({
      type: z.string().optional(),
      score: z.number(),
    }).loose(),
    precision: z.object({
      type: z.string().optional(),
      noul: z.number(),
    }).loose(),
  }).loose(),
  usage: z.object({ cost: z.number().optional() }).loose().optional(),
  id: z.string().optional(),
  provider: z.string().optional(),
}).loose()

/** Everything one judge call needs, injected so the tests never reach the network. */
export interface JudgeRequest {
  url: string
  apiKey: string
  model: string
  state: JudgeState
  questions: Record<string, unknown>
  proTier: string
  timeoutMs: number
  signal: AbortSignal
  headers: Readonly<Record<string, string>>
  fetch: typeof fetch
  now: () => number
}

/** The largest reply read; a decisions answer is a few hundred bytes. */
const MAX_RESPONSE_BYTES = 256 * 1024

/** Read a body under a hard byte ceiling, reporting an oversized reply rather than truncating it. */
async function readBounded(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (reader === undefined) return response.text()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel()
      throw new Error('response too large')
    }
    chunks.push(value)
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))))
}

/** The best human-usable message an HTTP failure can offer. */
function httpError(status: number, body: string): string {
  let message: string | undefined
  try {
    const parsed: unknown = JSON.parse(body)
    if (typeof parsed === 'object' && parsed !== null) {
      const error = (parsed as { error?: unknown }).error
      if (typeof error === 'object' && error !== null
        && typeof (error as { message?: unknown }).message === 'string') {
        message = (error as { message: string }).message
      }
    }
  } catch {
    // Not JSON; fall back to the raw body.
  }
  return `HTTP ${status}: ${message ?? body.slice(0, 200)}`
}

/**
 * Ask Jev which tier should handle this request.
 *
 * Never rejects: an HTTP status, a network failure, a timeout, an oversized or
 * invalid reply all come back as a verdict with `error` set and no probabilities,
 * so the caller keeps the tier it already had. The timeout is combined with the
 * caller's own signal so a cancelled request is not reported as a judge failure.
 * @param request - the call's inputs, with `fetch` and `now` injected.
 * @returns the verdict; the caller adds the `rule` that fired.
 */
export async function askJudge(request: JudgeRequest): Promise<Omit<JudgeVerdict, 'rule'>> {
  const started = request.now()
  const fail = (error: string): Omit<JudgeVerdict, 'rule'> => ({
    model: request.model,
    latencyMs: request.now() - started,
    error,
  })
  let response: Response
  try {
    response = await request.fetch(request.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${request.apiKey}`,
        'content-type': 'application/json',
        ...request.headers,
      },
      body: JSON.stringify({ model: request.model, state: request.state, questions: request.questions }),
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(request.timeoutMs)]),
    })
  } catch (error: unknown) {
    // A rejected `fetch` is the timeout, the caller's cancellation, or the
    // transport; all three mean the same thing here — no verdict.
    return fail(`HTTP 0: ${error instanceof Error ? error.message : String(error)}`)
  }
  let body: string
  try {
    body = await readBounded(response)
  } catch (error: unknown) {
    return fail(error instanceof Error ? error.message : String(error))
  }
  if (!response.ok) return fail(httpError(response.status, body))
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return fail(`HTTP ${response.status}: response is not JSON`)
  }
  const decoded = DecisionResponseSchema.safeParse(parsed)
  if (!decoded.success) return fail(`HTTP ${response.status}: response does not match the decision schema`)
  const { model, answers, usage } = decoded.data
  const pPro = answers.tier.probabilities[request.proTier]
  return {
    model: request.model,
    answeredBy: model,
    // A verdict with no probability for the pro tier is a verdict the model
    // could not place; `tierFromVerdict` reads the absence as zero, which routes
    // it to flash rather than guessing pro.
    ...pPro === undefined ? {} : { pPro },
    confidence: answers.tier.confidence,
    difficulty: answers.difficulty.score,
    precision: answers.precision.noul,
    ...usage?.cost === undefined ? {} : { costUsd: usage.cost },
    latencyMs: request.now() - started,
  }
}

/**
 * Translate a verdict into the tier this session should run on.
 *
 * The rules are ordered cheapest-first and each one exists for a specific
 * conversation: a high-precision request is pro whatever the probabilities say, a
 * low-confidence verdict is not worth acting on, and a session already running on
 * `pro` is never moved down on one bad reading — only a clearly easy one.
 * @param verdict - the judge's answer, with or without an error.
 * @param current - the tier the session is pinned on, `undefined` at session start.
 * @param settings - the whole settings value, carrying the thresholds.
 * @returns the tier to run on and the rule that chose it.
 */
export function tierFromVerdict(
  verdict: Omit<JudgeVerdict, 'rule'>,
  current: string | undefined,
  settings: RoutingSettings,
): { tier: string; rule: JudgeRule } {
  const fallback = current ?? settings.defaultTier
  if (verdict.error !== undefined) return { tier: fallback, rule: 'judge-error' }
  const pPro = verdict.pPro ?? 0
  if ((verdict.precision ?? 0) >= settings.judgePrecisionProAt) return { tier: settings.judgeProTier, rule: 'precision' }
  if ((verdict.confidence ?? 0) < settings.judgeMinConfidence) return { tier: fallback, rule: 'low-confidence' }
  if (current === undefined) {
    return pPro >= settings.judgeStartProAt
      ? { tier: settings.judgeProTier, rule: 'start-pro' }
      : { tier: settings.judgeFlashTier, rule: 'start-flash' }
  }
  if (current === settings.judgeFlashTier && pPro >= settings.judgeToProAt) {
    return { tier: settings.judgeProTier, rule: 'to-pro' }
  }
  if (current === settings.judgeProTier && pPro <= settings.judgeToFlashAt) {
    return { tier: settings.judgeFlashTier, rule: 'to-flash' }
  }
  return { tier: current, rule: 'keep' }
}
