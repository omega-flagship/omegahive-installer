import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, createRef, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

/**
 * Who answers (the owner, 2026-10-08: the cloud Ask answered 409 no_mind and the page let him think it "has no model"):
 * the host's exact words for no_mind / no_orchestrator with "Choose who answers" right there; choosing saves the
 * default Ask swarm and sends the same words once more; the bar says who answers before the first send; and the
 * person's own mind (Platform P2) is read when the host has it, inert until then. INVENTED data, no network, no model.
 */
const loc = { hash: '#/', search: '', pathname: '/' }
const kv = new Map<string, string>()
const storage = { getItem: (k: string) => kv.get(k) ?? null, setItem: (k: string, v: string) => void kv.set(k, v), removeItem: (k: string) => void kv.delete(k) }
const win = { location: loc, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), addEventListener() {}, removeEventListener() {}, innerWidth: 1440, innerHeight: 900, localStorage: storage }
vi.stubGlobal('window', win)
vi.stubGlobal('localStorage', storage)

const { useHive } = await import('../../store/store')
const { threadRows, useAskStore } = await import('../../store/ask')
const { AskRefusal } = await import('../../api/ask')
const { answererChip, chipWords, withPreselected, resendContext, HOST_SAY, CHOOSE_WHO, CHANGE_WHO } = await import('./answerer')
const { REFUSAL_WORDS } = await import('./words')
const { ThreadLog } = await import('./Thread')
const { FloatingAsk } = await import('./ClassicAsk')
const { AnswererInline, AnswererChipButton } = await import('./AnswererPicker')
type AskBody = import('../../api/ask').AskBody
type AskSettings = import('../../api/ask').AskSettings
type HiveClient = import('../../api/client').HiveClient

const lyra = { id: 's_lyra', name: 'Lyra', orchestrator: { id: 'a_vega01', name: 'Vega', status: 'awake' } }
const kelp = { id: 's_kelp', name: 'Kelp', orchestrator: { id: 'a_coral5', name: 'Coral', status: 'awake' } }
const thread = { id: 'ses_ask1', mind: { id: 'a_vega01', name: 'Vega' }, budget_usd: 0.25, spent_usd: 0 }
const settingsOf = (swarm_id: string | null, eligible = [lyra, kelp]): AskSettings => ({ swarm_id, thread_budget_usd: 0.25, eligible })

/** A synthetic host: refuses with `refuse` while no default is saved (as core/ask.py _route), else admits. */
function host(o: { refuse?: 'no_mind' | 'no_orchestrator'; mind?: unknown; eligible?: typeof lyra[] } = {}) {
  const posts: AskBody[] = []
  const puts: unknown[] = []
  let saved: string | null = null
  const client = {
    mode: 'sim',
    ask: vi.fn(async (b: AskBody) => {
      posts.push(b)
      const ctx = b.context as { swarm_id?: string }
      if (o.refuse === 'no_mind' && !saved && !ctx.swarm_id) throw new AskRefusal(409, 'no_mind', 'Choose a swarm to ask first.')
      if (o.refuse === 'no_orchestrator' && ctx.swarm_id === 's_bare') throw new AskRefusal(409, 'no_orchestrator', 'That swarm has no coordinator to answer. An admin can choose one.')
      return { operation_id: b.operation_id, turn_id: 't1', thread, state: 'accepted' as const, ...(o.mind ? { acting_as: { mind_id: 'a_deneb2', name: 'Deneb' } } : {}) }
    }),
    askTurn: vi.fn(async (op: string) => ({ operation_id: op, turn_id: 't1', events: [], more: false })),
    askSettings: vi.fn(async () => settingsOf(saved, o.eligible)),
    setAskSettings: vi.fn(async (b: { swarm_id?: string | null }) => {
      puts.push(b)
      saved = b.swarm_id ?? null
      return settingsOf(saved, o.eligible)
    }),
    ...(o.mind !== undefined ? { myMind: vi.fn(async () => (o.mind === 404 ? Promise.reject(new AskRefusal(404, 'not_found', 'not found')) : o.mind)) } : {}),
  } as unknown as HiveClient
  return { client, posts, puts }
}
let n = 0
async function start(client: HiveClient) {
  useHive.setState({ client, session: `session-${++n}`, inits: n })
  useAskStore.getState().bind(useHive.getState().session, 'user:p_ada')
  await useAskStore.getState().loadSettings()
  await flush()
}
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}
const rows = () => threadRows(useAskStore.getState())

