// Purpose: a mounted test of DecisionDialog's decisions that are off: every one says why (each reason once, labelled
// only when the decisions wait on different things), and a press on one focuses the field it is missing and decides
// nothing. INVENTED DATA only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, createRef, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { MiniDocument, MiniNode, reactProps } from './miniDom.testkit'

vi.mock('../lib/hooks', async (orig) => ({ ...(await orig<typeof import('../lib/hooks')>()), useEscape: () => undefined, useIsDesktop: () => true, useReducedMotion: () => true }))
vi.mock('./useModalContainment', () => ({ useModalContainment: () => undefined }))

const { DecisionDialog, blockedLines } = await import('./DecisionDialog')
type Action = Parameters<typeof DecisionDialog>[0]['actions'][number]

let doc: MiniDocument
let container: MiniNode
let root: Root | null

beforeEach(async () => {
  doc = new MiniDocument()
  const win = { document: doc, location: { hash: '#/', pathname: '/', search: '' }, HTMLElement: MiniNode, HTMLIFrameElement: class {}, Node: MiniNode,
    navigator: { userAgent: 'mini-dom-decision-dialog' }, addEventListener: () => undefined, removeEventListener: () => undefined }
  doc.defaultView = win
  vi.stubGlobal('window', win)
  vi.stubGlobal('document', doc)
  vi.stubGlobal('navigator', win.navigator)
  vi.stubGlobal('HTMLElement', MiniNode)
  vi.stubGlobal('HTMLIFrameElement', win.HTMLIFrameElement)
  vi.stubGlobal('Node', MiniNode)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = doc.body.appendChild(doc.createElement('div'))
  const { createRoot } = await import('react-dom/client')
  root = createRoot(container as unknown as HTMLElement)
})
afterEach(async () => {
  if (root) await act(async () => { root!.unmount() })
  root = null
  vi.unstubAllGlobals()
})

const amount = createRef<HTMLInputElement>()
const reason = createRef<HTMLTextAreaElement>()
const inputs: ReactNode = [createElement('input', { key: 'a', name: 'amount', ref: amount }), createElement('textarea', { key: 'r', name: 'reason', ref: reason })]

async function mount(actions: Action[]) {
  await act(async () => {
    root!.render(createElement(DecisionDialog, { eyebrow: 'A money decision', title: 'Correct the $0.05 estimate?', facts: [['Estimated', '$0.05']], bound: { kind: 'ready' }, thing: 'This estimate', onClose: () => undefined, actions, fields: { amount, reason }, children: inputs }))
  })
}
const status = () => doc.body.findAll((n) => n.getAttribute('role') === 'status')[0]
const lines = () => status().findAll((n) => n.tagName === 'P').map((n) => n.textContent)
const button = (label: string) => doc.body.findAll((n) => n.tagName === 'BUTTON' && n.textContent === label)[0]
const press = async (label: string) => {
  await act(async () => { await (reactProps(button(label)).onClick as (e: unknown) => Promise<void>)({ stopPropagation: () => undefined }) })
}

describe('a decision that is off says why, and a press on it goes to what it is missing', () => {
  it('names each decision with its own reason when they wait on different things, and decides nothing on a press', async () => {
    const correct = vi.fn(async () => true as const)
    const release = vi.fn(async () => true as const)
    await mount([
      { label: 'Correct to the billed cost', tone: 'primary', blocked: { why: 'Enter the billed cost from the provider’s billing.', field: 'amount' }, run: correct },
      { label: 'Nothing was billed', tone: 'plain', blocked: { why: 'Give a reason, recorded with the correction.', field: 'reason' }, run: release },
    ])
    expect(lines()).toEqual(['Correct to the billed cost: Enter the billed cost from the provider’s billing.', 'Nothing was billed: Give a reason, recorded with the correction.'])
    expect(button('Correct to the billed cost').getAttribute('aria-disabled')).toBe('true')
    expect(button('Nothing was billed').getAttribute('aria-disabled')).toBe('true')
    await press('Nothing was billed')
    expect(doc.activeElement).toBe(reason.current)
    await press('Correct to the billed cost')
    expect(doc.activeElement).toBe(amount.current)
    expect(correct).not.toHaveBeenCalled()
    expect(release).not.toHaveBeenCalled()
  })

  it('says a reason every decision shares once, unlabelled, and nothing once each has what it needs', async () => {
    const both = { why: 'Give a reason, recorded with each call.', field: 'reason' }
    await mount([
      { label: 'Release all $0.10', tone: 'primary', blocked: both, run: vi.fn(async () => true as const) },
      { label: 'Keep all at $0.10', tone: 'plain', blocked: both, run: vi.fn(async () => true as const) },
    ])
    expect(lines()).toEqual(['Give a reason, recorded with each call.'])
    await mount([
      { label: 'Release all $0.10', tone: 'primary', blocked: null, run: vi.fn(async () => true as const) },
      { label: 'Keep all at $0.10', tone: 'plain', blocked: null, run: vi.fn(async () => true as const) },
    ])
    expect(lines()).toEqual([])
    expect(button('Release all $0.10').getAttribute('aria-disabled')).toBe('false')
  })

  it('keeps a plain reason with no field as words alone', () => {
    const run = vi.fn(async () => true as const)
    expect(blockedLines([{ label: 'Give access', tone: 'primary', blocked: 'Choose a person.', run }])).toEqual(['Choose a person.'])
    expect(blockedLines([{ label: 'Give access', tone: 'primary', blocked: null, run }])).toEqual([])
  })
})
