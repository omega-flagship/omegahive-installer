import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HiveClient } from '../api/client'
import { useHive } from '../store/store'
import { askConfirm, confirmShowing } from '../ui/confirm'
import { askConfirmBound, bindEpoch, currentEpoch, guard, identityKey, onIdentityChange, STALE } from './identityEpoch'
import { isCurrent, releasePersons, signInAs, switchPerson, testPerson } from './identityEpoch.testkit'

/**
 * The identity epoch: one key for who and where (client + sign-in + store session + inits), bumped synchronously on
 * every change, with clear hooks that run before anything later sees the new identity. Synthetic SimClients only.
 */

function defer<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((r, j) => ((resolve = r), (reject = j)))
  return { promise, resolve, reject }
}
const offs: (() => void)[] = []
const hook = (fn: () => void) => offs.push(onIdentityChange(fn))

beforeEach(() => {
  vi.stubGlobal('window', { location: { search: '' } })
})
afterEach(() => {
  for (const off of offs.splice(0)) off()
  releasePersons()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('identity epoch: bumps synchronously on every kind of change', () => {
  it('a different client (another person on another tab)', async () => {
    const a = testPerson('a')
    const b = testPerson('b')
    await signInAs(a)
    const e = currentEpoch()
    const { before, after } = await switchPerson(a, b)
    expect(before).toBe(e)
    expect(after).toBe(e + 1)
    expect(currentEpoch()).toBe(e + 1)
  })

  it('a re-login on the same client without a logout (credential only)', async () => {
    const a = testPerson('a')
    const b = testPerson('b', { sameTab: a })
    await signInAs(a)
    const e = currentEpoch()
    const k = identityKey()
    const sw = switchPerson(a, b)
    expect(currentEpoch()).toBeGreaterThan(e)
    expect(identityKey()).not.toBe(k)
    expect(isCurrent(b)).toBe(true)
    await sw
  })

  it('a re-init of the same client (inits), with nothing else changed', async () => {
    const a = testPerson('a')
    await signInAs(a)
    const e = currentEpoch()
    const p = useHive.getState().init(a.client)
    expect(currentEpoch()).toBe(e + 1)
    await p
  })

  it('a sign-in replaced on the client before any observer ran is already a new epoch when read', async () => {
    const a = testPerson('a')
    await signInAs(a)
    const e = currentEpoch()
    const seen: number[] = []
    hook(() => seen.push(1))
    // the handle is replaced but onAuthChange has not been emitted yet: the epoch reads the client itself
    Object.assign(a.client, { authContext: () => ({}) })
    expect(currentEpoch()).toBe(e + 1)
    expect(seen).toEqual([1])
  })

  it('no bump, and no hook, when nothing about the identity changed', async () => {
    const a = testPerson('a')
    await signInAs(a)
    const e = currentEpoch()
    let fired = 0
    hook(() => fired++)
    useHive.setState({ paletteOpen: !useHive.getState().paletteOpen })
    useHive.setState({ paletteQuery: 'invented' })
    expect(currentEpoch()).toBe(e)
    expect(bindEpoch().current()).toBe(true)
    expect(fired).toBe(0)
  })
})

describe('identity epoch: clear hooks run before anyone later sees the new identity', () => {
  it('a store subscriber and an auth listener registered after the helper never see A’s data under B', async () => {
    const a = testPerson('a')
    const b = testPerson('b', { sameTab: a })
    const c = testPerson('c')
    await signInAs(a)
    let shown: string | null = 'A’s invented words'
    const sawUnderNew: (string | null)[] = []
    hook(() => (shown = null))
    let session = useHive.getState().session
    offs.push(
      useHive.subscribe((s) => {
        if (s.session !== session) {
          session = s.session
          sawUnderNew.push(shown)
        }
      }),
    )
    offs.push((a.client as HiveClient).onAuthChange!(() => sawUnderNew.push(shown)))
    void switchPerson(a, b)
    expect(shown).toBeNull()
    shown = 'B’s invented words'
    await switchPerson(b, c)
    expect(shown).toBeNull()
    expect(sawUnderNew.length).toBeGreaterThanOrEqual(3)
    expect(sawUnderNew.every((v) => v === null)).toBe(true)
  })

  it('every hook runs even when one throws; unsubscribed hooks never run', async () => {
    const a = testPerson('a')
    const b = testPerson('b')
    await signInAs(a)
    // a throwing hook is reported on a microtask (never inside the store's own set): capture it here
    const reported: (() => void)[] = []
    const ran: string[] = []
    hook(() => {
      throw new Error('invented hook failure')
    })
    hook(() => ran.push('second'))
    const off = onIdentityChange(() => ran.push('gone'))
    off()
    // only the synchronous part of the switch is captured (that is where the hooks run)
    const spy = vi.spyOn(globalThis, 'queueMicrotask').mockImplementation((cb) => void reported.push(cb))
    const done = switchPerson(a, b)
    spy.mockRestore()
    await done
    expect(ran).toEqual(['second'])
    expect(reported.length).toBe(1)
    expect(() => reported[0]()).toThrow('invented hook failure')
  })
})

describe('bindEpoch / guard: async continuations drop stale results', () => {
  it('a late answer for A is STALE under B; the same answer for A while A is current is kept', async () => {
    const a = testPerson('a')
    const b = testPerson('b')
    await signInAs(a)
    const kept = defer<string>()
    const keptBound = bindEpoch()
    const okP = guard(kept.promise, keptBound)
    kept.resolve('invented A answer')
    expect(await okP).toBe('invented A answer')
    expect(keptBound.current()).toBe(true)

    const late = defer<string>()
    const bound = bindEpoch()
    const p = guard(late.promise)
    const failing = defer<string>()
    const pf = guard(failing.promise)
    await switchPerson(a, b)
    expect(bound.current()).toBe(false)
    late.resolve('invented A answer')
    failing.reject(new Error('invented A failure'))
    expect(await p).toBe(STALE)
    expect(await pf).toBe(STALE)
  })

  it('a failure for the current identity still rejects', async () => {
    const a = testPerson('a')
    await signInAs(a)
    const d = defer<string>()
    const p = guard(d.promise)
    d.reject(new Error('invented current failure'))
    await expect(p).rejects.toThrow('invented current failure')
  })
})

describe('binding.commit: the write is checked in the same tick it happens (stand-in r1 P2)', () => {
  it('a change landing between guard’s check and the consumer’s write: guard says “current”, commit still drops it', async () => {
    const a = testPerson('a')
    const b = testPerson('b')
    await signInAs(a)
    const binding = bindEpoch()
    const late = defer<string>()
    let passedGuard: string | typeof STALE | null = null
    let written: string | null = null
    let result: unknown = null
    const consumer = (async () => {
      const v = await guard(late.promise, binding)
      passedGuard = v
      if (v !== STALE) result = binding.commit(() => (written = v))
    })()
    let done: Promise<unknown> = Promise.resolve()
    // queue order: guard's check, then this switch, then the consumer resuming after `await guard(...)`
    late.resolve('A’s invented late answer')
    queueMicrotask(() => {
      done = switchPerson(a, b)
    })
    await consumer
    await done
    expect(passedGuard).toBe('A’s invented late answer') // the guard's own check ran before the switch
    expect(written).toBeNull()
    expect(result).toBe(STALE)
  })

  it('under the same identity commit writes now and returns what the write returned', async () => {
    const a = testPerson('a')
    await signInAs(a)
    const binding = bindEpoch()
    let written = ''
    expect(binding.commit(() => ((written = 'invented'), 7))).toBe(7)
    expect(written).toBe('invented')
  })

  it('after a change commit never runs the write, even for a write made before any await', async () => {
    const a = testPerson('a')
    const b = testPerson('b', { sameTab: a })
    await signInAs(a)
    const binding = bindEpoch()
    void switchPerson(a, b)
    let ran = false
    expect(binding.commit(() => (ran = true))).toBe(STALE)
    expect(ran).toBe(false)
  })
})

describe('askConfirmBound: an identity change answers the open question "no"', () => {
  it('cancelled at once by a switch; the dialog is gone before B renders', async () => {
    const a = testPerson('a')
    const b = testPerson('b', { sameTab: a })
    await signInAs(a)
    const answer = askConfirmBound('Forget everything for A? (invented)', 'Forget', { danger: true })
    expect(confirmShowing()).toBe('Forget everything for A? (invented)')
    void switchPerson(a, b)
    expect(confirmShowing()).toBeNull()
    expect(await answer).toBe(false)
  })

  it('asked under a binding that is already stale: "no", and someone else’s open question is left as it is', async () => {
    const a = testPerson('a')
    const b = testPerson('b')
    await signInAs(a)
    const binding = bindEpoch()
    await switchPerson(a, b)
    const theirs = askConfirm('B’s own invented question')
    expect(await askConfirmBound('A’s stale question', 'Go', { binding })).toBe(false)
    expect(confirmShowing()).toBe('B’s own invented question')
    // answer B's own question so nothing is left open
    const other = askConfirmBound('replaces it')
    expect(await theirs).toBe(false)
    void switchPerson(b, a)
    expect(await other).toBe(false)
  })

  it('without a change it answers exactly as askConfirm does', async () => {
    const a = testPerson('a')
    await signInAs(a)
    const first = askConfirmBound('first (invented)')
    const second = askConfirmBound('second (invented)')
    // a newer question replaces an older one as before: the older is answered "no"
    expect(await first).toBe(false)
    expect(confirmShowing()).toBe('second (invented)')
    // the host's Cancel/Continue are not mounted here; a switch closes it
    const c = testPerson('c')
    void switchPerson(a, c)
    expect(await second).toBe(false)
  })
})

describe('test kit', () => {
  it('refuses to switch from someone who is not current, or to the same person', async () => {
    const a = testPerson('a')
    const b = testPerson('b')
    await signInAs(a)
    expect(() => switchPerson(b, a)).toThrow(/not the current person/)
    expect(() => switchPerson(a, a)).toThrow(/same person/)
  })
})
