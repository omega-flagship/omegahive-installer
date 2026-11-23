// Purpose: the You page's connectors: load the person's own connectors, keep what they type into each card's visible
// fields and what is pending, and carry out a save, a switch for one of their minds, or a disconnect. A token or
// password arrives with the Save press and goes straight to the hive; it is never kept here.
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { HiveClient } from '../../api/client'
import { homeAssistantSettings, libreLinkUpSettings, readConnectorChange, readConnectors, type ConnectorsStatus } from '../../api/connectors'
import { errorMessage } from '../../lib/useResource'
import type { ScreenItem } from '../../screens/Screen'
import type { ConnectorForm, ConnectorsInput } from './connectors'

const without = (set: ReadonlySet<string>, key: string) => new Set([...set].filter((k) => k !== key))
const FORM_FIELDS: Record<string, keyof ConnectorForm> = { 'form.url': 'url', 'form.username': 'username', 'form.unit': 'unit' }

export interface Connectors {
  /** what connectors.ts composes from, or undefined where the client has no connectors (the demo) */
  input: ConnectorsInput | undefined
  /** a press on a connector card; true when it was one */
  act(action: string, item: ScreenItem, value?: unknown): boolean
  /** a change to a card's visible field */
  type(bind: string, value: string, scope?: readonly string[]): void
}

export function useConnectors(client: HiveClient | null | undefined): Connectors {
  const supported = !!client?.connectors
  const [status, setStatus] = useState<ConnectorsStatus | null>(null)
  const [error, setError] = useState<unknown>(undefined)
  const [forms, setForms] = useState<Record<string, ConnectorForm>>({})
  const [confirming, setConfirming] = useState<ReadonlySet<string>>(() => new Set())
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set())
  const [restart, setRestart] = useState<Record<string, string[]>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    if (!client?.connectors) return
    setError(undefined)
    try {
      const read = readConnectors(await client.connectors())
      if (!read) throw new Error('The hive answered something other than your connectors.')
      setStatus(read)
    } catch (e) {
      setError(e)
    }
  }, [client])
  useEffect(() => { void load() }, [load])

  /** Run one change for a connector: busy while it runs, its answer folded into the status, its refusal on the card. */
  const change = useCallback(async (id: string, run: () => Promise<unknown>) => {
    setBusy((s) => new Set([...s, id]))
    setErrors((r) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== id)))
    try {
      const answer = readConnectorChange(await run())
      if (!answer) throw new Error('The hive answered something other than this connector.')
      setStatus((s) => (s ? { ...s, connectors: s.connectors.map((c) => (c.id === id ? answer.row : c)) } : s))
      setRestart((r) => ({ ...r, [id]: answer.restart }))
    } catch (e) {
      setErrors((r) => ({ ...r, [id]: errorMessage(e) }))
    } finally {
      setBusy((s) => without(s, id))
    }
  }, [])

  const act = (action: string, item: ScreenItem, value?: unknown): boolean => {
    if (!client?.connectors) return false
    if (action === 'connectors-retry') {
      void load()
      return true
    }
    const scope = Array.isArray(item.scope) ? item.scope.map(String) : []
    if (scope[0] !== 'connectors' || !scope[1]) return false
    const id = scope[1]
    const form = forms[id] ?? {}
    const secret = typeof item.value === 'string' ? item.value : ''
    const refuse = (e: unknown) => setErrors((r) => ({ ...r, [id]: errorMessage(e) }))
    try {
      if (action === 'save-home-assistant' && client.setConnectorSettings) {
        const settings = homeAssistantSettings(form.url ?? '', secret)
        void change(id, () => client.setConnectorSettings!(id, settings))
      } else if (action === 'save-librelinkup' && client.setConnectorSettings) {
        const settings = libreLinkUpSettings(form.username ?? '', secret, form.unit ?? '')
        void change(id, () => client.setConnectorSettings!(id, settings))
      } else if (action === 'install' && client.installConnector && typeof item.id === 'string' && typeof value === 'boolean') {
        const mind = item.id
        void change(id, () => client.installConnector!(id, mind, value))
      } else if (action === 'ask-disconnect') setConfirming((s) => new Set([...s, id]))
      else if (action === 'keep') setConfirming((s) => without(s, id))
      else if (action === 'disconnect' && client.disconnectConnector) {
        setConfirming((s) => without(s, id))
        void change(id, () => client.disconnectConnector!(id))
      } else return false
    } catch (e) {
      refuse(e)   // a form the hive would refuse anyway (an address, an email): said on the card, nothing sent
    }
    return true
  }

  const type = (bind: string, value: string, scope?: readonly string[]) => {
    const field = FORM_FIELDS[bind]
    const id = scope?.[0] === 'connectors' ? scope[1] : undefined
    if (!field || !id) return
    setForms((f) => ({ ...f, [id]: { ...f[id], [field]: value } }))
  }

  const input = useMemo<ConnectorsInput | undefined>(
    () => (supported ? { status, error, unsupported: false, work: { forms, confirming, busy, restart, errors } } : undefined),
    [supported, status, error, forms, confirming, busy, restart, errors])
  return { input, act, type }
}
