/**
 * Generic pi-ai-backed implementation of the Harness LLM seam.
 *
 * Each resolution produces one **immutable** snapshot — the profiles plus a
 * `Models` collection holding the `Provider` each route built — and an
 * operation captures a whole snapshot before its first `await`. A
 * configuration change builds a *new* collection rather than mutating the one
 * in use, because `Models.streamSimple()` is lazy: it resolves the provider
 * when the stream is first consumed, which is after the credential await, so a
 * mutated collection would let a request that started under one configuration
 * finish under another — or fail with a provider that no longer exists. This is
 * what makes the seam's per-step call freeze (`llm.prepareCall()`) hold all the
 * way down: switching models mid-reply takes effect on the next step, never
 * inside the one in flight.
 *
 * A route naming a credential reference still resolves it through the harness
 * seam and passes it as the request's `apiKey` option, which pi-ai treats as
 * the highest-priority auth override — that is what keeps the fail-loud
 * reference semantics. Everything that override does not cover reaches pi-ai
 * through the collection's own auth: the credential store holds the records a
 * login wrote and a refresh rotates, and the auth context answers the ambient
 * questions a provider asks while resolving. Both are stable across snapshots,
 * so a configuration change rebuilds the collection without forgetting who is
 * signed in.
 *
 * @module dsh-llm-pi-ai/adapter
 */

