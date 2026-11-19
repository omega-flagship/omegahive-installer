import { describe, expect, it } from 'vitest'
import { keyDefault } from './keyDefault'

/** omegahive-feedback#124: a member adding their own key was refused 403, because the form sent default: true. */
describe('the add-key default', () => {
  it('a member always sends default: false, and is offered no switch', () => {
    for (const hasDefault of [false, true])
      for (const makeDefault of [false, true]) expect(keyDefault({ admin: false, hasDefault, makeDefault })).toEqual({ send: false, choose: false })
  })
  it("an admin's first key for a provider becomes its default", () => {
    expect(keyDefault({ admin: true, hasDefault: false, makeDefault: false })).toEqual({ send: true, choose: false })
  })
  it('an admin with a default already chooses', () => {
    expect(keyDefault({ admin: true, hasDefault: true, makeDefault: true })).toEqual({ send: true, choose: true })
    expect(keyDefault({ admin: true, hasDefault: true, makeDefault: false })).toEqual({ send: false, choose: true })
  })
})
