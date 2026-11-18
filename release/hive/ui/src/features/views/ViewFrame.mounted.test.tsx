// @vitest-environment node
// Purpose: everything a person sees around an HTML view, and where a view opens, is views.metta's, mounted in every look
// the registry offers: the bar with Full screen and Close, who made it and what it reaches, the link and file it asks
// for as alertdialogs and the person's answer, Show it again once it is put away, and the frame closed when it loads a
// second page; the domains it waits on; on a page, opening it, a hive that can't show views and a view that could not be
// opened; under a mind's message, only a view. A new ticket from the page is a new frame, not the view leaving.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { press, reactProps, type MiniNode } from '../../ui/miniDom.testkit'
import { ApiError } from '../../api/client'
import { useHive } from '../../store/store'
import { previewLook } from '../../shell/uiVariant'
import type { HtmlArtifactView } from '../../api/moneyWork'
import { ViewFrame } from './ViewFrame'
import { mountPage, settle, type MountedPage } from './mountedView.testkit'

// the screens space opens once for the file, and every look composes the view's surroundings: allow for a loaded host
vi.setConfig({ testTimeout: 20_000 })
// the frame's context reads computed styles the mini page has none of; what a view is told is views.test.ts's subject
vi.mock('./hostContext', async (actual) => ({ ...(await actual<typeof import('./hostContext')>()), hostContext: () => ({}) }))

const fsName = 'node:fs'
const fs = (await import(/* @vite-ignore */ fsName)) as { readFileSync: (p: string, e: 'utf8') => string }
/** Every look the registry offers, read from its source so a new look is tested too. */
const LOOKS = [...fs.readFileSync(new URL('../../experiences/registry.ts', import.meta.url).pathname, 'utf8').matchAll(/^\s+id: '([a-z]+)',/gm)].map((m) => m[1]).sort()

/** INVENTED mind, ids and domains. */
const ID = `ar_${'7'.repeat(32)}`
const view = (over: Partial<HtmlArtifactView> = {}): HtmlArtifactView => ({
  artifact_id: ID, kind: 'view', title: 'Tip calculator', swarm_id: 's1', mind_id: 'a1', revision: 1,
  digest: `sha256:${'2'.repeat(64)}`, created_at: '2026-11-17T00:00:00Z', carrier: 'view', grant: { ran: true, reach: true },
  resource: { uri: `ui://hive/artifacts/${ID}/r1`, mimeType: 'text/html;profile=mcp-app', _meta: { ui: { csp: { connectDomains: ['https://api.example.com'] }, permissions: {} } } },
  asks: {}, allow: '', refused: ['https://tracker.example.net'], document: '/api/views/tkt-invented', ...over,
})
// what the stand-in hive answers for the view: the view, or a failure; and whether the person's Allow is recorded
let served: HtmlArtifactView | (() => Promise<HtmlArtifactView>)
let allowFails: Error | null = null
let reads = 0
const answers: [string, number, boolean][] = []
const client = {
  artifactView: async () => { reads++; return typeof served === 'function' ? served() : served },
  consentView: async (id: string, revision: number, reach: boolean) => {
    if (allowFails) throw allowFails
    answers.push([id, revision, reach])
    // the hive hands an HTML view whose domains were allowed out again under a new ticket, its CSP widened
    served = { ...(served as HtmlArtifactView), grant: { ran: true, reach: true }, asks: {}, document: '/api/views/tkt-reach-invented' }
    return { ran: true, reach }
  },
  subscribe: () => () => undefined,
}

const g = globalThis as unknown as Record<string, unknown>
let page: MountedPage
let kept: unknown
// what the page hears on its window (the bridge listens there), what the view's window is sent, and the tabs opened
let heard: ((e: unknown) => void)[] = []
let sent: { id?: unknown; result?: unknown; error?: unknown }[] = []
let opened: unknown[][] = []
const frameWindow = { postMessage: (m: { id?: unknown }) => { sent.push(m) } }

beforeEach(async () => {
  page = await mountPage()
  kept = g.ResizeObserver
  g.ResizeObserver = class { observe() {} disconnect() {} }
  heard = []
  sent = []
  opened = []
  answers.length = 0
  reads = 0
  allowFails = null
  served = view()
  Object.assign(g.window as object, {
    innerWidth: 1280, innerHeight: 800,
    addEventListener: (type: string, fn: (e: unknown) => void) => { if (type === 'message') heard.push(fn) },
    removeEventListener: (type: string, fn: (e: unknown) => void) => { if (type === 'message') heard = heard.filter((f) => f !== fn) },
    open: (...args: unknown[]) => { opened.push(args); return null },
  })
  useHive.setState({ client: client as never, agents: { a1: { id: 'a1', name: 'Wren' } } as never })
})
afterEach(async () => {
  await page.restore()
  g.ResizeObserver = kept
  previewLook(null)
  useHive.setState({ client: null as never, agents: {} as never })
})

