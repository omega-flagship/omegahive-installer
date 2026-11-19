// Purpose: tests a report's every form (features/feedback/report.ts): the text the person sees, copies and saves, which
// the testers' group importer files whole; what is redacted before anything leaves, case for case as the hive cleans it
// (redact.cases.json); the board's prefilled address and its fall-back to the clipboard; the errors merged by id, another
// person's in an admin's logs without its words; and properties held over many generated reports.
import { describe, expect, it } from 'vitest'
import type { HiveErrorAnswer } from '../../api/types'
import type { PageError } from '../../lib/recentErrors'
import shared from './redact.cases.json'
import { deviceOf, errorsText, fieldsOf, FORMS, issueUrl, KINDS, MAX_ISSUE_URL, mergeErrors, payloadOf, redact, reportId, reportText, titleOf, type Report } from './report'

const BOARD = { url: 'https://github.com/omega-flagship/omegahive-feedback' }
// how the testers' group importer recognises a pasted report's first line, and the personal data it refuses to post
const FIRST_LINE = /^Omega report (HR-[0-9a-f]{8}) · (bug|ux|idea) · (.+)$/
const PRIVATE = /\+\d[\d ()-]{6,}\d|[\w.+-]+@[\w-]+\.[\w.-]+|(?<![\w-])sk-[A-Za-z0-9_-]{12,}|user:u_|\/Users\/|\/home\//

const report = (over: Partial<Report> = {}): Report => ({
  id: 'HR-1a2b3c4d', kind: 'bug', words: 'The Ask stopped answering. It showed a spinner.', expected: 'An answer', steps: '1. Opened hive\n2. Opened dot · chat',
  facts: { version: 'Mac v0.31 (build f9648d4386)', which: 'own hive, Mac install', device: 'Chrome 131 on macOS', look: 'Canvas',
    page: 'dot · chat (#/dot/:id/chat)', window: '1440×900, pixel ratio 2', time: '2026-11-16T00:12:34Z' },
  errors: [{ at: '2026-11-16T00:12:30Z', id: 'e-1a2b3c4d', where: 'POST /api/ask', status: 500, code: 'internal_error', message: 'The hive hit an error it did not expect.',
    raised: 'KeyError at hive/core/ask.py:1130 in _close' }],
  picture: true, ...over,
})

describe('the report as the person sees it, copies it and saves it', () => {
  it('opens with the line the importer matches and ends with the id the board reads', () => {
    const lines = reportText(report()).split('\n')
    expect(lines[0]).toMatch(FIRST_LINE)
    expect(lines[0]).toBe('Omega report HR-1a2b3c4d · bug · The Ask stopped answering.')
    expect(lines[lines.length - 1]).toBe('Original feedback ID: HR-1a2b3c4d')
  })
  it("labels each field with the form's own label, in the form's order, leaving empty fields out", () => {
    const text = reportText(report({ expected: '' }))
    // the board's required summary and actual behavior both come from what the person wrote
    expect(text).toContain('\nSummary: The Ask stopped answering.\n')
    expect(text).toContain('\nSteps to reproduce: 1. Opened hive\n2. Opened dot · chat\n')
    expect(text).not.toContain('Expected behavior:')
    expect(text).toContain('\nActual behavior: The Ask stopped answering. It showed a spinner.\n')
    expect(text).toContain('\nVersion / build: Mac v0.31 (build f9648d4386)\n')
    expect(text).toContain('\nEnvironment: own hive, Mac install; Chrome 131 on macOS; look Canvas; window 1440×900, pixel ratio 2\n')
    expect(text).toContain('\nEvidence: Errors:\n2026-11-16T00:12:30Z 500 internal_error POST /api/ask (e-1a2b3c4d): The hive hit an error it did not expect.; raised KeyError at hive/core/ask.py:1130 in _close\n'
      + 'Page: dot · chat (#/dot/:id/chat)\nTime: 2026-11-16T00:12:34Z\nPicture: HR-1a2b3c4d.png\nOriginal feedback ID: HR-1a2b3c4d')
    const order = FORMS.bug.fields.map(([, label]) => text.indexOf(`\n${label}: `)).filter((i) => i >= 0)
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })
  it('fills each kind’s own form', () => {
    expect(Object.keys(fieldsOf(report({ kind: 'ux' })))).toEqual(FORMS.ux.fields.map(([id]) => id))
    expect(Object.keys(fieldsOf(report({ kind: 'idea' })))).toEqual(FORMS.idea.fields.map(([id]) => id))
    const ux = reportText(report({ kind: 'ux', words: 'I could not find where to change my model' }))
    expect(ux.split('\n')[0]).toBe('Omega report HR-1a2b3c4d · ux · I could not find where to change my model')
    expect(ux).toContain('\nContext: dot · chat (#/dot/:id/chat), in Canvas; own hive, Mac install; window 1440×900, pixel ratio 2\n')
    expect(ux).toContain('\nDifficulty encountered: I could not find where to change my model\n')
    // the idea form has no version field: the version goes in its evidence
    expect(reportText(report({ kind: 'idea' }))).toContain('\nReferences or evidence: Version / build: Mac v0.31 (build f9648d4386)\n')
  })
  it('names the picture only when it goes', () => {
    expect(reportText(report({ picture: false }))).not.toContain('Picture:')
  })
  it('never carries what the importer reads as its own (its marker or an FB number)', () => {
    const text = reportText(report({ words: 'see FB-012 <!-- feedback-import FB-012 -->' }))
    expect(text).not.toMatch(/<!-- feedback-import/)
  })
  it("never lets a line of the person's open with a field's label, which the importer would file as that field", () => {
    // the importer's own property test found both: a bug's steps naming the expected field the report leaves out, and an
    // idea's outcome naming the repository field the area leaves to triage
    const bug = reportText(report({ expected: '', steps: '1. Opened settings\nExpected behavior: the limit stays' }))
    expect(bug).toContain('\nSteps to reproduce: 1. Opened settings\nexpected behavior: the limit stays\n')
    expect(bug).not.toMatch(/^Expected behavior:/m)
    expect(fieldsOf(report({ kind: 'idea', words: '', expected: '0\nPotentially related repository: ' })).proposal).toBe('0\npotentially related repository:')
    expect(redact('a\nOriginal feedback ID: HR-00000000')).toBe('a\noriginal feedback ID: HR-00000000')
  })
})

