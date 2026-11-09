/**
 * The Code canvas's vibe request on the Ask's linkage intents (spec r3.6 §(a); host release main 39c0731) and Jon's
 * apply-to-live-only ruling (2026-10-07), as behaviour over the simulator's invented code service and intents mirror:
 * the route order, the capability fallback, copy-apply on (no Accept, Undo works) and off (the confirm stays), and
 * never /api/requests. INVENTED DATA only; no hive.
 */
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, onTestFinished, vi } from 'vitest'

vi.mock('react-dom', async (orig) => ({ ...(await orig<typeof import('react-dom')>()), createPortal: (node: ReactNode) => node }))
;(globalThis as { document?: unknown }).document ??= { body: {}, activeElement: null, addEventListener() {}, removeEventListener() {}, querySelector: () => null, querySelectorAll: () => [] }
;(globalThis as { HTMLElement?: unknown }).HTMLElement ??= class {}

import type { CodeContext, HiveClient } from '../../../api/client'
import { SimCodeService } from '../../../api/sim/codeService'
import type { WorkspaceHead } from '../suggestions/contract'
import { VibeCard } from './CodeCanvas'
import { DEPENDENT_GROUPS, PLAIN_SUMMARY, type Caps } from './features'
import { vibeFields } from './useVibe'
import { intentsKit, until } from './vibeIntents.testkit'
import { NO_INTENTS, NO_OFFER } from './vibeRoute'
import { VibeSession, type SavedFile } from './vibeSession'

const WS = 'ws_vibeintents'
const CTX: CodeContext = { task_id: 'g_vibeintents', grant_id: 'grant_vibeintents', repository_id: 'sim-suggestions' }
const READY: Caps = { status: 'ready', key: 'k', features: new Set([DEPENDENT_GROUPS, PLAIN_SUMMARY]) }
const NO_TIMER = { set: () => 0 as unknown as ReturnType<typeof setTimeout>, clear: () => undefined }

async function setup(o: { copyApply?: boolean; offer?: null; intents?: false | '404'; applyWaitMs?: number; path?: string; fixedTurn?: string; journal?: 'refused'; proposalWaitMs?: number; spawn?: boolean; children?: boolean; request?: { state: string; result: unknown }; startWaitMs?: number; consentGate?: boolean; consent?: boolean; evidence?: boolean; applyDelayMs?: number } = {}) {
  const path = o.path ?? 'src/greeting.py'
  const svc = new SimCodeService({ workspace_id: WS, task_id: CTX.task_id, copyApply: o.copyApply })
  let ws = (await svc.proxy('GET', `/v1/workspaces/${WS}`, {}, null)) as WorkspaceHead
  const kit = intentsKit(svc, { ctx: CTX, offer: o.offer, intents: o.intents, fixedTurn: o.fixedTurn, journal: o.journal, spawn: o.spawn, children: o.children, request: o.request, consentGate: o.consentGate, consent: o.consent, evidence: o.evidence, applyDelayMs: o.applyDelayMs })
  const f = (await svc.proxy('GET', `/v1/workspaces/${WS}/files`, { path }, null)) as { content: string; digest: string }
  const file: SavedFile = { path, content: f.content, digest: f.digest }
  const session = new VibeSession(NO_TIMER, { pollMs: [5], applyWaitMs: o.applyWaitMs ?? 3000, proposalWaitMs: o.proposalWaitMs ?? 10 * 60_000, startWaitMs: o.startWaitMs })
  const reloads: { generation: number; paths: string[] }[] = []
  const deps = () => ({
    client: kit.client,
    ctx: CTX,
    ws,
    turn: kit.turn,
    onWorkspace: async (h: WorkspaceHead, paths: string[]) => {
      ws = h
      reloads.push({ generation: h.generation, paths })
      session.setDeps(deps())
    },
  })
  session.setDeps(deps())
  const phases: string[] = []
  session.subscribe(() => {
    const k = session.getState().phase.kind
    if (phases[phases.length - 1] !== k) phases.push(k)
  })
  const saved = async () => ((await svc.proxy('GET', `/v1/workspaces/${WS}/files`, { path }, null)) as { content: string; digest: string })
  return { svc, kit, file, session, phases, reloads, saved }
}

function rendered(session: VibeSession, client: HiveClient, file: SavedFile): string {
  const noop = () => undefined
  const vibe = { ...vibeFields(session, session.getState(), { client, file, dirty: false, caps: READY }), ask: async () => undefined, choose: noop, review: noop, send: async () => true as const, finish: noop, reset: noop, undo: async () => undefined, recheck: async () => undefined, setReviewing: noop, setNote: noop }
  return renderToStaticMarkup(createElement(VibeCard, { vibe, mind: { name: 'Anvil', hue: 280 }, file: file.path, onTest: noop, onDrawer: noop, bottom: 84, phone: false }))
}
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ')
const who = () => 'Anvil'

