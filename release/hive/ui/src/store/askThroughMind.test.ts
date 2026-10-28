import { afterEach, describe, expect, it, vi } from 'vitest'

const loc = { hash: '#/program/omegadesign/s_des', search: '', pathname: '/' }
const kept = new Map<string, string>()
const storage = { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v), removeItem: (k: string) => void kept.delete(k) }
vi.stubGlobal('window', { location: loc, matchMedia: () => ({ matches: false }), localStorage: storage })
vi.stubGlobal('localStorage', storage)

const { useHive } = await import('./store')
const { threadRows, useAskStore } = await import('./ask')
const { AskRefusal } = await import('../api/ask')
type AskBody = import('../api/ask').AskBody
type HiveClient = import('../api/client').HiveClient

/**
 * ask-fix r2 (Quinn, live a37082e): on Design (OmegaDesign, no coordinator) "Make a poster…" fell back to his own mind.
 * In a swarm with no coordinator the Ask now addresses a mind there (context.mind), which answers itself on a host
 * with Platform's answer-through-mind route; a host without it refuses no_orchestrator and the turn is sent once more
 * with the r1 fallback. Synthetic host, INVENTED ids and names, no network, no model.
 */
const deck = { id: 'a_deck', name: 'Design deck maker (native)', swarm_id: 's_des', status: 'asleep' }
const luke = { id: 'a_luke', name: 'Luke core mind', swarm_id: 's_des', status: 'awake' }
const me = { id: 'a_me', name: 'Quinn', swarm_id: 's_me' }
function host(withRoute: boolean) {
  const posts: AskBody[] = []
  const view = (b: AskBody, mind: { id: string; name: string }) => ({ operation_id: b.operation_id, turn_id: `t_${b.operation_id}`, thread: { id: `th_${mind.id}`, mind, budget_usd: 0.25, spent_usd: 0 }, state: 'accepted' as const, events: [], more: false })
  const client = {
    mode: 'sim',
    ask: vi.fn(async (b: AskBody) => {
      posts.push(structuredClone(b))
      const c = b.context as { mind?: string; swarm_id?: string }
      if (c.mind) {
        if (!withRoute) throw new AskRefusal(409, 'no_orchestrator', 'no orchestrator')   // today's host: ask.py 330-333 -> 297-300
        return view(b, c.mind === deck.id ? deck : luke)
      }
      return view(b, me)   // the person's own mind (no swarm named, no default)
    }),
    askTurn: vi.fn(async () => { throw new AskRefusal(404, 'not_available', 'no such turn') }),
  } as unknown as HiveClient
  return { client, posts }
}
let n = 0
function start(client: HiveClient) {
  useHive.setState({
    client, session: `s-${++n}`, inits: n,
    swarms: { s_des: { id: 's_des', name: 'OmegaDesign', description: '', hue: 0, member_ids: [], created_at: '', coordinator_id: null } },
    agents: { a_deck: deck, a_luke: luke } as never,
    programs: [{ id: 'omegadesign', name: 'OmegaDesign' }] as never,
  })
  useAskStore.getState().bind(useHive.getState().session, 'user:p_quinn')
  useAskStore.setState({ settings: { swarm_id: null, thread_budget_usd: 0.25, eligible: [{ id: 's_lyra', name: 'Lyra' }, { id: 's_kelp', name: 'Kelp Commons' }] }, personal: me })
}
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
const notes = () => threadRows(useAskStore.getState()).filter((r) => r.kind === 'note').map((r) => r.text)
const ctx = { route: '#/program/omegadesign/s_des', experience: 'classic', program: 'omegadesign', swarm_id: 's_des' }

afterEach(() => useAskStore.getState().reset())

