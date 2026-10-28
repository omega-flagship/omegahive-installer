import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** close-home r3: unsent words live per person, apart from the panel; an identity change clears them. Invented data. */

const { releasePersons, signInAs, switchPerson, testPerson } = await import('../lib/identityEpoch.testkit')
const { draftWriter, readDraft, useDrafts } = await import('./drafts')

beforeEach(() => vi.stubGlobal('window', { location: { search: '' } }))
afterEach(() => {
  releasePersons()
  vi.unstubAllGlobals()
})

describe('experience drafts', () => {
  it('keep words per key, independent of any panel; empty words remove the entry', async () => {
    const a = testPerson('a')
    await signInAs(a)
    const set = draftWriter('canvas:mind:a1')
    set('half a thought')
    draftWriter('flux:mind:a1')('elsewhere')
    expect(readDraft('canvas:mind:a1')).toBe('half a thought')
    expect(readDraft('flux:mind:a1')).toBe('elsewhere')
    set((cur) => `${cur}, finished`)
    expect(readDraft('canvas:mind:a1')).toBe('half a thought, finished')
    set('')
    expect('canvas:mind:a1' in useDrafts.getState().drafts).toBe(false)
  })

  it('an identity change clears every draft at once, and a writer bound to the earlier person writes nothing after', async () => {
    const a = testPerson('a')
    const b = testPerson('b')
    await signInAs(a)
    const late = draftWriter('canvas:mind:a1')
    late('for a only')
    const done = switchPerson(a, b)
    expect(readDraft('canvas:mind:a1')).toBe('') // synchronously, before B hydrates
    await done
    late('a failed send puts its words back') // the continuation of A's send, after the await
    expect(readDraft('canvas:mind:a1')).toBe('')
    const bWriter = draftWriter('canvas:mind:a1')
    bWriter('b types')
    expect(readDraft('canvas:mind:a1')).toBe('b types')
  })

  it('A → B → A: back on A, neither B’s words nor any stale writer (A’s first sign-in, or B’s) populate A’s drafts', async () => {
    const a = testPerson('a')
    const b = testPerson('b')
    await signInAs(a)
    const aFirst = draftWriter('canvas:mind:a1')
    aFirst('a, first time')
    await switchPerson(a, b)
    const bWriter = draftWriter('canvas:mind:a1')
    bWriter('b’s private words')
    draftWriter('flux:mind:a1')('b elsewhere')
    expect(readDraft('canvas:mind:a1')).toBe('b’s private words')
    const back = switchPerson(b, a)
    expect(readDraft('canvas:mind:a1')).toBe('') // synchronously, on the change itself
    expect(readDraft('flux:mind:a1')).toBe('')
    await back
    expect(Object.keys(useDrafts.getState().drafts)).toEqual([])
    // late continuations from both earlier bindings: B's, and A's from before the round trip
    bWriter('b’s late failed send')
    bWriter((cur) => `${cur}b appends`)
    aFirst('a’s late failed send from the first sign-in')
    expect(readDraft('canvas:mind:a1')).toBe('')
    expect(Object.keys(useDrafts.getState().drafts)).toEqual([])
    // A, now, writes normally
    draftWriter('canvas:mind:a1')('a again')
    expect(readDraft('canvas:mind:a1')).toBe('a again')
  })
})
