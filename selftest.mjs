/**
 * Delivery self-test for dsh-bark-notify.
 *
 * Sends the real `POST <server>/push` payload through the plugin's own builder
 * and transport, so a missing notification can be told apart from a broken key
 * or an unreachable server. This DOES ring the phones for real — never point it
 * at a device key you do not own.
 *
 * Usage (from this directory):
 *   node selftest.mjs                 # uses cordis.patch.yml's device keys
 *   node selftest.mjs <key> [<key>…]  # override the device list
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildPayload, normalizeConfig, sendBark } from './index.js'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * Read the row config straight out of the bundle patch, without a YAML parser.
 * Handles scalars and the block sequence `deviceKeys` uses.
 */
function patchConfig() {
  const lines = readFileSync(join(here, 'cordis.patch.yml'), 'utf8').split(/\r?\n/)
  const header = lines.findIndex((line) => /^\s*config:\s*$/.test(line))
  if (header === -1) throw new Error('cordis.patch.yml has no config: block')
  const indent = /^\s*/.exec(lines[header])[0].length
  const config = {}
  let listKey
  for (const line of lines.slice(header + 1)) {
    if (line.trim() === '' || /^\s*#/.test(line)) continue
    const lead = /^\s*/.exec(line)[0].length
    if (lead <= indent) break
    const item = /^\s*-\s+(.*)$/.exec(line)
    if (item !== null) {
      if (listKey !== undefined) config[listKey].push(item[1].trim())
      continue
    }
    const match = /^\s*([A-Za-z][A-Za-z0-9]*):\s*(.*)$/.exec(line)
    if (match === null) continue
    const raw = match[2].trim()
    listKey = undefined
    if (raw === '') {
      config[match[1]] = []
      listKey = match[1]
    } else if (raw === 'true') config[match[1]] = true
    else if (raw === 'false') config[match[1]] = false
    else if (/^-?\d+$/.test(raw)) config[match[1]] = Number(raw)
    else config[match[1]] = raw
  }
  return config
}

const override = process.argv.slice(2)
const cfg = normalizeConfig({ ...patchConfig(), ...(override.length > 0 ? { deviceKeys: override } : {}), logFile: '' })
const log = { info: (m) => console.log(`[info] ${m}`), warn: (m) => console.warn(`[warn] ${m}`), debug: () => {} }

const card = {
  title: '🔔 DSH Bark 插件自检',
  subtitle: `dsh-bark-notify · ${cfg.deviceKeys.length} 台设备`,
  body: '看到这张卡片说明 key、POST /push 与网络链路都是通的。',
}

const payload = buildPayload(cfg, card)
console.log(`POST ${cfg.server}/push`)
console.log(JSON.stringify({
  ...payload,
  device_keys: payload.device_keys.map((key) => `${key.slice(0, 6)}…`),
}, null, 2))

const result = await sendBark(cfg, card, log)
console.log(`\naccepted=${result.ok} delivered=${result.delivered ?? 0}/${cfg.deviceKeys.length} attempts=${result.attempts ?? 0}`)
process.exitCode = result.ok && result.delivered === cfg.deviceKeys.length ? 0 : 1