const ctx = { route: 'hive', experience: 'classic' }

beforeEach(() => {
  loc.hash = '#/'
})
afterEach(() => {
  useAskStore.getState().reset()
})

describe('the host’s words, never models', () => {
  it('no_mind and no_orchestrator say exactly what the host says, and offer "Choose who answers"', () => {
    expect(REFUSAL_WORDS.no_mind.say).toBe('Choose a swarm to ask first.')
    expect(REFUSAL_WORDS.no_orchestrator.say).toBe('That swarm has no coordinator to answer. An admin can choose one.')
    expect(HOST_SAY.no_mind).toBe(REFUSAL_WORDS.no_mind.say)
    for (const r of ['no_mind', 'no_orchestrator'] as const) expect(REFUSAL_WORDS[r].offer?.[0].label).toBe(CHOOSE_WHO)
    for (const w of Object.values(REFUSAL_WORDS)) expect(w.say).not.toMatch(/\bmodels?\b/i)
  })

  it('the thread draws the refusal with the picker control and, for no_orchestrator, the admin wording', () => {
    const html = renderToStaticMarkup(
      createElement(ThreadLog, {
        variant: 'glass',
        rows: [
          { id: 'o1#refused', op: 'o1', kind: 'refused', text: '', reason: 'no_mind' },
          { id: 'o2#refused', op: 'o2', kind: 'refused', text: '', reason: 'no_orchestrator', swarm: 's_bare' },
        ],
      }),
    )
    expect(html).toContain('Choose a swarm to ask first.')
    expect(html).toContain('That swarm has no coordinator to answer. An admin can choose one.')
    expect(html).toContain('An admin can choose one in the swarm’s settings.')
    expect(html.match(/Choose who answers/g)?.length).toBe(2)
    expect(html).not.toMatch(/\bmodels?\b/i)
  })
})

describe('choosing who answers saves the default and sends the same words once more', () => {
  it('no_mind: the picker saves the default swarm, then the same words are sent again, once', async () => {
    const h = host({ refuse: 'no_mind' })
    await start(h.client)
    await useAskStore.getState().send('what changed today?', ctx)
    const op = h.posts[0].operation_id
    expect(rows().find((r) => r.op === op && r.kind === 'refused')?.reason).toBe('no_mind')
    expect(await useAskStore.getState().chooseAnswerer('s_kelp', op)).toBe('resent')
    await flush()
    expect(h.puts).toEqual([{ swarm_id: 's_kelp' }])
    expect(h.posts).toHaveLength(2)
    expect(h.posts[1].text).toBe('what changed today?')
    expect(h.posts[1].operation_id).not.toBe(op)
    // never twice for the same refusal
    expect(await useAskStore.getState().chooseAnswerer('s_lyra', op)).toBe('saved')
    expect(h.posts).toHaveLength(2)
  })

  it('no_orchestrator: the re-send names the chosen swarm (the page’s swarm has no coordinator)', async () => {
    const h = host({ refuse: 'no_orchestrator' })
    await start(h.client)
    await useAskStore.getState().send('hello', { ...ctx, swarm_id: 's_bare', mind: 'a_x' })
    const op = h.posts[0].operation_id
    const refused = rows().find((r) => r.op === op && r.kind === 'refused')
    expect(refused?.reason).toBe('no_orchestrator')
    expect(refused?.swarm).toBe('s_bare')
    await useAskStore.getState().chooseAnswerer('s_lyra', op)
    await flush()
    expect(h.posts[1].context).toMatchObject({ swarm_id: 's_lyra' })
    expect((h.posts[1].context as { mind?: string }).mind).toBeUndefined()
  })

  it('a choice that lands after the person changed is never sent', async () => {
    const h = host({ refuse: 'no_mind' })
    await start(h.client)
    await useAskStore.getState().send('mine', ctx)
    const op = h.posts[0].operation_id
    const p = useAskStore.getState().chooseAnswerer('s_kelp', op)
    useAskStore.getState().bind(useHive.getState().session, 'user:p_bob')
    expect(await p).toBe('failed')
    expect(h.posts).toHaveLength(1)
  })
})

