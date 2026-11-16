import { afterEach, describe, expect, it, vi } from 'vitest'
import { SimClient } from './SimClient'
import { SimLab, type LabRecord } from './lab'
import { DEMO_REFUSE } from './demo'
import { DEMO_SLEEP_RULES, DEMO_SPEND_CAP, DEMO_STALLED_RUN, DEMO_STUDIO } from './demo3'
import { SIM_STUDIO_FILES } from './studioFrame'
import { CATALOGUE_ITEMS } from './toolsCatalogue'
import { appDocument } from '../../lib/appFrame'
import { payloadOf } from '../../lib/hostConfirm'
import { DECK_SCHEMA, readSource } from '../../forms/designCanvas/model'
import { saveSentence, STUDIO_OFF_HERE } from '../../forms/designCanvas/words'
import { finalAsResult } from '../../features/programs/HostConfirm'
import { ApiError } from '../client'
import type { HiveEvent, ProgramActBody, WorkGraph } from '../types'

// Backstop (sim-commons r2.1): this file runs the sim's real MeTTa commons (a first seed per process, or live
// publishes); its slowest test took 5529 ms in a full default-worker run under load 26, so 3x that. The default seed is
// cached per process (SimClient seed cache), so this only matters under heavy load.
vi.setConfig({ testTimeout: 165000 }) // ~3x the worst case measured under load (followups-r5)

/** Surface demo D3: Studio, Tools, Lab and Health in plain demo mode. Everything here is INVENTED and in the browser. */

const demoSim = () => new SimClient({ seed: 7, latency: false, autoStart: false, demo: true, persona: 'person', refuse: DEMO_REFUSE })
const plainSim = () => new SimClient({ seed: 7, latency: false, autoStart: false })

afterEach(() => {
  vi.useRealTimers()
})

describe('Health in demo mode: sleep rules, a mind at its cap, refusals', () => {
  it('every listed mind carries its invented sleep rule', () => {
    const sim = demoSim()
    for (const [id, minutes] of Object.entries(DEMO_SLEEP_RULES)) expect(sim.agents.get(id)?.idle_sleep_minutes).toBe(minutes)
  })

  it('Quench is exactly at its cap, asleep, and its usage rows add up to what it spent', async () => {
    const sim = demoSim()
    const q = sim.agents.get(DEMO_SPEND_CAP.mind)!
    expect(q.budget_usd).toBe(DEMO_SPEND_CAP.cap_usd)
    expect(q.spent_usd).toBe(DEMO_SPEND_CAP.cap_usd)
    expect(q.status).toBe('asleep')
    expect(q.last_error).toMatch(/budget_exhausted/)
    const rows = await sim.listUsage({ agent_id: q.id })
    expect(rows.reduce((t, u) => t + u.cost_usd, 0)).toBeCloseTo(DEMO_SPEND_CAP.cap_usd, 5)
    // no other mind is at its cap, so the demo shows one
    expect([...sim.agents.values()].filter((a) => a.budget_usd > 0 && a.spent_usd >= a.budget_usd).map((a) => a.id)).toEqual([q.id])
  })

  it('while the demo runs the hive keeps refusing the capped mind (budget.refused, counting up)', () => {
    vi.useFakeTimers()
    const sim = new SimClient({ seed: 7, latency: false, autoStart: true, demo: true, persona: 'person' })
    const seen: HiveEvent[] = []
    sim.subscribe((e) => void seen.push(e))
    sim.connect()
    vi.advanceTimersByTime(1600)
    const refused = () => seen.filter((e): e is Extract<HiveEvent, { type: 'budget.refused' }> => e.type === 'budget.refused' && e.agent_id === DEMO_SPEND_CAP.mind)
    expect(refused().map((e) => e.count)).toEqual([DEMO_SPEND_CAP.refused_before + 1])
    vi.advanceTimersByTime(75_000)
    expect(refused().map((e) => e.count)).toEqual([DEMO_SPEND_CAP.refused_before + 1, DEMO_SPEND_CAP.refused_before + 2])
    sim.disconnect()
  })

  it('the demo runs ten simulated minutes without an error, Driftwood and Saltmarsh minds included (they have words of their own)', () => {
    vi.useFakeTimers()
    const sim = new SimClient({ seed: 11, latency: false, autoStart: true, demo: true, persona: 'person' })
    for (const id of ['a_drft13', 'a_drft14']) sim.agents.get(id)!.status = 'awake'
    sim.connect()
    expect(() => vi.advanceTimersByTime(600_000)).not.toThrow()
    sim.disconnect()
  })

  it('a sim that is not demo mode keeps its own budgets and rules', () => {
    const sim = plainSim()
    expect(sim.agents.get(DEMO_SPEND_CAP.mind)!.idle_sleep_minutes).not.toBe(DEMO_SLEEP_RULES[DEMO_SPEND_CAP.mind])
    expect(sim.agents.get(DEMO_SPEND_CAP.mind)!.spent_usd).not.toBe(DEMO_SPEND_CAP.cap_usd)
  })
})

