import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ProgramAction } from '../../api/types'
import { Screen } from '../../screens/Screen'
import { ScreensSpace, type ScreenFacts, type ScreenPlan } from '../../screens/screenSpace'
import { declaredInput, type PendingInput } from '../../store/programSession'
import { actForm, appActions, fieldOf, formFields, sentParams, startValues, ticked, type Values } from './actForm'

vi.setConfig({ testTimeout: 20_000 })

/**
 * An app's actions on its graph, end to end: what an action declares → the fields and their values → MeTTa composes the
 * form (program-act, one program-act-field each) and the actions that need no item (program-actions) → drawn. The worked
 * examples are omega-connect's add-server, which needs no item, and connect, which a person signs in with by browser.
 */
const space = ScreensSpace.open()
const seen = new Map<string, Set<number>>()
const compose = (screen: string, facts: ScreenFacts): ScreenPlan => {
  const plan = space.compose(screen, 'classic', facts)
  const orders = seen.get(screen) ?? new Set<number>()
  for (const p of plan.parts) orders.add(p.order)
  seen.set(screen, orders)
  return plan
}
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim()
const draw = (plan: ScreenPlan, data: Record<string, unknown>) => renderToStaticMarkup(createElement(Screen, { plan, host: { data, onOpen: () => undefined, onAction: () => undefined } }))

const ADD_SERVER: ProgramAction = {
  id: 'add-server', label: 'Add a server', applies_to: [], confirm: true,
  params: {
    name: { type: 'string', title: 'Name', description: 'lowercase letters, digits, - or _' },
    url: { type: 'string', title: 'Address', description: 'https://, or http:// on this machine' },
    signin_kind: { type: 'string', title: 'Sign-in', oneOf: [{ const: 'none', title: 'None' }, { const: 'oauth-device', title: 'Microsoft sign-in' }], default: 'none' },
    timeout: { type: 'integer', title: 'Timeout (seconds)', minimum: 1, maximum: 600 },
  },
}
const CONNECT: ProgramAction = {
  id: 'connect', label: 'Sign in to this server', applies_to: ['server'], confirm: true,
  params: { flow: { type: 'string', title: 'How', oneOf: [{ const: 'device', title: 'A code to enter' }, { const: 'browser', title: 'Sign in in this browser' }], default: 'device' } },
}
const formOf = (input: PendingInput, def: ProgramAction | undefined, values?: Values) => {
  const fields = formFields(input, def)
  return { fields, ...actForm(input, def, fields, values ?? startValues(input, fields), compose) }
}

describe('a declared input, as a field', () => {
  it('0.1’s words are a text field, the words its help', () => {
    expect(fieldOf('text', 'the corrected wording', 'the corrected wording')).toMatchObject({ kind: 'text', label: 'text', help: 'the corrected wording' })
    expect(fieldOf('note', undefined, 'note')).toMatchObject({ kind: 'text', label: 'note', help: '' })
  })
  it('MCP form shapes: a string, a titled or plain choice, a number or integer, a yes or no, several choices', () => {
    expect(fieldOf('name', { type: 'string', title: 'Name', default: 'teams' }, 'what to call it')).toMatchObject({ kind: 'text', label: 'Name', help: 'what to call it', start: 'teams' })
    expect(fieldOf('flow', CONNECT.params!.flow, '')).toMatchObject({ kind: 'choice', label: 'How', start: 'device',
      choices: [{ id: 'device', label: 'A code to enter' }, { id: 'browser', label: 'Sign in in this browser' }] })
    expect(fieldOf('size', { type: 'string', enum: ['s', 'm'] }, '').choices).toEqual([{ id: 's', label: 's' }, { id: 'm', label: 'm' }])
    expect(fieldOf('t', { type: 'integer', minimum: 1, maximum: 600, default: 30 }, '')).toMatchObject({ kind: 'number', integer: true, least: 1, most: 600, start: '30' })
    expect(fieldOf('w', { type: 'number' }, '')).toMatchObject({ kind: 'number', integer: false })
    expect(fieldOf('stdio', { type: 'boolean', title: 'Allow stdio', default: false }, '')).toMatchObject({ kind: 'ticks', many: false, start: false, choices: [{ id: 'stdio', label: 'Yes' }] })
    expect(fieldOf('scopes', { type: 'array', items: { anyOf: [{ const: 'Mail.Read', title: 'Read mail' }, { const: 'Chat.Read' }] }, default: ['Chat.Read', 'Nope'] }, ''))
      .toMatchObject({ kind: 'ticks', many: true, start: ['Chat.Read'], choices: [{ id: 'Mail.Read', label: 'Read mail' }, { id: 'Chat.Read', label: 'Chat.Read' }] })
    expect(fieldOf('tags', { type: 'array', items: { enum: ['a'] } }, '').choices).toEqual([{ id: 'a', label: 'a' }])
  })
  it('a shape the page does not draw takes words, and the app checks them; a default of the wrong kind is not filled in', () => {
    expect(fieldOf('x', { type: 'string', oneOf: [{ title: 'no value' } as never, { const: 3 } as never] }, '').kind).toBe('text')
    expect(fieldOf('x', { type: 'array' }, '').kind).toBe('text')
    expect(fieldOf('x', { type: 'object' } as never, '').kind).toBe('text')
    expect(fieldOf('x', { type: 'string', enum: ['a'], default: 'b' }, '').start).toBeUndefined()
    expect(fieldOf('x', { type: 'integer', default: 'ten' } as never, '').start).toBeUndefined()
  })
})