describe('a swarm with no coordinator answers through a mind there', () => {
  it('a host with the route: the app’s own mind (name match) is addressed with the swarm, and the note names it', async () => {
    const h = host(true)
    start(h.client)
    await useAskStore.getState().send('Make a poster inviting neighbours to a small community event', ctx)
    await flush()
    expect(h.posts).toHaveLength(1)
    expect(h.posts[0].context).toMatchObject({ swarm_id: 's_des', mind: 'a_deck' })
    expect(notes()).toContain('Answering: Design deck maker (native)')
    // j0-fixes r1: the explanation is kept for the note's tooltip, never in its visible words
    expect(threadRows(useAskStore.getState()).find((r) => r.kind === 'note')?.detail).toBe('OmegaDesign has no coordinator, so Design deck maker (native) answers directly')
  })
  it('today’s host refuses (no_orchestrator): sent once more with the r1 fallback, no refusal row, the admin fix offered', async () => {
    const h = host(false)
    start(h.client)
    await useAskStore.getState().send('Make a poster inviting neighbours to a small community event', ctx)
    await flush()
    expect(h.posts).toHaveLength(2)
    expect(h.posts[0].context).toMatchObject({ mind: 'a_deck' })
    expect(h.posts[1].context).not.toHaveProperty('mind')
    expect(h.posts[1].context).not.toHaveProperty('swarm_id')
    const rows = threadRows(useAskStore.getState())
    expect(rows.some((r) => r.kind === 'refused')).toBe(false)
    expect(rows.filter((r) => r.kind === 'you')).toHaveLength(1)
    const fix = rows.find((r) => r.kind === 'note' && r.fixCoordinator)
    expect(fix).toMatchObject({ swarm: 's_des', text: 'Answering: you', detail: 'OmegaDesign has no coordinator' })
  })
})

describe('Platform 80d066e shapes: follow-ups, mind_asleep, modules', () => {
  it('a follow-up keeps sending context.mind for the thread, also from a page with no swarm', async () => {
    const h = host(true)
    start(h.client)
    await useAskStore.getState().send('Make a poster', ctx)
    await flush()
    // the awake mind would now rank first; the thread keeps its mind
    useHive.setState({ agents: { a_deck: { ...deck, status: 'asleep' }, a_luke: luke } as never })
    useAskStore.setState({ open: null })
    await useAskStore.getState().send('make the title bigger', ctx)
    await flush()
    useAskStore.setState({ open: null })
    await useAskStore.getState().send('and the date smaller', { route: '#/', experience: 'classic' })
    await flush()
    expect(h.posts.map((b) => (b.context as { mind?: string }).mind)).toEqual(['a_deck', 'a_deck', 'a_deck'])
  })
  it('mind_asleep (no conductor): sent once more with the r1 fallback, no refusal row', async () => {
    const posts: AskBody[] = []
    const client = {
      mode: 'sim',
      ask: vi.fn(async (b: AskBody) => {
        posts.push(structuredClone(b))
        if ((b.context as { mind?: string }).mind) throw new AskRefusal(409, 'mind_asleep', 'asleep', { mind: { id: deck.id, name: deck.name } })
        return { operation_id: b.operation_id, turn_id: 't', thread: { id: 'th_me', mind: me, budget_usd: 0.25, spent_usd: 0 }, state: 'accepted' as const, events: [], more: false }
      }),
      askTurn: vi.fn(async () => { throw new AskRefusal(404, 'not_available', 'x') }),
    } as unknown as HiveClient
    start(client)
    await useAskStore.getState().send('Make a poster', ctx)
    await flush()
    expect(posts).toHaveLength(2)
    expect(posts[1].context).not.toHaveProperty('mind')
    expect(threadRows(useAskStore.getState()).some((r) => r.kind === 'refused')).toBe(false)
  })
})

describe('the admin’s fix stays beside "Answering for you"', () => {
  it('a make request answered by the person’s own mind (acting_as) still carries the coordinator fix', async () => {
    const client = {
      mode: 'sim',
      ask: vi.fn(async (b: AskBody) => {
        if ((b.context as { mind?: string }).mind) throw new AskRefusal(409, 'no_orchestrator', 'x')
        return { operation_id: b.operation_id, turn_id: 't', thread: { id: 'th_me', mind: me, budget_usd: 0.25, spent_usd: 0 }, state: 'accepted' as const, events: [], more: false, acting_as: { mind_id: me.id, name: me.name } }
      }),
      askTurn: vi.fn(async () => { throw new AskRefusal(404, 'not_available', 'x') }),
    } as unknown as HiveClient
    start(client)
    await useAskStore.getState().send('Make a poster', ctx)
    await flush()
    const rows = threadRows(useAskStore.getState())
    expect(rows.some((r) => r.kind === 'note' && /Answering for you/.test(r.text))).toBe(true)
    expect(rows.find((r) => r.kind === 'note' && r.fixCoordinator)).toMatchObject({ swarm: 's_des' })
  })
})