const RECORD: LabRecord = {
  runs: [
    {
      suite: 'bench-ops',
      status: 'passed',
      started: 1_700_000_000,
      finished: 1_700_000_090,
      cases: Array.from({ length: 6 }, (_, i) => ({ id: `bench-ops::c${i}`, name: `case ${i}`, status: 'passed' as const, duration_ms: 5000, metrics: [{ name: 'latency', value: 100 + i, unit: 'ms', better: 'lower' as const, target: 400, ok: true }] })),
    },
  ],
}
const lab = (demo: boolean) => new SimLab({ emit: () => undefined, rng: () => 0.5, latency: false, load: () => Promise.resolve(structuredClone(RECORD)), examples: 2, demo })

describe('Lab in demo mode: versions and one stalled run', () => {
  it('one run of the suite stopped making progress: still running, a few recorded cases, started long ago', async () => {
    const l = lab(true)
    const runs = await l.listRuns({ suite: DEMO_STALLED_RUN.suite })
    const stalled = runs.find((r) => r.status === 'running')!
    expect(stalled).toMatchObject({ demo: 'example', finished_at: null })
    const full = await l.get(stalled.id)
    expect(full.cases).toHaveLength(DEMO_STALLED_RUN.cases)
    expect(Date.now() - Date.parse(stalled.started_at)).toBeGreaterThanOrEqual(DEMO_STALLED_RUN.startedMinutesAgo * 60_000 - 1000)
    // the suite is busy as on a hive; cancelling frees it
    await expect(l.start(DEMO_STALLED_RUN.suite)).rejects.toMatchObject({ code: 'already_running' })
    vi.useFakeTimers()
    const cancelled = l.cancel(stalled.id)
    await vi.advanceTimersByTimeAsync(400)
    await cancelled
    expect((await l.get(stalled.id)).status).toBe('cancelled')
  })

  it('every demo run names an invented version, so two versions can be compared; a plain sim has none', async () => {
    const runs = await lab(true).listRuns()
    expect(runs.length).toBeGreaterThanOrEqual(3)
    expect(runs.every((r) => /^[0-9a-f]{12}$/.test(r.commit_sha ?? ''))).toBe(true)
    expect(new Set(runs.map((r) => r.commit_sha)).size).toBe(runs.length)
    const plain = await lab(false).listRuns()
    expect(plain.every((r) => r.commit_sha === null && r.status !== 'running')).toBe(true)
  })
})

describe('Tools in demo mode: the 80-item catalogue and a composition', () => {
  const tools = () => demoSim().programsHost
  it('80 tools, sets, foundations and components, every id once, every link between real items', () => {
    const g = tools().view('omega-tools', 's_lyra', null, 'map')
    const counted = g.items.filter((i) => ['tool', 'set', 'foundation', 'component'].includes(i.kind))
    expect(counted).toHaveLength(80)
    expect(new Set(g.items.map((i) => i.id)).size).toBe(g.items.length)
    const ids = new Set(g.items.map((i) => i.id))
    for (const l of g.links) expect(ids.has(l.from) && ids.has(l.to)).toBe(true)
    expect(counted.filter((i) => i.kind === 'set')).toHaveLength(6)
    // every invented label says so
    for (const i of CATALOGUE_ITEMS) expect(i.label).toMatch(/\(invented (tool|set|foundation|component)\)$/)
  })

  it('compose-set previews a set in the Tools app shape: complete or with open roles, never executed', async () => {
    const host = tools()
    const done = await host.act('omega-tools', 's_lyra', 'compose-set', ['s-plan'])
    expect(done.status).toBe('done')
    expect(done.detail).toMatchObject({ schema: 'omega-tools-composition-preview/v1', sets: ['s-plan'], status: 'complete', executed: false, registered: false, authority: 'none', effects: [] })
    expect(done.message).toMatch(/nothing ran/)
    const open = await host.act('omega-tools', 's_lyra', 'compose-set', ['s-memory'])
    expect(open.detail).toMatchObject({ status: 'incomplete', unresolved_required_slots: ['recall-ranking'], executed: false })
    expect((await host.act('omega-tools', 's_lyra', 'compose-set', ['t-urgency'])).status).toBe('refused')
    // a new invented tool inspects like the first three
    expect((await host.act('omega-tools', 's_lyra', 'inspect-tool', ['t-tally-sightings'])).status).toBe('done')
  })
})

