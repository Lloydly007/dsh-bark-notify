/**
 * Branch coverage for dsh-bark-notify without ringing the phones.
 *
 * Drives the plugin's REAL `apply()` — same `ctx.inject` / `ctx.effect` /
 * `ctx.on` / `ctx.jobs.events.subscribe` registration the Host uses — against a
 * stub context, and points the push at a throwaway HTTP server on loopback so
 * every card the plugin decides to send is captured and asserted instead of
 * delivered.
 *
 * Usage (from this directory): `node simulate.mjs`
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Config, apply, buildPayload, normalizeConfig, sendBark } from './index.js'

/**
 * Minimal Cordis-shaped context: inject resolves immediately, on() records
 * listeners and their options, `sessions.get/list` return the seeded sessions,
 * `jobs.events.subscribe` records a live subscription, and `sessionTitle`
 * mirrors the real service's `{ title, … }` snapshot.
 */
function fakeContext(liveSessions = [], options = {}) {
  const listeners = new Map()
  const optionsByEvent = new Map()
  const lines = []
  const jobSubscriptions = []
  const byId = new Map(liveSessions.map((session) => [String(session.header.id), session]))
  const record = (level) => (message) => lines.push(`${level} ${message}`)
  const ctx = {
    logger: { info: record('info'), warn: record('warn'), debug: record('debug') },
    sessions: {
      list: () => liveSessions,
      get: (id) => byId.get(String(id)),
    },
    jobs: {
      events: {
        subscribe: (filter, listener) => {
          const entry = { filter, listener }
          jobSubscriptions.push(entry)
          return () => {
            const index = jobSubscriptions.indexOf(entry)
            if (index >= 0) jobSubscriptions.splice(index, 1)
          }
        },
      },
    },
    sessionTitle: options.sessionTitle,
    inject: (_names, callback) => {
      callback(ctx)
      return { dispose: () => {} }
    },
    effect: (callback) => {
      const dispose = callback()
      return async () => {
        if (typeof dispose === 'function') await dispose()
      }
    },
    on: (event, callback, opts) => {
      listeners.set(event, [...(listeners.get(event) ?? []), callback])
      optionsByEvent.set(event, opts)
      return () => listeners.set(event, (listeners.get(event) ?? []).filter((one) => one !== callback))
    },
  }
  /** Deliver one fake job settlement to every live jobs subscription. */
  const emitJob = (event) => {
    for (const { listener } of [...jobSubscriptions]) listener(event)
  }
  return { ctx, listeners, options: optionsByEvent, lines, emitJob, jobSubscriptions }
}

/**
 * Start the capture server and return its base URL plus the received pushes.
 * `reply(index, payload)` may script a status/body per request (default 200).
 */
async function captureServer(reply = () => ({ status: 200, body: '{"code":200,"message":"success"}' })) {
  const requests = []
  const server = createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      let payload
      try {
        payload = JSON.parse(text)
      } catch {
        payload = undefined
      }
      const index = requests.length
      requests.push({ method: request.method, url: request.url, payload, type: request.headers['content-type'], text })
      const outcome = reply(index, payload) ?? { status: 200, body: '{"code":200,"message":"success"}' }
      response.writeHead(outcome.status ?? 200, { 'content-type': 'application/json' })
      response.end(outcome.body ?? '{"code":200,"message":"success"}')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { base: `http://127.0.0.1:${port}`, requests, close: () => new Promise((resolve) => server.close(resolve)) }
}

const silent = { info: () => {}, warn: () => {}, debug: () => {} }
const root = { header: { id: 'root-1' }, snapshotEvents: () => [] }
const subagent = { header: { id: 'child-1', origin: 'subagent' }, snapshotEvents: () => [] }

/** A live session stand-in whose log the arm-time recovery can fold. */
function loggedSession(id, events, origin) {
  return {
    header: { id, ...(origin === undefined ? {} : { origin }) },
    snapshotEvents: () => events,
  }
}

/** One appended event. */
const at = (type, data, time = Date.now()) => ({ type, time, data })

