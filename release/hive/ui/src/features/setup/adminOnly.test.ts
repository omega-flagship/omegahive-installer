import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Me } from '../../api/client'

/**
 * The getting-started list sets up the hive itself (its provider, who pays, its limit), so it shows only to an admin
 * view (adminViewOf): the hive view's pill, the empty-hive card and #/setup. A member never sees it, nor does anyone
 * while the hive has not yet said who is signed in. The signed-in person, the store and the setup reads are replaced
 * at their modules; INVENTED people only.
 */

const h = vi.hoisted(() => ({ me: undefined as Me | undefined, loaded: true, agents: {} as Record<string, unknown>, reads: 0 }))

vi.mock('../../lib/useAdmin', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/useAdmin')>()
  return {
    ...real,
    useMe: () => ({ me: h.me, admin: real.isAdminMe(h.me), loaded: h.loaded, failed: false }),
    useAdminView: () => ({ me: h.me, loaded: h.loaded, adminView: real.adminViewOf({ me: h.me, loaded: h.loaded }) }),
  }
})
// every setup read answers at once with nothing readable: each step is unknown but "Start a swarm", still to do
vi.mock('../../lib/useResource', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/useResource')>()),
  useResource: () => {
    h.reads++
    return { status: 'ready', data: undefined }
  },
}))
vi.mock('../../store/store', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../store/store')>()
  // the selector answers from this test's hive; getState and the rest stay the store's own (modules read them as they load)
  const pick = (select: (s: unknown) => unknown) => select({ ...real.useHive.getState(), ready: true, agents: h.agents, client: {}, swarms: {}, hive: null })
  return { ...real, useHive: Object.assign(pick, real.useHive) }
})
// First Light's door answers as it stands now (a server render would read the store's first state)
vi.mock('../firstlight/door', async (importOriginal) => {
  const real = await importOriginal<typeof import('../firstlight/door')>()
  const pick = (select: (s: unknown) => unknown) => select(real.useFlDoor.getState())
  return { ...real, useFlDoor: Object.assign(pick, real.useFlDoor) }
})

const { SetupNudge } = await import('./SetupChecklist')
const { noteFlRecord, useFlDoor } = await import('../firstlight/door')
const SetupPage = (await import('./SetupPage')).default
const { EmptyHive } = await import('../../shell/Ambient')

const ADMIN: Me = { principal: 'user:p_ada', kind: 'sso', role: 'admin', expires_at: null, person: { id: 'p_ada', email: 'ada@example.org', name: 'Ada' } }
const MEMBER: Me = { principal: 'user:p_bo', kind: 'member_password', role: 'member', expires_at: null, person: { id: 'p_bo', email: 'bo@example.org', name: 'Bo' } }
const OPERATOR: Me = { principal: 'user:operator', kind: 'password', role: null, expires_at: null, person: null }

const html = (component: (props: Record<string, never>) => unknown) => renderToStaticMarkup(createElement(component as () => null))
const signedIn = (me: Me, loaded = true) => {
  h.me = me
  h.loaded = loaded
}

beforeEach(() => {
  h.reads = 0
  // as GET /api/agents lists the signed-in person's personal mind (is_mine), asleep and never woken: a hive not in use
  h.agents = { a_quill: { id: 'a_quill', name: 'Quill', kind: 'omega', swarm_id: 's_quill', status: 'asleep', last_active_at: null, owner: 'user:p_ada', is_mine: true } }
})

describe('the hive view’s Getting started pill', () => {
  it('shows to an admin and to the operator while a step is left', () => {
    for (const me of [ADMIN, OPERATOR]) {
      signedIn(me)
      expect(html(SetupNudge)).toContain('data-tour="setup-nudge"')
    }
  })

  it('never shows to a member, whose view reads none of the hive’s setup', () => {
    signedIn(MEMBER)
    expect(html(SetupNudge)).toBe('')
    expect(h.reads).toBe(0)
  })

  it('stays hidden while the hive has not said who is signed in', () => {
    signedIn(ADMIN, false)
    expect(html(SetupNudge)).toBe('')
  })

  it('says Finish setup in its place while the person’s First Light is set aside, to admins and members alike', () => {
    signedIn(ADMIN)
    noteFlRecord('skipped')
    try {
      expect(html(SetupNudge)).toContain('data-tour="finish-setup"')
      expect(html(SetupNudge)).not.toContain('data-tour="setup-nudge"')
      signedIn(MEMBER)
      expect(html(SetupNudge)).toContain('>Finish setup<')
    } finally {
      useFlDoor.setState({ record: null })
    }
    signedIn(ADMIN)
    expect(html(SetupNudge)).toContain('data-tour="setup-nudge"')
  })
})

describe('the empty hive’s card', () => {
  beforeEach(() => {
    h.agents = {}
  })

  it('shows an admin the getting-started steps', () => {
    signedIn(ADMIN)
    const card = html(EmptyHive)
    expect(card).toContain('the steps below show what is set up')
    expect(card).toContain('Connect an AI provider')
  })

  it('shows a member the way to a first mind, without the hive’s setup', () => {
    signedIn(MEMBER)
    const card = html(EmptyHive)
    expect(card).toContain('The hive is quiet')
    expect(card).toContain('Create the first mind')
    expect(card).not.toContain('Getting started')
    expect(card).not.toContain('steps below')
    expect(h.reads).toBe(0)
  })
})

describe('#/setup', () => {
  it('lists the steps for an admin', () => {
    signedIn(ADMIN)
    const page = html(SetupPage)
    expect(page).toContain('Connect an AI provider')
    expect(page).not.toContain('For this hive&#x27;s admins')
  })

  it('tells a member whose job the steps are, and lists none of them', () => {
    signedIn(MEMBER)
    const page = html(SetupPage)
    expect(page).toContain('For this hive&#x27;s admins')
    expect(page).not.toContain('Connect an AI provider')
    expect(h.reads).toBe(0)
  })

  it('shows neither while the hive has not said who is signed in', () => {
    signedIn(ADMIN, false)
    const page = html(SetupPage)
    expect(page).not.toContain('Connect an AI provider')
    expect(page).not.toContain('For this hive&#x27;s admins')
  })
})