describe('before the first send: the bar says who answers', () => {
  it('no default, no page swarm, nothing addressed, several swarms: "Choose who answers"', () => {
    const chip = answererChip({ settings: settingsOf(null), personal: null })
    expect(chip).toEqual({ kind: 'choose' })
    expect(chipWords(chip!)).toBe('Choose who answers')
  })
  it('exactly one swarm can answer: preselected and shown, and the first send names it', () => {
    const chip = answererChip({ settings: settingsOf(null, [lyra]), personal: null })
    expect(chipWords(chip!)).toBe('Answering: Lyra · change')
    expect(withPreselected(ctx, chip)).toMatchObject({ swarm_id: 's_lyra' })
    expect(withPreselected({ private: true }, chip)).toEqual({ private: true })
  })
  it('nothing shows when something else decides, or before the host has said', () => {
    expect(answererChip({ settings: null, personal: null })).toBeNull()
    expect(answererChip({ settings: settingsOf('s_lyra'), personal: null })).toBeNull()
    expect(answererChip({ settings: settingsOf(null), personal: null, pageSwarm: 's_kelp' })).toBeNull()
    expect(answererChip({ settings: settingsOf(null), personal: null, to: 'a_vega01' })).toBeNull()
  })
  it('the person’s own mind’s chip is a link to that mind (#/me/mind), named for what it opens; the others stay buttons', () => {
    const own = renderToStaticMarkup(createElement(AnswererInline, { chip: { kind: 'personal', name: 'Deneb', resting: true }, answering: false }))
    expect(own).toMatch(/^<div class="ask-answerer-inline"><a [^>]*href="#\/me\/mind"/)
    expect(own).toContain('aria-label="Answering: you (Deneb) · resting: open your mind"')
    expect(own).toContain('data-answerer-chip="personal"')
    // beside it, one "Change" button (r2): the same picker the chip used to open, keyboard reachable as a native button
    expect(own.match(/<button/g)).toHaveLength(1)
    expect(own).toMatch(/<\/a><button type="button" class="ask-chip ask-chip-answerer" data-answerer-change="" aria-label="Change who answers" aria-expanded="false"[^>]*>Change<\/button>/)
    for (const chip of [{ kind: 'choose' as const }, { kind: 'one' as const, swarm: lyra }]) {
      const html = renderToStaticMarkup(createElement(AnswererInline, { chip, answering: false }))
      expect(html).toContain('<button type="button"')
      expect(html).toContain('aria-expanded="false"')
      expect(html).not.toContain('href=')
    }
  })
  it('the own-mind chip’s "Change" opens the picker: it is the toggle, and shows whether it is open', () => {
    const onToggle = vi.fn()
    const chip = { kind: 'personal' as const, name: 'Deneb', resting: false }
    const tree = AnswererChipButton({ chip, open: false, onToggle }) as ReactElement<{ children: ReactElement<{ onClick?: () => void; 'aria-label'?: string; href?: string }>[] }>
    const [link, change] = tree.props.children
    expect(link.props.href).toBe('#/me/mind')
    expect(link.props.onClick).toBeUndefined()
    expect(change.props['aria-label']).toBe(CHANGE_WHO)
    change.props.onClick!()
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(renderToStaticMarkup(createElement(AnswererChipButton, { chip, open: true, onToggle }))).toContain('aria-label="Change who answers" aria-expanded="true"')
    expect(CHANGE_WHO).toBe('Change who answers')
  })
  it('the chip draws its words (the floating bar, Professional and Still share it); the floating Ask is still there', () => {
    const html = renderToStaticMarkup(createElement(AnswererInline, { chip: { kind: 'choose' }, answering: false }))
    expect(html).toContain('data-answerer-chip="choose"')
    expect(html).toContain('Choose who answers')
    expect(renderToStaticMarkup(createElement(AnswererInline, { chip: { kind: 'personal', name: 'Deneb', resting: false }, answering: false }))).toContain('Answering: you (Deneb)')
    expect(renderToStaticMarkup(createElement(AnswererInline, { chip: { kind: 'choose' }, answering: true }))).toBe('')
    const bar = renderToStaticMarkup(createElement(FloatingAsk, { place: { mode: 'phone', bottom: 12, left: 16, width: 358 }, experience: 'classic', inputRef: createRef<HTMLInputElement>(), look: 'capsule' }))
    expect(bar).toMatch(/role="combobox"/)
  })
  it('a mind_asleep from the person’s own mind is marked as theirs on the row', async () => {
    const h = host({ mind: { mind: { id: 'a_deneb2', name: 'Deneb', swarm_id: 's_lyra', status: 'asleep' } } })
    ;(h.client as unknown as { ask: unknown }).ask = vi.fn(async () => {
      throw new AskRefusal(409, 'mind_asleep', 'asleep', { mind: { id: 'a_deneb2', name: 'Deneb' } })
    })
    await start(h.client)
    await useAskStore.getState().send('hi', ctx)
    expect(rows().find((r) => r.kind === 'refused')).toMatchObject({ reason: 'mind_asleep', own: true })
  })
  it('one swarm: the first send works without a saved default', async () => {
    const h = host({ refuse: 'no_mind', eligible: [lyra] })
    await start(h.client)
    await useAskStore.getState().send('first words', ctx)
    expect(h.posts[0].context).toMatchObject({ swarm_id: 's_lyra' })
    expect(rows().some((r) => r.kind === 'refused')).toBe(false)
  })
})

