import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** stand-in r4 P2: what one person typed never counts for the next (the identity epoch, as Ask and drafts). Invented data. */

const { releasePersons, signInAs, switchPerson, testPerson } = await import('../lib/identityEpoch.testkit')
const { noteChange, noteEdit, noteRoute, typedWork } = await import('./unsavedWork')

beforeEach(() => vi.stubGlobal('window', { location: { search: '' } }))
afterEach(() => {
  releasePersons()
  vi.unstubAllGlobals()
})

describe('typed work and the identity epoch', () => {
  it('an identity change forgets every typed field and choice, on the page or not, at once', async () => {
    const a = testPerson('a')
    const b = testPerson('b')
    await signInAs(a)
    noteRoute('#/swarms/new')
    const name = { tagName: 'INPUT', type: 'text', value: 'A’s swarm', isConnected: true, closest: () => null }
    const purpose = { tagName: 'TEXTAREA', value: 'A’s purpose', isConnected: false, closest: () => null }
    noteEdit(name)
    noteEdit(purpose)
    noteChange({ tagName: 'SELECT', value: 'ours', isConnected: true, closest: () => null }) // and a choice of A's
    expect(typedWork()).toBe(true)
    const done = switchPerson(a, b)
    expect(typedWork()).toBe(false) // synchronously, before B hydrates
    await done
    expect(typedWork()).toBe(false)
    noteEdit({ tagName: 'INPUT', type: 'text', value: 'B’s words', isConnected: true, closest: () => null })
    expect(typedWork()).toBe(true) // B's own typing counts as ever
  })
})
