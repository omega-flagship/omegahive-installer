import { describe, expect, it } from 'vitest'
import type { Agent, Message } from '../../api/types'
import { recentChats, RECENT_MAX } from './recent'
import { NAV_ITEMS } from '../../shell/navItems'
import { FEATURES } from '../registry'
import { reach } from '../../experiences/coverage'
import { EXPERIENCES } from '../../experiences/registry'
import proSource from '../../experiences/professional/index.tsx?raw'
import townSource from '../../experiences/omegatown/index.tsx?raw'
import storeSource from '../../store/store.ts?raw'

const agent = (id: string, kind: Agent['kind'] = 'omega') => ({ id, kind, name: id, hue: 200, status: 'awake' }) as unknown as Agent
const msg = (agent_id: string, sender: string, created_at: string, direction: Message['direction'] = 'in'): Message => ({ id: `${agent_id}-${created_at}`, agent_id, conversation_id: 'c', direction, sender, text: 'x', created_at })
const agents = { a: agent('a'), b: agent('b'), c: agent('c', 'iter'), mod: agent('mod', 'module') }

describe('Recent conversations: the minds this person talked to, newest first', () => {
  it('this client\'s own sends and this person\'s own read messages, newest first', () => {
    const rows = recentChats(
      { chattedAt: { a: '2026-10-09T10:00:00Z' }, messages: { b: [msg('b', 'user:p_me', '2026-10-09T11:00:00Z'), msg('b', 'agent:b', '2026-10-09T11:01:00Z', 'out')], c: [msg('c', 'user:p_me', '2026-10-09T09:00:00Z')] }, agents },
      'user:p_me',
    )
    expect(rows.map((r) => r.id)).toEqual(['b', 'a', 'c'])
    expect(rows[0].at).toBe('2026-10-09T11:00:00Z')
  })
  it('a mind someone else talked to (another person, or the shared operator name) is not this person\'s conversation', () => {
    const rows = recentChats({ chattedAt: {}, messages: { a: [msg('a', 'user:p_other', '2026-10-09T11:00:00Z')], b: [msg('b', 'user:operator', '2026-10-09T11:00:00Z')] }, agents }, 'user:p_me')
    expect(rows).toEqual([])
    // before /me answers, only this client's own sends count
    expect(recentChats({ chattedAt: {}, messages: { a: [msg('a', 'user:p_me', '2026-10-09T11:00:00Z')] }, agents }, undefined)).toEqual([])
  })
  it('only minds this person can see now and can talk to; at most RECENT_MAX', () => {
    expect(recentChats({ chattedAt: { gone: '2026-10-09T10:00:00Z', mod: '2026-10-09T10:00:00Z' }, messages: {}, agents }, 'user:p_me')).toEqual([])
    const many = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`m${i}`, agent(`m${i}`)]))
    const sent = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`m${i}`, new Date(Date.UTC(2026, 9, 9, 0, i)).toISOString()]))
    const rows = recentChats({ chattedAt: sent, messages: {}, agents: many }, null)
    expect(rows).toHaveLength(RECENT_MAX)
    expect(rows[0].id).toBe('m19')
  })
  it('a send records it (store), and it is one step away in every look: classic nav, Professional, OmegaTown, every directory', () => {
    expect(storeSource).toContain('chattedAt: { ...s.chattedAt, [agentId]: p.created_at }')
    const item = NAV_ITEMS.find((i) => i.key === 'conversations')!
    expect(item).toMatchObject({ label: 'Recent conversations', route: { name: 'conversations' }, feature: 'talk.recent' })
    expect(item.admin).toBeUndefined()
    const f = FEATURES.find((x) => x.id === 'talk.recent')!
    expect(f.classic).toEqual({ name: 'conversations' })
    for (const e of EXPERIENCES) expect(reach(e.id, f), e.id).not.toBe('gap')
    expect(proSource).toMatch(/<nav>\{VIEWS\.map[\s\S]*?onClick=\{\(\) => byId\('talk\.recent'\)\}>Recent conversations<\/button><\/nav>/)
    expect(townSource).toContain("onClick={() => feature('talk.recent')}>Recent conversations</button>")
  })
})
