import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Guided demos and a change of person (stand-in r1 P1 x2), on the REAL store identity change (lib/identityEpoch
// testkit: synthetic SimClients, invented data only, no hive). A demo, finished, stopped or still playing, is gone
// the moment someone else is signed in; what it captured to put back for the earlier person is discarded, never run.

const loc = { hash: '#/', search: '' }
vi.stubGlobal('window', { location: loc, matchMedia: () => ({ matches: false }), innerWidth: 1440, innerHeight: 900, addEventListener: () => undefined, removeEventListener: () => undefined })
const clicks: string[] = []
const menu = { expanded: 'false' }
const menuEl = {
  getAttribute: (k: string) => (k === 'aria-expanded' ? menu.expanded : null),
  click: () => {
    clicks.push(`click:${menu.expanded}`)
    menu.expanded = menu.expanded === 'true' ? 'false' : 'true'
  },
}
vi.stubGlobal('document', { querySelector: () => menuEl, documentElement: { style: { removeProperty: () => undefined, setProperty: () => undefined }, dataset: {} } })
vi.stubGlobal('CSS', { escape: (s: string) => s })

const { useGuide, liveEnv } = await import('./store')
const { reduceGuide, startMachine } = await import('./machine')
const { guidedIntent } = await import('./match')
const { lookState, previewLook } = await import('../../shell/uiVariant')
const { releasePersons, signInAs, switchPerson, testPerson } = await import('../../lib/identityEpoch.testkit')
type AskOrigin = import('../../store/ask').AskOrigin

beforeEach(() => {
  useGuide.getState().close()
  previewLook(null)
  clicks.length = 0
  menu.expanded = 'false'
  loc.hash = '#/'
})
afterEach(() => {
  useGuide.getState().close()
  previewLook(null)
  releasePersons()
})

/** Start a ready demo as the current person and play it to `until` (each step shown, then Next/Stop). */
async function playLab(until: 'done' | 'stopped'): Promise<string[]> {
  expect(await useGuide.getState().start(guidedIntent('walk me through the lab')!, { you: 'walk me through the lab' })).toBe(true)
  for (let i = 0; i < 20; i++) {
    const r = useGuide.getState().run
    if (r?.kind !== 'demo' || r.m.status === 'ended') break
    useGuide.getState().stepDone(r.m.token, { found: true, note: null })
    useGuide.getState().send({ type: until === 'stopped' && i === 1 ? 'stop' : 'next' })
  }
  const r = useGuide.getState().run
  if (r?.kind !== 'demo') throw new Error('no demo')
  expect([r.m.status, r.m.ended]).toEqual(['ended', until])
  expect(r.said.filter(Boolean).length).toBeGreaterThan(0)
  return r.said
}

describe('guided demos: a change of person ends the demo whatever its status', () => {
  for (const until of ['done', 'stopped'] as const) {
    it(`after ${until === 'done' ? 'Finish' : 'Stop'}: the earlier person's transcript is gone at once, and stays gone`, async () => {
      const a = testPerson('a')
      const b = testPerson('b')
      await signInAs(a)
      await playLab(until)
      const done = switchPerson(a, b)
      // synchronously, inside the change: the thread card (GuideCard renders run.said) has nothing to show
      expect(useGuide.getState().run).toBeNull()
      await done
      expect(useGuide.getState().run).toBeNull()
    }, 70000)   // followups-r6: measured worst 23101 ms (caps lifted; 1 and 3 workers, load to 9.3), about 3x

    it(`after ${until === 'done' ? 'Finish' : 'Stop'}, a re-login on the same tab (credential only) clears it too`, async () => {
      const a = testPerson('a')
      const b = testPerson('b', { sameTab: a })
      await signInAs(a)
      await playLab(until)
      const done = switchPerson(a, b)
      expect(useGuide.getState().run).toBeNull()
      await done
    }, 40000)   // followups-r6: measured worst 12624 ms (caps lifted; 1 and 3 workers, load to 9.3), about 3x
  }

  it('the fence itself (the layer’s check) ends a finished or stopped demo, not only a playing one', async () => {
    for (const until of ['done', 'stopped'] as const) {
      const ended = { ...startMachine(3), status: 'ended' as const, ended: until }
      expect(reduceGuide(ended, { type: 'fenced' })).toMatchObject({ status: 'ended', ended: 'fenced' })
      const a = testPerson(`a-${until}`)
      await signInAs(a)
      await playLab(until)
      const r = useGuide.getState().run
      if (r?.kind !== 'demo') throw new Error('no demo')
      // the Ask origin no longer holds (e.g. the thread was reset): the layer's check sends `fenced`
      const gone: AskOrigin = { ...r.origin, ok: () => false }
      useGuide.setState({ run: { ...r, origin: gone } })
      useGuide.getState().send({ type: 'fenced' })
      expect(useGuide.getState().run).toBeNull()
      releasePersons()
    }
  }, 60000)   // followups-r6: measured worst 19914 ms (caps lifted; 1 and 3 workers, load to 9.3), about 3x
})

describe('guided demos: what the demo captured for the earlier person is discarded, never run', () => {
  it('a person switch during an experience preview: the earlier person’s preview is not put back, no control is pressed', async () => {
    const a = testPerson('a')
    const b = testPerson('b')
    await signInAs(a)
    // A's own preview before the demo
    const mine = { variant: null, layout: 'topbar' as const, apps: null, experience: null }
    previewLook(mine)
    expect(await useGuide.getState().start(guidedIntent('show me how swapping experiences works')!, { you: 'x' })).toBe(true)
    liveEnv.experience('still')
    liveEnv.press('omega-menu', true)
    expect(lookState().preview?.experience).toBe('still')
    expect(clicks).toEqual(['click:false'])
    const done = switchPerson(a, b)
    // synchronously: the demo's preview is gone, and A's captured one is not restored for B
    expect(lookState().preview).toBeNull()
    expect(clicks).toEqual(['click:false'])
    expect(useGuide.getState().run).toBeNull()
    await done
    // whatever the layer does next (its fence check, a Close) has nothing left to put back
    useGuide.getState().send({ type: 'fenced' })
    useGuide.getState().close()
    expect(lookState().preview).toBeNull()
    expect(clicks).toEqual(['click:false'])
    // and a new demo for B captures B's own state afresh
    expect(await useGuide.getState().start(guidedIntent('show me how swapping experiences works')!, { you: 'x' })).toBe(true)
    liveEnv.experience('cosmos')
    useGuide.getState().close()
    expect(lookState().preview).toBeNull()
  }, 40000)   // followups-r6: measured worst 13094 ms (caps lifted; 1 and 3 workers, load to 9.3), about 3x
})
