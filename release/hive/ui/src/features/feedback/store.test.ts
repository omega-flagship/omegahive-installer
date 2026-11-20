// Purpose: tests the feedback area's actions (features/feedback/store.ts) with the browser stood in for: opening makes a
// fresh report and asks the hive what it adds; nothing leaves before the person presses a button; each press (copy, save,
// open on the board, send) does what it says with the report as the person saw it; a report to a report service carries
// the person's recent requests and the hive's logs unless they switch them off, and the picture only if they added one;
// and the hive's logs file is gathered only on their press and saved or copied exactly as shown.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HiveClient } from '../../api/client'
import type { FeedbackContext, FeedbackLogs } from '../../api/types'

const copied: string[] = []
const saved: { name: string; type: string }[] = []
const blobs: Blob[] = []
vi.mock('../../lib/hooks', async (orig) => ({ ...(await orig<typeof import('../../lib/hooks')>()), copyText: vi.fn(async (t: string) => (copied.push(t), true)) }))
vi.mock('../../lib/download', () => ({ downloadBlob: vi.fn((name: string, blob: Blob) => (saved.push({ name, type: blob.type }), blobs.push(blob))) }))
vi.mock('./capture', () => ({
  LEAVE_OUT: 'data-feedback-leave-out',
  capturePage: vi.fn(async () => 'data:image/png;base64,iVBORw0KGgo='),
  pngBlob: () => new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }),
}))

const { addPicture, closeFeedback, copyLogs, copyReport, extrasOfState, openFeedback, openOnBoard, reportOf, saveLogs, saveReport, sendReport, showLogs, useFeedback } = await import('./store')
const { extrasOf, extrasText } = await import('./logs')
const { capturePage } = await import('./capture')
const { issueUrl, payloadOf, reportText } = await import('./report')
const { noteScreen } = await import('./trail')

const opened: string[] = []
const CTX = (to: FeedbackContext['to']): FeedbackContext => ({ version: 'Mac v0.31 (build f9648d4386)', which: 'own hive, Mac install', system: 'Mac', to, errors: [] })
const PUBLIC_BOARD = { kind: 'board' as const, owner: 'omega-flagship', repo: 'omegahive-feedback', url: 'https://github.com/omega-flagship/omegahive-feedback', public: true }
const SERVICE = { kind: 'service' as const, url: 'https://reports.example.org/in', host: 'reports.example.org' }

function client(ctx: FeedbackContext, send = vi.fn(async () => ({ sent: true as const, to: 'reports.example.org', reference: 'FB-200' }))) {
  return { c: { feedback: vi.fn(async () => ctx), sendFeedback: send } as unknown as HiveClient, send }
}
const settle = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  copied.length = 0
  saved.length = 0
  blobs.length = 0
  opened.length = 0
  vi.stubGlobal('window', { location: { hash: '#/settings' }, innerWidth: 1440, innerHeight: 900, devicePixelRatio: 2, open: (u: string) => opened.push(u) })
  vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' })
})
afterEach(() => {
  closeFeedback()
  vi.unstubAllGlobals()
})

