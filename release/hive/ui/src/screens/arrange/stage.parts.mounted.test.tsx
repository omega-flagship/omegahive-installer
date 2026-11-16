// @vitest-environment node
// Purpose: the open page's composed parts on the stage (screens/openScreens.ts, Screen.tsx, StageView.tsx): a part never
// in view with a task vanishes when something is shown in it; once the person is back on the page after a statement in
// that task, its parts have been in view with it, and the next thing shown in the task brings them beside it, drawn by the
// block that draws them on the page and acting through the page's host; an island and a screen inside a view never take
// part. INVENTED screens, ids and words.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { useHive } from '../../store/store'
import { mountPage, settle, type MountedPage } from '../../features/views/mountedView.testkit'
import { press } from '../../ui/miniDom.testkit'
import { NotThePage } from '../openScreens'
import { Screen, type ScreenHost } from '../Screen'
import type { DrawnPart, ScreenPlan } from '../plan'
import { bindPerson, say } from './arrange'
import type { ArrangeItem } from './arrangeSpace'
import StageView from './StageView'

const part = (order: number, block: string, props: Record<string, unknown>): DrawnPart =>
  ({ order, block, how: { kind: 'direct' }, props, depth: { layer: 'surface', z: 1 }, place: { region: 'main', row: null } }) as DrawnPart
const page: ScreenPlan = { screen: 'shopping', look: 'classic', space: 'flat', title: 'Shopping', missing: [], parts: [
  part(10, 'header', { title: 'Shopping' }),
  part(20, 'actions', { items: [['action', 'Add limes', 'add-limes']] }),
  part(30, 'island', { name: 'basket' }),
] }
const photo = 'ar_photo01'
const sketch = 'ar_sketch01'
const art = (key: string): ArrangeItem => ({ key, source: 'artifact', stored: 'image' })
const client = {
  artifact: (id: string) => Promise.resolve({ artifact_id: id, kind: 'image', title: 'Harbour', swarm_id: 's1', mind_id: null, revision: 1, digest: 'x', created_at: '', revised_at: null }),
  creationText: () => Promise.resolve({ body: '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="3"/>' }),
}

let mounted: MountedPage
let pressed: string[] = []
const host: ScreenHost = { data: {}, onAction: (a) => { pressed.push(a) }, islands: { basket: <div data-basket="">basket</div> } }
const g = globalThis as unknown as Record<string, unknown>
beforeEach(async () => {
  mounted = await mountPage()
  Object.assign(g.window as Record<string, unknown>, { innerWidth: 1440, innerHeight: 900 })
  g.requestAnimationFrame = (f: (t: number) => void) => { f(0); return 1 }
  pressed = []
  useHive.setState({ client: client as never })
  bindPerson(null)
  bindPerson('p_parts')
})
afterEach(async () => {
  await mounted.restore()
  useHive.setState({ client: null as never })
  bindPerson(null)
})

const draw = async () => {
  await act(async () => mounted.root.render(<><Screen plan={page} host={host} /><StageView /></>))
  await settle()
}
const drawn = (key: string) => mounted.container.findAll((n) => n.getAttribute('data-stage-item') === key)[0]

describe('the open page’s parts on the stage', () => {
  it('vanish while never in view with the task, and come back beside the next thing shown in it, drawn by their own block', async () => {
    say({ say: 'show', key: photo, task: 'g_tip01' }, [art(photo)])
    await draw()
    expect(drawn(photo)).toBeDefined()
    expect(drawn('p_shopping_20')).toBeUndefined()
    // the person puts the stage away and is on the page again: its parts are in view with the task
    say({ say: 'clear' })
    await draw()
    say({ say: 'show', key: sketch, task: 'g_tip01' }, [art(sketch)])
    await draw()
    const beside = drawn('p_shopping_20')
    expect(beside?.getAttribute('data-stage-role')).toBe('beside')
    // brought beside it, the part is drawn whole by its block, and its press goes to the page
    await act(async () => press(mounted.container.findAll((n) => n.getAttribute('data-stage-beside') === 'p_shopping_20')[0]))
    await settle()
    const button = drawn('p_shopping_20')!.findAll((n) => n.tagName === 'BUTTON' && n.textContent === 'Add limes')[0]
    await act(async () => press(button))
    expect(pressed).toEqual(['add-limes'])
  })

  it('never takes an island, the page’s own component with its own state, nor a screen inside a view', async () => {
    say({ say: 'show', key: photo, task: 'g_tip01' }, [art(photo)])
    say({ say: 'clear' })
    await act(async () => mounted.root.render(<><Screen plan={page} host={host} /><NotThePage.Provider value={true}><Screen plan={{ ...page, screen: 'inview' }} host={host} /></NotThePage.Provider><StageView /></>))
    await settle()
    say({ say: 'show', key: sketch, task: 'g_tip01' }, [art(sketch)])
    await settle()
    expect(drawn('p_shopping_30')).toBeUndefined()
    expect(mounted.container.findAll((n) => (n.getAttribute('data-stage-item') ?? '').startsWith('p_inview_'))).toHaveLength(0)
    expect(drawn('p_shopping_10')?.getAttribute('data-stage-role')).toBe('beside')
  })
})
