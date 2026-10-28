import { describe, expect, it } from 'vitest'
import { ApiError } from '../../api/client'
import type { Swarm } from '../../api/types'
import { homesForPick, lookupHomes, type HomesState } from './homesLookup'
import { pickProgramSwarm } from './pickSwarm'

/**
 * Root finding on demo P1 r1: ProgramPage's homes effect set homes=[] both for an empty answer and for a refused or
 * unreadable lookup, so a failure read as "Not set up on any swarm you can see". The effect body is lookupHomes; each
 * state stays distinct, and a cancelled lookup (identity change) reports nothing. INVENTED ids only.
 */
const run = async (client: Parameters<typeof lookupHomes>[0], cancelFirst = false) => {
  const seen: HomesState[] = []
  const cancel = lookupHomes(client, 'commons-explorer', (s) => seen.push(s))
  if (cancelFirst) cancel()
  await new Promise((r) => setTimeout(r, 0))
  return seen
}
const answers = (v: unknown) => ({ programHomes: () => Promise.resolve(v as never) })
const refuses = (e: unknown) => ({ programHomes: () => Promise.reject(e) })

describe('the homes lookup keeps its states apart', () => {
  it('an empty answer is known-empty; a home stays intact', async () => {
    expect(await run(answers({ program: 'x', homes: [] }))).toEqual([{ kind: 'known', homes: [] }])
    expect(await run(answers({ program: 'x', homes: [{ swarm_id: 's_a', why: 'activated here' }] }))).toEqual([{ kind: 'known', homes: [{ swarm_id: 's_a', why: 'activated here' }] }])
  })
  it('a refused or unreadable lookup is failed, never known-empty', async () => {
    expect(await run(refuses(new ApiError(403, 'forbidden', 'no')))).toEqual([{ kind: 'failed', denied: true }])
    expect(await run(refuses(new ApiError(500, 'error', 'boom')))).toEqual([{ kind: 'failed', denied: false }])
    expect(await run(refuses(new TypeError('Failed to fetch')))).toEqual([{ kind: 'failed', denied: false }])
    expect(await run(answers({ program: 'x' }))).toEqual([{ kind: 'failed', denied: false }])   // a malformed answer is not "nowhere"
  })
  it('a host without the route is absent: the client lacks it, or GET /homes answers 404/405/501', async () => {
    expect(await run({})).toEqual([{ kind: 'absent' }])
    for (const status of [404, 405, 501]) expect(await run(refuses(new ApiError(status, 'not_found', 'no route')))).toEqual([{ kind: 'absent' }])
  })
  it('a lookup cancelled before its reply (a new identity, client or app) reports nothing', async () => {
    expect(await run(answers({ program: 'x', homes: [] }), true)).toEqual([])
    expect(await run(refuses(new ApiError(403, 'forbidden', 'no')), true)).toEqual([])
    expect(await run({}, true)).toEqual([])
  })
})

describe('what the picker gets from each state', () => {
  const sw = (id: string, name: string, extra: Partial<Swarm> = {}): Swarm => ({ id, name, description: '', hue: 0, member_ids: [], created_at: '', coordinator_id: `${id}_c`, ...extra })
  const swarms = { s_a: sw('s_a', 'Alder'), s_t: sw('s_t', 'Truth room') }
  const agents = { s_a_c: { id: 's_a_c', swarm_id: 's_a', status: 'awake' }, s_t_c: { id: 's_t_c', swarm_id: 's_t', status: 'awake' } } as never
  it('pending and failed: no pick at all (never a guess, never a wider set)', () => {
    expect(homesForPick({ kind: 'pending' })).toBeUndefined()
    expect(homesForPick({ kind: 'failed', denied: false })).toBeUndefined()
    expect(homesForPick({ kind: 'failed', denied: true })).toBeUndefined()
  })
  it('known: the homes, empty included; absent: no homes, under the same eligibility and privacy guards', () => {
    expect(homesForPick({ kind: 'known', homes: [] })).toEqual([])
    expect(homesForPick({ kind: 'absent' })).toBeNull()
    const usable = new Set(['s_a', 's_t'])
    expect(pickProgramSwarm({ swarms, agents, homes: homesForPick({ kind: 'absent' }) ?? null, usable, remembered: null, defaultSwarm: null })).toBe('s_a')
    expect(pickProgramSwarm({ swarms: { s_t: swarms.s_t }, agents, homes: null, usable, remembered: null, defaultSwarm: null })).toBeNull()   // private only
    expect(pickProgramSwarm({ swarms, agents, homes: null, usable: new Set(['s_t']), remembered: null, defaultSwarm: null })).toBeNull()   // usable only private
  })
})