describe('opening the area', () => {
  it('makes a fresh report: its own id, the screens visited as steps, the page as it is, and what the hive adds; no picture', async () => {
    vi.mocked(capturePage).mockClear()
    noteScreen('#/')
    noteScreen('#/settings')
    const { c } = client(CTX(PUBLIC_BOARD))
    openFeedback(c, 'Canvas')
    await settle()
    const s = useFeedback.getState()
    expect(s.open).toBe(true)
    expect(s.id).toMatch(/^HR-[0-9a-f]{8}$/)
    expect(s.steps).toBe('1. Opened hive\n2. Opened settings')
    expect(s.page).toMatchObject({ device: 'Chrome 131 on macOS', look: 'Canvas', page: 'settings (#/settings)', window: '1440×900, pixel ratio 2' })
    expect(s.picture).toEqual({ url: null, drawing: false, failed: false, kept: false })   // the person's to add (Jon on #367)
    expect(capturePage).not.toHaveBeenCalled()
    expect(s.ctx?.version).toBe('Mac v0.31 (build f9648d4386)')
  })
  it('starts from a draft the person chose: its kind, words, steps and expected, and says who drafted it', () => {
    openFeedback(null, 'Classic hive', { id: 'fd-51a1d2a7', origin: 'mind', kind: 'ux', title: 'Ada did not answer', words: 'The Ask stopped: Ada did not answer within 2 minutes',
      steps: '1. Opened hive\n2. Asked Ada', expected: 'An answer', draftedBy: 'Ada, a mind', at: '2026-11-16T00:00:00Z', count: 1 })
    const s = useFeedback.getState()
    expect(s).toMatchObject({ kind: 'ux', words: 'The Ask stopped: Ada did not answer within 2 minutes', steps: '1. Opened hive\n2. Asked Ada', expected: 'An answer',
      draft: { id: 'fd-51a1d2a7', origin: 'mind', draftedBy: 'Ada, a mind' } })
    expect(reportOf(s).draftedBy).toBe('Ada, a mind')
  })
  it('a report from a draft settles the draft once it leaves, and not before', async () => {
    const dismissFeedbackDraft = vi.fn(async () => undefined)
    const c = { feedback: vi.fn(async () => CTX(SERVICE)), dismissFeedbackDraft } as unknown as HiveClient
    const { setMindDrafts, useDrafts } = await import('./drafts')
    const draft = { id: 'fd-51a1d2a7', kind: 'bug' as const, title: 'A tool failed', words: 'The tool failed.', steps: null, expected: null,
      source: { kind: 'mind' as const, agent: 'a_ada01', name: 'Ada', conversation: null }, created: '2026-11-16T00:00:00Z' }
    setMindDrafts([draft])
    openFeedback(c, 'Classic hive', useDrafts.getState().drafts[0])
    await settle()
    expect(dismissFeedbackDraft).not.toHaveBeenCalled()
    await copyReport(c)
    expect(dismissFeedbackDraft).toHaveBeenCalledWith('fd-51a1d2a7')
    expect(useDrafts.getState().drafts).toEqual([])
  })
  it('sends nothing, copies nothing and saves nothing before the person presses a button', async () => {
    const { c, send } = client(CTX(SERVICE))
    openFeedback(c, 'Classic hive')
    useFeedback.setState({ words: 'The Ask stopped', expected: 'An answer' })
    await settle()
    expect(send).not.toHaveBeenCalled()
    expect([copied, saved, opened]).toEqual([[], [], []])
  })
})

describe('the picture is the person\'s to add', () => {
  it('is drawn the first time they add it, kept until they remove it, and added back without drawing again', async () => {
    vi.mocked(capturePage).mockClear()
    openFeedback(null, 'Classic hive')
    await settle()
    useFeedback.setState({ words: 'The Ask stopped' })
    expect(reportOf(useFeedback.getState()).picture).toBe(false)
    addPicture()
    expect(useFeedback.getState().picture).toMatchObject({ drawing: true, kept: true })
    await settle()
    expect(useFeedback.getState().picture).toEqual({ url: 'data:image/png;base64,iVBORw0KGgo=', drawing: false, failed: false, kept: true })
    expect(reportOf(useFeedback.getState()).picture).toBe(true)
    useFeedback.setState((st) => ({ picture: { ...st.picture, kept: false } }))   // Remove the picture
    expect(reportOf(useFeedback.getState()).picture).toBe(false)
    addPicture()
    expect(useFeedback.getState().picture.kept).toBe(true)
    expect(capturePage).toHaveBeenCalledTimes(1)
  })
  it('a picture that could not be drawn is not kept, says so, and can be tried again', async () => {
    vi.mocked(capturePage).mockClear().mockRejectedValueOnce(new Error('no canvas'))
    openFeedback(null, 'Classic hive')
    addPicture()
    await settle()
    expect(useFeedback.getState().picture).toEqual({ url: null, drawing: false, failed: true, kept: false })
    addPicture()
    await settle()
    expect(useFeedback.getState().picture).toMatchObject({ url: 'data:image/png;base64,iVBORw0KGgo=', kept: true })
  })
  it('a report sent, saved or opened with no picture added carries none', async () => {
    const { c, send } = client(CTX(SERVICE))
    openFeedback(c, 'Classic hive')
    await settle()
    useFeedback.setState({ words: 'The Ask stopped' })
    saveReport()
    expect(saved.map((f) => f.type)).toEqual(['text/plain;charset=utf-8'])
    await sendReport(c)
    expect((send.mock.calls[0] as unknown[])[0]).toMatchObject({ picture: null })
  })
  it('a send waits while an added picture is still being drawn, so no report goes without what the area says goes', async () => {
    let drawn: (url: string) => void = () => undefined
    vi.mocked(capturePage).mockImplementationOnce(() => new Promise<string>((r) => { drawn = r }))
    const { c, send } = client(CTX(SERVICE))
    openFeedback(c, 'Classic hive')
    await settle()
    useFeedback.setState({ words: 'The Ask stopped' })
    addPicture()
    await sendReport(c)
    expect(send).not.toHaveBeenCalled()
    drawn('data:image/png;base64,iVBORw0KGgo=')
    await settle()
    await sendReport(c)
    expect((send.mock.calls[0] as unknown[])[0]).toMatchObject({ picture: 'data:image/png;base64,iVBORw0KGgo=' })
  })
})

