// GuideLayer's "under a modal" probe (Surface D4 r2; the fix from D4 r1's smoke). A small model of the page plays what
// happens when the Ask's own sheet goes modal during a guided demo: modal containment makes every body-level layer
// outside it inert (its MutationObserver marks a newly mounted one at once), and GuideLayer renders its caption only
// while it is NOT under a modal (its useSyncExternalStore re-reads the probe on every mutation). With the probe on the
// always-mounted live region the page settles; probed on the caption itself it never does (the frozen page).
import { describe, expect, it } from 'vitest'
import { GUIDE_PROBE, guideUnderModal } from './underModal'
import { askUnderModal } from '../ask/placement'

interface El {
  sel: string
  inert: boolean
  closest(sel: string): El | null
}
const el = (sel: string): El => {
  const e: El = { sel, inert: false, closest: (s) => (s === '[inert]' && e.inert ? e : null) }
  return e
}

/** The page: the demo's live region (always mounted), its caption (mounted by GuideLayer), and the Ask's sheet. */
function page() {
  const live = el('.guide-live')
  const caption = el('.guide-caption')
  const state = { captionMounted: true, askSheetModal: false }
  const doc = {
    querySelector(sel: string): El | null {
      if (sel === '.guide-live') return live
      if (sel === '.guide-caption') return state.captionMounted ? caption : null
      // the Ask's own sheet is aria-modal with data-ask-own, so this selector never matches it
      if (sel === '[aria-modal="true"]:not([data-ask-own])') return null
      return null
    },
  }
  /** modal containment: while the Ask's sheet is modal, every body-level layer outside it is inert */
  const contain = () => {
    live.inert = state.askSheetModal
    caption.inert = state.askSheetModal && state.captionMounted
  }
  return { doc, state, contain }
}

/**
 * Play the observer loop: each round GuideLayer reads the probe and mounts or unmounts its caption, and containment
 * reacts to that mutation. Returns how many rounds it took to settle, or Infinity if it never did within `cap` rounds.
 */
function settle(probe: (doc: Pick<Document, 'querySelector'>) => boolean, cap = 50): number {
  const p = page()
  p.state.askSheetModal = true
  p.contain()
  for (let round = 1; round <= cap; round++) {
    const under = probe(p.doc as unknown as Pick<Document, 'querySelector'>)
    const mount = !under
    if (mount === p.state.captionMounted) return round
    p.state.captionMounted = mount
    p.contain()
  }
  return Infinity
}

describe('GuideLayer’s under-a-modal probe', () => {
  it('reads the always-mounted live region', () => {
    expect(GUIDE_PROBE).toBe('.guide-live')
  })

  it('settles when the Ask’s sheet goes modal during a demo: the caption is hidden and stays hidden', () => {
    expect(settle(guideUnderModal)).toBeLessThanOrEqual(2)
  })

  it('(control) probed on the caption itself, the same page never settles: the loop that froze it', () => {
    const onCaption = (doc: Pick<Document, 'querySelector'>) => askUnderModal(doc, doc.querySelector('.guide-caption'))
    expect(settle(onCaption)).toBe(Infinity)
  })

  it('no modal: not under one, and the caption stays', () => {
    const p = page()
    p.contain()
    expect(guideUnderModal(p.doc as unknown as Pick<Document, 'querySelector'>)).toBe(false)
  })
})
