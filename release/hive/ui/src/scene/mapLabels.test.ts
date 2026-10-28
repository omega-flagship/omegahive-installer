import { describe, expect, it } from 'vitest'
import { mapLabelBoxes, setMapLabelReader, swarmLabelBox } from './mapLabels'
import { placeHint } from '../tour/place'

/**
 * Platform sweep, phone hive 390x844: the first-visit hint covered the DRIFTWOOD label on the star map. The map's
 * swarm labels are canvas text, so they are given to the hint placer as boxes it stays off. INVENTED geometry.
 */
describe('the star map’s swarm labels as boxes', () => {
  it('a label box covers both drawn lines (name at core + 70·z^0.8 + 8, stats 16 px under it), centred on the core', () => {
    const b = swarmLabelBox(200, 600, 1, 'DRIFTWOOD', '0 beliefs · 2 minds')
    const nameTop = 600 + 70 + 8
    expect(b.top).toBeLessThanOrEqual(nameTop)
    expect(b.top + b.height).toBeGreaterThanOrEqual(nameTop + 16 + 10)
    expect(b.left + b.width / 2).toBeCloseTo(200)
    expect(b.width).toBeGreaterThanOrEqual('DRIFTWOOD'.length * 10)
  })
  it('the hint placer keeps a phone hint off the label (it took the free band, or waits)', () => {
    const label = swarmLabelBox(195, 620, 1, 'DRIFTWOOD', '0 beliefs · 2 minds')
    const anchor = { left: 332, top: 185, width: 44, height: 44 }
    const p = placeHint(anchor, { width: 300, height: 62 }, { width: 390, height: 844 }, [anchor, label], null, 120)
    const overlaps = p.left < label.left + label.width && label.left < p.left + p.width && p.top < label.top + label.height && label.top < p.top + p.height
    expect(p.covers === -1 || !overlaps).toBe(true)
    // the same layout without the label box (before): the free band it took would have been over the label's place
    const before = placeHint(anchor, { width: 300, height: 62 }, { width: 390, height: 844 }, [anchor], null, 120)
    expect(before.covers).toBe(0)
  })
  it('the live scene’s reader is used while registered; none or a failing one gives no boxes', () => {
    expect(mapLabelBoxes()).toEqual([])
    setMapLabelReader(() => [{ left: 1, top: 2, width: 3, height: 4 }])
    expect(mapLabelBoxes()).toEqual([{ left: 1, top: 2, width: 3, height: 4 }])
    setMapLabelReader(() => { throw new Error('gone') })
    expect(mapLabelBoxes()).toEqual([])
    setMapLabelReader(null)
  })
})