describe('each press does what it says, with the report as the person saw it', () => {
  it('copy: the whole text, for the testers’ group', async () => {
    openFeedback(client(CTX(PUBLIC_BOARD)).c, 'Classic hive')
    await settle()
    useFeedback.setState({ words: 'The Ask stopped' })
    expect(await copyReport()).toBe(true)
    expect(copied).toEqual([reportText(reportOf(useFeedback.getState()))])
    expect(useFeedback.getState().done).toBe('copied')
  })
  it('save: the text, and the picture beside it while it goes', async () => {
    openFeedback(null, 'Classic hive')
    await settle()
    useFeedback.setState({ words: 'The Ask stopped' })
    addPicture()
    await settle()
    const id = useFeedback.getState().id
    saveReport()
    expect(saved).toEqual([{ name: `${id}.txt`, type: 'text/plain;charset=utf-8' }, { name: `${id}.png`, type: 'image/png' }])
    saved.length = 0
    useFeedback.setState((s) => ({ picture: { ...s.picture, kept: false } }))
    saveReport()
    expect(saved).toEqual([{ name: `${id}.txt`, type: 'text/plain;charset=utf-8' }])
  })
  it('open on the board: its form filled in, in a new tab, and the picture saved to drag in', async () => {
    openFeedback(client(CTX(PUBLIC_BOARD)).c, 'Classic hive')
    await settle()
    useFeedback.setState({ words: 'The Ask stopped' })
    addPicture()
    await settle()
    const s = useFeedback.getState()
    await openOnBoard()
    expect(opened).toEqual([issueUrl(PUBLIC_BOARD, reportOf(s)).url])
    expect(saved).toEqual([{ name: `${s.id}.png`, type: 'image/png' }])
    expect(copied).toEqual([])
    expect(useFeedback.getState()).toMatchObject({ done: 'opened', copiedToo: false })
  })
  it('open on the board: a report too long for the address goes on the clipboard too', async () => {
    openFeedback(client(CTX(PUBLIC_BOARD)).c, 'Classic hive')
    await settle()
    useFeedback.setState({ words: 'The canvas froze. '.repeat(500) })
    await openOnBoard()
    expect(copied).toHaveLength(1)
    expect(useFeedback.getState().copiedToo).toBe(true)
  })
  it('send: the payload the person saw goes to the hive, which names the service; the reference comes back', async () => {
    const { c, send } = client(CTX(SERVICE))
    openFeedback(c, 'Classic hive')
    await settle()
    useFeedback.setState({ words: 'The Ask stopped' })
    const s = useFeedback.getState()
    await sendReport(c)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(payloadOf(reportOf(s), s.picture.url))
    expect(useFeedback.getState()).toMatchObject({ done: 'sent', reference: 'FB-200', sending: false })
  })
  it('send: refused by the service, it says why and nothing is marked sent', async () => {
    const { c } = client(CTX(SERVICE), vi.fn(async () => { throw new Error('The report service at reports.example.org answered 500.') }))
    openFeedback(c, 'Classic hive')
    await settle()
    useFeedback.setState({ words: 'The Ask stopped' })
    await sendReport(c)
    expect(useFeedback.getState()).toMatchObject({ done: 'none', failed: 'The report service at reports.example.org answered 500.', sending: false })
  })
  it('send: a hive without a report service sends nothing', async () => {
    const { c, send } = client(CTX(PUBLIC_BOARD))
    openFeedback(c, 'Classic hive')
    await settle()
    useFeedback.setState({ words: 'The Ask stopped' })
    await sendReport(c)
    expect(send).not.toHaveBeenCalled()
  })
})

