// Purpose: verify the thread report's detach rule (askRoom.ts threadReporter): the stage keeps clear of the thread the
// Ask draws now, even while the placement it replaced is still fading out, and of nothing once the thread is gone.
import { describe, expect, it } from 'vitest'
import { useScene } from '../../scene/sceneStore'
import { threadReporter } from './askRoom'

/** A stand-in for a drawn thread: its box, and whether it is still on the page. */
const node = (left: number, top: number, right: number, bottom: number) => {
  const n = { isConnected: true, getBoundingClientRect: () => ({ left, top, right, bottom, width: right - left, height: bottom - top }) as DOMRect }
  return n
}
const settled = () => new Promise<void>((r) => queueMicrotask(r))

describe('the Ask’s thread, reported to the stage', () => {
  it('a placement fading out after the next came in never clears the next one’s report; the last one gone clears it', async () => {
    const r = threadReporter()
    // the bubble's thread rising above the field
    const rise = node(440, 400, 1000, 818)
    r.ref(rise)
    expect(useScene.getState().askThread).toEqual({ left: 440, top: 400, right: 1000, bottom: 818 })
    // the person widens the Ask to half: the column comes in while the rising thread still fades out (AnimatePresence)
    const half = node(60, 12, 726, 818)
    r.ref(half)
    expect(useScene.getState().askThread).toEqual({ left: 60, top: 12, right: 726, bottom: 818 })
    // the rising thread's exit ends: it leaves the page, and its detach arrives as a bare null
    rise.isConnected = false
    r.ref(null)
    await settled()
    expect(useScene.getState().askThread).toEqual({ left: 60, top: 12, right: 726, bottom: 818 })
    // the column goes too (collapsed to the mark): nothing is drawn, so the stage has the whole screen again
    half.isConnected = false
    r.ref(null)
    await settled()
    expect(useScene.getState().askThread).toBeNull()
  })
})
