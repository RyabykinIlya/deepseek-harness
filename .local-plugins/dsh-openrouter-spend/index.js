/**
 * Host half of the OpenRouter spend bundle.
 *
 * Reads what the OpenRouter account actually charged with a management key and
 * serves it to the browser half as one cached summary. Every figure comes from
 * OpenRouter's own analytics (`total_usage`), so it is billed money rather than
 * a token estimate priced from a local table.
 */

/** Loader row id; matches the `insert` in cordis.patch.yml. */
export const name = 'openrouter-spend'

/** `credentials` resolves the management key, `webServer` carries the route. */
export const inject = ['credentials', 'webServer', 'connection']

/** One read-only summary route, fenced by the connection trust check. */
const SUMMARY_PATH = '/openrouter-spend/summary'

/** Route that stores or clears the management key. */
const CREDENTIAL_PATH = '/openrouter-spend/credential'

/** A credential body is one string; a larger one is hostile, not a real setting. */
const MAX_BODY_BYTES = 64 * 1024

/** A runaway guard: the window holds one row per day, key, and model. */
const MAX_REPLY_BYTES = 4 * 1024 * 1024

/** Rows beyond this are refused rather than truncated: a partial split misreports cost. */
const MAX_ANALYTICS_ROWS = 500

/**
 * Deployment defaults. Every field is overridable from the patch row so a
 * deployment can retarget the API, the credential, or the cadence without an
 * edit to this file.
 */
const DEFAULTS = {
  credentialRef: 'OPENROUTER_MGMT_API_KEY',
  apiBase: 'https://openrouter.ai/api/v1',
  refreshSeconds: 60,
  historyDays: 30,
  timeoutMs: 15_000,
}

/** Bound each tunables field, naming the offending field when a row is wrong. */
function resolveConfig(raw) {
  const config = { ...DEFAULTS, ...(raw ?? {}) }
  if (typeof config.credentialRef !== 'string' || config.credentialRef.length === 0) {
    throw new Error('openrouter-spend: config.credentialRef must be a non-empty string')
  }
  if (typeof config.apiBase !== 'string' || !config.apiBase.startsWith('https://')) {
    throw new Error('openrouter-spend: config.apiBase must be an https URL')
  }
  for (const [field, min, max] of [['refreshSeconds', 10, 3600], ['historyDays', 2, 366], ['timeoutMs', 1000, 120_000]]) {
    const value = config[field]
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      throw new Error(`openrouter-spend: config.${field} must be an integer in [${min}, ${max}]`)
    }
  }
  return config
}

/**
 * Read one analytics row. `request_count` arrives as a decimal string and the
 * dimensions are strings, so this is the wire boundary the narrowing belongs at.
 * @returns the row, or `undefined` when it does not carry a usable day and cost.
 */
function readRow(row) {
  if (row === null || typeof row !== 'object') return undefined
  const day = row.date__day
  const key = row.api_key_id
  const model = row.model
  const usd = Number(row.total_usage)
  const requests = Number(row.request_count)
  if (typeof day !== 'string' || typeof key !== 'string' || typeof model !== 'string') return undefined
  if (!Number.isFinite(usd) || !Number.isFinite(requests)) return undefined
  return { day, key, model, usd, requests }
}

/** Fetch the window split by API key and model; one query answers both views. */
async function queryAnalytics(config, credential, start, end, signal) {
  const url = `${config.apiBase.replace(/\/+$/, '')}/analytics/query`
  const response = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      metrics: ['total_usage', 'request_count'],
      dimensions: ['api_key_id', 'model'],
      granularity: 'day',
      time_range: { start, end },
      limit: MAX_ANALYTICS_ROWS,
    }),
    signal,
  })
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 200)
    throw new Error(`analytics/query answered ${response.status}: ${detail}`)
  }
  const length = Number(response.headers.get('content-length') ?? 0)
  if (Number.isFinite(length) && length > MAX_REPLY_BYTES) {
    throw new Error(`analytics/query reply exceeds ${MAX_REPLY_BYTES} bytes`)
  }
  const body = await response.json()
  const rows = body?.data?.data
  if (!Array.isArray(rows)) throw new Error('analytics/query returned no data rows')
  if (rows.length >= MAX_ANALYTICS_ROWS) {
    throw new Error(`analytics/query hit its ${MAX_ANALYTICS_ROWS}-row ceiling; narrow config.historyDays`)
  }
  return rows.flatMap(row => {
    const read = readRow(row)
    return read === undefined ? [] : [read]
  })
}

