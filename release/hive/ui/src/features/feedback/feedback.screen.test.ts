// Purpose: tests the feedback area end to end without a browser: invented state, the facts data.ts states, MeTTa's
// composition of feedback.metta for them, and the HTML Screen draws, for every kind, route, picture state, error state
// and outcome, and every moment of the hive's logs; and that every part of the screen can be reached.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { FeedbackDestination } from '../../api/types'
import { Screen } from '../../screens/Screen'
import { ScreensSpace } from '../../screens/screenSpace'
import { feedbackScreen, routeOf } from './data'
import type { Draft } from './drafts'
import { reportOf, type FeedbackState, type LogsState } from './store'

vi.setConfig({ testTimeout: 20_000 })

const space = ScreensSpace.open()
const seen = new Set<number>()

const BOARD: FeedbackDestination = { kind: 'board', owner: 'omega-flagship', repo: 'omegahive-feedback', url: 'https://github.com/omega-flagship/omegahive-feedback', public: false }
const state = (over: Partial<FeedbackState> = {}): FeedbackState => ({
  open: true, id: 'HR-1a2b3c4d', kind: 'bug', words: 'The Ask stopped answering.', expected: '', steps: '1. Opened hive',
  page: { device: 'Chrome 131 on macOS', look: 'Classic hive', page: 'hive (#/)', window: '1440×900, pixel ratio 1', time: '2026-11-16T00:12:34Z' },
  ctx: { version: 'Mac v0.31 (build f9648d4386)', which: 'own hive, Mac install', system: 'Mac', to: BOARD,
    errors: [{ id: 'e-1a2b3c4d', at: '2026-11-16T00:12:30.000Z', method: 'POST', route: '/api/ask', status: 500, code: 'internal_error', message: 'The hive hit an error it did not expect.' }] },
  ctxError: '', picture: { url: 'data:image/png;base64,iVBORw0KGgo=', drawing: false, failed: false, kept: true }, errorsKept: true,
  done: 'none', copiedToo: false, reference: '', sending: false, failed: '', draft: null,
  logs: { shown: false, loading: false, text: '', file: '', scope: 'page', missing: '', failed: '', done: 'none' }, ...over,
})
const LOGS = (over: Partial<LogsState> = {}): LogsState => ({
  shown: true, loading: false, text: 'Omega hive logs · 2026-11-17T01:23:45Z\nVersion: Mac v0.31 (build f9648d4386)',
  file: 'omega-hive-logs-2026-11-17T01-23-45Z.txt', scope: 'hive', missing: '', failed: '', done: 'none', ...over,
})
const DRAFTS: Draft[] = [
  { id: 'hd-0a1b2c3d', origin: 'hive', kind: 'bug', title: 'The hive answered 500 to POST /api/ask', words: 'The hive answered 500 internal_error to POST /api/ask (error e-1a2b3c4d): The hive hit an error it did not expect.',
    steps: '1. Opened hive', expected: '', draftedBy: 'the hive', at: '2026-11-16T00:12:30Z', count: 2 },
  { id: 'fd-51a1d2a7', origin: 'mind', kind: 'bug', title: 'A search tool kept failing', words: 'The web search tool failed three times.', steps: '', expected: '',
    draftedBy: 'Vega, a mind', at: '2026-11-16T00:10:00Z', count: 1 },
]

/** The screen for a state, in a look: its parts' orders and its drawn HTML. */
function draw(s: FeedbackState, look = 'classic', share = false, drafts: readonly Draft[] = []) {
  const report = reportOf(s, [])
  const { data, facts } = feedbackScreen(s, report, { share }, s.ctx?.errors.length ?? 0, drafts)
  const plan = space.compose('feedback', look, facts)
  for (const p of plan.parts) seen.add(p.order)
  // the area's own host takes presses (FeedbackHost), so a row's own buttons draw
  return { orders: plan.parts.map((p) => p.order), html: renderToStaticMarkup(createElement(Screen, { plan, host: { data, onAction: () => undefined } })), plan }
}