describe('the person’s own mind (Platform P2), inert until the host has it', () => {
  it('a host without the route (404): no mind, the picker flow stays', async () => {
    const h = host({ mind: 404 })
    await start(h.client)
    expect(useAskStore.getState().personal).toBeNull()
    expect(answererChip({ settings: useAskStore.getState().settings, personal: useAskStore.getState().personal })).toEqual({ kind: 'choose' })
  })
  it('GET /api/me/mind {mind}: "Answering: you (<name>)"; an explicit default still wins', async () => {
    const h = host({ mind: { mind: { id: 'a_deneb2', name: 'Deneb', swarm_id: 's_lyra', status: 'awake' } } })
    await start(h.client)
    const personal = useAskStore.getState().personal
    expect(personal?.name).toBe('Deneb')
    expect(chipWords(answererChip({ settings: settingsOf(null), personal })!)).toBe('Answering: you (Deneb)')
    expect(answererChip({ settings: settingsOf('s_kelp'), personal })).toBeNull()
  })
  it('{mind: null}: no mind', async () => {
    const h = host({ mind: { mind: null } })
    await start(h.client)
    expect(useAskStore.getState().personal).toBeNull()
  })
  it('acting_as on the acceptance is said in the thread', async () => {
    const h = host({ mind: { mind: { id: 'a_deneb2', name: 'Deneb', swarm_id: 's_lyra', status: 'awake' } } })
    await start(h.client)
    await useAskStore.getState().send('hi', ctx)
    await flush()
    expect(rows().some((r) => r.kind === 'note' && r.text === 'Answering for you: your mind Deneb.')).toBe(true)
  })
  it('mind_asleep for the person’s own mind: "Your mind is resting", the picker, and a wake behind a confirm', () => {
    const html = renderToStaticMarkup(createElement(ThreadLog, { variant: 'glass', rows: [{ id: 'o#refused', op: 'o', kind: 'refused', text: '', reason: 'mind_asleep', own: true, mind: { id: 'a_deneb2', name: 'Deneb' } }] }))
    expect(html).toContain('Your mind is resting — Ask from a swarm, or wake it.')
    expect(html).toContain('Choose who answers')
    expect(html).toContain('Wake Deneb')
  })
  it('the re-send context: no_mind and mind_asleep re-send as they were; only no_orchestrator names the swarm', () => {
    expect(resendContext(ctx, 'no_mind', 's_lyra')).toBe(ctx)
    expect(resendContext(ctx, 'mind_asleep', 's_lyra')).toBe(ctx)
    expect(resendContext({ private: true }, 'no_orchestrator', 's_lyra')).toEqual({ private: true })
  })
})