describe('the route: an Ask turn, one code.request intent recorded, then submitted, then the proposal read', () => {
  it('runs in exactly that order, with the r2.13 body bound to the issued scope, and never /api/requests', async () => {
    const { kit, file, session } = await setup()
    let recorded: Record<string, unknown> | null = null
    const record = kit.client.askRecordIntent!
    kit.client.askRecordIntent = (op, body) => ((recorded = body as unknown as Record<string, unknown>), record(op, body))
    await session.ask('use an f-string', null, file, false, who, true)
    const st = session.getState()
    expect(st.phase.kind).toBe('review')
    const at = (re: RegExp) => kit.log.findIndex((l) => re.test(l))
    const probe = at(/^GET \/api\/ask\/intents$/)
    const scope = at(/suggestion-scopes$/)
    const turn = at(/^POST \/api\/ask$/)
    const rec = at(/^POST \/api\/ask\/ask-kit-1\/intents$/)
    const submit = at(/^POST \/api\/ask\/intents\/ai_[0-9a-f]{24}\/submit$/)
    const poll = at(/^GET .*\/suggestions$/)
    const read = at(/^GET .*\/suggestions\/suggestion_/)
    expect([probe, scope, turn, rec, submit, poll, read].every((i) => i >= 0)).toBe(true)
    expect(probe < scope && scope < turn && turn < rec && rec < submit && submit < poll && poll < read).toBe(true)
    // one record, one submit: nothing is sent twice
    expect(kit.log.filter((l) => /\/intents$/.test(l) && l.startsWith('POST'))).toHaveLength(1)
    expect(kit.log.filter((l) => l.endsWith('/submit'))).toHaveLength(1)
    // never the direct request route, and never a write the person relay may not make
    expect(kit.log.some((l) => l.includes('/api/requests'))).toBe(false)
    expect(kit.log.some((l) => /^POST .*\/proposal-applications$/.test(l))).toBe(false)
    // the body is r2.13's, without operation_id, and its origin is the scope this request issued
    const body = recorded as unknown as { kind: string; request: Record<string, unknown> & { origin: Record<string, unknown> } }
    expect(body.kind).toBe('code.request')
    expect(Object.keys(body.request).sort()).toEqual(['budget', 'instruction', 'kind', 'lease', 'lifetime', 'origin', 'title', 'to_swarm'])
    expect(body.request.origin.scope_id).toBe(st.result!.read.record.scope_id)
    expect(body.request.origin.scope_digest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(body.request.origin).toMatchObject({ task_id: CTX.task_id, repository_id: CTX.repository_id, workspace_id: WS })
    expect(st.route).toMatchObject({ team: 'Lyra', copyApply: 'off' })
    expect(st.route!.request_id).toMatch(/^rq_sim/)
  })
})

describe('capability fallback: a hive without the route says so, and sends nothing', () => {
  it('a client with no intents routes: not available, nothing asked', async () => {
    const { kit, file, session } = await setup({ intents: false })
    expect(session.available).toBe(false)
    await session.ask('use an f-string', null, file, false, who, true)
    expect(session.getState().phase).toEqual({ kind: 'unavailable', text: NO_INTENTS })
    expect(kit.log).toEqual([])
  })
  it('a hive that answers the intents read 404 (an older host): not available on this hive, no scope, no turn', async () => {
    const { kit, file, session } = await setup({ intents: '404' })
    await session.ask('use an f-string', null, file, false, who, true)
    expect(session.getState().phase).toEqual({ kind: 'unavailable', text: NO_INTENTS })
    expect(kit.log).toEqual(['GET /api/ask/intents'])
  })
  it('no Code team offer (the live client today): says the hive does not name the team, sends nothing', async () => {
    const { kit, file, session } = await setup({ offer: null })
    await session.ask('use an f-string', null, file, false, who, true)
    expect(session.getState().phase).toEqual({ kind: 'unavailable', text: NO_OFFER })
    expect(kit.log).toEqual(['GET /api/ask/intents'])
  })
})

// r4 [P1] (stand-in r3): Jon's rule is that the person accepts. Copy-apply on never stands in for that OK; a change the
// team puts in without it is said plainly, with Undo, and never shown as accepted.
describe('r4: copy-apply on → still Accept and confirm; a change put in without your OK is labelled, with Undo', () => {
  // INVENTED: calculator.py's `return a - b`; "fix the sum" proposes `return a + b` (the same length, so the sim's
  // controller puts it in by itself when copy-apply is on: the host that does not wait for consent)
  it('the plain summary and Accept are shown first; the controller’s own application is “without your OK”, Undo puts it back', async () => {
    const { kit, file, session, phases, reloads, saved } = await setup({ copyApply: true, path: 'calculator.py', consentGate: false })
    const before = (await saved()).content
    await session.ask('fix the sum', null, file, false, who, true)
    expect(phases).toContain('review')
    expect(session.getState().lands).toBe('confirm')
    await until(() => session.getState().phase.kind === 'applied')
    expect(session.getState().phase).toMatchObject({ kind: 'applied', authorization: 'unconsented', currency: 'current' })
    expect(kit.log.some((l) => l.endsWith('/suggestion-decisions'))).toBe(false)
    const app = session.getState().applied!
    expect((await saved()).content).toBe('def add(a, b):\n    return a + b\n')
    expect(reloads.at(-1)).toEqual({ generation: app.after_generation, paths: ['calculator.py'] })
    const t = text(rendered(session, kit.client, file))
    expect(t).toMatch(/The swarm changed your copy of calculator\.py without your OK/)
    expect(t).toMatch(/You did not accept this change\. Undo puts your copy back as it was\./)
    expect(t).not.toMatch(/Kept|accepted it|Recorded/)
    await session.undo()
    expect(session.getState().phase.kind).toBe('undone')
    expect((await saved()).content).toBe(before)
  })
  it('a change the controller does not put in: it simply waits for the person’s Accept → confirm, with no “so far” note', async () => {
    const { file, session, saved } = await setup({ copyApply: true })
    const before = (await saved()).content
    // INVENTED: the f-string rewrite of greeting.py is shorter than the text it replaces (Code's auto path refuses it)
    await session.ask('use an f-string', null, file, false, who, true)
    expect(session.getState().phase.kind).toBe('review')
    await new Promise((r) => setTimeout(r, 100))
    expect(session.getState().phase.kind).toBe('review')
    expect(session.getState().note).toBeNull()
    expect((await saved()).content).toBe(before)
    session.review(file, false, READY)
    expect(session.getState().reviewing).not.toBeNull()
  })
  it('once the person has sent their decision, the watch stops (their own decide is the change, never “without your OK”)', async () => {
    const { file, session } = await setup({ copyApply: true })
    await session.ask('use an f-string', null, file, false, who, true)
    session.review(file, false, READY)
    await session.send(session.getState().reviewing!)
    expect(session.getState().phase.kind).toBe('done')
    await new Promise((r) => setTimeout(r, 100))
    expect(session.getState().phase.kind).toBe('done')
  })
  it('403 consent_required on the decision: nothing is shown as done; plain words ask to confirm again', async () => {
    const { kit, file, session } = await setup()
    await session.ask('use an f-string', null, file, false, who, true)
    session.review(file, false, READY)
    const { ApiError } = await import('../../../api/client')
    kit.client.codeSuggestionDecide = async () => Promise.reject(new ApiError(403, 'consent_required', 'invented'))
    await session.send(session.getState().reviewing!)
    expect(session.getState().phase.kind).toBe('review')
    expect(session.getState().reviewing).toBeNull()
    expect(session.getState().note).toMatch(/Confirm again\.$/)
  })
})

describe('copy-apply off: the existing Accept and confirm stay, and the card says why', () => {
  it('review, then Accept opens the confirm; the card says the hive asks for your OK', async () => {
    const { kit, file, session, phases } = await setup({ copyApply: false })
    await session.ask('use an f-string', null, file, false, who, true)
    expect(session.getState().phase.kind).toBe('review')
    expect(phases).not.toContain('applying')
    expect(session.getState().route!.copyApply).toBe('off')
    // the probe read the relay's real answer: held → 404 not_relayed
    expect(kit.log.some((l) => /proposal-applications\/application_0{32}$/.test(l))).toBe(true)
    const t = text(rendered(session, kit.client, file))
    expect(t).toMatch(/asks for your OK before a mind’s change goes into your copy/)
    expect(t).toMatch(/Accept/)
    session.review(file, false, READY)
    expect(session.getState().reviewing).not.toBeNull()
  })
})

// vibe-intents r2 [P2]: an application is shown as it is NOW — current (Undo), undone, or stale (no Undo)
describe('r2: the application’s own state decides what is shown', () => {
  /** after the controller applies, `then` runs before the canvas reads it (another tab, another actor) */
  async function appliedThen(then: (svc: SimCodeService, appId: string) => Promise<void>) {
    const t = await setup({ copyApply: true, path: 'calculator.py', consentGate: false })
    const apply = t.svc.applyAsController.bind(t.svc)
    t.svc.applyAsController = async (...args: Parameters<typeof apply>) => {
      const appId = await apply(...args)
      await then(t.svc, appId)
      return appId
    }
    await t.session.ask('fix the sum', null, t.file, false, who, true)
    await until(() => ['applied', 'undone'].includes(t.session.getState().phase.kind))
    return t
  }
  it('current: applied, with Undo', async () => {
    const { session, kit, file } = await appliedThen(async () => undefined)
    expect(session.getState().phase).toMatchObject({ kind: 'applied', currency: 'current' })
    expect(text(rendered(session, kit.client, file))).toMatch(/Undo/)
  })
  it('undone already (another tab): says so; no Undo, no applied', async () => {
    const { session, kit, file } = await appliedThen(async (svc, appId) => {
      const a = (await svc.proxy('GET', `/v1/workspaces/${WS}/proposal-applications/${appId}`, {}, null)) as { application: { after_generation: number; after_tree_digest: string } }
      await svc.proxy('POST', `/v1/workspaces/${WS}/proposal-applications/${appId}/undo`, {}, { operation_id: 'undo-other-tab', expected_generation: a.application.after_generation, expected_tree_digest: a.application.after_tree_digest })
    })
    expect(session.getState().phase).toEqual({ kind: 'undone', elsewhere: true })
    expect(session.getState().applied).toBeNull()
    const t = text(rendered(session, kit.client, file))
    expect(t).toMatch(/already been undone \(perhaps in another tab\)/)
    expect(t).not.toMatch(/\bUndo\b(?! )/)
  })
  it('stale (the copy changed since): shown as applied earlier, without Undo; Undo does nothing', async () => {
    const { session, kit, file } = await appliedThen(async (svc) => void (await svc.fixture('external-edit')))
    expect(session.getState().phase).toMatchObject({ kind: 'applied', currency: 'stale' })
    const t = text(rendered(session, kit.client, file))
    expect(t).toMatch(/changed your copy of calculator\.py without your OK earlier/)
    expect(t).toMatch(/changed since, so Undo can’t put it back/)
    expect(t).not.toMatch(/>\s*Undo\s*</)
    expect(rendered(session, kit.client, file)).not.toMatch(/>Undo</)
    await session.undo()
    expect(kit.log.some((l) => l.endsWith('/undo'))).toBe(false)
  })
})

describe('r2 rulings', () => {
  it('(b) the journal is refused: status unknown — the proposal is re-read, the card never says it was not applied, and a moved copy blocks the confirm', async () => {
    const { kit, file, session } = await setup({ copyApply: true, path: 'calculator.py', journal: 'refused', consentGate: false })
    await session.ask('fix the sum', null, file, false, who, true)
    await until(() => session.getState().phase.kind === 'review')
    expect(session.getState().note).toBe('This may already be in your copy. Check before confirming.')
    const reads = kit.log.filter((l) => /\/suggestions\/suggestion_/.test(l))
    expect(reads.length).toBeGreaterThanOrEqual(2) // read, then re-read for currency and decisions
    // the controller did put it in, so the re-read proposal is stale and cannot be confirmed
    // until the fresh re-read is verified, the confirm is blocked as "checking"; then the moved copy blocks it
    await until(() => session.getState().verify === null)
    expect(session.getState().result!.read.currency).toBe('stale')
    expect(session.blockedWhy(file, false, READY)).toMatch(/source moved|changed/)
    expect(text(rendered(session, kit.client, file))).not.toMatch(/has not gone into your copy|wasn’t put into your copy/)
  })
  it('(c) 409 intent_pending (the conductor already holds an intent on the turn): fail closed — never submitted, replaced or adopted', async () => {
    const { kit, file, session } = await setup({ fixedTurn: 'ask-conducted' })
    await kit.turn('the person’s earlier words') // the turn exists; the conductor recorded its own intent on it
    const theirs = kit.host.record('ask-conducted', { kind: 'code.request', request: { to_swarm: 's_lyra', kind: 'code', title: 'the conductor’s', instruction: 'something else', origin: { task_id: CTX.task_id, repository_id: CTX.repository_id, workspace_id: WS, scope_id: 'scope_conductor', scope_digest: `sha256:${'b'.repeat(64)}`, generation: 1 }, budget: { limit_usd: 0.5 }, lifetime: { until: new Date(Date.now() + 3600_000).toISOString() }, lease: { template_ids: ['tpl_sim_coder'], max_children: 1 } } }).view as { intent_id: string }
    await session.ask('use an f-string', null, file, false, who, true)
    expect(session.getState().phase).toMatchObject({ kind: 'error' })
    expect((session.getState().phase as { text: string }).text).toMatch(/already has a different change waiting/)
    expect(kit.log.some((l) => l.endsWith('/submit'))).toBe(false)
    expect(kit.log.some((l) => l.startsWith('GET /api/ask/intents/'))).toBe(false)
    expect((kit.host.get(theirs.intent_id) as { state: string }).state).toBe('pending')
  })
  it('(a) a fresh scope is minted for each request, before its intent, and each intent carries its own', async () => {
    const { kit, file, session } = await setup()
    const scopes: string[] = []
    const record = kit.client.askRecordIntent!
    kit.client.askRecordIntent = (op, body) => (scopes.push(body.request.origin.scope_id), record(op, body))
    await session.ask('use an f-string', null, file, false, who, true)
    await session.ask('add type hints', null, file, false, who, true)
    expect(scopes).toHaveLength(2)
    expect(new Set(scopes).size).toBe(2)
    const order = kit.log.filter((l) => /suggestion-scopes$|^POST \/api\/ask\/[^/]+\/intents$/.test(l)).map((l) => (l.endsWith('suggestion-scopes') ? 'scope' : 'intent'))
    expect(order).toEqual(['scope', 'intent', 'scope', 'intent'])
  })
})

// ---------------------------------------------------------------------------------------------------------- r3
type Raw = Record<string, unknown> & { request_binding?: { digest: string; content: Record<string, unknown> & { delegated: Record<string, unknown> } } | null }
/** Change what the relay answers for the provenance read (another request, a tampered digest, no binding). */
function onBindingRead(client: HiveClient, change: (raw: Raw) => Raw) {
  const real = client.codeProxy!.bind(client)
  client.codeProxy = (async (m: 'GET' | 'POST', path: string, q: Record<string, string>, body?: unknown) => {
    const r = await real(m, path, q, body)
    return q.include_request_binding === 'true' ? change(structuredClone(r) as Raw) : r
  }) as HiveClient['codeProxy']
}

describe('r3: a proposal is shown only when its retained request provenance is exactly this request’s', () => {
  it('a match is accepted (read with include_request_binding=true, digest and request checked)', async () => {
    const { kit, file, session } = await setup()
    let bound = 0
    onBindingRead(kit.client, (r) => (bound += r.request_binding ? 1 : 0, r))
    await session.ask('use an f-string', null, file, false, who, true)
    expect(session.getState().phase.kind).toBe('review')
    expect(bound).toBe(1) // the proposal shown came from the read with include_request_binding=true
    expect(session.getState().note).toBeNull() // nothing said about a proposal that is not yours
    expect(kit.log.some((l) => /^GET \/api\/code\/proxy\/v1\/workspaces\/[^/]+\/suggestions\/suggestion_/.test(l))).toBe(true)
  })
  for (const [name, change] of [
    ['another request’s', (r: Raw) => ((r.request_binding!.content.delegated.request_id = 'rq_someone_else'), r)],
    ['another scope’s', (r: Raw) => (((r.request_binding!.content.delegated.origin_scope as Record<string, unknown>).scope_id = 'scope_other'), r)],
    ['a tampered digest', (r: Raw) => ((r.request_binding!.digest = 'f'.repeat(64)), r)],
    ['content that no longer matches its digest', (r: Raw) => ((r.request_binding!.content.author = 'agent:intruder'), r)],
    ['a missing binding (null: unbound or legacy)', (r: Raw) => ((r.request_binding = null), r)],
    ['no binding field at all', (r: Raw) => (delete r.request_binding, r)],
  ] as const)
    it(`${name} proposal is not shown or offered, and the wait ends honestly`, async () => {
      // followups-r7 item 4: the wait's clock is a fake one (vitest fake timers, Date only; every real setTimeout the
      // invented team and the poll use still runs). It stands still until the foreign proposal has been read, then moves
      // past the wait's end. So the wait cannot end before the proposal is read and refused (no matter how slow a
      // loaded machine files it; it used to be a 2 s real-time wait, which load once exhausted), and it then ends at once.
      const WAIT_MS = 2000
      vi.useFakeTimers({ toFake: ['Date'] })
      onTestFinished(() => void vi.useRealTimers())
      const t0 = Date.now()
      const { kit, file, session } = await setup({ proposalWaitMs: WAIT_MS })
      onBindingRead(kit.client, (r) => {
        const out = change(r)
        vi.setSystemTime(t0 + WAIT_MS + 1)   // read and refused: now (and only now) the wait's end has passed
        return out
      })
      // while it waits, the person is told plainly that what turned up is not theirs
      const notes: (string | null)[] = []
      session.subscribe(() => notes.push(session.getState().phase.kind === 'working' ? session.getState().note : null))
      await session.ask('use an f-string', null, file, false, who, true)
      expect(kit.log.some((l) => /^GET \/api\/code\/proxy\/v1\/workspaces\/[^/]+\/suggestions\/suggestion_/.test(l))).toBe(true)
      expect(notes.some((n) => !!n && /not yours/.test(n))).toBe(true)
      expect(session.getState().result).toBeNull()
      expect(session.getState().phase).toMatchObject({ kind: 'error' })
      expect((session.getState().phase as { text: string }).text).toMatch(/has not proposed a change yet\. A proposal turned up on the lines you marked, but it is not yours/)
      expect(session.getState().note).toBeNull()
      expect(kit.log.some((l) => l.endsWith('/suggestion-decisions'))).toBe(false)
    })
  it('25 newer proposals before the match: the history is walked page by page to it', async () => {
    const { svc, kit, file, session } = await setup()
    const store = (svc as unknown as { suggestions: Map<string, { record: { id: string; created_at: number; scope_id: string }; content: unknown }> }).suggestions
    const ask = svc.ask.bind(svc)
    svc.ask = async (...a: Parameters<typeof svc.ask>) => {
      const rec = (await ask(...a)) as { id: string; created_at: number }
      const s = store.get(rec.id)!
      for (let i = 0; i < 25; i++) {
        const id = `suggestion_${(i + 1).toString(16).padStart(32, '0')}`
        store.set(id, { record: { ...s.record, id, scope_id: `scope_newer${i}`, created_at: rec.created_at + 1 + i }, content: structuredClone(s.content) })
      }
      return rec
    }
    await session.ask('use an f-string', null, file, false, who, true)
    expect(session.getState().phase.kind).toBe('review')
    expect(kit.log.filter((l) => /\/suggestions$/.test(l)).length).toBeGreaterThanOrEqual(2)
  })
})

describe('r3: one limit for the words, end to end', () => {
  it('a 5000-character request is refused in plain words before anything is issued or sent', async () => {
    const { kit, file, session } = await setup()
    await session.ask('x'.repeat(5000), null, file, false, who, true)
    expect(session.getState().phase).toMatchObject({ kind: 'error' })
    expect((session.getState().phase as { text: string }).text).toMatch(/too long .*\(5000 characters; at most 4000\).*Nothing was sent/)
    expect(kit.log).toEqual([])
  })
  it('the Ask and the Code team receive exactly the same words', async () => {
    const { kit, file, session } = await setup()
    let instruction = ''
    const record = kit.client.askRecordIntent!
    kit.client.askRecordIntent = (op, body) => ((instruction = body.request.instruction), record(op, body))
    const words = `use an f-string ${'é'.repeat(3990)}`.slice(0, 4000)
    await session.ask(`  ${words}  `, null, file, false, who, true)
    expect(kit.words).toEqual([words])
    expect(instruction).toBe(words)
  })
})

describe('r3: the card’s words for each way a change lands', () => {
  it('put in without your OK (r4): says so, with Undo, and never as accepted', async () => {
    const { kit, file, session } = await setup({ copyApply: true, path: 'calculator.py', consentGate: false })
    await session.ask('fix the sum', null, file, false, who, true)
    await until(() => session.getState().phase.kind === 'applied')
    const t = text(rendered(session, kit.client, file))
    expect(t).toMatch(/without your OK/)
    expect(t).toMatch(/Undo/)
    expect(t).not.toMatch(/until you accept|may already be|Kept/)
  })
  it('confirm required: “Nothing changes until you accept and confirm”', async () => {
    const { kit, file, session } = await setup()
    await session.ask('use an f-string', null, file, false, who, true)
    expect(session.getState().lands).toBe('confirm')
    const t = text(rendered(session, kit.client, file))
    expect(t).toMatch(/Nothing changes until you accept and confirm/)
    expect(t).not.toMatch(/may already be/)
  })
  it('unknown (the journal refused): “may already be in your copy”, never “nothing changes until you accept”', async () => {
    const { kit, file, session } = await setup({ copyApply: true, journal: 'refused' })
    await session.ask('use an f-string', null, file, false, who, true)
    await until(() => session.getState().phase.kind === 'review' && !session.getState().verify)
    expect(session.getState().lands).toBe('unknown')
    const t = text(rendered(session, kit.client, file))
    expect(t).toMatch(/may already be in your copy/)
    expect(t).not.toMatch(/Nothing changes until you accept/)
  })
})

describe('r3: an unknown application blocks the confirm until the proposal is freshly re-read', () => {
  it('the re-read fails: blocked, with plain words and Try again; Try again succeeding unblocks it', async () => {
    // INVENTED: the f-string rewrite shortens text, so the controller does not put it in; the copy stays current
    const { kit, file, session } = await setup({ copyApply: true, journal: 'refused' })
    // r4: the re-read is the provenance read (include_request_binding=true) through the relay
    const proxy = kit.client.codeProxy!.bind(kit.client)
    let fail = true
    kit.client.codeProxy = ((m: 'GET' | 'POST', path: string, q: Record<string, string>, body?: unknown) => (fail && q.include_request_binding === 'true' && session.getState().result ? Promise.reject(new Error('the code service did not answer')) : proxy(m, path, q, body))) as HiveClient['codeProxy']
    await session.ask('use an f-string', null, file, false, who, true)
    await until(() => !!session.getState().verify && !session.getState().verify!.busy)
    expect(session.getState().verify!.failed).toMatch(/did not answer/)
    expect(session.blockedWhy(file, false, READY)).toMatch(/Couldn’t check whether this is already in your copy/)
    session.review(file, false, READY)
    expect(session.getState().reviewing).toBeNull()
    expect(text(rendered(session, kit.client, file))).toMatch(/Try again/)
    fail = false
    await session.recheck()
    expect(session.getState().verify).toBeNull()
    expect(session.blockedWhy(file, false, READY)).toBeNull()
    expect(session.getState().note).toBe('This may already be in your copy. Check before confirming.')
  })
})

// r4 [P1] (stand-in r3): every later read of the shown proposal is the provenance read, re-verified, and pinned to the
// digest the person saw; nothing is ever swapped in silently
describe('r4: a refresh re-verifies the request binding and the digest the person saw', () => {
  it('a refresh reads with include_request_binding=true and keeps the same verified proposal', async () => {
    const { kit, file, session } = await setup()
    await session.ask('use an f-string', null, file, false, who, true)
    const n = kit.log.length
    let bound = 0
    onBindingRead(kit.client, (r) => (bound++, r))
    expect(await session.refresh()).toEqual({ ok: true })
    expect(bound).toBe(1)
    expect(kit.log.slice(n).some((l) => l.endsWith('/suggestion-decisions'))).toBe(false)
    expect(session.blockedWhy(file, false, READY)).toBeNull()
  })
  for (const [name, change] of [
    ['another request’s binding', (r: Raw) => ((r.request_binding!.content.delegated.request_id = 'rq_someone_else'), r)],
    ['a tampered binding digest', (r: Raw) => ((r.request_binding!.digest = 'f'.repeat(64)), r)],
    ['no binding at all', (r: Raw) => ((r.request_binding = null), r)],
  ] as const)
    it(`refresh with ${name}: “not yours”, nothing swapped in, and it can’t be accepted`, async () => {
      const { kit, file, session } = await setup()
      await session.ask('use an f-string', null, file, false, who, true)
      const shown = session.getState().result!.read
      onBindingRead(kit.client, change)
      const r = await session.refresh()
      expect(r.ok).toBe(false)
      expect(session.getState().result!.read).toBe(shown)
      expect(session.blockedWhy(file, false, READY)).toMatch(/it is not yours/)
      session.review(file, false, READY)
      expect(session.getState().reviewing).toBeNull()
      expect(text(rendered(session, kit.client, file))).toMatch(/it is not yours/)
    })
  it('refresh finds another digest than the one the person saw: “changed since you saw it”, never a silent swap', async () => {
    const { file, session } = await setup()
    await session.ask('use an f-string', null, file, false, who, true)
    const st = session.getState()
    // the person saw (and this browser verified) a different digest than the one the service now holds
    const seen = { ...st.result!, read: { ...st.result!.read, record: { ...st.result!.read.record, digest: 'e'.repeat(64) } }, integrity: { ...st.result!.integrity, digest: 'e'.repeat(64) } }
    ;(session as unknown as { state: typeof st }).state = { ...st, result: seen }
    const r = await session.refresh()
    expect(r).toEqual({ ok: false, text: 'It changed since you saw it — review again. Open it in the drawer’s Proposals, or ask again.' })
    expect(session.getState().result!.read.record.digest).toBe('e'.repeat(64))
    expect(session.blockedWhy(file, false, READY)).toMatch(/It changed since you saw it — review again/)
  })
})

// r4 [P2] (stand-in r3): the host admits a request before any mind starts (minds.instruct) and refuses a start
// (spawn_disabled) only to the controller: "working" is said only once a mind is seen started for this request
describe('r4: admitted is not working — spawn off is observed, never polled to a timeout', () => {
  it('a mind starts: the card goes from waiting for a mind to working on it', async () => {
    const { kit, file, session } = await setup({ children: true })
    const steps: string[] = []
    session.subscribe(() => { const p = session.getState().phase; if (p.kind === 'working' && steps.at(-1) !== p.step) steps.push(p.step) })
    await session.ask('use an f-string', null, file, false, who, true)
    expect(session.getState().phase.kind).toBe('review')
    expect(steps).toContain('starting')
    expect(steps.indexOf('starting')).toBeLessThan(steps.indexOf('read'))
    expect(kit.log.some((l) => /^GET \/api\/teams\/[^/]+\/children$/.test(l))).toBe(true)
  })
  it('spawning off and no mind ever starts: ends with plain words before the proposal wait, never “working on it”', async () => {
    const { file, session } = await setup({ children: true, spawn: false, startWaitMs: 200, proposalWaitMs: 60_000 })
    const steps: string[] = []
    session.subscribe(() => { const p = session.getState().phase; if (p.kind === 'working' && steps.at(-1) !== p.step) steps.push(p.step) })
    const t0 = Date.now()
    await session.ask('use an f-string', null, file, false, who, true)
    expect(Date.now() - t0).toBeLessThan(20_000)
    expect(steps).not.toContain('mind')
    expect(session.getState().phase).toMatchObject({ kind: 'error', text: expect.stringMatching(/^No mind has started for this request, so nothing is being worked on\. The hive may not be allowed to start minds for requests right now/) })
  })
  it('the request shows the hive refused to start a mind (spawn_disabled): says exactly that', async () => {
    const { file, session } = await setup({ children: true, spawn: false, request: { state: 'failed', result: { code: 'spawn_disabled' } }, startWaitMs: 5000 })
    await session.ask('use an f-string', null, file, false, who, true)
    expect(session.getState().phase).toEqual({ kind: 'error', text: 'The hive isn’t allowed to start minds for requests right now, so nothing is being worked on. Only its operator can switch that on.' })
  })
  it('the card never says the team is working while it waits for a mind', async () => {
    const { kit, file, session } = await setup({ children: true, spawn: false, startWaitMs: 60_000 })
    void session.ask('use an f-string', null, file, false, who, true)
    await until(() => session.getState().phase.kind === 'working' && (session.getState().phase as { step: string }).step === 'starting')
    const t = text(rendered(session, kit.client, file))
    expect(t).toMatch(/Waiting for it to start a mind on this request/)
    expect(t).not.toMatch(/is working on it/)
    session.reset()
  })
})

// r4 [P1], Platform copy-apply consent r1 (66312cd): with copy-apply on, Accept → confirm is the person's consent for
// exactly the digest they were shown; the team puts it in only then. Decline voids it. Never applied by the page itself.
describe('r4: copy-apply on → Accept → confirm sends the consent for the shown digest; the team puts it in only then', () => {
  it('Accept → confirm: POST …/accept with the shown digest, "valid for 10 minutes", then the team’s application is yours (not “without your OK”), with Undo', async () => {
    const { kit, file, session, saved } = await setup({ copyApply: true, path: 'calculator.py', consent: true })
    const before = (await saved()).content
    await session.ask('fix the sum', null, file, false, who, true)
    expect(session.getState().phase.kind).toBe('review')
    await new Promise((r) => setTimeout(r, 60))
    expect((await saved()).content).toBe(before) // the gate holds the controller until the person's OK
    const shown = session.getState().result!.read.record
    let body: unknown = null
    const give = kit.client.proposalConsent!
    kit.client.proposalConsent = (rq, id, d, digest) => ((body = { rq, id, d, digest }), give(rq, id, d, digest))
    session.review(file, false, READY)
    await session.send(session.getState().reviewing!)
    expect(body).toEqual({ rq: session.getState().result?.sent.request_id ?? expect.any(String), id: shown.id, d: 'accept', digest: shown.digest })
    expect(kit.log.some((l) => l.endsWith('/suggestion-decisions'))).toBe(false)
    expect(kit.log.some((l) => /^POST \/api\/requests\/rq_sim[0-9a-f]+\/proposals\/suggestion_[0-9a-f]{32}\/accept$/.test(l))).toBe(true)
    await until(() => ['consented', 'applied'].includes(session.getState().phase.kind))
    if (session.getState().phase.kind === 'consented') expect(text(rendered(session, kit.client, file))).toMatch(/You accepted it\. Your OK is valid for 10 minutes\./)
    await until(() => session.getState().phase.kind === 'applied')
    expect(session.getState().phase).toMatchObject({ kind: 'applied', currency: 'current' })
    expect(session.getState().phase).toMatchObject({ authorization: 'consented', acceptedHere: true })
    expect((await saved()).content).toBe('def add(a, b):\n    return a + b\n')
    expect(text(rendered(session, kit.client, file))).not.toMatch(/without your OK/)
    await session.undo()
    expect((await saved()).content).toBe(before)
  })
  it('the consented card says “valid for 10 minutes” while it waits for the team', async () => {
    const { kit, file, session } = await setup({ copyApply: true, path: 'calculator.py', consent: true })
    await session.ask('fix the sum', null, file, false, who, true)
    session.review(file, false, READY)
    await session.send(session.getState().reviewing!)
    // read at once: the invented controller looks for the consent on its next poll
    expect(session.getState().phase).toMatchObject({ kind: 'consented', valid: 'valid for 10 minutes' })
    const t = text(rendered(session, kit.client, file))
    expect(t).toMatch(/You accepted it\. Your OK is valid for 10 minutes\./)
    expect(t).toMatch(/Waiting for Lyra to put it into your copy/)
    await until(() => session.getState().phase.kind === 'applied')
  })
  it('Reject → confirm with copy-apply on: POST …/decline; declined, nothing goes in, and the team never applies it', async () => {
    const { kit, file, session, saved } = await setup({ copyApply: true, path: 'calculator.py', consent: true, applyWaitMs: 300 })
    const before = (await saved()).content
    await session.ask('fix the sum', null, file, false, who, true)
    session.review(file, false, READY, 'reject')
    await session.send(session.getState().reviewing!)
    expect(kit.log.some((l) => /\/proposals\/suggestion_[0-9a-f]{32}\/decline$/.test(l))).toBe(true)
    // r5: a decline first checks nothing was already put in (the in-flight window), then says nothing went in
    expect(session.getState().phase).toEqual({ kind: 'declined', checking: true })
    expect(text(rendered(session, kit.client, file))).toMatch(/Declined\. Checking it isn’t already in your copy/)
    await until(() => session.getState().phase.kind === 'declined' && !(session.getState().phase as { checking: boolean }).checking)
    expect((await saved()).content).toBe(before)
    expect(text(rendered(session, kit.client, file))).toMatch(/Declined\. Nothing went into your copy/)
  })
  for (const [code, status, words] of [
    ['not_request_person', 403, /Only the person who asked for this change can accept or decline it/],
    ['request_closed', 409, /This request has ended/],
    ['consent_stale', 409, /It changed since you saw it — review again/],
  ] as const)
    it(`a refused OK (${status} ${code}) is said plainly; nothing is shown as accepted`, async () => {
      const { kit, file, session } = await setup({ copyApply: true, path: 'calculator.py', consent: true })
      await session.ask('fix the sum', null, file, false, who, true)
      const { ApiError } = await import('../../../api/client')
      kit.client.proposalConsent = async () => Promise.reject(new ApiError(status, code, 'invented'))
      session.review(file, false, READY)
      await session.send(session.getState().reviewing!)
      expect(session.getState().phase.kind).toBe('review')
      expect(session.getState().consent).toBeNull()
      expect(session.getState().note).toMatch(words)
      if (code === 'consent_stale') expect(session.blockedWhy(file, false, READY)).toMatch(/review again/)
    })
  it('only some changes kept (copy-apply on): the person’s own decision records exactly those (the consent covers whole proposals)', async () => {
    const { kit, file, session } = await setup({ copyApply: true, consent: true })
    await session.ask('use an f-string', null, file, false, who, true)
    const first = session.getState().result!.read.content.hunks[0].id
    session.choose(first, 'reject')
    session.review(file, false, READY)
    await session.send(session.getState().reviewing!)
    expect(kit.log.some((l) => /\/proposals\//.test(l))).toBe(false)
    expect(kit.log.some((l) => l.endsWith('/suggestion-decisions'))).toBe(true)
  })
})

// r5 (stand-in r4 #2, #3): an application counts as made with the person's OK only on the host's evidence; a decline
// never hides an application already made
describe('r5: application authorization needs the host’s evidence; a decline reconciles what is already in', () => {
  it('today’s host (no consent_id/applied_at on the record): after Accept, “check it’s what you accepted”, with Undo, never “with your OK”', async () => {
    const { kit, file, session, saved } = await setup({ copyApply: true, path: 'calculator.py', consent: true, evidence: false })
    const before = (await saved()).content
    await session.ask('fix the sum', null, file, false, who, true)
    session.review(file, false, READY)
    await session.send(session.getState().reviewing!)
    await until(() => session.getState().phase.kind === 'applied')
    expect(session.getState().phase).toMatchObject({ authorization: 'unverified', acceptedHere: true })
    const t = text(rendered(session, kit.client, file))
    expect(t).toMatch(/The swarm changed your copy of calculator\.py — check it’s what you accepted\./)
    expect(t).not.toMatch(/with your OK|without your OK/)
    expect(t).toMatch(/Undo/)
    await session.undo()
    expect((await saved()).content).toBe(before)
  })
  it('a record naming another consent than this page’s: unverified, never “with your OK”', async () => {
    const { kit, file, session } = await setup({ copyApply: true, path: 'calculator.py', consent: true })
    const proxy = kit.client.codeProxy!.bind(kit.client)
    kit.client.codeProxy = (async (m: 'GET' | 'POST', path: string, q: Record<string, string>, body?: unknown) => {
      const r = (await proxy(m, path, q, body)) as Record<string, unknown>
      if (m === 'GET' && /\/proposal-applications\/application_[0-9a-f]{32}$/.test(path) && r && typeof r === 'object' && r.application) (r.application as Record<string, unknown>).consent_id = `cns_${'0'.repeat(32)}`
      return r
    }) as HiveClient['codeProxy']
    await session.ask('fix the sum', null, file, false, who, true)
    session.review(file, false, READY)
    await session.send(session.getState().reviewing!)
    await until(() => session.getState().phase.kind === 'applied')
    expect(session.getState().phase).toMatchObject({ authorization: 'unverified' })
  })
  it('a record applied after the consent ran out: unverified (no grace period)', async () => {
    const { kit, file, session } = await setup({ copyApply: true, path: 'calculator.py', consent: true })
    const proxy = kit.client.codeProxy!.bind(kit.client)
    kit.client.codeProxy = (async (m: 'GET' | 'POST', path: string, q: Record<string, string>, body?: unknown) => {
      const r = (await proxy(m, path, q, body)) as Record<string, unknown>
      if (m === 'GET' && /\/proposal-applications\/application_[0-9a-f]{32}$/.test(path) && r && typeof r === 'object' && r.application) (r.application as Record<string, unknown>).applied_at = new Date(Date.now() + 11 * 60_000).toISOString()
      return r
    }) as HiveClient['codeProxy']
    await session.ask('fix the sum', null, file, false, who, true)
    session.review(file, false, READY)
    await session.send(session.getState().reviewing!)
    await until(() => session.getState().phase.kind === 'applied')
    expect(session.getState().phase).toMatchObject({ authorization: 'unverified' })
  })
  it('decline after the team already put it in (a host without the gate): “already put in your copy before you declined”, with Undo', async () => {
    const { kit, file, session, saved, svc } = await setup({ copyApply: true, path: 'calculator.py', consent: true, consentGate: false, applyWaitMs: 2000, applyDelayMs: 200 })
    const before = (await saved()).content
    // hold the page's journal watch so the decline is sent before the page has seen the application
    const proxy = kit.client.codeProxy!.bind(kit.client)
    let hold = true
    kit.client.codeProxy = (async (m: 'GET' | 'POST', path: string, q: Record<string, string>, body?: unknown) => {
      while (hold && path === '/v1/events') await new Promise((r) => setTimeout(r, 5))
      return proxy(m, path, q, body)
    }) as HiveClient['codeProxy']
    await session.ask('fix the sum', null, file, false, who, true)
    expect(session.getState().phase.kind).toBe('review')
    await until(() => (svc as unknown as { applications: Map<string, unknown> }).applications.size === 1)
    session.review(file, false, READY, 'reject')
    expect(session.getState().reviewing).not.toBeNull()
    const sent = session.send(session.getState().reviewing!)
    hold = false
    await sent
    await until(() => session.getState().phase.kind === 'applied')
    expect(session.getState().phase).toMatchObject({ kind: 'applied', beforeDecline: true, currency: 'current' })
    const t = text(rendered(session, kit.client, file))
    expect(t).toMatch(/This was already put in your copy before you declined/)
    expect(t).toMatch(/Undo/)
    await session.undo()
    expect((await saved()).content).toBe(before)
  })
})