describe('where a report can go decides its buttons', () => {
  it.each([
    [{ kind: 'board', public: true }, 'board'], [{ kind: 'board', public: false }, 'copy'], [{ kind: 'board', public: null }, 'copy'],
    [{ kind: 'service' }, 'service'], [{ kind: 'none' }, 'copy'], [{ kind: 'invalid' }, 'invalid'], [undefined, 'copy'],
  ] as const)('%j is %s', (to, route) => {
    expect(routeOf(to === undefined ? undefined : ({ owner: 'o', repo: 'r', url: 'u', url_: '', host: 'h', reason: 'x', ...to } as unknown as FeedbackDestination))).toBe(route)
  })
  it('a private board: copy for the testers’ group first, save beside it, no GitHub', () => {
    const { orders, html } = draw(state())
    expect(orders).toEqual(expect.arrayContaining([53, 54, 57]))
    expect(orders).not.toContain(51)
    expect(html).toContain("Copy for the testers&#x27; group")
    expect(html).toContain('Save as files')
    expect(html).not.toContain('Open it on GitHub')
  })
  it('a public board: open it on GitHub first, with the copy and the file beside it', () => {
    const { orders, html } = draw(state({ ctx: { ...state().ctx!, to: { ...BOARD, public: true } } }))
    expect(orders).toEqual(expect.arrayContaining([51, 52, 56]))
    expect(orders).not.toContain(53)
    expect(html).toContain('Open it on GitHub')
    // where it goes, and that the issue is public (Jon on #367)
    expect(html).toContain('Opens a new issue on the team&#x27;s feedback board on GitHub, omega-flagship/omegahive-feedback, filled in.')
    expect(html).toContain('The issue is public, so anyone can read it once you press Submit new issue there')
  })
  it('a report service: send it to the team, with the copy and the file beside it', () => {
    const { orders, html } = draw(state({ ctx: { ...state().ctx!, to: { kind: 'service', url: 'https://reports.example.org/in', host: 'reports.example.org' } } }))
    expect(orders).toEqual(expect.arrayContaining([48, 50, 56]))
    expect(html).toContain('Send to the team')
    // where it goes, before the press (Jon on #367)
    expect(html).toContain('Sends your report, and the picture if you added one, to reports.example.org, the report service this hive is set to send reports to.')
    expect(html.indexOf('reports.example.org, the report service')).toBeLessThan(html.indexOf('Send to the team'))
  })
  it('a destination set wrongly is said, and the copy stays', () => {
    const { orders, html } = draw(state({ ctx: { ...state().ctx!, to: { kind: 'invalid', reason: 'HIVE_FEEDBACK_TO must be an https address, or none' } } }))
    expect(orders).toEqual(expect.arrayContaining([53, 55, 57]))
    expect(html).toContain('set wrongly: HIVE_FEEDBACK_TO must be an https address, or none.')
  })
  it('a hive that has not answered yet still lets the person copy or save', () => {
    const { orders } = draw(state({ ctx: null }))
    expect(orders).toEqual(expect.arrayContaining([53, 57]))
  })
  it('nothing can leave before the person has written something', () => {
    const { orders, html } = draw(state({ words: '  ' }))
    expect(orders).toContain(49)
    const opening = html.slice(html.lastIndexOf('<button', html.indexOf('Copy for the testers')), html.indexOf('Copy for the testers'))
    expect(opening.slice(0, opening.indexOf('>'))).toContain('disabled')
  })
})

