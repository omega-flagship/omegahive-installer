// @vitest-environment node
// Purpose: a mind's statement reaching the open stage (screens/arrange/StageHost.tsx): one stage frame from the hive is
// said to the stage and drawn in that event, the mind that said it brought along; what was said before the page opened
// is not replayed; and after a dropped socket exactly the statements the page missed are, once each. INVENTED ids.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import type { HiveEvent, StageSaid } from '../../api/types'
import { hiveBus, useHive } from '../../store/store'
import { mountPage, settle, type MountedPage } from '../../features/views/mountedView.testkit'
import { bindPerson } from './arrange'
import { StageHost } from './StageHost'

// the arranging loads with the first statement; loaded here first, so each test waits only on its own frames
await import('./StageView')

const photo = 'ar_photo01'
const words = 'ar_words01'
const old = 'ar_old01'
const rows: Record<string, { kind: string; title: string }> = {
  [photo]: { kind: 'image', title: 'Harbour at dusk' }, [words]: { kind: 'note', title: 'My description' }, [old]: { kind: 'image', title: 'Last week' },
}
const said = (seq: number, say: StageSaid['say'], ...keys: string[]): StageSaid => ({ principal: 'user:u_ada', seq, agent_id: 'a_vega01', say,
  items: keys.map((key) => ({ key, source: 'artifact', stored: rows[key].kind })), task: null })
let log: StageSaid[] = []
const client = {
  me: () => Promise.resolve({ principal: 'user:u_ada', kind: 'sso', role: 'member', expires_at: 0, person: { id: 'u_ada', email: null, name: 'Ada' } }),
  myStage: (after: number) => Promise.resolve(log.filter((s) => s.seq > after)),
  artifact: (id: string) => Promise.resolve({ artifact_id: id, kind: rows[id].kind, title: rows[id].title, swarm_id: 's1', mind_id: 'a_vega01', revision: 1, digest: `sha256:${'d'.repeat(64)}`, created_at: '2026-11-15T00:00:00Z', revised_at: null }),
  creationText: (id: string) => Promise.resolve({ artifact_id: id, kind: rows[id].kind, title: rows[id].title, swarm_id: 's1', revision: 1, digest: `sha256:${'d'.repeat(64)}`, body: 'Low sun on the water.', created_at: '2026-11-15T00:00:00Z' }),
}

let page: MountedPage
const g = globalThis as unknown as Record<string, unknown>
beforeEach(async () => {
  page = await mountPage()
  Object.assign(g.window as Record<string, unknown>, { innerWidth: 1440, innerHeight: 900 })
  g.requestAnimationFrame = (f: (t: number) => void) => { f(0); return 1 }
  g.cancelAnimationFrame = () => undefined
  bindPerson(null)
  // a statement from before this page opened
  log = [said(4, 'show', old)]
  useHive.setState({ client: client as never, resyncs: 0, agents: { a_vega01: { id: 'a_vega01', name: 'Vega', hue: 200, status: 'awake' } } as never })
})
afterEach(async () => {
  await page.restore()
  useHive.setState({ client: null as never, agents: {} })
  bindPerson(null)
})

const drawn = (key: string) => page.container.findAll((n) => n.getAttribute('data-stage-item') === key)[0]
const frame = (s: StageSaid) => ({ type: 'stage.said', at: '2026-11-15T00:00:00Z', ...s }) as HiveEvent
const host = async () => {
  await act(async () => page.root.render(<StageHost />))
  await settle()
}

describe('a mind’s statement reaches the open stage', () => {
  it('draws what one frame shows, in that event, with the mind that showed it known to the stage', async () => {
    await host()
    expect(drawn(old)).toBeUndefined()
    await act(async () => hiveBus.emit(frame(said(5, 'show', photo))))
    await settle()
    expect(drawn(photo)).toBeDefined()
    expect(page.container.textContent).toContain('Harbour at dusk')
    // the frame names the mind that showed it, so the task it holds brings it beside what it showed
    await act(async () => hiveBus.emit(frame({ ...said(6, 'show', words), task: 'g_tip01' })))
    await settle()
    const mind = drawn('a_vega01')
    expect(mind?.getAttribute('data-stage-role')).toBe('beside')
    expect(mind?.textContent).toContain('Vega')
  })

  it('replays exactly what a dropped socket missed, once each, and never what came before the page', async () => {
    await host()
    log.push(said(5, 'show', photo), said(6, 'compare', photo, words))
    await act(async () => useHive.setState({ resyncs: 1 }))
    await settle()
    // the compare is the newest anchor: the photo over its description, the older statement never drawn
    expect(drawn(photo)).toBeDefined()
    expect(drawn(words)).toBeDefined()
    expect(drawn(old)).toBeUndefined()
    // the same frame arriving late changes nothing
    await act(async () => hiveBus.emit(frame(said(5, 'show', photo))))
    await settle()
    expect(drawn(words)).toBeDefined()
  })
})
