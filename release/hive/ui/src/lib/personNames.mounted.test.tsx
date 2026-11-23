// @vitest-environment node
// Purpose: acceptance-tests#13: GET /api/people is admin-only on the hive, so a member's page must never ask it (each ask
// is a 403 that lands in the member's recent errors). usePeopleNames reads it only for an admin; a member still knows
// their own name. The hive here is a stand-in client. INVENTED people.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { ApiError } from '../api/client'
import { useHive } from '../store/store'
import { mountPage, settle, type MountedPage } from '../features/views/mountedView.testkit'
import { usePeopleNames, type PeopleNames } from './personNames'

const member = { kind: 'person', principal: 'user:p_ines', role: 'member', person: { id: 'p_ines', name: 'Ines' } }
const admin = { kind: 'person', principal: 'user:p_ada', role: 'admin', person: { id: 'p_ada', name: 'Ada' } }
const people = [{ id: 'p_ada', name: 'Ada' }, { id: 'p_ines', name: 'Ines' }]

function clientAs(me: typeof member) {
  return {
    me: vi.fn(async () => me),
    // the hive's own rule: admins only (hive/core/app.py /api/people)
    listPeople: vi.fn(async () => {
      if (me.role !== 'admin') throw new ApiError(403, 'forbidden', 'admin only')
      return { people }
    }),
  }
}

let page: MountedPage
const seen: PeopleNames[] = []
function Probe() {
  seen.push(usePeopleNames())
  return null
}

beforeEach(async () => {
  page = await mountPage()
  seen.length = 0
})
afterEach(async () => {
  await page.restore()
  useHive.setState({ client: null as never })
})

describe('usePeopleNames: the people list only for an admin', () => {
  it('a member never asks for the people list, and still has their own name', async () => {
    const client = clientAs(member)
    useHive.setState({ client: client as never })
    await act(async () => page.root.render(<Probe />))
    await settle()
    expect(client.me).toHaveBeenCalled()
    expect(client.listPeople).not.toHaveBeenCalled()
    expect(seen.at(-1)?.people).toBeNull()
    expect(seen.at(-1)?.me?.principal).toBe('user:p_ines')
  })

  it('an admin reads the people list', async () => {
    const client = clientAs(admin)
    useHive.setState({ client: client as never })
    await act(async () => page.root.render(<Probe />))
    await settle()
    expect(client.listPeople).toHaveBeenCalledTimes(1)
    expect(seen.at(-1)?.people).toEqual(people)
  })
})
