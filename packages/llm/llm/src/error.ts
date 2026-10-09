/**
 * Harness error base with a stable machine-routable code and chained cause.
 * Package errors extend it so tool results and replay can retain failure class.
 * @module @deepseek-ai/dsh-llm/error
 */

/**
 * Base class for all harness errors. Carries a `code` (stable, programmatic —
 * e.g. `NO_ADAPTER`, `INVALID_ARGS`) distinct from the
 * human-readable `message`, and supports `cause` chaining via the standard
 * `ErrorOptions`. `name` defaults to the subclass constructor name.
 */
export class HarnessError extends Error {
  /** Stable machine-routable failure class (e.g. `RATE_LIMIT`); route on this, never by parsing `message`. */
  readonly code: string

  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, options)
    this.code = code
    this.name = new.target.name
  }
}

/** Canonical provider-neutral code for a model request rejected because its context window was exceeded. */
export const CONTEXT_WINDOW_EXCEEDED_CODE = 'CONTEXT_WINDOW_EXCEEDED'

/** Canonical provider-neutral code for an exhausted account quota or balance. */
export const QUOTA_EXCEEDED_CODE = 'QUOTA'

/** Account-token quota that can be replenished through the first-party billing page. */
export const ACCOUNT_QUOTA_EXCEEDED_CODE = 'ACCOUNT_QUOTA'

/**
 * Canonical provider-neutral code for a request rejected because one supplied
 * API key reached its own usage ceiling. Distinct from `QUOTA` because the
 * remedy differs: rotating to another key unblocks the request, while an
 * exhausted `QUOTA` (account balance, credits, billing plan) stays blocked for
 * every key on the account. Also distinct from `RATE_LIMIT`, which clears on
 * its own — a per-key ceiling does not, so retrying the same key is pointless.
 */
export const KEY_QUOTA_EXCEEDED_CODE = 'KEY_QUOTA'

/**
 * Canonical provider-neutral code for a gateway that rejected the client's
 * identity rather than the request. Gateways reselling a first-party client
 * (for example Claude Code relays) fingerprint requests and answer a client
 * that does not look like their expected one with a 400 naming the client —
 * "client anomaly", "use the standard Claude Code client" — while the request
 * itself is servable by any other route. Distinct from `INVALID_REQUEST`
 * because the remedy differs: reroute to another route instead of failing
 * the turn, and distinct from every quota code because the rejection does not
 * clear with time, keys, or balance — it follows the client.
 */
export const CLIENT_GATE_REJECTED_CODE = 'CLIENT_GATE'

/** Client-identity gate wording: the gateway names the client, not the request, as the problem. */
const CLIENT_GATE_REJECTION = new RegExp(
  String.raw`\banomaly in your client\b`
  + String.raw`|\b(?:standard|official)\s+claude\s+code\s+client\b`
  + String.raw`|аномали[а-яё]*\s+клиент`
  + String.raw`|(?:стандартн[а-яё]*|официальн[а-яё]*)\s+клиент\s+claude\s+code`,
  'i',
)

/**
 * Recognize the wording of a client-identity gate rejection: the gateway
 * answers that this client is not the one it serves ("an anomaly in your
 * client", "use the standard Claude Code client") instead of naming a defect
 * in the request. Such a rejection follows the client, so retrying the same
 * route is pointless while the same request can succeed elsewhere.
 * @param detail - provider error code/type/message text joined into one string.
 * @returns true only when the text names the client as the rejected party.
 */
export function isClientGateRejectedError(detail: string): boolean {
  return CLIENT_GATE_REJECTION.test(detail)
}

/**
 * Canonical provider-neutral code for a response that completed normally but
 * carried no content blocks at all. Providers occasionally emit a degenerate
 * completion (a terminal stop with zero output); adapters classify it as this
 * failure instead of yielding an empty assistant message, because an empty
 * message silently ends the turn with nothing for the user or the loop to act
 * on. The attempt produced nothing durable, so retry policy treats it as safe
 * to repeat.
 */
export const EMPTY_RESPONSE_CODE = 'EMPTY_RESPONSE'

/**
 * Canonical provider-neutral code for a credential that was supplied but
 * cannot be used — malformed rather than absent. Distinct from
 * `MISSING_CREDENTIAL` because the fix differs: correct the stored value
 * rather than supply one. Deliberately outside the default retryable set —
 * a malformed credential fails identically on every attempt.
 */
export const INVALID_CREDENTIAL_CODE = 'INVALID_CREDENTIAL'

