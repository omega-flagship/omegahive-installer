// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import type { ProgramAction } from '../../api/types'
import { declaredInput } from '../../store/programSession'
import { MiniDocument, press, reactProps, type MiniNode } from '../../ui/miniDom.testkit'
import { ActionForm, AppActions } from './ActionForm'

vi.setConfig({ testTimeout: 20_000 })

/**
 * The form for an action's inputs, mounted: a person fills in omega-connect's add-server on an app page with nothing
 * selected (its declaration as the app would give it) and sends it; the composed fields hand back each value, and Send
 * carries them in the types the app declared. A choice is drawn as a <select>, which this test DOM can't hold (react-dom
 * updates a select's options on mount), so actForm.test.ts draws the choices and this one types, ticks and sends.
 */
const ADD_SERVER: ProgramAction = {
  id: 'add-server', label: 'Add a server', applies_to: [], confirm: true,
  params: {
    name: { type: 'string', title: 'Name' },
    signin_kind: { type: 'string', title: 'Sign-in', default: 'none' },
    timeout: { type: 'integer', title: 'Timeout (seconds)', minimum: 1, maximum: 600 },
    allow_stdio: { type: 'boolean', title: 'Start it on this machine' },
  },
}

let container: MiniNode, root: Root
let saved: Record<string, unknown>
beforeEach(async () => {
  const g = globalThis as unknown as Record<string, unknown>
  saved = {}
  for (const key of ['window', 'document', 'HTMLIFrameElement', 'IS_REACT_ACT_ENVIRONMENT']) saved[key] = g[key]
  const doc = new MiniDocument()
  const win = { document: doc, HTMLIFrameElement: class {}, addEventListener: () => undefined, removeEventListener: () => undefined, location: { hash: '', search: '', pathname: '/' },
    matchMedia: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }) }
  doc.defaultView = win; g.window = win; g.document = doc; g.HTMLIFrameElement = win.HTMLIFrameElement; g.IS_REACT_ACT_ENVIRONMENT = true
  container = doc.createElement('div'); doc.body.appendChild(container)
  const { createRoot } = await import('react-dom/client')
  root = createRoot(container as unknown as Element)
})
afterEach(async () => {
  await act(async () => root.unmount())
  for (const [k, v] of Object.entries(saved)) (globalThis as Record<string, unknown>)[k] = v
})

const change = async (n: MiniNode, value: unknown) => act(async () => { (reactProps(n).onChange as (e: unknown) => void)({ target: { value, checked: value } }) })
const button = (label: string) => container.findAll((n) => n.tagName === 'BUTTON' && n.textContent === label)[0]

describe('the action form, mounted', () => {
  it('a person fills in add-server and sends it: each value in the type the app declared, a blank field left out', async () => {
    const onSend = vi.fn(), onCancel = vi.fn()
    await act(async () => root.render(<ActionForm input={declaredInput(ADD_SERVER, [])} def={ADD_SERVER} busy={false} onSend={onSend} onCancel={onCancel} />))
    const inputs = container.findAll((n) => n.tagName === 'INPUT')
    const texts = inputs.filter((n) => reactProps(n).type === 'text')
    const [name, signin, timeout, stdio] = [texts[0], texts[1], inputs.find((n) => reactProps(n).type === 'number')!, inputs.find((n) => reactProps(n).type === 'checkbox')!]
    // the declared default is filled in
    expect(reactProps(signin).value).toBe('none')
    await change(name, 'teams')
    await change(signin, 'oauth-device')
    await change(timeout, '45')
    await act(async () => { (reactProps(stdio).onChange as (e: unknown) => void)({ target: { checked: true } }) })
    await act(async () => { press(button('Send')) })
    expect(onSend).toHaveBeenCalledWith({ name: 'teams', signin_kind: 'oauth-device', timeout: 45, allow_stdio: true })
    // Enter in a field submits the form, which sends nothing: only the Send button runs an action
    await act(async () => { (reactProps(container.findAll((n) => n.tagName === 'FORM')[0]).onSubmit as (e: unknown) => void)({ preventDefault: () => undefined }) })
    expect(onSend).toHaveBeenCalledTimes(1)
    await act(async () => { press(button('Cancel')) })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
  it('while the action runs, its buttons wait', async () => {
    const onSend = vi.fn()
    await act(async () => root.render(<ActionForm input={declaredInput(ADD_SERVER, [])} def={ADD_SERVER} busy onSend={onSend} onCancel={() => undefined} />))
    expect(reactProps(button('Send')).disabled).toBe(true)
    expect(reactProps(button('Cancel')).disabled).toBe(true)
  })
})

describe('the actions that need no item, mounted', () => {
  it('pressing a row runs that action', async () => {
    const onAct = vi.fn()
    await act(async () => root.render(<AppActions actions={[ADD_SERVER, { id: 'list-servers', label: 'List servers' }]} onAct={onAct} />))
    const rows = container.findAll((n) => n.tagName === 'BUTTON')
    expect(rows.map((n) => n.textContent)).toEqual(['Add a serverAsks for Name, Sign-in, Timeout (seconds), Start it on this machine', 'List servers'])
    await act(async () => { press(rows[0]) })
    expect(onAct).toHaveBeenCalledWith(ADD_SERVER)
  })
  it('no such action draws nothing', async () => {
    await act(async () => root.render(<AppActions actions={[]} onAct={() => undefined} />))
    expect(container.textContent).toBe('')
  })
})