describe('what a Send carries', () => {
  const asked = (over: Partial<PendingInput> = {}): PendingInput => ({ ...declaredInput(ADD_SERVER, []), ...over })
  it('starts from the defaults, or from what was sent before when the app asks again', () => {
    expect(startValues(asked(), formFields(asked(), ADD_SERVER))).toEqual({ signin_kind: 'none' })
    const again = asked({ params: { name: 'teams', timeout: 45, signin_kind: 'oauth-device' }, asked: true })
    expect(startValues(again, formFields(again, ADD_SERVER))).toEqual({ name: 'teams', timeout: '45', signin_kind: 'oauth-device' })
  })
  it('each value in its declared type; a blank field, or a number that is not one, left out', () => {
    const input = asked()
    const fields = formFields(input, ADD_SERVER)
    expect(sentParams(input, fields, { name: 'teams', url: '  ', signin_kind: 'oauth-device', timeout: '45' })).toEqual({ name: 'teams', signin_kind: 'oauth-device', timeout: 45 })
    expect(sentParams(input, fields, { name: '', timeout: 'soon' })).toEqual({})
  })
  it('keeps what was sent before, and a field cleared now is no longer sent', () => {
    const input = asked({ params: { name: 'teams', note: 'kept' }, asked: true })
    expect(sentParams(input, formFields(input, ADD_SERVER), { name: '' })).toEqual({ note: 'kept' })
  })
  it('ticks: a yes or no is true or false; several choices are a list in the declared order', () => {
    const def: ProgramAction = { id: 'x', params: { stdio: { type: 'boolean' }, scopes: { type: 'array', items: { enum: ['a', 'b', 'c'] } } } }
    const input = declaredInput(def, [])
    const [stdio, scopes] = formFields(input, def)
    let v: Values = {}
    v = ticked(v, stdio, 'stdio', true)
    v = ticked(ticked(ticked(v, scopes, 'c', true), scopes, 'a', true), scopes, 'b', true)
    v = ticked(v, scopes, 'b', false)
    expect(v).toEqual({ stdio: true, scopes: ['a', 'c'] })
    expect(sentParams(input, [stdio, scopes], v)).toEqual({ stdio: true, scopes: ['a', 'c'] })
    expect(sentParams(input, [stdio, scopes], ticked(v, stdio, 'stdio', false))).toMatchObject({ stdio: false })
  })
})

