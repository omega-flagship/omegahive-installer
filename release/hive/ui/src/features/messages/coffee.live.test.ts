import { afterEach, describe, expect, it, vi } from 'vitest'
import { LiveClient } from '../../api/live'
import { COFFEE_NAME, isCoffee, roomMatches, roomSections } from './coffee'

// Coffee UI r3: the live client path against host r4 (release a17bdda, hive/core/rooms.py view()). The parity audit
// (coordination/omegaui/UI_BACKEND_PARITY_AUDIT_20261007.md) found the live Messages list drew only the kinds it listed,
// so the host's Coffee Room was fetched and dropped. These payloads are shaped key for key as rooms.py view() with a
// viewer: `alias` only on the Coffee Room, `pinned`, `origin`, names only. INVENTED data, no network.

const at = (h: number) => `2026-10-07T0${h}:00:00Z`
/** rooms.py view(r, viewer): exactly the keys the host sends. */
function hostView(id: string, kind: string, updated: number, extra: Record<string, unknown> = {}) {
  const out: Record<string, unknown> = {
    id, kind, name: kind === 'coffee' ? 'Coffee Room' : `Room ${id}`, topic: '', owner: 'user:u_1', visibility: kind === 'coffee' ? 'public' : 'private',
    swarm_id: null, seq: 3, created_at: at(1), updated_at: at(updated),
  }
  if (kind === 'coffee') out.alias = 'coffee'
  Object.assign(out, {
    shared_with: [], settings: { minds_follow: false, turn_cap: 3 },
    members: [{ member: 'user:u_1', role: 'owner', name: 'Ada' }, { member: 'agent:a_v', role: 'member', name: 'Vega' }],
    origin: null, pinned: kind === 'coffee', unread: 1, joined: true, me: 'user:u_1', ...extra,
  })
  return out
}
// the host's list is newest first (ORDER BY updated_at DESC); the Coffee Room is not the newest here
const HOST_LIST = [
  hostView('r_dm', 'dm', 9), hostView('r_grp', 'group', 8, { origin: { room_id: 'r_cof', message_id: 'rm_1' } }),
  hostView('r_cof', 'coffee', 7), hostView('r_ch', 'channel', 6), hostView('r_prj', 'project', 5), hostView('r_ses', 'session', 4),
]

function live(payloads: Record<string, unknown>) {
  vi.stubGlobal('localStorage', { getItem: () => 'synthetic-token', setItem: () => undefined, removeItem: () => undefined })
  const fetcher = vi.fn(async (url: string) => {
    const path = new URL(url).pathname.replace(/^\/hive/, '')
    if (!(path in payloads)) return new Response(JSON.stringify({ error: { code: 'not_found', message: 'no such room' } }), { status: 404 })
    return new Response(JSON.stringify(payloads[path]), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
  vi.stubGlobal('fetch', fetcher)
  return { client: new LiveClient('https://example.test/hive/'), fetcher }
}
afterEach(() => vi.unstubAllGlobals())

describe('the live client path shows the Coffee Room (host r4)', () => {
  it('GET /api/rooms: the Coffee Room is pinned first and no room the host returned is dropped', async () => {
    const { client, fetcher } = live({ '/api/rooms': HOST_LIST })
    const rooms = await client.rooms()
    expect(fetcher.mock.calls[0][0]).toBe('https://example.test/hive/api/rooms')
    const { pinned, sections } = roomSections(rooms)
    expect(pinned.map((r) => r.id)).toEqual(['r_cof'])
    expect(pinned[0].name).toBe(COFFEE_NAME)
    const drawn = [...pinned, ...sections.flatMap((s) => s.items)].map((r) => r.id)
    expect(drawn.sort()).toEqual(HOST_LIST.map((r) => r.id as string).sort())
    expect(sections.map((s) => s.kind)).toEqual(['session', 'dm', 'group', 'channel', 'project'])
    // the break-off keeps its link back to the Coffee Room message
    expect(rooms.find((r) => r.id === 'r_grp')!.origin).toEqual({ room_id: 'r_cof', message_id: 'rm_1' })
  })

  it('GET /api/rooms/coffee (#/messages/coffee) loads the room by alias and the route resolves it', async () => {
    const { client, fetcher } = live({ '/api/rooms/coffee': hostView('r_cof', 'coffee', 7) })
    const r = await client.room('coffee')
    expect(fetcher.mock.calls[0][0]).toBe('https://example.test/hive/api/rooms/coffee')
    expect(r.alias).toBe('coffee')
    expect(r.pinned).toBe(true)
    expect(isCoffee(r)).toBe(true)
    expect(roomMatches(r, 'coffee')).toBe(true)
    expect(roomMatches(r, 'r_cof')).toBe(true)
    expect(roomSections([r]).pinned).toHaveLength(1)
  })

  it('a room kind the UI does not know yet still gets a section; a non-Coffee room marked pinned stays in its kind', () => {
    const odd = hostView('r_new', 'workshop', 3) as never
    const pinnedGroup = hostView('r_pg', 'group', 2, { pinned: true }) as never
    const { pinned, sections } = roomSections([odd, pinnedGroup, hostView('r_cof', 'coffee', 1) as never])
    expect(pinned.map((r) => r.id)).toEqual(['r_cof'])
    expect(sections).toEqual([
      { kind: 'group', items: [expect.objectContaining({ id: 'r_pg' })] },
      { kind: 'workshop', items: [expect.objectContaining({ id: 'r_new' })] },
    ])
  })
})