import type {
  Api,
  AuthContext,
  CredentialStore,
  Model,
  Models,
  ModelThinkingLevel,
  MutableModels,
  SimpleStreamOptions,
  ThinkingLevel,
} from '@earendil-works/pi-ai'
import {
  attributionHeaders,
  contentHasImage,
  KEY_QUOTA_EXCEEDED_CODE,
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  ImageAttachmentAccess,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  PreparedAdapterCall,
  ReasoningEffortId as ReasoningEffortIdType,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { ResolvedPiAiProviderProfile } from './config.ts'
import { toPiContext } from './context.ts'
import type { PiAiDispatchOptions } from './dispatch.ts'
import { createModels, getSupportedThinkingLevels } from './models.ts'
import type { OpenRouterRoutingBlock } from './dispatch.ts'
import { toStreamChunks } from './stream.ts'

/**
 * The model descriptor a request dispatches under, with its routing block
 * replaced by one resolved for this call.
 *
 * The copy is shallow and per-call: the resolved model belongs to an immutable
 * snapshot that other in-flight requests are reading, so mutating its compat
 * would repin a request that already started. Only the compat block is replaced,
 * and only when a block was resolved, so a plain route dispatches the very object
 * the catalog produced.
 * @param model - the snapshot's model descriptor.
 * @param block - the routing block resolved for this call.
 * @returns a descriptor carrying the resolved block, or the original when none was resolved.
 */
function withRouting(model: Model<Api>, block: OpenRouterRoutingBlock | undefined): Model<Api> {
  if (block === undefined) return model
  return { ...model, compat: { ...model.compat, openRouterRouting: block } }
}

/**
 * Whether one chunk carries model output, which is what commits an attempt to
 * the key that produced it.
 *
 * `usage` and `finish` are bookkeeping: a terminal failure chunk emits a
 * `usage` bookkeeping chunk immediately before itself (see `toStreamChunks`),
 * so an attempt that never reached content is exactly one whose buffered
 * chunks are all bookkeeping. Everything else is content.
 * @param chunk - one chunk from an attempt.
 * @returns true when the chunk is model output rather than bookkeeping.
 */
function isContentChunk(chunk: StreamChunk): boolean {
  return chunk.type !== 'usage' && chunk.type !== 'finish'
}

/**
 * Whether one attempt's terminal event says the credential it used reached its
 * own usage ceiling.
 *
 * Read from the finish failure's code, never its message: `KEY_QUOTA` is the
 * classification `toStreamChunks` already makes distinct from an account-wide
 * `QUOTA` and from a transient `RATE_LIMIT`, which is the distinction rotation
 * turns on — another key unblocks the first, and no key unblocks the other two.
 * @param chunk - the attempt's `finish` chunk.
 * @returns true when this key is exhausted and another may be tried.
 */
function isKeyQuotaFinish(chunk: StreamChunk): boolean {
  return chunk.type === 'finish'
    && chunk.reason.kind === 'error'
    && chunk.reason.failure.code === KEY_QUOTA_EXCEEDED_CODE
}

/** One resolution's frozen view: the profiles and the collection built from them. */
interface PiAiSnapshot {
  /** The resolved profiles this collection was built from, used as its identity. */
  profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>
  /** Providers for exactly those profiles; never mutated once published. */
  models: Models
}

/**
 * The cross-request key-rotation state one adapter consults.
 *
 * It lives outside the adapter because exhaustion outlives one operation: a
 * key the provider reported exhausted must stay out of rotation for its
 * cooldown, across every request that arrives in the meantime. Keeping it here
 * also keeps the adapter free of a mutable cache that a configuration change
 * would have to remember to clear.
 */
export interface PiAiKeyRotation {
  /**
   * The credentials one request may try, in order, with references currently
   * inside their cooldown omitted.
   * @param provider - the route key.
   * @param profile - the resolved profile the request captured.
   * @returns the candidate references; an empty list for a keyless route.
   */
  candidates: (provider: string, profile: ResolvedPiAiProviderProfile) => readonly CredentialRef[]
  /**
   * Record that one reference reported its own usage ceiling, starting its
   * cooldown for later requests.
   * @param provider - the route key.
   * @param ref - the exhausted reference.
   * @param cooldownMs - how long it stays out of rotation, as the operation
   *   captured from its own profile.
   */
  exhaust: (provider: string, ref: CredentialRef, cooldownMs: number) => void
}

/** Constructor options for {@link PiAiAdapter}: the two resolution hooks the plugin owns. */
export interface PiAiAdapterOptions {
  /** Current validated profiles by provider route; called once per operation. */
  profiles: () => ReadonlyMap<string, ResolvedPiAiProviderProfile>
  /**
   * Resolve the credential one attempt uses; called once per attempt and
   * frozen for it. `undefined` defers to the route's own pi-ai auth, which for
   * an installed catalog route is its provider-native ambient discovery; the
   * plugin allows that only when the profile names no credential at all,
   * because a named reference that misses throws `LlmError`
   * `MISSING_CREDENTIAL` rather than falling back.
   * @param provider - the route key.
   * @param profile - the resolved profile this operation captured.
   * @param ref - the specific reference this attempt authenticates with, or
   *   `undefined` for the keyless posture.
   * @returns the usable key, or undefined when the route names none.
   */
  resolveApiKey: (
    provider: string,
    profile: ResolvedPiAiProviderProfile,
    ref: CredentialRef | undefined,
  ) => Promise<string | undefined>
  /**
   * Rotation state and cooldown policy for a route naming several credentials.
   * Omission keeps the single-credential behavior for every route: one attempt
   * with `profile.apiKeyEnv` and no rotation.
   */
  keyRotation?: PiAiKeyRotation
  /**
   * How every collection this adapter builds resolves auth the request-level
   * `apiKey` override does not cover. Required rather than optional: a
   * collection built without them gets pi-ai's in-memory default store, which
   * is empty at every boot and discarded on every configuration change, so a
   * route whose only method is a login would report itself unconfigured on
   * every request no matter how often the human signed in.
   */
  auth: PiAiAuthInjection
  /** Resolve the optional durable attachment service at request time. */
  resolveAttachments?: () => AttachmentStore | undefined
  /** Bridge one attachment reference into the current model-tool execution world. */
  resolveImageAccess?: (attachments: AttachmentStore, ref: ImageAttachmentRef) => ImageAttachmentAccess | undefined
  /**
   * Observe one assistant history message degrading to provider-neutral
   * conversion because its stored replay state is unusable by this build.
   */
  onReplayDegrade?: (detail: { provider: string; model: string; reason: string }) => void
}

/** The two auth injectables a pi-ai collection is built with. */
export interface PiAiAuthInjection {
  /** Durable storage for credentials pi-ai itself writes: logins, and the refreshes it runs under its own lock. */
  credentials: CredentialStore
  /** Ambient lookups a provider performs while resolving its own auth. */
  authContext: AuthContext
}

/** Copy profile stream knobs into pi-ai's common option vocabulary. */
function profileOptions(
  profile: ResolvedPiAiProviderProfile,
  reasoning: ModelThinkingLevel | undefined,
  apiKey: string | undefined,
): SimpleStreamOptions {
  const enabledReasoning: ThinkingLevel | undefined = reasoning === 'off' ? undefined : reasoning
  return {
    ...apiKey === undefined ? {} : { apiKey },
    ...enabledReasoning === undefined ? {} : { reasoning: enabledReasoning },
    ...profile.thinkingBudgets === undefined ? {} : { thinkingBudgets: profile.thinkingBudgets },
    ...profile.cacheRetention === undefined ? {} : { cacheRetention: profile.cacheRetention },
    ...profile.transport === undefined ? {} : { transport: profile.transport },
    ...profile.timeoutMs === undefined ? {} : { timeoutMs: profile.timeoutMs },
    ...profile.websocketConnectTimeoutMs === undefined ? {} : { websocketConnectTimeoutMs: profile.websocketConnectTimeoutMs },
    // The agent recovery layer owns visible attempts; one adapter call is one SDK attempt.
    maxRetries: 0,
  }
}

/**
 * The profile default this exact model can actually take, for DESCRIBING it.
 * A configured level the model does not support yields none rather than
 * throwing: `resolveModel` builds the model catalog, and a catalog that fails
 * takes its whole provider out of every picker — so one mis-set profile field
 * would hide every model on the route, including the ones that support the
 * level. The request path still refuses, which is where a bad configuration
 * belongs: describing what a model can do must not fail because a deployment
 * asked it for something it cannot.
 * @param model - the resolved model descriptor.
 * @param effort - the profile's configured level, if any.
 * @returns the level when this model supports it, otherwise undefined.
 */
function describableReasoningLevel(
  model: Model<Api>,
  effort: ReasoningEffortIdType | ModelThinkingLevel | undefined,
): ModelThinkingLevel | undefined {
  if (effort === undefined) return undefined
  return getSupportedThinkingLevels(model).some(level => level === effort)
    ? effort as ModelThinkingLevel
    : undefined
}

/** Validate an explicit Harness/profile effort without invoking pi-ai's clamp. */
function resolveReasoningLevel(
  model: Model<Api>,
  effort: ReasoningEffortIdType | ModelThinkingLevel | undefined,
): ModelThinkingLevel | undefined {
  if (effort === undefined) return undefined
  const supported = getSupportedThinkingLevels(model)
  if (supported.some(level => level === effort)) return effort as ModelThinkingLevel
  throw new LlmError(
    `pi-ai provider "${model.provider}" model "${model.id}" does not support reasoning effort "${effort}"`,
    'UNSUPPORTED_REASONING_EFFORT',
  )
}

/**
 * Selectable reasoning efforts for one model, or nothing at all.
 *
 * A model that carries no reasoning metadata — every hand-declared one, and
 * every catalog model pi-ai marks as non-reasoning — is reported by pi-ai as
 * supporting the single level `off`. Passing that through would offer a control
 * that cannot do what it says: `off` is translated to *omitting* the reasoning
 * option, which for such a model is byte-for-byte the same request as naming no
 * effort — so a provider whose own default is to think would keep thinking with
 * `off` selected. Omitting `reasoning` entirely is the seam's way of saying the
 * capability is unavailable, which leaves the surface offering only the
 * provider's default.
 * @param model - the resolved model descriptor.
 * @param defaultLevel - the profile's configured effort, already validated.
 * @returns the `reasoning` field, or an empty object when none can be offered.
 */
function reasoningInfo(
  model: Model<Api>,
  defaultLevel: ModelThinkingLevel | undefined,
): Pick<LlmResolvedModelInfo, 'reasoning'> | Record<string, never> {
  if (!model.reasoning) return {}
  const levels = getSupportedThinkingLevels(model)
  return {
    reasoning: {
      efforts: levels.map(level => ({
        id: ReasoningEffortId(level),
        name: `${level.charAt(0).toUpperCase()}${level.slice(1)}`,
      })),
      ...defaultLevel === undefined ? {} : { defaultEffort: ReasoningEffortId(defaultLevel) },
    },
  }
}

/** Merge deployment headers while removing case-insensitive attribution collisions. */
function requestHeaders(headers: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const attribution = attributionHeaders()
  const reserved = new Set(Object.keys(attribution).map(name => name.toLowerCase()))
  return {
    ...Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => !reserved.has(name.toLowerCase()))),
    ...attribution,
  }
}

