// Purpose: test the reader of the person's connectors answer (api/connectors.ts): it keeps only safe fields, refuses a
// malformed answer whole, and the settings bodies it builds.
import { describe, expect, it } from 'vitest'
import { homeAssistantSettings, libreLinkUpSettings, readConnectorChange, readConnectors } from './connectors'

const row = (over: Record<string, unknown> = {}) => ({ id: 'home_assistant', module: 'home_assistant', kind: 'calls', exclusive: false,
  set: true, fields: ['token', 'url'], minds: ['a_wren'], ...over })
const answer = (over: Record<string, unknown> = {}) => ({
  store: { open: true, home: 'keychain' }, connectors: [row()], minds: [{ id: 'a_wren', name: 'Wren', running: true }], ...over,
})

describe('the connectors answer', () => {
  it('keeps the store, each connector and the minds, and nothing a secret could ride in', () => {
    const read = readConnectors({ ...answer(), token: 'never', connectors: [{ ...row(), token: 'ha-secret' }] })
    expect(read).toEqual({ store: { open: true, home: 'keychain', made: true, warning: null, reason: null },
      connectors: [{ id: 'home_assistant', kind: 'calls', exclusive: false, set: true, fields: ['token', 'url'], minds: ['a_wren'] }],
      minds: [{ id: 'a_wren', name: 'Wren', running: true }] })
    expect(JSON.stringify(read)).not.toContain('secret')
  })

  it('refuses an answer in any other shape, whole', () => {
    for (const bad of [null, [], answer({ store: { open: 'yes' } }), answer({ store: { open: true, home: 'drawer' } }),
      answer({ connectors: [row({ id: 'telegram' })] }), answer({ connectors: [row({ fields: ['Token Value'] })] }),
      answer({ connectors: [row({ minds: ['../a'] })] }), answer({ minds: [{ id: 'a_wren' }] })]) {
      expect(readConnectors(bad)).toBeNull()
    }
  })

  it('reads a change with the minds to restart, and a store that has made no key yet', () => {
    expect(readConnectorChange({ ...row({ id: 'whatsapp', kind: 'served', exclusive: true }), restart: ['a_wren'] }))
      .toEqual({ row: { id: 'whatsapp', kind: 'served', exclusive: true, set: true, fields: ['token', 'url'], minds: ['a_wren'] },
        restart: ['a_wren'] })
    expect(readConnectors(answer({ store: { open: true, home: 'systemd-creds', made: false } }))?.store.made).toBe(false)
  })

  it('builds the settings a person enters, and refuses one the hive would refuse', () => {
    expect(homeAssistantSettings(' http://ha.local:8123 ', ' tok ')).toEqual({ url: 'http://ha.local:8123', token: 'tok' })
    expect(() => homeAssistantSettings('ha.local', 'tok')).toThrow()
    expect(libreLinkUpSettings('wren@example.org', 'pw', 'mg/dL')).toEqual({ username: 'wren@example.org', password: 'pw', unit: 'mg/dL' })
    expect(libreLinkUpSettings('wren@example.org', 'pw', '')).toEqual({ username: 'wren@example.org', password: 'pw' })
    expect(() => libreLinkUpSettings('', 'pw', '')).toThrow()
  })
})
