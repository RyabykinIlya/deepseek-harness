/**
 * Host half of the @local/tg-notify bundle.
 *
 * Sends short Telegram notifications about harness work: a finished task
 * (agent back to idle), an approval or question waiting for the human, a
 * settled background job, and a completed or blocked session goal.
 *
 * Transport is one HTTPS POST to the Bot API per message; nothing listens,
 * so the same bot token stays free for other senders. Every send is
 * fire-and-forget: failures are logged and never affect the agent run.
 *
 * Configuration comes from the patch row (validated below) on top of the
 * launch environment read through `ctx.credentials` (managed store ->
 * process env -> <cwd>/.env -> $DSH_HOME/.env), so
 * `bin/dotfiles secret set TG_NOTIFY_BOT_TOKEN` is the whole token setup.
 */

import net from 'node:net'
import tls from 'node:tls'

/** Loader row id; matches the `insert` in cordis.patch.yml. */
export const name = 'tg-notify'

/** `credentials` resolves env/secret refs, `sessionTitle` labels messages, `commands` carries /tg-test, `sessions` seeds live titles. */
export const inject = ['credentials', 'sessionTitle', 'commands', 'sessions']

/** Telegram hard cap per message; every template stays below it by construction. */
const TG_MESSAGE_LIMIT = 4096

/** Worst-case header+footer overhead across all templates, kept apart from the body budget. */
const HEADER_RESERVE = 600

/** Deployment defaults; every field is overridable from the patch row. */
const DEFAULTS = {
  token: '',
  chatId: '',
  threadId: '',
  proxy: '',
  level: '',
  apiBase: 'https://api.telegram.org',
  tokenEnv: 'TG_NOTIFY_BOT_TOKEN',
  chatIdEnv: 'TG_NOTIFY_CHAT_ID',
  threadIdEnv: 'TG_NOTIFY_THREAD_ID',
  enabledEnv: 'TG_NOTIFY_ENABLED',
  levelEnv: 'TG_NOTIFY_LEVEL',
  proxyEnv: 'TG_NOTIFY_PROXY',
  timeoutMs: 8000,
  maxChars: 3800,
  minRunSeconds: 30,
  idleDebounceMs: 8000,
  minJobMs: 60000,
  ratePerMinute: 12,
  enabled: undefined,
  notifyOnIdle: true,
  notifyOnApproval: true,
  notifyOnQuestion: true,
  notifyOnJob: true,
  notifyOnGoal: true,
  notifySubagents: false,
  notifyStartup: true,
}

const INTEGER_RANGES = [
  ['timeoutMs', 1000, 60000],
  ['maxChars', 500, 3900],
  ['minRunSeconds', 0, 86400],
  ['idleDebounceMs', 0, 600000],
  ['minJobMs', 0, 86400000],
  ['ratePerMinute', 1, 120],
]

const BOOLEAN_FIELDS = [
  'notifyOnIdle',
  'notifyOnApproval',
  'notifyOnQuestion',
  'notifyOnJob',
  'notifyOnGoal',
  'notifySubagents',
  'notifyStartup',
]

const STRING_FIELDS = [
  'token',
  'chatId',
  'threadId',
  'proxy',
  'level',
  'apiBase',
  'tokenEnv',
  'chatIdEnv',
  'threadIdEnv',
  'enabledEnv',
  'levelEnv',
  'proxyEnv',
]

/** Values of `<enabledEnv>` that switch notifications off; anything else non-empty means on. */
const ENV_DISABLED = new Set(['0', 'false', 'no', 'off'])

/** Bind each tunables field, naming the offending field when a row is wrong. */
function resolveConfig(raw) {
  const config = { ...DEFAULTS, ...(raw ?? {}) }
  for (const field of STRING_FIELDS) {
    if (typeof config[field] !== 'string') {
      throw new Error(`tg-notify: config.${field} must be a string`)
    }
  }
  for (const [field, min, max] of INTEGER_RANGES) {
    const value = config[field]
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      throw new Error(`tg-notify: config.${field} must be an integer in [${min}, ${max}]`)
    }
  }
  for (const field of BOOLEAN_FIELDS) {
    if (typeof config[field] !== 'boolean') {
      throw new Error(`tg-notify: config.${field} must be a boolean`)
    }
  }
  if (config.enabled !== undefined && typeof config.enabled !== 'boolean') {
    throw new Error('tg-notify: config.enabled must be a boolean')
  }
  if (config.level !== '' && config.level !== 'all' && config.level !== 'approval-only') {
    throw new Error(`tg-notify: config.level must be 'all' or 'approval-only', got ${JSON.stringify(config.level)}`)
  }
  if (config.apiBase !== '' && !/^https?:\/\//.test(config.apiBase)) {
    throw new Error('tg-notify: config.apiBase must be an http(s) URL')
  }
  return config
}

