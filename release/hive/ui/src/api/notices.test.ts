import { describe, expect, it } from 'vitest'
import { parseAppAsk } from '../lib/appAsk'
import { readFrameNotices, readFrameSpend, readNoticeList, readNoticePrefs } from './notices'

const channel = '10000000-0000-4000-8000-000000000001'
const prefs = { cap: 3, quiet_start: '21:00', quiet_end: '07:00', tz: 'Europe/London', caps: [0, 1, 3, 5, 8], urgent_kinds: [] }
const item = { id: 'n_1', seq: 1, kind: 'notice', text: '<b>plain</b>', from: 'Watcher', at: '2026-10-27T12:00:00Z', posted_at: '2026-10-27T12:00:00Z', state: 'delivered', urgent: null }

describe('G2 notices and G4 spend readers', () => {
  it('reads the person\'s own list and refuses a malformed one', () => {
    const digest = { ...item, id: 'n_2', seq: 2, kind: 'digest', from: null, items: [{ ...item, state: 'digested' }] }
    expect(readNoticeList({ notices: [digest, item], waiting: 0, prefs })?.notices).toHaveLength(2)
    expect(readNoticeList({ notices: [{ ...item, kind: 'html' }], waiting: 0, prefs })).toBeNull()
    expect(readNoticeList({ notices: [{ ...digest, items: [digest] }], waiting: 0, prefs })).toBeNull()   // digests never nest
    expect(readNoticeList({ notices: [], waiting: -1, prefs })).toBeNull()
  })
  it('accepts only the designed caps and HH:MM quiet hours', () => {
    expect(readNoticePrefs(prefs)).not.toBeNull()
    expect(readNoticePrefs({ ...prefs, quiet_start: null, quiet_end: null })).not.toBeNull()
    expect(readNoticePrefs({ ...prefs, cap: 2 })).toBeNull()
    expect(readNoticePrefs({ ...prefs, quiet_start: '9pm' })).toBeNull()
  })
  it('reads the frame answers', () => {
    expect(readFrameNotices({ notices: [item], cursor: 1, more: false })?.cursor).toBe(1)
    expect(readFrameNotices({ notices: [{ ...item, items: [] }], cursor: 1, more: false })).toBeNull()
    const spend = { tz: 'UTC', days: [{ date: '2026-10-27', total_usd: 0.02, this_app_usd: 0.02 }], total_usd: 0.02, this_app_usd: 0.02 }
    expect(readFrameSpend(spend)?.total_usd).toBe(0.02)
    expect(readFrameSpend({ ...spend, total_usd: -1 })).toBeNull()
  })
  it('the frame bridge parses the two read ops and nothing that selects a person or swarm', () => {
    expect(parseAppAsk({ type: 'ask-notices', id: 'r1', channel })).toMatchObject({ ok: true })
    expect(parseAppAsk({ type: 'ask-notices', id: 'r1', channel, after: 4 })).toMatchObject({ ok: true })
    expect(parseAppAsk({ type: 'ask-spend', id: 'r1', channel, days: 14 })).toMatchObject({ ok: true })
    expect(parseAppAsk({ type: 'ask-spend', id: 'r1', channel, days: 32 })).toMatchObject({ ok: false, code: 'invalid' })
    expect(parseAppAsk({ type: 'ask-notices', id: 'r1', channel, after: -1 })).toMatchObject({ ok: false, code: 'invalid' })
    expect(parseAppAsk({ type: 'ask-notices', id: 'r1', channel, principal: 'user:u_x' })).toMatchObject({ ok: false, code: 'invalid' })
    expect(parseAppAsk({ type: 'ask-spend', id: 'r1', channel, swarm_id: 's1' })).toMatchObject({ ok: false, code: 'invalid' })
  })
})
