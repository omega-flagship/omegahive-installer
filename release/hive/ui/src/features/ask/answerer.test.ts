import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, createRef, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

/**
 * Who answers (Jon, 2026-10-08: the cloud Ask answered 409 no_mind and the page let him think it "has no model"):
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
const { askOrigin, threadRows, useAskStore } = await import('../../store/ask')
const { AskRefusal } = await import('../../api/ask')
const { answererChip, chipWords, planAsk, withPreselected, resendContext, HOST_SAY, CHOOSE_WHO, CHANGE_WHO } = await import('./answerer')
const { REFUSAL_WORDS } = await import('./words')
const { ThreadLog } = await import('./Thread')
const { FloatingAsk } = await import('./ClassicAsk')
const { AnswererInline, AnswererChipButton } = await import('./AnswererPicker')
const { answererChoice } = await import('./answererChoice')
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
  it('the own-mind chip is one picker button; resting is accessible without a visible gate', () => {
    const own = renderToStaticMarkup(createElement(AnswererInline, { chip: { kind: 'personal', name: 'Deneb', resting: true }, answering: false }))
    expect(own).toContain('aria-label="Answering: you (Deneb), your mind, resting. Asking wakes it. Change who answers"')
    expect(own).toContain('data-answerer-chip="personal"')
    expect(own.match(/<button/g)).toHaveLength(1)
    expect(own).not.toContain('href=')
    expect(own).toContain('>Answering: you (Deneb) <span aria-hidden="true">▾</span>')
    expect(own).not.toContain('>resting<')
    for (const chip of [{ kind: 'choose' as const }, { kind: 'one' as const, swarm: lyra }]) {
      const html = renderToStaticMarkup(createElement(AnswererInline, { chip, answering: false }))
      expect(html).toContain('<button type="button"')
      expect(html).toContain('aria-expanded="false"')
    }
  })
  it('the own-mind picker button is the toggle and exposes its expansion state', () => {
    const onToggle = vi.fn()
    const chip = { kind: 'personal' as const, name: 'Deneb', resting: false }
    const tree = AnswererChipButton({ chip, open: false, onToggle }) as ReactElement<{ onClick: () => void; 'aria-label': string }>
    expect(tree.props['aria-label']).toBe(`Answering: you (Deneb), your mind. ${CHANGE_WHO}`)
    tree.props.onClick()
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(renderToStaticMarkup(createElement(AnswererChipButton, { chip, open: true, onToggle }))).toContain('aria-expanded="true"')
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

it('an unresolved own-mind lookup never becomes a choose wall or a preselected swarm', () => {
  const settings = settingsOf(null, [lyra])
  expect(answererChip({ settings, personal: undefined })).toEqual({ kind: 'loading' })
  const plan = planAsk(ctx, { settings, personal: undefined, swarmOf: () => undefined, thread: null, carry: null, threadOpen: false })
  expect(plan.context).not.toHaveProperty('swarm_id')
  expect(plan.chip).toEqual({ kind: 'loading' })
  const fallback = planAsk({ ...ctx, swarm_id: 's_unavailable' }, { settings, personal: undefined, swarmOf: () => undefined, thread: null, carry: null, threadOpen: false })
  expect(fallback.context).not.toHaveProperty('swarm_id')
  expect(answererChip({ settings, personal: null })).toEqual({ kind: 'one', swarm: lyra })
})
it('own-chip filled dot requires confirmed awake; resting and unknown remain hollow', () => {
  for (const status of ['awake', 'asleep', 'starting', undefined]) {
    const chip = answererChip({ settings: settingsOf(null), personal: { id: 'a_deneb2', name: 'Deneb', status } })!
    const markup = renderToStaticMarkup(createElement(AnswererChipButton, { chip, open: false, onToggle: () => {} }))
    expect(markup).toContain(`data-awake="${status === 'awake'}"`)
    if (!status) expect(markup).not.toContain('your mind, awake')
  }
})

it('a scoped choice is not replaced by the inferred eligible fallback', () => {
  const plan = planAsk({ ...ctx, swarm_id: 's_explicit' }, { settings: settingsOf('s_lyra'), personal: null, swarmOf: () => undefined, thread: null, carry: null, threadOpen: false, explicitChoice: true })
  expect(plan.context).toMatchObject({ swarm_id: 's_explicit' })
  expect(plan).not.toHaveProperty('through')
  expect(plan.note).toBeNull()
})

describe('scoped choice through the actual Ask store', () => {
  it('sends the chosen swarm once without writing a preference or falling back to the sole eligible swarm', async () => {
    const h = host({ eligible: [lyra] })
    await start(h.client)
    const origin = askOrigin()
    answererChoice.select({ kind: 'swarm', swarm: 's_chosen', name: 'Chosen' }, origin.ok)
    await useAskStore.getState().send('hello', { ...ctx, swarm_id: 's_page' })
    expect(h.posts).toHaveLength(1)
    expect(h.posts[0].context).toMatchObject({ swarm_id: 's_chosen' })
    expect(h.puts).toEqual([])
    expect(useAskStore.getState().settings?.swarm_id).toBeNull()
    useAskStore.getState().setThreadOpen(false)
    expect(answererChoice.get()).toBeNull()
  })
  it('preserves the exact private body despite a local swarm choice', async () => {
    const h = host()
    await start(h.client)
    answererChoice.select({ kind: 'swarm', swarm: 's_chosen', name: 'Chosen' }, askOrigin().ok)
    await useAskStore.getState().send('private hello', { private: true })
    expect(h.posts[0].context).toEqual({ private: true })
    expect(h.puts).toEqual([])
  })
  it('reset invalidates a local choice before any subsequent person can use it', async () => {
    const h = host()
    await start(h.client)
    answererChoice.select({ kind: 'swarm', swarm: 's_chosen', name: 'Chosen' }, askOrigin().ok)
    useAskStore.getState().reset()
    expect(answererChoice.get()).toBeNull()
    expect(h.posts).toEqual([])
    expect(h.puts).toEqual([])
  })
})

it('an explicit default save does not claim a refused retry was admitted', async () => {
  const h = host({ refuse: 'no_mind' })
  await start(h.client)
  await useAskStore.getState().send('Keep these words', ctx)
  const op = h.posts[0].operation_id
  vi.mocked(h.client.ask!).mockRejectedValueOnce(new AskRefusal(409, 'no_mind', 'Still no answerer'))
  expect(await useAskStore.getState().chooseAnswerer('s_kelp', op)).toBe('saved-not-sent')
  expect(useAskStore.getState().turns[op].resent).toBe(false)
  expect(h.puts).toEqual([{ swarm_id: 's_kelp' }])
})

describe('explicit saved default supersedes a scoped refusal recipient before repair', () => {
  for (const reason of ['no_orchestrator', 'no_mind', 'mind_asleep'] as const) it(`${reason}: A local → refusal → B default sends B and retains its actual accepted mind`, async () => {
    const h = host()
    await start(h.client)
    const accepted = { ...thread, id: 'ses_kelp', mind: { id: 'a_coral5', name: 'Coral' } }
    vi.mocked(h.client.ask!).mockImplementationOnce(async (body) => { h.posts.push(body); throw new AskRefusal(409, reason, 'invented repairable refusal') })
      .mockImplementationOnce(async (body) => { h.posts.push(body); return { operation_id: body.operation_id, turn_id: 't_kelp', thread: accepted, state: 'accepted' as const } })
    answererChoice.select({ kind: 'swarm', swarm: 's_lyra', name: 'Lyra' }, askOrigin().ok)
    await useAskStore.getState().send('Keep these exact words', ctx)
    const oldOp = h.posts[0].operation_id
    expect(h.posts[0].context).toMatchObject({ swarm_id: 's_lyra' })
    expect(answererChoice.get()).toMatchObject({ swarm: 's_lyra' })
    expect(await useAskStore.getState().chooseAnswerer('s_kelp', oldOp)).toBe('resent')
    expect(h.posts).toHaveLength(2)
    expect(h.posts[1].context).toMatchObject({ swarm_id: 's_kelp' })
    expect(h.posts[1].text).toBe('Keep these exact words')
    expect(h.puts).toEqual([{ swarm_id: 's_kelp' }])
    expect(answererChoice.get()).toBeNull()
    expect(useAskStore.getState().turns[oldOp].resentMind).toEqual({ id: 'a_coral5', name: 'Coral' })
  })
  it('ordinary sends keep their local choice when no explicit default is saved', async () => {
    const h = host(); await start(h.client)
    answererChoice.select({ kind: 'swarm', swarm: 's_lyra', name: 'Lyra' }, askOrigin().ok)
    await useAskStore.getState().send('Ordinary request', ctx)
    expect(h.posts[0].context).toMatchObject({ swarm_id: 's_lyra' })
    expect(answererChoice.get()).toMatchObject({ swarm: 's_lyra' })
    expect(h.puts).toEqual([])
  })
  it('a failed default save keeps the existing local choice and sends nothing', async () => {
    const h = host(); await start(h.client)
    answererChoice.select({ kind: 'swarm', swarm: 's_lyra', name: 'Lyra' }, askOrigin().ok)
    vi.mocked(h.client.setAskSettings!).mockRejectedValueOnce(new Error('invented save failure'))
    expect(await useAskStore.getState().chooseAnswerer('s_kelp')).toBe('failed')
    expect(answererChoice.get()).toMatchObject({ swarm: 's_lyra' })
    expect(h.posts).toEqual([])
  })
})

describe('native answerer grammar without an invented admitted thread', () => {
  it('labels a resolved plan without calling it the current thread', () => {
    expect(chipWords({ kind: 'planned', name: 'Invented Vega' })).toBe('Answering: Invented Vega')
  })
  it('keeps the same named recipient in terminal, office and paper grammar', async () => {
    const { nativeAnswererWords } = await import('./answerer')
    const chip = { kind: 'personal' as const, name: 'Invented Ada', resting: true }
    expect(nativeAnswererWords(chip, 'construct')).toBe('answering: invented ada')
    expect(nativeAnswererWords(chip, 'professional')).toBe('Answering: Invented Ada')
    expect(nativeAnswererWords(chip, 'still')).toBe('Asking Invented Ada · change')
    expect(nativeAnswererWords({ kind: 'loading' }, 'construct')).toBe('finding who answers…')
  })
})