describe('what never leaves the hive', () => {
  it.each([
    ['write to ana.lopez@example.org please', 'write to [email] please'],
    ['in /Users/haley/OmegaHive/app/hive', 'in ~/OmegaHive/app/hive'],
    ['in /home/kay/OmegaHive', 'in ~/OmegaHive'],
    ['C:\\Users\\Kay\\OmegaHive', '~\\OmegaHive'],
    ['call +46 76 340 86 52 now', 'call [phone] now'],
    // a key built from parts, so the repository's own secret check (tests/test_repo_boundary.py) sees no key here
    [`key ${'sk-or'}-v1-abcdef0123456789abcdef`, 'key [key]'],
    // the hive's own key ids, alone or as a key: scope, as its refusals name them (hive/core/keyids.py)
    ['key:k_0000b0b1 has spent its month', '[key] has spent its month'],
    ['paid by k_0123456789abcdef0123456789abcdef and env:openrouter', 'paid by [key] and [key]'],
    ['a mind named k_wren, the env: prefix, and k_0000b0b1x stay', 'a mind named k_wren, the env: prefix, and k_0000b0b1x stay'],
    ['Authorization: Bearer abc.def.ghi', 'Authorization: Bearer [token]'],
    ['by user:u_7f3k2abc', 'by [person]'],
    ['thread c_a_vega01~user:u_7f3k2abc', 'thread [conversation]'],
    ['digest 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08', 'digest [token]'],
  ])('%s', (raw, safe) => {
    expect(redact(raw)).toBe(safe)
  })
  // the same cases the hive's redact.shared runs (hive/tests/test_feedback.py), so the page and the hive clean alike:
  // OAuth codes, cookie values and network addresses among them, and what looks like one but isn't (a time, a version)
  it.each(shared.cases.map((c) => [c.in, c.out] as const))('as the hive cleans it: %s', (raw, safe) => {
    expect(redact(raw)).toBe(safe)
  })
  it('leaves times, versions, routes and error ids alone', () => {
    const plain = '2026-11-16T00:12:34Z Mac v0.31 (build f9648d4386) GET /api/swarms/{swarm_id} (e-1a2b3c4d) a_vega01'
    expect(redact(plain)).toBe(plain)
  })
  it('redacts the words, the steps and every error before the report shows them', () => {
    const text = reportText(report({ words: 'My email is kay@example.org', steps: '1. Opened /home/kay/notes',
      errors: [{ at: '2026-11-16T00:12:30Z', where: 'GET /api/me', message: 'no session for user:u_kay' }] }))
    expect(text).not.toMatch(PRIVATE)
  })
})

