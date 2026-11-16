import { describe, expect, it } from 'vitest'
import { cardHeight } from './askMeasure'

/**
 * The room the Ask reports (--ask-room, askRoom) starts from its dock's measured height. On a phone Classic lifts its
 * answerer chips 6px above the capsule (autoWake.css), outside the capsule's own box, so the height reaches up to them:
 * otherwise the last row of a page or sheet, and the activity ticker, sat under "Answering: Vega". Rects are made up.
 */
const rect = (top: number, bottom: number) => ({ top, bottom, height: bottom - top, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) }) as DOMRect
const dock = (own: DOMRect, lifted: DOMRect[] = []) =>
  ({ getBoundingClientRect: () => own, querySelectorAll: () => lifted.map((p) => ({ getBoundingClientRect: () => p })) }) as unknown as HTMLElement

describe('the Ask dock’s measured height', () => {
  it('is its capsule when nothing sits above it', () => {
    expect(cardHeight(dock(rect(700, 760)))).toBe(60)
  })

  it('reaches up to the answerer chips it lifts above the capsule', () => {
    expect(cardHeight(dock(rect(700, 760), [rect(658, 694)]))).toBe(102)
  })

  it('leaves out a lifted part that is not shown, and one that sits inside the capsule', () => {
    expect(cardHeight(dock(rect(700, 760), [rect(0, 0)]))).toBe(60)
    expect(cardHeight(dock(rect(700, 760), [rect(710, 730)]))).toBe(60)
  })
})