/** Escape one string for parse_mode=HTML. */
function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * HTML-escape `text` and truncate it so the ESCAPED form fits `budget`
 * characters; the ellipsis never splits an entity because escaping is
 * per-character. One trailing `…` is counted inside the budget.
 */
function fit(text, budget) {
  let out = ''
  let used = 0
  for (const ch of String(text ?? '')) {
    const piece = ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch
    if (used + piece.length > budget - 1) return out + '…'
    out += piece
    used += piece.length
  }
  return out
}

/** Compact Russian duration: "42 с", "5 мин 03 с", "1 ч 07 мин". */
function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  if (totalSeconds < 60) return `${totalSeconds} с`
  const minutes = Math.floor(totalSeconds / 60)
  if (minutes < 60) return `${minutes} мин ${String(totalSeconds % 60).padStart(2, '0')} с`
  return `${Math.floor(minutes / 60)} ч ${String(minutes % 60).padStart(2, '0')} мин`
}

/** Error text without leaking stack noise; never carries the token. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Strip a secret from text headed for a log line, a command reply, or an
 * Error message. A malformed token surfaces verbatim inside a `fetch` URL
 * parse error, so every outward string passes through here.
 * @param text - the outward text.
 * @param secret - the token to mask.
 * @returns the text with every occurrence replaced by `<bot-token>`.
 */
function redact(text, secret) {
  if (typeof secret !== 'string' || secret === '') return String(text)
  return String(text).split(secret).join('<bot-token>')
}

/** Decode chunked transfer-encoding of a buffered HTTP/1.1 body. */
function dechunk(input) {
  const parts = []
  let index = 0
  while (index < input.length) {
    const lineEnd = input.indexOf('\r\n', index)
    if (lineEnd === -1) break
    const size = Number.parseInt(input.subarray(index, lineEnd).toString('latin1').trim(), 16)
    if (!Number.isFinite(size) || size <= 0) break
    parts.push(input.subarray(lineEnd + 2, lineEnd + 2 + size))
    index = lineEnd + 2 + size + 2
  }
  return Buffer.concat(parts)
}

/**
 * Parse one complete buffered HTTP/1.1 response: status line, headers,
 * and the body by content-length / chunked / everything-until-close.
 */
function parseHttpResponse(raw) {
  const head = raw.indexOf('\r\n\r\n')
  if (head === -1) throw new Error('tg-notify: пустой ответ через прокси')
  const headText = raw.subarray(0, head).toString('latin1')
  const status = Number(headText.split(' ', 3)[1])
  if (!Number.isInteger(status) || status < 100) {
    throw new Error(`tg-notify: нечитаемый статус-код от прокси: ${fit(headText.split('\r\n')[0], 120)}`)
  }
  const headers = new Map()
  for (const line of headText.split('\r\n').slice(1)) {
    const at = line.indexOf(':')
    if (at > 0) headers.set(line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim())
  }
  let body = raw.subarray(head + 4)
  if ((headers.get('transfer-encoding') ?? '').includes('chunked')) body = dechunk(body)
  const length = Number(headers.get('content-length'))
  if (Number.isFinite(length) && length >= 0 && !((headers.get('transfer-encoding') ?? '').includes('chunked'))) {
    body = body.subarray(0, length)
  }
  return { status, body: body.toString('utf8') }
}

/**
 * One JSON POST over an HTTP(S) proxy: CONNECT tunnel, TLS, HTTP/1.1 with
 * `connection: close`. Self-contained on purpose — `undici` is not an
 * installable dependency of a local plugin, and the harness global proxy
 * policy is process-wide while TG_NOTIFY_PROXY is Telegram-only.
 *
 * @returns the parsed JSON body
 */
