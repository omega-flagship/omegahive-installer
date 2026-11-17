// Purpose: verify thread.metta's ask-stopped screen: in every look, Continue is composed under a request only when it ended
// before its answer, is the thread's latest request and is still kept, worded by MeTTa as the action continue.
import { describe, expect, it, vi } from 'vitest'
import { ScreensSpace } from '../../screens/screenSpace'

vi.setConfig({ testTimeout: 20_000 })

const space = ScreensSpace.open()
const facts = (early: boolean, latest: boolean, kept: boolean) => ({ flags: { 'ask.ended-early': early, 'ask.latest': latest, 'ask.kept': kept } })

describe('the way on from a request that stopped (Haley, 17 Nov: "please have a \'continue task\' button")', () => {
  it('in every look, Continue only under the latest request that ended before its answer while it is kept', () => {
    for (const look of space.looks()) {
      const plan = space.compose('ask-stopped', look, facts(true, true, true))
      expect(plan.parts.map((p) => p.block), look).toEqual(['actions'])
      expect(plan.parts[0].props.items, look).toEqual([['action', 'Continue', 'continue']])
      for (const [early, latest, kept] of [[true, true, false], [true, false, true], [false, true, true], [false, false, false]] as const) {
        expect(space.compose('ask-stopped', look, facts(early, latest, kept)).parts, `${look} early=${early} latest=${latest} kept=${kept}`).toEqual([])
      }
    }
  })
})