/**
 * pi-ai-backed multi-provider adapter. Each operation reads the current
 * profiles, so a configuration change reaches the next request without a
 * restart; model descriptors come from the collection those profiles built.
 */
export class PiAiAdapter extends LlmAdapter {
  private snapshot: PiAiSnapshot | undefined

  constructor(private readonly config: PiAiAdapterOptions) {
    super()
  }

  /**
   * The snapshot for the current profiles. Resolution memoizes its result, so
   * an unchanged configuration is recognized by identity; a changed one gets a
   * brand-new collection, leaving any snapshot an operation already captured
   * untouched for as long as that operation holds it.
   */
  private current(): PiAiSnapshot {
    const profiles = this.config.profiles()
    if (this.snapshot?.profiles === profiles) return this.snapshot
    const models: MutableModels = createModels(this.config.auth)
    for (const profile of profiles.values()) {
      if (profile.piProvider !== undefined) models.setProvider(profile.piProvider)
    }
    this.snapshot = { profiles, models }
    return this.snapshot
  }

  /** The profile for one route within one snapshot, or the not-owned failure. */
  private profileOf(snapshot: PiAiSnapshot, provider: string): ResolvedPiAiProviderProfile {
    const profile = snapshot.profiles.get(provider)
    if (profile === undefined) {
      throw new LlmError(`pi-ai adapter does not own provider "${provider}"`, 'NO_ADAPTER')
    }
    return profile
  }