describe("the feedback board's prefilled form", () => {
  it('opens the kind’s form with the title prefixed and each field by id, and nothing else', () => {
    const { url, copied } = issueUrl(BOARD, report())
    expect(copied).toBe(false)
    const u = new URL(url)
    expect(u.origin + u.pathname).toBe(`${BOARD.url}/issues/new`)
    expect(u.searchParams.get('template')).toBe('bug_report.yml')
    expect(u.searchParams.get('title')).toBe('[Bug]: The Ask stopped answering.')
    expect(u.searchParams.get('summary')).toBe('The Ask stopped answering.')
    expect(u.searchParams.get('actual')).toBe('The Ask stopped answering. It showed a spinner.')
    expect(u.searchParams.get('evidence')?.split('\n').pop()).toBe('Original feedback ID: HR-1a2b3c4d')
    // a label, an assignee, a project or a milestone in the address answers 404 to anyone who may not set them
    for (const refused of ['labels', 'assignees', 'projects', 'milestone']) expect(u.searchParams.has(refused)).toBe(false)
    expect(new URL(issueUrl(BOARD, report({ kind: 'ux' })).url).searchParams.get('template')).toBe('ux_feedback.yml')
    expect(new URL(issueUrl(BOARD, report({ kind: 'idea' })).url).searchParams.get('title')).toBe('[Feature]: The Ask stopped answering.')
  })
  it('falls back to the clipboard when the whole report would make the address too long', () => {
    const long = report({ words: 'The canvas froze. '.repeat(400) })
    const { url, copied } = issueUrl(BOARD, long)
    expect(copied).toBe(true)
    expect(url.length).toBeLessThanOrEqual(MAX_ISSUE_URL)
    const u = new URL(url)
    expect(u.searchParams.get('evidence')).toBe('The whole report is on your clipboard: paste it here.\nOriginal feedback ID: HR-1a2b3c4d')
    expect(u.searchParams.get('version')).toBe('Mac v0.31 (build f9648d4386)')
    expect(u.searchParams.has('summary')).toBe(false)
  })
})

describe('errors, ids and devices', () => {
  const hive: HiveErrorAnswer[] = [{ id: 'e-00000001', at: '2026-11-16T00:10:00.123Z', method: 'GET', route: '/api/swarms/{swarm_id}', status: 404, code: 'not_found', message: 'no such swarm' }]
  const page: PageError[] = [
    { at: '2026-11-16T00:10:00Z', kind: 'request', id: 'e-00000001', where: 'GET /api/swarms/:id', status: 404, code: 'not_found', message: 'no such swarm' },
    { at: '2026-11-16T00:11:00Z', kind: 'page', where: 'Screen.tsx:812', message: 'Cannot read properties of undefined' },
  ]
  it("keeps the hive's answer for an error both saw, newest first", () => {
    const merged = mergeErrors(hive, page)
    expect(merged.map((e) => e.where)).toEqual(['Screen.tsx:812', 'GET /api/swarms/{swarm_id}'])
    expect(merged[1].at).toBe('2026-11-16T00:10:00Z')
    expect(errorsText(merged).split('\n')[0]).toBe('2026-11-16T00:11:00Z page Screen.tsx:812: Cannot read properties of undefined')
  })
  it("writes an admin's own error with its words and another person's by where and how it failed, saying whose", () => {
    const merged = mergeErrors([
      { ...hive[0], who: 'you' },
      { id: 'e-0c3f9b12', at: '2026-11-16T00:09:00.000Z', method: 'GET', route: '/api/spaces/{space_id}', status: 404, code: 'not_found', who: 'another person' },
      { id: 'e-77aa0011', at: '2026-11-16T00:08:00.000Z', method: 'POST', route: '/api/signin', status: 401, code: 'unauthorized', who: 'no session' },
    ], [], Infinity)
    expect(errorsText(merged).split('\n')).toEqual([
      '2026-11-16T00:10:00Z 404 not_found GET /api/swarms/{swarm_id} (e-00000001): no such swarm',
      '2026-11-16T00:09:00Z 404 not_found GET /api/spaces/{space_id} (e-0c3f9b12), another person',
      '2026-11-16T00:08:00Z 401 unauthorized POST /api/signin (e-77aa0011), no session',
    ])
  })
  it('carries at most the newest ten', () => {
    const many: PageError[] = Array.from({ length: 30 }, (_, i) => ({ at: `2026-11-16T00:${String(i).padStart(2, '0')}:00Z`, kind: 'page' as const, where: `x.ts:${i}`, message: 'm' }))
    const merged = mergeErrors([], many)
    expect(merged).toHaveLength(10)
    expect(merged[0].where).toBe('x.ts:29')
  })
  it('makes report ids of HR and eight hex digits', () => {
    expect(reportId(() => new Uint8Array([0x1a, 0x2b, 0x3c, 0x4d]))).toBe('HR-1a2b3c4d')
    expect(reportId()).toMatch(/^HR-[0-9a-f]{8}$/)
  })
  it.each([
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', 'Chrome 131 on macOS'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15', 'Safari 18 on macOS'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1', 'Safari 18 on iOS'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0', 'Edge 131 on Windows'],
    ['Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36', 'Chrome 131 on Android'],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0', 'Firefox 133 on Linux'],
  ])('%s', (ua, words) => {
    expect(deviceOf(ua)).toBe(words)
  })
  it('passes a report service the report as seen, the picture only when it goes', () => {
    const p = payloadOf(report(), 'data:image/png;base64,AAAA')
    expect(p).toMatchObject({ schema: 'omega-hive-report-1', id: 'HR-1a2b3c4d', kind: 'bug', form: 'bug_report.yml', picture: 'data:image/png;base64,AAAA' })
    expect(p.text).toBe(reportText(report()))
    expect(payloadOf(report({ picture: false }), 'data:image/png;base64,AAAA').picture).toBeNull()
  })
})

