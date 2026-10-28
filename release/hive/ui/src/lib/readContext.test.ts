import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clientIdentity, readContext, taggedFor } from './readContext'
import { PENDING, Resource } from './useResource'

// Surface K1/L1: answers are bound to the identity they were read under. INVENTED DATA only.

const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve()
}

/** A promise the test resolves or rejects by hand: a read that answers late. */
function held<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)))
  return { promise, resolve, reject }
}

describe('readContext: the identity a read is made under', () => {
  it('two clients never share an identity, even when everything else (admin, principal) is equal', () => {
    const a = {}, b = {}
    expect(clientIdentity(a)).not.toBe(clientIdentity(b))
    expect(clientIdentity(a)).toBe(clientIdentity(a))
    expect(readContext(a, ['user:x', true])).not.toBe(readContext(b, ['user:x', true]))
    expect(readContext(a, ['user:x', true])).toBe(readContext(a, ['user:x', true]))
  })
  it('principal, admin standing and entity are each part of it', () => {
    const c = {}
    expect(readContext(c, ['user:a', true])).not.toBe(readContext(c, ['user:b', true]))
    expect(readContext(c, ['user:a', true])).not.toBe(readContext(c, ['user:a', false]))
    expect(readContext(c, 'g_1')).not.toBe(readContext(c, 'g_2'))
  })
  it('"not read yet" (undefined) and "could not be read" (null) stay different identities', () => {
    const c = {}
    expect(readContext(c, [undefined])).not.toBe(readContext(c, [null]))
    expect(readContext(c, undefined)).not.toBe(readContext(c, null))
  })
  it('no client is its own identity', () => {
    expect(clientIdentity(null)).toBe(clientIdentity(undefined))
    expect(clientIdentity(null)).not.toBe(clientIdentity({}))
  })
  it('taggedFor gives an answer only for the identity it was read under', () => {
    const a = readContext({}), b = readContext({})
    expect(taggedFor({ ctx: a, value: 1 }, a)).toBe(1)
    expect(taggedFor({ ctx: a, value: 1 }, b)).toBeNull()
    expect(taggedFor(null, a)).toBeNull()
  })
})

describe('Resource: rebinding to another identity (K1)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('admin A to admin B: A’s answer is dropped at once, not kept as a refresh of B', async () => {
    let answer = ['archive A']
    const r = new Resource(() => Promise.resolve(answer), {}, 'A')
    r.start()
    await flush()
    expect(r.getState()).toMatchObject({ status: 'ready', data: ['archive A'] })
    answer = ['archive B']
    expect(r.rebind('B')).toBe(true)
    expect(r.getState()).toBe(PENDING)
    expect(r.getState().data).toBeUndefined()
    r.start()
    await flush()
    expect(r.getState()).toMatchObject({ status: 'ready', data: ['archive B'], refreshing: false })
  })

  it('an old response completing after the replacement never writes (success and failure)', async () => {
    const oldOk = held<string[]>(), oldFail = held<string[]>(), next = held<string[]>()
    const queue = [oldOk.promise, oldFail.promise, next.promise]
    const r = new Resource(() => queue.shift()!, {}, 'A')
    void r.load() // A, ok: pending
    void r.load() // A, failure: pending
    r.rebind('B')
    void r.load() // B: pending
    oldOk.resolve(['archive A'])
    oldFail.reject(new Error('A refused'))
    await flush()
    expect(r.getState()).toBe(PENDING)
    next.resolve(['archive B'])
    await flush()
    expect(r.getState()).toMatchObject({ status: 'ready', data: ['archive B'], error: undefined })
  })

  it('admin to member: the admin-only answer is gone, the member answer replaces it', async () => {
    let admin = true
    const r = new Resource(() => Promise.resolve(admin ? [{ id: 'i_1' }] : []), {}, 'admin')
    r.start()
    await flush()
    expect(r.getState().data).toEqual([{ id: 'i_1' }])
    admin = false
    r.rebind('member')
    expect(r.getState().data).toBeUndefined()
    r.start()
    await flush()
    expect(r.getState()).toMatchObject({ status: 'empty', data: [] })
  })

  it('same identity: a refresh keeps the last answer on screen while it reads again', async () => {
    const second = held<string[]>()
    let n = 0
    const r = new Resource(() => (n++ ? second.promise : Promise.resolve(['v1'])), {}, 'A')
    r.start()
    await flush()
    expect(r.rebind('A')).toBe(false)
    void r.load()
    await flush()
    expect(r.getState()).toMatchObject({ status: 'ready', data: ['v1'], refreshing: true })
    second.resolve(['v2'])
    await flush()
    expect(r.getState()).toMatchObject({ data: ['v2'], refreshing: false })
  })

  it('a mutation for an old identity is dropped; one for the current identity lands', async () => {
    const r = new Resource(() => Promise.resolve(['x']), {}, 'A')
    r.start()
    await flush()
    r.rebind('B')
    r.mutateIn('A', () => ['written for A'])
    expect(r.getState().data).toBeUndefined()
    r.mutateIn('B', () => ['written for B'])
    expect(r.getState().data).toEqual(['written for B'])
  })
})