describe("a report to a report service carries the person's recent requests and the hive's logs, theirs to leave out", () => {
  const HIVE: FeedbackLogs = {
    version: 'Mac v0.33 (build 691e651a12)', which: 'own hive, Mac install', system: 'Mac', scope: 'hive',
    requests: [
      { at: '2026-11-17T01:23:40.000Z', method: 'POST', route: '/api/ask', status: 429, ms: 61, count: 2, who: 'you' },
      { at: '2026-11-17T01:22:00.000Z', method: 'GET', route: '/api/swarms/{swarm_id}', status: 404, ms: 4, count: 1, who: 'another person' },
    ],
    errors: [
      { id: 'e-1a2b3c4d', at: '2026-11-17T01:23:40.100Z', method: 'POST', route: '/api/ask', status: 429, code: 'rate_limited', message: 'More model calls than the hive allows, ana@example.org.', who: 'you' },
      { id: 'e-0c3f9b12', at: '2026-11-17T01:22:00.000Z', method: 'GET', route: '/api/swarms/{swarm_id}', status: 404, code: 'not_found', who: 'another person' },
    ],
    log: [{ at: '2026-11-17T01:23:39.000Z', level: 'WARNING', logger: 'hive', message: 'the model provider answered 429 to 203.0.113.9' }],
  }
  const serviceWith = (logs: () => Promise<FeedbackLogs>, to: FeedbackContext['to'] = SERVICE) => {
    const send = vi.fn(async () => ({ sent: true as const, to: 'reports.example.org', reference: 'https://github.com/acme/board/issues/7' }))
    const feedbackLogs = vi.fn(logs)
    return { c: { feedback: vi.fn(async () => CTX(to)), sendFeedback: send, feedbackLogs } as unknown as HiveClient, send, feedbackLogs }
  }
  const sentOf = (send: ReturnType<typeof vi.fn>, call = 0) => (send.mock.calls[call] as unknown[])[0] as Record<string, unknown>

  it('on by default: asked of the hive as the area opens, and sent as shown, cleaned, the person\'s own only', async () => {
    const { c, send, feedbackLogs } = serviceWith(async () => HIVE)
    openFeedback(c, 'Classic hive')
    await settle()
    expect(feedbackLogs).toHaveBeenCalledTimes(1)
    expect(send).not.toHaveBeenCalled()   // gathered and shown; nothing has left
    useFeedback.setState({ words: 'The Ask stopped' })
    const s = useFeedback.getState()
    expect(s.attach).toMatchObject({ kept: true, loading: false, missing: '' })
    const shown = extrasOfState(s)!
    await sendReport(c)
    const sent = sentOf(send)
    expect(sent.recent_requests).toEqual([{ at: '2026-11-17T01:23:40Z', method: 'POST', route: '/api/ask', status: 429, ms: 61, count: 2, who: 'you' }])
    expect(sent.errors).toEqual([{ at: '2026-11-17T01:23:40Z', id: 'e-1a2b3c4d', where: 'POST /api/ask', status: 429, code: 'rate_limited',
      message: 'More model calls than the hive allows, [email].' }])
    expect(sent.logs).toEqual(['2026-11-17T01:23:39Z WARNING hive: the model provider answered 429 to [address]'])
    expect(sent).toEqual(payloadOf(reportOf(s), s.picture.url, shown))   // exactly what the area showed
    expect(JSON.stringify(sent)).not.toContain('e-0c3f9b12')             // another person's stays on the hive
    expect(useFeedback.getState()).toMatchObject({ done: 'sent', reference: 'https://github.com/acme/board/issues/7' })
  })
  it('switched off: the payload names no requests, errors list or logs', async () => {
    const { c, send } = serviceWith(async () => HIVE)
    openFeedback(c, 'Classic hive')
    await settle()
    useFeedback.setState((st) => ({ words: 'The Ask stopped', attach: { ...st.attach, kept: false } }))
    expect(extrasOfState(useFeedback.getState())).toBeNull()
    await sendReport(c)
    const sent = sentOf(send)
    for (const name of ['recent_requests', 'errors', 'logs']) expect(sent, name).not.toHaveProperty(name)
    expect(JSON.stringify(sent)).not.toContain('/api/ask')
    useFeedback.setState((st) => ({ attach: { ...st.attach, kept: true } }))   // and back on
    await sendReport(c)
    expect(sentOf(send, 1)).toHaveProperty('recent_requests')
  })
  it('the errors left out leave the errors list out too, the requests and logs still going', async () => {
    const { c, send } = serviceWith(async () => HIVE)
    openFeedback(c, 'Classic hive')
    await settle()
    useFeedback.setState({ words: 'The Ask stopped', errorsKept: false })
    await sendReport(c)
    const sent = sentOf(send)
    expect(sent).not.toHaveProperty('errors')
    expect(sent.recent_requests).toHaveLength(1)
    expect(JSON.stringify(sent)).not.toContain('e-1a2b3c4d')
  })
  it('a send waits while they are gathered; a hive that does not give them says why and the report goes without', async () => {
    let answer: (logs: FeedbackLogs) => void = () => undefined
    const slow = serviceWith(() => new Promise<FeedbackLogs>((r) => { answer = r }))
    openFeedback(slow.c, 'Classic hive')
    await settle()
    useFeedback.setState({ words: 'The Ask stopped' })
    expect(useFeedback.getState().attach.loading).toBe(true)
    await sendReport(slow.c)
    expect(slow.send).not.toHaveBeenCalled()
    answer(HIVE)
    await settle()
    await sendReport(slow.c)
    expect(sentOf(slow.send).logs).toHaveLength(1)

    const refused = serviceWith(async () => { throw new Error('only a signed-in person can do that') })
    openFeedback(refused.c, 'Classic hive')
    await settle()
    useFeedback.setState({ words: 'The Ask stopped' })
    expect(useFeedback.getState().attach).toMatchObject({ loading: false, hive: null, missing: 'only a signed-in person can do that' })
    await sendReport(refused.c)
    expect(sentOf(refused.send)).not.toHaveProperty('recent_requests')
  })
  it('the board and the copy are never asked for them: only a report service takes them', async () => {
    const { c, feedbackLogs } = serviceWith(async () => HIVE, PUBLIC_BOARD)
    openFeedback(c, 'Classic hive')
    await settle()
    expect(feedbackLogs).not.toHaveBeenCalled()
    expect(extrasOfState(useFeedback.getState())).toBeNull()
  })
  it('the text shown is the payload line for line, and stays within what the hive takes', () => {
    const x = extrasOf(HIVE, [], true)
    expect(extrasText(x, 'hive').split('\n')).toEqual([
      'Your recent requests to the hive, newest first:', '2026-11-17T01:23:40Z 429 POST /api/ask, 2 times, the slowest 61 ms', '',
      'Errors, newest first:', '2026-11-17T01:23:40Z 429 rate_limited POST /api/ask (e-1a2b3c4d): More model calls than the hive allows, [email].', '',
      "The hive's own warnings and errors, newest first:", '2026-11-17T01:23:39Z WARNING hive: the model provider answered 429 to [address]',
    ])
    expect(extrasText(extrasOf({ ...HIVE, scope: 'person', log: [] }, [], false), 'person').split('\n')).toEqual([
      'Your recent requests to the hive, newest first:', '2026-11-17T01:23:40Z 429 POST /api/ask, 2 times, the slowest 61 ms', '', 'Errors: left out'])
    const many: FeedbackLogs = { ...HIVE,
      requests: Array.from({ length: 100 }, () => HIVE.requests[0]),
      errors: Array.from({ length: 100 }, (_, i) => ({ ...HIVE.errors[0], id: `e-${String(i).padStart(8, '0')}`, message: 'm'.repeat(3000) })),
      log: Array.from({ length: 500 }, () => HIVE.log[0]) }
    const cut = extrasOf(many, [], true)
    expect(cut.recent_requests).toHaveLength(50)
    expect(cut.errors!.length).toBeLessThanOrEqual(100)
    expect(cut.logs.length).toBeLessThanOrEqual(400)
    expect(new TextEncoder().encode(JSON.stringify([cut.recent_requests, cut.errors, cut.logs])).length).toBeLessThanOrEqual(200 * 1024)
    expect(cut.recent_requests.length + cut.errors!.length).toBeGreaterThan(50)   // the oldest go first, never all of it
  })
})

