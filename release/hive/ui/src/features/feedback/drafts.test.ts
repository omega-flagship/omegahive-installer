// Purpose: tests the feedback area's drafts (features/feedback/drafts.ts): which of the page's errors the hive drafts a
// report from, one draft per cause however often it happens, a settled cause never drafted again in the tab, the
// minds' drafts read from the hive and its events, and an identity change forgetting every draft.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HiveClient } from '../../api/client'
import type { FeedbackDraft } from '../../api/types'
import { clearPageErrors, noteError, type PageError } from '../../lib/recentErrors'
import { useHive } from '../../store/store'
import { draftEvent, draftFrom, draftIdOf, loadMindDrafts, noticed, setMindDrafts, settleDraft, useDrafts, watchHiveDrafts } from './drafts'

const at = (s: number) => `2026-11-16T03:${String(s).padStart(2, '0')}:00Z`
const err = (over: Partial<PageError>): PageError => ({ at: at(0), kind: 'request', where: 'GET /api/swarms/:id', message: 'The hive hit an error it did not expect.', ...over })
const MIND: FeedbackDraft = {
  id: 'fd-51a1d2a7', kind: 'bug', title: 'A search tool kept failing', words: 'The web search tool failed three times.', steps: null, expected: 'It finds things.',
  source: { kind: 'mind', agent: 'a_vega01', name: 'Vega', conversation: null }, created: '2026-11-16T03:05:00.123Z',
}
const changeIdentity = () => useHive.setState((s) => ({ inits: s.inits + 1 }))

afterEach(() => {
  changeIdentity()
  clearPageErrors()
})

describe('what the hive drafts a report from', () => {
  it.each([
    ['a 500 with its error id', err({ status: 500, code: 'internal_error', id: 'e-1a2b3c4d' }), 'The hive answered 500 internal_error to GET /api/swarms/:id (error e-1a2b3c4d): The hive hit an error it did not expect.'],
    ['a 503 without one', err({ status: 503, code: 'service_unavailable' }), 'The hive answered 503 service_unavailable to GET /api/swarms/:id: The hive hit an error it did not expect.'],
    ['a mind that stopped', err({ kind: 'mind', where: 'Vega', code: 'timed_out', message: 'No answer came in time.' }), 'Vega stopped while it owed you an answer: No answer came in time.'],
    ['a refused hand-over', err({ kind: 'handover', where: 'Forge', code: 'not_allowed', message: 'The hive handed "a page" to Forge, and it was refused (not_allowed).' }), 'The hive handed "a page" to Forge, and it was refused (not_allowed).'],
    ['a screen', err({ kind: 'screen', where: 'settings', message: 'boom' }), 'The settings screen could not be drawn: boom'],
  ])('%s', (_, e, words) => {
    expect(noticed(e)?.words).toBe(words)
  })
  it.each([
    ['a 404: the hive answering as it should', err({ status: 404, code: 'not_found' })],
    ['a 409', err({ status: 409, code: 'conflict' })],
    ['a request that never reached the hive', err({ status: 0, code: 'network' })],
    ["the page's own uncaught error", err({ kind: 'page', where: 'Screen.tsx:812' })],
  ])('nothing for %s', (_, e) => {
    expect(noticed(e)).toBeNull()
  })
})

