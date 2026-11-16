import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ApiError, type Invite, type Person } from '../../api/client'
import type { ResourceState } from '../../lib/useResource'
import { DRAWN_BLOCKS, Screen, scopedHost, type ScreenHost, type ScreenItem } from '../../screens/Screen'
import { ScreensSpace, SCREEN_SOURCES, type ScreenFacts } from '../../screens/screenSpace'
import { signInWords } from './clearGoogle'
import { NOT_AGAIN, passwordWords, type ShownPassword } from './memberPassword'
import peopleSource from './people.metta?raw'
import { hsl } from '../../lib/color'
import { hueOf, pendingOf, peopleScreen, type Can, type Compose, type Moment, type PeopleData, type Viewer } from './data'

vi.setConfig({ testTimeout: 20_000 })

/** The People page end to end: invented people and invitations → facts → MeTTa composes the page and each person → drawn. */
const space = ScreensSpace.open()
const seen = new Map<string, Set<number>>()
const compose: Compose = (screen, facts) => {
  const plan = space.compose(screen, 'classic', facts)
  const orders = seen.get(screen) ?? new Set<number>()
  for (const p of plan.parts) orders.add(p.order)
  seen.set(screen, orders)
  return plan
}
const NAMES = { seen: () => '2h ago', day: () => '3/9/2026' }

const person = (id: string, name: string, over: Partial<Person> = {}): Person => ({
  id, name, email: `${name.toLowerCase()}@example.org`, role: 'member', invited_by: null, created_at: '2026-01-01T00:00:00Z', last_seen_at: null, disabled: false, ...over,
})
const invite = (id: string, name: string, status: Invite['status'] = 'pending'): Invite => ({
  id, name, email: `${name.toLowerCase()}@example.org`, role: 'member', created_by: 'p_0', created_at: '', expires_at: 1_773_000_000, accepted_at: null, revoked_at: null, status,
})
const PEOPLE: PeopleData = {
  people: [
    person('p_1', 'Wren', { role: 'admin', google_bound: true, last_seen_at: '2026-03-01T10:00:00Z' }),
    person('p_2', 'Ada', { password_set: true }),
    person('p_3', 'Juniper', { disabled: true }),
  ],
  invites: [invite('i_1', 'Moss'), invite('i_2', 'Fern', 'revoked'), invite('i_3', 'Sorrel', 'accepted')],
  google_ready: false,
  member_passwords: true,
}
const ALL: Can = { invite: true, addMember: true, revokeInvite: true, updatePerson: true, clearGoogle: true, resetPassword: true, removePassword: true }
const ADMIN: Viewer = { admin: true, selfId: 'p_1' }
const MEMBER: Viewer = { admin: false, selfId: 'p_2' }
const QUIET: Moment = { invite: null, password: null }
const ready = (data: PeopleData, error?: unknown): ResourceState<PeopleData> => ({ status: 'ready', data, error, refreshing: false })
const state = (status: 'loading' | 'unsupported' | 'error', error?: unknown): ResourceState<PeopleData> => ({ status, data: undefined, error, refreshing: false })
const ISLANDS = { 'invite-form': createElement('form', { 'aria-label': 'Invite form' }), 'member-form': createElement('form', { 'aria-label': 'Add a member' }) }

function page(res: ResourceState<PeopleData>, viewer = ADMIN, can = ALL, moment = QUIET, host: Partial<ScreenHost> = {}) {
  const { data, facts } = peopleScreen(res, viewer, can, moment, NAMES, compose)
  const plan = compose('people', facts)
  return { plan, data, facts, html: renderToStaticMarkup(createElement(Screen, { plan, host: { data, framed: true, islands: ISLANDS, onOpen: () => {}, onAction: () => {}, ...host } })) }
}
const islands = (p: { plan: { parts: { block: string | null; props: Record<string, unknown> }[] } }) => p.plan.parts.filter((x) => x.block === 'island').map((x) => x.props.name)
const pw = (over: Partial<ShownPassword & { copied: boolean }> = {}): Moment => ({ invite: null, password: { email: 'ada@example.org', name: 'Ada', password: 'invented-pass-9', reason: 'added', copied: false, ...over } })
/** One person's row, alone. */
const row = (p: Person, viewer = ADMIN, can = ALL, data: Partial<PeopleData> = {}) => {
  const { data: d } = peopleScreen(ready({ ...PEOPLE, ...data, people: [p] }), viewer, can, QUIET, NAMES, compose)
  const item = (d['people.rows'] as { id: string; plan: Parameters<typeof Screen>[0]['plan']; data: Record<string, unknown> }[])[1]
  return { item, html: renderToStaticMarkup(createElement(Screen, { plan: item.plan, host: { data: item.data, onAction: () => {} } })) }
}
const facts = (f: ScreenFacts) => f