  /** The configured descriptor for one exact route/model pair within one snapshot. */
  private modelOf(snapshot: PiAiSnapshot, provider: string, model: string): Model<Api> {
    const profile = this.profileOf(snapshot, provider)
    const failure = profile.modelErrors.get(model)
      ?? (profile.piProvider === undefined ? profile.catalogError : undefined)
    if (failure !== undefined) throw new LlmError(failure, 'INVALID_CONFIG')
    const resolved = snapshot.models.getModel(provider, model)
    if (resolved === undefined) {
      throw new LlmError(`pi-ai provider "${provider}" has no configured model "${model}"`, 'UNKNOWN_MODEL')
    }
    return resolved
  }

  override providerInfo(provider: string): LlmProviderInfo {
    // The configured name, not the route key: `displayName` exists so a
    // deployment can label a route, and a label only the configuration surface
    // reads would leave every selector showing the raw key.
    return { id: provider, name: this.current().profiles.get(provider)?.displayName ?? provider }
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined {
    return this.current().profiles.get(provider)?.retryPolicy
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve().then(() => {
      const snapshot = this.current()
      this.profileOf(snapshot, provider)
      return snapshot.models.getModels(provider).map(model => ({
        provider,
        id: model.id,
        name: model.name,
        inputModalities: [...model.input],
      }))
    })
  }

  override resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return Promise.resolve().then(() => {
      const snapshot = this.current()
      return this.modelInfo(snapshot, provider, model)
    })
  }