describe('everything the report carries is on the screen before it goes', () => {
  it('the words, the version, the page, the picture, the errors and the whole text', () => {
    const { html } = draw(state())
    for (const shown of ['The Ask stopped answering.', 'Mac v0.31 (build f9648d4386)', 'own hive, Mac install', 'hive (#/)', '1440×900, pixel ratio 1',
      '2026-11-16T00:12:34Z', 'HR-1a2b3c4d', 'Chrome 131 on macOS', 'Classic hive', 'data:image/png;base64,iVBORw0KGgo=', 'e-1a2b3c4d',
      'The hive hit an error it did not expect.', 'Omega report HR-1a2b3c4d · bug · The Ask stopped answering.', 'Original feedback ID: HR-1a2b3c4d'])
      expect(html, shown).toContain(shown.replace(/'/g, '&#x27;'))
  })
  it('a picture not added, or removed, is neither shown nor named; the person may add one, told what it shows', () => {
    for (const url of [null, 'data:image/png;base64,iVBORw0KGgo=']) {
      const none = draw(state({ picture: { url, drawing: false, failed: false, kept: false } }))
      expect(none.orders).toEqual(expect.arrayContaining([24, 26]))
      expect(none.orders).not.toContain(23)
      expect(none.html).toContain('Add a picture of this page')
      expect(none.html).toContain('other people&#x27;s names and messages included, and it isn&#x27;t cleaned the way your words are')
      expect(none.html).not.toContain('Picture: HR-1a2b3c4d.png')
    }
    const gone = draw(state({ picture: { url: 'data:image/png;base64,iVBORw0KGgo=', drawing: false, failed: false, kept: false } }))
    expect(gone.html).not.toContain('data:image/png')
    expect(gone.html).not.toContain('Picture: HR-1a2b3c4d.png')
    const added = draw(state())   // added: shown with its way to remove it, and nothing offers to add another
    expect(added.orders).toContain(23)
    expect(added.html).toContain('alt="This page as it was when you added the picture"')
    expect(added.orders).not.toContain(24)
    expect(added.orders).not.toContain(26)
  })
  it('a picture still being drawn, and one that could not be drawn, are said', () => {
    expect(draw(state({ picture: { url: null, drawing: true, failed: false, kept: true } })).html).toContain('Drawing a picture of the screen')
    const failed = draw(state({ picture: { url: null, drawing: false, failed: true, kept: false } }))
    expect(failed.html).toContain('could not draw a picture')
    expect(failed.html).toContain('Add a picture of this page')   // it can be tried again
    expect(draw(state({ picture: { url: null, drawing: true, failed: false, kept: true } })).orders).not.toContain(26)
  })
  it('the errors can be left out, and put back', () => {
    const kept = draw(state())
    expect(kept.orders).toEqual(expect.arrayContaining([30, 31, 32]))
    const out = draw(state({ errorsKept: false }))
    expect(out.orders).toContain(33)
    expect(out.orders).not.toContain(31)
    expect(out.html).not.toContain('e-1a2b3c4d')
  })
  it('each kind asks its own questions', () => {
    expect(draw(state({ kind: 'bug' })).html).toContain('What went wrong?')
    expect(draw(state({ kind: 'ux' })).html).toContain('What was hard?')
    expect(draw(state({ kind: 'idea' })).html).toContain('What do you need?')
    expect(draw(state({ kind: 'idea' })).html).not.toContain('Steps:')
  })
})

describe('after a press, the person is told what happened and what is left to do', () => {
  it.each([
    [{ done: 'copied' }, 'then send the picture as its own message with HR-1a2b3c4d as its caption'],
    [{ done: 'copied', picture: { url: null, drawing: false, failed: true, kept: true } }, 'Copied. Paste it in the group.'],
    [{ done: 'saved' }, 'Saved HR-1a2b3c4d.txt and the picture beside it as HR-1a2b3c4d.png'],
    [{ done: 'saved', picture: { url: 'data:image/png;base64,iVBORw0KGgo=', drawing: false, failed: false, kept: false } }, 'Saved HR-1a2b3c4d.txt where your browser keeps downloads.'],
    [{ done: 'opened' }, 'Press Submit new issue there.'],
    [{ done: 'opened', copiedToo: true }, 'it is on your clipboard too: paste it into Evidence.'],
    [{ done: 'sent', reference: 'FB-200' }, 'Sent. Thank you. The team&#x27;s reference: FB-200'],
    [{ failed: 'The report service at reports.example.org answered 500.' }, 'Not sent: The report service at reports.example.org answered 500. Copy or save it instead.'],
  ] as const)('%j', (over, words) => {
    expect(draw(state(over as Partial<FeedbackState>)).html).toContain(words)
  })
})

describe('every look draws it', () => {
  it.each(['classic', 'cosmos', 'flux', 'canvas', 'still', 'construct', 'professional'])('%s', (look) => {
    const { plan, html } = draw(state(), look, false, DRAFTS)
    expect(plan.missing).toEqual([])
    expect(html).toContain('Send feedback or report a bug')
    expect(html).toContain('Drafted for you')
    expect(html).toContain('Show the logs')
    const shown = draw(state({ logs: LOGS() }), look)
    expect(shown.plan.missing).toEqual([])
    expect(shown.html).toContain('Omega hive logs · 2026-11-17T01:23:45Z')
    expect(shown.html).toContain('Save the logs')
  })
  it('a phone that can share pictures is offered the share', () => {
    expect(draw(state(), 'classic', true).html).toContain('Share the picture')
    expect(draw(state(), 'classic', false).html).not.toContain('Share the picture')
  })
})

describe('drafts wait for the person', () => {
  it('listed by who drafted them, each to use or dismiss, and nothing sent', () => {
    const { orders, html } = draw(state({ words: '' }), 'classic', false, DRAFTS)
    expect(orders).toEqual(expect.arrayContaining([2, 3]))
    expect(html).toContain('Nothing has been sent')
    expect(html).toContain('Noticed by the hive')
    expect(html).toContain('2 times')
    expect(html).toContain('Drafted by Vega, a mind')
    expect(html).toContain('aria-label="Use the draft: A search tool kept failing"')
    expect(html).toContain('aria-label="Dismiss the draft: The hive answered 500 to POST /api/ask"')
  })
  it('none waiting: no drafts part', () => {
    expect(draw(state()).orders).not.toEqual(expect.arrayContaining([2]))
  })
  it('a report started from a draft says whose, and that draft leaves the list while its report is open', () => {
    const { orders, html } = draw(state({ draft: { id: 'fd-51a1d2a7', origin: 'mind', draftedBy: 'Vega, a mind' } }), 'classic', false, DRAFTS)
    expect(orders).toContain(4)
    expect(html).toContain('Started from a draft by Vega, a mind. Change anything before it goes.')
    expect(html).not.toContain('Use the draft: A search tool kept failing')
    expect(html).toContain('Drafted by: Vega, a mind')
  })
})

describe("the hive's logs: gathered on a press, shown whole, then saved or copied", () => {
  it('before the press: what they hold and that nothing leaves, and the one button that gathers them', () => {
    const { orders, html } = draw(state())
    expect(orders).toEqual(expect.arrayContaining([70, 71]))
    expect(orders).not.toEqual(expect.arrayContaining([76]))
    expect(html).toContain('nothing leaves until you save or copy it.')
  })
  it('while they are gathered it says so', () => {
    const { orders, html } = draw(state({ logs: LOGS({ shown: false, loading: true, text: '' }) }))
    expect(orders).toEqual(expect.arrayContaining([71, 72]))
    expect(html).toContain('Gathering the logs…')
  })
  it.each([
    ['hive', 74, 'since you are its admin'],
    ['person', 75, 'These are your own requests and errors on this hive.'],
  ] as const)('shown whole with their buttons, and whose they are (%s)', (scope, order, words) => {
    const { orders, html } = draw(state({ logs: LOGS({ scope }) }))
    expect(orders).toEqual(expect.arrayContaining([76, 77, order]))
    expect(orders).not.toContain(71)
    expect(html).toContain(words)
    expect(html).toContain('Omega hive logs · 2026-11-17T01:23:45Z\nVersion: Mac v0.31 (build f9648d4386)')
    expect(html.indexOf('Omega hive logs')).toBeLessThan(html.indexOf('Save the logs'))   // seen before the press that saves
  })
  it("the hive's part missing is said, and the page's own still shows", () => {
    const { orders, html } = draw(state({ logs: LOGS({ scope: 'page', missing: 'the hive did not answer' }) }))
    expect(orders).toEqual(expect.arrayContaining([73, 76]))
    expect(html).toContain('The hive did not give its part: the hive did not answer. What this page kept is below.')
  })
  it.each([
    [{ done: 'saved' }, 'Saved omega-hive-logs-2026-11-17T01-23-45Z.txt where your browser keeps downloads.'],
    [{ done: 'copied' }, 'Copied. Paste it where you talk with the team.'],
    [{ failed: 'Your browser would not copy them. Save them as a file instead.' }, 'Your browser would not copy them. Save them as a file instead.'],
  ] as const)('after a press, what happened: %j', (over, words) => {
    expect(draw(state({ logs: LOGS(over) })).html).toContain(words)
  })
  it.each([
    ['hive', 79, 78, 'where your browser keeps downloads. Send it to the team with your report.'],
    // up to the apostrophe, which the drawn HTML writes as &#x27;
    ['person', 78, 79, 'Send it to the team with your report, or in the testers'],
    ['page', 78, 79, 'Send it to the team with your report, or in the testers'],
  ] as const)("saved, only a person's own logs are offered the testers' group (%s)", (scope, shown, hidden, words) => {
    // an admin's hold other people's requests and errors, if only by route, status and code (Jon on #388)
    const { orders, html } = draw(state({ logs: LOGS({ scope, done: 'saved' }) }))
    expect(orders).toContain(shown)
    expect(orders).not.toContain(hidden)
    expect(html).toContain(words)
  })
})

afterAll(() => {
  // every part the screen declares was composed by some test above (screens/README.md: every condition can be reached)
  expect([...space.orders('feedback')].filter((o) => !seen.has(o))).toEqual([])
})