const text = () => page.container.textContent
const frames = () => page.container.findAll((n) => n.tagName === 'IFRAME')
const dialog = () => page.container.findAll((n) => n.tagName === 'DIALOG')[0]
const byRole = (role: string) => page.container.findAll((n) => n.nodeType === 1 && n.getAttribute('role') === role)
const byId = (id: string | null) => page.container.findAll((n) => n.nodeType === 1 && id !== null && n.getAttribute('id') === id)[0]
const button = (name: string, within: MiniNode = page.container) => {
  const [b] = within.findAll((n) => n.tagName === 'BUTTON' && n.textContent === name)
  if (!b) throw new Error(`no button ${name} in: ${within.textContent}`)
  return b
}
const tap = async (b: MiniNode) => { await act(async () => { press(b) }); await settle() }
// the frame's own load event, as the browser fires it on the element
const load = async (frame: MiniNode) => { await act(async () => { (reactProps(frame).onLoad as (e: unknown) => void)({ currentTarget: frame, target: frame }) }) }
/** The view where it is placed, once the hive's answer is in. */
async function placed(place: 'page' | 'chat' = 'page') {
  await act(async () => page.root.render(<ViewFrame artifactId={ID} place={place} />))
  await settle()
}
/** The running view's frame, given the window its document would have, and focused as the person's click leaves it. */
async function drawnFrame(): Promise<MiniNode> {
  await placed()
  const [frame] = frames()
  if (!frame) throw new Error(`no frame in: ${text()}`)
  Object.assign(frame, { contentWindow: frameWindow })
  frame.focus()
  await load(frame)
  return frame
}
/** A message from the view's own frame, as the bridge receives it on the page's window. */
const fromView = async (data: unknown) => { await act(async () => { for (const f of heard) f({ source: frameWindow, data }) }); await settle() }

describe('everything around an HTML view is views.metta’s, mounted in every look', () => {
  it('reads every look from the registry', () => {
    expect(LOOKS.length).toBeGreaterThan(5)
    expect(LOOKS).toContain('classic')
  })

  it.each(LOOKS)('%s: its bar, who made it and what it reaches, the link and the file it asks for, put away and left', async (look) => {
    previewLook({ experience: look } as never)
    const frame = await drawnFrame()
    // the bar names the view's dialog and its frame by the title MeTTa placed in it
    const titled = dialog().getAttribute('aria-labelledby')
    expect(byId(titled)?.textContent).toBe('Tip calculator')
    expect(frame.getAttribute('aria-labelledby')).toBe(titled)
    expect(text()).toContain('View made by Wren. It runs on its own and cannot see your hive.')
    expect(text()).toContain('It reaches https://api.example.com.')
    expect(text()).toContain('Not allowed: https://tracker.example.net.')

    // Full screen becomes Close on the same button, so the person's focus stays on it; full screen gives the view the
    // whole screen, without the notes under it
    const full = button('Full screen', dialog())
    await tap(full)
    expect(dialog().getAttribute('data-view-mode')).toBe('fullscreen')
    expect(button('Close', dialog())).toBe(full)
    expect(text()).not.toContain('View made by')
    await tap(full)
    expect(dialog().getAttribute('data-view-mode')).toBe('inline')
    expect(button('Full screen', dialog())).toBe(full)
    expect(text()).toContain('View made by Wren.')

    // a link: an alertdialog says where it goes, and the person opens it themselves, in a tab apart from the hive
    await fromView({ jsonrpc: '2.0', id: 1, method: 'ui/open-link', params: { url: 'https://example.org/recipe' } })
    const [link] = byRole('alertdialog')
    expect(link.getAttribute('aria-label')).toBe('Open a link from the view')
    expect(byId(link.getAttribute('aria-describedby'))?.textContent).toBe('This view wants to open https://example.org/recipe.')
    await tap(button('Open', link))
    expect(opened).toEqual([['https://example.org/recipe', '_blank', 'noopener,noreferrer']])
    expect(sent.find((m) => m.id === 1)).toMatchObject({ result: {} })
    expect(byRole('alertdialog')).toHaveLength(0)

    // a file: saved only on the person's Save; Cancel tells the view no
    await fromView({ jsonrpc: '2.0', id: 2, method: 'ui/download-file', params: { contents: [{ type: 'resource', resource: { uri: 'file:///split.csv', mimeType: 'text/csv', text: 'a,b' } }] } })
    const [file] = byRole('alertdialog')
    expect(file.getAttribute('aria-label')).toBe('Save a file from the view')
    expect(byId(file.getAttribute('aria-describedby'))?.textContent).toBe('Save split.csv (3 bytes) from this view?')
    await tap(button('Cancel', file))
    expect(sent.find((m) => m.id === 2)).toMatchObject({ error: { message: 'Download denied by user' } })
    expect(byRole('alertdialog')).toHaveLength(0)

    // put away at the view's own request, and shown again only when the person asks
    await fromView({ jsonrpc: '2.0', method: 'ui/notifications/request-teardown' })
    expect(frames()).toHaveLength(0)
    expect(text()).not.toContain('View made by')
    expect(text()).not.toContain('Full screen')
    await tap(button('Show Tip calculator again'))
    const shownAgain = frames()[0]
    expect(shownAgain).toBeTruthy()

    // a second load is the view going somewhere else: the frame is closed and MeTTa says so in its place
    await load(shownAgain)
    await load(shownAgain)
    await settle()
    expect(frames()).toHaveLength(0)
    expect(text()).toContain('Tip calculator tried to open another page in its place, so it was closed.')
    await tap(button('Show Tip calculator again'))
    const again = frames()[0]
    expect(again).not.toBe(shownAgain)
    await load(again)   // a frame shown again counts its own loads
    expect(frames()).toHaveLength(1)
    expect(text()).not.toContain('tried to open another page')
  })
})

