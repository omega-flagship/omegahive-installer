import { describe, expect, it } from 'vitest'
import { ApiError } from '../api/client'
import { authIdentity, clientIdentity, readContext } from './readContext'
import { isAuthContextChanged, readMe } from './readMe'
import { Resource } from './useResource'

/** Platform person-session (439efb9) in readContext and readMe. Synthetic clients, invented data only. */

function authed() {
  let handle: object = {}
  return {
    client: { authContext: () => handle },
    relogin: () => void (handle = {}),
  }
}
const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve()
}

describe('readContext names the client’s current sign-in', () => {
  it('a re-login on the same client (no logout) is a new identity; the same sign-in stays the same', () => {
    const a = authed()
    const first = readContext(a.client, ['user:x', true])
    expect(readContext(a.client, ['user:x', true])).toBe(first)
    a.relogin()
    expect(readContext(a.client, ['user:x', true])).not.toBe(first)
  })

  it('a client without authContext has no sign-in part (the sim reads as before)', () => {
    const sim = {}
    expect(authIdentity(sim)).toBeNull()
    expect(readContext(sim, 'g')).toBe(JSON.stringify([clientIdentity(sim), 'g']))
  })

  it('a resource read under the old sign-in is dropped when the identity is rebound', async () => {
    const a = authed()
    let answer!: (v: string) => void
    const r = new Resource<string>(() => new Promise((res) => (answer = res)), {}, readContext(a.client))
    const pending = r.load()
    await flush()
    a.relogin()
    expect(r.rebind(readContext(a.client))).toBe(true)
    answer('old identity answer')
    await pending
    expect(r.getState().data).toBeUndefined()
  })
})

describe('readMe: 409 auth_context_changed reads again', () => {
  const changed = () => new ApiError(409, 'auth_context_changed', 'Sign-in changed while reading identity')
  const me = { principal: 'user:new', kind: 'sso' as const, role: 'member' as const, expires_at: null, person: null }

  it('re-reads until the sign-in held still for the read', async () => {
    let n = 0
    const client = { me: async () => (++n < 3 ? Promise.reject(changed()) : me) }
    await expect(readMe(client)).resolves.toEqual(me)
    expect(n).toBe(3)
  })

  it('any other failure is still the caller’s', async () => {
    const client = { me: async () => Promise.reject(new ApiError(409, 'conflict', 'other')) }
    await expect(readMe(client)).rejects.toMatchObject({ code: 'conflict' })
    expect(isAuthContextChanged(new ApiError(409, 'conflict', 'x'))).toBe(false)
    expect(isAuthContextChanged(changed())).toBe(true)
  })
})
