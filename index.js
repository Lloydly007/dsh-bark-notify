/**
 * dsh-bark-notify — push a Bark card to your phones when a conversation turn
 * finishes (and, optionally, when a background job settles).
 *
 * Transport follows the official Bark API: one `POST <server>/push` carrying a
 * JSON body, with `device_keys` batch delivery so every configured phone gets
 * the same card from a single request (bark-server ≥ 2.1.9; the public server
 * allows 10 keys per request, a self-hosted one is unlimited). A push is
 * retried on transport errors, timeouts, 429, and 5xx; per-device rejections in
 * the response body are reported instead of being counted as success.
 *
 * Turn detection mirrors the Desktop edition's own notification plugin
 * (`dsh-plugin-desktop/notifications`): `turn/start` opens a turn, a
 * `user/message` whose source kind is `user` or `schedule` marks the turn as
 * human-initiated, and `turn/end` closes it. Sessions whose header origin is
 * `subagent` are skipped, so delegated work never rings the phone, and turn
 * ends the user caused themselves (`aborted`, `interrupted`, `blocked`,
 * `forked`) stay silent because the user already knows.
 *
 * Rules beyond that reference implementation:
 *
 * - The listener is always armed while the plugin is loaded. `enabled` and
 *   `deviceKeys` are re-read on every push, so the Settings toggle and the key
 *   list take effect live — no restart, and a key added after boot starts
 *   working immediately.
 * - The listener arms mid-turn whenever the plugin is enabled after a turn has
 *   already started. Each live session's own log is folded once at arm time so
 *   that in-flight turn is still reported, with its real start time.
 * - `{ global: true }` opts out of `@deepseek-ai/dsh-scope` event admission,
 *   which would otherwise deliver `session/event` only to listeners scoped to
 *   an ancestor of the session.
 * - Every Config field is `.volatile()`, so Settings-page edits take effect on
 *   the next push without reloading this plugin.
 * - Durations come from the events' own `time`, not from when the listener was
 *   scheduled, and a card label only ever comes from human messages (`user` /
 *   `schedule`), never from runtime-context or skill-catalog injections.
 * - Background jobs are opt-in: only settlements no caller was waiting on are
 *   reported, and short jobs stay silent.
 *
 * The push is fire-and-forget: the listener never awaits the network, never
 * throws into the committed-append feed, and reports every failure through the
 * Host logger (and optionally a size-capped log file).
 */

import { appendFileSync, renameSync, statSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

import z from '@deepseek-ai/schemastery'

/** Loader entry name; the profile patch row references it. */
export const name = 'dsh-bark-notify'

/** Bark interruption levels accepted by `level`. */
export const LEVELS = ['active', 'timeSensitive', 'passive', 'critical']

/** Bark tap actions accepted by `action`; the empty string means the default. */
export const ACTIONS = ['', 'alert', 'none']

/** User-message sources that count as a human starting a turn. */
const HUMAN_SOURCE_KINDS = new Set(['user', 'schedule'])

/** HTTP statuses worth retrying; every 5xx is retried as well. */
const RETRYABLE_STATUS = new Set([408, 425, 429])

/** Bytes of log written between two on-disk rotation checks. */
const LOG_CHECK_BYTES = 8192

/** Per-path bytes written since the last rotation check. */
const LOG_PENDING = new Map()

/**
 * Loader-validated configuration.
 *
 * Every field is volatile: the Settings page writes them into the profile
 * patch layer, the Loader hands this plugin live references, and each push
 * reads them again — no remount, no restart.
 */
export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  server: z.string().default('https://api.day.app').volatile(),
  deviceKeys: z.array(z.string()).default([]).volatile(),
  notifyOnSuccess: z.boolean().default(true).volatile(),
  notifyOnFailure: z.boolean().default(true).volatile(),
  notifyOnQuestion: z.boolean().default(true).volatile(),
  notifyOnApproval: z.boolean().default(true).volatile(),
  notifyOnJobSuccess: z.boolean().default(false).volatile(),
  notifyOnJobFailure: z.boolean().default(false).volatile(),
  questionOptions: z.natural().default(4).volatile(),
  minTurnSeconds: z.natural().default(0).volatile(),
  minJobSeconds: z.natural().default(10).volatile(),
  preview: z.boolean().default(true).volatile(),
  previewChars: z.natural().default(80).volatile(),
  markdown: z.boolean().default(false).volatile(),
  level: z.string().default('active').volatile(),
  volume: z.natural().default(5).volatile(),
  call: z.boolean().default(false).volatile(),
  sound: z.string().default('').volatile(),
  group: z.string().default('DSH').volatile(),
  icon: z.string().default('').volatile(),
  image: z.string().default('').volatile(),
  url: z.string().default('').volatile(),
  action: z.string().default('').volatile(),
  copy: z.string().default('').volatile(),
  badge: z.number().step(1).min(-1).max(99999).default(-1).volatile(),
  collapse: z.boolean().default(false).volatile(),
  collapseId: z.string().default('dsh-turn').volatile(),
  ttl: z.natural().default(0).volatile(),
  isArchive: z.boolean().default(true).volatile(),
  trace: z.boolean().default(false).volatile(),
  retries: z.natural().default(1).volatile(),
  timeoutMs: z.natural().default(10000).volatile(),
  logFile: z.string().default('').volatile(),
  logMaxBytes: z.natural().default(1048576).volatile(),
})