function requestThroughProxy(proxyUrl, targetUrl, bodyText, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    let proxy
    let target
    try {
      proxy = new URL(proxyUrl)
      target = new URL(targetUrl)
    } catch (error) {
      reject(new Error(`tg-notify: некорректный URL прокси/цели: ${messageOf(error)}`))
      return
    }
    if (proxy.protocol !== 'http:' && proxy.protocol !== 'https:') {
      reject(new Error(`tg-notify: TG_NOTIFY_PROXY поддерживает только http/https прокси, получено ${proxy.protocol}`))
      return
    }
    if (target.protocol !== 'https:') {
      reject(new Error('tg-notify: туннель через прокси поддерживает только https-цели'))
      return
    }
    const proxyPort = Number(proxy.port) || (proxy.protocol === 'https:' ? 443 : 80)
    const targetPort = Number(target.port) || 443
    let stage = 'соединение с прокси'
    let socket
    let tlsSocket
    let buffer = Buffer.alloc(0)
    let response = Buffer.alloc(0)
    let settled = false
    let timer
    const settle = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      try {
        tlsSocket?.destroy()
      } catch {
        /* already closed */
      }
      try {
        socket?.destroy()
      } catch {
        /* already closed */
      }
      fn(value)
    }
    const fail = (error) => settle(reject, error instanceof Error ? error : new Error(String(error)))
    const done = (value) => settle(resolve, value)
    function onAbort() {
      fail(new Error(`tg-notify: запрос через прокси отменён (этап: ${stage})`))
    }
    timer = setTimeout(() => {
      fail(new Error(`tg-notify: таймаут ${timeoutMs} мс (этап: ${stage})`))
    }, timeoutMs)
    signal?.addEventListener('abort', onAbort, { once: true })
    socket = proxy.protocol === 'https:'
      ? tls.connect({ host: proxy.hostname, port: proxyPort, servername: proxy.hostname })
      : net.connect({ host: proxy.hostname, port: proxyPort })
    socket.on('error', (error) => fail(new Error(`tg-notify: ошибка соединения с прокси: ${messageOf(error)}`)))
    // An https proxy must complete its own TLS handshake before the tunnel
    // request; a plain http proxy is writable right after TCP connect.
    socket.on(proxy.protocol === 'https:' ? 'secureConnect' : 'connect', () => {
      stage = 'CONNECT handshake'
      try {
        const credentials = proxy.username === '' && proxy.password === ''
          ? ''
          : `Proxy-Authorization: Basic ${Buffer.from(
            `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`,
          ).toString('base64')}\r\n`
        socket.write(`CONNECT ${target.hostname}:${targetPort} HTTP/1.1\r\nHost: ${target.hostname}:${targetPort}\r\n${credentials}\r\n`)
      } catch (error) {
        fail(new Error(`tg-notify: не удалось отправить CONNECT через прокси: ${messageOf(error)}`))
      }
    })
    // The single CONNECT-phase reader: detached before the TLS layer takes
    // over the socket, so handshake/response bytes never reach this parser.
    socket.on('data', onConnectPhaseData)
    function onConnectPhaseData(chunk) {
      if (settled) return
      buffer = Buffer.concat([buffer, chunk])
      const head = buffer.indexOf('\r\n\r\n')
      if (head === -1) {
        if (buffer.length > 8192) fail(new Error('tg-notify: прокси не дал читаемого ответа на CONNECT'))
        return
      }
      const statusLine = buffer.subarray(0, head).toString('latin1').split('\r\n')[0]
      const connectStatus = Number(statusLine.split(' ', 3)[1])
      if (connectStatus !== 200) {
        fail(new Error(`tg-notify: прокси отказал в CONNECT: ${fit(statusLine, 160)}`))
        return
      }
      socket.off('data', onConnectPhaseData)
      stage = 'TLS к цели'
      // Bytes after the CONNECT response could only be TLS handshake bytes;
      // the peer sends none before our ClientHello, so the buffer ends here.
      // A synchronous throw here would escape as an uncaughtException and take
      // the host process down, so the whole continuation is guarded.
      try {
        tlsSocket = tls.connect({ socket, servername: target.hostname }, () => {
          stage = 'HTTP-запрос'
          try {
            const path = target.pathname + target.search
            tlsSocket.write(
              `POST ${path} HTTP/1.1\r\nHost: ${target.hostname}\r\ncontent-type: application/json\r\n` +
                `content-length: ${Buffer.byteLength(bodyText)}\r\nconnection: close\r\n\r\n${bodyText}`,
            )
          } catch (error) {
            fail(new Error(`tg-notify: не удалось отправить запрос через прокси: ${messageOf(error)}`))
          }
        })
        tlsSocket.on('error', (error) => {
          // A reset after a complete response still delivers what Telegram accepted.
          if (response.length > 0) {
            try {
              done(parseHttpResponse(response))
              return
            } catch {
              /* fall through to the transport failure */
            }
          }
          fail(new Error(`tg-notify: TLS через прокси: ${messageOf(error)}`))
        })
        tlsSocket.on('data', (tlsChunk) => {
          if (settled) return
          response = Buffer.concat([response, tlsChunk])
          if (response.length > 64 * 1024) fail(new Error('tg-notify: ответ через прокси превышает 64 КБ'))
        })
        const finishResponse = () => {
          if (settled || response.length === 0) return
          try {
            done(parseHttpResponse(response))
          } catch (error) {
            fail(error)
          }
        }
        tlsSocket.on('end', finishResponse)
        tlsSocket.on('close', finishResponse)
      } catch (error) {
        fail(new Error(`tg-notify: туннель через прокси не поднялся: ${messageOf(error)}`))
      }
    }
  })
}

