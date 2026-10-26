/**
 * Offline verification driver for @local/tg-notify (not shipped; run by hand):
 *
 *   node --import tsx/esm .local-plugins/tg-notify/.verify.mjs
 *
 * Boots the REAL vendored Cordis Context with stub `credentials`,
 * `sessionTitle`, and `commands` services, mounts the real plugin aimed at a
 * local HTTP sink standing in for api.telegram.org, emits synthetic harness
 * events over the real event bus, and asserts the outgoing messages.
 */
import http from 'node:http'
import { Context, Service } from '../../vendor/cordis/src/index.ts'
import * as plugin from './index.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let failures = 0
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok  ${name}`)
  } else {
    failures += 1
    console.error(`FAIL  ${name}${detail === '' ? '' : ` :: ${detail}`}`)
  }
}

/** Minimal credentials stub: a plain env map behind resolve/describe. */
class CredentialsStub extends Service {
  constructor(ctx, env) {
    super(ctx, 'credentials')
    this.env = env
  }
  async resolve(ref) {
    const value = this.env[ref]
    return value === undefined ? undefined : { value, source: 'env' }
  }
  async describe(ref) {
    return { configured: this.env[ref] !== undefined, writable: false }
  }
}

class SessionTitleStub extends Service {
  constructor(ctx) {
    super(ctx, 'sessionTitle')
  }
  get() {
    return undefined
  }
}

class CommandsStub extends Service {
  definitions = new Map()
  constructor(ctx) {
    super(ctx, 'commands')
  }
  register(definition) {
    this.definitions.set(definition.name, definition)
    return () => this.definitions.delete(definition.name)
  }
}

class SessionsStub extends Service {
  constructor(ctx) {
    super(ctx, 'sessions')
  }
  list() {
    return []
  }
}

/** HTTP sink standing in for api.telegram.org. */
const received = []
const sink = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    let body
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      body = undefined
    }
    received.push({ path: req.url, body })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, result: { message_id: received.length } }))
  })
})
await new Promise((resolve) => sink.listen(0, '127.0.0.1', resolve))
const sinkUrl = `http://127.0.0.1:${sink.address().port}`

const ENV = {
  TG_NOTIFY_BOT_TOKEN: '123456:TEST_TOKEN',
  TG_NOTIFY_CHAT_ID: '424242',
}

const baseConfig = {
  apiBase: sinkUrl,
  idleDebounceMs: 150,
  minRunSeconds: 0,
  minJobMs: 0,
  notifyStartup: false,
  notifySubagents: true,
}

const makeSession = (id, header = {}) => ({
  id,
  header: { cwd: '/home/ilya/dev/deepseek-harness', ...header },
})

const event = (type, data) => ({ type, time: Date.now(), data, seq: 0 })