describe('one draft per cause', () => {
  it('the same cause again counts on its draft, newest time and words kept; another cause is a draft of its own, newest first', () => {
    draftFrom(err({ status: 500, code: 'internal_error', id: 'e-00000001', at: at(1) }))
    draftFrom(err({ status: 500, code: 'internal_error', id: 'e-00000002', at: at(3) }))
    draftFrom(err({ kind: 'screen', where: 'settings', message: 'boom', at: at(2) }))
    const drafts = useDrafts.getState().drafts
    expect(drafts.map((d) => [d.title, d.count, d.at])).toEqual([
      ['The hive answered 500 to GET /api/swarms/:id', 2, at(3)],
      ['The settings screen could not be drawn', 1, at(2)],
    ])
    expect(drafts[0].words).toContain('e-00000002')
    expect(drafts[0]).toMatchObject({ origin: 'hive', kind: 'bug', draftedBy: 'the hive', id: draftIdOf('request 500 internal_error GET /api/swarms/:id') })
  })
  it('a settled cause is not drafted again in the tab; another cause still is', async () => {
    draftFrom(err({ status: 500, code: 'internal_error' }))
    const [d] = useDrafts.getState().drafts
    await settleDraft(null, d.id)
    draftFrom(err({ status: 500, code: 'internal_error', at: at(9) }))
    draftFrom(err({ status: 502, code: 'bad_gateway' }))
    expect(useDrafts.getState().drafts.map((x) => x.title)).toEqual(['The hive answered 502 to GET /api/swarms/:id'])
  })
  it("watches the page's errors as they come, each error once", () => {
    const stop = watchHiveDrafts()
    noteError({ kind: 'mind', where: 'Vega', code: 'timed_out', message: 'No answer came in time.' })
    noteError({ kind: 'request', where: 'GET /api/x', status: 404, code: 'not_found', message: 'no' })
    noteError({ kind: 'page', where: 'a.ts:1', message: 'x' })
    expect(useDrafts.getState().drafts.map((d) => [d.title, d.count])).toEqual([['Vega stopped while it owed you an answer', 1]])
    stop()
  })
})

describe("the minds' drafts", () => {
  it('are read from the hive beside what it noticed, by the mind that drafted them', async () => {
    draftFrom(err({ status: 500, code: 'internal_error', at: at(1) }))
    const feedbackDrafts = vi.fn(async () => ({ drafts: [MIND] }))
    await loadMindDrafts({ feedbackDrafts } as unknown as HiveClient)
    expect(useDrafts.getState().drafts.map((d) => [d.origin, d.draftedBy, d.at])).toEqual([['mind', 'Vega, a mind', '2026-11-16T03:05:00Z'], ['hive', 'the hive', at(1)]])
    // a later read replaces the minds' drafts and leaves the hive's
    setMindDrafts([])
    expect(useDrafts.getState().drafts.map((d) => d.origin)).toEqual(['hive'])
  })
  it("follow the hive's events: a new or repeated draft, and one removed", () => {
    draftEvent({ type: 'feedback.draft', at: 1, principal: 'user:p_ada', draft: MIND } as never)
    draftEvent({ type: 'feedback.draft', at: 2, principal: 'user:p_ada', draft: { ...MIND, words: 'again' } } as never)
    expect(useDrafts.getState().drafts.map((d) => d.words)).toEqual(['again'])
    draftEvent({ type: 'feedback.draft.removed', at: 3, principal: 'user:p_ada', id: MIND.id } as never)
    expect(useDrafts.getState().drafts).toEqual([])
  })
  it("settling one removes it on the hive; when the hive would not, it stays, so the person sees it did not go", async () => {
    setMindDrafts([MIND])
    const ok = vi.fn(async () => undefined)
    await settleDraft({ dismissFeedbackDraft: ok } as unknown as HiveClient, MIND.id)
    expect(ok).toHaveBeenCalledWith(MIND.id)
    expect(useDrafts.getState().drafts).toEqual([])
    setMindDrafts([MIND])
    await settleDraft({ dismissFeedbackDraft: vi.fn(async () => { throw new Error('offline') }) } as unknown as HiveClient, MIND.id)
    expect(useDrafts.getState().drafts.map((d) => d.id)).toEqual([MIND.id])
  })
})

it('an identity change forgets every draft and every settled cause', async () => {
  draftFrom(err({ status: 500, code: 'internal_error' }))
  setMindDrafts([MIND])
  await settleDraft(null, useDrafts.getState().drafts.find((d) => d.origin === 'hive')!.id)
  changeIdentity()
  expect(useDrafts.getState().drafts).toEqual([])
  draftFrom(err({ status: 500, code: 'internal_error' }))
  expect(useDrafts.getState().drafts).toHaveLength(1)
})
