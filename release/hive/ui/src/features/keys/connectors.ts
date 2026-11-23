// Purpose: what the You page's connector screens are told (connectors.metta): the panel's facts and data from the
// person's connectors answer, and each connector card's, with what each connector does and where the key that seals
// them lives, in plain words. Pure: composing is handed in. No secret is ever here; the hive sends only which fields
// are entered, and a token or password typed into a card's hidden field goes straight to the hive.
import type { ConnectorRow, ConnectorsStatus, KeyHome } from '../../api/connectors'
import { withResource, type ResourceLike } from '../../screens/resourceFacts'
import type { Compose } from '../../screens/screenSpace'
import type { StackItem } from './data'

/** What the person has typed into a connector's visible fields (never its token or password). */
export interface ConnectorForm { url?: string; username?: string; unit?: string }

/** What the person is doing with each connector, by its id. */
export interface ConnectorWork {
  forms: Record<string, ConnectorForm>
  confirming: ReadonlySet<string>
  busy: ReadonlySet<string>
  /** minds whose module changes when they next start, by connector id */
  restart: Record<string, string[]>
  /** why the last save, switch or disconnect failed, by connector id */
  errors: Record<string, string>
}

export interface ConnectorsInput {
  status: ConnectorsStatus | null
  /** why the last read failed (undefined when it did not), or 'unsupported' when this hive has no connectors */
  error: unknown
  unsupported: boolean
  work: ConnectorWork
}

const ABOUT: Record<ConnectorRow['id'], { title: string; about: string }> = {
  home_assistant: { title: 'Home Assistant',
    about: 'Your home\'s devices. The hive makes each call with your token, so a mind never holds it.' },
  librelinkup: { title: 'LibreLinkUp',
    about: 'Glucose readings from the LibreLinkUp app. The hive logs in and reads them with your login, so a mind never holds it.' },
  whatsapp: { title: 'WhatsApp',
    about: 'Messages through your WhatsApp. The mind it is on pairs it and keeps the session with the hive.' },
  agentverse: { title: 'Agentverse',
    about: 'An Agentverse listener for the mind it is on. The hive makes its seed the first time a mind uses it.' },
}

const HOME: Record<Exclude<KeyHome, null>, string> = {
  keychain: 'The key that seals your logins is in this Mac\'s login Keychain.',
  'systemd-creds': 'The key that seals your logins is sealed to this machine and its user by systemd.',
  'key-file': 'The key that seals your logins is in the key file this hive was started with.',
  'fallback-file': 'The key that seals your logins is a private file in the hive owner\'s home folder.',
  throwaway: 'This is a throwaway hive: its key goes with it.',
}

/** Where the key lives, in words. */
export function storeWhere(home: KeyHome, made: boolean): string {
  const where = home ? HOME[home] : 'The hive will make the key that seals your logins when you enter the first one.'
  return made || !home ? where : `${where} It is made when you enter your first login.`
}

/** One connector's card: its facts and the words it draws. */
export function connectorItem(row: ConnectorRow, status: ConnectorsStatus, work: ConnectorWork, compose: Compose): StackItem {
  const restart = work.restart[row.id] ?? []
  const names = (ids: string[]) => ids.map((id) => status.minds.find((m) => m.id === id)?.name ?? id)
  const form = work.forms[row.id] ?? {}
  const meta = row.set
    ? (row.minds.length ? `On ${names(row.minds).join(', ')}` : 'On none of your minds yet')
    : (row.kind === 'calls' ? 'Not connected' : 'Not on a mind yet')
  return {
    id: row.id,
    plan: compose('profile-connector', {
      flags: { 'connector.set': row.set, 'connector.confirming': work.confirming.has(row.id), 'connector.busy': work.busy.has(row.id),
        'connector.restart': restart.length > 0, 'connector.error': !!work.errors[row.id] },
      values: { 'connector.id': row.id },
      counts: { 'connector.minds': status.minds.length },
    }),
    data: {
      'connector.title': ABOUT[row.id].title,
      'connector.about': ABOUT[row.id].about,
      'connector.meta': meta,
      'connector.busy': work.busy.has(row.id),
      'connector.error': work.errors[row.id] ?? '',
      'connector.restart_names': names(restart).join(', '),
      'connector.minds': status.minds.map((m) => ({ id: m.id, name: m.name, on: row.minds.includes(m.id) })),
      'connector.units': [{ id: 'mmol/L', label: 'mmol/L' }, { id: 'mg/dL', label: 'mg/dL' }],
      'form.url': form.url ?? '',
      'form.username': form.username ?? '',
      'form.unit': form.unit ?? '',
    },
  }
}

/** Where the connectors are: unsupported, loading, read, or failed (a failure after a read keeps them on screen). */
export function connectorsResource(input: ConnectorsInput): ResourceLike {
  if (input.unsupported) return { status: 'unsupported', error: undefined }
  if (input.status) return { status: 'ready', error: input.error }   // a failed refresh: stale, the last read kept
  return input.error !== undefined ? { status: 'error', error: input.error } : { status: 'loading', error: undefined }
}

/** The panel the You page stacks: the store's state and each connector's card. */
export function connectorsPanel(input: ConnectorsInput, compose: Compose): StackItem {
  const { status, work } = input
  const items = status ? status.connectors.map((row) => connectorItem(row, status, work, compose)) : []
  const { data, facts } = withResource(connectorsResource(input), {
    data: {
      'store.where': status ? storeWhere(status.store.home, status.store.made) : '',
      'store.warning': status?.store.warning ?? '',
      'store.reason': status?.store.reason ?? '',
      'connectors.items': items,
    },
    facts: {
      counts: { 'connectors.items': items.length },
      flags: { 'store.open': !!status?.store.open, 'store.warning': !!status?.store.warning },
    },
  })
  return { id: 'connectors', plan: compose('profile-connectors', facts), data }
}
