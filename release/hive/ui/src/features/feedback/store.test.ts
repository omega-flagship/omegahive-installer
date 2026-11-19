// Purpose: tests the feedback area's actions (features/feedback/store.ts) with the browser stood in for: opening makes a
// fresh report and asks the hive what it adds; nothing leaves before the person presses a button; and each press (copy,
// save, open on the board, send) does what it says with the report as the person saw it; and the hive's logs are
// gathered only on their press and saved or copied exactly as shown.
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

const { addPicture, closeFeedback, copyLogs, copyReport, openFeedback, openOnBoard, reportOf, saveLogs, saveReport, sendReport, showLogs, useFeedback } = await import('./store')
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