/** Structured codes and plain phrases that explicitly name a context bound being exceeded. */
const STRUCTURED_CONTEXT_OVERFLOW = new RegExp(
  String.raw`(?:^|[^a-z0-9])context[\s_-](?:length|window)[\s_-]`
  + String.raw`(?:exceed(?:ed|s)?|overflow(?:ed)?|limit[\s_-]exceeded)(?:$|[^a-z0-9])`,
  'i',
)

/** Request-size wording that ties "too large" directly to model context capacity. */
const TOO_LARGE_FOR_CONTEXT = new RegExp(
  String.raw`\b(?:request|prompt|input|messages?)\s+(?:is\s+|are\s+)?`
  + String.raw`too\s+(?:large|long)\s+for\s+(?:(?:this|the)\s+)?`
  + String.raw`(?:model(?:'s)?\s+)?context(?:\s+window)?\b`,
  'i',
)

/** "Exceeds" wording is safe only when its object is explicitly the model context. */
const EXCEEDS_MODEL_CONTEXT = new RegExp(
  String.raw`\b(?:input|prompt|request|messages?)\b.{0,40}`
  + String.raw`\b(?:exceed(?:s|ed)?|overflows?|is\s+larger\s+than)\b.{0,40}`
  + String.raw`\b(?:the\s+)?(?:model(?:'s)?\s+)?context(?:\s+(?:length|window))?\b`,
  'i',
)

/**
 * Recognize the context-overflow wording used by OpenAI-compatible providers
 * and library adapters. Adapters pass all available provider code, type, and
 * message text so both thrown and in-band delivery styles share one classifier.
 * @param detail - provider error code/type/message text joined into one string.
 * @returns true when the detail identifies a request exceeding the model context window.
 */
export function isContextWindowExceededError(detail: string): boolean {
  return STRUCTURED_CONTEXT_OVERFLOW.test(detail)
    || /\b(?:maximum|max)(?:\s+(?:allowed|supported))?\s+context\s+(?:length|window)\b/i.test(detail)
    || TOO_LARGE_FOR_CONTEXT.test(detail)
    || /\b(?:input|prompt|request)\s+(?:is\s+)?too\s+(?:long|large)\s+for\s+(?:this|the)\s+model\b/i.test(detail)
    || EXCEEDS_MODEL_CONTEXT.test(detail)
}

/** Account-level exhaustion wording that names the account rather than a single key. */
const ACCOUNT_LIMIT_REACHED = new RegExp(
  String.raw`\b(?:account|organization|organisation|org|tenant|workspace)\b[^.!?\n]{0,40}?`
  + String.raw`\b(?:reached|exceeded|exhausted|hit|depleted)\b[^.!?\n]{0,20}?`
  + String.raw`\b(?:quota|usage[\s_-]+limit|credits?|balance)\b`,
  'i',
)

/** A key named as the subject that reached or exhausted its own ceiling. */
const KEY_REACHED_ITS_LIMIT = new RegExp(
  String.raw`\b(?:api[\s_-]+)?key(?:'s)?\b[^.!?\n]{0,24}?`
  + String.raw`\b(?:reached|hit|exceeded|maxed)\b[^.!?\n]{0,20}?`
  + String.raw`\b(?:usage[\s_-]+limit|quota|budget|cap)\b`,
  'i',
)

/** Reversed order: the key's usage/request limit is named first and the ceiling verb follows. */
const KEY_LIMIT_REACHED = new RegExp(
  String.raw`\b(?:api[\s_-]+)?key[\s_-]+(?:usage[\s_-]+|request[\s_-]+)?limit[\s_-]+`
  + String.raw`(?:reached|exceeded|exhausted|hit)\b`,
  'i',
)

/** A key reported as exhausted/depleted with no limit noun present. */
const KEY_EXHAUSTED = new RegExp(
  String.raw`\b(?:api[\s_-]+)?key\b(?:\s+(?:has|have|had|is|was|been))*\s*`
  + String.raw`\b(?:exhausted|depleted)\b`,
  'i',
)

/**
 * Recognize provider wording that identifies one API key reaching its own
 * usage ceiling, as opposed to an account-wide quota or a transient request
 * rate. The distinction routes recovery: a per-key ceiling is worked around by
 * rotating keys, while an account quota stays blocked for every key. Also
 * matches the proxy wording "This API key reached its usage limit", whose
 * subject-then-limit word order {@link isQuotaExceededError} does not cover.
 * @param detail - provider error code/type/message text joined into one string.
 * @returns true only when a key is named as the thing that hit its limit.
 */