async function main() {
  const ctx = new Context()
  new CredentialsStub(ctx, ENV)
  new SessionTitleStub(ctx)
  new SessionsStub(ctx)
  const commands = new CommandsStub(ctx)
  await ctx.plugin(plugin, baseConfig)

  const session = makeSession('sess-aaaaaaaaaaaaaaaa')
  const agent = { id: 'agent-1', session }

  // 1) approval/asked -> immediate ping
  ctx.emit('session/event', session, event('approval/asked', { id: 'ap1', toolName: 'bash', reason: 'sandbox: выход за воркспейс' }))
  await sleep(300)
  check('approval: отправлено', received.some((r) => r.body?.text?.includes('нужно одобрение')), JSON.stringify(received.at(-1)?.body?.text))
  check('approval: инструмент в тексте', received.some((r) => r.body?.text?.includes('<code>bash</code>')))

  // 2) ask_user_question tool call -> question ping
  ctx.emit('session/event', session, event('tool/call', {
    turn: 1,
    step: 1,
    callId: 'c1',
    name: 'ask_user_question',
    arguments: JSON.stringify({ questions: [{ id: 'q1', header: 'Confirm', question: 'Удалять файлы <все>?' }] }),
  }))
  await sleep(300)
  check('question: отправлено', received.some((r) => r.body?.text?.includes('ждёт ответа')))
  check('question: текст вопроса экранирован', received.some((r) => r.body?.text?.includes('Удалять файлы &lt;все&gt;?')))

  // 3) job/settled -> job ping with duration
  ctx.emit('session/event', session, event('job/settled', {
    jobId: 'job-1', owner: session.id, kind: 'bash', label: 'pnpm build',
    startedAt: Date.now() - 95_000, finishedAt: Date.now(),
    status: 'completed', cause: 'producer', producerReported: true,
  }))
  await sleep(300)
  check('job: отправлено', received.some((r) => r.body?.text?.includes('фоновая задача завершена')))
  check('job: label в тексте', received.some((r) => r.body?.text?.includes('pnpm build')))

  // 4) goal complete
  ctx.emit('goal/changed', { agent, change: { operation: 'update', ref: {}, goal: { phase: 'complete', objective: 'Рабочий TG-нотификатор' } } })
  await sleep(300)
  check('goal: отправлено', received.some((r) => r.body?.text?.includes('цель достигнута')))

  // 5) subagent end (notifySubagents: true in this run)
  ctx.emit('subagent/end', { runId: 'r1', provider: 'spawn', id: 'sess-bbbbbbbbbbbbbbbb', local: true, stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: 'Нашёл 3 релевантных файла' }] })
  await sleep(300)
  check('subagent: отправлено', received.some((r) => r.body?.text?.includes('сабагент завершён')))

  // 6) idle after a run: title + escaped final message + duration
  ctx.emit('session/event', session, event('session/title', { title: 'TG & notifier <plugin>', messageSeqs: [], source: { kind: 'user' } }))
  ctx.emit('agent/status', { agent, status: 'running' })
  await sleep(50)
  ctx.emit('session/event', session, event('turn/start', { turn: 2 }))
  ctx.emit('session/event', session, event('assistant/message', { turn: 2, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'Готово: <b>плагин</b> & работает' }] } }))
  ctx.emit('session/event', session, event('turn/end', { turn: 2, reason: { kind: 'completed' } }))
  ctx.emit('agent/status', { agent, status: 'idle' })
  await sleep(500)
  const idleMessage = received.find((r) => r.body?.text?.includes('DSH: задача завершена'))
  check('idle: отправлено', idleMessage !== undefined)
  check('idle: заголовок экранирован', idleMessage?.body?.text?.includes('TG &amp; notifier &lt;plugin&gt;'))
  check('idle: текст экранирован', idleMessage?.body?.text?.includes('&lt;b&gt;плагин&lt;/b&gt; &amp; работает'))
  check('idle: длительность в тексте', /\d+ (с|мин)/.test(idleMessage?.body?.text ?? ''))
  check('idle: parse_mode HTML + chat id', idleMessage?.body?.parse_mode === 'HTML' && idleMessage?.body?.chat_id === '424242')
  check('idle: токен в пути', received.every((r) => r.path === '/bot123456:TEST_TOKEN/sendMessage'))

  // 7) error reason badge
  ctx.emit('agent/status', { agent, status: 'running' })
  await sleep(50)
  ctx.emit('session/event', session, event('turn/start', { turn: 3 }))
  ctx.emit('session/event', session, event('turn/end', { turn: 3, reason: { kind: 'error', error: { message: 'boom' } } }))
  ctx.emit('agent/status', { agent, status: 'idle' })
  await sleep(500)
  check('idle после ошибки: бейдж', received.some((r) => r.body?.text?.includes('❌') && r.body?.text?.includes('ошибка хода')))

  // 8) subagent-origin session never idles into a notification
  const childSession = makeSession('sess-child', { origin: 'subagent' })
  const childAgent = { id: 'agent-child', session: childSession }
  const before = received.length
  ctx.emit('agent/status', { agent: childAgent, status: 'running' })
  await sleep(50)
  ctx.emit('agent/status', { agent: childAgent, status: 'idle' })
  await sleep(400)
  check('subagent-сессия: idle без уведомления', received.length === before)

  // 9) /tg-test command
  const testCommand = commands.definitions.get('tg-test')
  check('/tg-test зарегистрирован', testCommand !== undefined)
  const result = await testCommand.handler({ agent, rawInput: '', signal: new AbortController().signal })
  check('/tg-test: успех', result?.kind === 'success' && received.some((r) => r.body?.text?.includes('/tg-test')), JSON.stringify(result))

  // 10) regression: an approval survives a saturated rate limit
  const ctx4 = new Context()
  new CredentialsStub(ctx4, ENV)
  new SessionTitleStub(ctx4)
  new SessionsStub(ctx4)
  new CommandsStub(ctx4)
  await ctx4.plugin(plugin, { ...baseConfig, ratePerMinute: 1 })
  const beforeBurst = received.length
  const burstSession = makeSession('sess-burst')
  for (let index = 0; index < 6; index += 1) {
    ctx4.emit('session/event', burstSession, event('job/settled', {
      jobId: `j${index}`, owner: burstSession.id, kind: 'bash', label: `job-${index}`,
      startedAt: Date.now() - 90_000, finishedAt: Date.now(), status: 'completed', cause: 'producer',
    }))
  }
  ctx4.emit('session/event', burstSession, event('approval/asked', { id: 'ap-burst', toolName: 'bash', reason: 'нужно подтверждение' }))
  await sleep(700)
  const burst = received.slice(beforeBurst)
  check('rate limit: джобы отброшены', burst.filter((r) => r.body?.text?.includes('фоновая задача')).length <= 1, `джоб прошло: ${burst.filter((r) => r.body?.text?.includes('фоновая задача')).length}`)
  check('rate limit: одобрение всё равно доставлено', burst.some((r) => r.body?.text?.includes('нужно одобрение')))

  // 11) regression: an error turn does not inherit the previous turn's text
  const ctx5 = new Context()
  new CredentialsStub(ctx5, ENV)
  new SessionTitleStub(ctx5)
  new SessionsStub(ctx5)
  new CommandsStub(ctx5)
  await ctx5.plugin(plugin, baseConfig)
  const beforeErr = received.length
  const session5 = makeSession('sess-err')
  const agent5 = { id: 'agent-err', session: session5 }
  ctx5.emit('agent/status', { agent: agent5, status: 'running' })
  await sleep(30)
  ctx5.emit('session/event', session5, event('turn/start', { turn: 1 }))
  ctx5.emit('session/event', session5, event('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'УСПЕШНЫЙ ОТВЕТ ПРОШЛОГО ХОДА' }] } }))
  ctx5.emit('session/event', session5, event('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  ctx5.emit('session/event', session5, event('turn/start', { turn: 2 }))
  ctx5.emit('session/event', session5, event('turn/end', { turn: 2, reason: { kind: 'error', error: { message: 'boom' } } }))
  ctx5.emit('agent/status', { agent: agent5, status: 'idle' })
  await sleep(500)
  const errMessage = received.slice(beforeErr).find((r) => r.body?.text?.includes('DSH: задача завершена'))
  check('ошибка: бейдж проставлен', errMessage?.body?.text?.includes('❌') === true)
  check('ошибка: текст прошлого хода не приписан', errMessage?.body?.text?.includes('УСПЕШНЫЙ ОТВЕТ ПРОШЛОГО ХОДА') !== true, JSON.stringify(errMessage?.body?.text))

  // 12) regression: a token-bearing failure never surfaces the token
  const ctx6 = new Context()
  new CredentialsStub(ctx6, { ...ENV, TG_NOTIFY_BOT_TOKEN: '123456:TEST_TOKEN bad/token' })
  new SessionTitleStub(ctx6)
  new SessionsStub(ctx6)
  new CommandsStub(ctx6)
  await ctx6.plugin(plugin, { ...baseConfig, apiBase: "http://127.0.0.1:9", timeoutMs: 1000 })
  const ctx6Commands = ctx6.get('commands').definitions.get('tg-test')
  const failResult = await ctx6Commands.handler({ agent: { id: 'a', session: makeSession('s6') }, rawInput: '', signal: new AbortController().signal })
  check('ошибка отправки: токен в ответе замаскирован', !JSON.stringify(failResult).includes('TEST_TOKEN'), JSON.stringify(failResult))

  // 13) level approval-only suppresses idle/job/goal
  const ctx2 = new Context()
  new CredentialsStub(ctx2, ENV)
  new SessionTitleStub(ctx2)
  new SessionsStub(ctx2)
  new CommandsStub(ctx2)
  await ctx2.plugin(plugin, { ...baseConfig, level: 'approval-only' })
  const countBefore = received.length
  const session2 = makeSession('sess-lvl')
  const agent2 = { id: 'agent-lvl', session: session2 }
  ctx2.emit('session/event', session2, event('approval/asked', { id: 'ap2', toolName: 'write' }))
  ctx2.emit('agent/status', { agent: agent2, status: 'running' })
  await sleep(50)
  ctx2.emit('agent/status', { agent: agent2, status: 'idle' })
  await sleep(400)
  const afterApprovalOnly = received.length - countBefore
  check('approval-only: одобрение пришло', received.slice(countBefore).some((r) => r.body?.text?.includes('нужно одобрение')))
  check('approval-only: idle подавлен', !received.slice(countBefore).some((r) => r.body?.text?.includes('DSH: задача завершена')), `получено ${afterApprovalOnly} сообщений`)

  // 11) send failure is contained and reported, with no token in the log line
  const logged = []
  const ctx3 = new Context()
  new CredentialsStub(ctx3, ENV)
  new SessionTitleStub(ctx3)
  new SessionsStub(ctx3)
  new CommandsStub(ctx3)
  ctx3.logger.exporter({ levels: { default: 3 }, export: (record) => logged.push(JSON.stringify(record.args ?? record.content ?? record)) })
  await ctx3.plugin(plugin, { ...baseConfig, apiBase: 'http://127.0.0.1:9', timeoutMs: 1000 })
  const session3 = makeSession('sess-dead')
  ctx3.emit('session/event', session3, event('approval/asked', { id: 'ap3', toolName: 'bash' }))
  await sleep(4500)
  const sendFailureLine = logged.find((line) => line.includes('отправка не удалась'))
  check('сбой отправки: ошибка попала в лог', sendFailureLine !== undefined, JSON.stringify(logged.slice(-3)))
  check('сбой отправки: токена в логе нет', !logged.some((line) => line.includes('TEST_TOKEN')), JSON.stringify(logged.slice(-3)))

  // 12) real thresholds: a run shorter than minRunSeconds stays silent
  const ctxShort = new Context()
  new CredentialsStub(ctxShort, ENV)
  new SessionTitleStub(ctxShort)
  new SessionsStub(ctxShort)
  new CommandsStub(ctxShort)
  await ctxShort.plugin(plugin, { ...baseConfig, minRunSeconds: 5, idleDebounceMs: 100 })
  const shortBefore = received.length
  const shortSession = makeSession('sess-short')
  const shortAgent = { id: 'agent-short', session: shortSession }
  ctxShort.emit('agent/status', { agent: shortAgent, status: 'running' })
  await sleep(120)
  ctxShort.emit('agent/status', { agent: shortAgent, status: 'idle' })
  await sleep(500)
  check('порог minRunSeconds: короткий ход молчит', received.length === shortBefore, `ушло ${received.length - shortBefore}`)

  // 13) debounce across a real running→idle→running→idle cycle: one ping, summed duration
  const ctxCycle = new Context()
  new CredentialsStub(ctxCycle, ENV)
  new SessionTitleStub(ctxCycle)
  new SessionsStub(ctxCycle)
  new CommandsStub(ctxCycle)
  await ctxCycle.plugin(plugin, { ...baseConfig, idleDebounceMs: 300, minRunSeconds: 0 })
  const cycleBefore = received.length
  const cycleSession = makeSession('sess-cycle')
  const cycleAgent = { id: 'agent-cycle', session: cycleSession }
  ctxCycle.emit('agent/status', { agent: cycleAgent, status: 'running' })
  await sleep(1100)
  ctxCycle.emit('agent/status', { agent: cycleAgent, status: 'idle' })
  await sleep(100)
  ctxCycle.emit('agent/status', { agent: cycleAgent, status: 'running' })
  await sleep(1100)
  ctxCycle.emit('agent/status', { agent: cycleAgent, status: 'idle' })
  await sleep(700)
  const cycleMessages = received.slice(cycleBefore).filter((r) => r.body?.text?.includes('DSH: задача завершена'))
  check('дебаунс: два захода → один пинг', cycleMessages.length === 1, `пингов: ${cycleMessages.length}`)
  // The second `running` cancels the first debounce timer but keeps its start
  // time, so the reported duration covers both bursts (~2.6 s here) instead of
  // restarting — that is the accumulation this assertion pins down.
  const cycleSeconds = Number(/(\d+) с/.exec(cycleMessages[0]?.body?.text ?? '')?.[1] ?? '0')
  check('дебаунс: длительность суммирует оба захода', cycleSeconds >= 2, `длительность: ${cycleSeconds} с`)

  // 14) truncation: a huge final message stays under the limit and never splits an entity
  const ctxLong = new Context()
  new CredentialsStub(ctxLong, ENV)
  new SessionTitleStub(ctxLong)
  new SessionsStub(ctxLong)
  new CommandsStub(ctxLong)
  const limit = 3800
  await ctxLong.plugin(plugin, { ...baseConfig, maxChars: limit, idleDebounceMs: 100, minRunSeconds: 0 })
  const longBefore = received.length
  const longSession = makeSession('sess-long')
  const longAgent = { id: 'agent-long', session: longSession }
  ctxLong.emit('agent/status', { agent: longAgent, status: 'running' })
  await sleep(30)
  // '<' and '&' expand five-fold when escaped: the cut must still respect the budget.
  ctxLong.emit('session/event', longSession, event('assistant/message', {
    turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '<&>'.repeat(4000) }] },
  }))
  ctxLong.emit('agent/status', { agent: longAgent, status: 'idle' })
  await sleep(500)
  const longMessage = received.slice(longBefore).find((r) => r.body?.text?.includes('DSH: задача завершена'))
  check('усечение: сообщение не длиннее лимита', (longMessage?.body?.text?.length ?? 0) <= limit, `длина ${longMessage?.body?.text?.length}`)
  check('усечение: все entity закрыты', !/&(?![a-z]+;|#\d+;)/.test(longMessage?.body?.text ?? ''), 'найден разорванный &')
  check('усечение: многоточие на месте среза', (longMessage?.body?.text ?? '').includes('…'))

  // 15) goal blocked branch (only the 'complete' phase was covered above)
  const blockedBefore = received.length
  ctx.emit('goal/changed', { agent, change: { operation: 'update', ref: {}, goal: { phase: 'blocked', objective: 'Довести нотификатор', blockedReason: { code: 'needs-input', message: 'нужен chat id' } } } })
  await sleep(300)
  const blockedMessage = received.slice(blockedBefore).find((r) => r.body?.text?.includes('цель заблокирована'))
  check('goal: ветка blocked', blockedMessage !== undefined)
  check('goal: причина блокировки в тексте', blockedMessage?.body?.text?.includes('нужен chat id') === true)

  // 16) machine badge: the default is this OS hostname, TG_NOTIFY_HOST and
  // config.hostLabel override it, and a sandboxed host degrades to no badge
  // rather than to a broken message.
  const hostNow = (await import('node:os')).hostname().split('.')[0]
  check('host: бейдж по умолчанию — hostname машины',
    received.filter((r) => r.body?.text?.includes('🖥 <code>')).every((r) => r.body?.text?.includes(`<code>${hostNow}</code>`)),
    hostNow)

  const ctxHost = new Context()
  new CredentialsStub(ctxHost, { ...ENV, TG_NOTIFY_HOST: 'wsl-workstation' })
  new SessionTitleStub(ctxHost)
  new SessionsStub(ctxHost)
  new CommandsStub(ctxHost)
  await ctxHost.plugin(plugin, { ...baseConfig, notifyStartup: false })
  const hostBefore = received.length
  const hostSession = makeSession('sess-host')
  ctxHost.emit('session/event', hostSession, event('approval/asked', { id: 'ap-host', toolName: 'bash' }))
  await sleep(400)
  const hostMessage = received.slice(hostBefore).find((r) => r.body?.text?.includes('нужно одобрение'))
  check('host: TG_NOTIFY_HOST переопределяет машину', hostMessage?.body?.text?.includes('<code>wsl-workstation</code>') === true, JSON.stringify(hostMessage?.body?.text))
  check('host: машина не дублируется', (hostMessage?.body?.text?.match(/🖥 /g) ?? []).length === 1)

  const ctxLabel = new Context()
  new CredentialsStub(ctxLabel, { ...ENV, TG_NOTIFY_HOST: 'from-env' })
  new SessionTitleStub(ctxLabel)
  new SessionsStub(ctxLabel)
  new CommandsStub(ctxLabel)
  await ctxLabel.plugin(plugin, { ...baseConfig, hostLabel: 'macbook-pro', notifyStartup: false })
  const labelBefore = received.length
  const labelSession = makeSession('sess-label')
  ctxLabel.emit('session/event', labelSession, event('approval/asked', { id: 'ap-label', toolName: 'bash' }))
  await sleep(400)
  const labelMessage = received.slice(labelBefore).find((r) => r.body?.text?.includes('нужно одобрение'))
  check('host: config.hostLabel сильнее env', labelMessage?.body?.text?.includes('<code>macbook-pro</code>') === true, JSON.stringify(labelMessage?.body?.text))

  // 17) markdown rendering: the final answer arrives as Telegram HTML, not raw
  // markdown — fences, inline code and emphasis become tags, and markup the
  // model wrote as literal text stays escaped.
  const ctxMd = new Context()
  new CredentialsStub(ctxMd, ENV)
  new SessionTitleStub(ctxMd)
  new SessionsStub(ctxMd)
  new CommandsStub(ctxMd)
  await ctxMd.plugin(plugin, { ...baseConfig, idleDebounceMs: 100, minRunSeconds: 0, notifyStartup: false })
  const mdBefore = received.length
  const mdSession = makeSession('sess-md')
  const mdAgent = { id: 'agent-md', session: mdSession }
  const answer = [
    'Итог: **готово**, файл *Main.java* тронут.',
    '',
    '- пункт с `inline code`',
    '',
    '```js',
    'const x = a < b && c > d',
    '```',
    '',
    'Литеральный тег <b> остаётся текстом, snake_case_name цел.',
  ].join('\n')
  ctxMd.emit('agent/status', { agent: mdAgent, status: 'running' })
  await sleep(30)
  ctxMd.emit('session/event', mdSession, event('turn/start', { turn: 1 }))
  ctxMd.emit('session/event', mdSession, event('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: answer }] } }))
  ctxMd.emit('session/event', mdSession, event('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  ctxMd.emit('agent/status', { agent: mdAgent, status: 'idle' })
  await sleep(500)
  const mdText = received.slice(mdBefore).find((r) => r.body?.text?.includes('DSH: задача завершена'))?.body?.text ?? ''
  check('md: жирный стал тегом', mdText.includes('<b>готово</b>'), mdText.slice(0, 200))
  check('md: курсив стал тегом', mdText.includes('<i>Main.java</i>'))
  check('md: inline code стал тегом', mdText.includes('<code>inline code</code>'))
  check('md: блок кода стал pre+code', mdText.includes('<pre><code class="language-js">'))
  check('md: в коде < и && экранированы', mdText.includes('a &lt; b &amp;&amp; c &gt; d'))
  check('md: сырых ** и ``` не осталось', !mdText.includes('**') && !mdText.includes('```'), mdText.slice(0, 300))
  check('md: литеральный <b> модели остался текстом', mdText.includes('&lt;b&gt;'))
  check('md: snake_case не стал курсивом', mdText.includes('snake_case_name'))
  check('md: теги сбалансированы',
    (mdText.match(/<[a-z]+/gi) ?? []).length === (mdText.match(/<\/[a-z]+>/gi) ?? []).length,
    `${(mdText.match(/<[a-z]+/gi) ?? []).length} открыто / ${(mdText.match(/<\/[a-z]+>/gi) ?? []).length} закрыто`)

  // 18) a fenced block cut by the budget is still closed, or Telegram rejects
  // the whole message
  const ctxCut = new Context()
  new CredentialsStub(ctxCut, ENV)
  new SessionTitleStub(ctxCut)
  new SessionsStub(ctxCut)
  new CommandsStub(ctxCut)
  const cutLimit = 700
  await ctxCut.plugin(plugin, { ...baseConfig, maxChars: cutLimit, idleDebounceMs: 100, minRunSeconds: 0, notifyStartup: false })
  const cutBefore = received.length
  const cutSession = makeSession('sess-cut')
  const cutAgent = { id: 'agent-cut', session: cutSession }
  const longAnswer = ['```py', ...Array.from({ length: 200 }, (_, i) => `line_${i} = compute(${i}) < 10 && ok`), '```'].join('\n')
  ctxCut.emit('agent/status', { agent: cutAgent, status: 'running' })
  await sleep(30)
  ctxCut.emit('session/event', cutSession, event('turn/start', { turn: 1 }))
  ctxCut.emit('session/event', cutSession, event('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: longAnswer }] } }))
  ctxCut.emit('session/event', cutSession, event('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  ctxCut.emit('agent/status', { agent: cutAgent, status: 'idle' })
  await sleep(500)
  const cutText = received.slice(cutBefore).find((r) => r.body?.text?.includes('DSH: задача завершена'))?.body?.text ?? ''
  check('md-обрезка: уложились в лимит', cutText.length <= cutLimit, `длина ${cutText.length}`)
  check('md-обрезка: <pre> закрыт', (cutText.match(/<pre>/g) ?? []).length === (cutText.match(/<\/pre>/g) ?? []).length, JSON.stringify(cutText.slice(-120)))
  check('md-обрезка: <code> закрыт', (cutText.match(/<code[\s>]/g) ?? []).length === (cutText.match(/<\/code>/g) ?? []).length)

  sink.close()
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
  process.exitCode = failures === 0 ? 0 : 1
}

await main()
