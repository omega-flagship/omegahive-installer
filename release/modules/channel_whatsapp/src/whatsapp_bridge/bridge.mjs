import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  getContentType,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import qrcodeTerminal from 'qrcode-terminal'
import QRCode from 'qrcode'
import pino from 'pino'

process.umask(0o077)

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const coreDir = path.resolve(__dirname, '..', '..')
const authDir = process.env.OMEGACLAW_WA_AUTH_DIR || path.join(__dirname, 'auth')
const authLabel = path.basename(authDir).replace(/[^A-Za-z0-9_-]+/g, '_') || 'auth'
const inboxDir = path.join(coreDir, 'memory', 'inbox', `whatsapp_${authLabel}`)
const inboxLog = path.join(coreDir, 'memory', `whatsapp_inbox_${authLabel}.jsonl`)
const qrPng = path.join(coreDir, 'memory', `whatsapp_qr_${authLabel}.png`)
const qrTxt = path.join(coreDir, 'memory', `whatsapp_qr_${authLabel}.txt`)
const port = Number(process.env.OMEGACLAW_WA_PORT || '3055')
const targetJid = process.env.OMEGACLAW_WA_TARGET_JID || ''
const outboundPrefix = Object.prototype.hasOwnProperty.call(process.env, 'OMEGACLAW_WA_PREFIX')
  ? process.env.OMEGACLAW_WA_PREFIX
  : ''
const primaryJidInitial = normalizeJid(process.env.OMEGACLAW_WA_PRIMARY_JID || '')
const primaryAliasesInitial = new Set(
  (process.env.OMEGACLAW_WA_PRIMARY_ALIASES || '')
    .split(',')
    .map(s => normalizeJid(s))
    .filter(Boolean)
)
const pairingPhone = (process.env.OMEGACLAW_WA_PAIR_PHONE || '').replace(/[^0-9]/g, '')
const listenJids = new Set((process.env.OMEGACLAW_WA_LISTEN_JIDS || '').split(',').map(s => s.trim()).filter(Boolean))
const includeOwnMessages = process.env.OMEGACLAW_WA_INCLUDE_OWN === '1'

fs.mkdirSync(inboxDir, { recursive: true, mode: 0o700 })
fs.mkdirSync(authDir, { recursive: true, mode: 0o700 })
try {
  fs.chmodSync(authDir, 0o700)
} catch {}

function assertExpectedIdentity() {
  const credsPath = path.join(authDir, 'creds.json')
  if (!fs.existsSync(credsPath)) return
  try {
    const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'))
    const me = creds?.me || {}
    const name = String(me.name || '')
    const id = String(me.id || '')
    const lid = String(me.lid || '')
    const expected = (process.env.OMEGACLAW_WA_EXPECT_SELF_NAME || '').split(',').map(s => s.trim()).filter(Boolean)
    const forbidden = (process.env.OMEGACLAW_WA_FORBID_SELF_NAMES || '').split(',').map(s => s.trim()).filter(Boolean)
    if (forbidden.includes(name) && process.env.OMEGACLAW_WA_ALLOW_FORBIDDEN_IDENTITY !== '1') {
      throw new Error(`Refusing WhatsApp bridge: auth identity name=${name} id=${id} lid=${lid}`)
    }
    if (expected.length && !expected.includes(name)) {
      throw new Error(`Refusing WhatsApp bridge: expected identity ${expected.join('/')} but found name=${name} id=${id} lid=${lid}`)
    }
  } catch (err) {
    console.error('[WHATSAPP] Identity guard failed:', err?.message || err)
    process.exit(78)
  }
}
assertExpectedIdentity()

let sock = null
let connected = false
let status = 'starting'
let lastQr = ''
let pairingRequested = false
let pairingCode = ''
let chats = new Map()
let queue = []
let primaryJid = primaryJidInitial
let primaryAliases = primaryAliasesInitial
let inboxByJid = new Map()
let messageRefs = new Map()
let remindedUnreadByJid = new Map()
let bridgeSentIds = new Set()
let seenMessageIds = new Set()
const bridgeStartedAtSeconds = Math.floor(Date.now() / 1000)
const STATE_RANK = { unread: 0, delivered: 1, seen: 2, read: 3 }

function normalizeJid(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (/^[A-Za-z_]+:/.test(raw)) return ''
  const messageKeyMatch = raw.match(/^(.+?@(lid|g\.us|s\.whatsapp\.net|broadcast|newsletter))(?:[:].*)?$/)
  if (messageKeyMatch) return messageKeyMatch[1]
  if (raw.includes('@')) return raw
  const digits = raw.replace(/[^0-9]/g, '')
  return digits ? `${digits}@s.whatsapp.net` : ''
}

function jidDigits(jid) {
  return String(jid || '').split('@', 1)[0].replace(/[^0-9]/g, '')
}

function jidDomain(jid) {
  const parts = String(jid || '').split('@')
  return parts.length > 1 ? parts.slice(1).join('@') : ''
}

function stalePrimaryAliasError(jid) {
  const primaryDigits = jidDigits(primaryJid)
  if (!primaryDigits || jidDigits(jid) !== primaryDigits) return ''
  if (jidDomain(jid) === jidDomain(primaryJid)) return ''
  return `WHATSAPP-STALE-PRIMARY-ALIAS jid=${jid} current_primary=${primaryJid} use primary route or inspect live inbox before changing primary`
}

function isPrimaryJid(jid) {
  return Boolean(jid && (jid === primaryJid || primaryAliases.has(jid)))
}