export function isKeyQuotaExceededError(detail: string): boolean {
  return KEY_REACHED_ITS_LIMIT.test(detail)
    || KEY_LIMIT_REACHED.test(detail)
    || KEY_EXHAUSTED.test(detail)
}

/**
 * Recognize provider wording that identifies an exhausted account quota rather
 * than a transient request-rate limit. The `usage limit` alternative excludes a
 * preceding `key` so a per-key ceiling stays on the {@link isKeyQuotaExceededError}
 * path instead of reading as an account-wide one; the predicates stay disjoint.
 * @param detail - provider error code/type/message text joined into one string.
 * @returns true only for terminal quota, balance, credit, budget, or usage-limit wording.
 */
export function isQuotaExceededError(detail: string): boolean {
  return /\binsufficient[\s_-]+(?:quota|balance|credits?)\b/i.test(detail)
    || /\b(?:quota|(?<!key[\s_-]+)usage[\s_-]+limit)[\s_-]+(?:exceeded|exhausted|reached)\b/i.test(detail)
    || /\bexceed(?:ed|s)?[\s_-]+(?:(?:your|the)[\s_-]+)?(?:current[\s_-]+)?quota\b/i.test(detail)
    || /\b(?:balance|credits?)[\s_-]+(?:exhausted|depleted)\b/i.test(detail)
    || /\bout[\s_-]+of[\s_-]+(?:credits?|budget)\b/i.test(detail)
    || ACCOUNT_LIMIT_REACHED.test(detail)
}

/**
 * Render a thrown value with its full `cause` chain and AggregateError
 * members, so transport wrappers like undici's `TypeError: fetch failed`
 * surface the underlying failure instead of masking it. Plain structured
 * failures render their own data-backed `message`. Diagnostic-surface
 * rendering only (messages, notices, logs) — never parse the result; route on
 * {@link HarnessError.code}.
 * @param value - the caught value (`unknown` in catch clauses).
 * @returns the outermost message first, each cause appended with `: ` (skipped
 * when it repeats the wrapper message verbatim), and AggregateError members
 * bracketed and `; `-joined.
 */
export function errorChain(value: unknown): string {
  // Tracks the active recursion path (entries removed on exit), so only true
  // cycles are flagged and a diamond-shared cause still renders in full.
  const path = new Set<unknown>()
  const render = (current: unknown): string => {
    if (path.has(current)) return '<circular cause>'
    path.add(current)
    try {
      if (!(current instanceof Error)) {
        if (typeof current === 'object' && current !== null) {
          const descriptor = Object.getOwnPropertyDescriptor(current, 'message')
          if (descriptor !== undefined && 'value' in descriptor && typeof descriptor.value === 'string') {
            return descriptor.value
          }
        }
        return String(current)
      }
      const message = current.message === '' ? current.name : current.message
      const members = current instanceof AggregateError && current.errors.length > 0
        ? ` [${current.errors.map(render).join('; ')}]`
        : ''
      const causeText = current.cause === undefined || current.cause === null
        ? ''
        : render(current.cause)
      // Wrappers like `new HarnessError(String(value), code, { cause: value })`
      // repeat their cause verbatim; rendering it again would only add noise.
      const cause = causeText === '' || causeText === message ? '' : `: ${causeText}`
      return `${message}${members}${cause}`
    } catch {
      // Only hostile coercion or hostile accessors (a throwing toString /
      // Symbol.toPrimitive on a non-Error, or a throwing message/name/cause/
      // errors getter on an Error subclass): this renderer feeds UI notices
      // and logs, so nothing may escape. Inner frames catch their own throws,
      // so only the hostile node collapses, not the whole chain.
      return '<unrenderable value>'
    } finally {
      path.delete(current)
    }
  }
  return render(value)
}

/**
 * Narrow an arbitrary thrown value to a HarnessError (for `instanceof` at runtime boundaries).
 * @param value - the caught value (`unknown` in catch clauses).
 * @returns true only for real instances; duck-typed or cross-realm errors do not narrow.
 */
export function isHarnessError(value: unknown): value is HarnessError {
  return value instanceof HarnessError
}

/**
 * Canonical code for a request an image-capable route cannot send until more
 * of its images are offloaded. The failure's `offloadImages` names how many
 * more of the oldest retained occurrences must be offloaded;
 * `dsh-compaction-image-offload` records an `image/offload` selection before
 * the agent or summarizer retries with freshly derived input.
 */
export const IMAGE_OFFLOAD_REQUIRED_CODE = 'IMAGE_OFFLOAD_REQUIRED'
