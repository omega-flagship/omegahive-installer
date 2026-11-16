import { describe, expect, it, vi } from 'vitest'
import { authorName, requestChildren, requestProgress } from './vibeRoute'
import type { HiveClient } from '../../../api/client'

// A proposal's author as a person reads it, on the shapes the live hive answers with (invented data, no network): the
// hive records a request helper's proposal under its bare mind id (minds.py claims actor) and names the helper after
// its template, so a mind the team started for this request, or one this page does not know, is said as the team; any
// other mind by its name; never by its id (vibeRoute authorName, from GET /api/teams/{swarm}/children, whose rows
// carry child_id, request_id and state).
const TEAM = 'Create · Code'
const HELPER = 'a_3f69c61d422c5fc5621211adfc8fb5da'
// the hive's child_view rows, two pages: this request's helper (running), another request's, a failed earlier attempt
const pages: Record<string, unknown> = {
  first: { children: [{ child_id: 'a_other', request_id: 'rq_other', team_id: 's_code', state: 'running' }], next_cursor: 'p2' },
  p2: { children: [{ child_id: HELPER, request_id: 'rq_1', team_id: 's_code', state: 'running' }, { child_id: 'a_failed', request_id: 'rq_1', team_id: 's_code', state: 'failed' }], next_cursor: null },
}
const children = (over?: (cursor?: string) => unknown) => vi.fn(async (_swarm: string, cursor?: string) => (over ? over(cursor) : pages[cursor ?? 'first']))
const team = (teamChildren?: HiveClient['teamChildren']) => ({ teamChildren, listRequests: vi.fn(async () => []) }) as unknown as HiveClient

describe('requestChildren: the minds the team started for this request', () => {
  it('reads every page, keeps only this request’s rows, by child_id', async () => {
    const c = team(children())
    expect(await requestChildren(c, 's_code', 'rq_1')).toEqual(new Map([[HELPER, 'running'], ['a_failed', 'failed']]))
    expect(c.teamChildren).toHaveBeenCalledTimes(2)
  })
  it('every child of the team when no request is named (the drawer’s read)', async () => {
    expect([...(await requestChildren(team(children()), 's_code', null))!.keys()]).toEqual(['a_other', HELPER, 'a_failed'])
  })
  it('requestProgress: started by a live child, never by a failed one alone', async () => {
    expect((await requestProgress(team(children()), 's_code', 'rq_1'))?.started).toBe(true)
    const failedOnly = children(() => ({ children: [{ child_id: 'a_failed', request_id: 'rq_1', state: 'failed' }], next_cursor: null }))
    expect((await requestProgress(team(failedOnly), 's_code', 'rq_1'))?.started).toBe(false)
    expect(await requestProgress(team(undefined), 's_code', 'rq_1')).toBeNull()
  })
  it('an answer it cannot read is an error, never "no children"', async () => {
    await expect(requestChildren(team(children(() => ({ minds: [] }))), 's_code', 'rq_1')).rejects.toThrow('not understood')
  })
})

describe('authorName: never a mind’s id', () => {
  const store: Record<string, string> = { [HELPER]: 'foundation.code-helper.v1 3f2a', a_anvil: 'Anvil' }
  const who = (author: string) => store[author.startsWith('agent:') ? author.slice(6) : author] ?? null
  it('this request’s helper, known to the page only by its template’s name: the team', async () => {
    expect(await authorName(team(children()), HELPER, 's_code', 'rq_1', TEAM, who)).toBe(TEAM)
    expect(await authorName(team(children()), `agent:${HELPER}`, 's_code', 'rq_1', TEAM, who)).toBe(TEAM)
  })
  it('a mind the page does not know: the team, with no read made', async () => {
    const c = team(children())
    expect(await authorName(c, 'a_unknown', 's_code', 'rq_1', TEAM, who)).toBe(TEAM)
    expect(c.teamChildren).not.toHaveBeenCalled()
  })
  it('a standing mind of the team the page knows by name: its name', async () => {
    expect(await authorName(team(children()), 'agent:a_anvil', 's_code', 'rq_1', TEAM, who)).toBe('Anvil')
  })
  it('a children read that fails, or no such read: the team', async () => {
    expect(await authorName(team(children(() => { throw new Error('network') })), 'agent:a_anvil', 's_code', 'rq_1', TEAM, who)).toBe(TEAM)
    expect(await authorName(team(undefined), 'agent:a_anvil', 's_code', 'rq_1', TEAM, who)).toBe(TEAM)
  })
})
