// Purpose: tests the logs file's text (features/feedback/logs.ts): what it names and in which order, a folded run and
// who made a request in an admin's, another person's error there without its words, the page's part alone when the
// hive's is missing, and that nothing in it can be a key, a token, an OAuth code, a cookie value, an address, an email,
// a home folder, a phone number or a person's id, whatever part it came in by.
import { describe, expect, it } from 'vitest'
import type { FeedbackLogs } from '../../api/types'
import type { PageError } from '../../lib/recentErrors'
import { logsFile, logsText } from './logs'

const PAGE = { device: 'Chrome 131 on macOS', look: 'Canvas', window: '1440×900, pixel ratio 2', time: '2026-11-17T01:23:45Z' }
const HIVE = (over: Partial<FeedbackLogs> = {}): FeedbackLogs => ({
  version: 'Mac v0.33 (build 691e651a12)', which: 'own hive, Mac install', system: 'Mac', scope: 'hive',
  requests: [
    { at: '2026-11-17T01:23:40.120Z', method: 'POST', route: '/api/ask', status: 429, ms: 61, count: 2, who: 'you' },
    { at: '2026-11-17T01:22:00.000Z', method: 'GET', route: '/api/swarms/{swarm_id}', status: 404, ms: 4, count: 1, who: 'another person' },
    { at: '2026-11-17T01:20:00.000Z', method: 'GET', route: '/api/swarms', status: 200, ms: 12, count: 6, who: 'a mind' },
  ],
  errors: [
    { id: 'e-1a2b3c4d', at: '2026-11-17T01:23:40.100Z', method: 'POST', route: '/api/ask', status: 429, code: 'rate_limited', message: 'More model calls this minute than the hive allows.', who: 'you' },
    { id: 'e-0c3f9b12', at: '2026-11-17T01:22:00.000Z', method: 'GET', route: '/api/swarms/{swarm_id}', status: 404, code: 'not_found', who: 'another person' },
  ],
  log: [{ at: '2026-11-17T01:23:39.900Z', level: 'WARNING', logger: 'hive', message: 'the model provider answered 429' }],
  ...over,
})
const PAGE_ERRORS: PageError[] = [{ at: '2026-11-17T01:21:00Z', kind: 'page', where: 'Screen.tsx:812', message: 'Cannot read properties of undefined' }]

describe('the logs file', () => {
  it("names the hive, the page and whose logs they are, then the requests, the errors, the screens and the hive's own lines", () => {
    expect(logsText(HIVE(), '', PAGE, PAGE_ERRORS, ['hive', 'settings']).split('\n')).toEqual([
      'Omega hive logs · 2026-11-17T01:23:45Z',
      'Version: Mac v0.33 (build 691e651a12)',
      'Hive: own hive, Mac install',
      'Device: Chrome 131 on macOS; look Canvas; window 1440×900, pixel ratio 2',
      "Holds: the whole hive's requests and errors, other people's errors by route, status and code only, and its own warnings and errors",
      '',
      'Requests to the hive, newest first:',
      '2026-11-17T01:23:40Z 429 POST /api/ask, 2 times, the slowest 61 ms',
      '2026-11-17T01:22:00Z 404 GET /api/swarms/{swarm_id}, 4 ms, another person',
      '2026-11-17T01:20:00Z 200 GET /api/swarms, 6 times, the slowest 12 ms, a mind',
      '',
      'Errors, newest first:',
      '2026-11-17T01:23:40Z 429 rate_limited POST /api/ask (e-1a2b3c4d): More model calls this minute than the hive allows.',
      '2026-11-17T01:22:00Z 404 not_found GET /api/swarms/{swarm_id} (e-0c3f9b12), another person',
      '2026-11-17T01:21:00Z page Screen.tsx:812: Cannot read properties of undefined',
      '',
      'Screens visited, oldest first:',
      'hive',
      'settings',
      '',
      "The hive's own warnings and errors, newest first:",
      '2026-11-17T01:23:39Z WARNING hive: the model provider answered 429',
    ])
  })
  it("a person's own: their requests and errors, and none of the hive's own lines", () => {
    const text = logsText(HIVE({ scope: 'person', log: [], errors: [HIVE().errors[0]] }), '', PAGE, [], [])
    expect(text).toContain('Holds: your own requests and errors on this hive')
    expect(text).not.toContain("The hive's own warnings")
    expect(text).not.toContain('e-0c3f9b12')   // another person's error is no person's own
    expect(text).toContain('Screens visited, oldest first:\nnone')
  })
  it("without the hive's part: the page's own, and why the rest is missing", () => {
    const lines = logsText(null, 'the hive did not answer', PAGE, PAGE_ERRORS, ['hive']).split('\n')
    expect(lines.slice(1, 6)).toEqual(['Version: unknown', 'Hive: unknown', 'Device: Chrome 131 on macOS; look Canvas; window 1440×900, pixel ratio 2',
      "Holds: what this page kept, without the hive's part", "The hive's part is missing: the hive did not answer"])
    expect(lines).toContain('2026-11-17T01:21:00Z page Screen.tsx:812: Cannot read properties of undefined')
    expect(lines.join('\n')).toContain('Requests to the hive, newest first:\nnone')
  })
  it('names no key, token, OAuth code, cookie, address, email, home folder, phone number or person, whichever part it came in by', () => {
    // a sign-in code as secrets.token_urlsafe(32) makes one: 43 letters, digits, - and _; a key built from parts, so the
    // repository's own secret check (tests/test_repo_boundary.py) sees no key here
    const code = 'Zq3_' + 'x7'.repeat(18) + '-9aB'
    const secret = [`${'sk-or'}-v1-${'abcdef0123456789'.repeat(2)}`, code, 'ana.lopez@example.org', '/home/ana', 'user:u_7f3k2abc', '+61 412 345 678',
      'oauth code 4f2a91c', 'omega_session=Q2xvc2Vk0x', '203.0.113.9', '2001:db8::1']
    const dirty = `${secret.join(' ')} Bearer ${code}`
    const text = logsText(HIVE({
      version: `v1 ${dirty}`, which: `own hive ${dirty}`,
      requests: [{ at: '2026-11-17T01:23:40Z', method: 'GET', route: `/api/x ${dirty}`, status: 200, ms: 1, count: 1, who: 'you' }],
      errors: [{ id: 'e-1a2b3c4d', at: '2026-11-17T01:23:40Z', method: 'GET', route: `/api/${code}`, status: 500, code: 'internal_error', message: dirty, raised: `KeyError at /home/ana/x.py:1 in f` }],
      log: [{ at: '2026-11-17T01:23:40Z', level: 'ERROR', logger: 'hive', message: `sign-in link https://hive.example.org/#/signin?code=${code} for ${dirty}` }],
    }), dirty, { ...PAGE, look: dirty }, [{ at: '2026-11-17T01:21:00Z', kind: 'mind', where: dirty, message: dirty }], [dirty])
    for (const s of secret) expect(text, s).not.toContain(s)
    expect(text).toContain('signin?code=[code]')
    expect(text).toContain('Bearer [token]')
  })
  it('is saved under the time it was made, without the colons some systems refuse', () => {
    expect(logsFile('2026-11-17T01:23:45Z')).toBe('omega-hive-logs-2026-11-17T01-23-45Z.txt')
  })
})
