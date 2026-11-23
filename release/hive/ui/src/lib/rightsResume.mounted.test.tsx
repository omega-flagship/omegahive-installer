// @vitest-environment node
// Purpose: Dot's read of omegahive#635: rights change mid-session (a person made admin, an owner's grant), so a read the
// hive refused with a 403 (and that stopped polling, acceptance-tests#13) reads again once /me says the signed-in
// person's role or identity changed, and not before. The hive here is a stand-in client. INVENTED people.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { ApiError } from '../api/client'
import { useHive } from '../store/store'
import { mountPage, settle, type MountedPage } from '../features/views/mountedView.testkit'
import { useMe } from './useAdmin'
import { useResource } from './useResource'

let role = 'member'
const client = { me: vi.fn(async () => ({ kind: 'person', principal: 'user:p_ines', role, person: { id: 'p_ines', name: 'Ines' } })) }
const adminRead = vi.fn(async () => {
  if (role !== 'admin') throw new ApiError(403, 'forbidden', 'admin only')
  return ['held call']
})
const seen: string[] = []

/** A page that reads an admin-only list on a poll, whoever is signed in (the shape #13 was about). */
function Page() {
  useMe()
  const r = useResource(adminRead, { poll: 60_000 })
  seen.push(r.status)
  return null
}
/** Another place that asks /me afresh (a page opened later). */
function MeOnly() {
  useMe()
  return null
}

let page: MountedPage
beforeEach(async () => {
  page = await mountPage()
  role = 'member'
  seen.length = 0
  adminRead.mockClear()
  useHive.setState({ client: client as never })
})
afterEach(async () => {
  await page.restore()
  useHive.setState({ client: null as never })
})

describe('a 403-stopped read after a change of rights', () => {
  it('reads again once /me says the person is now an admin, and shows the answer', async () => {
    await act(async () => page.root.render(<><Page /></>))
    await settle()
    expect(adminRead).toHaveBeenCalledTimes(1)
    expect(seen.at(-1)).toBe('error')

    // nothing about who is signed in changed: no new read (the first 403 is the only one)
    await act(async () => page.root.render(<><Page /><MeOnly /></>))
    await settle()
    expect(adminRead).toHaveBeenCalledTimes(1)

    // made admin mid-session; a fresh /me read says so
    role = 'admin'
    await act(async () => page.root.render(<><Page /><MeOnly /><MeOnly /></>))
    await settle()
    expect(adminRead).toHaveBeenCalledTimes(2)
    expect(seen.at(-1)).toBe('ready')
  })
})