/**
 * Entry point: mount the listeners and the /tg-test command.
 * @param ctx - plugin Context with credentials, sessionTitle and commands injected.
 * @param rawConfig - the patch row's `config`, validated before anything registers.
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const logger = ctx.logger

  /** Live per-session facts folded from the append feed; cleaned on session/disposed. */
  const titles = new Map()
  const projects = new Map()
  const lastText = new Map()
  const lastTurnEnd = new Map()

  /** Root-agent run tracking for the idle ("task finished") notification. */
  const running = new Map()
  const pendingIdle = new Map()
  const ownedTimers = new Set()
  let missingWarnAt = 0
  let badLevelWarnAt = 0
  const sendTimes = []
  let rateWarnAt = 0

  // Body budget derives from maxChars minus the header reserve, and maxChars is
  // validated below the Telegram cap, so no template needs a last-minute cut.
  const bodyBudget = Math.min(Math.max(500, config.maxChars - HEADER_RESERVE), TG_MESSAGE_LIMIT - HEADER_RESERVE)

  /**
   * Sleep that always settles: disposal resolves it instead of leaving an
   * awaited retry suspended forever with its closure retained.
   */
  const pendingSleeps = new Map()
  const sleep = (ms) => new Promise((resolveSleep) => {
    const settle = () => {
      // `settle` also runs from disposal, where the timer is still armed.
      clearTimeout(timer)
      if (!pendingSleeps.has(timer)) return
      pendingSleeps.delete(timer)
      ownedTimers.delete(timer)
      resolveSleep()
    }
    const timer = setTimeout(settle, ms)
    pendingSleeps.set(timer, settle)
    ownedTimers.add(timer)
  })

  /** One env/secret ref through the credentials service; undefined when absent or empty. */
  const envValue = async (ref) => {
    if (typeof ref !== 'string' || ref === '') return undefined
    try {
      const resolved = await ctx.credentials.resolve(ref)
      const value = resolved?.value?.trim()
      return value === '' ? undefined : value
    } catch {
      return undefined
    }
  }

  const isEnabled = async () => {
    if (config.enabled === false) return false
    if (config.enabled === true) return true
    const raw = (await envValue(config.enabledEnv))?.toLowerCase()
    return raw === undefined ? true : !ENV_DISABLED.has(raw)
  }

  const resolveLevel = async () => {
    if (config.level !== '') return config.level
    const raw = await envValue(config.levelEnv)
    if (raw === undefined) return 'all'
    if (raw === 'approval-only') return 'approval-only'
    if (raw === 'all') return 'all'
    if (Date.now() - badLevelWarnAt > 3600000) {
      badLevelWarnAt = Date.now()
      logger.warn(`tg-notify: ${config.levelEnv}="${raw}" не распознан (ожидаются all | approval-only), используется all`)
    }
    return 'all'
  }

  const resolveProxy = async () => config.proxy || (await envValue(config.proxyEnv)) || ''

  /**
   * Token + chat target, resolved per send so `secret set` and file watching
   * take effect without a restart.
   */
  const resolveTarget = async () => {
    const token = config.token || (await envValue(config.tokenEnv))
    const chatId = config.chatId || (await envValue(config.chatIdEnv))
    const threadId = config.threadId || (await envValue(config.threadIdEnv))
    if (token === undefined || chatId === undefined) return undefined
    return { token, chatId, threadId }
  }

  const warnMissing = () => {
    if (Date.now() - missingWarnAt < 3600000) return
    missingWarnAt = Date.now()
    logger.warn(
      'tg-notify: TG_NOTIFY_BOT_TOKEN / TG_NOTIFY_CHAT_ID не заданы — Telegram-уведомления пропускаются. ' +
        'Добавьте: bin/dotfiles secret set TG_NOTIFY_BOT_TOKEN и bin/dotfiles secret set TG_NOTIFY_CHAT_ID ' +
        '(из ~/my-harness-dotfiles), затем перезапустите dsh web.',
    )
  }

  /** Sliding one-minute window; a burst can never flood the chat. */
  const allowSend = () => {
    const now = Date.now()
    while (sendTimes.length > 0 && now - sendTimes[0] > 60000) sendTimes.shift()
    if (sendTimes.length >= config.ratePerMinute) {
      if (now - rateWarnAt > 60000) {
        rateWarnAt = now
        logger.warn(`tg-notify: достигнут лимит ${config.ratePerMinute} сообщений/мин, часть уведомлений отброшена`)
      }
      return false
    }
    sendTimes.push(now)
    return true
  }

  /** Telegram error with its HTTP status and retry_after, if the API sent one. */
  const telegramFailure = (status, body) => {
    const description = body?.ok === false && typeof body.description === 'string' ? body.description : 'без описания'
    const error = new Error(`Telegram API ${status}: ${fit(description, 200)}`)
    error.status = status
    const retryAfter = body?.parameters?.retry_after
    if (typeof retryAfter === 'number') error.retryAfterMs = retryAfter * 1000
    return error
  }

  /** One sendMessage through fetch (direct or harness-global proxy policy). */
  const sendViaFetch = async (url, bodyText) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: bodyText,
      signal: AbortSignal.timeout(config.timeoutMs),
    })
    const text = await response.text()
    let body
    try {
      body = JSON.parse(text)
    } catch {
      body = undefined
    }
    if (!response.ok || body?.ok !== true) throw telegramFailure(response.status, body)
  }

  /** One sendMessage through the dedicated CONNECT tunnel. */
  const sendViaProxy = async (proxyUrl, url, bodyText) => {
    const { status, body: text } = await requestThroughProxy(proxyUrl, url, bodyText, config.timeoutMs)
    let body
    try {
      body = JSON.parse(text)
    } catch {
      body = undefined
    }
    if (!(status >= 200 && status < 300) || body?.ok !== true) throw telegramFailure(status, body)
  }

  /** Deliver one message: retries once; 4xx (except 429) never retries. */
  const deliver = async (target, text) => {
    const url = `${config.apiBase.replace(/\/+$/, '')}/bot${target.token}/sendMessage`
    const payload = {
      chat_id: target.chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }
    if (target.threadId !== undefined) {
      const threadId = Number(target.threadId)
      if (Number.isInteger(threadId)) payload.message_thread_id = threadId
    }
    const bodyText = JSON.stringify(payload)
    const proxyUrl = await resolveProxy()
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        if (proxyUrl === '') await sendViaFetch(url, bodyText)
        else await sendViaProxy(proxyUrl, url, bodyText)
        return
      } catch (error) {
        // A network failure may already have delivered the message; the retry
        // trades a rare duplicate for not losing the notification.
        const status = typeof error?.status === 'number' ? error.status : 0
        const retryable = status === 0 || status === 429 || status >= 500
        if (attempt === 2 || !retryable) {
          throw new Error(redact(messageOf(error), target.token))
        }
        await sleep(error?.retryAfterMs ?? 3000)
      }
    }
  }

  /**
   * Fire-and-forget one notification: gates (enabled, level, rate, target)
   * run first, the text is built only after they pass, failures only log.
   * `kind` 'approval' and 'question' survive the approval-only level and the
   * rate limit, because a dropped "needs your approval" defeats the plugin.
   */
  const fire = (kind, buildText) => {
    void (async () => {
      const urgent = kind === 'approval' || kind === 'question'
      let secret
      try {
        if (!(await isEnabled())) return
        if ((await resolveLevel()) === 'approval-only' && !urgent) return
        const target = await resolveTarget()
        if (target === undefined) {
          warnMissing()
          return
        }
        secret = target.token
        // Charged only once a message can actually go out, so an unconfigured
        // deployment cannot exhaust the window a later configuration needs.
        if (!urgent && !allowSend()) return
        await deliver(target, buildText())
      } catch (error) {
        logger.warn(`tg-notify: отправка не удалась: ${redact(messageOf(error), secret)}`)
      }
    })()
  }

  const rememberSession = (session) => {
    if (projects.get(session.id) === undefined && typeof session.header?.cwd === 'string') {
      const base = session.header.cwd.split('/').filter(Boolean).pop()
      if (base !== undefined) projects.set(session.id, base)
    }
  }

  const sessionHeader = (sessionId) => {
    const title = titles.get(sessionId)
    const project = projects.get(sessionId)
    const parts = []
    if (title !== undefined) parts.push(`<i>${fit(title, 160)}</i>`)
    if (project !== undefined) parts.push(`<code>${escapeHtml(project)}</code>`)
    if (parts.length === 0) parts.push(`<code>#${String(sessionId).slice(-8)}</code>`)
    return parts.join(' · ')
  }

  const reasonBadge = (reason) => {
    const kind = typeof reason?.kind === 'string' ? reason.kind : 'completed'
    if (kind === 'error') return { icon: '❌', label: ' — ошибка хода' }
    if (kind === 'blocked') return { icon: '⛔', label: ' — ход заблокирован' }
    if (kind === 'max-tokens') return { icon: '✂️', label: ' — лимит токенов' }
    if (kind === 'aborted') return { icon: '🛑', label: ' — ход прерван' }
    if (kind === 'interrupted') return { icon: '⚠️', label: ' — ход оборван (после сбоя)' }
    if (kind === 'forked') return { icon: '↪️', label: ' — ответвление сессии' }
    return { icon: '✅', label: '' }
  }

  const notifyIdle = (sessionId, durationMs) => {
    const badge = reasonBadge(lastTurnEnd.get(sessionId)?.reason)
    const snippet = lastText.get(sessionId)
    const lines = [
      `${badge.icon} <b>DSH: задача завершена${badge.label}</b>`,
      sessionHeader(sessionId),
      `⏱ ${formatDuration(durationMs)}`,
    ]
    if (snippet !== undefined) {
      lines.push('——', fit(snippet, bodyBudget))
    }
    fire('idle', () => lines.join('\n'))
  }

  const notifyApproval = (sessionId, data) => {
    const lines = [
      '⏸ <b>DSH: нужно одобрение</b>',
      sessionHeader(sessionId),
      `🔧 <code>${fit(data.toolName ?? '?', 120)}</code>`,
    ]
    if (typeof data.reason === 'string' && data.reason.trim() !== '') lines.push(fit(data.reason, 300))
    fire('approval', () => lines.join('\n'))
  }

  const notifyQuestion = (sessionId, questions) => {
    const lines = ['❓ <b>DSH: агент ждёт ответа</b>', sessionHeader(sessionId)]
    if (questions.length === 0) {
      lines.push('Вопрос открыт в интерфейсе; структура аргументов недоступна.')
    }
    for (const question of questions.slice(0, 3)) {
      const head = typeof question.header === 'string' && question.header !== '' ? `<b>${fit(question.header, 80)}</b> — ` : ''
      lines.push(`• ${head}${fit(question.question ?? question.id ?? '', 300)}`)
    }
    fire('question', () => lines.join('\n'))
  }

  const notifyJob = (sessionId, data) => {
    const statusLabel = data.status === 'completed' ? 'завершена' : data.status === 'failed' ? 'упала' : 'остановлена'
    const icon = data.status === 'completed' ? '🔔' : data.status === 'failed' ? '💥' : '🛑'
    const lines = [
      `${icon} <b>DSH: фоновая задача ${statusLabel}</b>`,
      sessionHeader(sessionId),
      `📋 ${fit(data.label || data.kind || 'job', 160)}`,
      `⏱ ${formatDuration(Number(data.finishedAt ?? 0) - Number(data.startedAt ?? 0))}`,
    ]
    if (typeof data.detail === 'string' && data.detail.trim() !== '') lines.push(fit(data.detail, 300))
    fire('job', () => lines.join('\n'))
  }

  const notifySubagent = (info) => {
    const blocks = Array.isArray(info.lastAssistantMessage) ? info.lastAssistantMessage : []
    const text = blocks
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim()
    const lines = [`🤖 <b>DSH: сабагент завершён (${fit(info.stopReason ?? '?', 40)})</b>`, `<code>#${String(info.id).slice(-8)}</code>`]
    if (text !== '') lines.push('——', fit(text, bodyBudget))
    fire('subagent', () => lines.join('\n'))
  }

  const notifyGoal = (sessionId, goal) => {
    if (goal.phase === 'complete') {
      fire('goal', () => ['🏁 <b>DSH: цель достигнута</b>', sessionHeader(sessionId), `🎯 ${fit(goal.objective ?? '', 300)}`].join('\n'))
      return
    }
    if (goal.phase === 'blocked') {
      const reason = typeof goal.blockedReason?.message === 'string' ? goal.blockedReason.message : ''
      fire('goal', () => [
        '⛔ <b>DSH: цель заблокирована</b>',
        sessionHeader(sessionId),
        `🎯 ${fit(goal.objective ?? '', 300)}`,
        reason === '' ? undefined : `❌ ${fit(reason, 300)}`,
      ].filter((line) => line !== undefined).join('\n'))
    }
  }

  ctx.on('session/event', (session, event) => {
    try {
      rememberSession(session)
      const data = event.data ?? {}
      switch (event.type) {
        case 'turn/start':
          lastTurnEnd.delete(session.id)
          // A turn that fails before producing a message must not inherit the
          // previous turn's text as its "final answer".
          lastText.delete(session.id)
          break
        case 'turn/end':
          lastTurnEnd.set(session.id, { turn: data.turn, reason: data.reason })
          break
        case 'assistant/message': {
          const blocks = Array.isArray(data.message?.content) ? data.message.content : []
          const text = blocks
            .filter((block) => block?.type === 'text' && typeof block.text === 'string')
            .map((block) => block.text)
            .join('\n')
            .trim()
          if (text !== '') lastText.set(session.id, text)
          break
        }
        case 'session/title':
          if (typeof data.title === 'string' && data.title.trim() !== '') titles.set(session.id, data.title.trim())
          break
        case 'approval/asked':
          if (config.notifyOnApproval) notifyApproval(session.id, data)
          break
        case 'tool/call': {
          if (!config.notifyOnQuestion) break
          if (data.name !== 'ask_user_question') break
          let questions = []
          try {
            const parsed = JSON.parse(typeof data.arguments === 'string' ? data.arguments : '{}')
            if (Array.isArray(parsed?.questions)) questions = parsed.questions
          } catch {
            questions = []
          }
          notifyQuestion(session.id, questions)
          break
        }
        case 'job/settled': {
          if (!config.notifyOnJob) break
          const durationMs = Number(data.finishedAt ?? 0) - Number(data.startedAt ?? 0)
          if (durationMs < config.minJobMs) break
          notifyJob(session.id, data)
          break
        }
        default:
          break
      }
    } catch (error) {
      logger.warn(`tg-notify: session/event: ${messageOf(error)}`)
    }
  })

  /** Drop every trace of one session: folds, run state, and its pending idle ping. */
  const forgetSession = (sessionId) => {
    titles.delete(sessionId)
    projects.delete(sessionId)
    lastText.delete(sessionId)
    lastTurnEnd.delete(sessionId)
    running.delete(sessionId)
    const pending = pendingIdle.get(sessionId)
    if (pending !== undefined) {
      clearTimeout(pending)
      pendingIdle.delete(sessionId)
      ownedTimers.delete(pending)
    }
  }

  /**
   * Disposal of one agent, not of its session: a resumed session outlives the
   * agent that drove it, so its folded facts are only dropped once the store
   * no longer resolves that id.
   */
  const forgetAgent = (agent) => {
    const sessionId = agent?.session?.id
    if (sessionId === undefined) return
    running.delete(sessionId)
    const pending = pendingIdle.get(sessionId)
    if (pending !== undefined) {
      clearTimeout(pending)
      pendingIdle.delete(sessionId)
      ownedTimers.delete(pending)
    }
    if (ctx.sessions.get(sessionId) === undefined) forgetSession(sessionId)
  }

  ctx.on('session/disposed', (session) => {
    forgetSession(session.id)
  })

  ctx.on('agent/status', ({ agent, status }) => {
    try {
      const session = agent?.session
      const sessionId = session?.id
      if (sessionId === undefined) return
      rememberSession(session)
      // Root agents only: a subagent going idle is mid-task noise.
      if (session.header?.origin === 'subagent') return
      if (status === 'running') {
        const pending = pendingIdle.get(sessionId)
        if (pending !== undefined) {
          clearTimeout(pending)
          pendingIdle.delete(sessionId)
          ownedTimers.delete(pending)
        }
        if (!running.has(sessionId)) running.set(sessionId, { since: Date.now() })
        return
      }
      if (status !== 'idle') return
      const run = running.get(sessionId)
      if (run === undefined) return
      if (!config.notifyOnIdle) {
        running.delete(sessionId)
        return
      }
      const timer = setTimeout(() => {
        pendingIdle.delete(sessionId)
        running.delete(sessionId)
        ownedTimers.delete(timer)
        const durationMs = Date.now() - run.since
        if (durationMs < config.minRunSeconds * 1000) return
        notifyIdle(sessionId, durationMs)
      }, config.idleDebounceMs)
      ownedTimers.add(timer)
      pendingIdle.set(sessionId, timer)
    } catch (error) {
      logger.warn(`tg-notify: agent/status: ${messageOf(error)}`)
    }
  })

  ctx.on('agent/disposed', ({ agent }) => {
    forgetAgent(agent)
  })

  if (config.notifySubagents) {
    ctx.on('subagent/end', (info) => {
      try {
        notifySubagent(info)
      } catch (error) {
        logger.warn(`tg-notify: subagent/end: ${messageOf(error)}`)
      }
    })
  }

  if (config.notifyOnGoal) {
    ctx.on('goal/changed', ({ agent, change }) => {
      try {
        const goal = change?.goal
        if (goal?.phase !== 'complete' && goal?.phase !== 'blocked') return
        const sessionId = agent?.session?.id
        if (sessionId === undefined) return
        rememberSession(agent.session)
        notifyGoal(sessionId, goal)
      } catch (error) {
        logger.warn(`tg-notify: goal/changed: ${messageOf(error)}`)
      }
    })
  }

  ctx.effect(() => ctx.commands.register({
    name: 'tg-test',
    description: 'Telegram-нотификатор: отправить тестовое сообщение и показать диагноз',
    recordInput: false,
    handler: async () => {
      if (!(await isEnabled())) return { kind: 'error', text: 'tg-notify: отключено (TG_NOTIFY_ENABLED).' }
      const target = await resolveTarget()
      if (target === undefined) {
        return {
          kind: 'error',
          text: 'tg-notify: не настроен токен/чат. Выполните bin/dotfiles secret set TG_NOTIFY_BOT_TOKEN и ' +
            'bin/dotfiles secret set TG_NOTIFY_CHAT_ID из ~/my-harness-dotfiles, затем перезапустите dsh web.',
        }
      }
      const proxyUrl = await resolveProxy()
      // The reply is a recorded command result: report the proxy host only,
      // never the `user:pass@` part of the URL.
      let proxyHost = ''
      if (proxyUrl !== '') {
        try {
          proxyHost = new URL(proxyUrl).host
        } catch {
          proxyHost = 'задан'
        }
      }
      try {
        await deliver(target, `📨 <b>DSH /tg-test</b>\nЕсли это сообщение пришло — уведомления работают.\nЧат: <code>${escapeHtml(target.chatId)}</code>`)
        return {
          kind: 'success',
          text: `tg-notify: тестовое сообщение отправлено в чат ${target.chatId}${proxyHost === '' ? '' : ` через прокси ${proxyHost}`}.`,
        }
      } catch (error) {
        return { kind: 'error', text: `tg-notify: отправка не удалась — ${redact(messageOf(error), target.token)}` }
      }
    },
  }), 'tg-notify: команда /tg-test')

  // Adopt already-live sessions (plugin (re)load, HMR): titles and projects
  // are folded facts, so seed them from the title service instead of waiting
  // for the next session/title append.
  try {
    for (const session of ctx.sessions.list()) {
      rememberSession(session)
      const title = ctx.sessionTitle.get(session)?.title
      if (typeof title === 'string' && title.trim() !== '') titles.set(session.id, title.trim())
    }
  } catch (error) {
    logger.warn(`tg-notify: не удалось собрать живые сессии: ${messageOf(error)}`)
  }

  /** Slots this plugin keeps on the root context; both are process-scoped facts. */
  const ANNOUNCED_KEY = 'tg-notify:announced'

  /** Whether this process already announced the notifier, across plugin reloads. */
  const announcedAlready = () => {
    try {
      return ctx.root.get(ANNOUNCED_KEY) === true
    } catch {
      return false
    }
  }

  /** Record the announcement on the root context once. */
  const markAnnounced = () => {
    try {
      if (ctx.root.get(ANNOUNCED_KEY) === undefined) ctx.root.provide(ANNOUNCED_KEY, true)
    } catch {
      // A host without provide support re-announces; noise, never a failure.
    }
  }

  // Startup self-check: one message when configured (the "it works" signal
  // after the bot is connected), one actionable warning when not yet. The
  // announcement is recorded on the root context because a hot reload mounts
  // a fresh plugin instance inside the same process, and re-announcing on
  // every reload is noise rather than a health signal.
  const startupTimer = setTimeout(() => {
    ownedTimers.delete(startupTimer)
    void (async () => {
      let secret
      try {
        if (!(await isEnabled())) return
        const target = await resolveTarget()
        if (target === undefined) {
          warnMissing()
          return
        }
        secret = target.token
        if (!config.notifyStartup) return
        if (announcedAlready()) return
        if (!allowSend()) return
        const level = await resolveLevel()
        await deliver(
          target,
          `🚀 <b>DSH TG-нотификатор подключён</b>\nУровень: ${level === 'all' ? 'все события' : 'только одобрения и вопросы'}. ` +
            'Будут приходить: завершение задач, одобрения, вопросы, фоновые задачи, цели.',
        )
        markAnnounced()
      } catch (error) {
        logger.warn(`tg-notify: стартовое сообщение не отправлено: ${redact(messageOf(error), secret)}`)
      }
    })()
  }, 2500)
  ownedTimers.add(startupTimer)

  ctx.effect(() => () => {
    // Settle in-flight retries first so no awaiter is left suspended, then
    // clear whatever timers remain.
    for (const settle of [...pendingSleeps.values()]) settle()
    for (const timer of ownedTimers) clearTimeout(timer)
    ownedTimers.clear()
    pendingIdle.clear()
    running.clear()
  }, 'tg-notify: таймеры')
}
