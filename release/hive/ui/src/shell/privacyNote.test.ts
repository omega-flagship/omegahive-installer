import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import appSource from '../App.tsx?raw'

/**
 * T-210: per-person privacy is intended but not yet in place (#595 parked), so a signed-in person is told once per
 * store session (once per page load and sign-in) that other members and admins may see their tasks and app data.
 * The note renders in the shared notices, never on a simulator, never before sign-in. INVENTED data only.
 */
vi.stubGlobal('window', { location: { hash: '#/', search: '', pathname: '/' }, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), addEventListener() {}, removeEventListener() {}, innerWidth: 1440, innerHeight: 900, localStorage: { getItem: () => null, setItem() {}, removeItem() {} } })
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined })
const { useHive } = await import('../store/store')
const note = await import('./privacyNote')

type Who = { kind?: 'password' | 'sso' | 'member_password'; role?: 'admin' | 'member' | null; id?: string | null }
type Body = { id: string; disabled?: boolean }
/** A client whose `me` and `listPeople` answer as given; the default is a hive with an admin (me) and one member. */
function client(mode: 'live' | 'sim', who: Who = {}, people: Body[] | Error = [{ id: 'p-admin' }, { id: 'p-member' }]) {
  const id = who.id === undefined ? 'p-admin' : who.id
  return {
    mode,
    me: vi.fn(async () => ({ principal: 'user:x', kind: who.kind ?? 'sso', role: who.role === undefined ? 'admin' : who.role, expires_at: null, person: id ? { id, email: null, name: 'X' } : null })),
    listPeople: vi.fn(async () => {
      if (people instanceof Error) throw people
      return { people: people.map((p) => ({ disabled: false, ...p })), invites: [], google_ready: false }
    }),
  }
}
function hive(mode: 'live' | 'sim' | null, session = 'session-a', ready = true, c: unknown = mode ? client(mode) : null) {
  useHive.setState({ toasts: [], ready, session, client: c as never })
  return c as ReturnType<typeof client>
}
const titles = () => useHive.getState().toasts.map((t) => t.title)

afterEach(() => {
  note.resetPrivacyNote()
  useHive.setState({ toasts: [], client: null, ready: false })
})