  private modelInfo(snapshot: PiAiSnapshot, provider: string, model: string): LlmResolvedModelInfo {
    const profile = this.profileOf(snapshot, provider)
    const resolvedModel = this.modelOf(snapshot, provider, model)
    const defaultLevel = describableReasoningLevel(resolvedModel, profile.reasoning)
    // Only a cap the deployment configured is a request default; the
    // catalog's `maxTokens` sizes the model and stops there.
    const configuredMaxTokens = profile.configuredMaxTokens.get(model)
    return {
      provider,
      id: model,
      name: resolvedModel.name,
      inputModalities: [...resolvedModel.input],
      context: { contextWindow: resolvedModel.contextWindow },
      ...configuredMaxTokens === undefined ? {} : { defaultMaxTokens: configuredMaxTokens },
      ...reasoningInfo(resolvedModel, defaultLevel),
    }
  }

  override prepareCall(provider: string, model: string, _signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const snapshot = this.current()
    return Promise.resolve({
      model: this.modelInfo(snapshot, provider, model),
      stream: options => this.streamWithSnapshot(options, snapshot, {}),
    })
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.streamWithSnapshot(options, this.current(), {})
  }

  /**
   * One stream call carrying a routing block of the caller's choosing.
   *
   * This is what `ctx.piAiDispatch` publishes as `stream`; the block reaches the
   * wire exactly as a configured `compat.openRouterRouting` would, because pi-ai
   * copies it verbatim onto the request body. Everything else — the snapshot the
   * call froze under, credential resolution, the idle watchdog, consumer
   * teardown — is the same path {@link PiAiAdapter.stream} takes.
   * @param options - the request; its `provider` must be a pi-ai route this adapter owns.
   * @param dispatch - per-call options.
   * @returns the chunk stream of one provider attempt.
   */
  dispatch(options: GenerateOptions, dispatch: PiAiDispatchOptions): AsyncIterable<StreamChunk> {
    return this.streamWithSnapshot(options, this.current(), dispatch)
  }