function messageIdForKey(key) {
  const jid = key?.remoteJid || ''
  const id = key?.id || ''
  const participant = key?.participant || ''
  if (!jid || !id) return ''
  return `${jid}:${participant}:${id}`
}

function quoteMessageForText(text) {
  const value = String(text || '')
  if (!value) return null
  return { conversation: value.slice(0, 4096) }
}

function traceEvent(event) {
  try {
    fs.appendFileSync(inboxLog, JSON.stringify(event) + '\n')
  } catch (err) {
    console.log('[WHATSAPP] Trace write failed:', err?.message || err)
  }
}

function rememberBridgeSent(result, jid = '', details = {}) {
  const id = result?.key?.id
  if (!id) return
  bridgeSentIds.add(id)
  if (bridgeSentIds.size > 500) {
    const keep = Array.from(bridgeSentIds).slice(-250)
    bridgeSentIds = new Set(keep)
  }
  const item = {
    at: new Date().toISOString(),
    waTimestamp: Math.floor(Date.now() / 1000),
    messageId: messageIdFor(result, jid || result.key?.remoteJid || ''),
    jid: jid || result.key?.remoteJid || '',
    chatName: chatLabel(jid || result.key?.remoteJid || ''),
    from: process.env.OMEGACLAW_WA_SELF_NAME || 'self',
    fromMe: true,
    sentByBridge: true,
    kind: details.kind || 'text',
    text: String(details.text || ''),
    waKey: messageKeyFor(result, jid || result.key?.remoteJid || ''),
    quoteMessage: quoteMessageForText(details.text),
    quotedMessageId: details.quotedMessageId || '',
    state: 'read',
  }
  if (item.messageId && item.jid) rememberInbox(item.jid, item)
}

function safeName(name) {
  const base = path.basename(String(name || 'whatsapp_file'))
  return base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+|[._]+$/g, '') || 'whatsapp_file'
}

function extFor(kind, mimetype) {
  if (mimetype?.includes('jpeg')) return '.jpg'
  if (mimetype?.includes('png')) return '.png'
  if (mimetype?.includes('webp')) return '.webp'
  if (mimetype?.includes('mp4')) return '.mp4'
  if (mimetype?.includes('ogg')) return '.ogg'
  if (mimetype?.includes('mpeg')) return '.mp3'
  if (mimetype?.includes('pdf')) return '.pdf'
  if (kind === 'imageMessage') return '.jpg'
  if (kind === 'videoMessage') return '.mp4'
  if (kind === 'audioMessage') return '.ogg'
  return '.bin'
}

function mediaPayload(msg, kind) {
  if (!kind) return null
  const payload = msg.message?.[kind]
  if (!payload) return null
  if (['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'].includes(kind)) return payload
  return null
}

function extractText(msg) {
  const m = msg.message || {}
  if (m.conversation) return m.conversation
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text
  const kind = getContentType(m)
  const payload = mediaPayload(msg, kind)
  if (payload?.caption) return payload.caption
  return ''
}

function senderName(msg) {
  if (msg.key.fromMe) return process.env.OMEGACLAW_WA_SELF_NAME || 'self'
  return msg.pushName || msg.key.participant || msg.key.remoteJid || 'whatsapp_user'
}

function mentionJid(phone) {
  const digits = String(phone || '').replace(/[^0-9]/g, '')
  if (!digits) return ''
  return `${digits}@s.whatsapp.net`
}

function mentionText(phone) {
  const digits = String(phone || '').replace(/[^0-9]/g, '')
  return digits ? `@${digits}` : ''
}

function withMentionText(text, phone) {
  const mention = mentionText(phone)
  const base = String(text || '').trim()
  if (!mention) return base
  if (base.includes(mention)) return base
  return base ? `${base} ${mention}` : mention
}

function chatLabel(jid) {
  const known = chats.get(jid)
  return known?.name || known?.subject || jid
}

