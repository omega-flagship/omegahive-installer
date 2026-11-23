// @vitest-environment node
// Purpose: acceptance-tests#13 N1 (QA on #635): GET /api/people is admin-only on the hive, so no view a member can open
// asks it; each ask was a 403 in the member's recent errors. Each one-shot people read below is mounted once as a member
// (never asks, keeps the member's view it had after the 403) and once as an admin (reads, as before). The hive here is a
// stand-in client with the hive's own rule. INVENTED people.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { ApiError, type Person } from '../api/client'
import { useHive } from '../store/store'
import { mountPage, settle, type MountedPage } from '../features/views/mountedView.testkit'
import { MiniNode } from '../ui/miniDom.testkit'
import { VisibilityPicker } from '../ui/Visibility'
import { NewRoom } from '../features/messages/MessagesPage'
import { AppInstall } from '../features/programs/AppInstall'
import { Sheet } from '../experiences/still/Sheets'
import { readPeople } from '../experiences/sdk'
import { useAdminPeople } from './adminPeople'

vi.setConfig({ testTimeout: 20_000 })

const member = { kind: 'person', principal: 'user:p_ines', role: 'member', person: { id: 'p_ines', name: 'Ines' } }
const admin = { kind: 'person', principal: 'user:p_ada', role: 'admin', person: { id: 'p_ada', name: 'Ada' } }
const people = [{ id: 'p_ada', name: 'Ada', email: 'ada@example.test', role: 'admin' }, { id: 'p_ines', name: 'Ines', email: 'ines@example.test', role: 'member' }]

function clientAs(me: typeof member) {
  return {
    me: vi.fn(async () => me),
    // the hive's own rule: admins only (hive/core/app.py /api/people)
    listPeople: vi.fn(async () => {
      if (me.role !== 'admin') throw new ApiError(403, 'forbidden', 'admin only')
      return { people, invites: [] }
    }),
    programInstall: vi.fn(async () => ({ placement: 'person', person_allow: 'all', release_digest: 'sha256:aa', review: null })),
  }
}

let page: MountedPage
const text = () => page.container.textContent
async function mountAs(me: typeof member, node: React.ReactNode) {
  const client = clientAs(me)
  useHive.setState({ client: client as never })
  await act(async () => page.root.render(node))
  await settle()
  return client
}

// a dialog's focus keeping (ui/useModalContainment) asks `instanceof HTMLElement`; the mini page's nodes stand in. The
// still sheets time their entrance with window.setTimeout, which the mini page's window lacks.
const g = globalThis as unknown as Record<string, unknown>
let keptElement: unknown
beforeEach(async () => {
  page = await mountPage()
  keptElement = g.HTMLElement
  g.HTMLElement = MiniNode
  Object.assign(g.window as object, { setTimeout, clearTimeout })
})
afterEach(async () => {
  await page.restore()
  g.HTMLElement = keptElement
  useHive.setState({ client: null as never })
})

describe('useAdminPeople: the one people read a view opens (Motivations people boxes)', () => {
  const seen: (Person[] | null)[] = []
  function Probe({ active }: { active: boolean }) {
    seen.push(useAdminPeople(active))
    return null
  }
  beforeEach(() => {
    seen.length = 0
  })

  it('a member never asks, and gets no one (as after the 403 before)', async () => {
    const client = await mountAs(member, <Probe active />)
    expect(client.me).toHaveBeenCalled()
    expect(client.listPeople).not.toHaveBeenCalled()
    expect(seen.at(-1)).toEqual([])
  })

  it('an admin reads the people while the box is open, and not before', async () => {
    const client = await mountAs(admin, <Probe active={false} />)
    expect(client.listPeople).not.toHaveBeenCalled()
    await act(async () => page.root.render(<Probe active />))
    await settle()
    expect(client.listPeople).toHaveBeenCalledTimes(1)
    expect(seen.at(-1)).toEqual(people)
  })

  it('says nothing yet while who is signed in is still unknown', async () => {
    const client = clientAs(admin)
    client.me.mockImplementation(() => new Promise(() => undefined))
    useHive.setState({ client: client as never })
    await act(async () => page.root.render(<Probe active />))
    await settle()
    expect(client.listPeople).not.toHaveBeenCalled()
    expect(seen.at(-1)).toBeNull()
  })
})

describe('VisibilityPicker: shared with named people', () => {
  const shared = { visibility: 'shared' as const, shared_with: [] }
  it('a member never asks, and sees the no-one line', async () => {
    const client = await mountAs(member, <VisibilityPicker value={shared} onChange={() => undefined} />)
    expect(client.listPeople).not.toHaveBeenCalled()
    expect(text()).toContain('No one else here yet')
  })
  it('an admin reads and picks from the people', async () => {
    const client = await mountAs(admin, <VisibilityPicker value={shared} onChange={() => undefined} />)
    expect(client.listPeople).toHaveBeenCalledTimes(1)
    expect(text()).toContain('Ines')
  })
})

describe('NewRoom: the new conversation dialog', () => {
  it('a member never asks; minds only, as before', async () => {
    const client = await mountAs(member, <NewRoom onClose={() => undefined} onCreated={() => undefined} />)
    expect(client.listPeople).not.toHaveBeenCalled()
    expect(text()).not.toContain('Ines')
  })
  it('an admin reads the people to add', async () => {
    const client = await mountAs(admin, <NewRoom onClose={() => undefined} onCreated={() => undefined} />)
    expect(client.listPeople).toHaveBeenCalledTimes(1)
  })
})

describe('AppInstall: the Install tab of an app (a member can open it)', () => {
  it('a member never asks', async () => {
    const client = await mountAs(member, <AppInstall programId="p1" name="Notes" admin={false} />)
    expect(client.programInstall).toHaveBeenCalled()
    expect(client.listPeople).not.toHaveBeenCalled()
  })
  it('an admin reads the people to allow', async () => {
    const client = await mountAs(admin, <AppInstall programId="p1" name="Notes" admin />)
    expect(client.listPeople).toHaveBeenCalledTimes(1)
  })
})

describe('Still: the People sheet', () => {
  const sheet = <Sheet kind="people" onClose={() => undefined} onOpenMind={() => undefined} onLaunch={() => undefined} />
  it('a member never asks, and is told only an admin sees who is here', async () => {
    const client = await mountAs(member, sheet)
    expect(client.listPeople).not.toHaveBeenCalled()
    expect(text()).toContain('Only an admin of this hive can see who is in it.')
  })
  it('an admin reads the people', async () => {
    const client = await mountAs(admin, sheet)
    expect(client.listPeople).toHaveBeenCalledTimes(1)
    expect(text()).toContain('Ines')
  })
})

describe('sdk readPeople (canvas Hive panel, construct "people")', () => {
  it('a member gets null without asking (one /me read)', async () => {
    const client = clientAs(member)
    useHive.setState({ client: client as never })
    expect(await readPeople()).toBeNull()
    expect(client.listPeople).not.toHaveBeenCalled()
  })
  it('an admin gets the people', async () => {
    const client = clientAs(admin)
    useHive.setState({ client: client as never })
    expect((await readPeople())?.people).toEqual(people)
  })
})