/** Whether one parsed Config node is a volatile reference. */
function isRef(value) {
  return typeof value === 'object' && value !== null && typeof value.get === 'function'
}

/** Read one Config node's current value, reference or plain. */
function read(node, fallback) {
  if (isRef(node)) {
    const current = node.get()
    return current === undefined || current === null ? fallback : current
  }
  if (node === undefined || node === null) return fallback
  return node
}

/** Coerce one config value to a boolean with a fallback. */
function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/** Coerce one config value to a trimmed string with a fallback. */
function str(value, fallback) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

/** Coerce one config value to a number clamped into a range. */
function num(value, fallback, min, max) {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

/** Read a device-key field written as a list or as one separated string. */
function asKeys(value) {
  if (Array.isArray(value)) return value.map((one) => (typeof one === 'string' ? one.trim() : ''))
  if (typeof value === 'string') return value.split(/[\s,]+/).map((one) => one.trim())
  return []
}

/** Accept `bark.example.com`, `host:8080`, or a full URL, and drop trailing slashes. */
function normalizeServer(value) {
  const raw = str(value, 'https://api.day.app').replace(/\/+$/, '')
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return raw
  return `https://${raw.replace(/^\/+/, '')}`
}

/**
 * Snapshot the live configuration for one push.
 * @param config - the Loader row's Config, whose fields may be volatile references.
 * @returns the complete, clamped configuration.
 */
export function normalizeConfig(config) {
  const record = config !== null && typeof config === 'object' ? config : {}
  const deviceKeys = []
  for (const candidate of [...asKeys(read(record.deviceKeys, [])), ...asKeys(read(record.deviceKey, ''))]) {
    if (candidate !== '' && !deviceKeys.includes(candidate)) deviceKeys.push(candidate)
  }
  const level = str(read(record.level, ''), 'active')
  const action = str(read(record.action, ''), '')
  return {
    enabled: bool(read(record.enabled, undefined), true),
    server: normalizeServer(read(record.server, undefined)),
    deviceKeys,
    notifyOnSuccess: bool(read(record.notifyOnSuccess, undefined), true),
    notifyOnFailure: bool(read(record.notifyOnFailure, undefined), true),
    notifyOnQuestion: bool(read(record.notifyOnQuestion, undefined), true),
    notifyOnApproval: bool(read(record.notifyOnApproval, undefined), true),
    notifyOnJobSuccess: bool(read(record.notifyOnJobSuccess, undefined), false),
    notifyOnJobFailure: bool(read(record.notifyOnJobFailure, undefined), false),
    questionOptions: num(read(record.questionOptions, undefined), 4, 0, 12),
    minTurnSeconds: num(read(record.minTurnSeconds, undefined), 0, 0, 86400),
    minJobSeconds: num(read(record.minJobSeconds, undefined), 10, 0, 86400),
    preview: bool(read(record.preview, undefined), true),
    previewChars: num(read(record.previewChars, undefined), 80, 0, 400),
    markdown: bool(read(record.markdown, undefined), false),
    level: LEVELS.includes(level) ? level : 'active',
    volume: num(read(record.volume, undefined), 5, 0, 10),
    call: bool(read(record.call, undefined), false),
    sound: str(read(record.sound, ''), ''),
    group: str(read(record.group, ''), ''),
    icon: str(read(record.icon, ''), ''),
    image: str(read(record.image, ''), ''),
    url: str(read(record.url, ''), ''),
    action: ACTIONS.includes(action) ? action : '',
    copy: str(read(record.copy, ''), ''),
    badge: Math.round(num(read(record.badge, undefined), -1, -1, 99999)),
    collapse: bool(read(record.collapse, undefined), false),
    collapseId: str(read(record.collapseId, undefined), 'dsh-turn'),
    ttl: num(read(record.ttl, undefined), 0, 0, 604800),
    isArchive: bool(read(record.isArchive, undefined), true),
    trace: bool(read(record.trace, undefined), false),
    retries: Math.floor(num(read(record.retries, undefined), 1, 0, 3)),
    timeoutMs: num(read(record.timeoutMs, undefined), 10000, 1000, 60000),
    logFile: str(read(record.logFile, ''), ''),
    logMaxBytes: num(read(record.logMaxBytes, undefined), 1048576, 0, 104857600),
  }
}

/** Shorten a session id for a collapse template. */
function shortSession(sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return ''
  return sessionId.replace(/^session-/, '')
}

/** Render a collapse id template; an empty render falls back to the old constant. */
function collapseIdFor(template, card) {
  const rendered = template
    .replaceAll('{session}', shortSession(card?.sessionId))
    .replaceAll('{kind}', typeof card?.kind === 'string' ? card.kind : 'turn')
    .replaceAll('{turn}', card?.turn === undefined ? '' : String(card.turn))
    .trim()
  return rendered === '' ? 'dsh-turn' : rendered
}

/** Mask a device key for logs. */
function maskKey(key) {
  if (typeof key !== 'string' || key === '') return 'unknown'
  return key.length <= 6 ? '***' : `${key.slice(0, 6)}…`
}

/** Describe per-device rejections without leaking whole keys. */
function describeFailed(failed) {
  return failed
    .map((one) => `${maskKey(one.key)}${one.code === undefined ? '' : ` (${one.code})`}${one.message === '' ? '' : ` ${one.message}`}`)
    .join(', ')
}

/**
 * Build the official `/push` payload for one card.
 *
 * Field names, types, and accepted values follow Bark's parameter reference:
 * `call`/`isArchive` are strings, `id` must be a string, `badge` and `ttl` are
 * integers, and a `markdown` body replaces `body` entirely.
 *
 * `isArchive` is sent in both directions: omitting it on `false` would leave
 * the app's own "save history" default in charge, which is the opposite of what
 * the setting says. `badge` uses -1 as "leave untouched", 0 as "clear", and a
 * positive number as "set", because Bark treats a missing badge the same way.
 *
 * @param cfg - one configuration snapshot.
 * @param card - the notification content, plus optional collapse context.
 * @returns the JSON payload sent to `<server>/push`.
 */
export function buildPayload(cfg, card) {
  const payload = { device_keys: [...cfg.deviceKeys] }
  if (card.title) payload.title = card.title
  if (card.subtitle) payload.subtitle = card.subtitle
  if (cfg.markdown && card.markdown) payload.markdown = card.markdown
  else if (card.body) payload.body = card.body
  if (cfg.level) payload.level = cfg.level
  if (cfg.level === 'critical') payload.volume = String(cfg.volume)
  if (cfg.call) payload.call = '1'
  if (cfg.sound) payload.sound = cfg.sound
  if (cfg.group) payload.group = cfg.group
  if (cfg.icon) payload.icon = cfg.icon
  if (cfg.image) payload.image = cfg.image
  if (cfg.url) payload.url = cfg.url
  if (cfg.action) payload.action = cfg.action
  if (cfg.copy) payload.copy = cfg.copy
  if (cfg.badge >= 0) payload.badge = cfg.badge
  if (cfg.collapse && cfg.collapseId) payload.id = collapseIdFor(cfg.collapseId, card)
  if (cfg.ttl > 0) payload.ttl = cfg.ttl
  payload.isArchive = cfg.isArchive ? '1' : '0'
  return payload
}

/** One HTTP attempt; never rejects, reports transport failures as `error`. */
function postOnce(target, payload, timeoutMs) {
  const transport = target.protocol === 'http:' ? httpRequest : httpsRequest
  return new Promise((resolve) => {
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    let request
    try {
      request = transport(target, {
        method: 'POST',
        timeout: timeoutMs,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'content-length': Buffer.byteLength(payload),
          'user-agent': 'dsh-bark-notify',
        },
      }, (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => done({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8').slice(0, 400) }))
        response.on('error', (error) => done({ status: 0, body: '', error }))
      })
    } catch (error) {
      done({ status: 0, body: '', error })
      return
    }
    request.on('timeout', () => request.destroy(new Error(`timeout after ${timeoutMs}ms`)))
    request.on('error', (error) => done({ status: 0, body: '', error }))
    request.end(payload)
  })
}

/**
 * Turn one raw HTTP outcome into the fields delivery needs.
 *
 * bark-server answers 200 with a `data` array even when individual device
 * tokens are rejected, so a bare status check would call a half-broken batch a
 * success. A batch counts as delivered when at least one device reported 200.
 */
function classify(raw) {
  let body
  try {
    body = raw.body === '' ? undefined : JSON.parse(raw.body)
  } catch {
    body = undefined
  }
  const code = typeof body?.code === 'number' ? body.code : undefined
  const rows = Array.isArray(body?.data) ? body.data : undefined
  const failed = []
  let delivered
  if (rows !== undefined && rows.length > 0) {
    delivered = 0
    for (const row of rows) {
      if (row?.code === 200) delivered += 1
      else {
        failed.push({
          key: typeof row?.device_key === 'string' ? row.device_key : '',
          code: typeof row?.code === 'number' ? row.code : undefined,
          message: typeof row?.message === 'string' ? row.message : '',
        })
      }
    }
  }
  const httpOk = raw.status >= 200 && raw.status < 300
  const bodyOk = code === undefined || code === 200
  return {
    ok: raw.error === undefined && httpOk && bodyOk && (delivered === undefined || delivered > 0),
    status: raw.status,
    code,
    delivered,
    failed,
    error: raw.error,
    body: raw.body,
  }
}

/** Whether a failed attempt may succeed when repeated. */
function retryable(result) {
  if (result.error !== undefined) return true
  if (result.status === 0) return true
  if (RETRYABLE_STATUS.has(result.status)) return true
  if (result.status >= 500) return true
  return result.code !== undefined && result.code >= 500
}

/** One-line failure description for logs. */
function describeFailure(result) {
  if (result.error !== undefined) return result.error?.message ?? String(result.error)
  const parts = [`HTTP ${result.status}`]
  if (result.code !== undefined) parts.push(`code ${result.code}`)
  if (result.failed.length > 0) parts.push(describeFailed(result.failed))
  if (result.body !== '') parts.push(result.body.slice(0, 200))
  return parts.join(' · ')
}

/**
 * Deliver one card to every configured device in a single request.
 *
 * `enabled` is checked here rather than at registration time, which is what
 * makes the Settings toggle live. Transient failures are retried with a short
 * linear backoff; a 4xx (bad key, malformed payload) is not.
 *
 * @param cfg - one configuration snapshot.
 * @param card - the notification content.
 * @param log - sink for delivery diagnostics.
 * @returns the outcome: `ok`, configured `devices`, per-device `delivered`,
 *   the last HTTP `status`, and how many `attempts` were made.
 */
export function sendBark(cfg, card, log) {
  if (!cfg.enabled) {
    log?.debug?.('bark-notify: disabled by config, push skipped')
    return Promise.resolve({ ok: false, devices: 0, delivered: 0, status: 0, attempts: 0, skipped: true })
  }
  if (cfg.deviceKeys.length === 0) {
    log?.warn?.('bark-notify: no device key configured, push skipped')
    return Promise.resolve({ ok: false, devices: 0, delivered: 0, status: 0, attempts: 0, skipped: true })
  }
  let target
  try {
    target = new URL(`${cfg.server}/push`)
  } catch (error) {
    log?.warn?.(`bark-notify: bad server URL (${error?.message ?? error})`)
    return Promise.resolve({ ok: false, devices: cfg.deviceKeys.length, delivered: 0, status: 0, attempts: 0 })
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    log?.warn?.(`bark-notify: unsupported server protocol ${target.protocol}, push skipped`)
    return Promise.resolve({ ok: false, devices: cfg.deviceKeys.length, delivered: 0, status: 0, attempts: 0 })
  }
  const payload = JSON.stringify(buildPayload(cfg, card))
  const total = Math.max(1, Math.floor(cfg.retries) + 1)
  return new Promise((resolve) => {
    let attempt = 0
    let settled = false
    const finish = (outcome) => {
      if (settled) return
      settled = true
      resolve(outcome)
    }
    const run = () => {
      attempt += 1
      void postOnce(target, payload, cfg.timeoutMs).then((raw) => {
        const result = classify(raw)
        if (result.ok) {
          const delivered = result.delivered === undefined ? cfg.deviceKeys.length : result.delivered
          log?.info?.(`bark-notify: pushed "${card.title}" to ${delivered}/${cfg.deviceKeys.length} device(s) (${result.status})`)
          if (result.failed.length > 0) log?.warn?.(`bark-notify: ${result.failed.length} device(s) rejected: ${describeFailed(result.failed)}`)
          finish({ ok: true, devices: cfg.deviceKeys.length, delivered, status: result.status, attempts: attempt })
          return
        }
        if (attempt < total && retryable(result)) {
          const delay = 250 * attempt
          log?.warn?.(`bark-notify: push failed (${describeFailure(result)}), retrying in ${delay}ms (${attempt}/${total - 1})`)
          setTimeout(run, delay)
          return
        }
        log?.warn?.(`bark-notify: push failed after ${attempt} attempt(s) (${describeFailure(result)})`)
        finish({
          ok: false,
          devices: cfg.deviceKeys.length,
          delivered: result.delivered ?? 0,
          status: result.status,
          attempts: attempt,
        })
      })
    }
    run()
  })
}

/** Append one log line, rotating the file once it passes `maxBytes`. */
function appendLogLine(path, line, maxBytes) {
  try {
    appendFileSync(path, line)
  } catch {
    /* a failing diagnostics file must not break delivery */
    return
  }
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return
  const pending = (LOG_PENDING.get(path) ?? 0) + Buffer.byteLength(line)
  if (pending < LOG_CHECK_BYTES) {
    LOG_PENDING.set(path, pending)
    return
  }
  LOG_PENDING.set(path, 0)
  try {
    if (statSync(path).size < maxBytes) return
    renameSync(path, `${path}.1`)
  } catch {
    /* rotation is best-effort */
  }
}

/** Strip the Markdown that would otherwise leak into a one-line Bark body. */
function tidy(text) {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/~~([^~]*)~~/g, '$1')
    .replace(/(^|\s)[#>*+-]{1,6}\s+/g, '$1')
    .replace(/(^|\s)\d+[.)]\s+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Join text blocks of one message into a single collapsed line. */
function collectText(message, limit) {
  const blocks = message?.content
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const block of blocks) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  const text = tidy(parts.join(' '))
  if (limit <= 0) return ''
  return text.length > limit ? `${text.slice(0, Math.max(1, limit - 1))}…` : text
}

/** Raw text of one message, Markdown intact, for the `markdown` body. */
function collectRaw(message, limit) {
  const blocks = message?.content
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const block of blocks) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  const text = parts.join('\n').trim()
  if (limit <= 0) return ''
  return text.length > limit ? `${text.slice(0, Math.max(1, limit - 1))}…` : text
}

/** Collapse an arbitrary string into one clamped line. */
function clamp(text, limit) {
  if (typeof text !== 'string' || text.trim() === '') return ''
  const clean = tidy(text)
  if (limit <= 0) return ''
  return clean.length > limit ? `${clean.slice(0, Math.max(1, limit - 1))}…` : clean
}

/** Whether one user message was written by a human (or a schedule). */
function humanMessage(message) {
  return HUMAN_SOURCE_KINDS.has(message?.source?.kind)
}

/** The label text of one human user message, or an empty string. */
function humanText(message, limit) {
  return humanMessage(message) ? collectText(message, limit) : ''
}

/** A session event's own timestamp, falling back to now. */
function eventTime(event) {
  return typeof event?.time === 'number' && Number.isFinite(event.time) ? event.time : Date.now()
}

/** Render a turn duration as a short human string. */
function formatDuration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`
  const hours = Math.floor(minutes / 60)
  return `${hours} 小时 ${minutes % 60} 分`
}

/**
 * Fold one session log into the state this plugin needs.
 *
 * A listener that arms mid-turn never saw that turn's `turn/start`, and would
 * drop its `turn/end` on the floor. Folding the existing log once at arm time
 * closes that gap, and the event's own `time` keeps the reported duration
 * honest. The same pass yields a session label from the first human message,
 * so a two-word follow-up like "没收到" never has to stand in for the whole
 * conversation — and runtime-context / skill-catalog injections never become
 * the label.
 *
 * @param session - the live session to fold; its log is read, never appended to.
 * @param cfg - one configuration snapshot.
 * @returns the open turn (if any) and the session's own first human text.
 */
function foldSession(session, cfg) {
  let events
  try {
    events = session.snapshotEvents()
  } catch {
    return {}
  }
  if (!Array.isArray(events)) return {}
  let open
  let label = ''
  for (const event of events) {
    const type = event?.type
    if (type === 'turn/start') {
      open = {
        turn: event.data?.turn,
        startedAt: eventTime(event),
        preview: '',
        raw: '',
        label: '',
      }
      continue
    }
    if (type === 'user/message') {
      const text = humanText(event.data, 32)
      if (text !== '' && label === '') label = text
      if (open === undefined) continue
      const kind = event.data?.source?.kind
      if (kind === 'user' || kind === 'schedule') open.source = kind
      if (open.label === '' && text !== '') open.label = text
      continue
    }
    if (open === undefined) continue
    if (type === 'assistant/message') {
      const preview = collectText(event.data?.message, cfg.previewChars)
      if (preview !== '') open.preview = preview
      const raw = collectRaw(event.data?.message, cfg.previewChars)
      if (raw !== '') open.raw = raw
      continue
    }
    if (type === 'turn/end' && open.turn === event.data?.turn) open = undefined
  }
  return { open, label }
}

/** Build one card for a finished turn. */
function buildCard(cfg, info) {
  const lines = []
  if (cfg.preview && info.preview) lines.push(info.preview)
  if (!info.ok && info.failure) lines.push(`⚠️ ${info.failure}`)
  if (lines.length === 0) lines.push(info.ok ? '（本轮没有文本回复）' : '（本轮失败，打开 DSH 查看详情）')
  const subtitle = [info.label, formatDuration(info.elapsedMs)].filter(Boolean).join(' · ')
  return {
    title: info.ok ? '✅ 对话完成' : '❌ 对话出错',
    subtitle,
    body: lines.join('\n'),
    markdown: cfg.preview && info.raw ? info.raw : '',
    sessionId: info.sessionId,
    turn: info.turn,
    kind: info.ok ? 'done' : 'fail',
  }
}

/** Build one card for a settled background job. */
function jobCard(label, job, ok, elapsedMs) {
  const lines = []
  const command = clamp(job?.label, 160)
  if (command !== '') lines.push(command)
  const detail = clamp(job?.detail, 120)
  if (detail !== '') lines.push(`⚠️ ${detail}`)
  if (lines.length === 0) lines.push(ok ? '（后台任务已结束）' : '（后台任务失败，打开 DSH 查看输出）')
  return {
    title: ok ? '🛠 后台任务完成' : '❌ 后台任务失败',
    subtitle: [label, formatDuration(elapsedMs)].filter(Boolean).join(' · '),
    body: lines.join('\n'),
    sessionId: typeof job?.owner === 'string' ? job.owner : undefined,
    kind: 'job',
  }
}

/** One-line summary of an `ask_user_question` call, for the "waiting for you" card. */
function questionCard(cfg, label, data) {
  let args = {}
  try {
    args = JSON.parse(typeof data?.arguments === 'string' ? data.arguments : '{}')
  } catch {
    args = {}
  }
  const questions = Array.isArray(args?.questions) ? args.questions : []
  const first = questions[0] ?? {}
  const options = Array.isArray(first?.options) ? first.options : []
  const shown = cfg.questionOptions > 0 ? options.slice(0, cfg.questionOptions) : []
  const lines = []
  const header = typeof first?.header === 'string' ? clamp(first.header, 24) : ''
  const question = typeof first?.question === 'string' && first.question.trim() !== ''
    ? collectText({ content: [{ type: 'text', text: first.question }] }, 160)
    : ''
  if (question !== '') lines.push(header === '' ? question : `【${header}】${question}`)
  for (const option of shown) {
    if (option !== null && typeof option === 'object' && typeof option.label === 'string') lines.push(`· ${collectText({ content: [{ type: 'text', text: option.label }] }, 60)}`)
  }
  if (options.length > shown.length) lines.push(`…另有 ${options.length - shown.length} 项`)
  if (questions.length > 1) lines.push(`（本次共 ${questions.length} 个问题）`)
  return {
    title: '❓ 等你选择',
    subtitle: label,
    body: lines.length > 0 ? lines.join('\n') : '（打开 DSH 查看选项）',
    sessionId: typeof data?.sessionId === 'string' ? data.sessionId : undefined,
    turn: data?.turn,
    kind: 'ask',
  }
}

/** One-line summary of an `approval/asked` request, for the "waiting for you" card. */
function approvalCard(label, data) {
  const lines = []
  if (typeof data?.reason === 'string' && data.reason.trim() !== '') lines.push(collectText({ content: [{ type: 'text', text: data.reason }] }, 160))
  if (typeof data?.toolName === 'string' && data.toolName !== '') lines.push(`工具：${data.toolName}`)
  return {
    title: '🔐 等你批准',
    subtitle: label,
    body: lines.length > 0 ? lines.join('\n') : '（打开 DSH 查看请求）',
    sessionId: typeof data?.sessionId === 'string' ? data.sessionId : undefined,
    kind: 'approve',
  }
}

/** Extract a short failure description from a turn-end reason. */
function failureText(reason) {
  const failure = reason?.error
  if (failure !== null && typeof failure === 'object' && typeof failure.message === 'string') {
    const code = typeof failure.code === 'string' ? `${failure.code}: ` : ''
    return collectText({ content: [{ type: 'text', text: `${code}${failure.message}` }] }, 120)
  }
  return typeof reason?.kind === 'string' ? `结束原因：${reason.kind}` : ''
}

/** Build a logger that mirrors into the Host log and an optional capped file. */
function makeLog(ctx, cfg) {
  const write = (level, message) => {
    try {
      ctx.logger?.[level]?.(message)
    } catch {
      /* a missing logger must not break delivery */
    }
    if (cfg.logFile) appendLogLine(cfg.logFile, `${new Date().toISOString()} ${level} ${message}\n`, cfg.logMaxBytes)
  }
  return { info: (m) => write('info', m), warn: (m) => write('warn', m), debug: (m) => write('debug', m) }
}

/**
 * Track turns and push one card per finished user turn.
 * @param ctx - context carrying the `logger` service and the plugin lifetime.
 * @param config - the Loader row's Config, volatile references included.
 */
function trackTurns(ctx, config) {
  /** Snapshot the live configuration, so Settings edits apply from the next push. */
  const snapshot = () => normalizeConfig(config)

  ctx.inject(['sessions'], (sessionsCtx) => {
    /** Durable session titles, when the title service is composed. */
    let titleOf
    sessionsCtx.inject(['sessionTitle'], (titleCtx) => {
      titleOf = (session) => {
        try {
          const snapshotTitle = titleCtx.sessionTitle?.get?.(session)
          // The title service returns `{ title, … }`; accept a plain string too
          // so an older service generation keeps working.
          const title = typeof snapshotTitle === 'string' ? snapshotTitle : snapshotTitle?.title
          return typeof title === 'string' && title.trim() !== '' ? title.trim() : undefined
        } catch {
          return undefined
        }
      }
      return () => {
        titleOf = undefined
      }
    })

    sessionsCtx.effect(() => {
      /** @type {Map<string, {turn: number, source?: string, startedAt: number, preview: string, raw: string, label: string}>} */
      const openTurns = new Map()
      /** First human text seen for one session — the fallback label. */
      const sessionLabels = new Map()

      // `global: true` opts out of `@deepseek-ai/dsh-scope` event admission,
      // which otherwise delivers `session/event` only to listeners whose scope
      // tag is an ancestor of the session's scope. This plugin is app-global by
      // design: it wants every main session, not one scope's sessions.
      const stopEvents = sessionsCtx.on('session/event', (session, event) => {
        try {
          observe(session, event)
        } catch (error) {
          makeLog(ctx, snapshot()).warn(`bark-notify: turn tracking failed (${error?.message ?? error})`)
        }
      }, { global: true })
      const stopDisposed = sessionsCtx.on('session/disposed', (session) => {
        const id = String(session.header?.id)
        openTurns.delete(id)
        sessionLabels.delete(id)
      }, { global: true })

      /**
       * Adopt turns that were already running when this listener armed, and
       * learn each live session's own first human text.
       */
      function adoptLiveSessions() {
        let live
        try {
          live = sessionsCtx.sessions.list()
        } catch {
          return
        }
        let adopted = 0
        for (const session of live ?? []) {
          try {
            if (session?.header?.origin === 'subagent') continue
            const id = String(session.header.id)
            const folded = foldSession(session, snapshot())
            if (folded.label !== undefined && folded.label !== '' && !sessionLabels.has(id)) sessionLabels.set(id, folded.label)
            if (openTurns.has(id)) continue
            if (folded.open === undefined || folded.open.turn === undefined) continue
            openTurns.set(id, folded.open)
            adopted += 1
          } catch {
            /* one unreadable session must not stop the others */
          }
        }
        if (adopted > 0) makeLog(ctx, snapshot()).info(`bark-notify: adopted ${adopted} in-flight turn(s) already running at arm time`)
      }

      adoptLiveSessions()

      /** Fold one appended session event into the open-turn table. */
      function observe(session, event) {
        const cfg = snapshot()
        if (session.header.origin === 'subagent') return
        const id = String(session.header.id)
        const type = event?.type
        // "Waiting for you" events: the turn does not end here, so without a
        // dedicated card the user would never learn the agent is blocked.
        if (type === 'tool/call') {
          if (cfg.notifyOnQuestion && event.data?.name === 'ask_user_question') {
            if (cfg.trace) makeLog(ctx, cfg).info(`trace tool/call sid=${id} name=ask_user_question → question card`)
            const label = titleOf?.(session) ?? sessionLabels.get(id) ?? ''
            void sendBark(cfg, questionCard(cfg, label, { ...event.data, sessionId: id }), makeLog(ctx, cfg))
          }
          return
        }
        if (type === 'approval/asked') {
          if (cfg.notifyOnApproval) {
            if (cfg.trace) makeLog(ctx, cfg).info(`trace approval/asked sid=${id} tool=${event.data?.toolName} → approval card`)
            const label = titleOf?.(session) ?? sessionLabels.get(id) ?? ''
            void sendBark(cfg, approvalCard(label, { ...event.data, sessionId: id }), makeLog(ctx, cfg))
          }
          return
        }
        if (type === 'turn/start') {
          if (cfg.trace) makeLog(ctx, cfg).info(`trace turn/start sid=${id} turn=${event.data?.turn}`)
          openTurns.set(id, { turn: event.data.turn, startedAt: eventTime(event), preview: '', raw: '', label: '' })
          return
        }
        const tracked = openTurns.get(id)
        if (type === 'turn/end' && cfg.trace) {
          makeLog(ctx, cfg).info(`trace turn/end sid=${id} turn=${event.data?.turn} reason=${event.data?.reason?.kind} tracked=${tracked === undefined ? 'no' : 'yes'}`)
        }
        if (type === 'user/message') {
          const kind = event.data?.source?.kind
          if (cfg.trace) makeLog(ctx, cfg).info(`trace user/message sid=${id} source=${kind}`)
          const label = humanText(event.data, 32)
          if (label !== '' && !sessionLabels.has(id)) sessionLabels.set(id, label)
          if (tracked === undefined) return
          if (kind === 'user' || kind === 'schedule') tracked.source = kind
          if (tracked.label === '' && label !== '') tracked.label = label
          return
        }
        if (tracked === undefined) return
        if (type === 'assistant/message') {
          const preview = collectText(event.data?.message, cfg.previewChars)
          if (preview !== '') tracked.preview = preview
          const raw = collectRaw(event.data?.message, cfg.previewChars)
          if (raw !== '') tracked.raw = raw
          return
        }
        if (type !== 'turn/end') return
        if (tracked.turn !== event.data?.turn) return
        openTurns.delete(id)
        finish(session, tracked, event.data?.reason, cfg, eventTime(event))
      }

      /** Push the card for one finished, human-initiated turn. */
      function finish(session, tracked, reason, cfg, endedAt) {
        if (tracked.source === undefined) return
        const kind = reason?.kind
        const ok = kind === 'completed'
        const failed = kind === 'error' || kind === 'max-tokens'
        if (!ok && !failed) return
        if (ok && !cfg.notifyOnSuccess) return
        if (failed && !cfg.notifyOnFailure) return
        const elapsedMs = Math.max(0, endedAt - tracked.startedAt)
        if (elapsedMs / 1000 < cfg.minTurnSeconds) return
        const id = String(session.header.id)
        const label = titleOf?.(session) ?? sessionLabels.get(id) ?? tracked.label
        const card = buildCard(cfg, {
          ok,
          elapsedMs,
          label,
          preview: tracked.preview,
          raw: tracked.raw,
          failure: failed ? failureText(reason) : '',
          sessionId: id,
          turn: tracked.turn,
        })
        void sendBark(cfg, card, makeLog(ctx, cfg))
      }

      /** Push a card for an unattended background job settlement. */
      function observeJob(event) {
        if (event?.type !== 'settled') return
        const cfg = snapshot()
        if (!cfg.enabled) return
        if (event.awaited === true || event.cause === 'teardown') return
        const job = event.job
        if (job === null || typeof job !== 'object') return
        const ok = job.status === 'completed'
        const failed = job.status === 'failed'
        if (!ok && !failed) return
        if (ok && !cfg.notifyOnJobSuccess) return
        if (failed && !cfg.notifyOnJobFailure) return
        const owner = typeof job.owner === 'string' ? job.owner : undefined
        if (owner === undefined) return
        let session
        try {
          session = sessionsCtx.sessions.get?.(owner)
        } catch {
          session = undefined
        }
        if (session?.header?.origin === 'subagent') return
        const startedAt = typeof job.startedAt === 'number' ? job.startedAt : undefined
        const finishedAt = typeof job.finishedAt === 'number' ? job.finishedAt : Date.now()
        const elapsedMs = startedAt === undefined ? 0 : Math.max(0, finishedAt - startedAt)
        if (elapsedMs / 1000 < cfg.minJobSeconds) return
        const label = (session === undefined ? undefined : titleOf?.(session)) ?? sessionLabels.get(owner) ?? ''
        if (cfg.trace) makeLog(ctx, cfg).info(`trace job/settled id=${job.id} status=${job.status} owner=${owner}`)
        void sendBark(cfg, jobCard(label, job, ok, elapsedMs), makeLog(ctx, cfg))
      }

      // Background jobs are a separate service; the subscription is optional so
      // a composition without it still gets turn notifications.
      const stopJobs = sessionsCtx.inject(['jobs'], (jobsCtx) => {
        jobsCtx.effect(() => jobsCtx.jobs.events.subscribe({ owners: 'all' }, (event) => {
          try {
            observeJob(event)
          } catch (error) {
            makeLog(ctx, snapshot()).warn(`bark-notify: job tracking failed (${error?.message ?? error})`)
          }
        }), 'bark-notify: background job push')
      })

      return () => {
        try {
          stopJobs?.dispose?.()
        } catch {
          /* teardown must not throw out of a disposal path */
        }
        stopDisposed()
        stopEvents()
      }
    }, 'bark-notify: turn completion push')
  })
}

/**
 * Register the turn-completion push.
 *
 * The listener is registered even when `enabled` is false or the device list is
 * empty: both are re-read per push, so flipping them in Settings works without
 * reloading the plugin.
 *
 * @param ctx - Host plugin context.
 * @param config - the Loader row's `config`, with volatile fields as references.
 */
export function apply(ctx, config) {
  const cfg = normalizeConfig(config)
  trackTurns(ctx, config)
  if (!cfg.enabled) {
    ctx.logger?.info?.('bark-notify: armed but disabled by config; enable it in Settings to resume pushes')
    return
  }
  if (cfg.deviceKeys.length === 0) {
    ctx.logger?.warn?.('bark-notify: armed with no device key; pushes stay off until a key is added in Settings')
    return
  }
  ctx.logger?.info?.(`bark-notify: notifier armed for ${cfg.server} → ${cfg.deviceKeys.length} device(s)`)
}