async function saveMedia(msg, kind) {
  const payload = mediaPayload(msg, kind)
  if (!payload) return ''
  const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage })
  const original = payload.fileName || `${kind}${extFor(kind, payload.mimetype || '')}`
  const filename = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}_${safeName(original)}`
  const target = path.join(inboxDir, filename)
  fs.writeFileSync(target, buffer)
  return target
}

function pushNotice(notice, delivery = null, event = null) {
  queue.push({ notice, delivery, event })
  if (queue.length > 200) queue = queue.slice(-200)
}

function rememberChat(jid, name = '') {
  if (!jid) return
  const known = chats.get(jid) || {}
  chats.set(jid, {
    jid,
    name: name || known.name || jid,
    isGroup: jid.endsWith('@g.us'),
  })
}

function rememberInbox(jid, item) {
  if (item.messageId && seenMessageIds.has(item.messageId)) return { item, fresh: false }
  if (item.messageId) seenMessageIds.add(item.messageId)
  if (!item.state) item.state = item.fromMe ? 'read' : 'unread'
  if (item.messageId) messageRefs.set(item.messageId, item)
  const list = inboxByJid.get(jid) || []
  list.push(item)
  inboxByJid.set(jid, list.slice(-100))
  traceEvent(item)
  return { item, fresh: true }
}

function findMessageItem(jid, messageId) {
  const safeId = String(messageId || '').trim()
  if (!safeId) return { error: 'WHATSAPP-UNKNOWN-MESSAGE missing message-id' }
  const safeJid = normalizeJid(jid || '')
  const direct = messageRefs.get(safeId)
  const scoped = safeJid
    ? (inboxByJid.get(safeJid) || []).find(entry =>
        entry.messageId === safeId ||
        entry.waKey?.id === safeId ||
        String(entry.messageId || '').endsWith(`:${safeId}`)
      )
    : null
  const item = direct || scoped || Array.from(inboxByJid.values()).flat().find(entry => entry.messageId === safeId)
  if (!item) return { error: `WHATSAPP-UNKNOWN-MESSAGE id=${safeId}` }
  const expectedJid = normalizeJid(jid || item.jid || '')
  if (expectedJid && item.jid !== expectedJid) return { error: `WHATSAPP-MESSAGE-JID-MISMATCH id=${safeId} expected=${expectedJid} actual=${item.jid}` }
  return { item }
}

function quoteForItem(item) {
  const key = messageKeyForItem(item)
  if (!key?.remoteJid || !key?.id) return null
  const message = item.quoteMessage || quoteMessageForText(item.text || item.caption || '')
  if (!message) return null
  return { key, message }
}

function reactionActorFor(reaction) {
  return reaction?.key?.participant || reaction?.senderUserJid || reaction?.key?.remoteJid || 'unknown'
}

function applyMessageEvent(event, writeTrace = true) {
  if (!event?.event) return false
  const item = messageRefs.get(event.messageId)
  if (!item) {
    if (writeTrace) traceEvent(event)
    return false
  }
  if (event.event === 'message-edit') {
    if (!Object.prototype.hasOwnProperty.call(item, 'originalText')) item.originalText = item.text || ''
    item.text = String(event.text || '')
    item.edited = true
    item.editedAt = event.at || new Date().toISOString()
  } else if (event.event === 'message-delete') {
    item.deleted = true
    item.deletedAt = event.at || new Date().toISOString()
  } else if (event.event === 'message-reaction') {
    item.reactions = item.reactions || {}
    const actor = event.actor || 'unknown'
    if (event.emoji) item.reactions[actor] = event.emoji
    else delete item.reactions[actor]
  } else {
    return false
  }
  if (writeTrace) traceEvent(event)
  return true
}

function loadInboxTrace() {
  try {
    if (!fs.existsSync(inboxLog)) return
    const lines = fs.readFileSync(inboxLog, 'utf8').split('\n').filter(Boolean).slice(-1000)
    for (const line of lines) {
      try {
        const item = JSON.parse(line)
        if (!item?.jid) continue
        if (item.event === 'read-state') {
          if (item.scope === 'ids') markMessageIdsState(item.jid, item.ids || [], item.state, false)
          else markChatState(item.jid, item.state, item.scope || 'all', false)
          continue
        }
        if (item.event === 'message-edit' || item.event === 'message-delete' || item.event === 'message-reaction') {
          applyMessageEvent(item, false)
          continue
        }
        rememberChat(item.jid, item.chatName || item.jid)
        const list = inboxByJid.get(item.jid) || []
        if (item.messageId && seenMessageIds.has(item.messageId)) continue
        if (item.messageId) seenMessageIds.add(item.messageId)
        if (item.messageId) messageRefs.set(item.messageId, item)
        if (!item.state) item.state = item.fromMe ? 'read' : 'read'
        list.push(item)
        inboxByJid.set(item.jid, list.slice(-100))
      } catch {}
    }
  } catch (err) {
    console.log('[WHATSAPP] Inbox trace load failed:', err?.message || err)
  }
}

function inboxSummary() {
  return Array.from(inboxByJid.entries()).map(([jid, items]) => {
    const meta = chats.get(jid) || { jid, name: jid, isGroup: jid.endsWith('@g.us') }
    const last = items[items.length - 1] || {}
    const unread = items.filter(item => item.state === 'unread').length
    const delivered = items.filter(item => item.state === 'delivered').length
    const seen = items.filter(item => item.state === 'seen').length
    return {
      jid,
      name: meta.name || jid,
      isGroup: Boolean(meta.isGroup),
      primary: isPrimaryJid(jid),
      unread,
      delivered,
      seen,
      lastFrom: last.from || '',
      lastKind: last.kind || '',
      lastAt: last.at || '',
    }
  }).sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)))
}

function formatMessage(item) {
  const marker = item.state === 'unread' ? ' [unread]' : item.state === 'seen' ? ' [seen]' : item.state === 'delivered' ? ' [delivered]' : ''
  const id = item.messageId ? ` id=${item.messageId}` : ''
  const edited = item.edited ? ' [edited]' : ''
  const deleted = item.deleted ? ' [deleted]' : ''
  const reactions = item.reactions && Object.keys(item.reactions).length
    ? ` reactions=${Object.values(item.reactions).join('')}`
    : ''
  const quote = item.quotedMessageId ? ` quoted=${item.quotedMessageId}` : ''
  if (item.deleted) return `${item.at}${marker}${id} ${item.from}: deleted message${reactions}`
  if (item.saved) return `${item.at}${marker}${id} ${item.from}: sent ${item.kind} saved at ${item.saved}${item.caption ? ` caption: ${item.caption}` : ''}${edited}${deleted}${reactions}${quote}`
  return `${item.at}${marker}${id} ${item.from}: ${item.text}${edited}${deleted}${reactions}${quote}`
}

function noticeMeta(item) {
  const id = item.messageId ? ` id=${item.messageId}` : ''
  const at = item.at ? ` at=${item.at}` : ''
  return `${id}${at}`
}

function channelEvent(item, route, event = 'message', extra = {}) {
  return {
    event,
    channel: 'whatsapp',
    route,
    conversation_id: item.jid || '',
    message_id: item.messageId || '',
    sender: item.from || '',
    chat: item.chatName || '',
    text: item.text || item.caption || '',
    ...extra,
  }
}

function unreadReminderNotices() {
  const notices = []
  const summaries = inboxSummary()
    .filter(item => (item.unread + item.delivered) > 0)
    .sort((a, b) => Number(Boolean(b.primary)) - Number(Boolean(a.primary)))
  for (const summary of summaries) {
    const items = inboxByJid.get(summary.jid) || []
    const pending = items.filter(item => (item.state === 'unread' || item.state === 'delivered') && !item.fromMe)
    if (!pending.length) continue
    const latest = pending[pending.length - 1]
    const key = `${latest.messageId || latest.at || 'unknown'}:${pending.length}:${latest.state}`
    if (remindedUnreadByJid.get(summary.jid) === key) continue
    remindedUnreadByJid.set(summary.jid, key)
    if (isPrimaryJid(summary.jid)) {
      notices.push({
        notice: `WHATSAPP_UNREAD_PRIMARY${noticeMeta(latest)}: ${latest.from}: ${latest.text || latest.kind || 'message'} jid=${summary.jid} pending=${pending.length} read_with=read-whatsapp-chat "${summary.jid}"`,
        delivery: { jid: summary.jid, ids: pending.map(item => item.messageId).filter(Boolean), state: 'read' },
        event: channelEvent(latest, 'primary-operator', 'message', { unread: pending.length, reply_affordance: 'send message', explicit_reply_affordance: 'reply-whatsapp-to-message conversation_id message_id message' }),
      })
    } else {
      const where = summary.isGroup ? ` in ${summary.name}` : ''
      notices.push({
        notice: `WHATSAPP_UNREAD_NOTICE${noticeMeta(latest)}: pending ${latest.kind || 'message'} from ${latest.from}${where} jid=${summary.jid} pending=${pending.length}`,
        event: channelEvent(latest, 'explicit-chat', 'message-notice', { unread: pending.length, reply_affordance: 'send-whatsapp-to conversation_id message', explicit_reply_affordance: 'reply-whatsapp-to-message conversation_id message_id message' }),
      })
    }
  }
  return notices.slice(0, 5)
}

function messageIdFor(msg, jid) {
  const id = msg?.key?.id || ''
  const participant = msg?.key?.participant || ''
  if (id) return `${jid}:${participant}:${id}`
  return ''
}

function messageKeyFor(msg, jid) {
  const id = msg?.key?.id || ''
  if (!id) return null
  const key = { remoteJid: jid, id, fromMe: Boolean(msg?.key?.fromMe) }
  if (msg?.key?.participant) key.participant = msg.key.participant
  return key
}

function messageKeyForItem(item) {
  if (item?.waKey?.remoteJid && item?.waKey?.id) return item.waKey
  if (!item?.messageId) return null
  const first = item.messageId.indexOf(':')
  const last = item.messageId.lastIndexOf(':')
  if (first < 0 || last <= first) return null
  const remoteJid = item.messageId.slice(0, first)
  const participant = item.messageId.slice(first + 1, last)
  const id = item.messageId.slice(last + 1)
  if (!remoteJid || !id) return null
  const key = { remoteJid, id, fromMe: false }
  if (participant) key.participant = participant
  return key
}

function messageTimestampSeconds(msg) {
  const raw = msg?.messageTimestamp
  if (!raw) return 0
  if (typeof raw === 'number') return raw
  if (typeof raw === 'object' && typeof raw.low === 'number') return raw.low
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : 0
}

function shouldTransitionState(current, next) {
  if (next === 'unread' || next === 'read') return current !== next
  return (STATE_RANK[current] ?? 0) < (STATE_RANK[next] ?? 0)
}

function markChatState(jid, state, scope = 'all', writeTrace = true) {
  const list = inboxByJid.get(jid) || []
  if (!list.length) return 0
  const candidates = scope === 'latest' ? list.slice(-1) : list
  let changed = 0
  for (const item of candidates) {
    if (shouldTransitionState(item.state, state)) {
      item.state = state
      changed += 1
    }
  }
  if (changed && writeTrace) {
    try {
      fs.appendFileSync(inboxLog, JSON.stringify({ event: 'read-state', at: new Date().toISOString(), jid, state, scope }) + '\n')
    } catch (err) {
      console.log('[WHATSAPP] Read-state trace write failed:', err?.message || err)
    }
  }
  return changed
}

function markMessageIdsState(jid, ids, state, writeTrace = true) {
  const wanted = new Set((ids || []).filter(Boolean))
  if (!wanted.size) return 0
  const list = inboxByJid.get(jid) || []
  let changed = 0
  for (const item of list) {
    if (wanted.has(item.messageId) && shouldTransitionState(item.state, state)) {
      item.state = state
      changed += 1
    }
  }
  if (changed && writeTrace) {
    try {
      fs.appendFileSync(inboxLog, JSON.stringify({ event: 'read-state', at: new Date().toISOString(), jid, state, scope: 'ids', ids: Array.from(wanted) }) + '\n')
    } catch (err) {
      console.log('[WHATSAPP] Read-state trace write failed:', err?.message || err)
    }
  }
  return changed
}

async function applyDeliveryState(delivery) {
  if (!delivery?.jid) return 0
  if (delivery.state === 'read') await sendReadReceiptsFor(delivery.jid, delivery.scope || 'all')
  if (delivery.ids?.length) return markMessageIdsState(delivery.jid, delivery.ids, delivery.state || 'delivered')
  return markChatState(delivery.jid, delivery.state || 'delivered', delivery.scope || 'all')
}

function readReceiptKeys(jid, scope = 'all') {
  const list = inboxByJid.get(jid) || []
  const candidates = scope === 'latest' ? list.slice(-1) : list
  const keys = []
  const seen = new Set()
  for (const item of candidates) {
    if (item.fromMe || item.state === 'read') continue
    const key = messageKeyForItem(item)
    if (!key?.remoteJid || !key?.id) continue
    const signature = `${key.remoteJid}:${key.participant || ''}:${key.id}`
    if (seen.has(signature)) continue
    seen.add(signature)
    keys.push(key)
  }
  return keys
}

async function sendReadReceiptsFor(jid, scope = 'all') {
  const keys = readReceiptKeys(jid, scope)
  if (!keys.length) return { attempted: 0, sent: 0 }
  if (!sock?.readMessages) return { attempted: keys.length, sent: 0, error: 'readMessages unavailable' }
  try {
    await sock.readMessages(keys)
    return { attempted: keys.length, sent: keys.length }
  } catch (err) {
    console.log('[WHATSAPP] Read receipt failed:', err?.message || err)
    return { attempted: keys.length, sent: 0, error: err?.message || String(err) }
  }
}

async function markOutboundHandled(jid) {
  const readReceipts = await sendReadReceiptsFor(jid, 'all')
  const changed = markChatState(jid, 'read', 'all')
  return { changed, readReceipts }
}

async function refreshChats() {
  if (!sock) return []
  try {
    const groups = await sock.groupFetchAllParticipating()
    for (const [jid, group] of Object.entries(groups || {})) {
      rememberChat(jid, group.subject || jid)
    }
  } catch (err) {
    // Individual chat inventory is opportunistic in Baileys. Group fetch is enough for setup.
  }
  const visible = Array.from(chats.values())
  return visible.sort((a, b) => String(a.name).localeCompare(String(b.name)))
}

async function startSocket() {
  const { state, saveCreds } = await useMultiFileAuthState(authDir)
  const { version } = await fetchLatestBaileysVersion()
  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    markOnlineOnConnect: false,
    syncFullHistory: false,
  })

  sock.ev.on('creds.update', saveCreds)
  if (pairingPhone && !state.creds.registered && !pairingRequested) {
    pairingRequested = true
    setTimeout(async () => {
      try {
        pairingCode = await sock.requestPairingCode(pairingPhone)
        status = 'pairing-code'
        console.log(`[WHATSAPP] Pairing code for ${pairingPhone}: ${pairingCode}`)
      } catch (err) {
        console.log('[WHATSAPP] Pairing code failed:', err?.message || err)
      }
    }, 2000)
  }
  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr && !pairingPhone) {
      lastQr = qr
      status = 'qr'
      console.log('[WHATSAPP] Scan this QR with WhatsApp Linked Devices')
      qrcodeTerminal.generate(qr, { small: true })
      fs.writeFileSync(qrTxt, qr)
      QRCode.toFile(qrPng, qr, { width: 512 }).catch(err => console.log('[WHATSAPP] QR PNG failed:', err?.message || err))
    }
    if (connection === 'open') {
      connected = true
      status = 'connected'
      console.log('[WHATSAPP] Connected')
      await refreshChats()
    }
    if (connection === 'close') {
      connected = false
      const code = lastDisconnect?.error?.output?.statusCode
      status = `closed:${code || 'unknown'}`
      console.log(`[WHATSAPP] Closed ${code || ''}`)
      if (code !== DisconnectReason.loggedOut) setTimeout(startSocket, 3000)
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    for (const msg of messages || []) {
      try {
        if (!msg.message) continue
        if (msg.key.fromMe && bridgeSentIds.has(msg.key.id)) continue
        const jid = msg.key.remoteJid || ''
        const isGroup = jid.endsWith('@g.us')
        const kind = getContentType(msg.message)
        const text = extractText(msg)
        if (msg.key.fromMe && !includeOwnMessages) continue
        const from = senderName(msg)
        rememberChat(jid, chatLabel(jid))
        const where = isGroup ? ` in ${chatLabel(jid)}` : ''
        const prefix = `${from}${where}`
        const payload = mediaPayload(msg, kind)
        const waTimestamp = messageTimestampSeconds(msg)
        const oldReplay = waTimestamp && waTimestamp < bridgeStartedAtSeconds - 60
        const item = {
          at: new Date().toISOString(),
          waTimestamp,
          messageId: messageIdFor(msg, jid),
          jid,
          chatName: chatLabel(jid),
          from,
          fromMe: Boolean(msg.key.fromMe),
          kind: kind || 'text',
          text,
          waKey: messageKeyFor(msg, jid),
          quoteMessage: quoteMessageForText(text),
          state: (msg.key.fromMe || oldReplay) ? 'read' : 'unread',
        }
        if (payload) {
          const saved = await saveMedia(msg, kind)
          const caption = text ? ` caption: ${text}` : ''
          item.saved = saved
          item.caption = text || ''
          const remembered = rememberInbox(jid, item)
          if (!remembered.fresh || msg.key.fromMe || oldReplay) continue
          const unread = (inboxByJid.get(jid) || []).filter(entry => entry.state === 'unread').length
          if (!primaryJid || isPrimaryJid(jid)) {
            pushNotice(
              `WHATSAPP_PRIMARY${noticeMeta(item)}: ${prefix} sent ${kind.replace('Message', '')} saved at ${saved}${caption}`,
              { jid, ids: item.messageId ? [item.messageId] : [], state: 'read' },
              channelEvent(item, 'primary-operator', 'media', { text: caption || '', reply_affordance: 'send message', explicit_reply_affordance: 'reply-whatsapp-to-message conversation_id message_id message' })
            )
          } else {
            pushNotice(
              `WHATSAPP_INBOX_NOTICE${noticeMeta(item)}: new ${kind.replace('Message', '')} from ${from}${where} jid=${jid} unread=${unread} saved at ${saved}${caption}`,
              null,
              channelEvent(item, 'explicit-chat', 'media-notice', { unread, text: '<inspect-chat-for-current-text>', reply_affordance: 'send-whatsapp-to conversation_id message', explicit_reply_affordance: 'reply-whatsapp-to-message conversation_id message_id message' })
            )
          }
        } else if (text) {
          const remembered = rememberInbox(jid, item)
          if (!remembered.fresh || msg.key.fromMe || oldReplay) continue
          const unread = (inboxByJid.get(jid) || []).filter(entry => entry.state === 'unread').length
          if (!primaryJid || isPrimaryJid(jid)) {
            pushNotice(
              `WHATSAPP_PRIMARY${noticeMeta(item)}: ${prefix}: ${text}`,
              { jid, ids: item.messageId ? [item.messageId] : [], state: 'read' },
              channelEvent(item, 'primary-operator', 'message', { reply_affordance: 'send message', explicit_reply_affordance: 'reply-whatsapp-to-message conversation_id message_id message' })
            )
          } else {
            pushNotice(
              `WHATSAPP_INBOX_NOTICE${noticeMeta(item)}: new message from ${from}${where} jid=${jid} unread=${unread}`,
              null,
              channelEvent(item, 'explicit-chat', 'message-notice', { unread, text: '<inspect-chat-for-current-text>', reply_affordance: 'send-whatsapp-to conversation_id message', explicit_reply_affordance: 'reply-whatsapp-to-message conversation_id message_id message' })
            )
          }
        }
      } catch (err) {
        console.log('[WHATSAPP] Message handling failed:', err?.message || err)
      }
    }
  })

  sock.ev.on('messages.reaction', events => {
    for (const event of events || []) {
      try {
        const key = event?.key || event?.reaction?.key
        const messageId = messageIdForKey(key)
        if (!messageId) continue
        const item = messageRefs.get(messageId)
        const reactionEvent = {
          event: 'message-reaction',
          at: new Date().toISOString(),
          jid: item?.jid || key?.remoteJid || '',
          messageId,
          actor: reactionActorFor(event?.reaction),
          emoji: event?.reaction?.text || '',
          fromMe: Boolean(event?.reaction?.fromMe),
        }
        applyMessageEvent(reactionEvent)
        if (item && !item.fromMe && isPrimaryJid(item.jid)) {
          pushNotice(
            `WHATSAPP_PRIMARY_REACTION id=${messageId} emoji=${reactionEvent.emoji || 'removed'} jid=${item.jid}`,
            null,
            channelEvent(item, 'primary-operator', 'reaction', { emoji: reactionEvent.emoji || 'removed', reply_affordance: 'send message' })
          )
        }
      } catch (err) {
        console.log('[WHATSAPP] Reaction handling failed:', err?.message || err)
      }
    }
  })

  sock.ev.on('messages.update', updates => {
    for (const update of updates || []) {
      try {
        const messageId = messageIdForKey(update?.key)
        if (!messageId) continue
        const edited = update?.update?.message?.protocolMessage?.editedMessage
          || update?.update?.message?.editedMessage
          || null
        if (!edited) continue
        const text = extractText({ key: update.key, message: edited })
        const item = messageRefs.get(messageId)
        const editEvent = {
          event: 'message-edit',
          at: new Date().toISOString(),
          jid: item?.jid || update?.key?.remoteJid || '',
          messageId,
          text,
          fromMe: Boolean(update?.key?.fromMe),
        }
        applyMessageEvent(editEvent)
        if (item && !item.fromMe && isPrimaryJid(item.jid)) {
          pushNotice(
            `WHATSAPP_PRIMARY_EDIT id=${messageId} jid=${item.jid}: ${text}`,
            null,
            channelEvent(item, 'primary-operator', 'edit', { text, reply_affordance: 'send message' })
          )
        }
      } catch (err) {
        console.log('[WHATSAPP] Edit handling failed:', err?.message || err)
      }
    }
  })

  sock.ev.on('messages.delete', event => {
    const keys = event?.keys || []
    for (const key of keys) {
      try {
        const messageId = messageIdForKey(key)
        if (!messageId) continue
        const item = messageRefs.get(messageId)
        const deleteEvent = {
          event: 'message-delete',
          at: new Date().toISOString(),
          jid: item?.jid || key?.remoteJid || '',
          messageId,
          fromMe: Boolean(key?.fromMe),
        }
        applyMessageEvent(deleteEvent)
        if (item && !item.fromMe && isPrimaryJid(item.jid)) {
          pushNotice(
            `WHATSAPP_PRIMARY_DELETE id=${messageId} jid=${item.jid}`,
            null,
            channelEvent(item, 'primary-operator', 'delete', { text: '', reply_affordance: 'send message' })
          )
        }
      } catch (err) {
        console.log('[WHATSAPP] Delete handling failed:', err?.message || err)
      }
    }
  })
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', chunk => { data += chunk })
    req.on('end', () => {
      if (!data) return resolve({})
      try { resolve(JSON.parse(data)) } catch (err) { reject(err) }
    })
  })
}

function sendJson(res, statusCode, body) {
  const data = JSON.stringify(body)
  res.writeHead(statusCode, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) })
  res.end(data)
}

async function handle(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${port}`)
  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, { ok: true, connected, status, targetJid, primaryJid, primaryOperatorRoute: primaryJid, primaryAliases: Array.from(primaryAliases), queue: queue.length, qrFile: qrPng, hasQr: Boolean(lastQr), pairingPhone, pairingCode })
    }
    if (req.method === 'GET' && url.pathname === '/messages') {
      let entries = queue
      queue = []
      if (!entries.length) entries = unreadReminderNotices()
      const messages = await Promise.all(entries.map(async entry => {
        if (typeof entry === 'string') return entry
        await applyDeliveryState(entry.delivery)
        return entry.notice
      }))
      const events = entries
        .filter(entry => entry && typeof entry === 'object' && entry.event)
        .map(entry => entry.event)
      return sendJson(res, 200, { ok: true, messages, events })
    }
    if (req.method === 'GET' && url.pathname === '/chats') {
      const list = await refreshChats()
      return sendJson(res, 200, { ok: true, chats: list })
    }
    if (req.method === 'GET' && url.pathname === '/inbox') {
      await refreshChats()
      return sendJson(res, 200, { ok: true, primaryJid, primaryAliases: Array.from(primaryAliases), inbox: inboxSummary() })
    }
    if (req.method === 'GET' && url.pathname === '/chat-messages') {
      const jid = normalizeJid(url.searchParams.get('jid') || '')
      if (!jid) return sendJson(res, 400, { ok: false, error: 'missing jid' })
      const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit') || '20')))
      const items = (inboxByJid.get(jid) || []).slice(-limit)
      markChatState(jid, 'seen', 'all')
      return sendJson(res, 200, { ok: true, jid, messages: items.map(formatMessage) })
    }
    if (req.method === 'POST' && url.pathname === '/chat-state') {
      const body = await readJson(req)
      const jid = normalizeJid(body.jid || '')
      const state = body.state === 'unread' ? 'unread' : 'read'
      const scope = body.scope === 'latest' ? 'latest' : 'all'
      if (!jid) return sendJson(res, 400, { ok: false, error: 'missing jid' })
      const readReceipts = state === 'read' ? await sendReadReceiptsFor(jid, scope) : { attempted: 0, sent: 0 }
      const changed = markChatState(jid, state, scope)
      return sendJson(res, 200, { ok: true, jid, state, scope, changed, readReceipts })
    }
    if (req.method === 'POST' && url.pathname === '/primary') {
      const body = await readJson(req)
      const jid = normalizeJid(body.jid || '')
      if (!jid) return sendJson(res, 400, { ok: false, error: 'missing jid' })
      const aliases = new Set((body.aliases || []).map(normalizeJid).filter(Boolean))
      for (const alias of aliases) primaryAliases.add(alias)
      primaryAliases.add(jid)
      primaryJid = jid
      rememberChat(jid, body.name || jid)
      return sendJson(res, 200, { ok: true, primaryJid, primaryAliases: Array.from(primaryAliases) })
    }
    if (req.method === 'POST' && url.pathname === '/send') {
      const body = await readJson(req)
      const to = normalizeJid(body.to || targetJid || primaryJid)
      if (!connected || !sock) return sendJson(res, 503, { ok: false, error: 'not connected' })
      if (!to) return sendJson(res, 400, { ok: false, error: 'missing target jid' })
      const staleAlias = stalePrimaryAliasError(to)
      if (staleAlias) return sendJson(res, 400, { ok: false, error: staleAlias })
      const text = `${outboundPrefix}${String(body.text || '')}`
      const result = await sock.sendMessage(to, { text })
      rememberBridgeSent(result, to, { text })
      return sendJson(res, 200, { ok: true, messageId: messageIdFor(result, to), handled: { changed: 0, readReceipts: { attempted: 0, sent: 0 }, note: 'send-does-not-mark-inbound-read-use-mark-whatsapp-read' } })
    }
    if (req.method === 'POST' && url.pathname === '/send-mention') {
      const body = await readJson(req)
      const to = normalizeJid(body.to || targetJid || primaryJid)
      const mention = mentionJid(body.phone)
      if (!connected || !sock) return sendJson(res, 503, { ok: false, error: 'not connected' })
      if (!to) return sendJson(res, 400, { ok: false, error: 'missing target jid' })
      const staleAlias = stalePrimaryAliasError(to)
      if (staleAlias) return sendJson(res, 400, { ok: false, error: staleAlias })
      if (!mention) return sendJson(res, 400, { ok: false, error: 'missing mention phone' })
      const text = `${outboundPrefix}${withMentionText(body.text, body.phone)}`
      const result = await sock.sendMessage(to, { text, mentions: [mention] })
      rememberBridgeSent(result, to, { text })
      return sendJson(res, 200, { ok: true, messageId: messageIdFor(result, to), handled: { changed: 0, readReceipts: { attempted: 0, sent: 0 }, note: 'send-does-not-mark-inbound-read-use-mark-whatsapp-read' } })
    }
    if (req.method === 'POST' && url.pathname === '/send-file') {
      const body = await readJson(req)
      const to = normalizeJid(body.to || targetJid || primaryJid)
      const filePath = String(body.path || '')
      const caption = body.caption ? `${outboundPrefix}${String(body.caption || '')}` : outboundPrefix.trim()
      if (!connected || !sock) return sendJson(res, 503, { ok: false, error: 'not connected' })
      if (!to) return sendJson(res, 400, { ok: false, error: 'missing target jid' })
      const staleAlias = stalePrimaryAliasError(to)
      if (staleAlias) return sendJson(res, 400, { ok: false, error: staleAlias })
      if (!filePath || !fs.existsSync(filePath)) return sendJson(res, 400, { ok: false, error: 'file not found' })
      const mimetype = body.mimetype || 'application/octet-stream'
      const base = { mimetype, fileName: path.basename(filePath), caption }
      let result
      if (mimetype.startsWith('image/')) result = await sock.sendMessage(to, { image: { url: filePath }, caption })
      else if (mimetype.startsWith('video/')) result = await sock.sendMessage(to, { video: { url: filePath }, caption })
      else if (mimetype.startsWith('audio/')) result = await sock.sendMessage(to, { audio: { url: filePath }, mimetype })
      else result = await sock.sendMessage(to, { document: { url: filePath }, ...base })
      rememberBridgeSent(result, to, { text: caption, kind: mimetype.startsWith('image/') ? 'image' : mimetype.startsWith('video/') ? 'video' : mimetype.startsWith('audio/') ? 'audio' : 'document' })
      return sendJson(res, 200, { ok: true, messageId: messageIdFor(result, to), handled: { changed: 0, readReceipts: { attempted: 0, sent: 0 }, note: 'send-does-not-mark-inbound-read-use-mark-whatsapp-read' } })
    }
    if (req.method === 'POST' && url.pathname === '/reply-to-message') {
      const body = await readJson(req)
      const to = normalizeJid(body.to || '')
      const text = `${outboundPrefix}${String(body.text || '')}`
      if (!connected || !sock) return sendJson(res, 503, { ok: false, error: 'not connected' })
      if (!to) return sendJson(res, 400, { ok: false, error: 'missing target jid' })
      const found = findMessageItem(to, body.messageId)
      if (found.error) return sendJson(res, 400, { ok: false, error: found.error })
      const quoted = quoteForItem(found.item)
      if (!quoted) return sendJson(res, 400, { ok: false, error: `WHATSAPP-QUOTE-UNAVAILABLE id=${body.messageId}` })
      const result = await sock.sendMessage(to, { text }, { quoted })
      rememberBridgeSent(result, to, { text, quotedMessageId: found.item.messageId })
      return sendJson(res, 200, { ok: true, messageId: messageIdFor(result, to), quotedMessageId: found.item.messageId })
    }
    if (req.method === 'POST' && url.pathname === '/react') {
      const body = await readJson(req)
      const to = normalizeJid(body.to || '')
      const emoji = String(body.emoji || '').trim().slice(0, 16)
      if (!connected || !sock) return sendJson(res, 503, { ok: false, error: 'not connected' })
      if (!to) return sendJson(res, 400, { ok: false, error: 'missing target jid' })
      const found = findMessageItem(to, body.messageId)
      if (found.error) return sendJson(res, 400, { ok: false, error: found.error })
      const key = messageKeyForItem(found.item)
      if (!key) return sendJson(res, 400, { ok: false, error: `WHATSAPP-UNKNOWN-MESSAGE id=${body.messageId}` })
      await sock.sendMessage(to, { react: { text: emoji, key } })
      applyMessageEvent({ event: 'message-reaction', at: new Date().toISOString(), jid: to, messageId: found.item.messageId, actor: 'self', emoji, fromMe: true })
      return sendJson(res, 200, { ok: true, messageId: found.item.messageId, emoji })
    }
    if (req.method === 'POST' && url.pathname === '/edit') {
      const body = await readJson(req)
      const found = findMessageItem('', body.messageId)
      if (found.error) return sendJson(res, 400, { ok: false, error: found.error })
      if (!found.item.fromMe || !found.item.sentByBridge) return sendJson(res, 403, { ok: false, error: `WHATSAPP-EDIT-NOT-OWN-MESSAGE id=${body.messageId}` })
      const key = messageKeyForItem(found.item)
      const text = `${outboundPrefix}${String(body.text || '')}`
      if (!connected || !sock) return sendJson(res, 503, { ok: false, error: 'not connected' })
      if (!key) return sendJson(res, 400, { ok: false, error: `WHATSAPP-UNKNOWN-MESSAGE id=${body.messageId}` })
      await sock.sendMessage(found.item.jid, { text, edit: key })
      applyMessageEvent({ event: 'message-edit', at: new Date().toISOString(), jid: found.item.jid, messageId: found.item.messageId, text, fromMe: true })
      return sendJson(res, 200, { ok: true, messageId: found.item.messageId })
    }
    if (req.method === 'POST' && url.pathname === '/delete') {
      const body = await readJson(req)
      const found = findMessageItem('', body.messageId)
      if (found.error) return sendJson(res, 400, { ok: false, error: found.error })
      if (!found.item.fromMe || !found.item.sentByBridge) return sendJson(res, 403, { ok: false, error: `WHATSAPP-DELETE-NOT-OWN-MESSAGE id=${body.messageId}` })
      const key = messageKeyForItem(found.item)
      if (!connected || !sock) return sendJson(res, 503, { ok: false, error: 'not connected' })
      if (!key) return sendJson(res, 400, { ok: false, error: `WHATSAPP-UNKNOWN-MESSAGE id=${body.messageId}` })
      await sock.sendMessage(found.item.jid, { delete: key })
      applyMessageEvent({ event: 'message-delete', at: new Date().toISOString(), jid: found.item.jid, messageId: found.item.messageId, fromMe: true })
      return sendJson(res, 200, { ok: true, messageId: found.item.messageId })
    }
    return sendJson(res, 404, { ok: false, error: 'not found' })
  } catch (err) {
    return sendJson(res, 500, { ok: false, error: err?.message || String(err) })
  }
}

http.createServer(handle).listen(port, '127.0.0.1', () => {
  console.log(`[WHATSAPP] Bridge listening on 127.0.0.1:${port}`)
})

loadInboxTrace()

startSocket().catch(err => {
  status = `failed:${err?.message || err}`
  console.error('[WHATSAPP] Startup failed:', err)
})
