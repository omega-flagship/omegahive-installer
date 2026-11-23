// Purpose: read the hive's answer about a person's own connectors (GET /api/connectors) into safe, typed values, and
// build the bodies the person's connector changes send. No secret is ever a UI value: the hive sends only which fields
// are entered.

/** Where the hive keeps the key that seals connector secrets. */
export type KeyHome = 'keychain' | 'systemd-creds' | 'key-file' | 'fallback-file' | 'throwaway' | null

export interface ConnectorStore {
  open: boolean
  home: KeyHome
  /** set before the first secret: the key is made then */
  made: boolean
  warning: string | null
  reason: string | null
}

export interface ConnectorRow {
  id: 'home_assistant' | 'librelinkup' | 'whatsapp' | 'agentverse'
  kind: 'calls' | 'served'
  exclusive: boolean
  set: boolean
  /** the names of the entered fields, never their values */
  fields: string[]
  /** the person's minds it is installed on */
  minds: string[]
}

export interface ConnectorMind { id: string; name: string; running: boolean }

export interface ConnectorsStatus { store: ConnectorStore; connectors: ConnectorRow[]; minds: ConnectorMind[] }

const IDS = ['home_assistant', 'librelinkup', 'whatsapp', 'agentverse'] as const
const HOMES = ['keychain', 'systemd-creds', 'key-file', 'fallback-file', 'throwaway']
const MIND = /^[A-Za-z0-9_.:-]{1,128}$/
const FIELD = /^[a-z_]{1,32}$/
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown, most = 2000): string | null => (typeof v === 'string' && v.length <= most ? v : null)

function readStore(v: unknown): ConnectorStore | null {
  if (!object(v) || typeof v.open !== 'boolean') return null
  const home = v.home === null || v.home === undefined ? null : HOMES.includes(String(v.home)) ? (v.home as KeyHome) : undefined
  if (home === undefined) return null
  return { open: v.open, home, made: v.made !== false, warning: text(v.warning), reason: text(v.reason) }
}

function readRow(v: unknown): ConnectorRow | null {
  if (!object(v) || !IDS.includes(v.id as ConnectorRow['id']) || (v.kind !== 'calls' && v.kind !== 'served') ||
      typeof v.exclusive !== 'boolean' || typeof v.set !== 'boolean' || !Array.isArray(v.fields) || !Array.isArray(v.minds) ||
      !v.fields.every((f) => typeof f === 'string' && FIELD.test(f)) || !v.minds.every((m) => typeof m === 'string' && MIND.test(m)))
    return null
  return { id: v.id as ConnectorRow['id'], kind: v.kind, exclusive: v.exclusive, set: v.set, fields: [...v.fields as string[]],
    minds: [...v.minds as string[]] }
}

/** The person's connectors as the hive answered, or null when the answer is not the shape it should be. */
export function readConnectors(v: unknown): ConnectorsStatus | null {
  if (!object(v) || !Array.isArray(v.connectors) || !Array.isArray(v.minds)) return null
  const store = readStore(v.store)
  const connectors = v.connectors.map(readRow)
  const minds = v.minds.map((m) => (object(m) && typeof m.id === 'string' && MIND.test(m.id) && typeof m.running === 'boolean'
    ? { id: m.id, name: text(m.name, 200) ?? m.id, running: m.running } : null))
  if (!store || connectors.some((c) => c === null) || minds.some((m) => m === null)) return null
  return { store, connectors: connectors as ConnectorRow[], minds: minds as ConnectorMind[] }
}

/** What a change answers: the connector's row, and the minds that need a restart for its module to load or go. */
export function readConnectorChange(v: unknown): { row: ConnectorRow; restart: string[] } | null {
  const row = readRow(v)
  if (!row || !object(v)) return null
  const restart = Array.isArray(v.restart) && v.restart.every((m) => typeof m === 'string' && MIND.test(m)) ? [...v.restart as string[]] : []
  return { row, restart }
}

/** A person's Home Assistant address and token. */
export function homeAssistantSettings(url: string, token: string): { url: string; token: string } {
  if (!/^https?:\/\/\S+$/.test(url.trim()) || !token.trim()) throw new TypeError('An http(s) address and a token, please.')
  return { url: url.trim(), token: token.trim() }
}

/** A person's LibreLinkUp login, with its unit when they chose one. */
export function libreLinkUpSettings(username: string, password: string, unit: string): Record<string, string> {
  if (!username.trim() || !password) throw new TypeError('An email address and a password, please.')
  return { username: username.trim(), password, ...(unit === 'mmol/L' || unit === 'mg/dL' ? { unit } : {}) }
}