/** Read the prepaid credits balance, which is the account's remaining budget. */
async function queryCredits(config, credential, signal) {
  const url = `${config.apiBase.replace(/\/+$/, '')}/credits`
  const response = await fetch(url, { headers: { authorization: `Bearer ${credential}` }, signal })
  if (!response.ok) throw new Error(`credits answered ${response.status}`)
  const body = await response.json()
  const data = body?.data
  if (typeof data?.total_credits !== 'number' || typeof data?.total_usage !== 'number') {
    throw new Error('credits returned no total_credits/total_usage')
  }
  return { totalCredits: data.total_credits, totalUsage: data.total_usage }
}

/** UTC calendar day of a timestamp, the bucket OpenRouter answers `date__day` with. */
function utcDay(now) {
  return now.toISOString().slice(0, 10)
}

/** UTC midnight opening the day that is `offset` days before `now`'s day. */
function startOfUtcDay(now, offset) {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - offset))
  return `${day.toISOString().slice(0, 10)}T00:00:00Z`
}

/** Add one row's figures into an accumulator, creating it when the first row lands. */
function add(target, id, row) {
  const entry = target.get(id) ?? { usd: 0, requests: 0 }
  entry.usd += row.usd
  entry.requests += row.requests
  target.set(id, entry)
}

/** Zero-filled daily totals across the window, so a chart has no missing bars. */
function dailySeries(rows, historyDays, now) {
  const totals = new Map()
  for (const row of rows) add(totals, row.day, row)
  const series = []
  for (let offset = historyDays - 1; offset >= 0; offset -= 1) {
    const date = utcDay(new Date(now.getTime() - offset * 86_400_000))
    const entry = totals.get(date) ?? { usd: 0, requests: 0 }
    series.push({ date, usd: entry.usd, requests: entry.requests })
  }
  return series
}

/** Sum the trailing `days` entries of a daily series, today included. */
function trailing(series, days) {
  return series.slice(-days).reduce((sum, entry) => ({
    usd: sum.usd + entry.usd,
    requests: sum.requests + entry.requests,
  }), { usd: 0, requests: 0 })
}

/**
 * Per-key totals over the window plus today's per-key model split, so selecting
 * a key in the UI answers both "how much" and "on what" without a second poll.
 */
function byKey(rows, today, series) {
  const totals = new Map()
  const todayModels = new Map()
  const perDay = new Map()
  for (const row of rows) {
    add(totals, row.key, row)
    const days = perDay.get(row.key) ?? new Map()
    add(days, row.day, row)
    perDay.set(row.key, days)
    if (row.day !== today) continue
    const models = todayModels.get(row.key) ?? new Map()
    add(models, row.model, row)
    todayModels.set(row.key, models)
  }
  const trailingFor = (key, days) => {
    const window = series.slice(-days).map(entry => entry.date)
    let usd = 0
    let requests = 0
    for (const day of window) {
      const entry = perDay.get(key)?.get(day)
      if (entry === undefined) continue
      usd += entry.usd
      requests += entry.requests
    }
    return { usd, requests }
  }
  return [...totals.entries()]
    .map(([id, entry]) => {
      const models = [...(todayModels.get(id) ?? new Map()).entries()]
        .map(([model, modelEntry]) => ({ id: model, usd: modelEntry.usd, requests: modelEntry.requests }))
        .sort((left, right) => right.usd - left.usd)
      return {
        id,
        usd: entry.usd,
        requests: entry.requests,
        todayModels: models,
        todayUsd: models.reduce((sum, model) => sum + model.usd, 0),
        todayRequests: models.reduce((sum, model) => sum + model.requests, 0),
        last7: trailingFor(id, 7),
        last30: trailingFor(id, 30),
      }
    })
    .sort((left, right) => right.usd - left.usd)
}

/** Today's spend split by model, in descending cost. */
function byModel(rows, today) {
  const totals = new Map()
  for (const row of rows) {
    if (row.day === today) add(totals, row.model, row)
  }
  return [...totals.entries()]
    .map(([id, entry]) => ({ id, usd: entry.usd, requests: entry.requests }))
    .sort((left, right) => right.usd - left.usd)
}

/**
 * Build the one summary the browser half renders: today's spend, trailing
 * windows, the daily series, per-model and per-key splits, and the balance.
 */
async function collect(config, credential, signal) {
  const now = new Date()
  const end = new Date(now.getTime() + 60_000).toISOString()
  const start = startOfUtcDay(now, config.historyDays - 1)
  const [rows, credits] = await Promise.all([
    queryAnalytics(config, credential, start, end, signal),
    queryCredits(config, credential, signal),
  ])
  const today = utcDay(now)
  const series = dailySeries(rows, config.historyDays, now)
  return {
    status: 'ok',
    today,
    refreshedAt: now.toISOString(),
    refreshSeconds: config.refreshSeconds,
    historyDays: config.historyDays,
    todaySpend: series[series.length - 1] ?? { date: today, usd: 0, requests: 0 },
    last7: trailing(series, 7),
    last30: trailing(series, 30),
    byDay: series,
    byModel: byModel(rows, today),
    byKey: byKey(rows, today, series),
    credits,
  }
}