describe('Studio in demo mode: a deck, a design, Save behind the host confirm, a held swarm', () => {
  const ref = (sim: SimClient, swarm: string, id: string) => {
    const rows = (sim as unknown as { mw: { swarmOwned: Record<string, { artifact_id: string; revision: number; digest: string }[]> } }).mw.swarmOwned[swarm]
    const r = rows.find((x) => x.artifact_id === id)!
    return { artifact_id: r.artifact_id, revision: r.revision, digest: r.digest }
  }
  const focus = (r: { artifact_id: string; revision: number; digest: string }) => `studio-source:${JSON.stringify(r)}`
  const confirmed = async (s: SimClient, b: ProgramActBody) => {
    const { payload, digest } = await payloadOf(b)
    return { ...b, confirm_token: (await s.confirmAct('omegadesign', b.swarm_id, b.action, payload, digest)).confirm_token }
  }

  it('Lyra’s deck opens as a deck (the canvas sends it to the Studio); Forge owns a design and a deck', () => {
    const sim = demoSim()
    const deck = sim.programsHost.view('omegadesign', 's_lyra', focus(ref(sim, 's_lyra', 'ar_simdeck')))
    expect(readSource(deck as WorkGraph).kind).toBe('deck')
    const card = sim.programsHost.view('omegadesign', 's_forge', focus(ref(sim, 's_forge', 'ar_simbenchcard')))
    expect(readSource(card as WorkGraph).kind).toBe('studio')
    expect(readSource(sim.programsHost.view('omegadesign', 's_forge', focus(ref(sim, 's_forge', 'ar_simforgedeck'))) as WorkGraph).kind).toBe('deck')
  })

  it('Studio ships its own interface only in demo mode, and the host can frame it', async () => {
    const sim = demoSim()
    expect((await sim.programs()).find((p) => p.id === 'omegadesign')?.ui).toBe(true)
    const ui = await sim.programUi('omegadesign')
    const doc = appDocument(ui.files, 'http://127.0.0.1:5173', crypto.randomUUID(), crypto.randomUUID())
    expect(doc.html).toContain('Content-Security-Policy')
    expect(ui.files).toEqual(SIM_STUDIO_FILES)
    expect((await plainSim().programs()).find((p) => p.id === 'omegadesign')?.ui).toBeUndefined()
    await expect(plainSim().programUi('omegadesign')).rejects.toMatchObject({ status: 404 })
  })

  it('a deck save in Lyra is confirmed by the host, then kept as the next revision', async () => {
    const sim = demoSim()
    const base = ref(sim, 's_lyra', 'ar_simdeck')
    const g = sim.programsHost.view('omegadesign', 's_lyra', focus(base)) as WorkGraph
    const deck = structuredClone((g.items[0] as unknown as { data: { source: { schema: string; slides: { elements: { id: string; text?: string }[] }[] } } }).data.source)
    expect(deck.schema).toBe(DECK_SCHEMA)
    deck.slides[0].elements[0].text = 'Open day at the observatory'
    const body: ProgramActBody = { swarm_id: 's_lyra', action: 'save-source', items: [], params: { editable_source_json: JSON.stringify(deck), source: base }, idempotency_key: crypto.randomUUID() }
    await expect(sim.programAct('omegadesign', body)).rejects.toMatchObject({ status: 403, code: 'confirm_required' })
    const r = await sim.programAct('omegadesign', await confirmed(sim, body))
    expect(r.status).toBe('done')
    expect((r as unknown as { data: { output: { artifact_id: string; revision: number } } }).data.output).toMatchObject({ artifact_id: 'ar_simdeck', revision: base.revision + 1 })
  })

  it('in Forge, where Studio is held, the host refuses the person before any token or act: app_inactive', async () => {
    const sim = demoSim()
    expect(DEMO_STUDIO.activations.find((a) => a.swarm_id === 's_forge')?.active).toBe(false)
    const base = ref(sim, 's_forge', 'ar_simforgedeck')
    const body: ProgramActBody = { swarm_id: 's_forge', action: 'save-source', items: [], params: { editable_source_json: '{}', source: base }, idempotency_key: crypto.randomUUID() }
    const { payload, digest } = await payloadOf(body)
    await expect(sim.confirmAct('omegadesign', 's_forge', 'save-source', payload, digest)).rejects.toMatchObject({ status: 403, code: 'app_inactive' })
    await expect(sim.programAct('omegadesign', body)).rejects.toMatchObject({ status: 403, code: 'app_inactive' })
    // the operator is refused as a non-person first, as on the host
    const op = new SimClient({ seed: 7, latency: false, autoStart: false, demo: true, persona: 'operator' })
    await expect(op.confirmAct('omegadesign', 's_forge', 'save-source', payload, digest)).rejects.toMatchObject({ status: 403, code: 'person_required' })
  })

  it('the canvas says a held-swarm refusal plainly, never as an unknown outcome', () => {
    const r = finalAsResult({ kind: 'failed', error: new ApiError(403, 'app_inactive', 'activate the app in this swarm before human participation'), sent: false } as never)
    expect(r).toMatchObject({ status: 'error', code: 'app_inactive' })
    expect(r.unknown).toBeUndefined()
    expect(saveSentence(r)).toEqual({ text: STUDIO_OFF_HERE, tone: 'warn' })
    expect(STUDIO_OFF_HERE).toMatch(/isn’t switched on in this swarm/)
  })
})