/** Build the event sequence of one ordinary turn. */
function turnEvents(turn, { user = '帮我把网关的 pin 重建一遍', preview = '重建完成，216 个 pin 全部唯一。', reason = { kind: 'completed' } } = {}) {
  return [
    at('turn/start', { turn }),
    ...(user === null ? [] : [at('user/message', { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: user }] })]),
    at('assistant/message', { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: preview }] } }),
    at('turn/end', { turn, reason }),
  ]
}

/** Fire one event list at every registered session/event listener. */
function emit(listeners, session, events) {
  for (const event of events) {
    for (const listener of listeners.get('session/event') ?? []) listener(session, event)
  }
}

/** Let the fire-and-forget pushes reach the capture server. */
const settle = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms))

const results = []
/** Record one assertion. */
function check(what, condition, detail = '') {
  results.push({ what, ok: Boolean(condition), detail })
}

const capture = await captureServer()
const config = (extra) => normalizeConfig({ server: capture.base, deviceKeys: ['TESTKEY'], ...extra })

try {
  // 1) an ordinary user turn completes, through one batched POST /push
  {
    const { ctx, listeners, options } = fakeContext()
    apply(ctx, config({ previewChars: 40, group: 'DSH' }))
    emit(listeners, root, turnEvents(1))
    await settle()
    check('completed turn sends exactly one request', capture.requests.length === 1, `got ${capture.requests.length}`)
    const request = capture.requests[0] ?? {}
    const payload = request.payload ?? {}
    check('the request is POST /push with JSON', request.method === 'POST' && request.url === '/push' && String(request.type).startsWith('application/json'), `${request.method} ${request.url} ${request.type}`)
    check('device_keys carries the device list', Array.isArray(payload.device_keys) && payload.device_keys.join(',') === 'TESTKEY', JSON.stringify(payload.device_keys))
    check('card title marks success', payload.title === '✅ 对话完成', payload.title)
    check('subtitle carries label and duration', String(payload.subtitle).includes('帮我把网关的 pin 重建一遍') && /\d+ 秒/.test(String(payload.subtitle)), payload.subtitle)
    check('plain body carries the preview and no markdown field', String(payload.body).startsWith('重建完成，216 个 pin 全部唯一。') && payload.markdown === undefined, JSON.stringify(payload))
    check('level/group/archive follow the official names', payload.level === 'active' && payload.group === 'DSH' && payload.isArchive === '1', JSON.stringify(payload))
    check('both registrations opt out of scope admission', options.get('session/event')?.global === true && options.get('session/disposed')?.global === true, JSON.stringify([...options.entries()]))
    capture.requests.length = 0
  }

  // 2) every distinct device rides one batch, duplicates collapse
  {
    const { ctx, listeners } = fakeContext()
    apply(ctx, config({ deviceKeys: ['KEYA', 'KEYA', 'KEYB'], deviceKey: 'KEYB' }))
    emit(listeners, root, turnEvents(1))
    await settle()
    check('duplicate keys collapse into one batched request', capture.requests.length === 1 && capture.requests[0]?.payload?.device_keys?.join(',') === 'KEYA,KEYB', JSON.stringify(capture.requests.map((one) => one.payload?.device_keys)))
    capture.requests.length = 0
  }

  // 3) the official parameter set maps onto the payload
  {
    const { ctx, listeners } = fakeContext()
    apply(ctx, config({
      markdown: true,
      collapse: true,
      collapseId: 'dsh-turn',
      ttl: 3600,
      badge: 3,
      action: 'none',
      sound: 'minuet',
      level: 'critical',
      volume: 7,
      call: true,
      icon: 'https://example.test/i.png',
      image: 'https://example.test/p.png',
      url: 'https://example.test/go',
      copy: 'copy me',
    }))
    emit(listeners, root, turnEvents(1, { preview: '**完成**：见 `push.log`' }))
    await settle()
    const payload = capture.requests[0]?.payload ?? {}
    check('markdown replaces body', typeof payload.markdown === 'string' && payload.markdown.includes('**完成**') && payload.body === undefined, JSON.stringify(payload))
    check('id/ttl/badge are typed as the reference requires', payload.id === 'dsh-turn' && payload.ttl === 3600 && payload.badge === 3, JSON.stringify(payload))
    check('critical carries a string volume, call is "1"', payload.level === 'critical' && payload.volume === '7' && payload.call === '1', JSON.stringify(payload))
    check('display and tap fields travel', payload.sound === 'minuet' && payload.action === 'none' && payload.icon.endsWith('i.png') && payload.image.endsWith('p.png') && payload.url === 'https://example.test/go' && payload.copy === 'copy me', JSON.stringify(payload))
    capture.requests.length = 0
  }

  // 4) subagent sessions, aborted turns, and untriggered turns stay silent
  {
    const { ctx, listeners } = fakeContext()
    apply(ctx, config({}))
    emit(listeners, subagent, turnEvents(1))
    emit(listeners, root, turnEvents(2, { reason: { kind: 'aborted', reason: { kind: 'user' } } }))
    emit(listeners, root, turnEvents(3, { user: null }))
    emit(listeners, root, [at('turn/end', { turn: 99, reason: { kind: 'completed' } })])
    emit(listeners, root, turnEvents(4, { reason: { kind: 'interrupted' } }))
    for (const listener of listeners.get('session/disposed') ?? []) listener(root)
    await settle()
    check('subagent / aborted / interrupted / user-less turns are silent', capture.requests.length === 0, `got ${capture.requests.length}`)
    capture.requests.length = 0
  }

  // 5) minTurnSeconds filters quick back-and-forth
  {
    const { ctx, listeners } = fakeContext()
    apply(ctx, config({ minTurnSeconds: 3600 }))
    emit(listeners, root, turnEvents(1))
    await settle()
    check('minTurnSeconds suppresses short turns', capture.requests.length === 0, `got ${capture.requests.length}`)
  }

  // 6) a failed turn reports the failure
  {
    const { ctx, listeners } = fakeContext()
    apply(ctx, config({}))
    emit(listeners, root, turnEvents(1, { reason: { kind: 'error', error: { message: 'upstream 503', code: 'E_PROVIDER' } } }))
    await settle()
    const payload = capture.requests[0]?.payload ?? {}
    check('failed turn pushes exactly one card', capture.requests.length === 1, `got ${capture.requests.length}`)
    check('failure card is marked and carries the reason', payload.title === '❌ 对话出错' && String(payload.body).includes('E_PROVIDER: upstream 503'), JSON.stringify(payload))
    capture.requests.length = 0
  }

  // 7) armed mid-turn: the in-flight turn is recovered from the session log
  {
    const inFlight = [
      at('turn/start', { turn: 7 }, Date.now() - 5000),
      at('user/message', { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '把网关 pin 重建一遍' }] }, Date.now() - 5000),
      at('assistant/message', { turn: 7, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '正在重扫池子' }] } }, Date.now() - 1000),
    ]
    const { ctx, listeners, lines } = fakeContext([loggedSession('root-1', inFlight)])
    apply(ctx, config({ previewChars: 40 }))
    check('arm time reports the adopted in-flight turn', lines.some((line) => line.includes('adopted 1 in-flight turn')), lines.join(' | '))
    emit(listeners, root, [at('turn/end', { turn: 7, reason: { kind: 'completed' } })])
    await settle()
    const payload = capture.requests[0]?.payload ?? {}
    check('a turn that started before arming still pushes', capture.requests.length === 1, `got ${capture.requests.length}`)
    check('recovered card keeps the log label, preview, and real duration', String(payload.subtitle).includes('把网关 pin 重建一遍') && /5 秒/.test(String(payload.subtitle)) && String(payload.body).startsWith('正在重扫池子'), JSON.stringify(payload))
    capture.requests.length = 0
  }

  // 8) the card is labelled by the conversation, not by a two-word follow-up
  {
    const history = [
      at('turn/start', { turn: 1 }, Date.now() - 60000),
      at('user/message', { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '给我写个插件，对话完成时用bark通知我' }] }, Date.now() - 60000),
      at('turn/end', { turn: 1, reason: { kind: 'completed' } }, Date.now() - 50000),
    ]
    const { ctx, listeners } = fakeContext([loggedSession('root-1', history)])
    apply(ctx, config({}))
    emit(listeners, root, turnEvents(2, { user: '没收到', preview: '推送记录在 push.log 里。' }))
    await settle()
    const payload = capture.requests[0]?.payload ?? {}
    check('the session label wins over the short follow-up', String(payload.subtitle).includes('给我写个插件') && !String(payload.subtitle).includes('没收到'), payload.subtitle)
    capture.requests.length = 0
  }

  // 9) Markdown never leaks into the plain body
  {
    const { ctx, listeners } = fakeContext()
    apply(ctx, config({ previewChars: 120 }))
    emit(listeners, root, turnEvents(1, { preview: '## 结论：**不是** key 的问题\n\n- 见 `push.log`\n- 已完成' }))
    await settle()
    const payload = capture.requests[0]?.payload ?? {}
    check('markdown markers are stripped from the plain preview', String(payload.body).includes('结论：不是 key 的问题') && !/[#*`]/.test(String(payload.body)), payload.body)
    capture.requests.length = 0
  }

  // 10) arm-time recovery ignores idle and subagent sessions
  {
    const idle = loggedSession('root-1', turnEvents(3))
    const child = loggedSession('child-1', [at('turn/start', { turn: 1 })], 'subagent')
    const { ctx, listeners, lines } = fakeContext([idle, child])
    apply(ctx, config({}))
    check('closed and subagent sessions are not adopted', !lines.some((line) => line.includes('adopted')), lines.join(' | '))
    emit(listeners, root, [at('turn/end', { turn: 3, reason: { kind: 'completed' } })])
    await settle()
    check('an unadopted turn end pushes nothing', capture.requests.length === 0, `got ${capture.requests.length}`)
    capture.requests.length = 0
  }

  // 11) switch-shaped configs keep the listener armed but push nothing
  {
    for (const [name, extra] of [['enabled:false', { enabled: false }], ['empty deviceKeys', { deviceKeys: [] }]]) {
      const { ctx, listeners, lines } = fakeContext()
      apply(ctx, config(extra))
      emit(listeners, root, turnEvents(1))
      await settle()
      check(`${name} pushes nothing but stays armed`, capture.requests.length === 0 && (listeners.get('session/event') ?? []).length === 1, `pushes=${capture.requests.length} listeners=${(listeners.get('session/event') ?? []).length} log=${lines.join(' | ')}`)
      capture.requests.length = 0
    }
  }

  // 12) enable + device keys take effect live, without re-applying the plugin
  {
    const { ctx, listeners } = fakeContext()
    const live = { server: capture.base, enabled: false, deviceKeys: [] }
    apply(ctx, live)
    emit(listeners, root, turnEvents(1))
    await settle()
    check('a disabled listener stays silent', capture.requests.length === 0, `got ${capture.requests.length}`)
    live.enabled = true
    live.deviceKeys = ['TESTKEY']
    emit(listeners, root, turnEvents(2))
    await settle()
    check('enabling and adding a key live starts pushing', capture.requests.length === 1, `got ${capture.requests.length}`)
    live.enabled = false
    emit(listeners, root, turnEvents(3))
    await settle()
    check('disabling live stops the next push', capture.requests.length === 1, `got ${capture.requests.length}`)
    capture.requests.length = 0
  }

  // 13) the real session-title snapshot becomes the label
  {
    const session = loggedSession('root-1', [])
    const { ctx, listeners } = fakeContext([session], { sessionTitle: { get: () => ({ title: '网关 pin 重建' }) } })
    apply(ctx, config({}))
    emit(listeners, session, turnEvents(1, { user: '随便说点' }))
    await settle()
    const payload = capture.requests[0]?.payload ?? {}
    check('sessionTitle snapshot is used as the card label', String(payload.subtitle).startsWith('网关 pin 重建'), payload.subtitle)
    capture.requests.length = 0
  }

  // 14) injected context never becomes the label or opens a human turn
  {
    const history = [
      at('turn/start', { turn: 1 }, Date.now() - 60000),
      at('user/message', { role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: '<runtime context blob>' }] }, Date.now() - 60000),
      at('user/message', { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '真正的第一条' }] }, Date.now() - 59000),
      at('turn/end', { turn: 1, reason: { kind: 'completed' } }, Date.now() - 58000),
    ]
    const { ctx, listeners } = fakeContext([loggedSession('root-1', history)])
    apply(ctx, config({}))
    emit(listeners, root, turnEvents(2, { user: '继续' }))
    await settle()
    const payload = capture.requests[0]?.payload ?? {}
    check('runtime-context never wins the label', String(payload.subtitle).includes('真正的第一条') && !String(payload.subtitle).includes('runtime context'), payload.subtitle)
    capture.requests.length = 0

    const { ctx: quietCtx, listeners: quietListeners } = fakeContext()
    apply(quietCtx, config({}))
    emit(quietListeners, root, [
      at('turn/start', { turn: 1 }),
      at('user/message', { role: 'user', source: { kind: 'time-context' }, content: [{ type: 'text', text: '现在是 22:00' }] }),
      at('turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ])
    await settle()
    check('a turn without a human message stays silent', capture.requests.length === 0, `got ${capture.requests.length}`)
  }

  // 15) duration comes from the event clock, not from when the listener ran
  {
    const { ctx, listeners } = fakeContext()
    apply(ctx, config({}))
    const now = Date.now()
    emit(listeners, root, [
      at('turn/start', { turn: 1 }, now - 5000),
      at('user/message', { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '5 秒任务' }] }, now - 5000),
      at('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '完成' }] } }, now - 1000),
      at('turn/end', { turn: 1, reason: { kind: 'completed' } }, now),
    ])
    await settle()
    const payload = capture.requests[0]?.payload ?? {}
    check('duration follows event time', /5 秒/.test(String(payload.subtitle)), payload.subtitle)
    capture.requests.length = 0
  }

  // 16) diagnostics: `trace` reports what the listener actually receives
  {
    const quiet = fakeContext()
    apply(quiet.ctx, config({}))
    emit(quiet.listeners, root, turnEvents(1))
    await settle()
    check('trace is silent when off', !quiet.lines.some((line) => line.includes('trace ')), quiet.lines.join(' | '))
    capture.requests.length = 0

    const loud = fakeContext()
    apply(loud.ctx, config({ trace: true }))
    emit(loud.listeners, root, turnEvents(2))
    await settle()
    const traced = loud.lines.filter((line) => line.includes('trace '))
    check('trace names the turn lifecycle it received', traced.some((l) => l.includes('turn/start') && l.includes('turn=2')) && traced.some((l) => l.includes('source=user')) && traced.some((l) => l.includes('turn/end') && l.includes('reason=completed') && l.includes('tracked=yes')), traced.join(' | '))
    capture.requests.length = 0

    const untracked = fakeContext()
    apply(untracked.ctx, config({ trace: true }))
    emit(untracked.listeners, root, [at('turn/end', { turn: 9, reason: { kind: 'completed' } })])
    await settle()
    check('trace distinguishes an untracked turn end', untracked.lines.some((line) => line.includes('tracked=no')), untracked.lines.join(' | '))
    capture.requests.length = 0
  }

  // 17) "waiting for you" cards: an asked question and an approval request
  {
    const askArguments = JSON.stringify({
      questions: [{
        id: 'q1',
        header: '推送目标',
        question: '要推给哪几台设备？',
        options: [
          { label: '两台都推', description: 'primary + secondary' },
          { label: '只推 primary' },
          { label: '只推 secondary' },
          { label: '推给官方云 key' },
          { label: '先不推' },
        ],
      }],
    })
    const { ctx, listeners } = fakeContext()
    apply(ctx, config({ questionOptions: 2 }))
    emit(listeners, root, [at('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{}' })])
    emit(listeners, root, [at('tool/call', { turn: 1, step: 1, callId: 'c2', name: 'ask_user_question', arguments: askArguments })])
    emit(listeners, root, [at('approval/asked', { id: 'a1', toolName: 'pwsh', reason: 'danger-full-access 需要确认' })])
    await settle()
    const cards = capture.requests.map((one) => one.payload ?? {})
    check('an unrelated tool call pushes nothing', cards.length === 2, `got ${cards.length}`)
    const question = cards[0] ?? {}
    check('a question card names the question and its options', question.title === '❓ 等你选择' && String(question.body).includes('要推给哪几台设备？') && String(question.body).includes('两台都推') && String(question.body).includes('另有 3 项') && String(question.body).includes('【推送目标】'), JSON.stringify(question))
    const approval = cards[1] ?? {}
    check('an approval card names the reason and tool', approval.title === '🔐 等你批准' && String(approval.body).includes('danger-full-access 需要确认') && String(approval.body).includes('pwsh'), JSON.stringify(approval))
    capture.requests.length = 0
  }

  // 18) both "waiting for you" triggers honour their switches
  {
    const { ctx, listeners } = fakeContext()
    apply(ctx, config({ notifyOnQuestion: false, notifyOnApproval: false }))
    emit(listeners, root, [at('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'ask_user_question', arguments: '{"questions":[{"question":"q","options":[]}]}' })])
    emit(listeners, root, [at('approval/asked', { id: 'a1', toolName: 'pwsh' })])
    await settle()
    check('the waiting switches silence both cards', capture.requests.length === 0, `got ${capture.requests.length}`)
    capture.requests.length = 0
  }

  // 19) an empty device list is refused instead of pushed to nobody
  {
    const outcome = await sendBark(config({ deviceKeys: [] }), { title: 'x', body: 'y' }, silent)
    check('an empty device list refuses to push', outcome.ok === false && outcome.devices === 0 && capture.requests.length === 0, JSON.stringify(outcome))
  }

  // 20) the Config schema the Settings page renders is exactly what it claims
  {
    const keys = Object.keys(Config.dict ?? {})
    const notVolatile = keys.filter((key) => Config.dict[key].meta?.volatile !== true)
    check('every Config field is volatile (so Settings edits apply live)', keys.length > 0 && notVolatile.length === 0, `not volatile: ${notVolatile.join(',')}`)
    const expected = [
      'enabled', 'server', 'deviceKeys', 'notifyOnSuccess', 'notifyOnFailure',
      'notifyOnQuestion', 'notifyOnApproval', 'notifyOnJobSuccess', 'notifyOnJobFailure',
      'questionOptions', 'minTurnSeconds', 'minJobSeconds', 'preview', 'previewChars',
      'markdown', 'level', 'volume', 'call', 'sound', 'group', 'icon', 'image', 'url',
      'action', 'copy', 'badge', 'collapse', 'collapseId', 'ttl', 'isArchive', 'trace',
      'retries', 'timeoutMs', 'logFile', 'logMaxBytes',
    ]
    const missing = expected.filter((key) => !keys.includes(key))
    const extra = keys.filter((key) => !expected.includes(key))
    check('the schema covers the documented parameter set', missing.length === 0 && extra.length === 0, `missing: ${missing.join(',')} extra: ${extra.join(',')}`)
  }

  // 21) optional payload fields: archive, badge, collapse placeholders
  {
    const plain = normalizeConfig({ deviceKeys: ['K'] })
    const base = buildPayload(plain, { title: 'T', body: 'B' })
    check('unset optional parameters stay out of the payload', base.device_keys.length === 1 && base.level === 'active' && base.sound === undefined && base.volume === undefined && base.call === undefined && base.id === undefined && base.badge === undefined, JSON.stringify(base))
    check('isArchive defaults to an explicit "1"', base.isArchive === '1', JSON.stringify(base))
    check('isArchive=false is sent as "0"', buildPayload(normalizeConfig({ deviceKeys: ['K'], isArchive: false }), { title: 'T', body: 'B' }).isArchive === '0', 'expected "0"')
    check('badge 0 clears instead of being omitted', buildPayload(normalizeConfig({ deviceKeys: ['K'], badge: 0 }), { title: 'T', body: 'B' }).badge === 0, 'expected 0')
    check('badge -1 leaves the badge untouched', buildPayload(normalizeConfig({ deviceKeys: ['K'] }), { title: 'T', body: 'B' }).badge === undefined, 'expected undefined')
    const collapsed = buildPayload(normalizeConfig({ deviceKeys: ['K'], badge: 3, collapse: true, collapseId: 'dsh-{kind}-{session}' }), { title: 'T', body: 'B', kind: 'done', sessionId: 'session-abc123' })
    check('collapse placeholders render and empty renders fall back', collapsed.id === 'dsh-done-abc123' && collapsed.badge === 3, JSON.stringify(collapsed))
    check('a bare host or host:port gets an https scheme', normalizeConfig({ server: 'bark.test' }).server === 'https://bark.test' && normalizeConfig({ server: 'bark.test:8080/' }).server === 'https://bark.test:8080', JSON.stringify([normalizeConfig({ server: 'bark.test' }).server, normalizeConfig({ server: 'bark.test:8080/' }).server]))
    check('trailing slashes are trimmed', normalizeConfig({ server: 'https://bark.test///' }).server === 'https://bark.test', normalizeConfig({ server: 'https://bark.test///' }).server)
  }

  // 22) transient failures retry; permanent ones do not
  {
    const flaky = await captureServer((index) => (index === 0
      ? { status: 502, body: '{"code":502,"message":"bad gateway"}' }
      : { status: 200, body: '{"code":200,"message":"success"}' }))
    const outcome = await sendBark(normalizeConfig({ server: flaky.base, deviceKeys: ['K'], retries: 2 }), { title: 'retry', body: 'x' }, silent)
    check('a 502 is retried and then succeeds', flaky.requests.length === 2 && outcome.ok === true && outcome.attempts === 2, `${flaky.requests.length} requests, ${JSON.stringify(outcome)}`)
    await flaky.close()

    const strict = await captureServer(() => ({ status: 400, body: '{"code":400,"message":"bad key"}' }))
    const rejected = await sendBark(normalizeConfig({ server: strict.base, deviceKeys: ['K'], retries: 2 }), { title: 'strict', body: 'x' }, silent)
    check('a 400 is not retried', strict.requests.length === 1 && rejected.ok === false && rejected.attempts === 1, `${strict.requests.length} requests, ${JSON.stringify(rejected)}`)
    await strict.close()
  }

  // 23) per-device results are parsed instead of trusting the HTTP status
  {
    const partial = await captureServer(() => ({
      status: 200,
      body: JSON.stringify({
        code: 200,
        message: 'success',
        data: [
          { code: 200, device_key: 'KEYAAA111', message: 'success' },
          { code: 400, device_key: 'KEYBBB222', message: 'failed to get device token' },
        ],
      }),
    }))
    const lines = []
    const log = { info: (m) => lines.push(m), warn: (m) => lines.push(m), debug: () => {} }
    const outcome = await sendBark(normalizeConfig({ server: partial.base, deviceKeys: ['KEYAAA111', 'KEYBBB222'] }), { title: 'partial', body: 'x' }, log)
    check('a half-delivered batch reports delivered/total', outcome.ok === true && outcome.delivered === 1 && outcome.devices === 2, JSON.stringify(outcome))
    check('a rejected device is warned with a masked key', lines.some((line) => line.includes('KEYBBB…') && !line.includes('KEYBBB222')), lines.join(' | '))
    await partial.close()

    const bare = await captureServer(() => ({ status: 200, body: '{"code":200,"message":"success","data":[]}' }))
    const unknown = await sendBark(normalizeConfig({ server: bare.base, deviceKeys: ['KEYAAA111'] }), { title: 'bare', body: 'x' }, silent)
    check('an empty data array falls back to HTTP success', unknown.ok === true && unknown.delivered === 1, JSON.stringify(unknown))
    await bare.close()

    const broken = await captureServer(() => ({
      status: 200,
      body: JSON.stringify({ code: 200, message: 'success', data: [{ code: 400, device_key: 'KEYBBB222', message: 'bad token' }] }),
    }))
    const failed = await sendBark(normalizeConfig({ server: broken.base, deviceKeys: ['KEYBBB222'] }), { title: 'broken', body: 'x' }, silent)
    check('an all-rejected batch is a failure, not a success', failed.ok === false && failed.delivered === 0, JSON.stringify(failed))
    await broken.close()
  }

  // 24) background jobs are opt-in, filtered, and labelled
  {
    const now = Date.now()
    const main = loggedSession('root-1', [])
    const child = loggedSession('child-1', [], 'subagent')
    const job = (owner, status, startedAt = now - 60000) => ({
      id: 'job-1',
      owner,
      status,
      label: 'npm run build',
      startedAt,
      finishedAt: now,
      output: { total: 0 },
    })
    const { ctx, emitJob } = fakeContext([main, child], { sessionTitle: { get: (session) => (session.header.id === 'root-1' ? { title: '部署' } : undefined) } })
    apply(ctx, config({ notifyOnJobSuccess: true, notifyOnJobFailure: true, minJobSeconds: 5 }))
    emitJob({ type: 'settled', awaited: false, cause: 'producer', job: job('root-1', 'completed') })
    await settle()
    const payload = capture.requests[0]?.payload ?? {}
    check('an unattended completed job pushes one card', capture.requests.length === 1, `got ${capture.requests.length}`)
    check('job card names the command, label, and status', payload.title === '🛠 后台任务完成' && String(payload.body).includes('npm run build') && String(payload.subtitle).includes('部署'), JSON.stringify(payload))
    capture.requests.length = 0

    emitJob({ type: 'settled', awaited: true, cause: 'producer', job: job('root-1', 'completed') })
    emitJob({ type: 'settled', awaited: false, cause: 'teardown', job: job('root-1', 'completed') })
    emitJob({ type: 'settled', awaited: false, cause: 'producer', job: job('child-1', 'completed') })
    emitJob({ type: 'settled', awaited: false, cause: 'producer', job: job('root-1', 'completed', now - 1000) })
    await settle()
    check('awaited / teardown / subagent / short jobs stay silent', capture.requests.length === 0, `got ${capture.requests.length}`)
    capture.requests.length = 0

    emitJob({ type: 'settled', awaited: false, cause: 'producer', job: job('root-1', 'failed') })
    await settle()
    check('a failed job uses the failure card', capture.requests[0]?.payload?.title === '❌ 后台任务失败', JSON.stringify(capture.requests[0]?.payload))
    capture.requests.length = 0

    const quiet = fakeContext([main])
    apply(quiet.ctx, config({}))
    quiet.emitJob({ type: 'settled', awaited: false, cause: 'producer', job: job('root-1', 'completed') })
    await settle()
    check('job pushes are off by default', capture.requests.length === 0, `got ${capture.requests.length}`)
  }

  // 25) the diagnostics file rotates instead of growing without bound
  {
    const dir = mkdtempSync(join(tmpdir(), 'bark-log-'))
    const file = join(dir, 'push.log')
    const { ctx, listeners } = fakeContext()
    apply(ctx, config({ trace: true, logFile: file, logMaxBytes: 2000 }))
    const now = Date.now()
    for (let index = 0; index < 50; index += 1) {
      emit(listeners, root, [
        at('turn/start', { turn: 1 }, now),
        at('user/message', { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `第 ${index} 轮，用来把诊断日志写满` }] }, now),
        at('turn/end', { turn: 1, reason: { kind: 'completed' } }, now),
      ])
    }
    await settle(800)
    check('the diagnostics log rotates to .1 past its cap', existsSync(file) && existsSync(`${file}.1`) && readFileSync(file, 'utf8').length < 8192, `fresh=${existsSync(file) ? readFileSync(file, 'utf8').length : 'missing'} rotated=${existsSync(`${file}.1`)}`)
    rmSync(dir, { recursive: true, force: true })
    capture.requests.length = 0
  }
} finally {
  await capture.close()
}

for (const { what, ok, detail } of results) console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${ok || detail === '' ? '' : `  → ${detail}`}`)
const failed = results.filter((one) => !one.ok).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exitCode = failed === 0 ? 0 : 1
