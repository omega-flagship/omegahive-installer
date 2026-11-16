import { describe, expect, it } from 'vitest'
import { noteRefusal, takeRefusal } from './approvalRefusal'

/** r1.2 (Kimi r1.1 #3): a refusal's words belong to the dialog that sent the answer. INVENTED ids. */
describe('refusal words are keyed by request AND dialog', () => {
  it('two dialogs on one request never take each other’s words', () => {
    const a = {}, b = {}
    noteRefusal('ap_invented', 'words for A', a)
    expect(takeRefusal('ap_invented', b)).toBeNull()
    expect(takeRefusal('ap_invented', a)).toBe('words for A')
    expect(takeRefusal('ap_invented', a)).toBeNull() // taken once
  })
  it('an answer sent without an origin notes nothing', () => {
    const a = {}
    noteRefusal('ap_invented', 'nobody asked', undefined)
    expect(takeRefusal('ap_invented', a)).toBeNull()
  })
  it('one dialog, two requests: each its own words', () => {
    const a = {}
    noteRefusal('ap_1', 'one', a); noteRefusal('ap_2', 'two', a)
    expect(takeRefusal('ap_2', a)).toBe('two')
    expect(takeRefusal('ap_1', a)).toBe('one')
  })
})