describe('the People page, composed by MeTTa', () => {
  it('the new chooser block is known to MeTTa and drawn by the renderer; the guards stay clean', () => {
    expect(space.blocks()).toContain('chooser')
    expect(DRAWN_BLOCKS).toContain('chooser')
    expect(space.screens()).toEqual(expect.arrayContaining(['people', 'people-person', 'people-operator']))
    expect(Object.values(space.guards()).flat()).toEqual([])
    expect(page(ready(PEOPLE)).plan.missing).toEqual([])
  })
  it('while loading, unsupported, forbidden or failed: says so, and nothing else', () => {
    const loading = page(state('loading'))
    expect(loading.plan.parts.map((p) => p.block)).toEqual(['waiting'])
    expect(loading.html).toContain('aria-label="Loading people"')
    const unsupported = page(state('unsupported')).html
    expect(unsupported).toContain('Not available here')
    expect(unsupported).toContain('does not list people')
    const forbidden = page(state('error', new ApiError(403, 'forbidden', 'admins only'))).html
    expect(forbidden).toContain('Admins only')
    expect(forbidden).toContain('Ask an admin of this hive to invite someone.')
    expect(forbidden).not.toContain('Try again')
    const failed = page(state('error', new Error('The hive is busy'))).html
    expect(failed).toContain('Could not load people')
    expect(failed).toContain('The hive is busy')
    expect(failed).toContain('>Try again</button>')
    for (const html of [unsupported, forbidden, failed]) expect(html).not.toContain('Invite form')
  })
  it('a failed refresh keeps the people on screen, says so, and offers Retry', () => {
    const { html } = page(ready(PEOPLE, new Error('Timed out')))
    expect(html).toContain('Could not refresh: Timed out Showing the last loaded data.')
    expect(html).toContain('>Retry</button>')
    expect(html).toContain('Wren')
  })
  it('an admin sees the invitation form, the member form while Google sign-in is not set up, and every control', () => {
    const { html, plan } = page(ready(PEOPLE))
    expect(islands({ plan })).toEqual(['invite-form', 'member-form'])
    expect(html).toContain('Google sign-in is not set up yet; the link will not work until it is.')
    expect(html).toContain('aria-label="Role of Ada"')
    expect(html).toContain('>Remove</button>')
    expect(html).toContain('>Restore</button>')
    expect(html).toContain('>Reset password</button>')
    expect(html).toContain('>Remove password</button>')
  })
  it('once Google sign-in is set up, there is no member form and no warning', () => {
    const { html, plan } = page(ready({ ...PEOPLE, google_ready: true }))
    expect(islands({ plan })).toEqual(['invite-form'])
    expect(html).not.toContain('Google sign-in is not set up yet')
  })
  it('a member sees the list, but no member form and no password or Google controls', () => {
    const { html, plan } = page(ready(PEOPLE), MEMBER)
    expect(islands({ plan })).toEqual(['invite-form'])
    expect(html).not.toContain('Reset password')
    expect(html).not.toContain('Make a password')
    expect(html).not.toContain('Remove password')
    expect(html).not.toContain('Clear Google sign-in')
  })
  it('a hive that sends no invitations says so; one without member passwords offers none', () => {
    expect(page(ready(PEOPLE), ADMIN, { ...ALL, invite: false }).html).toContain('Inviting is not available here (this hive or the demo does not send invitations).')
    expect(page(ready(PEOPLE)).html).not.toContain('Inviting is not available here')
    const off = page(ready({ ...PEOPLE, member_passwords: false }))
    expect(islands(off)).toEqual(['invite-form'])
    expect(off.html).not.toContain('Reset password')
    expect(islands(page(ready(PEOPLE), ADMIN, { ...ALL, addMember: false }))).toEqual(['invite-form'])
  })
  it('the fresh invitation link shows only while there is one: Copy link, Dismiss, and Email it', () => {
    const fresh = { ...invite('i_9', 'Rowan'), link: 'https://hive.example/invite/abc', copied: false }
    const { plan, html, data } = page(ready(PEOPLE), ADMIN, ALL, { invite: fresh, password: null })
    expect(islands({ plan })).toEqual(['invite-form', 'member-form'])
    expect(html).toContain('Invitation ready for rowan@example.org')
    expect(html).toContain('https://hive.example/invite/abc')
    expect(html).toContain('>Copy link</button>')
    expect(html).toContain('>Dismiss</button>')
    expect(html).toContain('>Email it</button>')
    expect(html).toContain('Send this link. It is shown only now; create a new invitation if it is lost.')
    expect(String(data['invite.mail'])).toMatch(/^mailto:rowan%40example\.org\?subject=An%20invitation%20to%20OmegaHive&body=Hi%20Rowan/)
    expect(page(ready(PEOPLE), ADMIN, ALL, { invite: { ...fresh, copied: true }, password: null }).html).toContain('>Copied</button>')
    expect(page(ready(PEOPLE)).html).not.toContain('Invitation ready')
  })
  it('only pending invitations are listed, each with Withdraw when this hive can withdraw', () => {
    expect(pendingOf(PEOPLE).map((i) => i.id)).toEqual(['i_1'])
    const { html, facts } = page(ready(PEOPLE))
    expect(facts.counts?.['invites.pending']).toBe(1)
    expect(html).toContain('aria-label="Waiting to accept"')
    expect(html).toContain('moss@example.org · member · expires 3/9/2026')
    expect(html).toContain('>Withdraw</button>')
    expect(html).not.toContain('Fern')     // withdrawn
    expect(html).not.toContain('Sorrel')   // accepted
    expect(page(ready(PEOPLE), ADMIN, { ...ALL, revokeInvite: false }).html).not.toContain('Withdraw')
    expect(page(ready({ ...PEOPLE, invites: [invite('i_2', 'Fern', 'revoked')] })).html).not.toContain('Waiting to accept')
  })
  it('Withdraw opens "withdraw" with the invitation, which carries its id', () => {
    const { data, facts: f } = peopleScreen(ready(PEOPLE), ADMIN, ALL, QUIET, NAMES, compose)
    const part = compose('people', f).parts.find((p) => p.block === 'entries')
    expect(part?.props.open).toBe('withdraw')
    expect((data['invites.pending'] as ScreenItem[])[0]).toMatchObject({ id: 'i_1', withdraw: 'Withdraw' })
  })
  it('the operator comes first, as an admin who signs in on the hive’s own machine', () => {
    const { html } = page(ready(PEOPLE))
    expect(html.indexOf('Hive operator')).toBeLessThan(html.indexOf('Wren'))
    expect(html).toContain("Signs in on this hive&#x27;s own machine")
    expect(html.indexOf('Wren')).toBeLessThan(html.indexOf('Ada'))
    expect(html.indexOf('Ada')).toBeLessThan(html.indexOf('Juniper'))
    expect(html).toContain('Members use the hive. Admins also invite people')
  })
  it('you: marked, and offered no role change, removal or password controls on yourself', () => {
    const { html } = row(PEOPLE.people[0])
    expect(html).toContain('>you<')
    expect(html).toContain('>Admin<')
    expect(html).not.toContain('radiogroup')
    expect(html).not.toContain('>Remove<')
    expect(html).not.toContain('Clear Google sign-in')
  })
  it('someone else: their role can be changed, they can be removed, and their sign-in is described', () => {
    const { html } = row(person('p_4', 'Wren', { role: 'admin', google_bound: true, last_seen_at: '2026-03-01T10:00:00Z' }))
    expect(html).toContain('aria-label="Role of Wren"')
    expect(html).toMatch(/aria-checked="true"(?:(?!<\/button>).)*>Admin</)
    expect(html).toContain('wren@example.org · seen 2h ago')
    expect(html).toContain('>Signs in with Google<')
    expect(html).toContain('>Clear Google sign-in</button>')
    // an admin has no password made by the hive, so neither Reset nor Make
    expect(html).not.toContain('Make a password')
  })
  it('without a way to change people, the role is shown in words', () => {
    const { html } = row(person('p_4', 'Moss'), ADMIN, { ...ALL, updatePerson: false })
    expect(html).toContain('>Member<')
    expect(html).not.toContain('radiogroup')
    expect(html).not.toContain('>Remove<')
    expect(html).toContain('moss@example.org · not signed in yet')
  })
  it('someone removed: marked removed, offered Restore, and nothing else', () => {
    const { html } = row(person('p_3', 'Juniper', { disabled: true, password_set: true }))
    expect(html).toContain('>Removed<')
    expect(html).toContain('>Restore</button>')
    expect(html).not.toContain('radiogroup')
    expect(html).not.toContain('Reset password')
    expect(html).not.toContain('Remove password')
  })
  it('the member password states: none (Make), set (Reset and Remove), and an admin with one (Remove only)', () => {
    expect(row(person('p_5', 'Bo')).html).toContain('>Make a password</button>')
    const set = row(person('p_2', 'Ada', { password_set: true })).html
    expect(set).toContain('>Reset password</button>')
    expect(set).toContain('>Remove password</button>')
    const adminWith = row(person('p_6', 'Rue', { role: 'admin', password_set: true })).html
    expect(adminWith).not.toContain('Reset password')
    expect(adminWith).toContain('>Remove password</button>')
    expect(row(person('p_2', 'Ada', { password_set: true }), ADMIN, { ...ALL, removePassword: false }).html).not.toContain('Remove password')
    expect(row(person('p_2', 'Ada', { password_set: true, google_bound: true })).html).toContain('Signs in with Google · Signs in with a hive password')
  })
  it('someone else’s buttons sit side by side in one row', () => {
    const { item, html } = row(person('p_2', 'Ada', { password_set: true, google_bound: true }))
    const actions = item.plan.parts.filter((p) => p.block === 'actions')
    expect(actions.map((p) => p.order)).toEqual([40, 42, 43, 45])
    expect(new Set(actions.map((p) => p.place.row))).toEqual(new Set(['person-actions']))
    expect(html.match(/data-screen-row="/g)).toHaveLength(1)
    const inRow = html.slice(html.indexOf('data-screen-row="person-actions"'))
    for (const label of ['Remove', 'Clear Google sign-in', 'Reset password', 'Remove password']) expect(inRow).toContain(`>${label}</button>`)
    // the role chooser keeps its own line above the row
    expect(html.indexOf('aria-label="Role of Ada"')).toBeLessThan(html.indexOf('data-screen-row="person-actions"'))
  })
  it('each person has their own orb before their name, and the operator theirs', () => {
    const { html } = row(person('p_4', 'Moss'))
    expect(html).toContain(hsl(hueOf('moss@example.org'), 100, 80))
    expect(html).toContain('animate-breathe')
    expect(html.indexOf('aria-hidden="true"')).toBeLessThan(html.indexOf('Moss'))
    expect(hueOf('moss@example.org')).not.toBe(hueOf('wren@example.org'))
    const operator = page(ready(PEOPLE)).html
    expect(operator).toContain(hsl(150, 100, 80))
    expect(operator.indexOf(hsl(150, 100, 80))).toBeLessThan(operator.indexOf('Hive operator'))
  })
  it('someone removed is dimmed, their orb stilled; someone still here is not', () => {
    const removed = row(person('p_3', 'Juniper', { disabled: true })).html
    expect(removed).toMatch(/<div class="[^"]*opacity-60[^"]*">(?:(?!<\/div>).)*grayscale\(0\.7\)/)
    expect(removed).not.toContain('animate-breathe')
    const here = row(person('p_4', 'Moss')).html
    expect(here).not.toContain('opacity-60')
    expect(here).not.toContain('grayscale')
  })
  it('the sign-in words are the same as clearGoogle.ts and memberPassword.ts say them', () => {
    expect(peopleSource).toContain(`"${signInWords(true)}"`)
    expect(peopleSource).toContain(`"${passwordWords({ password_set: true })}"`)
    expect(peopleSource).toContain(`"${NOT_AGAIN}"`)
  })
  it('a press on a person’s role comes back with the chosen value and the person', () => {
    const got: [string, ScreenItem][] = []
    const { item } = row(person('p_4', 'Moss'))
    const host = scopedHost({ data: {}, onAction: (a, it) => got.push([a, it]) }, item)
    const part = item.plan.parts.find((p) => p.block === 'chooser')!
    expect(part.props.action).toBe('set-role')
    host.onAction!('set-role', { value: 'admin' })
    expect(got).toEqual([['set-role', { value: 'admin', scope: ['p_4'] }]])
  })
  it('a password made for a new member: shown once, with Copy password and Dismiss, announced as it appears', () => {
    const { html } = page(ready(PEOPLE), ADMIN, ALL, pw())
    expect(html).toContain('role="alert"')
    expect(html).toContain('Ada is a member. Their password:')
    expect(html).toContain('invented-pass-9')
    expect(html).toContain('They sign in with ada@example.org and this password.')
    expect(html).toContain('>Copy password</button>')
    expect(html).toContain('>Dismiss</button>')
    expect(html).toContain(NOT_AGAIN)
    expect(page(ready(PEOPLE), ADMIN, ALL, pw({ copied: true })).html).toContain('>Copied</button>')
  })
  it('a reset password: says which, and whether earlier sign-ins ended', () => {
    const plain = page(ready(PEOPLE), ADMIN, ALL, pw({ reason: 'reset' })).html
    expect(plain).toContain('New password for Ada:')
    expect(plain).not.toContain('earlier password sign-ins ended')
    const ended = page(ready(PEOPLE), ADMIN, ALL, pw({ reason: 'reset', endedSessions: 3 })).html
    expect(ended).toContain('Their earlier password sign-ins ended (3).')
    expect(page(ready(PEOPLE), ADMIN, ALL, pw({ reason: 'reset', endedSessions: 3, copied: true })).html).toContain('>Copied</button>')
    expect(page(ready(PEOPLE), ADMIN, ALL, pw({ reason: 'reset', copied: true })).html).toContain('>Copied</button>')
    expect(page(ready(PEOPLE)).html).not.toContain('invented-pass-9')
  })
  it('Cosmos draws the same atoms on a 3D stage', () => {
    const { data, facts: f } = peopleScreen(ready(PEOPLE), ADMIN, ALL, QUIET, NAMES, compose)
    const plan = space.compose('people', 'cosmos', facts(f))
    expect(plan.space).toBe('3d')
    expect(renderToStaticMarkup(createElement(Screen, { plan, host: { data } }))).toContain('Juniper')
  })
  it('every part of every People screen can be reached', () => {
    const declared = new Map<string, Set<number>>()
    for (const [, screen, order] of peopleSource.matchAll(/\((?:Part|RolePart) (\S+) (\d+) /g)) {
      declared.set(screen, (declared.get(screen) ?? new Set()).add(Number(order)))
    }
    // the cases above, plus a removed person who is signed in (yourself)
    row(person('p_9', 'Yarrow', { disabled: true }), { admin: true, selfId: 'p_9' })
    for (const [screen, orders] of declared) expect([...orders].filter((o) => !seen.get(screen)?.has(o)), screen).toEqual([])
  })
})

describe('the blocks the People page added or extended', () => {
  const FIXTURE = `
(Screen shelf "Shelf")
(Part shelf 10 chooser ((label "Size of the pot") (value pot.size) (action set-size) (options ((option small "Small") (option large "Large")))))
(Part shelf 20 reveal ((label "Code") (value "invented-code") (copy copy) (hide hide)))
`
  it('a chooser marks the current value and sends its action with the chosen value', () => {
    const s = ScreensSpace.open([...SCREEN_SOURCES, ['shelf', FIXTURE]])
    const plan = s.compose('shelf', 'classic')
    expect(plan.parts.map((p) => [p.block, p.depth.layer])).toEqual([['chooser', 'surface'], ['reveal', 'raised']])
    const got: [string, ScreenItem][] = []
    const html = renderToStaticMarkup(createElement(Screen, { plan, host: { data: { 'pot.size': 'large' }, onAction: (a, it) => got.push([a, it]) } }))
    expect(html).toContain('aria-label="Size of the pot"')
    expect(html).toMatch(/aria-checked="true"(?:(?!<\/button>).)*>Large</)
    // a reveal without labels keeps Copy and Hide, and is not announced
    expect(html).toContain('>Copy</button>')
    expect(html).toContain('>Hide</button>')
    expect(html).not.toContain('role="alert"')
  })
})