describe('the domains an HTML view waits on', () => {
  const waiting = () => view({ grant: { ran: true, reach: false }, asks: { connectDomains: ['https://api.example.com'] } })

  it('takes the new document the page loads once its domains are allowed as a new frame, never as the view leaving', async () => {
    served = waiting()
    const first = await drawnFrame()
    expect(text()).toContain("This view asks to reach https://api.example.com. It can't load anything from there until you allow that for this version.")
    await tap(button('Allow for this version'))
    expect(answers).toEqual([[ID, 1, true]])
    const [granted] = frames()
    expect(granted).not.toBe(first)
    expect(granted.getAttribute('src')).toBe('/api/views/tkt-reach-invented')
    await load(granted)
    expect(frames()).toHaveLength(1)
    expect(text()).not.toContain('tried to open another page')
    expect(text()).not.toContain('This view asks to reach')
  })

  it('says when the Allow could not be recorded, and leaves the prompt out of full screen', async () => {
    served = waiting()
    allowFails = new Error('the hive is restarting')
    await drawnFrame()
    await tap(button('Allow for this version'))
    expect(answers).toEqual([])
    expect(text()).toContain('Could not allow it: the hive is restarting')
    await tap(button('Full screen', dialog()))
    expect(text()).not.toContain('This view asks to reach')
    expect(text()).not.toContain('Could not allow it')
  })

  it('names a mind the person cannot see as a mind', async () => {
    useHive.setState({ agents: {} as never })
    await drawnFrame()
    expect(text()).toContain('View made by a mind. It runs on its own and cannot see your hive.')
  })
})

describe('where a view opens', () => {
  it('on a page: opening it, a hive that cannot show views, and a view that could not be opened, with Try again', async () => {
    let finish: (v: HtmlArtifactView) => void = () => undefined
    served = () => new Promise((resolve) => { finish = resolve })
    await placed()
    expect(byRole('status').map((n) => n.getAttribute('aria-label'))).toContain('Opening the view')
    await act(async () => { finish(view()) })
    await settle()
    expect(frames()).toHaveLength(1)

    // each state below is another revision, which the page reads afresh
    const at = async (revision: number) => { await act(async () => page.root.render(<ViewFrame artifactId={ID} revision={revision} place="page" />)); await settle() }
    useHive.setState({ client: { subscribe: () => () => undefined } as never })
    await at(5)
    expect(text()).toBe("This hive can't show views here. Ask the mind that made it to send you the text.")

    useHive.setState({ client: client as never })
    served = () => Promise.reject(new ApiError(404, 'not_found', 'no such artifact'))
    await at(2)
    expect(text()).toContain('Could not open the view: it is no longer here, or not shown to you.')
    served = () => Promise.reject(new ApiError(500, 'internal', 'The hive is restarting.'))
    const before = reads
    await tap(button('Try again'))
    expect(reads).toBe(before + 1)
    expect(text()).toContain('Could not open the view: The hive is restarting.')
    expect(text()).not.toContain('no longer here')
  })

  it('under a mind’s message: only a view, once it is in hand; a plan’s page or a view it cannot open leaves the message as it is', async () => {
    served = view({ carrier: 'document' })
    await placed('chat')
    expect(text()).toBe('')
    expect(frames()).toHaveLength(0)

    served = () => Promise.reject(new ApiError(404, 'not_found', 'no such artifact'))
    await act(async () => page.root.render(<ViewFrame artifactId={ID} revision={3} place="chat" />))
    await settle()
    expect(text()).toBe('')

    served = view()
    await act(async () => page.root.render(<ViewFrame artifactId={ID} revision={4} place="chat" />))
    await settle()
    expect(frames()).toHaveLength(1)
  })
})