describe("the hive's logs", () => {
  const LOGS: FeedbackLogs = {
    version: 'Mac v0.33 (build 691e651a12)', which: 'own hive, Mac install', system: 'Mac', scope: 'hive',
    requests: [{ at: '2026-11-17T01:23:40.000Z', method: 'POST', route: '/api/ask', status: 429, ms: 61, count: 2, who: 'you' }],
    errors: [], log: [{ at: '2026-11-17T01:23:39.000Z', level: 'WARNING', logger: 'hive', message: 'the model provider answered 429' }],
  }
  const withLogs = (logs: () => Promise<FeedbackLogs>) => ({ feedback: vi.fn(async () => CTX(PUBLIC_BOARD)), feedbackLogs: vi.fn(logs) }) as unknown as HiveClient & { feedbackLogs: ReturnType<typeof vi.fn> }

  it('are gathered only on their press, shown whole, and saved or copied exactly as shown', async () => {
    const c = withLogs(async () => LOGS)
    openFeedback(c, 'Canvas')
    await settle()
    expect(c.feedbackLogs).not.toHaveBeenCalled()
    await showLogs(c)
    const logs = useFeedback.getState().logs
    expect(c.feedbackLogs).toHaveBeenCalledTimes(1)
    expect(logs).toMatchObject({ shown: true, loading: false, scope: 'hive', missing: '', failed: '', done: 'none' })
    expect(logs.file).toMatch(/^omega-hive-logs-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\dZ\.txt$/)
    expect(logs.text.split('\n').slice(1, 4)).toEqual(['Version: Mac v0.33 (build 691e651a12)', 'Hive: own hive, Mac install',
      'Device: Chrome 131 on macOS; look Canvas; window 1440×900, pixel ratio 2'])
    expect(logs.text).toContain('2026-11-17T01:23:40Z 429 POST /api/ask, 2 times, the slowest 61 ms')
    expect([saved, copied, opened]).toEqual([[], [], []])   // shown, and nothing has left
    saveLogs()
    expect(saved).toEqual([{ name: logs.file, type: 'text/plain;charset=utf-8' }])
    expect(await blobs[0].text()).toBe(logs.text + '\n')
    await copyLogs()
    expect(copied).toEqual([logs.text])
    expect(useFeedback.getState().logs.done).toBe('copied')
  })
  it("without the hive's part, the page's own still shows, saying why", async () => {
    const refused = withLogs(async () => { throw new Error('only a signed-in person can do that') })
    openFeedback(refused, 'Canvas')
    await showLogs(refused)
    expect(useFeedback.getState().logs).toMatchObject({ shown: true, scope: 'page', missing: 'only a signed-in person can do that' })
    expect(useFeedback.getState().logs.text).toContain("The hive's part is missing: only a signed-in person can do that")
    const old = { feedback: vi.fn(async () => CTX(PUBLIC_BOARD)) } as unknown as HiveClient   // a hive from before the logs
    openFeedback(old, 'Canvas')
    await showLogs(old)
    expect(useFeedback.getState().logs).toMatchObject({ shown: true, scope: 'page', missing: 'this hive does not give its logs yet' })
  })
  it('nothing is saved or copied before they are shown, and closing the area forgets them', async () => {
    const c = withLogs(async () => LOGS)
    openFeedback(c, 'Canvas')
    saveLogs()
    await copyLogs()
    expect([saved, copied]).toEqual([[], []])
    await showLogs(c)
    closeFeedback()
    expect(useFeedback.getState().logs).toMatchObject({ shown: false, text: '' })
  })
})