/** JSON reply carrying live facts; never cached by the browser. */
function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/** Collect a bounded request body as UTF-8; null past the ceiling (stream drained). */
async function readBoundedBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      // Drain the rest so the refusal is a readable response, not a socket cut.
      req.resume()
      return null
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size).toString('utf8')
}

/** Validate the credential body at the wire: an object with `value` or `clear`. */
function parseCredentialBody(text) {
  let body
  try {
    body = JSON.parse(text)
  } catch {
    // A non-JSON body is exactly the refusal case.
    return undefined
  }
  if (body === null || typeof body !== 'object') return undefined
  if (body.clear === true) return { clear: true }
  return typeof body.value === 'string' && body.value.length > 0 ? { value: body.value } : undefined
}

/** The payload the browser shows before any query has answered. */
function emptyPayload(config) {
  return {
    status: 'loading',
    today: utcDay(new Date()),
    refreshSeconds: config.refreshSeconds,
    historyDays: config.historyDays,
    todaySpend: { usd: 0, requests: 0 },
    last7: { usd: 0, requests: 0 },
    last30: { usd: 0, requests: 0 },
    byDay: [],
    byModel: [],
    byKey: [],
  }
}

/**
 * Register the summary route. The reply is cached for `refreshSeconds` and one
 * refresh serves every concurrent caller, so several open tabs cost one poll.
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  let cached = undefined
  let inFlight = undefined

  const summary = async () => {
    const resolved = await ctx.credentials.resolve(config.credentialRef)
    const info = await ctx.credentials.describe(config.credentialRef)
    const credential = {
      ref: config.credentialRef,
      configured: info.configured,
      writable: info.writable,
      ...(info.source === undefined ? {} : { source: info.source }),
    }
    if (resolved === undefined) {
      return { ...emptyPayload(config), status: 'no-credential', credential }
    }
    const signal = AbortSignal.timeout(config.timeoutMs)
    try {
      return { ...(await collect(config, resolved.value, signal)), credential }
    } catch (error) {
      // A stale reply beats an empty panel: keep the last good figures and say why.
      const reason = error instanceof Error ? error.message : String(error)
      ctx.logger.warn('openrouter-spend: refresh failed', reason)
      return {
        ...(cached ?? emptyPayload(config)),
        status: 'stale',
        error: reason,
        credential,
      }
    }
  }

  const current = () => {
    const fresh = cached !== undefined && Date.now() - cached.fetchedAt < config.refreshSeconds * 1000
    if (fresh) return Promise.resolve(cached.payload)
    if (inFlight !== undefined) return inFlight
    inFlight = (async () => {
      try {
        const payload = await summary()
        cached = { fetchedAt: Date.now(), payload }
        return payload
      } finally {
        inFlight = undefined
      }
    })()
    return inFlight
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: SUMMARY_PATH,
    handler: async (req, res) => {
      const rejection = ctx.connection.requestRejection(req)
      if (rejection !== undefined) {
        res.statusCode = rejection
        res.end()
        return
      }
      if (req.method !== 'GET') {
        res.statusCode = 405
        res.setHeader('allow', 'GET')
        res.end()
        return
      }
      try {
        sendJson(res, 200, await current())
      } catch (error) {
        ctx.logger.warn('openrouter-spend: summary failed', error)
        sendJson(res, 502, { status: 'error', error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), `openrouter-spend: GET ${SUMMARY_PATH}`)

  // Storing the key: the credentials service owns the write, and its refusal
  // (a shadowing read-only source) is passed through so Settings can show it.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CREDENTIAL_PATH,
    handler: async (req, res) => {
      const rejection = ctx.connection.requestRejection(req)
      if (rejection !== undefined) {
        res.statusCode = rejection
        res.end()
        return
      }
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'POST')
        res.end()
        return
      }
      const body = readBoundedBody(req).then(parseCredentialBody)
      const parsed = await body
      if (parsed === undefined) {
        sendJson(res, 400, { status: 'error', error: 'expected {"value": "..."} or {"clear": true}' })
        return
      }
      try {
        if (parsed.clear === true) await ctx.credentials.unset(config.credentialRef)
        else await ctx.credentials.set(config.credentialRef, parsed.value)
      } catch (error) {
        sendJson(res, 409, { status: 'error', error: error instanceof Error ? error.message : String(error) })
        return
      }
      cached = undefined
      sendJson(res, 200, await current())
    },
  }), `openrouter-spend: POST ${CREDENTIAL_PATH}`)

  // Prime the cache so the first browser poll is a reply rather than a stall.
  ctx.effect(() => {
    void current().catch(error => ctx.logger.warn('openrouter-spend: priming failed', error))
    return () => undefined
  })
}