import { describe, expect, it } from 'vitest'
import { ARM_MS, began, canActivate, initialGate, keyUp, settled, shown, type Activation, type GateState } from './gate'

/**
 * A small model of Needs.tsx's wiring around the gate: the queue's top is shown (layout effect) whenever it changes,
 * every activation is bound to the card it was aimed at, a decision is in flight until the hive answers, and the
 * hive's answer removes the request before the in-flight flag clears (as the store does: set, then finally).
 */
class Desk {
  gate: GateState = initialGate
  t = 0
  decided: { id: string; d: string }[] = []
  constructor(public queue: string[]) {
    this.show()
  }
  show() {
    this.gate = shown(this.gate, this.queue[0] ?? null, this.t)
  }
  at(t: number) {
    this.t = t
    return this
  }
  /** A key pressed on the card for `bound` (default: the card on top). */
  key(k: string, opts: { repeat?: boolean; bound?: string } = {}) {
    const e: Activation = { kind: 'key', key: k, repeat: !!opts.repeat, at: this.t, boundId: opts.bound ?? this.queue[0] }
    return this.fire(e, k === 'l' ? 'later' : k === 'n' ? 'no' : 'yes')
  }
  click(d: 'yes' | 'no' | 'later', bound?: string) {
    return this.fire({ kind: 'pointer', at: this.t, boundId: bound ?? this.queue[0] }, d)
  }
  private fire(e: Activation, d: string) {
    const v = canActivate(this.gate, e)
    if (!v.ok) return v.why
    this.gate = began(this.gate, e, d !== 'later')
    if (d === 'later') {
      this.queue = [...this.queue.filter((x) => x !== e.boundId), e.boundId]
      this.show()
    } else this.decided.push({ id: e.boundId, d })
    return 'ok'
  }
  up() {
    this.gate = keyUp(this.gate)
  }
  /** The hive answers for `id`: it leaves the queue, the next is shown, then the in-flight flag clears. */
  answer(id: string, ok = true) {
    if (ok) this.queue = this.queue.filter((x) => x !== id)
    this.show()
    this.gate = settled(this.gate, id)
  }
  arrive(id: string, first = false) {
    this.queue = first ? [id, ...this.queue] : [...this.queue, id]
    this.show()
  }
}

describe('R3: one intended decision never authorises two requests', () => {
  it('a held Y approves only the first request, whatever the repeat flag says', () => {
    const k = new Desk(['A-rm-rf-tmp', 'B-send-funds'])
    expect(k.at(1000).key('y')).toBe('ok')
    k.at(1040).answer('A-rm-rf-tmp')
    // auto-repeat for two seconds at 30 Hz, flagged as repeat
    for (let t = 1060; t < 3000; t += 33) expect(k.at(t).key('y', { repeat: true })).toBe('repeat')
    // a platform that does not flag repeats: still refused until the key goes up
    for (let t = 1060; t < 3000; t += 33) expect(['held', 'arming']).toContain(k.at(t).key('y'))
    expect(k.decided).toEqual([{ id: 'A-rm-rf-tmp', d: 'yes' }])
    // released, read, pressed again on purpose: that is a fresh decision for B
    k.up()
    expect(k.at(3100).key('y')).toBe('ok')
    expect(k.decided.map((x) => x.id)).toEqual(['A-rm-rf-tmp', 'B-send-funds'])
  })

  it('a held Enter on the Yes button is the same as a held Y', () => {
    const k = new Desk(['A', 'B'])
    expect(k.at(1000).key('enter')).toBe('ok')
    k.at(1010).answer('A')
    for (let t = 1020; t < 2500; t += 33) expect(k.at(t).key('enter', { repeat: t > 1500 })).not.toBe('ok')
    expect(k.decided.map((x) => x.id)).toEqual(['A'])
  })

  it('rapid separate presses: the second lands in the arm interval of the next card and is refused', () => {
    const k = new Desk(['A', 'B', 'C'])
    expect(k.at(1000).key('y')).toBe('ok')
    k.up()
    k.at(1030).answer('A')
    for (const t of [1060, 1120, 1300, 1030 + ARM_MS - 1]) {
      expect(k.at(t).key('y')).toBe('arming')
      k.up()
    }
    expect(k.decided.map((x) => x.id)).toEqual(['A'])
    // after the interval, a fresh press counts (the person had the time to see B)
    expect(k.at(1030 + ARM_MS).key('y')).toBe('ok')
    expect(k.decided.map((x) => x.id)).toEqual(['A', 'B'])
  })

  it('busy spans cards: while A is in flight nothing reaches A or the request that takes its place', () => {
    const k = new Desk(['A'])
    expect(k.at(1000).click('yes')).toBe('ok')
    expect(k.at(1100).click('yes')).toBe('busy')
    expect(k.at(1100).click('no')).toBe('busy')
    // a new request arrives first in line while A is still waiting on the hive
    k.at(1200).arrive('B', true)
    expect(k.at(1200 + ARM_MS + 50).click('yes')).toBe('busy')
    // slow server answers; B is now on top
    k.at(5000).answer('A')
    expect(k.at(5000 + ARM_MS).click('yes')).toBe('ok')
    expect(k.decided.map((x) => x.id)).toEqual(['A', 'B'])
  })

  it('a refused or failed decision clears busy (finally) and the same request can be answered again', () => {
    const k = new Desk(['A', 'B'])
    expect(k.at(1000).click('yes')).toBe('ok')
    k.at(1500).answer('A', false)
    expect(k.queue[0]).toBe('A')
    expect(k.at(1600).click('yes')).toBe('ok')
  })

  it('a new arrival at the top: a press aimed at the old card is stale, at the new one is arming', () => {
    const k = new Desk(['A'])
    k.at(5000).arrive('B', true)
    expect(k.at(5010).key('y', { bound: 'A' })).toBe('stale')
    expect(k.at(5010).key('y', { bound: 'B' })).toBe('arming')
    expect(k.decided).toEqual([])
  })

  it('a reorder (later, or a queue update) re-arms, and the person must look again', () => {
    const k = new Desk(['A', 'B'])
    expect(k.at(2000).key('l')).toBe('ok')
    expect(k.queue).toEqual(['B', 'A'])
    k.up()
    expect(k.at(2100).key('y')).toBe('arming')
    // a held L after "later" does not cycle the queue either
    const j = new Desk(['A', 'B', 'C'])
    expect(j.at(2000).key('l')).toBe('ok')
    expect(j.at(2000 + ARM_MS + 10).key('l', { repeat: true })).toBe('repeat')
    expect(j.at(2000 + ARM_MS + 10).key('l')).toBe('held')
    expect(j.queue).toEqual(['B', 'C', 'A'])
  })

  it('pointer and assistive clicks need no keyup but do honour arming, busy and binding', () => {
    const k = new Desk(['A', 'B'])
    expect(k.at(100).click('yes')).toBe('arming')
    expect(k.at(1000).click('yes')).toBe('ok')
    k.at(1100).answer('A')
    expect(k.at(1200).click('yes')).toBe('arming')
    expect(k.at(1100 + ARM_MS).click('yes', 'A')).toBe('stale')
    expect(k.at(1100 + ARM_MS).click('yes')).toBe('ok')
  })

  it('the queue becoming empty leaves nothing to activate', () => {
    const k = new Desk(['A'])
    k.at(1000).click('yes')
    k.at(1100).answer('A')
    expect(k.gate.currentId).toBeNull()
    expect(k.at(9000).click('yes', 'A')).toBe('stale')
  })
})
