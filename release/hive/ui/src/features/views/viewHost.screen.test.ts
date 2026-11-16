import { describe, expect, it, vi } from 'vitest'
import { screensSpace } from '../../screens/screenSpace'

vi.setConfig({ testTimeout: 20_000 })

// What surrounds a view a mind wrote in MeTTa (views.metta), composed by MeTTa from the facts MettaFrame states.
const drawn = (flags: Record<string, boolean>, look = 'classic') =>
  screensSpace().compose('view-host', look, { flags }).parts.map((p) => `${p.order}:${p.block}`)

describe('around a view a mind wrote in MeTTa', () => {
  it('shows the view once drawn, says why when it is not, and offers to start it again when it stopped', () => {
    expect(drawn({ 'view.starting': true })).toEqual(['10:waiting'])
    expect(drawn({ 'view.drawn': true })).toEqual(['60:island', '80:note'])
    expect(drawn({ 'view.drawn': true, 'view.slipped': true })).toEqual(['60:island', '70:notice', '80:note'])
    expect(drawn({ 'view.broken': true })).toEqual(['20:notice', '80:note'])
    expect(drawn({ 'view.stopped': true })).toEqual(['30:notice', '40:actions', '80:note'])
    expect(drawn({ 'view.unsafe': true })).toEqual(['50:notice'])
    // a look of rooms and light draws the same parts
    expect(drawn({ 'view.drawn': true }, 'cosmos')).toEqual(['60:island', '80:note'])
  })

  it('asks before a view runs and before an HTML view reaches its domains, and says when an answer failed', () => {
    const composed = (screen: string, asks: number, failed = false) =>
      screensSpace().compose(screen, 'classic', { counts: { 'view.asks': asks }, flags: { 'view.failed': failed } }).parts.map((p) => `${p.order}:${p.block}`)
    expect(composed('view-run', 0)).toEqual(['10:paragraph', '30:actions'])
    expect(composed('view-run', 2)).toEqual(['10:paragraph', '20:note', '30:actions'])
    expect(composed('view-run', 0, true)).toEqual(['10:paragraph', '30:actions', '40:notice'])
    expect(composed('view-reach', 0)).toEqual([])
    expect(composed('view-reach', 1)).toEqual(['10:notice', '20:actions'])
    expect(composed('view-reach', 1, true)).toEqual(['10:notice', '20:actions', '30:notice'])
  })

  it('every part can be reached by some state', () => {
    const reached = new Set(['starting', 'drawn', 'broken', 'stopped', 'unsafe', 'slipped'].flatMap((s) =>
      drawn({ [`view.${s}`]: true, 'view.drawn': s === 'slipped' || s === 'drawn' }).map((p) => Number(p.split(':')[0]))))
    expect([...reached].sort((a, b) => a - b)).toEqual(screensSpace().orders('view-host'))
  })
})
