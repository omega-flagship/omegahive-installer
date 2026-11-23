// Purpose: Store a Baileys session through the hive's WhatsApp entries route.
import { BufferJSON, initAuthCreds, proto } from '@whiskeysockets/baileys'

// Keep requests in call order, including across socket restarts. Each write is atomic in the hive.
let lastRequest = Promise.resolve()

async function postEntries(body) {
  const base = process.env.HIVE_API_URL?.replace(/\/+$/, '')
  const token = process.env.HIVE_WS_TOKEN
  if (!base || !token) throw new Error('WhatsApp hive auth requires HIVE_API_URL and HIVE_WS_TOKEN')
  const response = await fetch(base + '/api/agent/connectors/whatsapp/entries', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) {
    const error = (await response.json().catch(() => null))?.error
    const detail = error ? `${error.code}: ${error.message}` : response.statusText
    throw new Error(`Hive HTTP ${response.status}: ${detail}`)
  }
  return (await response.json()).values
}

function entries(body) {
  const request = lastRequest.then(() => postEntries(body))
  lastRequest = request.catch(() => {})
  return request
}

function keyFile(type, id) {
  return `${type}-${id}.json`.replaceAll('/', '__').replaceAll(':', '-')
}

export async function useHiveAuthState(checkIdentity = () => {}) {
  const { 'creds.json': text } = await entries({ get: ['creds.json'] })
  const savedCreds = text === null ? null : JSON.parse(text, BufferJSON.reviver)
  if (savedCreds) checkIdentity(savedCreds)
  const creds = savedCreds || initAuthCreds()

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const files = ids.map(id => keyFile(type, id))
          const values = await entries({ get: files })
          return Object.fromEntries(ids.map((id, index) => {
            const text = values[files[index]]
            const value = text === null ? null : JSON.parse(text, BufferJSON.reviver)
            return [id, type === 'app-state-sync-key' && value
              ? proto.Message.AppStateSyncKeyData.fromObject(value)
              : value]
          }))
        },
        set: async (data) => {
          const updates = new Map()
          for (const [type, keys] of Object.entries(data)) {
            for (const [id, value] of Object.entries(keys)) updates.set(keyFile(type, id), value)
          }
          const set = {}
          const remove = []
          for (const [file, value] of updates) {
            if (value) set[file] = JSON.stringify(value, BufferJSON.replacer)
            else remove.push(file)
          }
          await entries({ set, delete: remove })
        },
      },
    },
    saveCreds: async () => {
      await entries({ set: { 'creds.json': JSON.stringify(creds, BufferJSON.replacer) } })
    },
  }
}
