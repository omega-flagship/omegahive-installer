import { describe, expect, it } from 'vitest'
import { DESKTOP_TICKER_BOTTOM, PHONE_TICKER_BOTTOM } from './tickerPlace'

/** Platform sweep: on a phone the activity ticker showed half-hidden behind the Ask. It now clears the Ask's band. */
describe('the phone activity ticker', () => {
  it('stands above the Ask’s band (--ask-room) whenever the Ask is higher than its old place', () => {
    expect(PHONE_TICKER_BOTTOM).toMatch(/^max\(/)
    expect(PHONE_TICKER_BOTTOM).toContain('calc(var(--ask-room, 0px) + 8px)')
    expect(PHONE_TICKER_BOTTOM).toContain('calc(var(--sab) + 82px)')   // never lower than before
  })
})

/** Audit P2 #13: on desktop the ticker's fourth line sat partly behind the Ask's left edge. */
describe('the desktop activity ticker', () => {
  it('stands above the Ask’s band, never lower than its old place above the dock', () => {
    expect(DESKTOP_TICKER_BOTTOM).toMatch(/^max\(/)
    expect(DESKTOP_TICKER_BOTTOM).toContain('calc(var(--ask-room, 0px) + 8px)')
    expect(DESKTOP_TICKER_BOTTOM).toContain('calc(var(--hud-bottom, 0px) + 20px)')
  })
})