describe('the form, composed', () => {
  it('asked first: the action’s name and what it takes, one field per input, Send and Cancel', () => {
    const { plan, data } = formOf(declaredInput(ADD_SERVER, []), ADD_SERVER)
    expect(plan.parts.map((p) => p.order)).toEqual([10, 40, 50])
    const words = text(draw(plan, data))
    expect(words).toContain('Add a server Fill in what it takes. A blank field is left out.')
    for (const label of ['Name', 'Address', 'Sign-in', 'Timeout (seconds)', 'lowercase letters, digits, - or _', 'Send', 'Cancel']) expect(words).toContain(label)
    const fields = data['act.fields'] as { id: string; plan: ScreenPlan }[]
    expect(fields.map((f) => [f.id, f.plan.parts.map((p) => p.order)])).toEqual([['name', [10, 20]], ['url', [10, 20]], ['signin_kind', [12]], ['timeout', [11]]])
  })
  it('connect: the choice of how to sign in, the device code chosen until the person picks the browser', () => {
    const { plan, data } = formOf(declaredInput(CONNECT, ['s-teams']), CONNECT)
    const html = draw(plan, data)
    // the declared default is the chosen option; the browser is the other choice
    expect(html).toContain('<option value="device" selected="">A code to enter</option>')
    expect(html).toContain('<option value="browser">Sign in in this browser</option>')
    expect(sentParams(declaredInput(CONNECT, ['s-teams']), formFields(declaredInput(CONNECT, ['s-teams']), CONNECT), { flow: 'browser' })).toEqual({ flow: 'browser' })
  })
  it('the app asked for more: its words over the field it asked for, the items it wants to be selected', () => {
    const input: PendingInput = { action: 'connect', items: ['s-teams'], needs: { redirect_url: 'the whole address your browser lands on after you sign in' },
      message: 'Open https://login.example/authorize and sign in.', params: { flow: 'browser' }, asked: true }
    const { plan, data } = formOf(input, CONNECT)
    expect(plan.parts.map((p) => p.order)).toEqual([11, 20, 40, 50])
    const words = text(draw(plan, data))
    expect(words).toContain('Sign in to this server: the app needs more Fill it in and send it again.')
    expect(words).toContain('Open https://login.example/authorize and sign in.')
    expect(words).toContain('the whole address your browser lands on after you sign in')
    const items: PendingInput = { action: 'compare', items: [], needs: { items: 'two or more beliefs' }, asked: true, params: {} }
    const only = formOf(items, undefined)
    expect(only.plan.parts.map((p) => p.order)).toEqual([11, 30, 51])
    expect(text(draw(only.plan, only.data))).toContain('It needs two or more beliefs. Select them on the stage')
  })
  it('each field kind draws its own control', () => {
    const def: ProgramAction = { id: 'x', params: { a: 'words', b: { type: 'number' }, c: { type: 'string', enum: ['p'] }, d: { type: 'boolean' } } }
    const { data } = formOf(declaredInput(def, []), def)
    const fields = data['act.fields'] as { id: string; plan: ScreenPlan; data: Record<string, unknown> }[]
    expect(fields.map((f) => f.plan.parts.map((p) => p.order))).toEqual([[10, 20], [11], [12], [13]])
    const html = fields.map((f) => draw(f.plan, f.data)).join('')
    expect(html).toContain('type="number"')
    expect(html).toContain('type="checkbox"')
    expect(html).toContain('<select')
  })
})

describe('the actions that need no item, composed', () => {
  it('one row each, saying what it asks for; none at all draws nothing', () => {
    const { plan, data } = appActions([ADD_SERVER, { id: 'list-servers', label: 'List servers' }], compose)
    expect(plan.parts.map((p) => p.order)).toEqual([10, 11])
    expect(text(draw(plan, data))).toBe('In this app Add a server Asks for Name, Address, Sign-in, Timeout (seconds) List servers')
    expect(appActions([], compose).plan.parts).toEqual([])
  })
})

describe('the action screens', () => {
  it('every part of each can be reached, and the guards stay clean', () => {
    for (const screen of ['program-actions', 'program-act', 'program-act-field']) {
      const missing = space.orders(screen).filter((o) => !seen.get(screen)?.has(o))
      expect(missing, screen).toEqual([])
    }
    for (const [name, list] of Object.entries(space.guards())) expect(list, name).toEqual([])
  })
})