describe('the privacy note: per-person privacy is not in place yet', () => {
  it('renders in the notices for a signed-in person on a live hive, with what may be seen and by whom', async () => {
    hive('live')
    expect(await note.announcePrivacyNote(true)).toBe(true)
    // mounted with react-dom on ui/miniDom.testkit, so the store subscription is the real one (a server render reads
    // the store's initial state and shows no notice)
    const { MiniDocument } = await import('../ui/miniDom.testkit')
    const doc = new MiniDocument()
    const g = globalThis as Record<string, unknown>
    const win = g.window as Record<string, unknown>
    win.document = doc
    doc.defaultView = win as never
    g.document = doc
    win.HTMLIFrameElement = class {}
    g.HTMLIFrameElement = win.HTMLIFrameElement
    g.IS_REACT_ACT_ENVIRONMENT = true
    const { act } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { Toasts } = await import('./Hud')
    const { LazyMotion, domMax } = await import('framer-motion')
    const container = doc.body.appendChild(doc.createElement('div'))
    const root = createRoot(container as unknown as HTMLElement)
    await act(async () => root.render(createElement(LazyMotion, { features: domMax }, createElement(Toasts))))
    const html = container.textContent ?? ''
    const dismiss = container.findAll((n) => n.getAttribute('aria-label') === 'Dismiss')
    await act(async () => root.unmount())
    expect(html).toContain(note.PRIVACY_NOTE_TITLE)
    expect(html).toContain('other members and admins may see your tasks and app data')
    expect(dismiss).toHaveLength(1)   // it never blocks work: one press puts it away
    const t = useHive.getState().toasts.find((x) => x.title === note.PRIVACY_NOTE_TITLE)!
    expect(t.tone).toBe('info')
    expect(t.ttl).toBe(note.PRIVACY_NOTE_TTL)
  })

  it('is said once per store session (a page load), and again for a new session (another sign-in or a reload)', async () => {
    const c = hive('live')
    expect(await note.announcePrivacyNote(true)).toBe(true)
    expect(await note.announcePrivacyNote(true)).toBe(false)
    expect(titles().filter((x) => x === note.PRIVACY_NOTE_TITLE)).toHaveLength(1)
    expect(c.me).toHaveBeenCalledTimes(1)   // a re-render asks the hive nothing
    hive('live', 'session-b')
    expect(await note.announcePrivacyNote(true)).toBe(true)
  })

  it('says nothing before sign-in, before the hive is ready, or on a simulator', async () => {
    hive('live')
    expect(await note.announcePrivacyNote(false)).toBe(false)
    hive('live', 'session-a', false)
    expect(await note.announcePrivacyNote(true)).toBe(false)
    hive('sim')
    expect(await note.announcePrivacyNote(true)).toBe(false)
    hive(null)
    expect(await note.announcePrivacyNote(true)).toBe(false)
    expect(titles()).toEqual([])
  })

  it('says nothing on a tester\'s own hive: one person, who is also its admin', async () => {
    const c = hive('live', 'session-a', true, client('live', {}, [{ id: 'p-admin' }]))
    expect(await note.announcePrivacyNote(true)).toBe(false)
    expect(c.listPeople).toHaveBeenCalledTimes(1)
    expect(titles()).toEqual([])
    // the others there are disabled: none of them signs in to see anything
    hive('live', 'session-b', true, client('live', {}, [{ id: 'p-admin' }, { id: 'p-gone', disabled: true }]))
    expect(await note.announcePrivacyNote(true)).toBe(false)
    expect(titles()).toEqual([])
  })

  it('is said when the hive has someone else: an admin with a member, or a member (an admin is always there)', async () => {
    hive('live', 'session-a', true, client('live', {}, [{ id: 'p-admin' }, { id: 'p-member' }]))
    expect(await note.announcePrivacyNote(true)).toBe(true)
    const m = hive('live', 'session-b', true, client('live', { role: 'member', kind: 'member_password', id: 'p-member' }))
    expect(await note.announcePrivacyNote(true)).toBe(true)
    expect(m.listPeople).not.toHaveBeenCalled()   // the list is for admins; a member is never refused for it
    // the operator's password session is no person: anyone listed is someone else
    hive('live', 'session-c', true, client('live', { kind: 'password', role: null, id: null }, [{ id: 'p-admin' }]))
    expect(await note.announcePrivacyNote(true)).toBe(true)
    expect(titles()).toEqual([note.PRIVACY_NOTE_TITLE])   // hive() empties the notices: this one is the operator's
  })

  it('is said when the hive cannot say who is in it (a warning too many beats one missing)', async () => {
    hive('live', 'session-a', true, client('live', {}, new Error('people: 503')))
    expect(await note.othersInHive(client('live', {}, new Error('x')) as never)).toBe(true)
    expect(await note.announcePrivacyNote(true)).toBe(true)
  })

  it('an answer that comes back after the sign-in changed says nothing for the old session', async () => {
    const c = client('live')
    let release!: () => void
    c.me.mockImplementationOnce(() => new Promise((r) => { release = () => r({ principal: 'user:x', kind: 'sso', role: 'member', expires_at: null, person: null }) }))
    hive('live', 'session-a', true, c)
    const spoke = note.announcePrivacyNote(true)
    await Promise.resolve()
    useHive.setState({ session: 'session-b' })
    release()
    expect(await spoke).toBe(false)
    expect(titles()).toEqual([])
  })

  it('App mounts it once, told whether the person is signed in', () => {
    expect(appSource.match(/<PrivacyNotice /g)).toHaveLength(1)
    expect(appSource).toContain('<PrivacyNotice signedIn={!!client && !needsLogin} />')
  })
})