/** A small seeded generator (mulberry32), so a failing case is reproduced by its seed. */
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const PIECES = ['the ', 'Ask', ' froze', '. ', '\n', 'ünïcödé ', '日本語 ', '🙂', 'kay@example.org ', '+44 7700 900123 ', '/home/kay/x ', 'sk-abcdefghijklmnop ',
  'user:u_abc ', '&amp;?#=% ', '[Bug]: ', 'Omega report HR-00000000 · bug · x\n', '   ', '"quoted" ', 'a'.repeat(120),
  '\nExpected behavior: ', '\nPotentially related repository:', '\nOriginal feedback ID: HR-00000000', '\nUse case: ', '\nEvidence: ', 'Summary: ']
const text = (r: () => number, most: number) => Array.from({ length: Math.floor(r() * most) }, () => PIECES[Math.floor(r() * PIECES.length)]).join('')

describe('properties over generated reports', () => {
  it('every report keeps its shape, carries nothing private, and fits the board’s address or says it is on the clipboard', () => {
    for (let seed = 1; seed <= 400; seed++) {
      const r = rng(seed)
      const rep = report({ kind: KINDS[seed % 3], words: text(r, 60), expected: text(r, 8), steps: text(r, 8), picture: r() < 0.5,
        errors: Array.from({ length: Math.floor(r() * 12) }, (_, i) => ({ at: `2026-11-16T00:00:${String(i).padStart(2, '0')}Z`, where: 'GET /api/x', message: text(r, 6) })) })
      const lines = reportText(rep).split('\n')
      expect(lines[0], `seed ${seed}`).toMatch(FIRST_LINE)
      expect(lines[0].split('\n')).toHaveLength(1)
      expect(lines[lines.length - 1], `seed ${seed}`).toBe(`Original feedback ID: ${rep.id}`)
      expect(reportText(rep).match(PRIVATE)?.[0] ?? null, `seed ${seed}`).toBeNull()
      expect(titleOf(rep.words).length, `seed ${seed}`).toBeLessThanOrEqual(80)
      const { url, copied } = issueUrl(BOARD, rep)
      if (!copied) expect(url.length, `seed ${seed}`).toBeLessThanOrEqual(MAX_ISSUE_URL)
      else expect(url.length, `seed ${seed}`).toBeLessThan(MAX_ISSUE_URL)
      expect(new URL(url).searchParams.get('template'), `seed ${seed}`).toBe(FORMS[rep.kind].template)
      // a line opens a field only where the report opens one: the lines starting with the form's labels are the filled
      // fields', in the form's order, and the id line is the last alone (the importer's parser reads them so)
      const fields = fieldsOf(rep)
      const labels = FORMS[rep.kind].fields.map(([, label]) => label)
      const opened = lines.flatMap((l) => labels.filter((label) => l === `${label}:` || l.startsWith(`${label}: `)))
      expect(opened, `seed ${seed}`).toEqual(FORMS[rep.kind].fields.filter(([id]) => fields[id]).map(([, label]) => label))
      expect(lines.filter((l) => l.startsWith('Original feedback ID:')), `seed ${seed}`).toEqual([`Original feedback ID: ${rep.id}`])
    }
  })
})