  private async * streamWithSnapshot(
    options: GenerateOptions,
    snapshot: PiAiSnapshot,
    dispatch: PiAiDispatchOptions,
  ): AsyncIterable<StreamChunk> {
    if (options.stop !== undefined) {
      throw new LlmError('llm-pi-ai does not support GenerateOptions.stop', 'UNSUPPORTED_OPTION')
    }
    // One capture per stream call, taken before any await: the profile, the
    // model descriptor, and the collection all come from the same immutable
    // snapshot, and the credential freezes with them. A configuration change
    // mid-request builds a separate snapshot, so this request finishes under
    // the one it started with and the next call picks up the new one.
    const profile = this.profileOf(snapshot, options.provider)
    const model = this.modelOf(snapshot, options.provider, options.model)
    const reasoning = resolveReasoningLevel(
      model,
      options.reasoningEffort ?? profile.reasoning,
    )
    // Choosing a key is not a retry: one adapter call is still one SDK attempt
    // (`profileOptions` pins `maxRetries: 0`), and every key below is tried
    // inside that single attempt. Without the rotation state the route keeps
    // its single-credential behavior.
    const candidates = this.config.keyRotation?.candidates(options.provider, profile)
      ?? (profile.apiKeyEnv === undefined ? [] : [profile.apiKeyEnv])
    // Whether the route names a credential at all is read from the profile, not
    // from this list: every key can be inside its cooldown, which leaves the
    // list empty while the route is still a keyed one. Falling through to
    // pi-ai's ambient discovery then would authenticate with an unrelated
    // ambient key — the exact substitution a named reference exists to prevent.
    const keyless = profile.apiKeys.length === 0
    const attempted = new Set<CredentialRef>()
    for (;;) {
      const ref = candidates.find(candidate => !attempted.has(candidate))
      if (ref === undefined && keyless) {
        // One attempt that leaves the credential for pi-ai's own
        // provider-native discovery to answer.
        const ambient = await this.config.resolveApiKey(options.provider, profile, undefined)
        yield* this.attemptStream(options, snapshot, dispatch, profile, model, reasoning, ambient)
        return
      }
      if (ref === undefined) {
        // Two ways to arrive here, and the remedy differs: every key was tried
        // on this request, or the ones left are still cooling from an earlier
        // one. The second is the more common by far once a route is in
        // rotation, so it names the cooldown rather than the attempt count.
        const attemptedCount = attempted.size
        throw new LlmError(
          attemptedCount === candidates.length
            ? `llm-pi-ai: route "${options.provider}" exhausted all ${String(candidates.length)} API`
              + ` key${candidates.length === 1 ? '' : 's'} for one request; each reported its own usage ceiling`
              + ' (KEY_QUOTA), so another key or a higher per-key budget is what unblocks it — this is not the'
              + ' account balance, which no key change fixes'
            : `llm-pi-ai: route "${options.provider}" has no API key to try: of the`
              + ` ${String(profile.apiKeys.length)} the profile names, every one is still inside its`
              + ` keyCooldownMs (${String(profile.keyCooldownMs ?? 0)}ms) after reporting its own usage ceiling`
              + ' (KEY_QUOTA), so the next request succeeds once one expires',
          KEY_QUOTA_EXCEEDED_CODE,
        )
      }
      const apiKey = await this.config.resolveApiKey(options.provider, profile, ref)
      // `AsyncIterable` hides its iterator type, so this names the one the
      // generator method already produces without converting any value.
      const attempt = this
        .attemptStream(options, snapshot, dispatch, profile, model, reasoning, apiKey)
        [Symbol.asyncIterator]() as AsyncGenerator<StreamChunk>
      // A key may be rotated away from only while this attempt has produced no
      // content: pi-ai reports a failure as a terminal in-band event, so the
      // reason is unknown until its finish chunk arrives, by which point bytes
      // already yielded to the caller cannot be taken back.
      const buffered: StreamChunk[] = []
      let outcome: StreamChunk | undefined
      let sawContent = false
      for (;;) {
        const next = await attempt.next()
        if (next.done === true) break
        const chunk = next.value
        if (chunk.type === 'finish') {
          outcome = chunk
          break
        }
        if (!sawContent && isContentChunk(chunk)) sawContent = true
        // Once content exists the request is committed, so the buffer is
        // released immediately and every later chunk streams straight through.
        if (sawContent) {
          for (const held of buffered) yield held
          buffered.length = 0
          yield chunk
          for (;;) {
            const rest = await attempt.next()
            if (rest.done === true) break
            yield rest.value
          }
          await attempt.return?.(undefined)
          return
        }
        buffered.push(chunk)
      }
      await attempt.return?.(undefined)
      if (outcome === undefined) {
        // The stream ended without a terminal event. Nothing was content, so
        // the buffered chunks are exactly what an unknown-ending stream
        // produced before; release them and let the caller's own handling
        // decide what a terminal-less stream means.
        for (const held of buffered) yield held
        return
      }
      if (isKeyQuotaFinish(outcome)) {
        // The key is exhausted and nothing durable has left this operation:
        // report the exhaustion, discard the buffer, and try the next key.
        this.config.keyRotation?.exhaust(options.provider, ref, profile.keyCooldownMs ?? 0)
        attempted.add(ref)
        continue
      }
      for (const held of buffered) yield held
      yield outcome
      return
    }
  }

