import { describe, expect, it } from 'vitest'
import { brandStatus } from './brandStatus'

/** Demo audit P1 #4: the cloud sign-in page said "OFFLINE" above "Invite only". Signed out is not offline. */
describe('brandStatus', () => {
  it('on the sign-in page, a hive that answered is "Signed out", never "Offline"', () => {
    expect(brandStatus('live', 'idle', 'reachable')).toBe('Signed out')
    expect(brandStatus('live', 'unauthorized', 'reachable')).toBe('Signed out')
  })
  it('says nothing while it asks the hive how to sign in', () => {
    expect(brandStatus('live', 'idle', 'checking')).toBeNull()
  })
  it('a hive that cannot be reached is still "Offline", on the sign-in page and elsewhere', () => {
    expect(brandStatus('live', 'idle', 'unreachable')).toBe('Offline')
    expect(brandStatus('live', 'idle')).toBe('Offline')
  })
  it('keeps the connection states as they were', () => {
    expect(brandStatus('sim', 'idle', 'reachable')).toBe('Simulation')
    expect(brandStatus('live', 'open')).toBe('Live')
    expect(brandStatus('live', 'reconnecting', 'reachable')).toBe('Reconnecting')
    expect(brandStatus('live', 'connecting', 'checking')).toBe('Connecting')
  })
})
