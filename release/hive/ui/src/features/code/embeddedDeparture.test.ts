import { describe, expect, it } from 'vitest'
import { confirmEmbeddedDeparture, type EmbeddedDraftSnapshot } from './embeddedDeparture'

describe('embedded Code draft departure', () => {
  it('leaves a clean current bench without confirmation', async () => {
    let questions = 0; let left = 0
    const draft = { path: 'a.py', text: 'saved', dirty: false }
    expect(await confirmEmbeddedDeparture(() => draft, () => true, async () => { questions++; return true }, () => { left++ })).toBe(true)
    expect(questions).toBe(0); expect(left).toBe(1)
  })
  it('retains a dirty draft on Cancel', async () => {
    let left = false
    expect(await confirmEmbeddedDeparture(() => ({ path: 'a.py', text: 'draft', dirty: true }), () => true, async () => false, () => { left = true })).toBe(false)
    expect(left).toBe(false)
  })
  it('leaves only the identical confirmed dirty draft', async () => {
    let left = 0
    const draft = { path: 'a.py', text: 'draft', dirty: true }
    expect(await confirmEmbeddedDeparture(() => draft, () => true, async () => true, () => { left++ })).toBe(true)
    expect(left).toBe(1)
  })
  it('rejects confirmation after a newer edit or file switch', async () => {
    for (const changed of [{ path: 'a.py', text: 'newer', dirty: true }, { path: 'b.py', text: 'draft', dirty: true }]) {
      let draft: EmbeddedDraftSnapshot = { path: 'a.py', text: 'draft', dirty: true }; let left = false
      expect(await confirmEmbeddedDeparture(() => draft, () => true, async () => { draft = changed; return true }, () => { left = true })).toBe(false)
      expect(left).toBe(false)
    }
  })
  it('rejects a late confirmation after unmount', async () => {
    const draft = { path: 'a.py', text: 'draft', dirty: true }
    let live = true; let left = false
    let resolve!: (answer: boolean) => void
    const decision = new Promise<boolean>(done => { resolve = done })
    const pending = confirmEmbeddedDeparture(() => draft, () => live, () => decision, () => { left = true })
    expect(left).toBe(false)
    live = false
    resolve(true)
    expect(await pending).toBe(false)
    expect(left).toBe(false)
  })
  it('rejects edit-and-revert while a confirmation is open', async () => {
    let draft: EmbeddedDraftSnapshot = { path: 'a.py', text: 'draft', dirty: true }; let left = false
    expect(await confirmEmbeddedDeparture(() => draft, () => true, async () => { draft = { ...draft }; return true }, () => { left = true })).toBe(false)
    expect(left).toBe(false)
  })
})
