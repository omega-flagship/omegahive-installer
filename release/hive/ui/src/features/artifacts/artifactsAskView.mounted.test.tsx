// @vitest-environment node
// Purpose: the Artifacts page tells the Ask what it lists (features/artifacts/ArtifactsPage.tsx; features/ask/view): each
// creation by its id, in the list's order, following the person's filter, and the one open in place first, so the Ask
// can show a picture the person names by its title (the hive names each id from its own data). INVENTED ids and titles.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import type { ArtifactList } from '../../api/moneyWork'
import { useHive } from '../../store/store'
import { currentView } from '../ask/view'
import { mountPage, settle, type MountedPage } from '../views/mountedView.testkit'
import ArtifactsPage from './ArtifactsPage'

const digest = `sha256:${'e'.repeat(64)}`
const creation = (id: string, title: string, kind: string, at: string) => ({
  key: `creation:${id}`, kind: 'creation' as const, title, swarm_id: 's1', mind_id: 'a_vega01', app: null, at,
  artifact_id: id, revision: 1, ref: { artifact_id: id, revision: 1, digest }, creation_kind: kind,
})
const list: ArtifactList = {
  items: [
    creation('ar_harbour01', 'Harbour at dusk', 'image', '2026-11-15T10:03:00Z'),
    creation('ar_tipview01', 'Tip calculator', 'view', '2026-11-15T10:02:00Z'),
    // a review of the harbour picture names the same artifact: it is listed once
    { key: 'review:rq1', kind: 'review', title: 'Review the harbour', swarm_id: 's1', mind_id: 'a_vega01', app: null, at: '2026-11-15T10:01:00Z', artifact_id: 'ar_harbour01', revision: 1 },
    // an exhibit has no artifact id: nothing to name
    { key: 'exhibit:ex1', kind: 'exhibit', title: 'Spectra', swarm_id: null, mind_id: 'a_vega01', app: null, at: '2026-11-15T10:00:00Z' },
  ],
  missing: [],
}
const client = {
  hiveArtifacts: () => Promise.resolve(list),
  artifact: (id: string) => Promise.resolve({ artifact_id: id, kind: 'note', title: 'Older notes', swarm_id: 's1', mind_id: 'a_vega01', revision: 2, digest, created_at: '2026-11-14T00:00:00Z', revised_at: null }),
  creationText: (id: string) => Promise.resolve({ artifact_id: id, kind: 'note', title: 'Older notes', swarm_id: 's1', revision: 2, digest, body: 'Some words.', created_at: '2026-11-14T00:00:00Z' }),
}

let page: MountedPage
beforeEach(async () => {
  page = await mountPage()
  useHive.setState({ client: client as never, agents: {}, swarms: {}, programs: [] })
})
afterEach(async () => {
  await page.restore()
  useHive.setState({ client: null as never })
})

const mount = async (hash: string) => {
  ;(globalThis as unknown as { window: { location: { hash: string } } }).window.location.hash = hash
  await act(async () => page.root.render(<ArtifactsPage />))
  await settle()
}
const refs = () => currentView()?.view.refs?.map((r) => `${r.kind} ${r.ref}`)

describe('what the Artifacts page tells the Ask', () => {
  it('names every creation it lists by id, once each, in the list’s order', async () => {
    await mount('#/artifacts')
    expect(currentView()?.scope).toBe('artifacts')
    expect(refs()).toEqual(['artifact ar_harbour01', 'artifact ar_tipview01'])
    expect(currentView()?.view.summary).toBe('2 listed')
  })

  it('names the creation open in place first, then the list', async () => {
    await mount('#/artifacts/ar_older01')
    expect(refs()).toEqual(['artifact ar_older01', 'artifact ar_harbour01', 'artifact ar_tipview01'])
  })

  it('tells the Ask nothing once the page is gone', async () => {
    await mount('#/artifacts')
    expect(refs()).toHaveLength(2)
    await act(async () => page.root.render(<></>))
    expect(currentView()).toBeNull()
  })
})