  /**
   * One attempt for one credential, as its own chunk iterator.
   *
   * Everything from here down is per-attempt — the consumer controller, the
   * idle watchdog, the SDK stream, and its teardown — so abandoning an attempt
   * for the next key cannot leak the previous one's socket or watchdog.
   * @param options - the request.
   * @param snapshot - the snapshot this operation captured.
   * @param dispatch - per-call options.
   * @param profile - this operation's profile.
   * @param model - this operation's model descriptor.
   * @param reasoning - the resolved reasoning level.
   * @param apiKey - the credential this attempt authenticates with.
   * @returns this attempt's chunks, ending with a `finish` when the provider produced one.
   */
  private async * attemptStream(
    options: GenerateOptions,
    snapshot: PiAiSnapshot,
    dispatch: PiAiDispatchOptions,
    profile: ResolvedPiAiProviderProfile,
    model: Model<Api>,
    reasoning: ModelThinkingLevel | undefined,
    apiKey: string | undefined,
  ): AsyncIterable<StreamChunk> {
    const consumer = new AbortController()
    const upstream = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal])
    const streamIdleTimeoutMs = profile.streamIdleTimeoutMs
    using watchdog = idleWatchdog(upstream, streamIdleTimeoutMs, 'LLM_STREAM_IDLE_TIMEOUT')

    try {
      // The caller's block is checked against the model's protocol before
      // anything is dispatched: pi-ai sends `provider` only on
      // `openai-completions`, so handing one to any other model would silently
      // drop the pin the caller believes it applied.
      if (dispatch.openRouterRouting !== undefined && model.api !== 'openai-completions') {
        throw new LlmError(
          `pi-ai model "${model.id}" on route "${options.provider}" cannot take an OpenRouter routing block: it speaks ${model.api}`,
          'INVALID_CONFIG',
        )
      }
      const dispatched = withRouting(model, dispatch.openRouterRouting)
      const containsImage = options.messages.some(message => contentHasImage(message.content))
      if (containsImage && !model.input.includes('image')) {
        throw new LlmError(`pi-ai model "${model.id}" does not support image input`, 'UNSUPPORTED_CONTENT')
      }
      const attachments = containsImage ? this.config.resolveAttachments?.() : undefined
      if (containsImage && attachments === undefined) {
        throw new LlmError('pi-ai image input requires the durable attachment service', 'UNSUPPORTED_CONTENT')
      }
      const onReplayDegrade = (reason: string): void => {
        this.config.onReplayDegrade?.({ provider: options.provider, model: options.model, reason })
      }
      const context = attachments === undefined
        ? toPiContext(options, undefined, onReplayDegrade)
        : await toPiContext({ ...options, signal: watchdog.signal }, {
          attachments,
          resolveImageAccess: ref => this.config.resolveImageAccess?.(attachments, ref),
          maxRequestImageBytes: profile.maxRequestImageBytes,
          requestImagePolicy: {
            maxPixels: profile.requestImagePixelBudget,
            maxBytes: profile.requestImageMaxBytes,
          },
        }, onReplayDegrade)
      const events = snapshot.models.streamSimple(dispatched, context, {
        ...profileOptions(profile, reasoning, apiKey),
        ...options.temperature === undefined ? {} : { temperature: options.temperature },
        ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
        ...options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) },
        signal: watchdog.signal,
        // Profile headers are deployment-owned; attribution names are
        // Harness-owned and therefore win collisions.
        headers: requestHeaders(profile.headers),
      })
      const iterator = toStreamChunks(events, model.contextWindow, options.signal, model.id)[Symbol.asyncIterator]()
      let exhausted = false
      try {
        while (true) {
          const result = await watchdog.next(iterator)
          const timeout = timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT')
          if (timeout !== undefined) throw timeout
          if (result.done) {
            exhausted = true
            return
          }
          yield result.value
        }
      } finally {
        if (!exhausted) {
          consumer.abort('pi-ai stream consumer stopped')
          try {
            await iterator.return(undefined)
          } catch (_abortedSdkTeardown) {
            // The stable signal already owns SDK termination; return-time abort cannot add an outcome.
          }
        }
      }
    } catch (error: unknown) {
      if (timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT') !== undefined) {
        throw new LlmError(`pi-ai stream idle timeout after ${streamIdleTimeoutMs}ms`, 'TIMEOUT', { cause: error })
      }
      if (options.signal?.aborted) {
        throw new LlmError('pi-ai request aborted by caller', 'ABORTED', { cause: error })
      }
      throw error
    } finally {
      consumer.abort('pi-ai stream consumer stopped')
    }
  }
}
